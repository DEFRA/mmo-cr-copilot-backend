import Boom from '@hapi/boom'

import { requireIngestToken } from '#/common/helpers/ingest-auth.js'
import {
  PROJECT_ROLES,
  assertProjectRole,
  hasRole,
  isDashboardAdmin,
  requireUser,
  resolveProjectRole
} from '#/common/helpers/project-access.js'
import {
  repositoryFullNameParamSchema,
  repositoryMapSchema
} from '#/schemas/project.js'
import { recordAuditEvent } from '#/services/audit-logs.js'
import {
  findProject,
  findRepository,
  findUnassignedRepositories,
  listProjects,
  listRepositories,
  mapRepository,
  unmapRepository
} from '#/services/projects.js'

const statusNoContent = 204
const actorOf = (user) => ({ oid: user.oid, name: user.name })

const activeProject = async (db, slug) => {
  const project = await findProject(db, slug)
  return project && !project.archivedAt ? project : null
}

async function auditMapping(request, user, action, repository, before, after) {
  const projectSlug = after?.projectSlug ?? before?.projectSlug ?? null
  await recordAuditEvent(
    request.db,
    {
      action,
      entity: 'repository-mapping',
      entityId: repository,
      projectSlug,
      summary: `Repository ${repository}: ${action.replace('repository.', '')}`,
      before: before && {
        projectSlug: before.projectSlug,
        sonarProjectKey: before.sonarProjectKey ?? null
      },
      after: after && {
        projectSlug: after.projectSlug,
        sonarProjectKey: after.sonarProjectKey ?? null
      },
      actor: actorOf(user)
    },
    request.logger
  )
}

export const repositoriesRoutes = [
  {
    // Called by the dashboard BFF for GitHub Actions ingest, which has no user:
    // it only learns whether a repository is mapped to a project.
    method: 'GET',
    path: '/api/ingest/repositories/{fullName}',
    options: {
      auth: false,
      pre: [{ method: requireIngestToken }],
      validate: { params: repositoryFullNameParamSchema }
    },
    handler: async (request, h) => {
      const { fullName } = request.params
      const repository = await findRepository(request.db, fullName)
      const project = repository?.projectSlug
        ? await activeProject(request.db, repository.projectSlug)
        : null
      return h.response({ fullName, mapped: Boolean(project) })
    }
  },
  {
    method: 'GET',
    path: '/api/repositories',
    handler: async (request, h) => {
      const user = requireUser(request)
      const [repositories, projects] = await Promise.all([
        listRepositories(request.db),
        listProjects(request.db)
      ])
      const readable = new Set(
        projects
          .filter((project) => resolveProjectRole(user, project))
          .map((project) => project.slug)
      )
      return h.response({
        repositories: isDashboardAdmin(user)
          ? repositories
          : repositories.filter((r) => readable.has(r.projectSlug))
      })
    }
  },
  {
    method: 'GET',
    path: '/api/repositories/unassigned',
    handler: async (request, h) => {
      const user = requireUser(request)
      const projects = await listProjects(request.db)
      const mayMap = projects.some((project) =>
        hasRole(resolveProjectRole(user, project), PROJECT_ROLES.admin)
      )
      if (!mayMap) throw Boom.forbidden('Project admin role required')
      const repositories = await findUnassignedRepositories(request.db)
      return h.response({ repositories })
    }
  },
  {
    method: 'PUT',
    path: '/api/repositories/{fullName}',
    options: {
      validate: {
        params: repositoryFullNameParamSchema,
        payload: repositoryMapSchema
      }
    },
    handler: async (request, h) => {
      const { fullName } = request.params
      const { projectSlug, sonarProjectKey } = request.payload

      const project = await activeProject(request.db, projectSlug)
      if (!project) {
        throw Boom.badRequest(`Project '${projectSlug}' not found`)
      }
      const { user } = assertProjectRole(request, project, PROJECT_ROLES.admin)

      const existing = await findRepository(request.db, fullName)
      if (
        existing?.projectSlug &&
        existing.projectSlug !== projectSlug &&
        !isDashboardAdmin(user)
      ) {
        throw Boom.forbidden('Moving a repository needs a dashboard admin')
      }

      const repository = await mapRepository(request.db, {
        fullName,
        projectSlug,
        sonarProjectKey,
        mappedBy: user.name || user.oid
      })
      await auditMapping(
        request,
        user,
        existing ? 'repository.remapped' : 'repository.mapped',
        fullName,
        existing,
        repository
      )

      return h.response(repository)
    }
  },
  {
    method: 'DELETE',
    path: '/api/repositories/{fullName}',
    options: {
      validate: {
        params: repositoryFullNameParamSchema
      }
    },
    handler: async (request, h) => {
      const { fullName } = request.params
      const existing = await findRepository(request.db, fullName)
      const project = existing?.projectSlug
        ? await activeProject(request.db, existing.projectSlug)
        : null

      let user
      if (project) {
        ;({ user } = assertProjectRole(request, project, PROJECT_ROLES.admin))
      } else {
        user = requireUser(request)
        if (!isDashboardAdmin(user)) {
          throw Boom.notFound(`Repository '${fullName}' not found`)
        }
      }

      const deleted = await unmapRepository(request.db, fullName)
      if (!deleted) {
        throw Boom.notFound(`Repository '${fullName}' not found`)
      }
      await auditMapping(
        request,
        user,
        'repository.unmapped',
        fullName,
        existing,
        null
      )
      return h.response().code(statusNoContent)
    }
  }
]
