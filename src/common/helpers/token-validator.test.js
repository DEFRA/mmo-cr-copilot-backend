import {
  TOKEN_ERRORS,
  TokenError,
  verifyAccessToken
} from '#/common/helpers/token-validator.js'
import {
  ISSUER,
  TEST_IDS,
  TEST_SETTINGS,
  createSigningKeys,
  signAccessToken,
  unsignedToken,
  validClaims
} from '#/test-helpers/entra-tokens.js'

describe('#verifyAccessToken', () => {
  let keys
  let otherKeys
  const now = () => Math.floor(Date.now() / 1000)

  beforeAll(async () => {
    keys = await createSigningKeys()
    otherKeys = await createSigningKeys()
  })

  const verify = (token, settings = {}) =>
    verifyAccessToken(token, {
      jwks: keys.jwks,
      settings: { ...TEST_SETTINGS, ...settings }
    })

  const sign = (claims, options) => signAccessToken(keys, claims, options)

  describe('valid tokens', () => {
    test('Should return the caller claims with group names kept exactly', async () => {
      const claims = await verify(
        await sign({ groups: ['AG-Mixed-Case', 'ag-mixed-case'] })
      )

      expect(claims).toEqual({
        oid: TEST_IDS.oid,
        tid: TEST_IDS.tenant,
        name: 'Test User',
        email: 'test.user@example.test',
        groups: ['AG-Mixed-Case', 'ag-mixed-case']
      })
    })

    test('Should accept a client-secret or certificate flow (azpacr 1 or 2)', async () => {
      await expect(verify(await sign({ azpacr: '2' }))).resolves.toBeDefined()
      await expect(verify(await sign({ azpacr: 1 }))).resolves.toBeDefined()
    })

    test('Should tolerate 60 seconds of clock skew either way', async () => {
      await expect(
        verify(await sign({}, { notBefore: now() + 30 }))
      ).resolves.toBeDefined()
      await expect(
        verify(await sign({}, { expiresAt: now() - 30 }))
      ).resolves.toBeDefined()
    })

    test('Should treat a token with no groups claim as having no groups', async () => {
      const claims = await verify(await sign({ groups: undefined }))

      expect(claims.groups).toEqual([])
    })
  })

  describe('rejected tokens', () => {
    const wrongKey = async () =>
      signAccessToken(keys, {}, { key: otherKeys.privateKey })

    test.each([
      [
        'wrong audience',
        () => sign({}, { audience: 'api://someone-else' }),
        TOKEN_ERRORS.audience
      ],
      [
        'the App ID URI as audience',
        () => sign({}, { audience: `api://${TEST_IDS.backendClient}` }),
        TOKEN_ERRORS.audience
      ],
      ['missing scp', () => sign({ scp: undefined }), TOKEN_ERRORS.scope],
      [
        'wrong scp',
        () => sign({ scp: 'user_impersonation' }),
        TOKEN_ERRORS.scope
      ],
      [
        'scp that only contains the scope as a substring',
        () => sign({ scp: 'access_as_user_extra' }),
        TOKEN_ERRORS.scope
      ],
      [
        'v1 issuer',
        () =>
          sign(
            { ver: '1.0' },
            { issuer: `https://sts.windows.net/${TEST_IDS.tenant}/` }
          ),
        TOKEN_ERRORS.issuer
      ],
      [
        'issuer for another tenant',
        () =>
          sign(
            {},
            {
              issuer: `https://login.microsoftonline.com/${TEST_IDS.otherClient}/v2.0`
            }
          ),
        TOKEN_ERRORS.issuer
      ],
      [
        'wrong tid',
        () => sign({ tid: TEST_IDS.otherClient }),
        TOKEN_ERRORS.tenant
      ],
      ['missing tid', () => sign({ tid: undefined }), TOKEN_ERRORS.tenant],
      ['ver 1.0', () => sign({ ver: '1.0' }), TOKEN_ERRORS.version],
      ['missing ver', () => sign({ ver: undefined }), TOKEN_ERRORS.version],
      [
        'azp not in the allow-list',
        () => sign({ azp: TEST_IDS.otherClient }),
        TOKEN_ERRORS.client
      ],
      ['missing azp', () => sign({ azp: undefined }), TOKEN_ERRORS.client],
      [
        'azpacr 0 (public client)',
        () => sign({ azpacr: '0' }),
        TOKEN_ERRORS.client
      ],
      [
        'missing azpacr',
        () => sign({ azpacr: undefined }),
        TOKEN_ERRORS.client
      ],
      [
        'an expired token beyond tolerance',
        () => sign({}, { expiresAt: now() - 120 }),
        TOKEN_ERRORS.expired
      ],
      [
        'nbf in the future beyond tolerance',
        () => sign({}, { notBefore: now() + 300 }),
        TOKEN_ERRORS.notYetValid
      ],
      ['alg none', async () => unsignedToken(), TOKEN_ERRORS.signature],
      [
        'HS256 signed with the public key material',
        async () => {
          const { SignJWT } = await import('jose')
          return new SignJWT(validClaims())
            .setProtectedHeader({ alg: 'HS256', kid: keys.kid })
            .setIssuer(ISSUER)
            .setAudience(TEST_IDS.backendClient)
            .setIssuedAt()
            .setNotBefore(now())
            .setExpirationTime('1h')
            .sign(new TextEncoder().encode('shared-secret-shared-secret-1234'))
        },
        TOKEN_ERRORS.signature
      ],
      [
        'a tampered payload',
        async () => {
          const [header, , signature] = (await sign({})).split('.')
          const payload = Buffer.from(
            JSON.stringify({ ...validClaims(), oid: TEST_IDS.dashboardClient })
          ).toString('base64url')
          return `${header}.${payload}.${signature}`
        },
        TOKEN_ERRORS.signature
      ],
      ['a signature from another key', wrongKey, TOKEN_ERRORS.signature],
      ['a missing oid', () => sign({ oid: undefined }), TOKEN_ERRORS.subject],
      [
        'an oid that is not a GUID',
        () => sign({ oid: 'someone' }),
        TOKEN_ERRORS.subject
      ],
      [
        'group overage via hasgroups',
        () => sign({ groups: undefined, hasgroups: true }),
        TOKEN_ERRORS.overage
      ],
      [
        'group overage via _claim_names',
        () =>
          sign({
            groups: undefined,
            _claim_names: { groups: 'src1' },
            _claim_sources: { src1: { endpoint: 'https://graph.example' } }
          }),
        TOKEN_ERRORS.overage
      ],
      ['a malformed token', async () => 'not.a.jwt', TOKEN_ERRORS.signature]
    ])('Should reject %s', async (_, makeToken, code) => {
      const error = await verify(await makeToken()).catch((e) => e)

      expect(error).toBeInstanceOf(TokenError)
      expect(error.code).toBe(code)
    })

    test.each([undefined, '', null])(
      'Should reject a missing token (%s)',
      async (token) => {
        await expect(verify(token)).rejects.toMatchObject({
          code: TOKEN_ERRORS.missing
        })
      }
    )

    test('Should refuse a valid token when Entra is not configured', async () => {
      await expect(
        verify(await sign({}), { tenantId: '' })
      ).rejects.toMatchObject({ code: TOKEN_ERRORS.jwks })
    })

    test('Should report an unavailable signing key', async () => {
      const unknownKey = await createSigningKeys('another-kid')
      const token = await signAccessToken(unknownKey)

      await expect(verify(token)).rejects.toMatchObject({
        code: TOKEN_ERRORS.jwks
      })
    })
  })

  describe('dev tokens', () => {
    const dev = (claims) =>
      `dev-mock.${Buffer.from(JSON.stringify(claims)).toString('base64url')}`

    test('Should be refused unless the bypass is enabled', async () => {
      await expect(verify(dev({ oid: 'x' }))).rejects.toMatchObject({
        code: TOKEN_ERRORS.malformed
      })
    })

    test('Should be accepted with the bypass and keep group names', async () => {
      const claims = await verify(dev({ oid: 'dev-1', groups: ['AG-Dev'] }), {
        devBypass: true
      })

      expect(claims).toMatchObject({ oid: 'dev-1', groups: ['AG-Dev'] })
    })

    test('Should still reject overage and malformed payloads with the bypass', async () => {
      await expect(
        verify(dev({ oid: 'dev-1', hasgroups: true }), { devBypass: true })
      ).rejects.toMatchObject({ code: TOKEN_ERRORS.overage })
      await expect(
        verify('dev-mock.%%%', { devBypass: true })
      ).rejects.toMatchObject({ code: TOKEN_ERRORS.malformed })
      await expect(
        verify(dev({ oid: '' }), { devBypass: true })
      ).rejects.toMatchObject({ code: TOKEN_ERRORS.subject })
    })
  })
})
