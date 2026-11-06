import Joi from 'joi'

/**
 * Validation for the contributor → persona (role) mapping configured on the
 * dashboard's Settings page. Kept separate from the payload contract since
 * this is operator-entered configuration, not analytics data.
 */

// The git config author name, so free text; it is a URL path segment, hence no slashes or dot segments.
const GITHUB_HANDLE_PATTERN = /^(?!\.{1,2}$)(?!\s)(?!.*\s$)[^/\\\p{Cc}]+$/u

export const PERSONAS = ['developer', 'devops', 'qa']

export const githubHandleParamSchema = Joi.object({
  githubHandle: Joi.string()
    .max(100)
    .pattern(GITHUB_HANDLE_PATTERN)
    .message('{{#label}} must not contain slashes or be a dot segment')
    .required()
})

export const personaMappingPayloadSchema = Joi.object({
  persona: Joi.string()
    .valid(...PERSONAS)
    .required()
}).options({ stripUnknown: true })
