const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() }
const NOW = new Date('2026-06-01T12:00:00Z')
const MINUTE = 60 * 1000
const HOUR = 60 * MINUTE
const ago = (ms) => new Date(NOW.getTime() - ms)

const storedIssue = (key, overrides = {}) => ({
  key,
  projectSlug: 'FES',
  issueType: 'Story',
  status: { name: 'In Progress', categoryKey: 'indeterminate' },
  created: ago(48 * HOUR),
  statusHistory: [],
  storyPointsField: 'customfield_10028',
  fetchedAt: ago(HOUR),
  ...overrides
})

const doneIssue = (key, overrides = {}) =>
  storedIssue(key, {
    status: { name: 'Done', categoryKey: 'done' },
    resolved: ago(24 * HOUR),
    statusHistory: [
      { at: ago(30 * HOUR), from: 'To Do', to: 'In Progress' },
      { at: ago(24 * HOUR), from: 'In Progress', to: 'Done' }
    ],
    ...overrides
  })

// Stores each requested key as an open Story, as a real fetch would.
const storeRequested = async (
  db,
  { projectSlug, issueKeys, storyPointsField },
  extra = {}
) => {
  await db.collection('jira-issues').bulkWrite(
    issueKeys.map((key) => ({
      updateOne: {
        filter: { key },
        update: {
          $set: storedIssue(key, {
            projectSlug,
            storyPointsField,
            fetchedAt: new Date(),
            ...extra[key]
          })
        },
        upsert: true
      }
    }))
  )
}

const fakeClient = (over = {}) => ({
  isConfigured: () => true,
  getStoryPointsFieldId: vi.fn(async () => 'customfield_10028'),
  getProjectStatuses: vi.fn(async () => [
    { name: 'Done', categoryKey: 'done' }
  ]),
  getBoardSprints: vi.fn(async () => []),
  searchIssues: vi.fn(async () => ({ issues: [], isLast: true })),
  fetchIssuesByKey: vi.fn(async (db, options) => {
    await storeRequested(db, options)
    return { fetched: options.issueKeys, unresolved: [] }
  }),
  ...over
})

