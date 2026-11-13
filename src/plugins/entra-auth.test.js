import {
  TEST_IDS,
  createSigningKeys,
  signAccessToken,
  unsignedToken,
  validClaims
} from '#/test-helpers/entra-tokens.js'
import { devToken, grantAccess } from '#/test-helpers/auth-headers.js'

const INGEST_TOKEN = 'test-ingest-token'
const CONFIG_KEYS = {
  'auth.devBypass': false,
  'auth.entraTenantId': TEST_IDS.tenant,
  'auth.entraBackendClientId': TEST_IDS.backendClient,
  'auth.allowedClientIds': TEST_IDS.dashboardClient
}

describe('#entra-auth strategy', () => {
  let server
  let keys
  let logged
  let previous
  let config

  const bearer = (token) => ({ authorization: `Bearer ${token}` })
  const get = (url, headers) => server.inject({ url, headers })
  const tokenFor = (claims, options) => signAccessToken(keys, claims, options)

  beforeAll(async () => {
    ;({ config } = await import('#/config.js'))
    previous = Object.fromEntries(
      Object.keys(CONFIG_KEYS).map((key) => [key, config.get(key)])
    )
    for (const [key, value] of Object.entries(CONFIG_KEYS)) {
      config.set(key, value)
    }
    process.env.INGEST_TOKEN = INGEST_TOKEN
    config.set('ingest.token', INGEST_TOKEN)

    keys = await createSigningKeys()
    const { createServer } = await import('#/server.js')
    server = await createServer({ jwks: keys.jwks })
    await server.initialize()
    server.ext('onRequest', (request, h) => {
      const wrap = (level) => {
        const original = request.logger[level].bind(request.logger)
        request.logger[level] = (...args) => {
          logged.push({ level, args })
          return original(...args)
        }
      }
      ;['warn', 'info', 'error'].forEach(wrap)
      return h.continue
    })
  })

  afterAll(async () => {
    await server.stop({ timeout: 1000 })
    for (const [key, value] of Object.entries(previous)) {
      config.set(key, value)
    }
    config.set('ingest.token', '')
    delete process.env.INGEST_TOKEN
  })

  beforeEach(async () => {
    logged = []
    await server.db.collection('role_mappings').deleteMany({})
    await server.db.collection('projects').deleteMany({})
    await server.db.collection('repositories').deleteMany({})
  })

  const authFailure = () =>
    logged.find(({ args }) => args[0]?.event?.category === 'authentication')

  const expectNoJwtLogged = () => {
    expect(JSON.stringify(logged)).not.toMatch(/eyJ/)
  }

  describe('authentication failures', () => {
    test('Should answer 401 with a Bearer challenge when no token is sent', async () => {
      const { statusCode, headers } = await get('/api/projects')

      expect(statusCode).toBe(401)
      expect(headers['www-authenticate']).toBe(
        'Bearer realm="mmo-cr-copilot-backend"'
      )
    })

    test('Should answer 401 invalid_request for a non-Bearer scheme', async () => {
      const { statusCode, headers } = await get('/api/projects', {
        authorization: 'Basic eDp5'
      })

      expect(statusCode).toBe(401)
      expect(headers['www-authenticate']).toContain('error="invalid_request"')
    })

    test.each([
      [
        'wrong audience',
        () => tokenFor({}, { audience: 'api://other' }),
        'audience'
      ],
      [
        'v1 issuer',
        () =>
          tokenFor(
            {},
            { issuer: `https://sts.windows.net/${TEST_IDS.tenant}/` }
          ),
        'issuer'
      ],
      ['expired', () => tokenFor({}, { expiresAt: 1 }), 'expired'],
      [
        'tampered',
        async () => {
          const [h, , s] = (await tokenFor({})).split('.')
          const p = Buffer.from(JSON.stringify(validClaims())).toString(
            'base64url'
          )
          return `${h}.${p}.${s}`
        },
        'signature'
      ],
      ['alg none', async () => unsignedToken(), 'signature'],
      [
        'unauthorised client',
        () => tokenFor({ azp: TEST_IDS.otherClient }),
        'client'
      ]
    ])('Should answer 401 invalid_token for %s', async (_, make, reason) => {
      const token = await make()

      const { statusCode, headers } = await get('/api/projects', bearer(token))

      expect(statusCode).toBe(401)
      expect(headers['www-authenticate']).toContain('error="invalid_token"')
      expect(authFailure().args[0].event).toMatchObject({
        outcome: 'failure',
        reason
      })
      expectNoJwtLogged()
    })

    test('Should answer 403 insufficient_scope when access_as_user is missing', async () => {
      const token = await tokenFor({ scp: 'other' })

      const { statusCode, headers } = await get('/api/projects', bearer(token))

      expect(statusCode).toBe(403)
      expect(headers['www-authenticate']).toContain(
        'error="insufficient_scope"'
      )
    })

    test('Should answer 403 for group overage and log the reason', async () => {
      const token = await tokenFor({ groups: undefined, hasgroups: true })

      const { statusCode } = await get('/api/projects', bearer(token))

      expect(statusCode).toBe(403)
      expect(authFailure().args[0].event.reason).toBe('group-overage')
      expectNoJwtLogged()
    })

    test('Should refuse a dev token when the bypass is off', async () => {
      const { statusCode } = await get(
        '/api/projects',
        bearer(devToken({ oid: 'someone' }))
      )

      expect(statusCode).toBe(401)
    })
  })

  describe('authenticated requests', () => {
    test('Should serve an empty project list to a valid token with no mappings', async () => {
      const token = await tokenFor({})

      const { statusCode, result } = await get('/api/projects', bearer(token))

      expect(statusCode).toBe(200)
      expect(result.projects).toEqual([])
    })

    test('Should ignore a roles claim without an admin mapping', async () => {
      const token = await tokenFor({ roles: ['Dashboard.Admin'] })

      const { statusCode } = await get('/api/role-mappings', bearer(token))

      expect(statusCode).toBe(403)
    })

    test('Should grant admin only through the role mapping', async () => {
      await grantAccess(server.db)
      const token = await tokenFor({
        groups: ['AG-Users-CopilotAnalytics-Dashboard-Admin']
      })

      const { statusCode } = await get('/api/role-mappings', bearer(token))

      expect(statusCode).toBe(200)
    })

    test('Should validate the token on every request', async () => {
      const token = await tokenFor(
        {},
        { expiresAt: Math.floor(Date.now() / 1000) + 3600 }
      )
      const first = await get('/api/auth/me', bearer(token))
      const second = await get('/api/auth/me', bearer(`${token}x`))

      expect(first.statusCode).toBe(200)
      expect(second.statusCode).toBe(401)
    })
  })

  describe('routes that stay open', () => {
    test('Should serve /health without a token', async () => {
      expect((await get('/health')).statusCode).toBe(200)
    })

    test('Should reach the ingest handlers without a bearer token once the ingest token matches', async () => {
      const { statusCode } = await server.inject({
        method: 'POST',
        url: '/api/payloads',
        headers: { 'x-ingest-token': INGEST_TOKEN },
        payload: {}
      })

      // Past authentication: the handler's own validation rejects the empty body
      expect(statusCode).toBe(400)
    })

    test('Should keep auth disabled on exactly the expected routes', () => {
      const open = server
        .table()
        .filter((route) => route.settings.auth === false)
        .map((route) => `${route.method.toUpperCase()} ${route.path}`)
        .sort()

      expect(open).toEqual([
        'GET /api/ingest/repositories/{fullName}',
        'GET /health',
        'POST /api/payloads',
        'POST /api/survival'
      ])
    })
  })
})
