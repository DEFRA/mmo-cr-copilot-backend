import { describe, it, expect } from 'vitest'
import {
  computeComplexityScore,
  computeLeverageV2,
  computeCodeChurn,
  computeAiNativeDeliveryLeverage
} from './complexity.js'

describe('#complexity service', () => {
  describe('computeComplexityScore', () => {
    it('returns score 1 and XS band for empty or 0 inputs', () => {
      const res = computeComplexityScore({})
      expect(res.score).toBe(1)
      expect(res.band).toBe('XS')
      expect(res.version).toBe(1)
    })

    it('returns score 100 and XL band when hard cap L > 400 is exceeded', () => {
      const res = computeComplexityScore({
        linesTouched: 401,
        changed: 5,
        modulesTouched: 1
      })
      expect(res.score).toBe(100)
      expect(res.band).toBe('XL')
    })

    it('returns score 100 and XL band when hard cap F > 50 is exceeded', () => {
      const res = computeComplexityScore({
        linesTouched: 50,
        changed: 51,
        modulesTouched: 1
      })
      expect(res.score).toBe(100)
      expect(res.band).toBe('XL')
    })

    it('calculates expected score within bands for moderate PR', () => {
      const res = computeComplexityScore({
        linesTouched: 100,
        changed: 10,
        modulesTouched: 2
      })
      expect(res.score).toBeGreaterThan(20)
      expect(res.score).toBeLessThanOrEqual(100)
      expect(['S', 'M', 'L']).toContain(res.band)
    })

    it('scores with a project model and stamps its version', () => {
      const files = { linesTouched: 100, changed: 10, modulesTouched: 2 }
      const linesOnly = {
        lineCap: 100,
        fileCap: 25,
        moduleCap: 5,
        weights: { lines: 1, files: 0, modules: 0 },
        hardCapLines: 1000,
        hardCapFiles: 50,
        version: 3
      }

      const res = computeComplexityScore(files, linesOnly)

      expect(res).toMatchObject({ score: 100, band: 'XL', version: 3 })
      expect(
        computeComplexityScore({ linesTouched: 401 }, { ...linesOnly })
      ).toMatchObject({ score: 100, version: 3 })
      expect(computeComplexityScore(files).score).toBeLessThan(100)
    })
  })

  describe('computeCodeChurn', () => {
    const record = (overrides = {}) => ({
      aiLinesMerged: 100,
      aiLinesSurviving: 90,
      humanLinesMerged: 200,
      humanLinesSurviving: 180,
      byOrigin: {
        aiAgent: { merged: 60, surviving: 54 },
        aiCompletion: { merged: 30, surviving: 27 },
        aiChat: { merged: 10, surviving: 9 }
      },
      ...overrides
    })
    const dbWith = (docs, spy) => ({
      collection: () => ({
        find: (filter) => {
          spy?.(filter)
          return { toArray: async () => docs }
        }
      })
    })

    it('reports churn as unavailable rather than inventing a figure', async () => {
      const res = await computeCodeChurn(dbWith([]), 'test-project', {
        windowDays: 14
      })

      expect(res).toMatchObject({
        projectSlug: 'test-project',
        windowDays: 14,
        available: false,
        churnRatePercent: null,
        churnPenaltyPercent: 0,
        effectiveMultiplier: 1,
        prCount: 0
      })
      expect(res.reason).toBe(
        'No AI lines merged in this period have reached 14 days yet'
      )
    })

    it('treats pull requests with no AI lines as nothing to measure', async () => {
      const res = await computeCodeChurn(
        dbWith([record({ aiLinesMerged: 0, aiLinesSurviving: 0 })]),
        'p'
      )

      expect(res).toMatchObject({ available: false, prCount: 1 })
      expect(res.windowDays).toBe(21)
    })

    it('computes CCR from summed lines, by origin, without a penalty at or below 25 percent', async () => {
      const res = await computeCodeChurn(
        dbWith([record(), record({ aiLinesSurviving: 60 })]),
        'p'
      )

      // (200 - 150) / 200
      expect(res).toMatchObject({
        available: true,
        prCount: 2,
        aiLinesMerged: 200,
        aiLinesSurviving: 150,
        churnRatePercent: 25,
        humanChurnPercent: 10,
        penaltyApplied: false,
        churnPenaltyPercent: 0,
        effectiveMultiplier: 1
      })
      expect(res.byOrigin.aiAgent).toEqual({
        merged: 120,
        surviving: 108,
        churnPercent: 10
      })
    })

    it('discounts delivered volume by (1 - CCR) above 25 percent', async () => {
      const res = await computeCodeChurn(
        dbWith([record({ aiLinesSurviving: 74.9 })]),
        'p'
      )

      expect(res.churnRatePercent).toBe(25.1)
      expect(res).toMatchObject({
        penaltyApplied: true,
        churnPenaltyPercent: 25.1,
        effectiveMultiplier: 0.749
      })
    })

    it('reports no human churn when no human lines were measured', async () => {
      const res = await computeCodeChurn(
        dbWith([record({ humanLinesMerged: 0, humanLinesSurviving: 0 })]),
        'p'
      )

      expect(res.humanChurnPercent).toBeNull()
    })

    it('queries by project, window and merge date range', async () => {
      let filter
      await computeCodeChurn(
        dbWith([], (f) => (filter = f)),
        'p',
        {
          windowDays: 21,
          from: '2026-01-01T00:00:00Z',
          to: '2026-02-01T00:00:00Z'
        }
      )

      expect(filter).toEqual({
        projectSlug: 'p',
        windowDays: 21,
        mergedAt: {
          $gte: new Date('2026-01-01T00:00:00Z'),
          $lt: new Date('2026-02-01T00:00:00Z')
        }
      })
    })
  })

  describe('computeLeverageV2', () => {
    const ADOPTION = '2026-01-01T00:00:00.000Z'
    const BEFORE = '2025-12-01T00:00:00.000Z'
    const AFTER = '2026-02-01T00:00:00.000Z'

    const pr = (prNumber, band, mergedAt, hours, extra = {}) => ({
      repository: 'DEFRA/repo',
      prNumber,
      prMergedAt: mergedAt,
      codingCycleTimeHours: hours,
      complexity: { score: 10, band },
      ...extra
    })
    const many = (count, start, band, mergedAt, hours, extra) =>
      Array.from({ length: count }, (_, i) =>
        pr(start + i, band, mergedAt, hours, extra)
      )

    const mockDb = (docs) => ({
      collection: (name) => ({
        findOne: async () =>
          name === 'projects'
            ? { slug: 'p', adoptionStartDate: ADOPTION }
            : null,
        find: (query) => ({
          sort: () => ({
            toArray: async () =>
              docs.filter(
                (d) => !query?.repository || d.repository === query.repository
              )
          })
        })
      })
    })

    it('returns null if project does not exist', async () => {
      const db = {
        collection: () => ({
          findOne: async () => null,
          find: () => ({ sort: () => ({ toArray: async () => [] }) })
        })
      }

      await expect(computeLeverageV2(db, 'non-existent')).resolves.toBeNull()
    })

    it('compares a band only with at least 5 PRs on each side', async () => {
      const payloads = [
        ...many(5, 1, 'XS', BEFORE, 10),
        ...many(4, 6, 'XS', AFTER, 5)
      ]

      const thin = await computeLeverageV2(mockDb(payloads), 'p')
      const enough = await computeLeverageV2(
        mockDb([...payloads, pr(10, 'XS', AFTER, 5)]),
        'p'
      )

      expect(thin.bandComparison.XS.comparable).toBe(false)
      expect(enough.bandComparison.XS).toMatchObject({
        comparable: true,
        speedup: 2
      })
      expect(enough.overallLeverageScore).toBe(2)
      expect(enough.comparableBands).toBe(1)
    })

    it('says nothing is comparable instead of claiming no change', async () => {
      const thin = await computeLeverageV2(
        mockDb([
          ...many(5, 1, 'XS', BEFORE, 10),
          ...many(2, 6, 'XS', AFTER, 5)
        ]),
        'p'
      )

      expect(thin.enoughData).toBe(false)
      expect(thin.overallLeverageScore).toBeNull()
      expect(thin.standardisedReworkRatio).toBeNull()
      expect(thin.comparableBands).toBe(0)
    })

    it('standardises on the current period’s band mix, not an equal average', async () => {
      // XS is 2x faster with 6 current PRs; XL is 1x with 2 would-be PRs.
      // Equal weights would give 1.5; the current mix (6:5) gives 1.55.
      const payloads = [
        ...many(5, 1, 'XS', BEFORE, 10),
        ...many(6, 10, 'XS', AFTER, 5),
        ...many(5, 20, 'XL', BEFORE, 40),
        ...many(5, 30, 'XL', AFTER, 40)
      ]

      const res = await computeLeverageV2(mockDb(payloads), 'p')

      expect(res.comparableBands).toBe(2)
      expect(res.overallLeverageScore).toBe(1.55)
    })

    it('leaves out a band that is not comparable when combining', async () => {
      const payloads = [
        ...many(5, 1, 'XS', BEFORE, 10),
        ...many(5, 10, 'XS', AFTER, 5),
        ...many(1, 20, 'XL', BEFORE, 99),
        ...many(40, 30, 'XL', AFTER, 1)
      ]

      const res = await computeLeverageV2(mockDb(payloads), 'p')

      expect(res.overallLeverageScore).toBe(2)
    })

    it('counts merged pull requests only', async () => {
      const open = many(5, 10, 'XS', undefined, 1)
      const payloads = [
        ...many(5, 1, 'XS', BEFORE, 10),
        ...many(5, 20, 'XS', AFTER, 5),
        ...open
      ]

      const res = await computeLeverageV2(mockDb(payloads), 'p')

      expect(res.sampleSize).toEqual({ baseline: 5, adopted: 5 })
    })

    it('bounds the adopted cohort by the window but not the baseline', async () => {
      const payloads = [
        ...many(5, 1, 'XS', BEFORE, 10),
        ...many(5, 10, 'XS', '2026-02-01T00:00:00.000Z', 5),
        ...many(5, 20, 'XS', '2026-06-01T00:00:00.000Z', 1)
      ]

      const res = await computeLeverageV2(mockDb(payloads), 'p', {
        from: '2026-01-15T00:00:00.000Z',
        to: '2026-03-01T00:00:00.000Z'
      })

      expect(res.sampleSize).toEqual({ baseline: 5, adopted: 5 })
      expect(res.overallLeverageScore).toBe(2)
    })

    it('can be scoped to one repository', async () => {
      const other = (n) => ({
        ...pr(n, 'XS', AFTER, 1),
        repository: 'DEFRA/other'
      })
      const payloads = [
        ...many(5, 1, 'XS', BEFORE, 10),
        ...many(5, 10, 'XS', AFTER, 5),
        ...[40, 41, 42, 43, 44].map(other)
      ]

      const all = await computeLeverageV2(mockDb(payloads), 'p')
      const one = await computeLeverageV2(mockDb(payloads), 'p', {
        repository: 'DEFRA/repo'
      })

      expect(all.sampleSize.adopted).toBe(10)
      expect(one.sampleSize.adopted).toBe(5)
      expect(one.repository).toBe('DEFRA/repo')
    })

    it('reports the rework ratio per band and standardised', async () => {
      const commits = (added, deleted) => [
        { linesAdded: added, linesDeleted: deleted }
      ]
      const payloads = [
        ...many(5, 1, 'XS', BEFORE, 10, { commitBreakdown: commits(100, 50) }),
        ...many(5, 10, 'XS', AFTER, 5, { commitBreakdown: commits(100, 20) })
      ]

      const res = await computeLeverageV2(mockDb(payloads), 'p')

      expect(res.bandComparison.XS).toMatchObject({
        baselineMedianReworkRatio: 0.5,
        adoptedMedianReworkRatio: 0.2
      })
      expect(res.standardisedReworkRatio).toEqual({
        baseline: 0.5,
        adopted: 0.2
      })
    })

    it('scores a pull request without stored complexity from its files', async () => {
      const bare = (n, mergedAt) => ({
        repository: 'DEFRA/repo',
        prNumber: n,
        prMergedAt: mergedAt,
        codingCycleTimeHours: 4,
        files: { linesTouched: 5, changed: 1, modulesTouched: 1 }
      })
      const payloads = [
        ...[1, 2, 3, 4, 5].map((n) => bare(n, BEFORE)),
        ...[6, 7, 8, 9, 10].map((n) => bare(n, AFTER))
      ]

      const res = await computeLeverageV2(mockDb(payloads), 'p')

      expect(res.comparableBands).toBe(1)
      expect(res.bandComparison.S.comparable).toBe(true)
    })
  })

  describe('computeAiNativeDeliveryLeverage', () => {
    it('returns null if project does not exist', async () => {
      const mockDb = {
        collection: () => ({
          findOne: async () => null,
          find: () => ({
            toArray: async () => []
          })
        })
      }
      const res = await computeAiNativeDeliveryLeverage(mockDb, 'missing')
      expect(res).toBeNull()
    })
  })
})
