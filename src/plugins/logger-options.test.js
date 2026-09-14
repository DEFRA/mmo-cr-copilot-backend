import { getTraceId } from '@defra/hapi-tracing'
import { loggerOptions } from './logger-options.js'

vi.mock('@defra/hapi-tracing', () => ({
  getTraceId: vi.fn()
}))

describe('#loggerOptions', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  test('Should configure standard options', () => {
    expect(loggerOptions.ignorePaths).toContain('/health')
    expect(loggerOptions.nesting).toBe(true)
    expect(typeof loggerOptions.level).toBe('string')
    expect(Array.isArray(loggerOptions.redact.paths)).toBe(true)
  })

  test('Should return trace ID in mixin when available', () => {
    vi.mocked(getTraceId).mockReturnValue('trace-xyz-123')

    const mixinValues = loggerOptions.mixin()
    expect(mixinValues).toEqual({ trace: { id: 'trace-xyz-123' } })
  })

  test('Should return empty object in mixin when trace ID is not available', () => {
    vi.mocked(getTraceId).mockReturnValue(undefined)

    const mixinValues = loggerOptions.mixin()
    expect(mixinValues).toEqual({})
  })

  test('Should dynamically load pino-pretty format when configured', async () => {
    const previous = { ...process.env }
    process.env.LOG_FORMAT = 'pino-pretty'
    vi.resetModules()

    try {
      const { loggerOptions: prettyOptions } =
        await import('./logger-options.js')
      expect(prettyOptions.stream).toBeDefined()
    } finally {
      process.env = previous
      vi.resetModules()
    }
  })

  test('Should fall back to ECS when pino-pretty cannot be resolved', async () => {
    const previous = { ...process.env }
    process.env.LOG_FORMAT = 'pino-pretty'
    vi.resetModules()
    vi.doMock('pino-pretty', () => {
      throw new Error("Cannot find package 'pino-pretty'")
    })

    try {
      const { loggerOptions: fallbackOptions } =
        await import('./logger-options.js')
      expect(fallbackOptions.stream).toBeUndefined()
      expect(fallbackOptions.formatters).toBeDefined()
    } finally {
      vi.doUnmock('pino-pretty')
      process.env = previous
      vi.resetModules()
    }
  })
})
