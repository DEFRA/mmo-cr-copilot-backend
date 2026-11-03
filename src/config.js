import convict from 'convict'
import convictFormatWithValidator from 'convict-format-with-validator'

import { convictValidateMongoUri } from '#/common/helpers/convict/validate-mongo-uri.js'

import {
  convictValidateGuidList,
  convictValidateGuidOrEmpty
} from '#/common/helpers/convict/validate-guid.js'

convict.addFormat(convictValidateMongoUri)
convict.addFormat(convictValidateGuidOrEmpty)
convict.addFormat(convictValidateGuidList)
convict.addFormats(convictFormatWithValidator)

const isProduction = process.env.NODE_ENV === 'production'
const isTest = process.env.NODE_ENV === 'test'

export const config = convict({
  serviceVersion: {
    doc: 'The service version, this variable is injected into your docker container in CDP environments',
    format: String,
    nullable: true,
    default: null,
    env: 'SERVICE_VERSION'
  },
  host: {
    doc: 'The IP address to bind',
    format: 'ipaddress',
    default: '0.0.0.0',
    env: 'HOST'
  },
  port: {
    doc: 'The port to bind',
    format: 'port',
    default: 3001,
    env: 'PORT'
  },
  serviceName: {
    doc: 'Api Service Name',
    format: String,
    default: 'mmo-cr-copilot-backend'
  },
  cdpEnvironment: {
    doc: 'The CDP environment the app is running in. With the addition of "local" for local development',
    format: [
      'local',
      'infra-dev',
      'management',
      'dev',
      'test',
      'perf-test',
      'ext-test',
      'prod'
    ],
    default: 'local',
    env: 'ENVIRONMENT'
  },
  log: {
    isEnabled: {
      doc: 'Is logging enabled',
      format: Boolean,
      default: !isTest,
      env: 'LOG_ENABLED'
    },
    level: {
      doc: 'Logging level',
      format: ['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent'],
      default: 'info',
      env: 'LOG_LEVEL'
    },
    format: {
      doc: 'Format to output logs in',
      format: ['ecs', 'pino-pretty'],
      default: isProduction ? 'ecs' : 'pino-pretty',
      env: 'LOG_FORMAT'
    },
    redact: {
      doc: 'Log paths to redact',
      format: Array,
      default: [
        'req.headers.authorization',
        'req.headers.cookie',
        'req.headers["x-ingest-token"]',
        ...(isProduction ? ['res.headers'] : ['req', 'res', 'responseTime'])
      ]
    }
  },
  mongo: {
    mongoUrl: {
      doc: 'URI for mongodb',
      format: String,
      default: 'mongodb://127.0.0.1:27017/',
      env: 'MONGO_URI'
    },
    databaseName: {
      doc: 'database for mongodb',
      format: String,
      default: 'mmo-cr-copilot-backend',
      env: 'MONGO_DATABASE'
    },
    mongoOptions: {
      retryWrites: {
        doc: 'Enable Mongo write retries, overrides mongo URI when set.',
        format: Boolean,
        default: null,
        nullable: true,
        env: 'MONGO_RETRY_WRITES'
      },
      readPreference: {
        doc: 'Mongo read preference, overrides mongo URI when set.',
        format: [
          'primary',
          'primaryPreferred',
          'secondary',
          'secondaryPreferred',
          'nearest'
        ],
        default: null,
        nullable: true,
        env: 'MONGO_READ_PREFERENCE'
      }
    }
  },
  httpProxy: {
    doc: 'HTTP Proxy URL',
    format: String,
    nullable: true,
    default: null,
    env: 'HTTP_PROXY'
  },
  tracing: {
    header: {
      doc: 'CDP tracing header name',
      format: String,
      default: 'x-cdp-request-id',
      env: 'TRACING_HEADER'
    }
  },
  auth: {
    entraTenantId: {
      doc: 'Entra ID tenant that issues access tokens. Required outside local development.',
      format: 'guid-or-empty',
      default: '',
      env: 'ENTRA_TENANT_ID'
    },
    entraBackendClientId: {
      doc: 'Client ID of the backend app registration; the only accepted aud. Required outside local development.',
      format: 'guid-or-empty',
      default: '',
      env: 'ENTRA_BACKEND_CLIENT_ID'
    },
    entraBackendScope: {
      doc: 'Delegated scope every access token must carry',
      format: String,
      default: 'access_as_user',
      env: 'ENTRA_BACKEND_SCOPE'
    },
    allowedClientIds: {
      doc: 'Comma-separated client IDs allowed as the token azp (the dashboard app registration). Required outside local development.',
      format: 'guid-list',
      default: '',
      env: 'AUTH_ALLOWED_CLIENT_IDS'
    },
    clockToleranceSeconds: {
      doc: 'Clock skew tolerated on exp and nbf',
      format: 'nat',
      default: 60,
      env: 'AUTH_CLOCK_TOLERANCE_SECONDS'
    },
    jwksTimeoutMs: {
      doc: 'Timeout for fetching the Entra signing keys',
      format: 'nat',
      default: 5000,
      env: 'AUTH_JWKS_TIMEOUT_MS'
    },
    jwksCacheMaxAgeMs: {
      doc: 'How long fetched signing keys are cached',
      format: 'nat',
      default: 600000,
      env: 'AUTH_JWKS_CACHE_MAX_AGE_MS'
    },
    jwksCooldownMs: {
      doc: 'Minimum time between signing key refetches',
      format: 'nat',
      default: 30000,
      env: 'AUTH_JWKS_COOLDOWN_MS'
    },
    devBypass: {
      doc: 'Accepts synthetic dev-mock bearer tokens. Refused outside local development and tests.',
      format: Boolean,
      default: false,
      env: 'AUTH_DEV_BYPASS'
    },
    roleCacheTtlMs: {
      doc: 'How long resolved group-to-role results are cached',
      format: 'nat',
      default: 60000,
      env: 'AUTH_ROLE_CACHE_TTL_MS'
    },
    roleCacheMaxEntries: {
      doc: 'Maximum cached group-to-role results',
      format: 'nat',
      default: 500,
      env: 'AUTH_ROLE_CACHE_MAX_ENTRIES'
    },
    bootstrapAdminGroup: {
      doc: 'Group name (as emitted in the token groups claim) mapped to Dashboard Admin on start-up when no Dashboard Admin mapping exists',
      format: String,
      default: 'AG-Users-CopilotAnalytics-Dashboard-Admin',
      env: 'AUTH_BOOTSTRAP_ADMIN_GROUP'
    }
  },
  ingest: {
    token: {
      doc: 'Shared secret the dashboard frontend presents on POST /api/payloads. Required outside local development.',
      format: String,
      default: '',
      sensitive: true,
      env: 'INGEST_TOKEN'
    },
    maxPayloadBytes: {
      doc: 'Maximum accepted size of an ingest request body. Must match INGEST_MAX_PAYLOAD_BYTES in the dashboard, which forwards to this route.',
      format: Number,
      default: 2097152,
      env: 'INGEST_MAX_PAYLOAD_BYTES'
    }
  },
  sonar: {
    baseUrl: {
      doc: 'SonarCloud / SonarQube Server API base URL',
      format: String,
      default: 'https://sonarcloud.io',
      env: 'SONAR_BASE_URL'
    },
    token: {
      doc: 'SonarCloud user token. Only required for private projects; public projects are read anonymously.',
      format: String,
      default: '',
      sensitive: true,
      env: 'SONAR_TOKEN'
    },
    projectMap: {
      doc: 'JSON map of "<git repository>": "<SonarCloud project key>". Repositories absent from the map are reported as not linked.',
      format: String,
      default: '',
      env: 'SONAR_PROJECT_MAP'
    },
    requestTimeoutMs: {
      doc: 'Timeout applied to each SonarCloud API request',
      format: Number,
      default: 8000,
      env: 'SONAR_REQUEST_TIMEOUT_MS'
    },
    cacheTtlMs: {
      doc: 'How long SonarCloud responses are cached in memory',
      format: Number,
      default: 300000,
      env: 'SONAR_CACHE_TTL_MS'
    },
    snapshotFallback: {
      doc: 'Local development only: when SONAR_PROJECT_MAP is empty, serve /api/sonar/* from stored snapshots (ADR 0006)',
      format: Boolean,
      default: false,
      env: 'SONAR_SNAPSHOT_FALLBACK'
    }
  },
  jira: {
    baseUrl: {
      doc: 'Jira Cloud base URL (e.g. https://your-domain.atlassian.net)',
      format: String,
      default: '',
      env: 'JIRA_BASE_URL'
    },
    email: {
      doc: 'Jira service account email address',
      format: String,
      default: '',
      env: 'JIRA_EMAIL'
    },
    apiToken: {
      doc: 'Jira API token for basic authentication',
      format: String,
      default: '',
      env: 'JIRA_API_TOKEN',
      sensitive: true
    },
    requestTimeoutMs: {
      doc: 'Jira request timeout',
      format: Number,
      default: 10000,
      env: 'JIRA_REQUEST_TIMEOUT_MS'
    },
    syncIntervalMinutes: {
      doc: 'Minutes between incremental Jira syncs of every project with Jira keys; 0 turns the scheduled sync off',
      format: 'nat',
      default: 15,
      env: 'JIRA_SYNC_INTERVAL_MINUTES'
    }
  }
})

