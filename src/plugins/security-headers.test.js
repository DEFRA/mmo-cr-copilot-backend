describe('#securityHeaders', () => {
  let server

  beforeAll(async () => {
    // Dynamic import needed due to config being updated by vitest-mongodb
    const { createServer } = await import('#/server.js')

    server = await createServer()
    await server.initialize()
  })

  afterAll(async () => {
    await server.stop({ timeout: 1000 })
  })

  test('Should set the headers on a successful response', async () => {
    const { headers } = await server.inject({ method: 'GET', url: '/health' })

    expect(headers['referrer-policy']).toBe('no-referrer')
    expect(headers['permissions-policy']).toContain('geolocation=()')
    expect(headers['cross-origin-opener-policy']).toBe('same-origin')
  })

  test('Should set the headers on an error response', async () => {
    const { statusCode, headers } = await server.inject({
      method: 'GET',
      url: '/non-existent-path'
    })

    expect(statusCode).toBe(404)
    expect(headers['referrer-policy']).toBe('no-referrer')
  })
})
