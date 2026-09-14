import Boom from '@hapi/boom'

import { config } from '#/config.js'
import { requireIngestToken, INGEST_TOKEN_HEADER } from './ingest-auth.js'

function createRequest(headers = {}) {
  return {
    headers,
    logger: { warn: vi.fn(), info: vi.fn() }
  }
}

const h = { continue: Symbol('continue') }

describe('#requireIngestToken', () => {
  describe('When no token is configured', () => {
    test('Should allow the request but warn that it is unauthenticated', () => {
      const request = createRequest()

      expect(requireIngestToken(request, h)).toBe(h.continue)
      expect(request.logger.warn).toHaveBeenCalledWith(
        expect.stringContaining('INGEST_TOKEN is not set')
      )
    })
  })

  describe('When a token is configured', () => {
    beforeEach(() => {
      vi.spyOn(config, 'get').mockImplementation((key) =>
        key === 'ingest.token' ? 'expected-token' : undefined
      )
    })

    test('Should allow a request presenting the correct token', () => {
      const request = createRequest({ [INGEST_TOKEN_HEADER]: 'expected-token' })

      expect(requireIngestToken(request, h)).toBe(h.continue)
      expect(request.logger.warn).not.toHaveBeenCalled()
    })

    test('Should reject a request with a missing token', () => {
      const request = createRequest()

      expect(() => requireIngestToken(request, h)).toThrow(
        Boom.unauthorized('Invalid ingest token')
      )
      expect(request.logger.warn).toHaveBeenCalledWith(
        expect.stringContaining('missing or invalid token')
      )
    })

    test('Should reject a request with an incorrect token', () => {
      const request = createRequest({ [INGEST_TOKEN_HEADER]: 'wrong-token' })

      expect(() => requireIngestToken(request, h)).toThrow(
        'Invalid ingest token'
      )
    })
  })
})