config.validate({ allowed: 'strict' })

/**
 * Secrets that guard a write path must fail closed. Defaulting them to empty
 * keeps local development frictionless, but a deployed environment that lost
 * its SSM injection would otherwise run wide open and only log a warning.
 */
const bypassAllowed =
  config.get('cdpEnvironment') === 'local' || process.env.NODE_ENV === 'test'

if (config.get('auth.devBypass') && !bypassAllowed) {
  throw new Error(
    'AUTH_DEV_BYPASS is only allowed in the local environment and in tests'
  )
}

if (config.get('cdpEnvironment') !== 'local') {
  const required = [
    ['ingest.token', 'INGEST_TOKEN'],
    ['auth.entraTenantId', 'ENTRA_TENANT_ID'],
    ['auth.entraBackendClientId', 'ENTRA_BACKEND_CLIENT_ID'],
    ['auth.allowedClientIds', 'AUTH_ALLOWED_CLIENT_IDS']
  ]

  const missing = required
    .filter(([key]) => !config.get(key).trim())
    .map(([, env]) => env)

  if (missing.length) {
    throw new Error(
      `Missing required configuration in the '${config.get('cdpEnvironment')}' environment: ${missing.join(', ')}`
    )
  }

  if (config.get('sonar.snapshotFallback')) {
    throw new Error(
      'SONAR_SNAPSHOT_FALLBACK is only allowed in the local environment'
    )
  }
}
