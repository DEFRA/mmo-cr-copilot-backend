import {
  computeFlowMetrics,
  median,
  ticketFlowEfficiency
} from './flow-metrics.js'

const at = (day, hour = 9) =>
  new Date(Date.UTC(2026, 0, day, hour)).toISOString()

const done = (key, overrides = {}) => ({
  key,
  issueType: 'Story',
  status: { name: 'Done', categoryKey: 'done' },
  created: at(1),
  resolved: at(10),
  firstDoneAt: at(10),
  reopenCount: 0,
  issueLinks: [],
  statusHistory: [],
  ...overrides
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
      done('A-1', { reopenCount: 1 }),
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
      done('B-1', { issueType: 'Bug', created: at(8), resolved: at(10) }),
      done('B-2', { issueType: 'Bug', created: at(6), resolved: at(10) })
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

  test('Should subtract waiting time for flow efficiency', () => {
    const story = done('A-1', {
      resolved: at(5),
      statusHistory: [
        { at: at(1), from: 'To Do', to: 'In Progress' },
        { at: at(2), from: 'In Progress', to: 'Blocked' },
        { at: at(3), from: 'Blocked', to: 'In Progress' },
        { at: at(5), from: 'In Progress', to: 'Done' }
      ]
    })

    expect(ticketFlowEfficiency(story)).toBe(75)
    expect(ticketFlowEfficiency(done('A-2'))).toBeNull()
    expect(base({ done: [story], issues: [story] }).flowEfficiency).toBe(75)
  })

  test('Should compare committed sprint scope with what was done by sprint end', () => {
    const issues = [
      done('A-1', { firstDoneAt: at(10) }),
      done('A-2', { firstDoneAt: at(20) }),
      { key: 'A-3', status: { categoryKey: 'indeterminate' } }
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
    const issues = [done('A-1', { firstDoneAt: at(10) })]

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
})
