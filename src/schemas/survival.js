import Joi from 'joi'

/**
 * AI code survival record: one per merged pull request and measurement window,
 * produced by the scheduled survival workflow (ADR 0007). It carries counts
 * only; no contributor identities or line content.
 */

const ISO_DATE_TIME =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/

const ONE_WEEK_DAYS = 7
const TWO_WEEKS_DAYS = 14
const THREE_WEEKS_DAYS = 21
const THIRTY_DAYS = 30
const MAX_REPOSITORY_LENGTH = 200
const MAX_PATH_LENGTH = 500

export const SURVIVAL_WINDOWS = [
  ONE_WEEK_DAYS,
  TWO_WEEKS_DAYS,
  THREE_WEEKS_DAYS,
  THIRTY_DAYS
]
export const MAX_SURVIVAL_FILES = 200
export const SURVIVAL_METADATA_SCHEMAS = [
  'ai-attribution/2',
  'mmo-attribution/1',
  'mmo-attribution/2'
]

const isoDateTime = Joi.string()
  .pattern(ISO_DATE_TIME)
  .message('{{#label}} must be an ISO-8601 date-time with a timezone offset')
  .required()

const sha = Joi.string()
  .pattern(/^[0-9a-f]{40}$/)
  .required()

const lines = Joi.number().integer().min(0).required()

const originPair = Joi.object({
  merged: lines,
  surviving: lines.max(Joi.ref('merged'))
}).required()

export const survivalSchema = Joi.object({
  kind: Joi.string().valid('ai-survival').required(),
  schemaVersion: Joi.number().valid(1).required(),
  repository: Joi.string()
    .pattern(/^[A-Za-z0-9-]+\/[A-Za-z0-9._-]+$/)
    .max(MAX_REPOSITORY_LENGTH)
    .required(),
  prNumber: Joi.number().integer().min(1).required(),
  mergeCommitSha: sha,
  mergedAt: isoDateTime,
  windowDays: Joi.number()
    .integer()
    .valid(...SURVIVAL_WINDOWS)
    .required(),
  measuredAt: isoDateTime,
  measuredCommitSha: sha,
  aiLinesMerged: lines,
  aiLinesSurviving: lines.max(Joi.ref('aiLinesMerged')),
  humanLinesMerged: lines,
  humanLinesSurviving: lines.max(Joi.ref('humanLinesMerged')),
  byOrigin: Joi.object({
    aiAgent: originPair,
    aiCompletion: originPair,
    aiChat: originPair
  }).required(),
  files: Joi.array()
    .max(MAX_SURVIVAL_FILES)
    .items(
      Joi.object({
        path: Joi.string().min(1).max(MAX_PATH_LENGTH).required(),
        aiMerged: lines,
        aiSurviving: lines.max(Joi.ref('aiMerged')),
        deleted: Joi.boolean().required()
      })
    )
    .default([]),
  metadataSchemas: Joi.array()
    .items(Joi.string().valid(...SURVIVAL_METADATA_SCHEMAS))
    .max(SURVIVAL_METADATA_SCHEMAS.length)
    .required(),
  calculatedAt: isoDateTime
}).options({ stripUnknown: true })
