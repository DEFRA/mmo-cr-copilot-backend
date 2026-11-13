import Boom from '@hapi/boom'
import { LockManager } from 'mongo-locks'
import { ObjectId } from 'mongodb'

import { config } from '#/config.js'
import { AUDIT_ACTIONS, AUDIT_ENTITIES } from '#/schemas/audit-log.js'
import { ROLES, scopeForRole } from '#/schemas/role-mapping.js'
import { recordAuditEvent } from '#/services/audit-logs.js'

export const ROLE_MAPPINGS_COLLECTION = 'role_mappings'

export const SYSTEM_ACTOR = { oid: 'system', name: 'System' }

const DUPLICATE_KEY = 11000
const ADMIN_LOCK = 'role-mappings-admin'
const NOT_FOUND_MESSAGE = 'Role mapping not found'
const DUPLICATE_MESSAGE = 'That group already has a mapping for this scope'
const SLUG_REQUIRED_MESSAGE = 'projectSlug is required'

const collection = (db) => db.collection(ROLE_MAPPINGS_COLLECTION)
const toIso = (value) => (value instanceof Date ? value.toISOString() : value)

function toObjectId(id) {
  if (id instanceof ObjectId) {
    return id
  }
  if (!ObjectId.isValid(id)) {
    throw Boom.notFound(NOT_FOUND_MESSAGE)
  }
  return new ObjectId(id)
}

export function toRoleMapping(doc) {
  if (!doc) {
    return null
  }
  const { _id, createdAt, updatedAt, ...rest } = doc
  return {
    id: _id.toString(),
    groupName: rest.groupName,
    role: rest.role,
    scope: rest.scope,
    projectSlug: rest.projectSlug ?? null,
    description: rest.description ?? '',
    createdAt: toIso(createdAt),
    updatedAt: toIso(updatedAt)
  }
}

const auditView = (doc) =>
  doc && {
    groupName: doc.groupName,
    role: doc.role,
    projectSlug: doc.projectSlug ?? null
  }

const summaryOf = (doc) => {
  const scope = doc.projectSlug ? ` on ${doc.projectSlug}` : ''
  return `${doc.groupName} as ${doc.role}${scope}`
}

const isDuplicateKey = (error) => error?.code === DUPLICATE_KEY

export async function listRoleMappings(db, { projectSlug } = {}) {
  const docs = await collection(db)
    .find(projectSlug ? { projectSlug } : {})
    .sort({ groupName: 1, projectSlug: 1 })
    .toArray()
  return docs.map(toRoleMapping)
}

export async function findRoleMappingsForGroups(db, groupNames) {
  if (!Array.isArray(groupNames) || groupNames.length === 0) {
    return []
  }
  return collection(db)
    .find({ groupName: { $in: groupNames } })
    .toArray()
}

export const countDashboardAdminMappings = (db) =>
  collection(db).countDocuments({ role: ROLES.dashboardAdmin })

async function assertActiveProject(db, slug) {
  const project = await db.collection('projects').findOne({ slug })
  if (!project || project.archivedAt) {
    throw Boom.badRequest(`Project '${slug}' not found`)
  }
}

// Serialises changes that could remove the last Dashboard Admin mapping.
async function withAdminLock(db, fn) {
  const lock = await new LockManager(db.collection('mongo-locks')).lock(
    ADMIN_LOCK
  )
  if (!lock) {
    throw Boom.conflict('Role mappings are being changed; try again')
  }
  try {
    return await fn()
  } finally {
    await lock.free()
  }
}

async function assertAnotherAdminRemains(db) {
  if ((await countDashboardAdminMappings(db)) <= 1) {
    throw Boom.conflict('At least one Dashboard Admin mapping must remain')
  }
}

export async function createRoleMapping(db, input, actor, logger) {
  const role = input.role
  const projectSlug = role === ROLES.dashboardAdmin ? null : input.projectSlug
  if (role !== ROLES.dashboardAdmin) {
    if (!projectSlug) {
      throw Boom.badRequest(SLUG_REQUIRED_MESSAGE)
    }
    await assertActiveProject(db, projectSlug)
  }

  const now = new Date()
  const doc = {
    groupName: input.groupName,
    role,
    scope: scopeForRole(role),
    projectSlug,
    description: input.description ?? '',
    createdAt: now,
    updatedAt: now
  }
  try {
    const { insertedId } = await collection(db).insertOne(doc)
    doc._id = insertedId
  } catch (error) {
    if (isDuplicateKey(error)) {
      throw Boom.conflict(DUPLICATE_MESSAGE)
    }
    throw error
  }
  invalidateRoleCache()

  await recordAuditEvent(
    db,
    {
      action: AUDIT_ACTIONS.roleMappingCreated,
      entity: AUDIT_ENTITIES.roleMapping,
      entityId: doc._id.toString(),
      projectSlug,
      summary: `Role mapping created: ${summaryOf(doc)}`,
      after: auditView(doc),
      actor
    },
    logger
  )
  return toRoleMapping(doc)
}

