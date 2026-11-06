import Boom from '@hapi/boom'

import {
  findProject,
  findRepository,
  listProjects,
  listRepositories
} from '#/services/projects.js'

export const DASHBOARD_ADMIN_ROLE = 'Dashboard.Admin'

export const PROJECT_ROLES = {
  user: 'project-user',
  admin: 'project-admin',
  dashboardAdmin: 'dashboard-admin'
}

const RANK = {
  [PROJECT_ROLES.user]: 1,
  [PROJECT_ROLES.admin]: 2,
  [PROJECT_ROLES.dashboardAdmin]: 3
}

export function isDashboardAdmin(user) {
  return Boolean(user?.roles?.includes(DASHBOARD_ADMIN_ROLE))
}

/**
 * The caller's role on one project, or null. Deny by default: only a role
 * mapping for the project grants access, and groups are never inferred.
 */
export function resolveProjectRole(user, project) {
  if (isDashboardAdmin(user)) return PROJECT_ROLES.dashboardAdmin
  const mapped = user?.projectRoles?.[project?.slug]
  return mapped === PROJECT_ROLES.admin || mapped === PROJECT_ROLES.user
    ? mapped
    : null
}

export const hasRole = (role, minimum) =>
  (RANK[role] ?? 0) >= (RANK[minimum] ?? Infinity)

/** The user validated by the entra auth strategy, or a 401. */
export function requireUser(request) {
  const user = request.auth?.credentials
  if (!user?.oid) throw Boom.unauthorized(null, 'Bearer')
  return user
}

export function requireDashboardAdmin(request) {
  const user = requireUser(request)
  if (!isDashboardAdmin(user)) {
    logDenied(request, user, 'admin-role')
    throw Boom.forbidden('Admin role required')
  }
  return { user }
}

function logDenied(request, user, reason) {
  request.logger?.warn(
    {
      event: { category: 'iam', action: 'access-denied', reason },
      user: { id: user?.oid }
    },
    'Access denied'
  )
}

/**
 * Throws unless the caller holds at least `minimum` on the project. A caller
 * with no role at all gets the same 404 as a missing project, so slugs cannot
 * be probed; a caller with too low a role gets 403.
 */
export function assertProjectRole(
  request,
  project,
  minimum = PROJECT_ROLES.user
) {
  const user = requireUser(request)
  const role = resolveProjectRole(user, project)
  if (!role) {
    logDenied(request, user, 'project')
    throw Boom.notFound(`Project '${project?.slug}' not found`)
  }
  if (!hasRole(role, minimum)) {
    logDenied(request, user, 'project-role')
    throw Boom.forbidden('Project admin role required')
  }
  return { user, role }
}

/**
 * The project a repository belongs to, or null when it is unmapped. Callers
 * must treat an unmapped repository as dashboard-admin only.
 */
export async function projectForRepository(db, repository) {
  const repo = await findRepository(db, repository)
  if (!repo?.projectSlug) return null
  const project = await findProject(db, repo.projectSlug)
  return project && !project.archivedAt ? project : null
}

/** Role check for repository-level data; unmapped repositories need a dashboard admin. */
export async function assertRepositoryRole(
  request,
  repository,
  minimum = PROJECT_ROLES.user
) {
  const project = await projectForRepository(request.db, repository)
  if (project) {
    return { ...assertProjectRole(request, project, minimum), project }
  }
  const user = requireUser(request)
  if (!isDashboardAdmin(user)) {
    logDenied(request, user, 'repository')
    throw Boom.notFound(`Repository '${repository}' not found`)
  }
  return { user, role: PROJECT_ROLES.dashboardAdmin, project: null }
}

/** The active project named in the path, once the caller's role on it is checked. */
export async function loadProject(request, minimum = PROJECT_ROLES.user) {
  return loadProjectBySlug(request, request.params.slug, minimum)
}

export async function loadProjectBySlug(
  request,
  slug,
  minimum = PROJECT_ROLES.user
) {
  const project = await findProject(request.db, slug)
  if (!project || project.archivedAt) {
    // Same answer as a project the caller cannot see.
    requireUser(request)
    throw Boom.notFound(`Project '${slug}' not found`)
  }
  return { project, ...assertProjectRole(request, project, minimum) }
}

/** Repositories mapped to one project the caller may read. */
export async function projectRepositoryNames(request, slug) {
  await loadProjectBySlug(request, slug)
  const repositories = await listRepositories(request.db)
  return new Set(
    repositories.filter((r) => r.projectSlug === slug).map((r) => r.fullName)
  )
}

/** Names of repositories the caller may read; null means every repository. */
export async function readableRepositoryNames(db, user) {
  if (isDashboardAdmin(user)) return null
  const [projects, repositories] = await Promise.all([
    listProjects(db),
    listRepositories(db)
  ])
  const slugs = new Set(
    projects.filter((p) => resolveProjectRole(user, p)).map((p) => p.slug)
  )
  return new Set(
    repositories.filter((r) => slugs.has(r.projectSlug)).map((r) => r.fullName)
  )
}
