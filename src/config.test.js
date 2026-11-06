/**
 * The guard runs at module load, so each case needs a fresh module registry
 * with the environment already in place.
 */
const TENANT = '11111111-1111-4111-8111-111111111111'
const CLIENT = '22222222-2222-4222-8222-222222222222'
const ENTRA = {
  ENTRA_TENANT_ID: TENANT,
  ENTRA_BACKEND_CLIENT_ID: CLIENT,
  AUTH_ALLOWED_CLIENT_IDS: CLIENT
}

const loadConfig = async (env) => {
  vi.resetModules()

  const previous = { ...process.env }
  Object.assign(process.env, env)

  try {
    return await import('./config.js')
  } finally {
    process.env = previous
  }
}

describe('#config required secrets', () => {
  test('Should allow missing secrets in local development', async () => {
    await expect(loadConfig({ ENVIRONMENT: 'local' })).resolves.toBeDefined()
  })

  test('Should refuse to start a deployed environment without INGEST_TOKEN', async () => {
    await expect(
      loadConfig({ ENVIRONMENT: 'prod', INGEST_TOKEN: '' })
    ).rejects.toThrow('INGEST_TOKEN')
  })

  test('Should reject a whitespace-only INGEST_TOKEN', async () => {
    await expect(
      loadConfig({ ENVIRONMENT: 'dev', INGEST_TOKEN: '   ' })
    ).rejects.toThrow('INGEST_TOKEN')
  })

  test('Should start a deployed environment once the secret is present', async () => {
    await expect(
      loadConfig({
        ENVIRONMENT: 'prod',
        INGEST_TOKEN: 'a-real-secret',
        ...ENTRA
      })
    ).resolves.toBeDefined()
  })

  test('Should refuse the Sonar snapshot fallback outside local', async () => {
    await expect(
      loadConfig({
        ENVIRONMENT: 'prod',
        INGEST_TOKEN: 'a-real-secret',
        ...ENTRA,
        SONAR_SNAPSHOT_FALLBACK: 'true'
      })
    ).rejects.toThrow('SONAR_SNAPSHOT_FALLBACK')
    const local = await loadConfig({
      ENVIRONMENT: 'local',
      SONAR_SNAPSHOT_FALLBACK: 'true'
    })
    expect(local.config.get('sonar.snapshotFallback')).toBe(true)
  })
  test('Should list every missing Entra setting in a deployed environment', async () => {
    await expect(
      loadConfig({
        ENVIRONMENT: 'dev',
        INGEST_TOKEN: 'a-real-secret',
        ENTRA_TENANT_ID: '',
        ENTRA_BACKEND_CLIENT_ID: '',
        AUTH_ALLOWED_CLIENT_IDS: ''
      })
    ).rejects.toThrow(
      'ENTRA_TENANT_ID, ENTRA_BACKEND_CLIENT_ID, AUTH_ALLOWED_CLIENT_IDS'
    )
  })

  test('Should reject a malformed tenant or client GUID', async () => {
    await expect(
      loadConfig({ ENVIRONMENT: 'local', ENTRA_TENANT_ID: 'not-a-guid' })
    ).rejects.toThrow()
    await expect(
      loadConfig({
        ENVIRONMENT: 'local',
        AUTH_ALLOWED_CLIENT_IDS: CLIENT + ',nope'
      })
    ).rejects.toThrow()
  })

  test('Should refuse AUTH_DEV_BYPASS outside local and test runs', async () => {
    await expect(
      loadConfig({
        ENVIRONMENT: 'dev',
        NODE_ENV: 'production',
        INGEST_TOKEN: 'a-real-secret',
        AUTH_DEV_BYPASS: 'true',
        ...ENTRA
      })
    ).rejects.toThrow('AUTH_DEV_BYPASS')
    const local = await loadConfig({
      ENVIRONMENT: 'local',
      NODE_ENV: 'development',
      AUTH_DEV_BYPASS: 'true'
    })
    expect(local.config.get('auth.devBypass')).toBe(true)
  })

  test('Should always redact credentials from logs', async () => {
    for (const ENVIRONMENT of ['local', 'prod']) {
      const { config } = await loadConfig({
        ENVIRONMENT,
        NODE_ENV: ENVIRONMENT === 'prod' ? 'production' : 'development',
        INGEST_TOKEN: 'a-real-secret',
        AUTH_DEV_BYPASS: 'false',
        ...ENTRA
      })

      expect(config.get('log.redact')).toEqual(
        expect.arrayContaining([
          'req.headers.authorization',
          'req.headers.cookie',
          'req.headers["x-ingest-token"]'
        ])
      )
    }
  })
})
