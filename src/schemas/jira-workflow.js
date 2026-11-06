import Boom from '@hapi/boom'
import Joi from 'joi'

import { failAction } from '#/common/helpers/fail-action.js'
import {
  MAX_STATUS_LENGTH,
  MAX_STATUSES_PER_STAGE,
  STAGE_IDS,
  tidyStatus,
  workflowStagesError
} from '#/services/workflow-stages.js'

const statusName = Joi.string()
  .trim()
  .min(1)
  .max(MAX_STATUS_LENGTH)
  // eslint-disable-next-line no-control-regex -- control characters are exactly what is rejected
  .pattern(/^[^\u0000-\u001f\u007f]+$/)
  .custom((value) => tidyStatus(value))

const WORKFLOW_RULE = 'workflow.rule'

// `version` is the stored version the edit started from: 0 when nothing is saved yet.
export const jiraWorkflowPayloadSchema = Joi.object({
  version: Joi.number().integer().min(0).required(),
  stages: Joi.array()
    .items(
      Joi.object({
        id: Joi.string()
          .valid(...STAGE_IDS)
          .required(),
        statuses: Joi.array()
          .items(statusName)
          .max(MAX_STATUSES_PER_STAGE)
          .required()
      })
    )
    .min(2)
    .max(STAGE_IDS.length)
    .unique('id')
    .required()
    .custom((stages, helpers) => {
      const rule = workflowStagesError(stages)
      // A local, not helpers.message(): status names must not be parsed as a joi template.
      return rule ? helpers.error(WORKFLOW_RULE, { rule }) : stages
    })
    .messages({ [WORKFLOW_RULE]: '{#rule}' })
}).options({ stripUnknown: true })

/** Like the global failAction, but a broken workflow rule is shown to the admin. */
export function workflowFailAction(request, h, error) {
  const broken = error?.details?.find((d) => d.type === WORKFLOW_RULE)
  if (!broken) return failAction(request, h, error)
  request.logger.warn(
    { validation: { paths: [{ path: 'stages', type: WORKFLOW_RULE }] } },
    'Request failed validation'
  )
  throw Boom.badRequest(broken.context.rule)
}
