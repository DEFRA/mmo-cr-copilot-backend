/**
 * The guard runs at module load, so each case needs a fresh module registry
 * with the environment already in place.
 */
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
      loadConfig({ ENVIRONMENT: 'prod', INGEST_TOKEN: 'a-real-secret' })
    ).resolves.toBeDefined()
  })
})
