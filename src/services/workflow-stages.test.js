import {
  MAX_STATUSES_TOTAL,
  STAGE_IDS,
  STATUS_BASELINE,
  WORKFLOW_STAGES,
  attachIssueFlow,
  buildStageIndex,
  buildStatusCatalogue,
  buildWorkflowIndex,
  classifyStatus,
  deriveIssueFlow,
  normaliseStatus,
  resolveWorkflow,
  summariseUnmapped,
  workflowStagesError
} from './workflow-stages.js'

const at = (day, hour = 9) => new Date(Date.UTC(2026, 0, day, hour))
const NOW = at(30)

const issue = (overrides = {}) => ({
  key: 'A-1',
  status: { name: 'Done', categoryKey: 'done' },
  created: at(1),
  statusHistory: [],
  ...overrides
})

const path = (...steps) =>
  steps.slice(1).map(([day, to], i) => ({
    at: at(day),
    from: steps[i][1],
    to
  }))

const flowFor = (subject, project = null, issues = [subject]) => {
  const workflow = resolveWorkflow(project)
  return deriveIssueFlow(
    subject,
    buildWorkflowIndex(workflow),
    buildStatusCatalogue(issues),
    NOW
  )
}

const stagesOf = (workflow) =>
  Object.fromEntries(workflow.stages.map((s) => [s.id, s.statuses]))

const savedProject = (stages, version = 1) => ({
  jira: {
    projectKeys: ['ALPH'],
    statusMapping: {
      version,
      stages: STAGE_IDS.map((id) => ({ id, statuses: stages[id] ?? [] })),
      updatedAt: at(2),
      updatedBy: { oid: 'oid-1', name: 'A Person' }
    }
  }
})

