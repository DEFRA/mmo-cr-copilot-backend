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

// Upper bounds sized well above a realistic pull request so a malformed or
// hostile producer cannot drive unbounded documents into Mongo.
export const MAX_COMMITS = 1000
export const MAX_CONTRIBUTORS = 200
export const MAX_JIRA_KEYS = 50
export const MAX_PR_TITLE_LENGTH = 256

/** Contract versions, see docs/adr/0001-payload-contract-v2.md. */
export const SCHEMA_VERSIONS = [1, 2]
export const CURRENT_SCHEMA_VERSION = 2
export const ATTRIBUTION_SOURCES = ['extension', 'legacy-trailer', 'none']
export const PAYLOAD_SOURCES = ['live', 'backfill']
export const JIRA_KEY_PATTERN = /^[A-Z][A-Z0-9_]{1,49}-[1-9]\d{0,9}$/

/**
 * `Rebase` and `Dependabot` commits are reported so a consumer can show how
 * many were set aside, but the producer excludes them from every total in
 * `summary` and `contributorBreakdown`. Payloads stored before the producer
 * classified them carry merge commits as `Human-authored`.
 */
export const COUNTED_CLASSIFICATIONS = ['Copilot-assisted', 'Human-authored']
export const EXCLUDED_CLASSIFICATIONS = ['Rebase', 'Dependabot']
export const COMMIT_CLASSIFICATIONS = [
  ...COUNTED_CLASSIFICATIONS,
  ...EXCLUDED_CLASSIFICATIONS
]

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
  copilotAssistedLineRate: percentage,
  // Optional: absent from payloads produced before commits were classified
  // as Rebase/Dependabot upstream.
  excludedCommits: count.optional(),
  rebaseCommits: count.optional(),
  dependabotCommits: count.optional()
})

// Line-level fields exist only for the VS Code extension source.
const extensionOnly = (schema) =>
  Joi.when('source', {
    is: 'extension',
    then: schema,
    otherwise: Joi.forbidden()
  })

const attributionLines = extensionOnly(Joi.number().integer().min(0))

const tokenCount = Joi.number().integer().min(0).max(10_000_000_000).default(0)

// A Copilot request shared between repositories counts as a share (ADR 0009).
const requestCount = Joi.number()
  .min(0)
  .max(10_000_000_000)
  .precision(2)
  .default(0)

// GitHub AI credits as recorded by the extension; absent means not recorded.
const aiCredits = Joi.number().min(0).max(1_000_000_000).precision(4)

// Copilot model usage for the commit, read from Copilot Chat's local usage log
// by the extension. Counts and credits only: no prompts, responses or identities.
export const MAX_USAGE_MODELS = 20
const usageSchema = Joi.object({
  models: Joi.array()
    .max(MAX_USAGE_MODELS)
    .items(
      Joi.object({
        model: Joi.string()
          .max(100)
          .pattern(/^[A-Za-z0-9._:/ -]+$/)
          .required(),
        requests: requestCount,
        inputTokens: tokenCount,
        outputTokens: tokenCount,
        cacheReadTokens: tokenCount,
        cacheCreationTokens: tokenCount,
        reasoningTokens: tokenCount,
        credits: aiCredits.optional()
      })
    )
    .required(),
  sessions: Joi.number().integer().min(0).max(10000).required(),
  commitsWithUsage: Joi.number().integer().min(0).max(10000).required()
})

const attributionSchema = Joi.object({
  source: Joi.string()
    .valid(...ATTRIBUTION_SOURCES)
    .required(),
  version: extensionOnly(Joi.number().integer().min(1).max(999).required()),
  aiCompletionLines: attributionLines,
  aiChatLines: attributionLines,
  aiAgentLines: attributionLines,
  pastedLines: attributionLines,
  typedLines: attributionLines,
  usage: extensionOnly(usageSchema)
})

const commitEntryV2Schema = commitEntrySchema.keys({
  attribution: attributionSchema.required()
})

const filesSchema = Joi.object({
  changed: count,
  linesTouched: count,
  testFilesChanged: count,
  testLinesTouched: count,
  modulesTouched: count,
  excluded: Joi.object({
    filesChanged: count,
    linesTouched: count
  }).required()
})

const commitBreakdown = (entrySchema) =>
  Joi.array().items(entrySchema).min(1).max(MAX_COMMITS).required()

const basePayloadKeys = {
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
    .max(MAX_CONTRIBUTORS)
    .required(),
  commitBreakdown: commitBreakdown(commitEntrySchema)
}

// v2-only keys sent on a v1 payload are stripped, matching the old tolerance.
const payloadV1Schema = Joi.object({
  ...basePayloadKeys,
  schemaVersion: Joi.number().integer().valid(1).default(1)
}).options({ stripUnknown: true })

const payloadV2Schema = Joi.object({
  ...basePayloadKeys,
  schemaVersion: Joi.number().integer().valid(2).required(),
  source: Joi.string()
    .valid(...PAYLOAD_SOURCES)
    .required(),
  prTitle: Joi.string().min(1).max(MAX_PR_TITLE_LENGTH).required(),
  jiraKeys: Joi.array()
    .items(Joi.string().max(64).pattern(JIRA_KEY_PATTERN))
    .unique()
    .max(MAX_JIRA_KEYS)
    .required(),
  files: filesSchema.required(),
  commitBreakdown: commitBreakdown(commitEntryV2Schema)
}).options({ stripUnknown: true })

/**
 * Routes on `schemaVersion`: 2 is v2, absent or anything else is checked as
 * v1, where only 1 is valid. Unknown keys are stripped rather than rejected,
 * so a producer emitting a newer field set still ingests.
 */
export const analyticsPayloadSchema = Joi.alternatives().conditional(
  Joi.object({ schemaVersion: Joi.number().valid(2).required() }).unknown(),
  { then: payloadV2Schema, otherwise: payloadV1Schema }
)

/**
 * Validation for an operator correcting one commit's classification from the
 * dashboard. Separate from the ingest contract above: this is a hand-made
 * change to a single field, not a machine-generated analytics message.
 */
export const commitClassificationParamsSchema = Joi.object({
  // URL-encoded on the wire (e.g. DEFRA%2Frepo-name).
  repository: Joi.string().min(1).max(512).required(),
  prNumber: Joi.number().integer().min(1).required(),
  commit: Joi.string()
    .pattern(/^[\da-f]{7,64}$/i)
    .message('{{#label}} must be a commit SHA')
    .required()
})

export const commitClassificationPayloadSchema = Joi.object({
  classification: Joi.string()
    .valid(...COMMIT_CLASSIFICATIONS)
    .required()
}).options({ stripUnknown: true })