async function findExisting(db, _id) {
  const existing = await collection(db).findOne({ _id })
  if (!existing) {
    throw Boom.notFound(NOT_FOUND_MESSAGE)
  }
  return existing
}

// The project a patched mapping ends up on: none for a Dashboard Admin.
async function patchedProjectSlug(db, role, patch, existing) {
  if (role === ROLES.dashboardAdmin) {
    return null
  }
  const projectSlug =
    patch.projectSlug === undefined ? existing.projectSlug : patch.projectSlug
  if (!projectSlug) {
    throw Boom.badRequest(SLUG_REQUIRED_MESSAGE)
  }
  if (projectSlug !== existing.projectSlug) {
    await assertActiveProject(db, projectSlug)
  }
  return projectSlug
}

export async function updateRoleMapping(db, id, patch, actor, logger) {
  const _id = toObjectId(id)
  const existing = await findExisting(db, _id)

  const role = patch.role ?? existing.role
  const projectSlug = await patchedProjectSlug(db, role, patch, existing)

  const $set = {
    role,
    scope: scopeForRole(role),
    projectSlug,
    ...(patch.description !== undefined
      ? { description: patch.description }
      : {}),
    updatedAt: new Date()
  }

  const apply = async () => {
    try {
      return await collection(db).findOneAndUpdate(
        { _id },
        { $set },
        { returnDocument: 'after' }
      )
    } catch (error) {
      if (isDuplicateKey(error)) {
        throw Boom.conflict(DUPLICATE_MESSAGE)
      }
      throw error
    }
  }

  const demotesAdmin =
    existing.role === ROLES.dashboardAdmin && role !== ROLES.dashboardAdmin
  const updated = demotesAdmin
    ? await withAdminLock(db, async () => {
        await assertAnotherAdminRemains(db)
        return apply()
      })
    : await apply()
  if (!updated) {
    throw Boom.notFound(NOT_FOUND_MESSAGE)
  }
  invalidateRoleCache()

  await recordAuditEvent(
    db,
    {
      action: AUDIT_ACTIONS.roleMappingUpdated,
      entity: AUDIT_ENTITIES.roleMapping,
      entityId: _id.toString(),
      projectSlug: updated.projectSlug ?? existing.projectSlug ?? null,
      summary: `Role mapping updated: ${summaryOf(updated)}`,
      before: auditView(existing),
      after: auditView(updated),
      actor
    },
    logger
  )
  return toRoleMapping(updated)
}

export async function deleteRoleMapping(db, id, actor, logger) {
  const _id = toObjectId(id)
  const existing = await findExisting(db, _id)

  const remove = () => collection(db).deleteOne({ _id })
  if (existing.role === ROLES.dashboardAdmin) {
    await withAdminLock(db, async () => {
      await assertAnotherAdminRemains(db)
      await remove()
    })
  } else {
    await remove()
  }
  invalidateRoleCache()

  await recordAuditEvent(
    db,
    {
      action: AUDIT_ACTIONS.roleMappingDeleted,
      entity: AUDIT_ENTITIES.roleMapping,
      entityId: _id.toString(),
      projectSlug: existing.projectSlug ?? null,
      summary: `Role mapping deleted: ${summaryOf(existing)}`,
      before: auditView(existing),
      actor
    },
    logger
  )
}

/** Removes every mapping that grants access to a project that is going away. */
export async function deleteMappingsForProject(db, slug, actor, logger) {
  const mappings = await collection(db).find({ projectSlug: slug }).toArray()
  if (mappings.length === 0) {
    return 0
  }
  await collection(db).deleteMany({ projectSlug: slug })
  invalidateRoleCache()
  await recordAuditEvent(
    db,
    {
      action: AUDIT_ACTIONS.roleMappingDeleted,
      entity: AUDIT_ENTITIES.roleMapping,
      entityId: slug,
      projectSlug: slug,
      summary: `Removed ${mappings.length} role mapping(s) for project ${slug}`,
      before: mappings.map(auditView),
      actor
    },
    logger
  )
  return mappings.length
}

