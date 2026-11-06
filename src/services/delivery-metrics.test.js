const PROJECT = 'proj'

// Created Jan 5, started Jan 6 and Done on `resolved` (Jan 10 by default).
const issue = (key, overrides = {}) => {
  const resolved =
    'resolved' in overrides
      ? overrides.resolved
      : new Date('2026-01-10T09:00:00Z')
  return {
    key,
    projectSlug: PROJECT,
    status: { name: 'Done', categoryKey: 'done' },
    created: new Date('2026-01-05T09:00:00Z'),
    resolved,
    statusHistory: [
      {
        at: new Date('2026-01-06T09:00:00Z'),
        from: 'To Do',
        to: 'In Progress'
      },
      { at: resolved, from: 'In Progress', to: 'Done' }
    ],
    storyPoints: 3,
    ...overrides
  }
}

const payload = (prNumber, overrides = {}) => ({
  repository: 'DEFRA/repo',
  prNumber,
  projectSlug: PROJECT,
  calculatedAt: new Date('2026-01-09T09:00:00Z'),
  receivedAt: new Date('2026-01-09T09:00:00Z'),
  commitBreakdown: [],
  jiraKeys: [],
  ...overrides
})

describe('#computeDeliveryMetrics', () => {
  let server
  let db
  let computeDeliveryMetrics
  let computeAiNativeDeliveryLeverage

  beforeAll(async () => {
    // Dynamic imports: config must be read after vitest-mongodb sets MONGO_URI
    ;({ computeDeliveryMetrics } = await import('./delivery-metrics.js'))
    ;({ computeAiNativeDeliveryLeverage } = await import('./complexity.js'))
    const { createServer } = await import('#/server.js')
    server = await createServer()
    await server.initialize()
    db = server.db
  })

  afterAll(async () => {
    await server.stop({ timeout: 1000 })
  })

  beforeEach(async () => {
    for (const name of [
      'jira-issues',
      'pr-jira-links',
      'payloads',
      'repositories',
      'sonar-pr-snapshots',
      'ai_survival'
    ]) {
      await db.collection(name).deleteMany({})
    }
    await db
      .collection('repositories')
      .insertOne({ fullName: 'DEFRA/repo', projectSlug: PROJECT })
  })

  test('Should count only Done issues resolved in the window', async () => {
    await db.collection('jira-issues').insertMany([
      issue('P-1'),
      issue('P-2', { resolved: new Date('2026-03-01T00:00:00Z') }),
      issue('P-3', {
        status: { name: 'In Progress', categoryKey: 'indeterminate' }
      })
    ])

    const result = await computeDeliveryMetrics(db, PROJECT, {
      from: '2026-01-01T00:00:00Z',
      to: '2026-02-01T00:00:00Z'
    })

    expect(result.storiesDelivered).toBe(1)
    expect(result.leadTimeToDoneDays).toBe(5)
    expect(result.cycleTimeDays).toBe(4)
  })

  test('Should report the share of delivered stories that were reopened', async () => {
    const day = (d) => new Date(Date.UTC(2026, 0, d, 9))
    await db.collection('jira-issues').insertMany([
      issue('P-1', {
        statusHistory: [
          { at: day(6), from: 'To Do', to: 'In Progress' },
          { at: day(8), from: 'In Progress', to: 'Done' },
          { at: day(9), from: 'Done', to: 'In Progress' },
          { at: day(10), from: 'In Progress', to: 'Done' }
        ]
      }),
      issue('P-2'),
      issue('P-3'),
      issue('P-4')
    ])

    const result = await computeDeliveryMetrics(db, PROJECT)

    expect(result.reopenRate).toBe(25)
  })

  test('Should warn about Done tickets whose linked PR is not merged', async () => {
    await db.collection('jira-issues').insertMany([issue('P-1'), issue('P-2')])
    await db.collection('payloads').insertMany([
      payload(1, { jiraKeys: ['P-1'] }),
      payload(2, {
        jiraKeys: ['P-2'],
        prMergedAt: new Date('2026-01-09T10:00:00Z')
      })
    ])

    const result = await computeDeliveryMetrics(db, PROJECT)

    expect(result.warnings).toEqual([{ key: 'P-1', type: 'done-with-open-pr' }])
  })

  test('Should rate PRs without a Jira key as unlinked', async () => {
    await db
      .collection('payloads')
      .insertMany([payload(1, { jiraKeys: ['P-1'] }), payload(2)])

    const result = await computeDeliveryMetrics(db, PROJECT)

    expect(result.unlinkedPrRate).toBe(50)
  })

  test('Should return zeros and no warnings for an empty project', async () => {
    const result = await computeDeliveryMetrics(db, PROJECT)

    expect(result).toMatchObject({
      storiesDelivered: 0,
      reopenRate: 0,
      unlinkedPrRate: 0,
      firstScanPassRate: 0,
      standardDeployableUnits: 0,
      warnings: []
    })
  })

  describe('Jira workflow mapping', () => {
    const at = (day) => new Date(Date.UTC(2026, 0, day, 9))
    const moves = (...steps) =>
      steps.slice(1).map(([day, to], i) => ({
        at: at(day),
        from: steps[i][1],
        to
      }))
    const saveMapping = (stages) =>
      db.collection('projects').updateOne(
        { slug: PROJECT },
        {
          $set: {
            'jira.statusMapping': {
              version: 2,
              stages: Object.entries(stages).map(([id, statuses]) => ({
                id,
                statuses
              }))
            }
          }
        }
      )
    const window = { from: '2026-01-01T00:00:00Z', to: '2026-02-01T00:00:00Z' }

    beforeEach(async () => {
      await db.collection('projects').deleteMany({})
      await db
        .collection('projects')
        .insertOne({ slug: PROJECT, jira: { projectKeys: ['PROJ'] } })
    })

    test('Should deliver a story moved into a mapped Done status without a resolution', async () => {
      await saveMapping({
        todo: ['To Do'],
        'in-progress': ['In Progress'],
        done: ['Completed']
      })
      await db.collection('jira-issues').insertOne(
        issue('P-1', {
          status: { name: 'Completed', categoryKey: 'indeterminate' },
          resolved: null,
          created: at(1),
          statusHistory: moves(
            [1, 'To Do'],
            [3, 'In Progress'],
            [7, 'Completed']
          )
        })
      )

      const result = await computeDeliveryMetrics(db, PROJECT, window)

      expect(result.storiesDelivered).toBe(1)
      expect(result.cycleTimeDays).toBe(4)
      expect(result.leadTimeToDoneDays).toBe(6)
      expect(result.workflow).toEqual({
        source: 'project',
        version: 2,
        unmappedStatuses: []
      })
    })

    test('Should start the clock on leaving a custom To Do status', async () => {
      await saveMapping({
        todo: ['Selected'],
        'in-progress': ['Building'],
        done: ['Done']
      })
      await db.collection('jira-issues').insertOne(
        issue('P-1', {
          created: at(1),
          statusHistory: moves([1, 'Selected'], [5, 'Building'], [6, 'Done'])
        })
      )

      const result = await computeDeliveryMetrics(db, PROJECT, window)

      expect(result.cycleTimeDays).toBe(1)
    })

    test('Should not deliver a cancelled story', async () => {
      await db
        .collection('jira-issues')
        .insertMany([
          issue('P-1'),
          issue('P-2', { status: { name: 'Cancelled', categoryKey: 'done' } })
        ])

      const result = await computeDeliveryMetrics(db, PROJECT, window)

      expect(result.storiesDelivered).toBe(1)
      expect(result.workflow.source).toBe('default')
    })

    test('Should apply statuses detected from Jira with no admin action', async () => {
      await db.collection('projects').updateOne(
        { slug: PROJECT },
        {
          $set: {
            'jira.detectedStatuses': [
              { name: 'Funnel', categoryKey: 'new' },
              { name: 'Cooking', categoryKey: 'indeterminate' },
              { name: 'Served', categoryKey: 'done' }
            ]
          }
        }
      )
      await db.collection('jira-issues').insertOne(
        issue('P-1', {
          status: { name: 'Served', categoryKey: '' },
          created: at(1),
          statusHistory: moves([1, 'Funnel'], [4, 'Cooking'], [6, 'Served'])
        })
      )

      const result = await computeDeliveryMetrics(db, PROJECT, window)

      expect(result.workflow.source).toBe('detected')
      expect(result.storiesDelivered).toBe(1)
      expect(result.cycleTimeDays).toBe(2)
    })

    test('Should list statuses outside every stage with their issue counts', async () => {
      await db.collection('jira-issues').insertMany([
        issue('P-1', {
          statusHistory: moves([1, 'To Do'], [2, 'Funnel'], [4, 'Done'])
        }),
        issue('P-2', {
          status: { name: 'Funnel', categoryKey: '' },
          statusHistory: moves([1, 'To Do'], [2, 'Funnel'])
        })
      ])

      const result = await computeDeliveryMetrics(db, PROJECT)

      expect(result.workflow.unmappedStatuses).toEqual([
        { name: 'Funnel', issues: 2 }
      ])
    })
  })

  describe('QANT_comp (complexity-normalised QANT)', () => {
    const merged = new Date('2026-01-09T09:00:00Z')
    const withLines = (prNumber, added, score, extra = {}) =>
      payload(prNumber, {
        prMergedAt: merged,
        commitBreakdown: [
          { commit: `c${prNumber}`, linesAdded: added, linesDeleted: 0 }
        ],
        complexity: { score, band: 'M' },
        ...extra
      })

    test('Should divide each story’s quality lines by its PR complexity, per cycle day', async () => {
      await db.collection('jira-issues').insertOne(issue('P-1'))
      await db
        .collection('payloads')
        .insertOne(withLines(1, 100, 50, { jiraKeys: ['P-1'] }))

      const res = await computeDeliveryMetrics(db, PROJECT)

      // 100 lines × Q 1.0 ÷ complexity 50 = 2, over a 4-day cycle = 0.5.
      expect(res.qant).toBe(25)
      expect(res.qantComp).toBe(0.5)
    })

    test('Should rate a more complex PR lower for the same lines', async () => {
      await db
        .collection('jira-issues')
        .insertMany([issue('P-1'), issue('P-2')])
      await db
        .collection('payloads')
        .insertMany([
          withLines(1, 100, 10, { jiraKeys: ['P-1'] }),
          withLines(2, 100, 90, { jiraKeys: ['P-2'] })
        ])

      const simple = await computeDeliveryMetrics(db, PROJECT)

      expect(simple.qantComp).toBe(1.39)
    })

    test('Should leave a story with no complexity score out of both sums', async () => {
      await db
        .collection('jira-issues')
        .insertMany([issue('P-1'), issue('P-2')])
      await db.collection('payloads').insertMany([
        withLines(1, 100, 50, { jiraKeys: ['P-1'] }),
        payload(2, {
          prMergedAt: merged,
          commitBreakdown: [{ commit: 'x', linesAdded: 500, linesDeleted: 0 }],
          jiraKeys: ['P-2']
        })
      ])

      const res = await computeDeliveryMetrics(db, PROJECT)

      expect(res.qantComp).toBe(0.5)
    })

    test('Should derive the score from the files block when none is stored', async () => {
      await db.collection('jira-issues').insertOne(issue('P-1'))
      await db.collection('payloads').insertOne(
        payload(1, {
          prMergedAt: merged,
          commitBreakdown: [{ commit: 'c', linesAdded: 100, linesDeleted: 0 }],
          files: { linesTouched: 100, changed: 4, modulesTouched: 2 },
          jiraKeys: ['P-1']
        })
      )

      const res = await computeDeliveryMetrics(db, PROJECT)

      expect(res.qantComp).toBeGreaterThan(0)
    })

    test('Should be zero with no delivered stories', async () => {
      const res = await computeDeliveryMetrics(db, PROJECT)

      expect(res.qantComp).toBe(0)
    })
  })

  describe('#computeAiNativeDeliveryLeverage', () => {
    const pr = (prNumber, startDay, hours, merged = true) => {
      const first = new Date(Date.UTC(2026, 0, startDay, 9))
      return payload(prNumber, {
        calculatedAt: first,
        firstCommitAt: first,
        lastCommitAt: new Date(first.getTime() + hours * 3600000),
        ...(merged ? { prMergedAt: first } : {}),
        complexity: { score: 10, band: 'XS' }
      })
    }

    beforeEach(async () => {
      await db.collection('projects').deleteMany({})
      await db.collection('projects').insertOne({
        slug: PROJECT,
        type: 'ai-native',
        sprintCalendar: { cadenceDays: 7 }
      })
    })

    test('Should compare the window with the first sprints of the project', async () => {
      await db
        .collection('payloads')
        .insertMany([
          ...[1, 2, 3, 4, 5].map((n) => pr(n, 1 + n, 20)),
          ...[6, 7, 8, 9, 10].map((n) => pr(n, 30 + n, 10)),
          pr(11, 41, 10, false)
        ])

      const result = await computeAiNativeDeliveryLeverage(db, PROJECT, {
        baselineSprintCount: 1,
        from: '2026-01-20T00:00:00Z',
        to: '2026-03-01T00:00:00Z'
      })

      expect(result.ownBaseline).toMatchObject({
        baselineMedianCycleHours: 20,
        currentMedianCycleHours: 10,
        baselineCount: 5,
        currentCount: 6,
        comparable: true,
        speedup: 2
      })
      expect(result.complexityWeightedThroughput).toBe(50)
      expect(result.mergedPullRequests).toBe(5)
      expect(result.deliveryQuality).toEqual({
        changeFailRate: 0,
        deliveryReworkRate: 0,
        reopenRate: 0
      })
      expect(result.codeDurability).toEqual({ available: false })
    })

    test('Should report how much AI code survived 21 days once it has been measured', async () => {
      const record = (
        prNumber,
        merged,
        surviving,
        humanMerged,
        humanSurviving
      ) => ({
        repository: 'DEFRA/repo',
        prNumber,
        windowDays: 21,
        projectSlug: PROJECT,
        mergedAt: new Date('2026-02-01T00:00:00Z'),
        aiLinesMerged: merged,
        aiLinesSurviving: surviving,
        humanLinesMerged: humanMerged,
        humanLinesSurviving: humanSurviving
      })
      await db
        .collection('ai_survival')
        .insertMany([record(1, 100, 80, 50, 45), record(2, 100, 60, 50, 45)])

      const result = await computeAiNativeDeliveryLeverage(db, PROJECT, {
        from: '2026-01-20T00:00:00Z',
        to: '2026-03-01T00:00:00Z'
      })

      expect(result.codeDurability).toEqual({
        available: true,
        windowDays: 21,
        prCount: 2,
        aiSurvivalPercent: 70,
        humanSurvivalPercent: 90
      })
    })

    test('Should not compare a thin baseline', async () => {
      await db.collection('payloads').insertMany([pr(1, 2, 20), pr(2, 40, 10)])

      const result = await computeAiNativeDeliveryLeverage(db, PROJECT, {
        baselineSprintCount: 1
      })

      expect(result.ownBaseline).toMatchObject({
        comparable: false,
        speedup: null
      })
    })
  })
})
