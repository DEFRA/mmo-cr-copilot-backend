import Joi from 'joi'

/**
 * Validation for the contributor → persona (role) mapping configured on the
 * dashboard's Settings page. Kept separate from the payload contract since
 * this is operator-entered configuration, not analytics data.
 */

// Mirrors GitHub's own username rules: alphanumeric, single hyphens, no
// leading/trailing hyphen, max 39 characters.
const GITHUB_HANDLE_PATTERN = /^[a-zA-Z\d](?:[a-zA-Z\d]|-(?=[a-zA-Z\d])){0,38}$/

export const PERSONAS = ['developer', 'devops', 'qa']

export const githubHandleParamSchema = Joi.object({
  githubHandle: Joi.string()
    .pattern(GITHUB_HANDLE_PATTERN)
    .message('{{#label}} must be a valid GitHub handle')
    .required()
})

export const personaMappingPayloadSchema = Joi.object({
  persona: Joi.string()
    .valid(...PERSONAS)
    .required()
}).options({ stripUnknown: true })
