import { config } from '#/config.js'
import { createSonarClient } from '#/services/sonar.js'
import { createSonarSnapshotReader } from '#/services/sonar-snapshots.js'

export const sonar = {
  plugin: {
    name: 'sonar',
    version: '1.0.0',
    register: (server, _options) => {
      const live = createSonarClient({ logger: server.logger })
      const useSnapshots =
        !live.isConfigured() && config.get('sonar.snapshotFallback')
      const client = useSnapshots ? createSonarSnapshotReader() : live

      server.decorate('server', 'sonar', client)
      server.decorate('request', 'sonar', () => client, { apply: true })

      if (useSnapshots) {
        server.logger.info(
          'SonarCloud snapshot fallback is on (local development only)'
        )
      } else if (live.isConfigured()) {
        server.events.on('start', () => {
          // Diagnostic only — a bad token never blocks startup.
          live.validateToken()
        })
      } else {
        server.logger.info(
          'SONAR_PROJECT_MAP is not set — SonarCloud panels will be hidden'
        )
      }
    }
  }
}