/**
 * Seeds the first Dashboard Admin mapping when none exists, so a fresh
 * database is administrable. Idempotent and safe across concurrent starts.
 */
export async function ensureBootstrapAdmin(db, { groupName, logger } = {}) {
  const name = groupName?.trim()
  if (!name) {
    return false
  }
  if ((await countDashboardAdminMappings(db)) > 0) {
    return false
  }

  const now = new Date()
  const doc = {
    groupName: name,
    role: ROLES.dashboardAdmin,
    scope: 'global',
    projectSlug: null,
    description: 'Bootstrap Dashboard Admin group',
    createdAt: now,
    updatedAt: now
  }
  try {
    const { insertedId } = await collection(db).insertOne(doc)
    doc._id = insertedId
  } catch (error) {
    if (isDuplicateKey(error)) {
      return false
    }
    throw error
  }
  invalidateRoleCache()

  await recordAuditEvent(
    db,
    {
      action: AUDIT_ACTIONS.roleMappingCreated,
      entity: AUDIT_ENTITIES.roleMapping,
      entityId: doc._id.toString(),
      summary: `Role mapping created: ${summaryOf(doc)} (bootstrap)`,
      after: auditView(doc),
      actor: SYSTEM_ACTOR
    },
    logger
  )
  logger?.info(
    { event: { category: 'iam', action: 'bootstrap-admin-mapping' } },
    'Created the bootstrap Dashboard Admin role mapping'
  )
  return true
}

const roleCache = new Map()

export function invalidateRoleCache() {
  roleCache.clear()
}

const cacheKey = (groups) =>
  JSON.stringify([...new Set(groups)].sort((a, b) => a.localeCompare(b)))

function readCache(key) {
  const entry = roleCache.get(key)
  if (!entry) {
    return null
  }
  if (entry.expiresAt <= Date.now()) {
    roleCache.delete(key)
    return null
  }
  // Re-insert so the Map's insertion order doubles as least-recently-used.
  roleCache.delete(key)
  roleCache.set(key, entry)
  return entry.value
}

function writeCache(key, value) {
  const max = config.get('auth.roleCacheMaxEntries')
  const ttl = config.get('auth.roleCacheTtlMs')
  if (max <= 0 || ttl <= 0) {
    return
  }
  while (roleCache.size >= max) {
    roleCache.delete(roleCache.keys().next().value)
  }
  roleCache.set(key, { value, expiresAt: Date.now() + ttl })
}

async function computeUserRoles(db, groups) {
  const mappings = await findRoleMappingsForGroups(db, groups)

  // Dashboard Admin comes only from a stored mapping, never from a token claim.
  const isAdmin = mappings.some((m) => m.role === ROLES.dashboardAdmin)
  const wanted = {}
  for (const m of mappings) {
    if (
      !m.projectSlug ||
      ![ROLES.projectAdmin, ROLES.projectUser].includes(m.role)
    ) {
      continue
    }
    if (wanted[m.projectSlug] !== ROLES.projectAdmin) {
      wanted[m.projectSlug] = m.role
    }
  }

  const projects = db.collection('projects')
  const active = new Set(
    await projects.distinct('slug', {
      archivedAt: null,
      ...(isAdmin ? {} : { slug: { $in: Object.keys(wanted) } })
    })
  )

  const projectRoles = Object.fromEntries(
    Object.entries(wanted).filter(([slug]) => active.has(slug))
  )
  return {
    roles: isAdmin ? [ROLES.dashboardAdmin] : [],
    projectRoles,
    allowedProjects: isAdmin
      ? [...active].sort((a, b) => a.localeCompare(b))
      : Object.keys(projectRoles)
  }
}

/** Maps the caller's group names to application roles and project access. */
export async function resolveUserRoles(db, tokenClaims) {
  const groups = Array.isArray(tokenClaims?.groups) ? tokenClaims.groups : []
  if (groups.length === 0) {
    return { roles: [], projectRoles: {}, allowedProjects: [] }
  }

  const key = cacheKey(groups)
  const cached = readCache(key)
  if (cached) {
    return structuredClone(cached)
  }

  const value = await computeUserRoles(db, groups)
  writeCache(key, value)
  return structuredClone(value)
}
