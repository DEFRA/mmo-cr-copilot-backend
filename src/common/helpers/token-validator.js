import { createRemoteJWKSet, errors, jwtVerify } from 'jose'

import { config } from '#/config.js'
import {
  GUID_PATTERN,
  parseGuidList
} from '#/common/helpers/convict/validate-guid.js'

export const TOKEN_ERRORS = {
  missing: 'missing',
  malformed: 'malformed',
  signature: 'signature',
  expired: 'expired',
  notYetValid: 'not-yet-valid',
  issuer: 'issuer',
  audience: 'audience',
  version: 'version',
  tenant: 'tenant',
  scope: 'scope',
  client: 'client',
  subject: 'subject',
  overage: 'overage',
  jwks: 'jwks'
}

export class TokenError extends Error {
  constructor(code, message = code) {
    super(message)
    this.name = 'TokenError'
    this.code = code
  }
}

const DEV_TOKEN_PREFIX = 'dev-mock'
const REQUIRED_CLAIMS = ['exp', 'iat', 'nbf', 'oid', 'tid', 'scp', 'azp', 'ver']
// A missing claim is reported as the check that needed it.
const MISSING_CLAIM_ERRORS = {
  iss: TOKEN_ERRORS.issuer,
  aud: TOKEN_ERRORS.audience,
  ver: TOKEN_ERRORS.version,
  tid: TOKEN_ERRORS.tenant,
  scp: TOKEN_ERRORS.scope,
  azp: TOKEN_ERRORS.client
}
const jwksByTenant = new Map()

/** Reads the validation settings at call time so tests can change config. */
export function readAuthSettings() {
  return {
    tenantId: config.get('auth.entraTenantId'),
    clientId: config.get('auth.entraBackendClientId'),
    scope: config.get('auth.entraBackendScope'),
    allowedClientIds: parseGuidList(config.get('auth.allowedClientIds')),
    clockToleranceSeconds: config.get('auth.clockToleranceSeconds'),
    jwksTimeoutMs: config.get('auth.jwksTimeoutMs'),
    jwksCacheMaxAgeMs: config.get('auth.jwksCacheMaxAgeMs'),
    jwksCooldownMs: config.get('auth.jwksCooldownMs'),
    devBypass: config.get('auth.devBypass')
  }
}

export function createJwksResolver({
  tenantId,
  timeoutMs,
  cacheMaxAgeMs,
  cooldownMs
}) {
  if (!jwksByTenant.has(tenantId)) {
    jwksByTenant.set(
      tenantId,
      createRemoteJWKSet(
        new URL(
          `https://login.microsoftonline.com/${tenantId}/discovery/v2.0/keys`
        ),
        {
          timeoutDuration: timeoutMs,
          cacheMaxAge: cacheMaxAgeMs,
          cooldownDuration: cooldownMs
        }
      )
    )
  }
  return jwksByTenant.get(tenantId)
}

// Group names are kept exactly as emitted; no normalisation or GUID check.
const toClaims = (payload) => ({
  oid: payload.oid,
  tid: payload.tid,
  name: payload.name,
  email: payload.email ?? payload.preferred_username,
  groups: Array.isArray(payload.groups)
    ? payload.groups.filter((group) => typeof group === 'string')
    : []
})

function assertNoOverage(payload) {
  if (payload.hasgroups === true || payload._claim_names?.groups) {
    throw new TokenError(TOKEN_ERRORS.overage, 'Group overage')
  }
}

// Dev/test only: `dev-mock` or `dev-mock.<base64url JSON claims>`.
function parseDevToken(token) {
  const encoded = token.slice(DEV_TOKEN_PREFIX.length + 1)
  let claims = {}
  if (encoded) {
    try {
      claims = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8'))
    } catch {
      throw new TokenError(TOKEN_ERRORS.malformed, 'Malformed dev token')
    }
    if (claims === null || typeof claims !== 'object') {
      throw new TokenError(TOKEN_ERRORS.malformed, 'Malformed dev token')
    }
  }
  const payload = {
    oid: 'dev-user',
    tid: 'dev-tenant',
    name: 'Dev User',
    ...claims
  }
  if (typeof payload.oid !== 'string' || !payload.oid) {
    throw new TokenError(TOKEN_ERRORS.subject, 'Missing oid')
  }
  assertNoOverage(payload)
  return toClaims(payload)
}

