describe('#health route', () => {
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

  test('Should report success when MongoDB answers', async () => {
    const { statusCode, result } = await server.inject({
      method: 'GET',
      url: '/health'
    })

    expect(statusCode).toBe(200)
    expect(result).toEqual({ message: 'success' })
  })

  test('Should report unhealthy when the MongoDB ping fails', async () => {
    const admin = vi
      .spyOn(server.db, 'admin')
      .mockReturnValue({ ping: () => Promise.reject(Error('no connection')) })

    const { statusCode, result } = await server.inject({
      method: 'GET',
      url: '/health'
    })

    expect(statusCode).toBe(503)
    expect(result).toEqual({
      message: 'unhealthy',
      dependencies: { mongodb: 'down' }
    })

    admin.mockRestore()
  })
})
