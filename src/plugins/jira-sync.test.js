const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() }
const JIRA_ISSUES_COLLECTION = 'jira-issues'
const PROJECTS_COLLECTION = 'projects'

describe('#jira-sync', () => {
  let server
  let db
  let runJiraSync
  let fetchUnknownJiraIssues
  let captureSprintScope

  beforeAll(async () => {
    // Dynamic imports: config must be read after vitest-mongodb sets MONGO_URI
    ;({ runJiraSync, fetchUnknownJiraIssues } = await import('./jira-sync.js'))
    ;({ captureSprintScope } = await import('#/services/jira-project-sync.js'))
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
    await db.collection(PROJECTS_COLLECTION).deleteMany({})
    await db.collection(JIRA_ISSUES_COLLECTION).deleteMany({})
    await db.collection('mongo-locks').deleteMany({})
  })

  describe('#runJiraSync', () => {
    const fakeClient = () => ({
      syncProjectIssues: vi.fn(async () => ({ synced: 2 }))
    })

    test('Should sync only active projects with Jira keys and record the run', async () => {
      const lastSyncedAt = new Date('2026-03-01T10:00:00Z')
      await db.collection(PROJECTS_COLLECTION).insertMany([
        {
          slug: 'live',
          archivedAt: null,
          jira: {
            projectKeys: ['MMO'],
            storyPointsField: 'customfield_1',
            lastSyncedAt
          }
        },
        { slug: 'nokeys', archivedAt: null, jira: { projectKeys: [] } },
        {
          slug: 'gone',
          archivedAt: new Date(),
          jira: { projectKeys: ['OLD'] }
        }
      ])
      await db
        .collection(JIRA_ISSUES_COLLECTION)
        .insertOne({ key: 'MMO-1', projectSlug: 'live' })
      const client = fakeClient()

      const result = await runJiraSync({
        db,
        locker: server.locker,
        client,
        logger
      })

      expect(result).toEqual({ synced: 2, projects: 1 })
      expect(client.syncProjectIssues).toHaveBeenCalledTimes(1)
      expect(client.syncProjectIssues).toHaveBeenCalledWith(
        db,
        'live',
        ['MMO'],
        'customfield_1',
        { updatedSince: new Date('2026-03-01T09:45:00Z') }
      )
      const project = await db
        .collection(PROJECTS_COLLECTION)
        .findOne({ slug: 'live' })
      expect(project.jira.lastSyncedAt.getTime()).toBeGreaterThan(
        lastSyncedAt.getTime()
      )
    })

    test('Should do a full sync when the project has never been synced', async () => {
      await db.collection(PROJECTS_COLLECTION).insertOne({
        slug: 'new',
        archivedAt: null,
        jira: { projectKeys: ['N'] }
      })
      const client = fakeClient()

      await runJiraSync({ db, locker: server.locker, client, logger })

      expect(client.syncProjectIssues.mock.calls[0][4]).toEqual({})
    })

    test('Should do a full sync when a synced project has no issues stored', async () => {
      await db.collection(PROJECTS_COLLECTION).insertOne({
        slug: 'empty',
        archivedAt: null,
        jira: {
          projectKeys: ['E'],
          lastSyncedAt: new Date('2026-03-01T10:00:00Z')
        }
      })
      await db
        .collection(JIRA_ISSUES_COLLECTION)
        .insertOne({ key: 'X-1', projectSlug: 'other' })
      const client = fakeClient()

      await runJiraSync({ db, locker: server.locker, client, logger })

      expect(client.syncProjectIssues.mock.calls[0][4]).toEqual({})
    })

    test('Should keep lastSyncedAt when a project sync fails', async () => {
      await db.collection(PROJECTS_COLLECTION).insertOne({
        slug: 'bad',
        archivedAt: null,
        jira: { projectKeys: ['B'] }
      })
      const client = {
        syncProjectIssues: vi.fn(async () => {
          throw new Error('Jira down')
        })
      }

      await runJiraSync({ db, locker: server.locker, client, logger })

      const project = await db
        .collection(PROJECTS_COLLECTION)
        .findOne({ slug: 'bad' })
      expect(project.jira.lastSyncedAt).toBeUndefined()
      expect(logger.error).toHaveBeenCalled()
    })

    describe('Status detection', () => {
      const previous = [{ name: 'Old', categoryKey: 'new' }]

      beforeEach(async () => {
        await db.collection(PROJECTS_COLLECTION).insertOne({
          slug: 'live',
          archivedAt: null,
          jira: { projectKeys: ['MMO'], detectedStatuses: previous }
        })
      })

      const stored = () =>
        db.collection(PROJECTS_COLLECTION).findOne({ slug: 'live' })

      test('Should store the Jira statuses detected for the project key', async () => {
        const client = {
          syncProjectIssues: vi.fn(async () => ({ synced: 1 })),
          getProjectStatuses: vi.fn(async () => [
            { name: 'To Do', categoryKey: 'new', issueType: 'Story' },
            { name: 'Shipped', categoryKey: 'done', issueType: 'Story' }
          ])
        }

        await runJiraSync({ db, locker: server.locker, client, logger })

        const { jira } = await stored()
        expect(client.getProjectStatuses).toHaveBeenCalledWith('MMO')
        expect(jira.detectedStatuses).toEqual([
          { name: 'To Do', categoryKey: 'new' },
          { name: 'Shipped', categoryKey: 'done' }
        ])
        expect(jira.lastSyncedAt).toBeInstanceOf(Date)
      })

      test('Should finish the sync and keep earlier statuses when detection fails', async () => {
        const client = {
          syncProjectIssues: vi.fn(async () => ({ synced: 1 })),
          getProjectStatuses: vi.fn(async () => {
            throw new Error('Jira down')
          })
        }

        const result = await runJiraSync({
          db,
          locker: server.locker,
          client,
          logger
        })

        const { jira } = await stored()
        expect(result).toEqual({ synced: 1, projects: 1 })
        expect(jira.detectedStatuses).toEqual(previous)
        expect(jira.lastSyncedAt).toBeInstanceOf(Date)
        expect(logger.warn).toHaveBeenCalled()
        expect(logger.error).not.toHaveBeenCalled()
      })

      test('Should keep earlier statuses and warn when Jira returns none', async () => {
        const client = {
          syncProjectIssues: vi.fn(async () => ({ synced: 1 })),
          getProjectStatuses: vi.fn(async () => [])
        }

        await runJiraSync({ db, locker: server.locker, client, logger })

        const { jira } = await stored()
        expect(jira.detectedStatuses).toEqual(previous)
        expect(jira.lastSyncedAt).toBeInstanceOf(Date)
        expect(logger.warn).toHaveBeenCalledWith(
          'Jira returned no statuses for project live'
        )
      })
    })

    test('Should skip when another instance holds the lock', async () => {
      const held = await server.locker.lock('jira-sync')
      const client = fakeClient()

      const result = await runJiraSync({
        db,
        locker: server.locker,
        client,
        logger
      })

      expect(result).toEqual({ skipped: true })
      expect(client.syncProjectIssues).not.toHaveBeenCalled()
      await held.free()
    })
  })

  describe('#captureSprintScope', () => {
    test('Should store the scope of an active sprint only once', async () => {
      await db.collection('jira-sprint-scope').deleteMany({})
      const client = {
        getBoardSprints: vi.fn(async () => [
          { id: 11, state: 'closed', name: 'Old' },
          {
            id: 12,
            state: 'active',
            name: 'Now',
            startDate: '2026-07-15T09:00:00Z'
          }
        ]),
        searchIssues: vi
          .fn()
          .mockResolvedValueOnce({
            issues: [{ key: 'MMO-1' }],
            isLast: false,
            nextPageToken: 't'
          })
          .mockResolvedValueOnce({ issues: [{ key: 'MMO-2' }], isLast: true })
      }
      const project = { slug: 'p', jira: { boardId: 3 } }

      await captureSprintScope({ db, client, project })
      await captureSprintScope({ db, client, project })

      const docs = await db.collection('jira-sprint-scope').find({}).toArray()
      expect(docs).toHaveLength(1)
      expect(docs[0]).toMatchObject({
        sprintId: 12,
        projectSlug: 'p',
        issueKeys: ['MMO-1', 'MMO-2']
      })
      expect(client.searchIssues).toHaveBeenCalledTimes(2)
      expect(client.searchIssues.mock.calls[0][0]).toBe('sprint = 12')
    })
  })

  describe('#fetchUnknownJiraIssues', () => {
    const client = () => ({
      isConfigured: () => true,
      syncIssuesByKey: vi.fn(async () => ({ synced: 1 }))
    })

    test('Should fetch only keys not already stored', async () => {
      await db
        .collection(JIRA_ISSUES_COLLECTION)
        .insertOne({ key: 'MMO-1', projectSlug: 'p' })
      const jira = client()

      await fetchUnknownJiraIssues({
        db,
        client: jira,
        projectSlug: 'p',
        jiraKeys: ['MMO-1', 'MMO-2'],
        logger
      })

      expect(jira.syncIssuesByKey).toHaveBeenCalledWith(db, 'p', ['MMO-2'])
    })

    test('Should do nothing when every key is known or there is no project', async () => {
      await db
        .collection(JIRA_ISSUES_COLLECTION)
        .insertOne({ key: 'MMO-1', projectSlug: 'p' })
      const jira = client()

      await fetchUnknownJiraIssues({
        db,
        client: jira,
        projectSlug: 'p',
        jiraKeys: ['MMO-1'],
        logger
      })
      await fetchUnknownJiraIssues({
        db,
        client: jira,
        projectSlug: null,
        jiraKeys: ['MMO-9'],
        logger
      })

      expect(jira.syncIssuesByKey).not.toHaveBeenCalled()
    })

    test('Should log and swallow a Jira failure', async () => {
      const jira = {
        isConfigured: () => true,
        syncIssuesByKey: vi.fn(async () => {
          throw new Error('timeout')
        })
      }

      await expect(
        fetchUnknownJiraIssues({
          db,
          client: jira,
          projectSlug: 'p',
          jiraKeys: ['MMO-3'],
          logger
        })
      ).resolves.toBeUndefined()
      expect(logger.warn).toHaveBeenCalled()
    })
  })
})
