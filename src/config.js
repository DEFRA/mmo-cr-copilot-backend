import convict from 'convict'
import convictFormatWithValidator from 'convict-format-with-validator'

import { convictValidateMongoUri } from '#/common/helpers/convict/validate-mongo-uri.js'

convict.addFormat(convictValidateMongoUri)
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
      default: isProduction
        ? [
            'req.headers.authorization',
            'req.headers.cookie',
            'req.headers["x-ingest-token"]',
            'res.headers'
          ]
        : ['req', 'res', 'responseTime']
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
    }
  }
})

config.validate({ allowed: 'strict' })

/**
 * Secrets that guard a write path must fail closed. Defaulting them to empty
 * keeps local development frictionless, but a deployed environment that lost
 * its SSM injection would otherwise run wide open and only log a warning.
 */
if (config.get('cdpEnvironment') !== 'local') {
  const required = [['ingest.token', 'INGEST_TOKEN']]

  const missing = required
    .filter(([key]) => !config.get(key).trim())
    .map(([, env]) => env)

  if (missing.length) {
    throw new Error(
      `Missing required configuration in the '${config.get('cdpEnvironment')}' environment: ${missing.join(', ')}`
    )
  }
}
