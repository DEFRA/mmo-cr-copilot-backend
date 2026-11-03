import { survivalSchema } from './survival.js'

const SHA = 'a'.repeat(40)

const buildSurvival = (overrides = {}) => ({
  kind: 'ai-survival',
  schemaVersion: 1,
  repository: 'DEFRA/mmo-cr-copilot-dashboard',
  prNumber: 42,
  mergeCommitSha: SHA,
  mergedAt: '2026-05-01T09:00:00Z',
  windowDays: 21,
  measuredAt: '2026-05-22T03:17:00Z',
  measuredCommitSha: 'b'.repeat(40),
  aiLinesMerged: 100,
  aiLinesSurviving: 80,
  humanLinesMerged: 50,
  humanLinesSurviving: 45,
  byOrigin: {
    aiAgent: { merged: 60, surviving: 50 },
    aiCompletion: { merged: 30, surviving: 25 },
    aiChat: { merged: 10, surviving: 5 }
  },
  files: [{ path: 'src/a.js', aiMerged: 10, aiSurviving: 8, deleted: false }],
  metadataSchemas: ['ai-attribution/2'],
  calculatedAt: '2026-05-22T03:18:00Z',
  ...overrides
})

const validate = (value) => survivalSchema.validate(value)

describe('#survivalSchema', () => {
  test('Should accept a complete record', () => {
    expect(validate(buildSurvival()).error).toBeUndefined()
  })

  test('Should still accept metadata schema names written by earlier extension builds', () => {
    const record = buildSurvival({
      metadataSchemas: ['mmo-attribution/1', 'mmo-attribution/2']
    })
    expect(validate(record).error).toBeUndefined()
  })

  test('Should default files to an empty list and strip unknown keys', () => {
    const record = buildSurvival({ injected: true })
    delete record.files

    const { error, value } = validate(record)

    expect(error).toBeUndefined()
    expect(value.files).toEqual([])
    expect(value).not.toHaveProperty('injected')
  })

  test.each([
    ['surviving above merged', { aiLinesSurviving: 101 }],
    ['human surviving above merged', { humanLinesSurviving: 51 }],
    [
      'an origin surviving above merged',
      {
        byOrigin: {
          aiAgent: { merged: 1, surviving: 2 },
          aiCompletion: { merged: 0, surviving: 0 },
          aiChat: { merged: 0, surviving: 0 }
        }
      }
    ],
    ['a short sha', { mergeCommitSha: 'abc123' }],
    ['an uppercase sha', { measuredCommitSha: 'A'.repeat(40) }],
    ['a window that is not offered', { windowDays: 20 }],
    ['an unknown kind', { kind: 'other' }],
    ['a date without a timezone', { mergedAt: '2026-05-01T09:00:00' }],
    ['a repository that is not owner/name', { repository: 'nope' }],
    ['a repository with an injected path', { repository: 'a/b/../c' }],
    ['a zero pull request number', { prNumber: 0 }],
    ['a negative line count', { aiLinesMerged: -1 }],
    ['an unknown metadata schema', { metadataSchemas: ['x/1'] }],
    [
      'a file surviving above merged',
      {
        files: [{ path: 'a', aiMerged: 1, aiSurviving: 2, deleted: false }]
      }
    ],
    [
      'too many files',
      {
        files: Array.from({ length: 201 }, (_, i) => ({
          path: `f${i}`,
          aiMerged: 0,
          aiSurviving: 0,
          deleted: false
        }))
      }
    ],
    ['a missing origin', { byOrigin: { aiAgent: { merged: 0, surviving: 0 } } }]
  ])('Should reject %s', (_label, override) => {
    expect(validate(buildSurvival(override)).error).toBeDefined()
  })

  test('Should accept every offered window', () => {
    for (const windowDays of [7, 14, 21, 30]) {
      expect(validate(buildSurvival({ windowDays })).error).toBeUndefined()
    }
  })
})
