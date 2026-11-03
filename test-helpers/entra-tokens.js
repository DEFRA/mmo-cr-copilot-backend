import {
  SignJWT,
  base64url,
  createLocalJWKSet,
  exportJWK,
  generateKeyPair
} from 'jose'

export const TEST_IDS = {
  tenant: '11111111-1111-4111-8111-111111111111',
  backendClient: '22222222-2222-4222-8222-222222222222',
  dashboardClient: '33333333-3333-4333-8333-333333333333',
  otherClient: '44444444-4444-4444-8444-444444444444',
  oid: '55555555-5555-4555-8555-555555555555'
}

export const TEST_SETTINGS = {
  tenantId: TEST_IDS.tenant,
  clientId: TEST_IDS.backendClient,
  scope: 'access_as_user',
  allowedClientIds: [TEST_IDS.dashboardClient],
  clockToleranceSeconds: 60,
  jwksTimeoutMs: 1000,
  jwksCacheMaxAgeMs: 1000,
  jwksCooldownMs: 1000,
  devBypass: false
}

export const ISSUER = `https://login.microsoftonline.com/${TEST_IDS.tenant}/v2.0`

const KID = 'test-key-1'

/** A signing key pair plus a local JWKS that trusts only its public half. */
export async function createSigningKeys(kid = KID) {
  const { publicKey, privateKey } = await generateKeyPair('RS256')
  const jwk = { ...(await exportJWK(publicKey)), kid, alg: 'RS256', use: 'sig' }
  return { privateKey, kid, jwks: createLocalJWKSet({ keys: [jwk] }) }
}

export const validClaims = (overrides = {}) => ({
  ver: '2.0',
  tid: TEST_IDS.tenant,
  oid: TEST_IDS.oid,
  name: 'Test User',
  preferred_username: 'test.user@example.test',
  scp: 'access_as_user',
  azp: TEST_IDS.dashboardClient,
  azpacr: '1',
  groups: ['AG-Test-Project-User'],
  ...overrides
})

/**
 * Signs a v2 access token. A claim set to `undefined` is omitted, which is how
 * tests produce "missing claim" cases; header overrides allow alg tricks.
 */
export async function signAccessToken(keys, overrides = {}, options = {}) {
  const now = options.now ?? Math.floor(Date.now() / 1000)
  const claims = Object.fromEntries(
    Object.entries(validClaims(overrides)).filter(([, v]) => v !== undefined)
  )
  const jwt = new SignJWT(claims)
    .setProtectedHeader({ alg: 'RS256', kid: keys.kid, ...options.header })
    .setIssuer(ISSUER)
    .setAudience(TEST_IDS.backendClient)
    .setIssuedAt(now)
    .setNotBefore(now)
    .setExpirationTime(now + 3600)
  if (options.issuer !== undefined) jwt.setIssuer(options.issuer)
  if (options.audience !== undefined) jwt.setAudience(options.audience)
  if (options.notBefore !== undefined) jwt.setNotBefore(options.notBefore)
  if (options.expiresAt !== undefined) jwt.setExpirationTime(options.expiresAt)
  return jwt.sign(options.key ?? keys.privateKey)
}

/** A token with alg "none" and no signature. */
export function unsignedToken(claims = validClaims()) {
  const now = Math.floor(Date.now() / 1000)
  const encode = (value) =>
    base64url.encode(new TextEncoder().encode(JSON.stringify(value)))
  const header = { alg: 'none', typ: 'JWT' }
  const payload = {
    iss: ISSUER,
    aud: TEST_IDS.backendClient,
    iat: now,
    nbf: now,
    exp: now + 3600,
    ...claims
  }
  return `${encode(header)}.${encode(payload)}.`
}
