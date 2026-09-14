import { createSonarClient } from '#/services/sonar.js'

export const sonar = {
  plugin: {
    name: 'sonar',
    version: '1.0.0',
    register: (server, _options) => {
      const client = createSonarClient({ logger: server.logger })

      server.decorate('server', 'sonar', client)
      server.decorate('request', 'sonar', () => client, { apply: true })

      if (client.isConfigured()) {
        server.events.on('start', () => {
          // Diagnostic only — a bad token never blocks startup.
          client.validateToken()
        })
      } else {
        server.logger.info(
          'SONAR_PROJECT_MAP is not set — SonarCloud panels will be hidden'
        )
      }
    }
  }
}
