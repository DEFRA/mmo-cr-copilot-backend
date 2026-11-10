import Boom from '@hapi/boom'
import Joi from 'joi'

import {
  PROJECT_ROLES,
  assertProjectRole,
  loadProject,
  requireDashboardAdmin,
  requireUser,
  resolveProjectRole
} from '#/common/helpers/project-access.js'
import {
  AI_NATIVE_JIRA_KEY_MESSAGE,
  JIRA_KEY_FIXED_MESSAGE,
  complexityModelSchema,
  hasRequiredJiraKey,
  prLinkParamSchema,
  prLinkPayloadSchema,
  projectCreateSchema,
  leverageQuerySchema,
  projectPayloadsQuerySchema,
  projectSlugParamSchema,
  projectSprintsQuerySchema,
  projectUpdateSchema
} from '#/schemas/project.js'
import {
  PROJECT_SLUG_CONFLICT_MESSAGE,
  createProject,
  deleteProject,
  findProject,
  findProjectPayloads,
  resolveProjectSprints,
  listProjects,
  updateProject
} from '#/services/projects.js'
import { listProjectJiraIssues } from '#/services/jira-scope.js'
import { ensureJiraWindowFresh } from '#/services/jira-lazy-fetch.js'
import { ensurePrQualityGates } from '#/services/sonar-pr-gates.js'
import { findPrLinks, setManualPrLinks } from '#/services/pr-jira-links.js'
import { recordAuditEvent } from '#/services/audit-logs.js'
import {
  deleteMappingsForProject,
  invalidateRoleCache
} from '#/services/role-mappings.js'
import { computeDeliveryMetrics } from '#/services/delivery-metrics.js'
import {
  DEFAULT_COMPLEXITY_MODEL,
  computeAiNativeDeliveryLeverage,
  computeCodeChurn,
  computeLeverageV2,
  recomputeComplexity
} from '#/services/complexity.js'

const statusCreated = 201
const statusNoContent = 204

const actorOf = (user) => ({ oid: user.oid, name: user.name })

async function auditProject(request, user, action, after, before) {
  const slug = after?.slug ?? before?.slug
  const pick = (p) =>
    p && {
      name: p.name,
      type: p.type
    }
  await recordAuditEvent(
    request.db,
    {
      action,
      entity: 'project',
      entityId: slug,
      projectSlug: slug,
      summary: `Project ${slug}: ${action.replace('project.', '').replace('.', ' ')}`,
      before: pick(before),
      after: pick(after),
      actor: actorOf(user)
    },
    request.logger
  )
}

// The project named in the path, if it exists and the caller may read it.
async function readableProject(request) {
  return (await loadProject(request)).project
}

const presentProject = (project, role) => ({ ...project, role })

const sameKeys = (a, b) =>
  a.length === b.length && a.every((key, i) => key === b[i])

// A set Jira key never changes; the type rule is checked against the project as it will be stored.
function assertJiraKeyRule(existing, changes) {
  const storedKeys = existing?.jira?.projectKeys ?? []
  const requestedKeys = changes.jira?.projectKeys
  if (
    storedKeys.length > 0 &&
    requestedKeys !== undefined &&
    !sameKeys(storedKeys, requestedKeys)
  ) {
    throw Boom.badRequest(JIRA_KEY_FIXED_MESSAGE)
  }
  const resulting = {
    type: changes.type ?? existing?.type,
    jira: { projectKeys: requestedKeys ?? storedKeys }
  }
  if (!hasRequiredJiraKey(resulting)) {
    throw Boom.badRequest(AI_NATIVE_JIRA_KEY_MESSAGE)
  }
}

