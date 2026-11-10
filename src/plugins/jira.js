import { createJiraClient } from '#/services/jira.js'
import { settleJiraRefreshes } from '#/services/jira-lazy-fetch.js'

export const jira = {
  plugin: {
    name: 'jira',
    version: '1.0.0',
    dependencies: ['mongodb'],
    register(server) {
      server.decorate(
        'server',
        'jira',
        createJiraClient({ logger: server.logger })
      )
      // Background refreshes write to Mongo, so they finish before the connection closes.
      server.ext('onPreStop', () => settleJiraRefreshes())
    }
  }
}
