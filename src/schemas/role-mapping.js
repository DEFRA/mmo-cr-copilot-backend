import Joi from 'joi'

import { PROJECT_SLUG_PATTERN } from '#/schemas/project.js'

export const ROLES = {
  dashboardAdmin: 'Dashboard.Admin',
  projectAdmin: 'project-admin',
  projectUser: 'project-user'
}
export const ROLE_MAPPING_ROLES = Object.values(ROLES)
export const ROLE_MAPPING_SCOPES = ['global', 'project']

// The group name exactly as the Entra groups claim emits it: compared
// case-sensitively, so it is never lower-cased or otherwise rewritten.
const groupName = Joi.string()
  .trim()
  .min(1)
  .max(256)
  // eslint-disable-next-line no-control-regex -- control characters are exactly what is rejected
  .pattern(/^[^\u0000-\u001f\u007f]+$/)
  .message('{{#label}} must not contain control characters')

const projectSlug = Joi.string().pattern(PROJECT_SLUG_PATTERN)
const description = Joi.string().allow('').max(500)

export const roleMappingCreateSchema = Joi.object({
  groupName: groupName.required(),
  role: Joi.string()
    .valid(...ROLE_MAPPING_ROLES)
    .required(),
  projectSlug: Joi.when('role', {
    is: ROLES.dashboardAdmin,
    then: Joi.valid(null).default(null),
    otherwise: projectSlug.required()
  }),
  description: description.optional()
}).options({ stripUnknown: true })

// The group is immutable: changing it is a delete and a create.
export const roleMappingUpdateSchema = Joi.object({
  role: Joi.string().valid(...ROLE_MAPPING_ROLES),
  projectSlug: projectSlug.allow(null),
  description
})
  .min(1)
  .options({ stripUnknown: true })

export const roleMappingIdParamSchema = Joi.object({
  id: Joi.string().hex().length(24).required()
})

export const roleMappingListQuerySchema = Joi.object({
  projectSlug: projectSlug.optional()
}).options({ stripUnknown: true })

/** global for Dashboard Admin, project for everything else. */
export const scopeForRole = (role) =>
  role === ROLES.dashboardAdmin ? 'global' : 'project'
