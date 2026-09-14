import { buildPayload } from '#/test-helpers/payload-fixture.js'
import { analyticsPayloadSchema } from './payload.js'

const validate = (payload) => analyticsPayloadSchema.validate(payload)

describe('#analyticsPayloadSchema', () => {
  test('Should accept a complete payload', () => {
    const { error, value } = validate(buildPayload())

    expect(error).toBeUndefined()
    expect(value.repository).toBe('DEFRA/mmo-cr-copilot-dashboard')
  })

  test('Should accept a payload with every optional date absent', () => {
    const payload = buildPayload()
    delete payload.prCreatedAt
    delete payload.firstCommitAt
    delete payload.lastCommitAt
    delete payload.prMergedAt
    delete payload.sourceBranch

    expect(validate(payload).error).toBeUndefined()
  })

  test.each([
    ['empty string', ''],
    ['null', null]
  ])('Should treat a %s optional date as absent', (_label, emptyValue) => {
    const { error, value } = validate(
      buildPayload({ prMergedAt: emptyValue, sourceBranch: emptyValue })
    )

    expect(error).toBeUndefined()
    expect(value.prMergedAt).toBeUndefined()
    expect(value.sourceBranch).toBeUndefined()
  })

  test('Should reject a date-time without a timezone offset', () => {
    const { error } = validate(
      buildPayload({ calculatedAt: '2026-01-15T10:00:00' })
    )

    expect(error?.message).toContain('ISO-8601 date-time')
  })

  test('Should accept a date-time with a numeric offset', () => {
    expect(
      validate(buildPayload({ calculatedAt: '2026-01-15T10:00:00+01:00' }))
        .error
    ).toBeUndefined()
  })

  test('Should require calculatedAt', () => {
    const payload = buildPayload()
    delete payload.calculatedAt

    expect(validate(payload).error?.message).toContain('calculatedAt')
  })

  test('Should reject a prNumber below one', () => {
    expect(validate(buildPayload({ prNumber: 0 })).error).toBeDefined()
  })

  test('Should reject an unknown commit classification', () => {
    const payload = buildPayload()
    payload.commitBreakdown[0].classification = 'Robot-authored'

    expect(validate(payload).error?.message).toContain('classification')
  })

  test('Should allow negative netLines', () => {
    const payload = buildPayload()
    payload.commitBreakdown[0].netLines = -120

    expect(validate(payload).error).toBeUndefined()
  })

  test('Should reject negative line counts', () => {
    const payload = buildPayload()
    payload.commitBreakdown[0].linesAdded = -1

    expect(validate(payload).error).toBeDefined()
  })

  test('Should reject a rate above one hundred', () => {
    const payload = buildPayload()
    payload.summary.copilotAssistedRate = 101

    expect(validate(payload).error).toBeDefined()
  })

  test('Should reject empty breakdown arrays', () => {
    expect(validate(buildPayload({ commitBreakdown: [] })).error).toBeDefined()
    expect(
      validate(buildPayload({ contributorBreakdown: [] })).error
    ).toBeDefined()
  })

  test('Should strip unknown top level keys', () => {
    const { error, value } = validate(buildPayload({ injected: 'value' }))

    expect(error).toBeUndefined()
    expect(value).not.toHaveProperty('injected')
  })

  test('Should strip unknown keys a previous producer emitted', () => {
    const payload = buildPayload()
    payload.summary.nonFlaggedCommits = 2
    payload.contributorBreakdown[0].nonFlagged = 2
    payload.commitBreakdown[0].nonFlaggedLines = 8

    const { error, value } = validate(payload)

    expect(error).toBeUndefined()
    expect(value.summary).not.toHaveProperty('nonFlaggedCommits')
    expect(value.contributorBreakdown[0]).not.toHaveProperty('nonFlagged')
    expect(value.commitBreakdown[0]).not.toHaveProperty('nonFlaggedLines')
  })
})
