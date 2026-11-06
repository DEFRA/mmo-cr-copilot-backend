import {
  grantAccess,
  ADMIN,
  OUTSIDER,
  PROJECT_ADMIN,
  PROJECT_USER,
  asUser
} from '#/test-helpers/auth-headers.js'

const url = (slug = 'ALPH', resource = 'workflow') =>
  `/api/projects/${slug}/jira/${resource}`

const stages = (overrides = {}) =>
  Object.entries({
    todo: ['To Do'],
    'in-progress': ['In Progress'],
    done: ['Done'],
    ...overrides
  }).map(([id, statuses]) => ({ id, statuses }))

describe('#jira-workflow routes', () => {
  let server
  let db
  let admin
  let projectAdmin
  let projectUser
  let outsider

  beforeAll(async () => {
    // Dynamic import needed due to config being updated by vitest-mongodb
    const { createServer } = await import('#/server.js')
    server = await createServer()
    await server.initialize()
    db = server.db
    ;[admin, projectAdmin, projectUser, outsider] = [
      ADMIN,
      PROJECT_ADMIN,
      PROJECT_USER,
      OUTSIDER
    ].map(asUser)
  })

  afterAll(async () => {
    await server.stop({ timeout: 1000 })
  })

  beforeEach(async () => {
    for (const name of ['projects', 'audit-logs', 'jira-issues']) {
      await db.collection(name).deleteMany({})
    }
    await db.collection('projects').insertMany([
      {
        slug: 'ALPH',
        name: 'Alpha',
        type: 'ai-adopted',
        archivedAt: null,
        jira: { projectKeys: ['ALPH'] }
      },
      {
        slug: 'BETA',
        name: 'Beta',
        type: 'ai-adopted',
        archivedAt: null,
        jira: { projectKeys: [] }
      }
    ])
    await db.collection('role_mappings').deleteMany({})
    await grantAccess(db, 'ALPH')
    await grantAccess(db, 'BETA')
  })

  const get = (headers, slug, resource) =>
    server.inject({ url: url(slug, resource), headers })
  const put = (headers, payload, slug = 'ALPH') =>
    server.inject({ method: 'PUT', url: url(slug), headers, payload })

  describe('GET /jira/workflow', () => {
    test('Should return the default workflow with suggestions to a project admin', async () => {
      const { statusCode, result } = await get(projectAdmin)

      expect(statusCode).toBe(200)
      expect(result).toMatchObject({
        source: 'default',
        version: 0,
        updatedAt: null,
        updatedBy: null,
        detectedAt: null,
        detectedCount: 0
      })
      expect(result.stages).toHaveLength(10)
      expect(result.stages[0]).toMatchObject({
        id: 'todo',
        label: 'To Do',
        kind: 'todo',
        required: true
      })
      expect(result.suggestions.todo).toContain('Backlog')
    })

    test('Should report statuses detected at the last sync', async () => {
      await db.collection('projects').updateOne(
        { slug: 'ALPH' },
        {
          $set: {
            'jira.lastSyncedAt': new Date('2026-11-05T08:00:00Z'),
            'jira.detectedStatuses': [
              { name: 'Funnel', categoryKey: 'new' },
              { name: 'Done', categoryKey: 'done' }
            ]
          }
        }
      )

      const { result } = await get(admin)

      expect(result).toMatchObject({
        source: 'detected',
        version: 0,
        detectedAt: '2026-11-05T08:00:00.000Z',
        detectedCount: 2
      })
      expect(result.stages[0].statuses).toEqual(['Funnel'])
    })

    test('Should hide the workflow from a project user', async () => {
      expect((await get(projectUser)).statusCode).toBe(403)
    })

    test('Should answer 404 to a caller with no role on the project', async () => {
      expect((await get(outsider)).statusCode).toBe(404)
    })

    test('Should refuse a project with no Jira key', async () => {
      const { statusCode, result } = await get(admin, 'BETA')

      expect(statusCode).toBe(422)
      expect(result.message).toBe('Project has no Jira project key')
    })
  })

  describe('PUT /jira/workflow', () => {
    test('Should save a project admin’s workflow and audit it', async () => {
      const { statusCode, result } = await put(projectAdmin, {
        version: 0,
        stages: stages()
      })

      expect(statusCode).toBe(200)
      expect(result).toMatchObject({
        source: 'project',
        version: 1,
        updatedBy: { name: PROJECT_ADMIN.name }
      })
      expect(result.updatedAt).toEqual(expect.any(String))
      const audit = await db
        .collection('audit-logs')
        .findOne({ action: 'jira-workflow.updated' })
      expect(audit).toMatchObject({
        entity: 'jira-workflow',
        entityId: 'ALPH',
        projectSlug: 'ALPH',
        summary: 'Jira workflow for ALPH changed to version 1',
        before: null
      })
      expect(audit.after.stages).toHaveLength(10)
    })

    test('Should let a dashboard admin save', async () => {
      const { statusCode } = await put(admin, { version: 0, stages: stages() })

      expect(statusCode).toBe(200)
    })

    test('Should refuse a project user and an outsider', async () => {
      const payload = { version: 0, stages: stages() }

      expect((await put(projectUser, payload)).statusCode).toBe(403)
      expect((await put(outsider, payload)).statusCode).toBe(404)
    })

    test('Should refuse a project with no Jira key', async () => {
      expect(
        (await put(admin, { version: 0, stages: stages() }, 'BETA')).statusCode
      ).toBe(422)
    })

    test('Should reject a stale version', async () => {
      await put(admin, { version: 0, stages: stages() })

      const { statusCode, result } = await put(admin, {
        version: 0,
        stages: stages()
      })

      expect(statusCode).toBe(409)
      expect(result.message).toBe(
        'The Jira workflow was changed by someone else. Reload to see the latest version.'
      )
    })

    test('Should reject a version newer than the stored one', async () => {
      await put(admin, { version: 0, stages: stages() })

      const { statusCode } = await put(admin, { version: 7, stages: stages() })

      expect(statusCode).toBe(409)
    })

    test('Should reject a workflow without a Done status', async () => {
      const { statusCode, result } = await put(admin, {
        version: 0,
        stages: stages({ done: [] })
      })

      expect(statusCode).toBe(400)
      expect(result.message).toBe('Done needs at least one status')
    })

    test('Should apply the saved workflow to delivery metrics and Jira issues', async () => {
      await db.collection('jira-issues').insertOne({
        key: 'ALPH-1',
        projectSlug: 'ALPH',
        status: { name: 'Shipped', categoryKey: 'indeterminate' },
        created: new Date('2026-10-01T09:00:00Z'),
        statusHistory: [
          {
            at: new Date('2026-10-02T09:00:00Z'),
            from: 'To Do',
            to: 'In Progress'
          },
          {
            at: new Date('2026-10-04T09:00:00Z'),
            from: 'In Progress',
            to: 'Shipped'
          }
        ]
      })
      await put(admin, {
        version: 0,
        stages: stages({ done: ['Shipped'] })
      })

      const metrics = await server.inject({
        url: '/api/projects/ALPH/delivery-metrics',
        headers: projectUser
      })
      const issues = await server.inject({
        url: '/api/projects/ALPH/jira-issues',
        headers: projectUser
      })

      expect(metrics.result.workflow).toEqual({
        source: 'project',
        version: 1,
        unmappedStatuses: []
      })
      expect(metrics.result.storiesDelivered).toBe(1)
      expect(issues.result.issues[0].flow).toMatchObject({
        stageId: 'done',
        stageKind: 'done',
        doneAt: '2026-10-04T09:00:00.000Z',
        cycleDays: 2
      })
    })
  })

  describe('When the project is archived', () => {
    beforeEach(async () => {
      await db
        .collection('projects')
        .updateOne({ slug: 'ALPH' }, { $set: { archivedAt: new Date() } })
    })

    test('Should answer 404 to every workflow route', async () => {
      expect((await get(admin)).statusCode).toBe(404)
      expect((await get(admin, 'ALPH', 'statuses')).statusCode).toBe(404)
      expect(
        (await put(admin, { version: 0, stages: stages() })).statusCode
      ).toBe(404)
    })
  })

  describe('GET /jira/statuses', () => {
    afterEach(() => {
      vi.restoreAllMocks()
    })

    test('Should merge live Jira statuses when Jira is configured', async () => {
      vi.spyOn(server.jira, 'isConfigured').mockReturnValue(true)
      const getProjectStatuses = vi
        .spyOn(server.jira, 'getProjectStatuses')
        .mockResolvedValue([
          { name: 'Doing', categoryKey: 'indeterminate', issueType: 'Story' }
        ])

      const { statusCode, result } = await get(admin, 'ALPH', 'statuses')

      expect(statusCode).toBe(200)
      expect(getProjectStatuses).toHaveBeenCalledWith('ALPH')
      expect(result).toEqual({
        jiraConfigured: true,
        jiraAvailable: true,
        statuses: [
          {
            name: 'Doing',
            categoryKey: 'indeterminate',
            issueTypes: ['Story'],
            inJira: true,
            issueCount: 0
          }
        ]
      })
    })

    test('Should report Jira as unavailable when the call fails', async () => {
      vi.spyOn(server.jira, 'isConfigured').mockReturnValue(true)
      vi.spyOn(server.jira, 'getProjectStatuses').mockRejectedValue(
        new Error('Jira down')
      )

      const { statusCode, result } = await get(admin, 'ALPH', 'statuses')

      expect(statusCode).toBe(200)
      expect(result).toEqual({
        jiraConfigured: true,
        jiraAvailable: false,
        statuses: []
      })
    })

    test('Should list stored statuses when Jira is not configured', async () => {
      await db.collection('jira-issues').insertOne({
        key: 'ALPH-1',
        projectSlug: 'ALPH',
        status: { name: 'In Progress', categoryKey: 'indeterminate' }
      })

      const { statusCode, result } = await get(projectAdmin, 'ALPH', 'statuses')

      expect(statusCode).toBe(200)
      expect(result).toEqual({
        jiraConfigured: false,
        jiraAvailable: false,
        statuses: [
          {
            name: 'In Progress',
            categoryKey: 'indeterminate',
            issueTypes: [],
            inJira: false,
            issueCount: 1
          }
        ]
      })
    })

    test('Should apply the same role and Jira key rules', async () => {
      expect((await get(projectUser, 'ALPH', 'statuses')).statusCode).toBe(403)
      expect((await get(outsider, 'ALPH', 'statuses')).statusCode).toBe(404)
      expect((await get(admin, 'BETA', 'statuses')).statusCode).toBe(422)
    })
  })
})
