import { health } from '#/routes/health.js'
import { payloads } from '#/routes/payloads.js'
import { personaMappings } from '#/routes/persona-mappings.js'
import { sonar } from '#/routes/sonar.js'

export const router = {
  plugin: {
    name: 'router',
    register: (server, _options) => {
      server.route([health, ...payloads, ...personaMappings, ...sonar])
    }
  }
}