export const projectsRoutes = [
  {
    method: 'GET',
    path: '/api/projects/{slug}/complexity-model',
    options: { validate: { params: projectSlugParamSchema } },
    handler: async (request, h) => {
      const project = await readableProject(request)
      return h.response(project.complexity ?? DEFAULT_COMPLEXITY_MODEL)
    }
  },
  {
    method: 'PUT',
    path: '/api/projects/{slug}/complexity-model',
    options: {
      validate: {
        params: projectSlugParamSchema,
        payload: complexityModelSchema
      }
    },
    handler: async (request, h) => {
      const auth = requireDashboardAdmin(request)
      const project = await readableProject(request)
      const before = project.complexity ?? DEFAULT_COMPLEXITY_MODEL
      const after = { ...request.payload, version: (before.version ?? 1) + 1 }
      await request.db
        .collection('projects')
        .updateOne(
          { slug: project.slug },
          { $set: { complexity: after, updatedAt: new Date() } }
        )
      await recordAuditEvent(
        request.db,
        {
          action: 'complexity-model.updated',
          entity: 'complexity-model',
          entityId: project.slug,
          projectSlug: project.slug,
          summary: `Complexity model for ${project.slug} changed to version ${after.version}`,
          before,
          after,
          actor: { oid: auth.user.oid, name: auth.user.name }
        },
        request.logger
      )
      return h.response(after)
    }
  },
  {
    method: 'POST',
    path: '/api/admin/complexity/recompute',
    handler: async (request, h) => {
      const auth = requireDashboardAdmin(request)
      const updated = await recomputeComplexity(request.db)
      await recordAuditEvent(
        request.db,
        {
          action: 'complexity.recomputed',
          entity: 'complexity-model',
          entityId: 'all',
          summary: `Complexity recomputed for ${updated} pull requests`,
          after: { updated },
          actor: { oid: auth.user.oid, name: auth.user.name }
        },
        request.logger
      )
      return h.response({ updated })
    }
  },
  {
    method: 'GET',
    path: '/api/projects',
    handler: async (request, h) => {
      const user = requireUser(request)
      const projects = await listProjects(request.db)
      const visible = projects.flatMap((project) => {
        const role = resolveProjectRole(user, project)
        return role ? [presentProject(project, role)] : []
      })
      return h.response({ projects: visible })
    }
  },
  {
    method: 'POST',
    path: '/api/projects',
    options: {
      validate: {
        payload: projectCreateSchema
      }
    },
    handler: async (request, h) => {
      const { user } = requireDashboardAdmin(request)
      const existing = await findProject(request.db, request.payload.slug)
      if (existing) {
        throw Boom.conflict(PROJECT_SLUG_CONFLICT_MESSAGE)
      }
      assertJiraKeyRule(null, request.payload)
      const project = await createProject(request.db, request.payload)
      invalidateRoleCache()
      await auditProject(request, user, 'project.created', project, null)
      return h.response(project).code(statusCreated)
    }
  },
  {
    method: 'GET',
    path: '/api/projects/{slug}',
    options: {
      validate: {
        params: projectSlugParamSchema
      }
    },
    handler: async (request, h) => {
      const { project, role } = await loadProject(request)
      return h.response(presentProject(project, role))
    }
  },
  {
    method: 'PUT',
    path: '/api/projects/{slug}',
    options: {
      validate: {
        params: projectSlugParamSchema,
        payload: projectUpdateSchema
      }
    },
    handler: async (request, h) => {
      const { user } = requireDashboardAdmin(request)
      const existing = await findProject(request.db, request.params.slug)
      if (!existing || existing.archivedAt) {
        throw Boom.notFound(`Project '${request.params.slug}' not found`)
      }
      assertJiraKeyRule(existing, request.payload)
      const project = await updateProject(
        request.db,
        request.params.slug,
        request.payload
      )
      await auditProject(request, user, 'project.updated', project, existing)
      return h.response(project)
    }
  },
  {
    method: 'DELETE',
    path: '/api/projects/{slug}',
    options: {
      validate: {
        params: projectSlugParamSchema
      }
    },
    handler: async (request, h) => {
      const { user } = requireDashboardAdmin(request)
      const existing = await findProject(request.db, request.params.slug)
      if (!existing || existing.archivedAt) {
        throw Boom.notFound(`Project '${request.params.slug}' not found`)
      }
      await deleteProject(request.db, request.params.slug)
      await deleteMappingsForProject(
        request.db,
        request.params.slug,
        actorOf(user),
        request.logger
      )
      invalidateRoleCache()
      await auditProject(request, user, 'project.archived', null, existing)
      return h.response().code(statusNoContent)
    }
  },
  {
    method: 'GET',
    path: '/api/projects/{slug}/payloads',
    options: {
      validate: {
        params: projectSlugParamSchema,
        query: projectPayloadsQuerySchema
      }
    },
    handler: async (request, h) => {
      const project = await findProject(request.db, request.params.slug)
      if (!project || project.archivedAt) {
        throw Boom.notFound(`Project '${request.params.slug}' not found`)
      }
      assertProjectRole(request, project)
      const payloads = await findProjectPayloads(
        request.db,
        request.params.slug,
        request.query
      )
      return h.response({ payloads })
    }
  },
  {
    method: 'GET',
    path: '/api/projects/{slug}/sprints',
    options: {
      validate: {
        params: projectSlugParamSchema,
        query: projectSprintsQuerySchema
      }
    },
    handler: async (request, h) => {
      const project = await findProject(request.db, request.params.slug)
      if (!project || project.archivedAt) {
        throw Boom.notFound(`Project '${request.params.slug}' not found`)
      }
      assertProjectRole(request, project)
      const sprints = await resolveProjectSprints(
        project,
        request.server.jira,
        {
          count: request.query?.count,
          logger: request.logger
        }
      )
      return h.response({ sprints })
    }
  },
  {
    method: 'GET',
    path: '/api/projects/{slug}/delivery-metrics',
    options: {
      validate: {
        params: projectSlugParamSchema,
        query: projectPayloadsQuerySchema
      }
    },
    handler: async (request, h) => {
      const project = await findProject(request.db, request.params.slug)
      if (!project || project.archivedAt) {
        throw Boom.notFound(`Project '${request.params.slug}' not found`)
      }
      assertProjectRole(request, project)
      const jira = await ensureJiraWindowFresh({
        db: request.db,
        client: request.server.jira,
        project,
        from: request.query.from,
        to: request.query.to,
        logger: request.logger
      })
      const metrics = await computeDeliveryMetrics(
        request.db,
        request.params.slug,
        request.query,
        {
          prGates: (prs) =>
            ensurePrQualityGates({
              db: request.db,
              sonar: request.server.sonar,
              prs,
              logger: request.logger
            })
        }
      )
      return h.response({ ...metrics, jira })
    }
  },
  {
    method: 'GET',
    path: '/api/projects/{slug}/jira-issues',
    options: {
      validate: {
        params: projectSlugParamSchema
      }
    },
    handler: async (request, h) => {
      const project = await findProject(request.db, request.params.slug)
      if (!project || project.archivedAt) {
        throw Boom.notFound(`Project '${request.params.slug}' not found`)
      }
      assertProjectRole(request, project)
      const issues = await listProjectJiraIssues(request.db, project)
      return h.response({ issues })
    }
  },
  {
    method: 'GET',
    path: '/api/projects/{slug}/leverage-v2',
    options: {
      validate: {
        params: projectSlugParamSchema,
        query: leverageQuerySchema
      }
    },
    handler: async (request, h) => {
      await readableProject(request)
      return h.response(
        await computeLeverageV2(request.db, request.params.slug, request.query)
      )
    }
  },
  {
    method: 'GET',
    path: '/api/projects/{slug}/churn',
    options: {
      validate: {
        params: projectSlugParamSchema,
        query: Joi.object({
          windowDays: Joi.number().integer().min(1).max(90).default(21),
          from: Joi.date().iso().optional(),
          to: Joi.date().iso().optional()
        }).unknown()
      }
    },
    handler: async (request, h) => {
      await readableProject(request)
      return h.response(
        await computeCodeChurn(request.db, request.params.slug, request.query)
      )
    }
  },
  {
    method: 'GET',
    path: '/api/projects/{slug}/ai-native-leverage',
    options: {
      validate: {
        params: projectSlugParamSchema,
        query: projectPayloadsQuerySchema
      }
    },
    handler: async (request, h) => {
      const project = await readableProject(request)
      await ensureJiraWindowFresh({
        db: request.db,
        client: request.server.jira,
        project,
        from: request.query.from,
        to: request.query.to,
        logger: request.logger
      })
      return h.response(
        await computeAiNativeDeliveryLeverage(
          request.db,
          request.params.slug,
          request.query
        )
      )
    }
  },
  {
    method: 'GET',
    path: '/api/projects/{slug}/pr-links/{repository}/{prNumber}',
    options: { validate: { params: prLinkParamSchema } },
    handler: async (request, h) => {
      const project = await findProject(request.db, request.params.slug)
      if (!project || project.archivedAt) {
        throw Boom.notFound(`Project '${request.params.slug}' not found`)
      }
      assertProjectRole(request, project)
      const links = await findPrLinks(request.db, {
        projectSlug: project.slug,
        repository: request.params.repository,
        prNumber: request.params.prNumber
      })
      return h.response({ links })
    }
  },
  {
    method: 'PUT',
    path: '/api/projects/{slug}/pr-links/{repository}/{prNumber}',
    options: {
      validate: { params: prLinkParamSchema, payload: prLinkPayloadSchema }
    },
    handler: async (request, h) => {
      const { project, user } = await loadProject(request, PROJECT_ROLES.admin)
      const auth = { user }
      const { repository, prNumber } = request.params
      const { before, after } = await setManualPrLinks(request.db, {
        projectSlug: project.slug,
        repository,
        prNumber,
        jiraKeys: request.payload.jiraKeys
      })
      await recordAuditEvent(
        request.db,
        {
          action: 'pr-jira-links.updated',
          entity: 'pr-jira-links',
          entityId: `${repository}#${prNumber}`,
          projectSlug: project.slug,
          summary: `Jira links for ${repository} #${prNumber} changed`,
          before,
          after,
          actor: { oid: auth.user.oid, name: auth.user.name }
        },
        request.logger
      )
      const links = await findPrLinks(request.db, {
        projectSlug: project.slug,
        repository,
        prNumber
      })
      return h.response({ links })
    }
  }
]
