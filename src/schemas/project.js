import Joi from 'joi'

// Project slug: three or four uppercase letters or digits, starting with a letter (e.g. CRAR, FES).
export const PROJECT_SLUG_PATTERN = /^[A-Z][A-Z0-9]{2,3}$/

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
  slug: Joi.string().pattern(PROJECT_SLUG_PATTERN).min(3).max(4).required(),
  name: Joi.string().min(1).max(200).required(),
  type: Joi.string().valid('ai-adopted', 'ai-native').required(),
  adoptionStartDate: Joi.date().iso().optional(),
  sprintCalendar: Joi.object({
    cadenceDays: Joi.number().integer().min(1).max(30).default(14),
    anchorDate: Joi.date().iso().default('2026-07-08T00:00:00.000Z')
  }).default(),
  jira: Joi.object({
    projectKeys: Joi.array()
      .items(Joi.string().pattern(/^[A-Z][A-Z0-9_]+$/))
      .max(20)
      .default([]),
    storyPointsField: Joi.string().default('customfield_10016'),
    boardId: Joi.number().integer().positive().optional(),
    waitingStatuses: Joi.array().items(Joi.string().max(60)).max(30).optional()
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
  jira: Joi.object({
    projectKeys: Joi.array()
      .items(Joi.string().pattern(/^[A-Z][A-Z0-9_]+$/))
      .max(20)
      .default([]),
    storyPointsField: Joi.string().default('customfield_10016'),
    boardId: Joi.number().integer().positive().optional(),
    waitingStatuses: Joi.array().items(Joi.string().max(60)).max(30).optional()
  }).optional()
}).options({ stripUnknown: true })

export const repositoryMapSchema = Joi.object({
  projectSlug: Joi.string().required(),
  sonarProjectKey: Joi.string().allow('', null).optional()
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
