import { LockManager } from 'mongo-locks'

import { ROLES, scopeForRole } from '#/schemas/role-mapping.js'
import { recordAuditEvent } from '#/services/audit-logs.js'
import { JIRA_ISSUES_COLLECTION } from '#/services/jira.js'
import { PAYLOADS_COLLECTION } from '#/services/payloads.js'
import { PERSONA_MAPPINGS_COLLECTION } from '#/services/persona-mappings.js'
import { PR_JIRA_LINKS_COLLECTION } from '#/services/pr-jira-links.js'
import {
  PROJECTS_COLLECTION,
  REPOSITORIES_COLLECTION
} from '#/services/projects.js'
import {
  ROLE_MAPPINGS_COLLECTION,
  invalidateRoleCache
} from '#/services/role-mappings.js'
import { SURVIVAL_COLLECTION } from '#/services/survival.js'

// One-off (FI0-11625): delete this file, its test and its call in mongodb.js once deployed.

const FROM = 'FES'
const TO = 'CRAR'
const LOCK = 'rename-default-project-slug'

// The auto-created CR project; a genuine FES project never carries the MMOCR key.
const LEGACY_PROJECT = { slug: FROM, 'jira.projectKeys': 'MMOCR' }
const FES_GROUP = /^AG-Users-CopilotAnalytics-FES-/
const CRAR_GROUPS = [
  ['AG-Users-CopilotAnalytics-CRAR-Admin', ROLES.projectAdmin],
  ['AG-Users-CopilotAnalytics-CRAR-Reader', ROLES.projectUser]
]
const SLUG_COLLECTIONS = [
  REPOSITORIES_COLLECTION,
  PAYLOADS_COLLECTION,
  JIRA_ISSUES_COLLECTION,
  'jira-sprint-scope',
  PR_JIRA_LINKS_COLLECTION,
  SURVIVAL_COLLECTION
]

async function renameSlugReferences(db) {
  for (const name of SLUG_COLLECTIONS) {
    await db
      .collection(name)
      .updateMany({ projectSlug: FROM }, { $set: { projectSlug: TO } })
  }

  // Persona mappings are keyed `<slug>:<handle>`, so they move to a new _id.
  const personas = db.collection(PERSONA_MAPPINGS_COLLECTION)
  for (const { _id, ...doc } of await personas
    .find({ projectSlug: FROM })
    .toArray()) {
    await personas.replaceOne(
      { _id: String(_id).replace(`${FROM}:`, `${TO}:`) },
      { ...doc, projectSlug: TO },
      { upsert: true }
    )
    await personas.deleteOne({ _id })
  }
}

// FES-named groups stay on FES: they belong to the real FES project created later.
async function moveRoleMappings(db) {
  const mappings = db.collection(ROLE_MAPPINGS_COLLECTION)
  const now = new Date()
  const { modifiedCount: moved } = await mappings.updateMany(
    { projectSlug: FROM, groupName: { $not: FES_GROUP } },
    { $set: { projectSlug: TO, updatedAt: now } }
  )

  let created = 0
  for (const [groupName, role] of CRAR_GROUPS) {
    const { upsertedCount } = await mappings.updateOne(
      { groupName, projectSlug: TO },
      {
        $setOnInsert: {
          groupName,
          role,
          scope: scopeForRole(role),
          projectSlug: TO,
          description: `${groupName} mapped to ${role}`,
          createdAt: now,
          updatedAt: now
        }
      },
      { upsert: true }
    )
    created += upsertedCount
  }
  return { moved, created }
}

/**
 * Renames the auto-created CR project from FES to CRAR, makes it AI-Native and
 * moves everything
 * that refers to it. The project is renamed last, so an interrupted run is
 * finished by the next start. Existing audit entries keep their slug.
 */
export async function renameDefaultProjectSlug(db, logger) {
  const projects = db.collection(PROJECTS_COLLECTION)
  if (!(await projects.findOne(LEGACY_PROJECT))) return false
  if (await projects.findOne({ slug: TO })) {
    logger?.warn(`Project ${TO} already exists; not renaming project ${FROM}`)
    return false
  }

  const lock = await new LockManager(db.collection('mongo-locks')).lock(LOCK)
  if (!lock) return false
  let roleMappings
  let before
  try {
    before = await projects.findOne(LEGACY_PROJECT)
    if (!before) return false
    await renameSlugReferences(db)
    roleMappings = await moveRoleMappings(db)
    // The CR project is AI-Native, which has no adoption date.
    await projects.updateOne(LEGACY_PROJECT, {
      $set: {
        slug: TO,
        type: 'ai-native',
        adoptionStartDate: null,
        updatedAt: new Date()
      }
    })
  } finally {
    await lock.free()
  }
  invalidateRoleCache()

  await recordAuditEvent(
    db,
    {
      action: 'project.updated',
      entity: 'project',
      entityId: TO,
      projectSlug: TO,
      summary: `Project ${FROM} renamed to ${TO} and set to AI-Native`,
      before: { slug: FROM, type: before.type },
      after: { slug: TO, type: 'ai-native' }
    },
    logger
  )
  await recordAuditEvent(
    db,
    {
      action: 'role-mapping.migrated',
      entity: 'role-mapping',
      entityId: TO,
      projectSlug: TO,
      summary: `Moved ${roleMappings.moved} and created ${roleMappings.created} role mapping(s) for project ${TO}`
    },
    logger
  )
  logger?.info(`Renamed project ${FROM} to ${TO}`)
  return true
}
