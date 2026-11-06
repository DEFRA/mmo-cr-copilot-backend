import { computeFlowMetrics, median } from './flow-metrics.js'

const at = (day, hour = 9) =>
  new Date(Date.UTC(2026, 0, day, hour)).toISOString()

const done = (key, overrides = {}, flow = {}) => ({
  key,
  issueType: 'Story',
  status: { name: 'Done', categoryKey: 'done' },
  created: at(1),
  issueLinks: [],
  ...overrides,
  flow: {
    stageKind: 'done',
    doneAt: at(10),
    firstDoneAt: at(10),
    reopenCount: 0,
    flowEfficiency: null,
    ...flow
  }
})

const base = (overrides) =>
  computeFlowMetrics({
    done: [],
    issues: [],
    prsByKey: new Map(),
    payloads: [],
    ...overrides
  })

describe('#flow-metrics', () => {
  test('median ignores non-numbers and returns null when empty', () => {
    expect(median([3, 1, NaN, 2])).toBe(2)
    expect(median([1, 2])).toBe(1.5)
    expect(median([])).toBeNull()
  })

  test('Should measure change lead time from the first linked commit', () => {
    const story = done('A-1')
    const result = base({
      done: [story],
      issues: [story],
      prsByKey: new Map([
        [
          'A-1',
          [
            { firstCommitAt: at(4), prMergedAt: at(8) },
            { firstCommitAt: at(6), prMergedAt: at(9) }
          ]
        ]
      ])
    })

    expect(result.changeLeadTimeDays).toBe(6)
    expect(result.prsPerTicket).toBe(2)
  })

  test('Should count reopened tickets and bugs linked soon after Done as failed', () => {
    const bugSoon = done('B-1', { issueType: 'Bug', created: at(12) })
    const bugLate = done('B-2', { issueType: 'Bug', created: at(30) })
    const stories = [
      done('A-1', {}, { reopenCount: 1 }),
      done('A-2', { issueLinks: [{ key: 'B-1', issueType: 'Bug' }] }),
      done('A-3', { issueLinks: [{ key: 'B-2', issueType: 'Bug' }] }),
      done('A-4')
    ]

    const result = base({
      done: stories,
      issues: [...stories, bugSoon, bugLate]
    })

    expect(result.failedTickets).toEqual(['A-1', 'A-2'])
    expect(result.changeFailRate).toBe(50)
  })

  test('Should report rework, defect recovery and delivery frequency', () => {
    const tickets = [
      done('A-1'),
      done('B-1', { issueType: 'Bug', created: at(8) }),
      done('B-2', { issueType: 'Bug', created: at(6) })
    ]

    const result = base({
      done: tickets,
      issues: tickets,
      from: at(1, 0),
      to: at(15, 0)
    })

    expect(result.deliveryReworkRate).toBe(66.7)
    expect(result.defectRecoveryTimeDays).toBe(3)
    expect(result.bugsDelivered).toBe(2)
    expect(result.deliveryFrequencyPerWeek).toBe(1.5)
  })

  test('Should take the median flow efficiency of tickets that have one', () => {
    const stories = [
      done('A-1', {}, { flowEfficiency: 80 }),
      done('A-2', {}, { flowEfficiency: 60 }),
      done('A-3')
    ]

    expect(base({ done: stories, issues: stories }).flowEfficiency).toBe(70)
  })

  test('Should compare committed sprint scope with what was done by sprint end', () => {
    const issues = [
      done('A-1', {}, { firstDoneAt: at(10) }),
      done('A-2', {}, { firstDoneAt: at(20) }),
      { key: 'A-3', flow: { stageKind: 'active' } }
    ]
    const scopes = [
      { name: 'Sprint 1', endDate: at(14), issueKeys: ['A-1', 'A-2', 'A-3'] },
      { name: 'Old', endDate: at(1), issueKeys: ['A-1'] }
    ]

    const result = base({
      issues,
      scopes,
      from: at(2),
      to: at(20)
    })

    expect(result.sprintPredictability).toBe(33.3)
    expect(result.sprints).toEqual([
      { name: 'Sprint 1', committed: 3, done: 1, predictability: 33.3 }
    ])
    expect(result.workInProgress).toBe(1)
  })

  test('Should leave out a sprint that has not ended yet', () => {
    const issues = [done('A-1', {}, { firstDoneAt: at(10) })]

    const result = base({
      issues,
      scopes: [{ name: 'Live', endDate: at(20), issueKeys: ['A-1'] }],
      now: new Date(at(15))
    })

    expect(result.sprintPredictability).toBeNull()
    expect(result.sprints).toEqual([])
  })

  test('Should return nulls rather than zeros when there is nothing to measure', () => {
    const result = base({})

    expect(result).toMatchObject({
      changeLeadTimeDays: null,
      defectRecoveryTimeDays: null,
      flowEfficiency: null,
      sprintPredictability: null,
      prsPerTicket: null,
      prCycleTimeHours: null,
      changeFailRate: 0,
      deliveryFrequencyPerWeek: 0
    })
  })

  test('Should measure PR cycle time for merged PRs only', () => {
    const result = base({
      payloads: [
        { prCreatedAt: at(1, 9), prMergedAt: at(1, 21) },
        { prCreatedAt: at(1, 9) }
      ]
    })

    expect(result.prCycleTimeHours).toBe(12)
  })

  test('Should count active, waiting and unmapped tickets as WIP but not excluded ones', () => {
    const issues = [
      done('A-1', {}, { stageKind: 'active' }),
      done('A-2', {}, { stageKind: 'waiting' }),
      done('A-3', {}, { stageKind: 'excluded' }),
      done('A-4', {}, { stageKind: 'todo' }),
      done('A-5', {}, { stageKind: 'unmapped' })
    ]

    expect(base({ issues }).workInProgress).toBe(3)
  })

  test('Should take bug recovery to the flow Done time', () => {
    const bug = done('B-1', { issueType: 'Bug' }, { doneAt: at(5) })

    expect(base({ done: [bug], issues: [bug] }).defectRecoveryTimeDays).toBe(4)
  })

  test('Should count a ticket with no first Done as not done by sprint end', () => {
    const stories = [
      done('A-1', {}, { firstDoneAt: at(5) }),
      done('A-2', {}, { firstDoneAt: null })
    ]

    const result = base({
      done: stories,
      issues: stories,
      scopes: [{ name: 'S', endDate: at(8), issueKeys: ['A-1', 'A-2', 'A-9'] }]
    })

    expect(result.sprints[0]).toMatchObject({ committed: 3, done: 1 })
  })
})
