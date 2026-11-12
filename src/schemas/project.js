import Joi from 'joi'

// Any stored slug: 3–4 upper-case letters or digits starting with a letter, so legacy digit slugs still resolve.
export const PROJECT_SLUG_PATTERN = /^[A-Z][A-Z0-9]{2,3}$/
// New projects only: 3–4 upper-case letters (ADR 0010).
export const PROJECT_SLUG_CREATE_PATTERN = /^[A-Z]{3,4}$/

export const JIRA_PROJECT_KEY_PATTERN = /^[A-Z][A-Z0-9_]+$/
export const STORY_POINTS_FIELD_PATTERN = /^customfield_\d+$/
export const SONAR_PROJECT_KEY_PATTERN = /^[\w.:-]+$/

export const AI_NATIVE_JIRA_KEY_MESSAGE =
  'AI-Native projects require exactly one Jira project key'
export const JIRA_KEY_REQUIRED_MESSAGE =
  'The Jira project key cannot be removed'

// Trimmed; '' and null both mean "no key" and are stored as null.
const sonarProjectKey = Joi.string()
  .trim()
  .max(255)
  .pattern(SONAR_PROJECT_KEY_PATTERN)
  .allow('', null)

const jiraProjectKeys = Joi.array()
  .items(Joi.string().pattern(JIRA_PROJECT_KEY_PATTERN))
  .max(1)

/** True unless the project is AI-Native without exactly one Jira project key. */
export function hasRequiredJiraKey({ type, jira } = {}) {
  return type !== 'ai-native' || jira?.projectKeys?.length === 1
}

const weight = Joi.number().min(0).max(1).required()

// The version is server-owned: each admin change increments it.
export const complexityModelSchema = Joi.object({
  lineCap: Joi.number().integer().min(1).max(100000).required(),
  fileCap: Joi.number().integer().min(1).max(10000).required(),
  moduleCap: Joi.number().integer().min(1).max(1000).required(),
  weights: Joi.object({ lines: weight, files: weight, modules: weight })
    .required()
    .custom((w, helpers) =>
      Math.abs(w.lines + w.files + w.modules - 1) < 1e-6
        ? w
        : helpers.message('weights must sum to 1')
    ),
  hardCapLines: Joi.number().integer().min(1).max(1000000).required(),
  hardCapFiles: Joi.number().integer().min(1).max(100000).required()
}).options({ stripUnknown: true })

export const projectCreateSchema = Joi.object({
  slug: Joi.string().pattern(PROJECT_SLUG_CREATE_PATTERN).required(),
  name: Joi.string().min(1).max(200).required(),
  type: Joi.string().valid('ai-adopted', 'ai-native').required(),
  adoptionStartDate: Joi.date().iso().optional(),
  sprintCalendar: Joi.object({
    cadenceDays: Joi.number().integer().min(1).max(30).default(14),
    anchorDate: Joi.date().iso().default('2026-07-08T00:00:00.000Z')
  }).default(),
  jira: Joi.object({
    projectKeys: jiraProjectKeys.default([]),
    storyPointsField: Joi.string()
      .pattern(STORY_POINTS_FIELD_PATTERN)
      .optional(),
    boardId: Joi.number().integer().positive().optional()
  }).default()
}).options({ stripUnknown: true })

export const projectUpdateSchema = Joi.object({
  slug: Joi.forbidden(),
  name: Joi.string().min(1).max(200).optional(),
  type: Joi.string().valid('ai-adopted', 'ai-native').optional(),
  adoptionStartDate: Joi.date().iso().allow(null).optional(),
  sprintCalendar: Joi.object({
    cadenceDays: Joi.number().integer().min(1).max(30).default(14),
    anchorDate: Joi.date().iso().default('2026-07-08T00:00:00.000Z')
  }).optional(),
  // No defaults: an omitted field must leave the stored value alone.
  jira: Joi.object({
    projectKeys: jiraProjectKeys.optional(),
    storyPointsField: Joi.string()
      .pattern(STORY_POINTS_FIELD_PATTERN)
      .allow(null)
      .optional(),
    boardId: Joi.number().integer().positive().optional()
  }).optional()
}).options({ stripUnknown: true })

// The SonarCloud key is set only through the sonar-key route.
export const repositoryMapSchema = Joi.object({
  projectSlug: Joi.string().pattern(PROJECT_SLUG_PATTERN).required()
}).options({ stripUnknown: true })

export const repositorySonarKeySchema = Joi.object({
  sonarProjectKey: sonarProjectKey.required()
}).options({ stripUnknown: true })

export const projectSlugParamSchema = Joi.object({
  slug: Joi.string().pattern(PROJECT_SLUG_PATTERN).required()
})

export const repositoryFullNameParamSchema = Joi.object({
  fullName: Joi.string().min(1).max(512).required()
})

export const projectPayloadsQuerySchema = Joi.object({
  from: Joi.date().iso().optional(),
  to: Joi.date().iso().optional()
}).options({ stripUnknown: true })

export const leverageQuerySchema = Joi.object({
  from: Joi.date().iso().optional(),
  to: Joi.date().iso().optional(),
  repository: Joi.string().min(1).max(512).optional()
}).options({ stripUnknown: true })

export const projectSprintsQuerySchema = Joi.object({
  count: Joi.number().integer().min(1).max(50).default(5).optional()
}).options({ stripUnknown: true })

// Set by a project admin from Settings → JIRA; both fields are required.
export const sprintCalendarSchema = Joi.object({
  cadenceDays: Joi.number().integer().min(1).max(30).required(),
  anchorDate: Joi.date().iso().required()
}).options({ stripUnknown: true })

export const JIRA_ISSUE_KEY_PATTERN = /^[A-Z][A-Z0-9_]+-\d+$/

export const prLinkParamSchema = Joi.object({
  slug: Joi.string().pattern(PROJECT_SLUG_PATTERN).required(),
  repository: Joi.string().min(1).max(512).required(),
  prNumber: Joi.number().integer().min(1).required()
})

export const prLinkPayloadSchema = Joi.object({
  jiraKeys: Joi.array()
    .items(Joi.string().pattern(JIRA_ISSUE_KEY_PATTERN))
    .max(20)
    .unique()
    .required()
}).options({ stripUnknown: true })
