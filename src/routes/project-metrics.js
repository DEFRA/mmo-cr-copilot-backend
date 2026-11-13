import { PROJECT_ROLES, loadProject } from '#/common/helpers/project-access.js'
import {
  churnQuerySchema,
  leverageQuerySchema,
  prLinkParamSchema,
  prLinkPayloadSchema,
  projectPayloadsQuerySchema,
  projectSlugParamSchema
} from '#/schemas/project.js'
import { recordAuditEvent } from '#/services/audit-logs.js'
import {
  computeAiNativeDeliveryLeverage,
  computeCodeChurn,
  computeLeverageV2
} from '#/services/complexity.js'
import { computeDeliveryMetrics } from '#/services/delivery-metrics.js'
import { ensureJiraWindowFresh } from '#/services/jira-lazy-fetch.js'
import { listProjectJiraIssues } from '#/services/jira-scope.js'
import { findPrLinks, setManualPrLinks } from '#/services/pr-jira-links.js'
import { ensurePrQualityGates } from '#/services/sonar-pr-gates.js'

const windowedQuery = (query) => ({
  validate: { params: projectSlugParamSchema, query }
})

const refreshJiraWindow = (request, project) =>
  ensureJiraWindowFresh({
    db: request.db,
    client: request.server.jira,
    project,
    from: request.query.from,
    to: request.query.to,
    logger: request.logger
  })

const prLinkScope = (project, params) => ({
  projectSlug: project.slug,
  repository: params.repository,
  prNumber: params.prNumber
})

// Read-only project metrics and the manual pull request to Jira links.
export const projectMetricsRoutes = [
  {
    method: 'GET',
    path: '/api/projects/{slug}/delivery-metrics',
    options: windowedQuery(projectPayloadsQuerySchema),
    handler: async (request, h) => {
      const { project } = await loadProject(request)
      const jira = await refreshJiraWindow(request, project)
      const metrics = await computeDeliveryMetrics(
        request.db,
        project.slug,
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
    options: { validate: { params: projectSlugParamSchema } },
    handler: async (request, h) => {
      const { project } = await loadProject(request)
      const issues = await listProjectJiraIssues(request.db, project)
      return h.response({ issues })
    }
  },
  {
    method: 'GET',
    path: '/api/projects/{slug}/leverage-v2',
    options: windowedQuery(leverageQuerySchema),
    handler: async (request, h) => {
      const { project } = await loadProject(request)
      return h.response(
        await computeLeverageV2(request.db, project.slug, request.query)
      )
    }
  },
  {
    method: 'GET',
    path: '/api/projects/{slug}/churn',
    options: windowedQuery(churnQuerySchema),
    handler: async (request, h) => {
      const { project } = await loadProject(request)
      return h.response(
        await computeCodeChurn(request.db, project.slug, request.query)
      )
    }
  },
  {
    method: 'GET',
    path: '/api/projects/{slug}/ai-native-leverage',
    options: windowedQuery(projectPayloadsQuerySchema),
    handler: async (request, h) => {
      const { project } = await loadProject(request)
      await refreshJiraWindow(request, project)
      return h.response(
        await computeAiNativeDeliveryLeverage(
          request.db,
          project.slug,
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
      const { project } = await loadProject(request)
      const links = await findPrLinks(
        request.db,
        prLinkScope(project, request.params)
      )
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
      const scope = prLinkScope(project, request.params)
      const { repository, prNumber } = scope
      const { before, after } = await setManualPrLinks(request.db, {
        ...scope,
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
          actor: { oid: user.oid, name: user.name }
        },
        request.logger
      )
      const links = await findPrLinks(request.db, scope)
      return h.response({ links })
    }
  }
]
