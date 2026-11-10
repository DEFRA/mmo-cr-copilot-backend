describe('#jira plugin', () => {
  let server
  let config

  beforeAll(async () => {
    // Dynamic imports: config must be read after vitest-mongodb sets MONGO_URI
    ;({ config } = await import('#/config.js'))
    const { createServer } = await import('#/server.js')
    server = await createServer()
    await server.initialize()
  })

  afterAll(async () => {
    await server.stop({ timeout: 1000 })
  })

  test('Should decorate the server with a Jira client and start no timer', () => {
    expect(typeof server.jira.fetchIssuesByKey).toBe('function')
    expect(config.has('jira.syncIntervalMinutes')).toBe(false)
  })
})
