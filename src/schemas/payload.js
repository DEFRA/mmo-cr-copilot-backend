import Joi from 'joi'

/**
 * Validation for the Copilot analytics payload posted by the GitHub Actions
 * workflow (via the dashboard frontend). The shape mirrors what the analytics
 * job emits and what the dashboard renders, so anything that does not match is
 * rejected at the boundary rather than persisted and broken downstream.
 */

// ISO-8601 date-time that must carry a timezone (`Z` or `±hh:mm`).
const ISO_DATE_TIME =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/

// Absent keys, explicit `null`, and `""` all mean "not provided".
const emptyish = Joi.valid('', null)

const isoDateTime = Joi.string()
  .pattern(ISO_DATE_TIME)
  .message('{{#label}} must be an ISO-8601 date-time with a timezone offset')

const optionalIsoDateTime = isoDateTime.empty(emptyish).optional()

const optionalString = Joi.string().min(1).max(512).empty(emptyish).optional()

const count = Joi.number().integer().min(0).required()
const percentage = Joi.number().min(0).max(100).required()

export const COMMIT_CLASSIFICATIONS = ['Copilot-assisted', 'Human-authored']

const commitEntrySchema = Joi.object({
  commit: Joi.string().min(1).max(64).required(),
  committedAt: optionalIsoDateTime,
  author: Joi.string().min(1).max(256).required(),
  subject: Joi.string().max(1024).allow('').required(),
  classification: Joi.string()
    .valid(...COMMIT_CLASSIFICATIONS)
    .required(),
  filesChanged: count,
  linesAdded: count,
  linesDeleted: count,
  linesTouched: count,
  netLines: Joi.number().integer().required()
})

const contributorEntrySchema = Joi.object({
  contributor: Joi.string().min(1).max(256).required(),
  totalCommits: count,
  copilotAssisted: count,
  humanAuthored: count,
  linesAdded: count,
  linesDeleted: count,
  linesTouched: count,
  netLines: Joi.number().integer().required(),
  copilotAssistedLines: count,
  humanAuthoredLines: count
})

const summarySchema = Joi.object({
  totalCommits: count,
  copilotAssistedCommits: count,
  humanAuthoredCommits: count,
  copilotAssistedRate: percentage,
  totalLinesTouched: count,
  copilotAssistedLines: count,
  humanAuthoredLines: count,
  copilotAssistedLineRate: percentage
})

/**
 * Unknown keys are stripped rather than rejected, so a producer emitting an
 * older or newer field set still ingests — only the agreed contract is stored.
 */
export const analyticsPayloadSchema = Joi.object({
  prNumber: Joi.number().integer().min(1).required(),
  repository: Joi.string().min(1).max(512).required(),
  sourceBranch: optionalString,
  targetBranch: Joi.string().min(1).max(512).required(),
  buildId: Joi.string().min(1).max(128).required(),
  calculatedAt: isoDateTime.required(),
  prCreatedAt: optionalIsoDateTime,
  firstCommitAt: optionalIsoDateTime,
  lastCommitAt: optionalIsoDateTime,
  prMergedAt: optionalIsoDateTime,
  summary: summarySchema.required(),
  contributorBreakdown: Joi.array()
    .items(contributorEntrySchema)
    .min(1)
    .required(),
  commitBreakdown: Joi.array().items(commitEntrySchema).min(1).required()
}).options({ stripUnknown: true })