describe('#workflow-stages', () => {
  describe('Catalogue and baseline', () => {
    test('Should list ten stages with To Do and Done required', () => {
      expect(STAGE_IDS).toHaveLength(10)
      expect(
        WORKFLOW_STAGES.filter((s) => s.required).map((s) => s.id)
      ).toEqual(['todo', 'done'])
    })

    test('Should not repeat a baseline status across stages', () => {
      const names = STAGE_IDS.flatMap((id) => STATUS_BASELINE[id])
      expect(new Set(names.map(normaliseStatus)).size).toBe(names.length)
      expect(names).toHaveLength(113)
    })
  })

  describe('#workflowStagesError', () => {
    const valid = [
      { id: 'todo', statuses: ['To Do'] },
      { id: 'done', statuses: ['Done'] }
    ]

    test('Should accept a valid stage list', () => {
      expect(workflowStagesError(valid)).toBeNull()
    })

    test('Should require To Do and Done', () => {
      expect(workflowStagesError([valid[1]])).toBe(
        'To Do needs at least one status'
      )
      expect(
        workflowStagesError([valid[0], { id: 'done', statuses: [] }])
      ).toBe('Done needs at least one status')
    })

    test('Should catch a duplicate ignoring case and spacing', () => {
      expect(
        workflowStagesError([
          ...valid,
          { id: 'in-review', statuses: ['In  review'] },
          { id: 'in-test', statuses: ['in review'] }
        ])
      ).toBe("'in review' is in more than one stage")
    })

    test('Should cap the total number of statuses', () => {
      const many = Array.from({ length: MAX_STATUSES_TOTAL }, (_, i) => `S${i}`)
      expect(
        workflowStagesError([...valid, { id: 'blocked', statuses: many }])
      ).toBe(`A workflow can have at most ${MAX_STATUSES_TOTAL} statuses`)
    })
  })

  describe('#resolveWorkflow', () => {
    test('Should use a saved mapping', () => {
      const workflow = resolveWorkflow(
        savedProject({ todo: ['Selected'], done: ['Completed'] }, 3)
      )

      expect(workflow).toMatchObject({
        source: 'project',
        version: 3,
        updatedAt: at(2),
        updatedBy: { name: 'A Person' }
      })
      expect(workflow.stages[0]).toEqual({
        id: 'todo',
        label: 'To Do',
        kind: 'todo',
        required: true,
        statuses: ['Selected']
      })
      expect(stagesOf(workflow)['in-progress']).toEqual([])
    })

    test('Should fall back to the baseline', () => {
      const workflow = resolveWorkflow({ jira: { projectKeys: ['ALPH'] } })

      expect(workflow).toMatchObject({
        source: 'default',
        version: 0,
        updatedAt: null,
        updatedBy: null
      })
      expect(stagesOf(workflow)).toEqual(STATUS_BASELINE)
    })

    test('Should ignore a stored mapping that is not a saved workflow', () => {
      expect(
        resolveWorkflow({ jira: { statusMapping: { Done: 'done' } } }).source
      ).toBe('default')
      expect(resolveWorkflow(null).source).toBe('default')
    })

    describe('When statuses were detected from Jira', () => {
      const detected = (statuses) => ({
        jira: { detectedStatuses: statuses }
      })

      test('Should place each status by baseline synonym first, then its Jira category', () => {
        const workflow = resolveWorkflow(
          detected([
            { name: 'Backlog', categoryKey: 'new' },
            { name: 'Code  Review', categoryKey: 'indeterminate' },
            { name: 'Blocked', categoryKey: 'indeterminate' },
            { name: 'Funnel', categoryKey: 'new' },
            { name: 'Building Stuff', categoryKey: 'indeterminate' },
            { name: 'Closed', categoryKey: 'done' },
            { name: 'Shipped It', categoryKey: 'done' },
            { name: 'Mystery', categoryKey: null },
            { name: 'backlog', categoryKey: 'new' }
          ])
        )
        const stages = stagesOf(workflow)

        expect(workflow).toMatchObject({ source: 'detected', version: 0 })
        expect(stages.todo).toEqual(['Backlog', 'Funnel'])
        expect(stages['in-review']).toEqual(['Code Review'])
        expect(stages.blocked).toEqual(['Blocked'])
        expect(stages['in-progress']).toEqual(['Building Stuff'])
        expect(stages.done).toEqual(['Closed', 'Shipped It'])
        expect(Object.values(stages).flat()).not.toContain('Mystery')
      })

      test('Should fill an empty To Do or Done from the baseline', () => {
        const stages = stagesOf(
          resolveWorkflow(
            detected([{ name: 'In Progress', categoryKey: 'indeterminate' }])
          )
        )

        expect(stages.todo).toEqual(STATUS_BASELINE.todo)
        expect(stages.done).toEqual(STATUS_BASELINE.done)
        expect(stages['in-progress']).toEqual(['In Progress'])
      })

      test('Should let a saved mapping override detection', () => {
        const project = savedProject({ todo: ['To Do'], done: ['Done'] })
        project.jira.detectedStatuses = [{ name: 'Funnel', categoryKey: 'new' }]

        expect(resolveWorkflow(project).source).toBe('project')
      })

      test('Should classify an undetected history status by baseline synonym, then category', () => {
        const workflow = resolveWorkflow(
          detected([
            { name: 'To Do', categoryKey: 'new' },
            { name: 'Done', categoryKey: 'done' }
          ])
        )
        const index = buildWorkflowIndex(workflow)
        const catalogue = new Map([['triaged', 'new']])

        expect(classifyStatus('In Review', index, catalogue)).toEqual({
          stageId: 'in-review',
          kind: 'active',
          inferred: true
        })
        expect(classifyStatus('Triaged', index, catalogue)).toEqual({
          stageId: null,
          kind: 'todo',
          inferred: true
        })
        expect(classifyStatus('Funnel', index, catalogue).kind).toBe('unmapped')
      })
    })
  })

  describe('#buildStageIndex and #classifyStatus', () => {
    test('Should keep the first stage for a repeated name', () => {
      const index = buildStageIndex([
        { id: 'todo', kind: 'todo', statuses: ['Open'] },
        { id: 'done', kind: 'done', statuses: ['open'] }
      ])

      expect(index.get('open')).toEqual({ stageId: 'todo', kind: 'todo' })
    })

    test('Should not fall back to the baseline for a saved mapping', () => {
      const index = buildWorkflowIndex(
        resolveWorkflow(savedProject({ todo: ['To Do'], done: ['Completed'] }))
      )

      expect(classifyStatus('Done', index).kind).toBe('unmapped')
    })
  })

  describe('#buildStatusCatalogue', () => {
    test('Should keep the first known category for each current status', () => {
      const catalogue = buildStatusCatalogue([
        { status: { name: 'Shipped', categoryKey: 'done' } },
        { status: { name: 'shipped', categoryKey: 'new' } },
        { status: { name: 'Odd', categoryKey: '' } },
        {}
      ])

      expect([...catalogue]).toEqual([['shipped', 'done']])
    })
  })

  describe('#deriveIssueFlow', () => {
    test('Should measure a full path from first move out of To Do to Done', () => {
      const flow = flowFor(
        issue({
          statusHistory: path(
            [1, 'To Do'],
            [2, 'In Dev'],
            [4, 'In Review'],
            [5, 'Ready to Test'],
            [7, 'In Test'],
            [8, 'Done']
          )
        })
      )

      expect(flow).toEqual({
        stageId: 'done',
        stageKind: 'done',
        startedAt: at(2),
        doneAt: at(8),
        firstDoneAt: at(8),
        cycleDays: 6,
        leadDays: 7,
        activeDays: 4,
        waitingDays: 2,
        flowEfficiency: 66.7,
        reopenCount: 0,
        unmappedStatuses: []
      })
    })

    test('Should start and finish together when To Do goes straight to Done', () => {
      const flow = flowFor(
        issue({ statusHistory: path([1, 'To Do'], [3, 'Done']) })
      )

      expect(flow.startedAt).toEqual(flow.doneAt)
      expect(flow.cycleDays).toBe(0)
      expect(flow.flowEfficiency).toBeNull()
    })

    test('Should end at the last Done after a reopen and count the earlier Done as waiting', () => {
      const flow = flowFor(
        issue({
          statusHistory: path(
            [1, 'To Do'],
            [2, 'In Progress'],
            [4, 'Done'],
            [6, 'In Progress'],
            [7, 'Done']
          )
        })
      )

      expect(flow).toMatchObject({
        reopenCount: 1,
        firstDoneAt: at(4),
        doneAt: at(7),
        activeDays: 3,
        waitingDays: 2
      })
    })

    test('Should keep the start when a ticket moves back to To Do and count that time as waiting', () => {
      const flow = flowFor(
        issue({
          statusHistory: path(
            [1, 'To Do'],
            [2, 'In Progress'],
            [3, 'To Do'],
            [5, 'In Progress'],
            [6, 'Done']
          )
        })
      )

      expect(flow).toMatchObject({
        startedAt: at(2),
        activeDays: 2,
        waitingDays: 2
      })
    })

    test('Should start at creation when created straight into In Progress', () => {
      const flow = flowFor(
        issue({
          created: at(1, 8),
          statusHistory: path([1, 'In Progress'], [3, 'Done'])
        })
      )

      expect(flow.startedAt).toEqual(at(1, 8))
    })

    test('Should list an unmapped status and count its time as active', () => {
      const flow = flowFor(
        issue({
          statusHistory: path(
            [1, 'To Do'],
            [2, 'In Progress'],
            [3, 'Funnel'],
            [5, 'Done']
          )
        })
      )

      expect(flow.unmappedStatuses).toEqual(['Funnel'])
      expect(flow.activeDays).toBe(3)
      expect(flow.flowEfficiency).toBe(100)
    })

    test('Should start on the first move out of To Do even into an unmapped status', () => {
      const flow = flowFor(
        issue({
          statusHistory: path(
            [1, 'To Do'],
            [2, 'Analysis'],
            [4, 'In Progress'],
            [6, 'Done']
          )
        })
      )

      expect(flow).toMatchObject({
        startedAt: at(2),
        activeDays: 4,
        unmappedStatuses: ['Analysis']
      })
    })

    test('Should infer Done for an unmapped status whose Jira category is done', () => {
      const shipped = issue({
        status: { name: 'Shipped To Users', categoryKey: 'done' },
        statusHistory: path(
          [1, 'To Do'],
          [2, 'In Progress'],
          [4, 'Shipped To Users']
        )
      })
      const flow = flowFor(shipped)

      expect(flow).toMatchObject({
        stageId: null,
        stageKind: 'done',
        doneAt: at(4),
        unmappedStatuses: []
      })
    })

    test('Should exclude a cancelled ticket', () => {
      const flow = flowFor(
        issue({
          status: { name: 'Cancelled', categoryKey: 'done' },
          statusHistory: path([1, 'To Do'], [2, 'Cancelled'])
        })
      )

      expect(flow).toMatchObject({
        stageKind: 'excluded',
        startedAt: null,
        doneAt: null,
        cycleDays: null,
        activeDays: null
      })
    })

    test('Should end a cancelled ticket at the move into Cancelled', () => {
      const flow = flowFor(
        issue({
          status: { name: 'Cancelled', categoryKey: 'done' },
          statusHistory: path(
            [1, 'To Do'],
            [2, 'In Progress'],
            [5, 'Cancelled']
          )
        })
      )

      expect(flow).toMatchObject({
        stageKind: 'excluded',
        startedAt: at(2),
        doneAt: null,
        activeDays: 3,
        waitingDays: 0,
        reopenCount: 0
      })
    })

    test('Should not count Done to Cancelled as a reopen', () => {
      const flow = flowFor(
        issue({
          status: { name: 'Cancelled', categoryKey: 'done' },
          statusHistory: path(
            [1, 'To Do'],
            [2, 'In Progress'],
            [4, 'Done'],
            [6, 'Cancelled']
          )
        })
      )

      expect(flow).toMatchObject({
        stageKind: 'excluded',
        doneAt: null,
        firstDoneAt: at(4),
        activeDays: 2,
        waitingDays: 2,
        reopenCount: 0
      })
    })

    test('Should measure an open ticket up to now', () => {
      const flow = flowFor(
        issue({
          status: { name: 'In Progress', categoryKey: 'indeterminate' },
          statusHistory: path([1, 'To Do'], [28, 'In Progress'])
        })
      )

      expect(flow).toMatchObject({
        stageKind: 'active',
        doneAt: null,
        firstDoneAt: null,
        cycleDays: null,
        activeDays: 2
      })
    })

    test('Should add the current status at the last update when history lags behind', () => {
      const flow = flowFor(
        issue({
          status: { name: 'Done', categoryKey: 'done' },
          resolved: at(6),
          statusHistory: path([1, 'To Do'], [2, 'Funnel'])
        })
      )

      expect(flow).toMatchObject({
        stageKind: 'done',
        doneAt: at(6),
        activeDays: 4,
        unmappedStatuses: ['Funnel']
      })
    })

    test('Should not place the lagging status before the last history move', () => {
      const flow = flowFor(
        issue({
          status: { name: 'Done', categoryKey: 'done' },
          updated: at(1),
          statusHistory: path([1, 'To Do'], [2, 'In Progress'])
        })
      )

      expect(flow).toMatchObject({ doneAt: at(2), cycleDays: 0 })
    })

    test('Should use the resolution date when no transition moves into Done', () => {
      const flow = flowFor(
        issue({
          status: { name: 'Closed', categoryKey: 'done' },
          resolved: at(9),
          statusHistory: path([1, 'Done'], [3, 'Closed'])
        })
      )

      expect(flow).toMatchObject({
        startedAt: at(1),
        doneAt: at(9),
        firstDoneAt: at(9)
      })
    })

    test('Should start at creation and keep stored fields when there is no history', () => {
      const flow = flowFor(
        issue({
          resolved: at(5),
          firstDoneAt: at(4),
          reopenCount: 2
        })
      )

      expect(flow).toEqual({
        stageId: 'done',
        stageKind: 'done',
        startedAt: at(1),
        doneAt: at(5),
        firstDoneAt: at(4),
        cycleDays: 4,
        leadDays: 4,
        activeDays: null,
        waitingDays: null,
        flowEfficiency: null,
        reopenCount: 2,
        unmappedStatuses: []
      })
    })

    test('Should report an unmapped current status on the legacy path', () => {
      const flow = flowFor(
        issue({ status: { name: 'Funnel', categoryKey: '' } })
      )

      expect(flow).toMatchObject({
        stageKind: 'unmapped',
        startedAt: at(1),
        doneAt: null,
        reopenCount: 0,
        unmappedStatuses: ['Funnel']
      })
    })

    test('Should leave Done unmapped when a custom mapping uses only Completed', () => {
      const subject = issue({
        status: { name: 'Done', categoryKey: '' },
        statusHistory: path([1, 'To Do'], [2, 'In Progress'], [4, 'Done'])
      })

      const flow = flowFor(
        subject,
        savedProject({
          todo: ['To Do'],
          'in-progress': ['In Progress'],
          done: ['Completed']
        })
      )

      expect(flow.stageKind).toBe('unmapped')
      expect(flow.unmappedStatuses).toEqual(['Done'])
    })

    test('Should not mutate the issue', () => {
      const subject = issue({ statusHistory: path([1, 'To Do'], [2, 'Done']) })
      const copy = structuredClone(subject)

      flowFor(subject)

      expect(subject).toEqual(copy)
    })
  })

  describe('#attachIssueFlow and #summariseUnmapped', () => {
    test('Should attach flow and summarise unmapped statuses by issue count', () => {
      const issues = [
        issue({ key: 'A-1', status: { name: 'Funnel', categoryKey: '' } }),
        issue({ key: 'A-2', status: { name: 'Funnel', categoryKey: '' } }),
        issue({ key: 'A-3', status: { name: 'Alpha', categoryKey: '' } }),
        issue({ key: 'A-4', status: { name: 'Beta', categoryKey: '' } })
      ]

      const { workflow, issues: withFlow } = attachIssueFlow(issues, null, NOW)

      expect(workflow.source).toBe('default')
      expect(withFlow[0].flow.stageKind).toBe('unmapped')
      expect(issues[0].flow).toBeUndefined()
      expect(summariseUnmapped(withFlow)).toEqual([
        { name: 'Funnel', issues: 2 },
        { name: 'Alpha', issues: 1 },
        { name: 'Beta', issues: 1 }
      ])
      expect(summariseUnmapped(withFlow, 1)).toHaveLength(1)
    })
  })
})
