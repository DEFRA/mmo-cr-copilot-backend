import Boom from '@hapi/boom'

import { config } from '#/config.js'
import {
  TOKEN_ERRORS,
  TokenError,
  createJwksResolver,
  readAuthSettings,
  verifyAccessToken
} from '#/common/helpers/token-validator.js'
import { resolveUserRoles } from '#/services/role-mappings.js'

export const ENTRA_STRATEGY = 'entra'
const REALM = 'mmo-cr-copilot-backend'

const BEARER = /^Bearer\s+(\S+)$/i

function challenge(extra = '') {
  return `Bearer realm="${REALM}"${extra}`
}

function unauthorized(error) {
  const err = Boom.unauthorized(error ? 'Invalid access token' : null)
  err.output.headers['WWW-Authenticate'] = challenge(
    error ? `, error="${error}"` : ''
  )
  return err
}

function forbidden(message, header) {
  const err = Boom.forbidden(message)
  if (header) err.output.headers['WWW-Authenticate'] = header
  return err
}

function logFailure(request, code, oid) {
  request.logger?.warn(
    {
      event: {
        category: 'authentication',
        action: 'token-validation',
        outcome: 'failure',
        reason: code === TOKEN_ERRORS.overage ? 'group-overage' : code
      },
      ...(oid ? { user: { id: oid } } : {})
    },
    'Access token rejected'
  )
}

function toBoom(request, error) {
  const code = error instanceof TokenError ? error.code : 'unexpected'
  logFailure(request, code)
  if (code === TOKEN_ERRORS.overage) return forbidden('Group overage')
  if (code === TOKEN_ERRORS.scope) {
    return forbidden(
      'Insufficient scope',
      challenge(
        `, error="insufficient_scope", scope="${config.get('auth.entraBackendScope')}"`
      )
    )
  }
  return unauthorized('invalid_token')
}

function createScheme(options) {
  return () => ({
    authenticate: async (request, h) => {
      const header = request.headers.authorization
      if (!header) throw unauthorized()
      const match = BEARER.exec(header)
      if (!match) throw unauthorized('invalid_request')

      let claims
      try {
        claims = await verifyAccessToken(match[1], { jwks: options.jwks })
      } catch (error) {
        throw toBoom(request, error)
      }

      const roles = await resolveUserRoles(request.db, claims)
      return h.authenticated({ credentials: { ...claims, ...roles } })
    }
  })
}

/**
 * Makes bearer-token validation the default for every route: each request is
 * verified in full, with roles resolved from role_mappings. Routes that must
 * stay open (health, ingest) opt out with `options.auth: false`.
 */
export const entraAuth = {
  plugin: {
    name: 'entra-auth',
    register(server, options = {}) {
      server.auth.scheme('entra-bearer', createScheme(options))
      server.auth.strategy(ENTRA_STRATEGY, 'entra-bearer')
      server.auth.default(ENTRA_STRATEGY)

      // Warm the signing keys without delaying or failing start-up.
      const warm = async () => {
        const settings = readAuthSettings()
        if (options.jwks || settings.devBypass || !settings.tenantId) return
        try {
          const jwks = createJwksResolver({
            tenantId: settings.tenantId,
            timeoutMs: settings.jwksTimeoutMs,
            cacheMaxAgeMs: settings.jwksCacheMaxAgeMs,
            cooldownMs: settings.jwksCooldownMs
          })
          await jwks({ alg: 'RS256' }, { payload: '', signature: '' }).catch(
            (error) => {
              // Without a kid these only prove the key set was fetched and cached.
              if (
                [
                  'ERR_JWKS_NO_MATCHING_KEY',
                  'ERR_JWKS_MULTIPLE_MATCHING_KEYS'
                ].includes(error?.code)
              ) {
                return
              }
              throw error
            }
          )
        } catch (error) {
          server.logger.warn(
            { err: error?.code ?? error?.message },
            'Could not warm the Entra signing keys'
          )
        }
      }
      server.ext('onPostStart', () => {
        warm()
      })
    }
  }
}