describe('#jira-lazy-fetch', () => {
  let server
  let db
  let lazy
  let JiraAccessError

  beforeAll(async () => {
    // Dynamic imports: config must be read after vitest-mongodb sets MONGO_URI
    lazy = await import('./jira-lazy-fetch.js')
    ;({ JiraAccessError } = await import('#/services/jira.js'))
    const { createServer } = await import('#/server.js')
    server = await createServer()
    await server.initialize()
    db = server.db
  })

  afterAll(async () => {
    await lazy.settleJiraRefreshes()
    await server.stop({ timeout: 1000 })
  })

  beforeEach(async () => {
    vi.clearAllMocks()
    for (const name of [
      'projects',
      'jira-issues',
      'pr-jira-links',
      'payloads',
      'jira-unresolved-keys',
      'jira-sprint-scope'
    ]) {
      await db.collection(name).deleteMany({})
    }
    await db.collection('projects').insertOne({
      slug: 'FES',
      archivedAt: null,
      jira: { projectKeys: ['FI0'] }
    })
  })

  const loadProject = (slug = 'FES') =>
    db.collection('projects').findOne({ slug })

  const inWindowPayload = (prNumber, jiraKeys) => ({
    repository: 'DEFRA/r',
    prNumber,
    projectSlug: 'FES',
    jiraKeys,
    calculatedAt: new Date('2026-01-09T09:00:00Z'),
    commitBreakdown: [{ committedAt: new Date('2026-01-09T09:00:00Z') }]
  })

  const WINDOW = { from: '2026-01-01T00:00:00Z', to: '2026-02-01T00:00:00Z' }

  describe('#planIssueRefresh', () => {
    const base = {
      windowKeys: [],
      otherKeys: [],
      docsByKey: new Map(),
      doneKeys: new Set(),
      unresolved: new Set(),
      storyPointsField: 'customfield_10028',
      now: NOW,
      freshMs: 15 * MINUTE,
      maxKeys: 300
    }
    const docs = (...list) => new Map(list.map((doc) => [doc.key, doc]))

    test('Should order the four tiers by urgency', () => {
      const plan = lazy.planIssueRefresh({
        ...base,
        windowKeys: ['FI0-2', 'FI0-1'],
        otherKeys: ['FI0-4', 'FI0-3'],
        docsByKey: docs(storedIssue('FI0-2'), storedIssue('FI0-3'))
      })

      expect(plan).toEqual(['FI0-1', 'FI0-2', 'FI0-3', 'FI0-4'])
    })

    test('Should skip unresolved keys', () => {
      const plan = lazy.planIssueRefresh({
        ...base,
        windowKeys: ['FI0-1', 'FI0-2'],
        unresolved: new Set(['FI0-1'])
      })

      expect(plan).toEqual(['FI0-2'])
    })

    test('Should not refetch a Done doc fetched an hour ago', () => {
      const plan = lazy.planIssueRefresh({
        ...base,
        windowKeys: ['FI0-1'],
        docsByKey: docs(doneIssue('FI0-1')),
        doneKeys: new Set(['FI0-1'])
      })

      expect(plan).toEqual([])
    })

    test('Should refetch an open doc older than the freshness window', () => {
      const plan = lazy.planIssueRefresh({
        ...base,
        windowKeys: ['FI0-1'],
        docsByKey: docs(storedIssue('FI0-1'))
      })

      expect(plan).toEqual(['FI0-1'])
    })

    test('Should not refetch an open doc inside the freshness window', () => {
      const plan = lazy.planIssueRefresh({
        ...base,
        windowKeys: ['FI0-1'],
        docsByKey: docs(storedIssue('FI0-1', { fetchedAt: ago(MINUTE) }))
      })

      expect(plan).toEqual([])
    })

    test('Should refetch a legacy doc with no fetchedAt even when Done', () => {
      const { fetchedAt, ...legacy } = doneIssue('FI0-1')
      const plan = lazy.planIssueRefresh({
        ...base,
        windowKeys: ['FI0-1'],
        docsByKey: docs(legacy),
        doneKeys: new Set(['FI0-1'])
      })

      expect(fetchedAt).toBeInstanceOf(Date)
      expect(plan).toEqual(['FI0-1'])
    })

    test('Should refetch a Done doc fetched with a different story points field', () => {
      const plan = lazy.planIssueRefresh({
        ...base,
        windowKeys: ['FI0-1'],
        docsByKey: docs(
          doneIssue('FI0-1', { storyPointsField: 'customfield_1' })
        ),
        doneKeys: new Set(['FI0-1'])
      })

      expect(plan).toEqual(['FI0-1'])
    })

    test('Should cap the plan at maxKeys', () => {
      const plan = lazy.planIssueRefresh({
        ...base,
        windowKeys: ['FI0-1', 'FI0-2', 'FI0-3'],
        maxKeys: 2
      })

      expect(plan).toEqual(['FI0-1', 'FI0-2'])
    })
  })

  describe('#resolveStoryPointsField', () => {
    test('Should detect the field and persist it with its source and time', async () => {
      const client = fakeClient()

      const field = await lazy.resolveStoryPointsField({
        db,
        client,
        project: await loadProject(),
        logger,
        now: NOW
      })

      expect(field).toBe('customfield_10028')
      expect((await loadProject()).jira).toMatchObject({
        storyPointsField: 'customfield_10028',
        storyPointsFieldSource: 'detected',
        storyPointsFieldDetectedAt: NOW
      })
    })

    test('Should return the admin field without asking Jira', async () => {
      const client = fakeClient()

      const field = await lazy.resolveStoryPointsField({
        db,
        client,
        project: {
          slug: 'FES',
          jira: {
            storyPointsField: 'customfield_7',
            storyPointsFieldSource: 'admin'
          }
        },
        logger
      })

      expect(field).toBe('customfield_7')
      expect(client.getStoryPointsFieldId).not.toHaveBeenCalled()
    })

    test('Should not detect again within 24 hours', async () => {
      const client = fakeClient()

      const field = await lazy.resolveStoryPointsField({
        db,
        client,
        project: {
          slug: 'FES',
          jira: {
            storyPointsField: 'customfield_9',
            storyPointsFieldSource: 'detected',
            storyPointsFieldDetectedAt: ago(HOUR)
          }
        },
        logger,
        now: NOW
      })

      expect(field).toBe('customfield_9')
      expect(client.getStoryPointsFieldId).not.toHaveBeenCalled()
    })

    test('Should detect again after 24 hours', async () => {
      const client = fakeClient()

      await lazy.resolveStoryPointsField({
        db,
        client,
        project: {
          slug: 'FES',
          jira: { storyPointsFieldDetectedAt: ago(25 * HOUR) }
        },
        logger,
        now: NOW
      })

      expect(client.getStoryPointsFieldId).toHaveBeenCalledTimes(1)
    })

    test('Should keep the stored field and warn when Jira fails', async () => {
      const client = fakeClient({
        getStoryPointsFieldId: vi.fn(async () => {
          throw new Error('boom')
        })
      })

      const field = await lazy.resolveStoryPointsField({
        db,
        client,
        project: { slug: 'FES', jira: { storyPointsField: 'customfield_9' } },
        logger,
        now: NOW
      })

      expect(field).toBe('customfield_9')
      expect(logger.warn).toHaveBeenCalled()
    })

    test('Should warn and report null when Jira has no such field', async () => {
      const client = fakeClient({
        getStoryPointsFieldId: vi.fn(async () => null)
      })

      const field = await lazy.resolveStoryPointsField({
        db,
        client,
        project: await loadProject(),
        logger,
        now: NOW
      })

      expect(field).toBeNull()
      expect(logger.warn).toHaveBeenCalled()
    })

    test('Should not overwrite an admin choice made during detection', async () => {
      await db.collection('projects').updateOne(
        { slug: 'FES' },
        {
          $set: {
            'jira.storyPointsField': 'customfield_7',
            'jira.storyPointsFieldSource': 'admin'
          }
        }
      )

      await lazy.resolveStoryPointsField({
        db,
        client: fakeClient(),
        project: { slug: 'FES', jira: {} },
        logger,
        now: NOW
      })

      expect((await loadProject()).jira.storyPointsField).toBe('customfield_7')
    })
  })

  describe('#refreshJiraWindow', () => {
    const refresh = async (client, extra = {}) =>
      lazy.refreshJiraWindow({
        db,
        client,
        project: await loadProject(),
        ...WINDOW,
        logger,
        now: NOW,
        ...extra
      })

    beforeEach(async () => {
      await db
        .collection('payloads')
        .insertOne(inWindowPayload(1, ['FI0-1', 'ABC-9']))
      await db.collection('pr-jira-links').insertOne({
        projectSlug: 'FES',
        jiraKey: 'FI0-2',
        repository: 'DEFRA/r',
        prNumber: 2
      })
    })

    test('Should fetch missing keys the window references first, in the project only', async () => {
      const client = fakeClient()

      await refresh(client)

      expect(client.fetchIssuesByKey).toHaveBeenCalledTimes(1)
      expect(client.fetchIssuesByKey).toHaveBeenCalledWith(
        db,
        expect.objectContaining({
          projectSlug: 'FES',
          projectKeys: ['FI0'],
          issueKeys: ['FI0-1', 'FI0-2'],
          storyPointsField: 'customfield_10028'
        })
      )
    })

    test('Should fetch a Story parent but not an Epic parent', async () => {
      const client = fakeClient({
        fetchIssuesByKey: vi.fn(async (database, options) => {
          await storeRequested(database, options, {
            'FI0-1': { parentKey: 'FI0-10', parentIssueType: 'Story' },
            'FI0-2': { parentKey: 'FI0-50', parentIssueType: 'Epic' }
          })
          return { fetched: options.issueKeys, unresolved: [] }
        })
      })

      const result = await refresh(client)

      expect(client.fetchIssuesByKey).toHaveBeenCalledTimes(2)
      expect(client.fetchIssuesByKey.mock.calls[1][1].issueKeys).toEqual([
        'FI0-10'
      ])
      expect(result.fetched).toBe(3)
    })

    test('Should not refetch a Done issue fetched recently', async () => {
      await db
        .collection('jira-issues')
        .insertMany([doneIssue('FI0-1'), doneIssue('FI0-2')])
      const client = fakeClient()

      await refresh(client)

      expect(client.fetchIssuesByKey).not.toHaveBeenCalled()
    })

    test('Should refetch an open issue whose copy is stale', async () => {
      await db
        .collection('jira-issues')
        .insertMany([doneIssue('FI0-1'), storedIssue('FI0-2')])
      const client = fakeClient()

      await refresh(client)

      expect(client.fetchIssuesByKey.mock.calls[0][1].issueKeys).toEqual([
        'FI0-2'
      ])
    })

    test('Should record unresolved keys and skip them next time', async () => {
      const client = fakeClient({
        fetchIssuesByKey: vi.fn(async () => ({
          fetched: [],
          unresolved: ['FI0-1', 'FI0-2']
        }))
      })

      await refresh(client)
      await refresh(client)

      const recorded = await db
        .collection('jira-unresolved-keys')
        .find({})
        .toArray()
      expect(recorded.map((doc) => doc.key).sort()).toEqual(['FI0-1', 'FI0-2'])
      expect(client.fetchIssuesByKey).toHaveBeenCalledTimes(1)
    })

    test('Should not fetch a key another request already has in flight', async () => {
      let release
      const gate = new Promise((resolve) => {
        release = resolve
      })
      const slow = fakeClient({
        fetchIssuesByKey: vi.fn(async (database, options) => {
          await gate
          await storeRequested(database, options)
          return { fetched: options.issueKeys, unresolved: [] }
        })
      })
      const other = fakeClient()

      const first = refresh(slow)
      await vi.waitFor(() => expect(slow.fetchIssuesByKey).toHaveBeenCalled())
      await refresh(other)
      release()
      await first

      expect(other.fetchIssuesByKey).not.toHaveBeenCalled()
    })

    test('Should store detected statuses with detectedStatusesAt', async () => {
      await refresh(fakeClient())

      expect((await loadProject()).jira).toMatchObject({
        detectedStatuses: [{ name: 'Done', categoryKey: 'done' }],
        detectedStatusesAt: NOW
      })
    })

    test('Should keep earlier statuses when Jira returns none', async () => {
      await db
        .collection('projects')
        .updateOne(
          { slug: 'FES' },
          { $set: { 'jira.detectedStatuses': [{ name: 'Old' }] } }
        )
      const client = fakeClient({ getProjectStatuses: vi.fn(async () => []) })

      await refresh(client)

      expect((await loadProject()).jira.detectedStatuses).toEqual([
        { name: 'Old' }
      ])
      expect(logger.warn).toHaveBeenCalled()
    })

    test('Should not ask for statuses again within 24 hours', async () => {
      await db
        .collection('projects')
        .updateOne(
          { slug: 'FES' },
          { $set: { 'jira.detectedStatusesAt': ago(HOUR) } }
        )
      const client = fakeClient()

      await refresh(client)

      expect(client.getProjectStatuses).not.toHaveBeenCalled()
    })

    test('Should capture sprint scope at most hourly when a board is set', async () => {
      await db.collection('projects').insertOne({
        slug: 'SPR',
        archivedAt: null,
        jira: { projectKeys: ['SPR'], boardId: 3 }
      })
      const client = fakeClient({
        getBoardSprints: vi.fn(async () => [
          { id: 21, state: 'active', name: 'Now' }
        ])
      })
      const project = await loadProject('SPR')

      await lazy.refreshJiraWindow({ db, client, project, logger, now: NOW })
      await lazy.refreshJiraWindow({ db, client, project, logger, now: NOW })

      expect(client.getBoardSprints).toHaveBeenCalledTimes(1)
    })

    test('Should warn and carry on when sprint scope capture fails', async () => {
      await db.collection('projects').insertOne({
        slug: 'SPF',
        archivedAt: null,
        jira: { projectKeys: ['SPF'], boardId: 4 }
      })
      const client = fakeClient({
        getBoardSprints: vi.fn(async () => {
          throw new Error('board gone')
        })
      })

      await expect(
        lazy.refreshJiraWindow({
          db,
          client,
          project: await loadProject('SPF'),
          logger,
          now: NOW
        })
      ).resolves.toEqual({ fetched: 0 })
      expect(logger.warn).toHaveBeenCalled()
    })

    test('Should use every referenced key when no window is given', async () => {
      const client = fakeClient()

      await refresh(client, { from: undefined, to: undefined })

      expect(client.fetchIssuesByKey.mock.calls[0][1].issueKeys.sort()).toEqual(
        ['FI0-1', 'FI0-2']
      )
    })
  })

  describe('#ensureJiraWindowFresh', () => {
    const ensure = async (client, extra = {}) =>
      lazy.ensureJiraWindowFresh({
        db,
        client,
        project: await loadProject(),
        ...WINDOW,
        logger,
        ...extra
      })

    beforeEach(async () => {
      await db.collection('payloads').insertOne(inWindowPayload(1, ['FI0-1']))
    })

    test('Should report not configured without calling Jira', async () => {
      const client = fakeClient({ isConfigured: () => false })

      const result = await ensure(client)

      expect(result).toEqual({
        configured: false,
        stale: false,
        pending: false,
        error: null,
        refreshedAt: null
      })
      expect(client.fetchIssuesByKey).not.toHaveBeenCalled()
    })

    test('Should report not configured for a project without Jira keys', async () => {
      const client = fakeClient()

      const result = await lazy.ensureJiraWindowFresh({
        db,
        client,
        project: { slug: 'FES', jira: { projectKeys: [] } },
        logger
      })

      expect(result.configured).toBe(false)
    })

    test('Should report a fresh refresh', async () => {
      const result = await ensure(fakeClient())

      expect(result).toMatchObject({
        configured: true,
        stale: false,
        pending: false,
        error: null
      })
      expect(typeof result.refreshedAt).toBe('string')
    })

    test('Should share one refresh between concurrent views of a window', async () => {
      const client = fakeClient()

      await Promise.all([ensure(client), ensure(client)])

      expect(client.getStoryPointsFieldId).toHaveBeenCalledTimes(1)
    })

    test('Should serve stored data after the budget and finish in the background', async () => {
      const client = fakeClient({
        fetchIssuesByKey: vi.fn(async (database, options) => {
          await new Promise((resolve) => setTimeout(resolve, 200))
          await storeRequested(database, options)
          return { fetched: options.issueKeys, unresolved: [] }
        })
      })

      const result = await ensure(client, { budgetMs: 20 })

      expect(result).toMatchObject({ stale: true, pending: true, error: null })
      await lazy.settleJiraRefreshes()
      expect(
        await db.collection('jira-issues').findOne({ key: 'FI0-1' })
      ).not.toBeNull()
    })

    test('Should report a credentials error without failing', async () => {
      const client = fakeClient({
        fetchIssuesByKey: vi.fn(async () => {
          throw new JiraAccessError('x', 'credentials')
        })
      })

      const result = await ensure(client)

      expect(result).toMatchObject({
        stale: true,
        pending: false,
        error: 'credentials',
        refreshedAt: null
      })
      expect(logger.error).toHaveBeenCalled()
    })

    test('Should report a project that is not visible', async () => {
      const client = fakeClient({
        fetchIssuesByKey: vi.fn(async () => {
          throw new JiraAccessError('x', 'not-visible')
        })
      })

      const result = await ensure(client)

      expect(result.error).toBe('not-visible')
    })

    test('Should report Jira being unavailable', async () => {
      const client = fakeClient({
        fetchIssuesByKey: vi.fn(async () => {
          throw new Error('boom')
        })
      })

      const result = await ensure(client)

      expect(result).toMatchObject({ stale: true, error: 'unavailable' })
      expect(logger.warn).toHaveBeenCalled()
    })
  })

  describe('#fetchUnknownJiraIssues', () => {
    const fetchUnknown = (client, extra = {}) =>
      lazy.fetchUnknownJiraIssues({
        db,
        client,
        projectSlug: 'FES',
        jiraKeys: ['FI0-1', 'ABC-1', 'bad'],
        logger,
        ...extra
      })

    test('Should fetch only the keys of the project', async () => {
      const client = fakeClient()

      await fetchUnknown(client)

      expect(client.fetchIssuesByKey).toHaveBeenCalledTimes(1)
      expect(client.fetchIssuesByKey.mock.calls[0][1].issueKeys).toEqual([
        'FI0-1'
      ])
    })

    test('Should fetch the Story parent of a fetched key', async () => {
      const client = fakeClient({
        fetchIssuesByKey: vi.fn(async (database, options) => {
          await storeRequested(database, options, {
            'FI0-1': { parentKey: 'FI0-10', parentIssueType: 'Story' }
          })
          return { fetched: options.issueKeys, unresolved: [] }
        })
      })

      await fetchUnknown(client)

      expect(client.fetchIssuesByKey.mock.calls[1][1].issueKeys).toEqual([
        'FI0-10'
      ])
    })

    test('Should do nothing for an archived project', async () => {
      await db
        .collection('projects')
        .updateOne({ slug: 'FES' }, { $set: { archivedAt: new Date() } })
      const client = fakeClient()

      await fetchUnknown(client)

      expect(client.fetchIssuesByKey).not.toHaveBeenCalled()
    })

    test('Should do nothing for an unknown project or one without Jira keys', async () => {
      await db.collection('projects').insertOne({
        slug: 'NOKEYS',
        archivedAt: null,
        jira: { projectKeys: [] }
      })
      const client = fakeClient()

      await fetchUnknown(client, { projectSlug: 'NOKEYS' })
      await fetchUnknown(client, { projectSlug: 'MISSING' })
      await fetchUnknown(client, { projectSlug: null })

      expect(client.fetchIssuesByKey).not.toHaveBeenCalled()
    })

    test('Should do nothing when unconfigured, or when no key belongs to the project', async () => {
      const unconfigured = fakeClient({ isConfigured: () => false })
      const client = fakeClient()

      await fetchUnknown(unconfigured)
      await fetchUnknown(client, { jiraKeys: ['ABC-1'] })
      await fetchUnknown(client, { jiraKeys: [] })

      expect(unconfigured.fetchIssuesByKey).not.toHaveBeenCalled()
      expect(client.fetchIssuesByKey).not.toHaveBeenCalled()
    })

    test('Should never reject and should warn when the client throws', async () => {
      const client = fakeClient({
        fetchIssuesByKey: vi.fn(async () => {
          throw new Error('boom')
        })
      })

      await expect(fetchUnknown(client)).resolves.toBeUndefined()
      expect(logger.warn).toHaveBeenCalled()
    })
  })

  describe('#captureSprintScope', () => {
    test('Should store the scope of an active sprint only once', async () => {
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

      await lazy.captureSprintScope({ db, client, project })
      await lazy.captureSprintScope({ db, client, project })

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

    test('Should ignore a duplicate-key race when storing the scope', async () => {
      const client = {
        getBoardSprints: vi.fn(async () => [
          { id: 30, state: 'active', name: 'Race' }
        ]),
        searchIssues: vi.fn(async () => ({ issues: [], isLast: true }))
      }
      const racing = {
        collection: () => ({
          findOne: async () => null,
          insertOne: async () => {
            throw Object.assign(new Error('dup'), { code: 11000 })
          }
        })
      }

      await expect(
        lazy.captureSprintScope({
          db: racing,
          client,
          project: { slug: 'p', jira: { boardId: 3 } }
        })
      ).resolves.toBeUndefined()
    })
  })
})
