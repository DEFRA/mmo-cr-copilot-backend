const statusServiceUnavailable = 503

/**
 * Platform health check. Reports unhealthy when MongoDB is unreachable so a
 * task with a dead connection pool is taken out of the load balancer rather
 * than left accepting requests it cannot serve.
 */
export const health = {
  method: 'GET',
  path: '/health',
  handler: async (request, h) => {
    try {
      await request.db.admin().ping()
    } catch (error) {
      request.logger.error({ err: error }, 'Health check failed: MongoDB ping')

      return h
        .response({ message: 'unhealthy', dependencies: { mongodb: 'down' } })
        .code(statusServiceUnavailable)
    }

    return h.response({ message: 'success' })
  }
}
