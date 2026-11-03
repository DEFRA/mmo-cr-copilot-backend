import { auditLogs } from '#/routes/audit-logs.js'
import { authRoutes } from '#/routes/auth.js'
import { health } from '#/routes/health.js'
import { payloads } from '#/routes/payloads.js'
import { personaMappings } from '#/routes/persona-mappings.js'
import { projectsRoutes } from '#/routes/projects.js'
import { repositoriesRoutes } from '#/routes/repositories.js'
import { roleMappingsRoutes } from '#/routes/role-mappings.js'
import { sonar } from '#/routes/sonar.js'
import { survival } from '#/routes/survival.js'

export const router = {
  plugin: {
    name: 'router',
    register: (server, _options) => {
      server.route([
        health,
        ...authRoutes,
        ...roleMappingsRoutes,
        ...payloads,
        ...survival,
        ...personaMappings,
        ...auditLogs,
        ...sonar,
        ...projectsRoutes,
        ...repositoriesRoutes
      ])
    }
  }
}
