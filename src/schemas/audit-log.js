import Joi from 'joi'

/**
 * Validation for the audit trail: the record of every operator-initiated
 * change made through the dashboard. Analytics ingest is not audited — it is
 * machine-generated and already reproducible from the build — so this covers
 * only the changes a person makes by hand.
 */

export const AUDIT_ENTITIES = {
  commitClassification: 'commit-classification',
  personaMapping: 'persona-mapping'
}

export const AUDIT_ACTIONS = {
  commitClassificationUpdated: 'commit-classification.updated',
  personaMappingUpserted: 'persona-mapping.upserted',
  personaMappingDeleted: 'persona-mapping.deleted'
}

const MAX_PAGE_SIZE = 200
const DEFAULT_PAGE_SIZE = 25

/**
 * `from`/`to` bound the query on `occurredAt` as a half-open range
 * `[from, to)`, so consecutive windows neither overlap nor drop an entry on
 * the boundary. Joi parses both into `Date` instances for Mongo.
 */
export const auditLogQuerySchema = Joi.object({
  from: Joi.date().iso().optional(),
  to: Joi.date().iso().greater(Joi.ref('from')).optional(),
  page: Joi.number().integer().min(1).default(1),
  pageSize: Joi.number()
    .integer()
    .min(1)
    .max(MAX_PAGE_SIZE)
    .default(DEFAULT_PAGE_SIZE)
}).options({ stripUnknown: true })
