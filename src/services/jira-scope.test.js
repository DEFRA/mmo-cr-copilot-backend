const PROJECT = { slug: 'FES', jira: { projectKeys: ['FI0'] } }

const issue = (key, overrides = {}) => ({
  key,
  projectSlug: 'FES',
  issueType: 'Story',
  status: { name: 'Done', categoryKey: 'done' },
  created: new Date('2026-07-01T09:00:00.000Z'),
  statusHistory: [
    {
      at: new Date('2026-07-02T09:00:00.000Z'),
      from: 'To Do',
      to: 'In Progress'
    },
    {
      at: new Date('2026-07-04T09:00:00.000Z'),
      from: 'In Progress',
      to: 'Done'
    }
  ],
  ...overrides
})

describe('#jira-scope', () => {
  let server
  let db
  let scope

  beforeAll(async () => {
    // Dynamic imports: config must be read after vitest-mongodb sets MONGO_URI
    scope = await import('./jira-scope.js')
    const { createServer } = await import('#/server.js')
    server = await createServer()
    await server.initialize()
    db = server.db
  })

  afterAll(async () => {
    await server.stop({ timeout: 1000 })
  })

  beforeEach(async () => {
    for (const name of ['jira-issues', 'pr-jira-links', 'payloads']) {
      await db.collection(name).deleteMany({})
    }
  })

  describe('#inProjectKeys', () => {
    test("Should keep only well-formed keys of the project's Jira projects", () => {
      const keys = scope.inProjectKeys(
        ['FI0-1', 'ABC-1', 'fi0-1', 'FI0', 'FI0-1', 42, null],
        PROJECT
      )

      expect(keys).toEqual(['FI0-1'])
    })

    test('Should accept any well-formed key when the project has none', () => {
      expect(
        scope.inProjectKeys(['ABC-1', 'bad'], { jira: { projectKeys: [] } })
      ).toEqual(['ABC-1'])
    })

    test('Should return nothing for no keys', () => {
      expect(scope.inProjectKeys(undefined, PROJECT)).toEqual([])
    })
  })

  describe('#referencedKeys', () => {
    beforeEach(async () => {
      await db.collection('payloads').insertOne({
        repository: 'DEFRA/r',
        prNumber: 1,
        projectSlug: 'FES',
        jiraKeys: ['FI0-1', 'ABC-9'],
        calculatedAt: new Date('2026-01-09'),
        commitBreakdown: [{ committedAt: new Date('2026-01-09') }]
      })
      await db.collection('pr-jira-links').insertOne({
        projectSlug: 'FES',
        jiraKey: 'FI0-2',
        repository: 'DEFRA/r',
        prNumber: 2
      })
    })

    test('Should map every referenced key to its PRs across all time', async () => {
      const byKey = await scope.referencedKeys(db, { slug: 'FES', ...PROJECT })

      expect([...byKey.keys()].sort()).toEqual(['FI0-1', 'FI0-2'])
      expect(byKey.get('FI0-1')).toEqual(new Set(['DEFRA/r#1']))
    })

    test('Should limit keys to PRs active in the window', async () => {
      const byKey = await scope.referencedKeys(db, PROJECT, {
        from: '2026-01-01',
        to: '2026-02-01'
      })

      expect([...byKey.keys()]).toEqual(['FI0-1'])
    })

    test('Should read links of a windowed PR', async () => {
      await db.collection('pr-jira-links').insertOne({
        projectSlug: 'FES',
        jiraKey: 'FI0-3',
        repository: 'DEFRA/r',
        prNumber: 1
      })

      const byKey = await scope.referencedKeys(db, PROJECT, {
        from: '2026-01-01',
        to: '2026-02-01'
      })

      expect([...byKey.keys()].sort()).toEqual(['FI0-1', 'FI0-3'])
    })

    test('Should return nothing when no PR is active in the window', async () => {
      const byKey = await scope.referencedKeys(db, PROJECT, {
        from: '2027-01-01',
        to: '2027-02-01'
      })

      expect(byKey.size).toBe(0)
    })
  })

  describe('#loadScopedIssues', () => {
    test('Should load referenced issues and Story parents but not Epics or strangers', async () => {
      await db.collection('jira-issues').insertMany([
        issue('FI0-1', {
          issueType: 'Sub-task',
          parentKey: 'FI0-10',
          parentIssueType: 'Story'
        }),
        issue('FI0-10'),
        issue('FI0-3', {
          issueType: 'Task',
          parentKey: 'FI0-50',
          parentIssueType: 'Epic'
        }),
        issue('FI0-50', { issueType: 'Epic' }),
        issue('FI0-9999')
      ])
      await db.collection('payloads').insertOne({
        repository: 'DEFRA/r',
        prNumber: 1,
        projectSlug: 'FES',
        jiraKeys: ['FI0-1', 'FI0-3'],
        calculatedAt: new Date('2026-01-09')
      })

      const { issues } = await scope.loadScopedIssues(db, PROJECT)

      expect(issues.map((i) => i.key).sort()).toEqual([
        'FI0-1',
        'FI0-10',
        'FI0-3'
      ])
      expect(issues.every((i) => i.flow)).toBe(true)
    })

    test('Should return nothing when no PR references a key', async () => {
      await db.collection('jira-issues').insertOne(issue('FI0-1'))

      const { issues } = await scope.loadScopedIssues(db, PROJECT)

      expect(issues).toEqual([])
    })
  })

  describe('#deliveryUnitKey', () => {
    const byKey = new Map(
      [
        issue('FI0-1'),
        issue('FI0-2', { issueType: 'Bug' }),
        issue('FI0-3', {
          issueType: 'Sub-task',
          parentKey: 'FI0-1',
          parentIssueType: 'Story'
        }),
        issue('FI0-4', {
          issueType: 'Task',
          parentKey: 'FI0-5',
          parentIssueType: 'Epic'
        }),
        issue('FI0-5', { issueType: 'Epic' }),
        issue('FI0-6', {
          issueType: 'Sub-task',
          parentKey: 'FI0-7',
          parentIssueType: 'Story'
        })
      ].map((i) => [i.key, i])
    )

    test.each([
      ['a Story', 'FI0-1', 'FI0-1'],
      ['a Bug', 'FI0-2', 'FI0-2'],
      ['a Sub-task under a stored Story', 'FI0-3', 'FI0-1'],
      ['a Task under an Epic', 'FI0-4', null],
      ['a Sub-task whose parent is not stored', 'FI0-6', null]
    ])('Should resolve %s', (_name, key, expected) => {
      expect(scope.deliveryUnitKey(byKey.get(key), byKey)).toBe(expected)
    })
  })

  describe('#listProjectJiraIssues', () => {
    test('Should return each referenced issue with its flow and ISO dates', async () => {
      await db
        .collection('jira-issues')
        .insertMany([issue('FI0-5'), issue('FI0-9999')])
      await db.collection('payloads').insertOne({
        repository: 'DEFRA/r',
        prNumber: 1,
        projectSlug: 'FES',
        jiraKeys: ['FI0-5'],
        calculatedAt: new Date('2026-01-09')
      })

      const issues = await scope.listProjectJiraIssues(db, PROJECT)

      expect(issues).toHaveLength(1)
      expect(issues[0]).not.toHaveProperty('_id')
      expect(issues[0].flow).toMatchObject({
        stageKind: 'done',
        startedAt: '2026-07-02T09:00:00.000Z',
        doneAt: '2026-07-04T09:00:00.000Z',
        firstDoneAt: '2026-07-04T09:00:00.000Z',
        cycleDays: 2
      })
    })

    test('Should list the newest resolved first', async () => {
      await db
        .collection('jira-issues')
        .insertMany([
          issue('FI0-1', { resolved: new Date('2026-07-01T00:00:00Z') }),
          issue('FI0-2', { resolved: new Date('2026-07-09T00:00:00Z') })
        ])
      await db.collection('payloads').insertOne({
        repository: 'DEFRA/r',
        prNumber: 1,
        projectSlug: 'FES',
        jiraKeys: ['FI0-1', 'FI0-2'],
        calculatedAt: new Date('2026-01-09')
      })

      const issues = await scope.listProjectJiraIssues(db, PROJECT)

      expect(issues.map((i) => i.key)).toEqual(['FI0-2', 'FI0-1'])
    })
  })
})
