import { STAGE_IDS } from './workflow-stages.js'

const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() }
const SLUG = 'ALPH'
const actor = { oid: 'oid-1', name: 'A Person' }
const stages = [
  { id: 'todo', statuses: ['To Do'] },
  { id: 'done', statuses: ['Done'] }
]

describe('#jira-workflow service', () => {
  let server
  let db
  let saveProjectWorkflow
  let listProjectStatuses
  let detectProjectStatuses

  beforeAll(async () => {
    // Dynamic imports: config must be read after vitest-mongodb sets MONGO_URI
    ;({ saveProjectWorkflow, listProjectStatuses, detectProjectStatuses } =
      await import('./jira-workflow.js'))
    const { createServer } = await import('#/server.js')
    server = await createServer()
    await server.initialize()
    db = server.db
  })

  afterAll(async () => {
    await server.stop({ timeout: 1000 })
  })

  beforeEach(async () => {
    vi.clearAllMocks()
    await db.collection('projects').deleteMany({})
    await db.collection('jira-issues').deleteMany({})
    await db.collection('pr-jira-links').deleteMany({})
    await db.collection('projects').insertOne({
      slug: SLUG,
      archivedAt: null,
      jira: {
        projectKeys: ['ALPH'],
        storyPointsField: 'customfield_1',
        lastSyncedAt: new Date('2026-11-01T00:00:00Z')
      }
    })
  })

  const stored = () => db.collection('projects').findOne({ slug: SLUG })

  describe('#saveProjectWorkflow', () => {
    test('Should store every stage in catalogue order and keep other Jira fields', async () => {
      const { before, after } = await saveProjectWorkflow(
        db,
        SLUG,
        { version: 0, stages },
        actor
      )

      const { jira } = await stored()
      expect(before).toBeNull()
      expect(after.version).toBe(1)
      expect(jira.statusMapping.stages.map((s) => s.id)).toEqual(STAGE_IDS)
      expect(jira.statusMapping.stages[0].statuses).toEqual(['To Do'])
      expect(jira.statusMapping.updatedAt).toBeInstanceOf(Date)
      expect(jira.statusMapping.updatedBy).toEqual(actor)
      expect(jira.projectKeys).toEqual(['ALPH'])
      expect(jira.lastSyncedAt).toEqual(new Date('2026-11-01T00:00:00Z'))
    })

    test('Should accept version 0 once and reject a second first save', async () => {
      await saveProjectWorkflow(db, SLUG, { version: 0, stages }, actor)

      await expect(
        saveProjectWorkflow(db, SLUG, { version: 0, stages }, actor)
      ).rejects.toMatchObject({ output: { statusCode: 409 } })
    })

    test('Should save over the current version and return the previous one', async () => {
      await saveProjectWorkflow(db, SLUG, { version: 0, stages }, actor)

      const { before, after } = await saveProjectWorkflow(
        db,
        SLUG,
        { version: 1, stages },
        actor
      )

      expect(before.version).toBe(1)
      expect(after.version).toBe(2)
    })

    test('Should reject a stale version', async () => {
      await saveProjectWorkflow(db, SLUG, { version: 0, stages }, actor)

      await expect(
        saveProjectWorkflow(db, SLUG, { version: 5, stages }, actor)
      ).rejects.toMatchObject({
        output: {
          statusCode: 409,
          payload: {
            message:
              'The Jira workflow was changed by someone else. Reload to see the latest version.'
          }
        }
      })
    })

    test.each([
      ['archived', { $set: { archivedAt: new Date() } }],
      ['deleted', null]
    ])('Should answer 404 when the project was %s', async (_, update) => {
      const projects = db.collection('projects')
      if (update) await projects.updateOne({ slug: SLUG }, update)
      else await projects.deleteOne({ slug: SLUG })

      await expect(
        saveProjectWorkflow(db, SLUG, { version: 0, stages }, actor)
      ).rejects.toMatchObject({ output: { statusCode: 404 } })
    })
  })

  describe('#detectProjectStatuses', () => {
    const project = { slug: SLUG, jira: { projectKeys: ['ALPH', 'bad key'] } }

    test('Should return unique tidy names with their categories', async () => {
      const client = {
        getProjectStatuses: vi.fn(async () => [
          { name: ' To  Do ', categoryKey: 'new', issueType: 'Story' },
          { name: 'to do', categoryKey: 'new', issueType: 'Bug' },
          { name: 'Odd', categoryKey: null, issueType: 'Bug' },
          { name: 'x'.repeat(61), categoryKey: 'done', issueType: 'Bug' },
          { name: '', categoryKey: 'done', issueType: 'Bug' }
        ])
      }

      await expect(
        detectProjectStatuses(client, project, logger)
      ).resolves.toEqual([
        { name: 'To Do', categoryKey: 'new' },
        { name: 'Odd', categoryKey: null }
      ])
      expect(client.getProjectStatuses).toHaveBeenCalledTimes(1)
    })

    test('Should stop at 500 statuses', async () => {
      const client = {
        getProjectStatuses: async () =>
          Array.from({ length: 600 }, (_, i) => ({
            name: `S${i}`,
            categoryKey: 'new'
          }))
      }

      const detected = await detectProjectStatuses(client, project, logger)

      expect(detected).toHaveLength(500)
    })

    test('Should warn and return null when Jira fails', async () => {
      const client = {
        getProjectStatuses: vi.fn(async () => {
          throw new Error('Jira down')
        })
      }

      await expect(
        detectProjectStatuses(client, project, logger)
      ).resolves.toBeNull()
      expect(logger.warn).toHaveBeenCalledWith(
        { err: expect.any(Error) },
        `Could not detect Jira statuses for project ${SLUG}`
      )
    })
  })

  describe('#listProjectStatuses', () => {
    const configured = (getProjectStatuses) => ({
      isConfigured: () => true,
      getProjectStatuses
    })

    const linkIssues = (...keys) =>
      db.collection('pr-jira-links').insertMany(
        keys.map((jiraKey, i) => ({
          projectSlug: SLUG,
          jiraKey,
          repository: 'DEFRA/r',
          prNumber: i + 1
        }))
      )

    beforeEach(async () => {
      await linkIssues('ALPH-1', 'ALPH-2')
      await db.collection('jira-issues').insertMany([
        {
          key: 'ALPH-1',
          projectSlug: SLUG,
          status: { name: 'in dev', categoryKey: 'indeterminate' },
          statusHistory: [{ at: new Date(), from: 'Funnel', to: 'in dev' }]
        },
        {
          key: 'ALPH-2',
          projectSlug: SLUG,
          status: { name: 'in dev', categoryKey: 'indeterminate' },
          statusHistory: []
        },
        {
          key: 'OTHER-1',
          projectSlug: 'OTHR',
          status: { name: 'Elsewhere', categoryKey: 'new' }
        }
      ])
    })

    test('Should merge stored, detected and live statuses preferring Jira names', async () => {
      const project = {
        slug: SLUG,
        jira: {
          projectKeys: ['ALPH'],
          detectedStatuses: [{ name: 'Parked', categoryKey: 'indeterminate' }]
        }
      }
      const client = configured(async () => [
        { name: 'In Dev', categoryKey: 'indeterminate', issueType: 'Story' },
        { name: 'In Dev', categoryKey: 'indeterminate', issueType: 'Bug' },
        { name: 'Done', categoryKey: 'done', issueType: 'Story' }
      ])

      const result = await listProjectStatuses(db, project, client, logger)

      expect(result).toEqual({
        jiraConfigured: true,
        jiraAvailable: true,
        statuses: [
          {
            name: 'In Dev',
            categoryKey: 'indeterminate',
            issueTypes: ['Bug', 'Story'],
            inJira: true,
            issueCount: 2
          },
          {
            name: 'Parked',
            categoryKey: 'indeterminate',
            issueTypes: [],
            inJira: true,
            issueCount: 0
          },
          {
            name: 'Done',
            categoryKey: 'done',
            issueTypes: ['Story'],
            inJira: true,
            issueCount: 0
          },
          {
            name: 'Funnel',
            categoryKey: null,
            issueTypes: [],
            inJira: false,
            issueCount: 0
          }
        ]
      })
    })

    test('Should fall back to stored statuses when Jira cannot be reached', async () => {
      const client = configured(async () => {
        throw new Error('Jira down')
      })

      const result = await listProjectStatuses(
        db,
        { slug: SLUG, jira: { projectKeys: ['ALPH'] } },
        client,
        logger
      )

      expect(result.jiraConfigured).toBe(true)
      expect(result.jiraAvailable).toBe(false)
      expect(result.statuses.map((s) => s.name)).toEqual(['in dev', 'Funnel'])
      expect(logger.warn).toHaveBeenCalledWith(
        { err: expect.any(Error) },
        'Jira project statuses unavailable'
      )
    })

    test('Should drop a status name longer than the saveable maximum', async () => {
      const tooLong = 'x'.repeat(61)
      await linkIssues('ALPH-3')
      await db.collection('jira-issues').insertOne({
        key: 'ALPH-3',
        projectSlug: SLUG,
        status: { name: tooLong, categoryKey: 'new' },
        statusHistory: [{ at: new Date(), from: tooLong, to: 'in dev' }]
      })
      const client = configured(async () => [
        { name: tooLong, categoryKey: 'done', issueType: 'Story' }
      ])

      const result = await listProjectStatuses(
        db,
        { slug: SLUG, jira: { projectKeys: ['ALPH'] } },
        client,
        logger
      )

      expect(result.statuses.map((s) => s.name)).toEqual(['in dev', 'Funnel'])
    })

    test('Should not call Jira when it is not configured', async () => {
      const getProjectStatuses = vi.fn()

      const result = await listProjectStatuses(
        db,
        { slug: SLUG, jira: { projectKeys: ['ALPH'] } },
        { isConfigured: () => false, getProjectStatuses },
        logger
      )

      expect(result).toMatchObject({
        jiraConfigured: false,
        jiraAvailable: false
      })
      expect(result.statuses[0]).toMatchObject({
        name: 'in dev',
        categoryKey: 'indeterminate',
        issueCount: 2,
        inJira: false
      })
      expect(getProjectStatuses).not.toHaveBeenCalled()
    })
  })
})
