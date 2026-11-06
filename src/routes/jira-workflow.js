import Boom from '@hapi/boom'

import { loadProject, PROJECT_ROLES } from '#/common/helpers/project-access.js'
import { AUDIT_ACTIONS, AUDIT_ENTITIES } from '#/schemas/audit-log.js'
import {
  jiraWorkflowPayloadSchema,
  workflowFailAction
} from '#/schemas/jira-workflow.js'
import { projectSlugParamSchema } from '#/schemas/project.js'
import { recordAuditEvent } from '#/services/audit-logs.js'
import {
  listProjectStatuses,
  saveProjectWorkflow
} from '#/services/jira-workflow.js'
import { STATUS_BASELINE, resolveWorkflow } from '#/services/workflow-stages.js'

const actorOf = (user) => ({ oid: user.oid, name: user.name })
const toIso = (value) => (value ? new Date(value).toISOString() : null)

async function loadJiraProject(request) {
  const access = await loadProject(request, PROJECT_ROLES.admin)
  if (!access.project.jira?.projectKeys?.length) {
    throw Boom.badData('Project has no Jira project key')
  }
  return access
}

function presentWorkflow(project) {
  const workflow = resolveWorkflow(project)
  const detected = project.jira?.detectedStatuses
  return {
    source: workflow.source,
    version: workflow.version,
    updatedAt: toIso(workflow.updatedAt),
    updatedBy: workflow.updatedBy,
    detectedAt: Array.isArray(detected)
      ? toIso(project.jira?.lastSyncedAt)
      : null,
    detectedCount: Array.isArray(detected) ? detected.length : 0,
    stages: workflow.stages,
    suggestions: STATUS_BASELINE
  }
}

export const jiraWorkflowRoutes = [
  {
    method: 'GET',
    path: '/api/projects/{slug}/jira/workflow',
    options: { validate: { params: projectSlugParamSchema } },
    handler: async (request, h) => {
      const { project } = await loadJiraProject(request)
      return h.response(presentWorkflow(project))
    }
  },
  {
    method: 'PUT',
    path: '/api/projects/{slug}/jira/workflow',
    options: {
      payload: { maxBytes: 32768 },
      validate: {
        params: projectSlugParamSchema,
        payload: jiraWorkflowPayloadSchema,
        failAction: workflowFailAction
      }
    },
    handler: async (request, h) => {
      const { project, user } = await loadJiraProject(request)
      const { before, after } = await saveProjectWorkflow(
        request.db,
        project.slug,
        request.payload,
        actorOf(user)
      )

      await recordAuditEvent(
        request.db,
        {
          action: AUDIT_ACTIONS.jiraWorkflowUpdated,
          entity: AUDIT_ENTITIES.jiraWorkflow,
          entityId: project.slug,
          projectSlug: project.slug,
          summary: `Jira workflow for ${project.slug} changed to version ${after.version}`,
          before: before && { stages: before.stages },
          after: { stages: after.stages },
          actor: actorOf(user)
        },
        request.logger
      )

      request.logger.info(
        `Saved Jira workflow version ${after.version} for ${project.slug}`
      )

      return h.response(
        presentWorkflow({
          ...project,
          jira: { ...project.jira, statusMapping: after }
        })
      )
    }
  },
  {
    method: 'GET',
    path: '/api/projects/{slug}/jira/statuses',
    options: { validate: { params: projectSlugParamSchema } },
    handler: async (request, h) => {
      const { project } = await loadJiraProject(request)
      return h.response(
        await listProjectStatuses(
          request.db,
          project,
          request.server.jira,
          request.logger
        )
      )
    }
  }
]
