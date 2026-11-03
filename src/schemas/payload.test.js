import { readFileSync } from 'node:fs'

import { config } from '#/config.js'
import {
  buildAttribution,
  buildPayload,
  buildPayloadV2
} from '#/test-helpers/payload-fixture.js'
import {
  analyticsPayloadSchema,
  CURRENT_SCHEMA_VERSION,
  MAX_COMMITS,
  MAX_CONTRIBUTORS,
  MAX_JIRA_KEYS,
  MAX_PR_TITLE_LENGTH
} from './payload.js'

const producerSample = JSON.parse(
  readFileSync(
    new URL(
      '../../test-helpers/fixtures/producer-v2-sample.json',
      import.meta.url
    ),
    'utf8'
  )
)

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

  describe('When the payload is v1', () => {
    test('Should default a missing schemaVersion to 1', () => {
      const { error, value } = validate(buildPayload())

      expect(error).toBeUndefined()
      expect(value.schemaVersion).toBe(1)
    })

    test('Should accept an explicit schemaVersion of 1', () => {
      expect(validate(buildPayload({ schemaVersion: 1 })).error).toBeUndefined()
    })

    test('Should strip v2 fields rather than reject them', () => {
      const v2 = buildPayloadV2()
      const payload = buildPayload({
        prTitle: v2.prTitle,
        jiraKeys: v2.jiraKeys,
        files: v2.files,
        source: v2.source,
        commitBreakdown: v2.commitBreakdown
      })

      const { error, value } = validate(payload)

      expect(error).toBeUndefined()
      expect(value).not.toHaveProperty('prTitle')
      expect(value).not.toHaveProperty('jiraKeys')
      expect(value).not.toHaveProperty('files')
      expect(value).not.toHaveProperty('source')
      expect(value.commitBreakdown[0]).not.toHaveProperty('attribution')
    })
  })

  describe('When the payload is v2', () => {
    test('Should accept a complete v2 payload', () => {
      const { error, value } = validate(buildPayloadV2())

      expect(error).toBeUndefined()
      expect(value.schemaVersion).toBe(2)
      expect(value.files.excluded).toEqual({
        filesChanged: 1,
        linesTouched: 20
      })
      expect(value.commitBreakdown[0].attribution).toEqual({
        source: 'legacy-trailer'
      })
    })

    test('Should convert a string schemaVersion', () => {
      const { error, value } = validate(buildPayloadV2({ schemaVersion: '2' }))

      expect(error).toBeUndefined()
      expect(value.schemaVersion).toBe(2)
    })

    test('Should accept an empty jiraKeys array as none found', () => {
      const { error, value } = validate(buildPayloadV2({ jiraKeys: [] }))

      expect(error).toBeUndefined()
      expect(value.jiraKeys).toEqual([])
    })

    test.each(['prTitle', 'jiraKeys', 'files', 'source'])(
      'Should require %s',
      (field) => {
        const payload = buildPayloadV2()
        delete payload[field]

        expect(validate(payload).error?.message).toContain(field)
      }
    )

    test.each([
      'changed',
      'linesTouched',
      'testFilesChanged',
      'testLinesTouched',
      'modulesTouched',
      'excluded'
    ])('Should require files.%s', (field) => {
      const payload = buildPayloadV2()
      delete payload.files[field]

      expect(validate(payload).error?.message).toContain(field)
    })

    test.each(['filesChanged', 'linesTouched'])(
      'Should require files.excluded.%s',
      (field) => {
        const payload = buildPayloadV2()
        delete payload.files.excluded[field]

        expect(validate(payload).error?.message).toContain(field)
      }
    )

    test('Should require attribution on every commit', () => {
      const payload = buildPayloadV2()
      delete payload.commitBreakdown[0].attribution

      expect(validate(payload).error?.message).toContain('attribution')
    })

    test('Should require attribution.source', () => {
      const payload = buildPayloadV2()
      payload.commitBreakdown[0].attribution = {}

      expect(validate(payload).error?.message).toContain('source')
    })

    test('Should reject an unknown payload source', () => {
      expect(validate(buildPayloadV2({ source: 'replay' })).error).toBeDefined()
    })

    test.each([
      ['an empty string', ''],
      ['null', null],
      ['a 257 character string', 'x'.repeat(257)]
    ])('Should reject a prTitle that is %s', (_label, prTitle) => {
      expect(validate(buildPayloadV2({ prTitle })).error).toBeDefined()
    })

    test('Should accept a 256 character prTitle', () => {
      expect(
        validate(buildPayloadV2({ prTitle: 'x'.repeat(256) })).error
      ).toBeUndefined()
    })

    test.each([
      ['lowercase', ['abc-1']],
      ['a single letter project', ['A-1']],
      ['a number starting at zero', ['ABC-0']],
      ['duplicates', ['ABC-1', 'ABC-1']],
      [
        'more than fifty keys',
        Array.from({ length: 51 }, (_, i) => `ABC-${i + 1}`)
      ],
      ['an item over 64 characters', [`A${'B'.repeat(60)}-1234`]]
    ])('Should reject jiraKeys with %s', (_label, jiraKeys) => {
      expect(validate(buildPayloadV2({ jiraKeys })).error).toBeDefined()
    })

    test('Should accept a valid Jira key', () => {
      expect(
        validate(buildPayloadV2({ jiraKeys: ['ABC-1', 'MMO_CR-42'] })).error
      ).toBeUndefined()
    })

    test.each([
      ['a negative count', -1],
      ['a fractional count', 1.5]
    ])('Should reject files with %s', (_label, changed) => {
      const payload = buildPayloadV2()
      payload.files.changed = changed

      expect(validate(payload).error).toBeDefined()
    })

    test('Should strip unknown keys inside files', () => {
      const payload = buildPayloadV2()
      payload.files.injected = 1
      payload.files.excluded.injected = 1

      const { error, value } = validate(payload)

      expect(error).toBeUndefined()
      expect(value.files).not.toHaveProperty('injected')
      expect(value.files.excluded).not.toHaveProperty('injected')
    })

    test.each([
      [0, 'zero'],
      [3, 'three']
    ])('Should reject schemaVersion %s (%s)', (schemaVersion) => {
      expect(
        validate(buildPayloadV2({ schemaVersion })).error?.message
      ).toContain('schemaVersion')
    })
  })

  describe('When validating commit attribution', () => {
    const withAttribution = (attribution) => {
      const payload = buildPayloadV2()
      payload.commitBreakdown[0].attribution = attribution
      return validate(payload)
    }

    test('Should accept extension attribution with a version and line counts', () => {
      const attribution = buildAttribution({
        source: 'extension',
        version: 1,
        aiCompletionLines: 10,
        aiChatLines: 5,
        aiAgentLines: 0,
        pastedLines: 2,
        typedLines: 30
      })

      const { error, value } = withAttribution(attribution)

      expect(error).toBeUndefined()
      expect(value.commitBreakdown[0].attribution).toEqual(attribution)
    })

    test('Should accept a none attribution', () => {
      expect(withAttribution({ source: 'none' }).error).toBeUndefined()
    })

    test('Should require a version for extension attribution', () => {
      expect(
        withAttribution({ source: 'extension', typedLines: 1 }).error?.message
      ).toContain('version')
    })

    test('Should forbid line counts for legacy-trailer attribution', () => {
      expect(
        withAttribution({ source: 'legacy-trailer', aiChatLines: 3 }).error
          ?.message
      ).toContain('aiChatLines')
    })

    test('Should forbid a version for none attribution', () => {
      expect(
        withAttribution({ source: 'none', version: 1 }).error?.message
      ).toContain('version')
    })

    test('Should reject negative line counts', () => {
      expect(
        withAttribution({ source: 'extension', version: 1, typedLines: -1 })
          .error
      ).toBeDefined()
    })

    test('Should reject an unknown attribution source', () => {
      expect(withAttribution({ source: 'robot' }).error).toBeDefined()
    })

    test('Should strip unknown keys inside attribution', () => {
      const { error, value } = withAttribution({
        source: 'none',
        injected: true
      })

      expect(error).toBeUndefined()
      expect(value.commitBreakdown[0].attribution).toEqual({ source: 'none' })
    })

    describe('and usage', () => {
      const usage = {
        models: [
          {
            model: 'claude-sonnet-4.5',
            requests: 7,
            inputTokens: 48211,
            outputTokens: 3112,
            cacheReadTokens: 30120,
            cacheCreationTokens: 0,
            reasoningTokens: 0
          }
        ],
        sessions: 1,
        commitsWithUsage: 1
      }
      const extension = (extra) => ({
        source: 'extension',
        version: 1,
        typedLines: 3,
        ...extra
      })

      test('Should accept model and token usage for extension attribution', () => {
        const { error, value } = withAttribution(extension({ usage }))

        expect(error).toBeUndefined()
        expect(value.commitBreakdown[0].attribution.usage).toEqual(usage)
      })

      test('Should default missing token counts to zero and strip unknown model keys', () => {
        const { error, value } = withAttribution(
          extension({
            usage: {
              ...usage,
              models: [{ model: 'gpt-5', inputTokens: 5, prompt: 'secret' }]
            }
          })
        )

        expect(error).toBeUndefined()
        expect(value.commitBreakdown[0].attribution.usage.models[0]).toEqual({
          model: 'gpt-5',
          requests: 0,
          inputTokens: 5,
          outputTokens: 0,
          cacheReadTokens: 0,
          cacheCreationTokens: 0,
          reasoningTokens: 0
        })
      })

      test('Should forbid usage for legacy-trailer attribution', () => {
        expect(
          withAttribution({ source: 'legacy-trailer', usage }).error?.message
        ).toContain('usage')
      })

      test.each([
        ['a hostile model name', { models: [{ model: '<script>' }] }],
        [
          'too many models',
          { models: Array.from({ length: 21 }, (_, i) => ({ model: `m${i}` })) }
        ],
        [
          'a negative token count',
          { models: [{ model: 'm', inputTokens: -1 }] }
        ],
        [
          'a fractional token count',
          { models: [{ model: 'm', inputTokens: 1.5 }] }
        ],
        [
          'an absurd token count',
          { models: [{ model: 'm', inputTokens: 1e12 }] }
        ]
      ])('Should reject %s', (_label, override) => {
        expect(
          withAttribution(extension({ usage: { ...usage, ...override } })).error
        ).toBeDefined()
      })
    })
  })

  describe('When sizing the largest allowed v2 payload', () => {
    test('Should serialise below the ingest size cap', () => {
      const base = buildPayloadV2()
      const commit = {
        ...base.commitBreakdown[0],
        subject: 's'.repeat(80),
        attribution: {
          source: 'extension',
          version: 999,
          aiCompletionLines: 99999,
          aiChatLines: 99999,
          aiAgentLines: 99999,
          pastedLines: 99999,
          typedLines: 99999
        }
      }
      const payload = buildPayloadV2({
        prTitle: 't'.repeat(MAX_PR_TITLE_LENGTH),
        jiraKeys: Array.from(
          { length: MAX_JIRA_KEYS },
          (_, i) => `PROJECT_KEY-${1000000 + i}`
        ),
        contributorBreakdown: Array.from(
          { length: MAX_CONTRIBUTORS },
          (_, i) => ({
            ...base.contributorBreakdown[0],
            contributor: `contributor-${i}`
          })
        ),
        commitBreakdown: Array.from({ length: MAX_COMMITS }, (_, i) => ({
          ...commit,
          commit: `${i}`.padStart(40, 'a')
        }))
      })

      expect(validate(payload).error).toBeUndefined()
      expect(Buffer.byteLength(JSON.stringify(payload))).toBeLessThan(
        config.get('ingest.maxPayloadBytes')
      )
    })
  })

  describe('When validating the producer contract sample', () => {
    test('Should accept the payload the producer emits', () => {
      const { error, value } = validate(producerSample)

      expect(error).toBeUndefined()
      expect(value.schemaVersion).toBe(CURRENT_SCHEMA_VERSION)
    })
  })
})
