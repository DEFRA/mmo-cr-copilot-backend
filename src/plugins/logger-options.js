import { ecsFormat } from '@elastic/ecs-pino-format'
import { getTraceId } from '@defra/hapi-tracing'
import { config } from '#/config.js'

const logConfig = config.get('log')
const serviceName = config.get('serviceName')
const serviceVersion = config.get('serviceVersion')

// pino-pretty is a devDependency, so it is absent from the deployed image.
async function loadPrettyFormatter() {
  try {
    const { default: pinoPretty } = await import('pino-pretty')
    return { stream: pinoPretty() }
  } catch {
    return null
  }
}

const formatters = {
  ecs: {
    ...ecsFormat({
      serviceVersion,
      serviceName
    })
  },
  'pino-pretty':
    logConfig.format === 'pino-pretty' ? await loadPrettyFormatter() : null
}

export const loggerOptions = {
  enabled: logConfig.isEnabled,
  ignorePaths: ['/health'],
  redact: {
    paths: logConfig.redact,
    remove: true
  },
  level: logConfig.level,
  ...(formatters[logConfig.format] ?? formatters.ecs),
  nesting: true,
  mixin() {
    const mixinValues = {}
    const traceId = getTraceId()
    if (traceId) {
      mixinValues.trace = { id: traceId }
    }
    return mixinValues
  }
}