function mapJoseError(error) {
  if (error instanceof errors.JWTExpired) {
    return new TokenError(TOKEN_ERRORS.expired, 'Token expired')
  }
  if (error instanceof errors.JWTClaimValidationFailed) {
    if (error.claim === 'nbf') {
      return new TokenError(TOKEN_ERRORS.notYetValid, 'Token not yet valid')
    }
    if (error.claim === 'iss') {
      return new TokenError(TOKEN_ERRORS.issuer, 'Unexpected issuer')
    }
    if (error.claim === 'aud') {
      return new TokenError(TOKEN_ERRORS.audience, 'Unexpected audience')
    }
    return new TokenError(
      MISSING_CLAIM_ERRORS[error.claim] ?? TOKEN_ERRORS.subject,
      `Claim ${error.claim} is invalid`
    )
  }
  if (
    error instanceof errors.JWSSignatureVerificationFailed ||
    error instanceof errors.JWSInvalid ||
    error instanceof errors.JOSEAlgNotAllowed ||
    error instanceof errors.JWTInvalid
  ) {
    return new TokenError(TOKEN_ERRORS.signature, 'Invalid token signature')
  }
  if (
    error instanceof errors.JWKSTimeout ||
    error instanceof errors.JWKSNoMatchingKey ||
    error instanceof errors.JWKSMultipleMatchingKeys
  ) {
    return new TokenError(TOKEN_ERRORS.jwks, 'Signing key unavailable')
  }
  return new TokenError(TOKEN_ERRORS.malformed, 'Token could not be verified')
}

/**
 * Verifies an Entra ID v2 delegated access token issued for this API and
 * returns the caller's claims. Throws a TokenError with a stable `code` when
 * the token is invalid for any reason. Called on every request.
 * options: { jwks, settings, now }
 */
export async function verifyAccessToken(token, options = {}) {
  if (typeof token !== 'string' || !token) {
    throw new TokenError(TOKEN_ERRORS.missing, 'Token missing')
  }

  const settings = options.settings ?? readAuthSettings()

  if (token === DEV_TOKEN_PREFIX || token.startsWith(`${DEV_TOKEN_PREFIX}.`)) {
    if (!settings.devBypass) {
      throw new TokenError(TOKEN_ERRORS.malformed, 'Dev tokens are disabled')
    }
    return parseDevToken(token)
  }

  const { tenantId, clientId } = settings
  if (!tenantId || !clientId) {
    throw new TokenError(TOKEN_ERRORS.jwks, 'Entra is not configured')
  }

  const jwks =
    options.jwks ??
    createJwksResolver({
      tenantId,
      timeoutMs: settings.jwksTimeoutMs,
      cacheMaxAgeMs: settings.jwksCacheMaxAgeMs,
      cooldownMs: settings.jwksCooldownMs
    })

  let payload
  try {
    ;({ payload } = await jwtVerify(token, jwks, {
      algorithms: ['RS256'],
      issuer: `https://login.microsoftonline.com/${tenantId}/v2.0`,
      audience: clientId,
      clockTolerance: settings.clockToleranceSeconds,
      requiredClaims: REQUIRED_CLAIMS,
      ...(options.now ? { currentDate: options.now } : {})
    }))
  } catch (error) {
    throw mapJoseError(error)
  }

  if (payload.ver !== '2.0') {
    throw new TokenError(TOKEN_ERRORS.version, 'Unexpected token version')
  }
  if (payload.tid !== tenantId) {
    throw new TokenError(TOKEN_ERRORS.tenant, 'Unexpected tenant')
  }
  const scopes = typeof payload.scp === 'string' ? payload.scp.split(' ') : []
  if (!scopes.includes(settings.scope)) {
    throw new TokenError(TOKEN_ERRORS.scope, 'Required scope missing')
  }
  if (
    !settings.allowedClientIds.includes(payload.azp) ||
    !['1', '2'].includes(String(payload.azpacr))
  ) {
    throw new TokenError(TOKEN_ERRORS.client, 'Client is not allowed')
  }
  if (typeof payload.oid !== 'string' || !GUID_PATTERN.test(payload.oid)) {
    throw new TokenError(TOKEN_ERRORS.subject, 'Invalid oid')
  }
  assertNoOverage(payload)

  return toClaims(payload)
}
