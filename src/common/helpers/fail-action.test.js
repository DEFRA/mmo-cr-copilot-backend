import { failAction } from './fail-action.js'

const mockRequest = () => ({ logger: { warn: vi.fn() } })

const joiLikeError = () =>
  Object.assign(Error('"contributorBreakdown[0].contributor" is not allowed'), {
    details: [
      {
        path: ['contributorBreakdown', 0, 'contributor'],
        type: 'string.base',
        context: { value: 'a.real.person@example.com', label: 'contributor' }
      }
    ],
    _original: { contributorBreakdown: [{ contributor: 'a.real.person' }] }
  })

describe('#fail-action', () => {
  test('Should throw a generic 400 rather than the validation detail', () => {
    const request = mockRequest()

    expect(() => failAction(request, {}, joiLikeError())).toThrow(
      'Invalid request input'
    )

    try {
      failAction(request, {}, joiLikeError())
    } catch (error) {
      expect(error.output.statusCode).toBe(400)
      expect(error.output.payload.message).toBe('Invalid request input')
    }
  })

  test('Should log field paths without any submitted values', () => {
    const request = mockRequest()

    expect(() => failAction(request, {}, joiLikeError())).toThrow()

    const [logged] = request.logger.warn.mock.calls[0]

    expect(logged).toEqual({
      validation: {
        paths: [
          { path: 'contributorBreakdown.0.contributor', type: 'string.base' }
        ]
      }
    })

    const serialised = JSON.stringify(logged)
    expect(serialised).not.toContain('a.real.person')
    expect(serialised).not.toContain('_original')
  })

  test('Should tolerate an error carrying no joi details', () => {
    const request = mockRequest()

    expect(() => failAction(request, {}, Error('boom'))).toThrow(
      'Invalid request input'
    )
    expect(request.logger.warn).toHaveBeenCalledWith(
      { validation: { paths: [] } },
      'Request failed validation'
    )
  })
})
