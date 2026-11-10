import { JiraAccessError, createJiraClient } from './jira.js'

const BASE = 'https://defra.atlassian.net'

const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() }

const jsonResponse = (body, init = {}) =>
  new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
    ...init
  })

const ACCESS_CHECK = /\/rest\/api\/3\/project\/[^/]+$/

const rawClient = (options = {}) =>
  createJiraClient({
    baseUrl: BASE,
    email: 'bot@example.com',
    apiToken: 'token',
    requestTimeoutMs: 1000,
    dispatcher: null,
    logger,
    sleep: vi.fn(async () => {}),
    ...options
  })

// Answers the access checks each project sync makes, so `fetch` sees only the calls under test.
const client = ({ fetch, ...options } = {}) =>
  rawClient({
    ...options,
    fetch:
      fetch &&
      (async (url, init) =>
        ACCESS_CHECK.test(url) ? jsonResponse({}) : fetch(url, init))
  })

function fakeDb() {
  const docs = []
  return {
    docs,
    collection: () => ({
      bulkWrite: vi.fn(async (ops) => {
        docs.push(...ops.map((op) => op.updateOne.update.$set))
      })
    })
  }
}

describe('#createJiraClient', () => {
  describe('When not configured', () => {
    test('Should make no request', async () => {
      const fetch = vi.fn()
      const jira = client({ baseUrl: '', fetch })

      await expect(jira.searchIssues('project = X')).resolves.toEqual({
        issues: [],
        isLast: true,
        total: 0
      })
      await expect(
        jira.fetchIssuesByKey(fakeDb(), {
          projectSlug: 'p',
          projectKeys: ['MMO'],
          issueKeys: ['MMO-1']
        })
      ).resolves.toEqual({ fetched: [], unresolved: [] })
      await expect(jira.getBoardSprints(1)).resolves.toEqual([])
      expect(fetch).not.toHaveBeenCalled()
    })
  })

  describe('Rate limiting', () => {
    test('Should wait for Retry-After and retry a 429', async () => {
      const sleep = vi.fn(async () => {})
      const fetch = vi
        .fn()
        .mockResolvedValueOnce(
          new Response('', { status: 429, headers: { 'retry-after': '1' } })
        )
        .mockResolvedValueOnce(jsonResponse({ issues: [], isLast: true }))
      const jira = client({ fetch, sleep })

      await jira.searchIssues('project = MMO')

      expect(fetch).toHaveBeenCalledTimes(2)
      expect(sleep).toHaveBeenCalledWith(1000)
    })

    test('Should back off exponentially without Retry-After', async () => {
      const sleep = vi.fn(async () => {})
      const fetch = vi
        .fn()
        .mockResolvedValueOnce(new Response('', { status: 503 }))
        .mockResolvedValueOnce(new Response('', { status: 503 }))
        .mockResolvedValueOnce(jsonResponse({ issues: [], isLast: true }))
      const jira = client({ fetch, sleep })

      await jira.searchIssues('project = MMO')

      const [first, second] = sleep.mock.calls.map(([ms]) => ms)
      expect(first).toBeGreaterThanOrEqual(500)
      expect(first).toBeLessThanOrEqual(650)
      expect(second).toBeGreaterThanOrEqual(1000)
      expect(second).toBeLessThanOrEqual(1300)
    })

    test('Should give up after three retries', async () => {
      const fetch = vi.fn(async () => new Response('', { status: 429 }))
      const jira = client({ fetch })

      await expect(jira.searchIssues('project = MMO')).rejects.toThrow(
        'Jira API error: 429'
      )
      expect(fetch).toHaveBeenCalledTimes(4)
    })

    test('Should not retry other errors', async () => {
      const fetch = vi.fn(async () => new Response('', { status: 400 }))

      await expect(client({ fetch }).searchIssues('x')).rejects.toThrow(
        'Jira API error: 400'
      )
      expect(fetch).toHaveBeenCalledTimes(1)
    })
  })

  describe('#fetchIssuesByKey', () => {
    const fetchKeys = (jira, db, issueKeys, extra = {}) =>
      jira.fetchIssuesByKey(db, {
        projectSlug: 'mmo',
        projectKeys: ['MMO'],
        issueKeys,
        ...extra
      })
    const emptySearch = () => jsonResponse({ issues: [], isLast: true })
    const issueFor = (key, fields = {}) => ({
      key,
      fields: {
        status: { name: 'Done', statusCategory: { key: 'done' } },
        created: '2026-07-01T10:00:00.000Z',
        ...fields
      }
    })

    test("Should search only the project's keys in batches of 100 with project in (...)", async () => {
      const fetch = vi.fn(async () => emptySearch())
      const keys = Array.from({ length: 150 }, (_, i) => `MMO-${i + 1}`)

      await fetchKeys(client({ fetch }), fakeDb(), [...keys, 'ABC-1'], {
        storyPointsField: 'customfield_10028'
      })

      expect(fetch).toHaveBeenCalledTimes(2)
      const [first, second] = fetch.mock.calls.map(([, init]) =>
        JSON.parse(init.body)
      )
      expect(first.jql.startsWith('project in ("MMO") AND key in (')).toBe(true)
      expect(first.jql.match(/"MMO-\d+"/g)).toHaveLength(100)
      expect(first.jql).not.toContain('ABC-1')
      expect(second.jql.match(/"MMO-\d+"/g)).toHaveLength(50)
      expect(first.fields).toContain('parent')
      expect(first.fields).toContain('customfield_10028')
    })

    test('Should store parent key, parent type, story points and fetchedAt', async () => {
      const fetch = vi.fn(async () =>
        jsonResponse({
          issues: [
            issueFor('MMO-1', {
              parent: {
                key: 'MMO-9',
                fields: { issuetype: { name: 'Story' } }
              },
              customfield_10028: 5
            })
          ],
          isLast: true
        })
      )
      const db = fakeDb()

      await fetchKeys(client({ fetch }), db, ['MMO-1'], {
        storyPointsField: 'customfield_10028'
      })

      expect(db.docs[0]).toMatchObject({
        key: 'MMO-1',
        parentKey: 'MMO-9',
        parentIssueType: 'Story',
        storyPoints: 5,
        storyPointsField: 'customfield_10028'
      })
      expect(db.docs[0].fetchedAt).toBeInstanceOf(Date)
    })

    test('Should store no parent when the issue has none', async () => {
      const fetch = vi.fn(async () =>
        jsonResponse({ issues: [issueFor('MMO-1')], isLast: true })
      )
      const db = fakeDb()

      await fetchKeys(client({ fetch }), db, ['MMO-1'])

      expect(db.docs[0]).toMatchObject({
        parentKey: null,
        parentIssueType: null,
        storyPointsField: null
      })
    })

    test('Should read story points only from the given field', async () => {
      const fetch = vi.fn(async () =>
        jsonResponse({
          issues: [issueFor('MMO-1', { customfield_10016: 3 })],
          isLast: true
        })
      )
      const db = fakeDb()

      await fetchKeys(client({ fetch }), db, ['MMO-1'], {
        storyPointsField: 'customfield_10028'
      })

      expect(db.docs[0].storyPoints).toBeNull()
    })

    test('Should read story points sent as a numeric string', async () => {
      const fetch = vi.fn(async () =>
        jsonResponse({
          issues: [issueFor('MMO-1', { customfield_10028: '8' })],
          isLast: true
        })
      )
      const db = fakeDb()

      await fetchKeys(client({ fetch }), db, ['MMO-1'], {
        storyPointsField: 'customfield_10028'
      })

      expect(db.docs[0].storyPoints).toBe(8)
    })

    test('Should count each cleared resolution as a reopen', async () => {
      const resolution = (from, to) => ({
        items: [{ field: 'resolution', from, to }]
      })
      const fetch = vi.fn(async () =>
        jsonResponse({
          issues: [
            {
              ...issueFor('MMO-2'),
              changelog: {
                histories: [
                  resolution(null, '10000'),
                  resolution('10000', null),
                  resolution(null, '10000'),
                  resolution('10000', null),
                  resolution(null, '10000')
                ]
              }
            }
          ],
          isLast: true
        })
      )
      const db = fakeDb()

      await fetchKeys(client({ fetch }), db, ['MMO-2'])

      expect(db.docs[0].reopenCount).toBe(2)
    })

    test('Should keep status history, first Done time and issue links', async () => {
      const fetch = vi.fn(async () =>
        jsonResponse({
          issues: [
            {
              ...issueFor('MMO-3', {
                priority: { name: 'High' },
                issuelinks: [
                  {
                    type: { name: 'Relates' },
                    inwardIssue: {
                      key: 'MMO-9',
                      fields: { issuetype: { name: 'Bug' } }
                    }
                  },
                  { type: { name: 'Blocks' } }
                ]
              }),
              changelog: {
                histories: [
                  {
                    created: '2026-07-03T10:00:00.000Z',
                    items: [
                      {
                        field: 'status',
                        fromString: 'In Progress',
                        toString: 'Done'
                      },
                      { field: 'resolution', from: null, to: '1' }
                    ]
                  },
                  {
                    created: '2026-07-01T10:00:00.000Z',
                    items: [
                      {
                        field: 'status',
                        fromString: 'To Do',
                        toString: 'In Progress'
                      }
                    ]
                  }
                ]
              }
            }
          ],
          isLast: true
        })
      )
      const db = fakeDb()

      await fetchKeys(client({ fetch }), db, ['MMO-3'])

      expect(db.docs[0]).toMatchObject({
        priority: 'High',
        firstDoneAt: new Date('2026-07-03T10:00:00.000Z'),
        issueLinks: [
          {
            key: 'MMO-9',
            type: 'Relates',
            direction: 'inward',
            issueType: 'Bug'
          }
        ],
        statusHistory: [
          { from: 'To Do', to: 'In Progress' },
          { from: 'In Progress', to: 'Done' }
        ]
      })
    })

    test('Should report keys Jira did not return as unresolved', async () => {
      const fetch = vi.fn(async () =>
        jsonResponse({ issues: [issueFor('MMO-1')], isLast: true })
      )

      const result = await fetchKeys(client({ fetch }), fakeDb(), [
        'MMO-1',
        'MMO-2'
      ])

      expect(result).toEqual({ fetched: ['MMO-1'], unresolved: ['MMO-2'] })
    })

    test('Should follow the page token until the last page', async () => {
      const fetch = vi
        .fn()
        .mockResolvedValueOnce(
          jsonResponse({
            issues: [issueFor('MMO-1')],
            isLast: false,
            nextPageToken: 'next'
          })
        )
        .mockResolvedValueOnce(
          jsonResponse({ issues: [issueFor('MMO-2')], isLast: true })
        )

      const result = await fetchKeys(client({ fetch }), fakeDb(), [
        'MMO-1',
        'MMO-2'
      ])

      expect(result.fetched).toEqual(['MMO-1', 'MMO-2'])
      expect(JSON.parse(fetch.mock.calls[1][1].body).nextPageToken).toBe('next')
    })

    test('Should ignore a duplicate-key error from a concurrent upsert', async () => {
      const fetch = vi.fn(async () =>
        jsonResponse({ issues: [issueFor('MMO-1')], isLast: true })
      )
      const db = {
        collection: () => ({
          bulkWrite: vi.fn(async () => {
            throw Object.assign(new Error('dup'), {
              writeErrors: [{ code: 11000 }]
            })
          })
        })
      }

      await expect(
        fetchKeys(client({ fetch }), db, ['MMO-1'])
      ).resolves.toMatchObject({ fetched: ['MMO-1'] })
    })

    test('Should rethrow any other write failure', async () => {
      const fetch = vi.fn(async () =>
        jsonResponse({ issues: [issueFor('MMO-1')], isLast: true })
      )
      const db = {
        collection: () => ({
          bulkWrite: vi.fn(async () => {
            throw new Error('disk full')
          })
        })
      }

      await expect(fetchKeys(client({ fetch }), db, ['MMO-1'])).rejects.toThrow(
        'disk full'
      )
    })

    test('Should drop keys a 400 names and retry once', async () => {
      const fetch = vi
        .fn()
        .mockResolvedValueOnce(
          jsonResponse(
            {
              errorMessages: [
                "An issue with key 'MMO-2' does not exist for field 'key'."
              ]
            },
            { status: 400 }
          )
        )
        .mockResolvedValueOnce(
          jsonResponse({ issues: [issueFor('MMO-1')], isLast: true })
        )

      const result = await fetchKeys(client({ fetch }), fakeDb(), [
        'MMO-1',
        'MMO-2'
      ])

      expect(result).toEqual({ fetched: ['MMO-1'], unresolved: ['MMO-2'] })
      expect(fetch).toHaveBeenCalledTimes(2)
      expect(JSON.parse(fetch.mock.calls[1][1].body).jql).not.toContain('MMO-2')
    })

    test('Should give up on a batch after a second 400', async () => {
      const named = {
        errorMessages: [
          "An issue with key 'MMO-2' does not exist for field 'key'."
        ]
      }
      const fetch = vi
        .fn()
        .mockResolvedValueOnce(jsonResponse(named, { status: 400 }))
        .mockResolvedValueOnce(jsonResponse({}, { status: 400 }))
      logger.warn.mockClear()

      const result = await fetchKeys(client({ fetch }), fakeDb(), [
        'MMO-1',
        'MMO-2'
      ])

      expect(result.fetched).toEqual([])
      expect(result.unresolved.sort()).toEqual(['MMO-1', 'MMO-2'])
      expect(logger.warn).toHaveBeenCalled()
    })

    test('Should mark every key unresolved when a 400 names none', async () => {
      const fetch = vi.fn(async () => jsonResponse({}, { status: 400 }))

      const result = await fetchKeys(client({ fetch }), fakeDb(), ['MMO-1'])

      expect(result).toEqual({ fetched: [], unresolved: ['MMO-1'] })
      expect(fetch).toHaveBeenCalledTimes(1)
    })

    test('Should mark every key unresolved when the 400 names all of them', async () => {
      const fetch = vi.fn(async () =>
        jsonResponse(
          { errorMessages: ["An issue with key 'MMO-1' does not exist."] },
          { status: 400 }
        )
      )

      const result = await fetchKeys(client({ fetch }), fakeDb(), ['MMO-1'])

      expect(result).toEqual({ fetched: [], unresolved: ['MMO-1'] })
    })

    test('Should rethrow a non-400 search failure', async () => {
      const fetch = vi.fn(async () => new Response('', { status: 500 }))

      await expect(
        fetchKeys(client({ fetch }), fakeDb(), ['MMO-1'])
      ).rejects.toThrow('Jira API error: 500')
    })

    describe('Access checks', () => {
      const status = (code) => new Response('', { status: code })
      const accessClient = (accessStatus, search = vi.fn(emptySearch)) => {
        const fetch = vi.fn(async (url, init) =>
          ACCESS_CHECK.test(url)
            ? accessStatus === 200
              ? jsonResponse({})
              : status(accessStatus)
            : search(url, init)
        )
        return { jira: rawClient({ fetch }), fetch, search }
      }

      test('Should refuse when Jira rejects the credentials', async () => {
        const { jira } = accessClient(401)

        const fetched = fetchKeys(jira, fakeDb(), ['MMO-1'])

        await expect(fetched).rejects.toBeInstanceOf(JiraAccessError)
        await expect(fetched).rejects.toMatchObject({ kind: 'credentials' })
      })

      test('Should refuse when no Jira project is visible', async () => {
        const { jira } = accessClient(404)

        const fetched = fetchKeys(jira, fakeDb(), ['MMO-1'])

        await expect(fetched).rejects.toMatchObject({
          name: 'JiraAccessError',
          kind: 'not-visible'
        })
      })

      test('Should search only the visible Jira projects and warn about the rest', async () => {
        const fetch = vi.fn(async (url) =>
          new URL(url).pathname === '/rest/api/3/project/GONE'
            ? status(404)
            : jsonResponse({ issues: [], isLast: true })
        )
        logger.warn.mockClear()

        const result = await rawClient({ fetch }).fetchIssuesByKey(fakeDb(), {
          projectSlug: 'fes',
          projectKeys: ['FI0', 'GONE'],
          issueKeys: ['FI0-1', 'GONE-1']
        })

        const search = fetch.mock.calls.find(([, init]) => init?.body)
        expect(JSON.parse(search[1].body).jql).toBe(
          'project in ("FI0") AND key in ("FI0-1")'
        )
        expect(result.unresolved).toEqual(['GONE-1', 'FI0-1'])
        expect(logger.warn).toHaveBeenCalledWith(
          'Jira project GONE is not visible to the Jira account'
        )
      })

      test('Should cache a visible project for ten minutes', async () => {
        const { jira, fetch } = accessClient(200)

        await fetchKeys(jira, fakeDb(), ['MMO-1'])
        await fetchKeys(jira, fakeDb(), ['MMO-2'])

        const checks = fetch.mock.calls.filter(([url]) =>
          ACCESS_CHECK.test(url)
        )
        expect(checks).toHaveLength(1)
      })

      test('Should pass on any other Jira failure unchanged', async () => {
        const { jira } = accessClient(500)

        const fetched = fetchKeys(jira, fakeDb(), ['MMO-1'])

        await expect(fetched).rejects.toThrow('Jira API error: 500')
        await expect(fetched).rejects.not.toBeInstanceOf(JiraAccessError)
      })
    })

    test('Should make no request when no key belongs to the project', async () => {
      const fetch = vi.fn()

      const result = await fetchKeys(client({ fetch }), fakeDb(), ['ABC-1'])

      expect(result).toEqual({ fetched: [], unresolved: [] })
      expect(fetch).not.toHaveBeenCalled()
    })

    test('Should make no request for keys that are not well formed', async () => {
      const fetch = vi.fn()

      const result = await fetchKeys(client({ fetch }), fakeDb(), [
        'x) OR 1=1',
        'MMO-1) OR (a=1'
      ])

      expect(result).toEqual({ fetched: [], unresolved: [] })
      expect(fetch).not.toHaveBeenCalled()
    })
  })

  describe('#getStoryPointsFieldId', () => {
    const fieldsClient = (fields) =>
      client({ fetch: vi.fn(async () => jsonResponse(fields)) })

    test('Should prefer Story Points over Story point estimate', async () => {
      const jira = fieldsClient([
        { id: 'customfield_10016', name: 'Story point estimate', custom: true },
        {
          id: 'customfield_10028',
          name: 'Story Points',
          custom: true,
          schema: { type: 'number' }
        }
      ])

      await expect(jira.getStoryPointsFieldId()).resolves.toBe(
        'customfield_10028'
      )
    })

    test('Should match the name case-insensitively', async () => {
      const jira = fieldsClient([
        { id: 'customfield_1', name: ' story points ', custom: true }
      ])

      await expect(jira.getStoryPointsFieldId()).resolves.toBe('customfield_1')
    })

    test('Should prefer a numeric field among several with the name', async () => {
      const jira = fieldsClient([
        {
          id: 'customfield_1',
          name: 'Story Points',
          custom: true,
          schema: { type: 'string' }
        },
        {
          id: 'customfield_2',
          name: 'Story Points',
          custom: true,
          schema: { type: 'number' }
        }
      ])

      await expect(jira.getStoryPointsFieldId()).resolves.toBe('customfield_2')
    })

    test('Should fall back to Story point estimate', async () => {
      const jira = fieldsClient([
        { id: 'customfield_10016', name: 'Story point estimate', custom: true }
      ])

      await expect(jira.getStoryPointsFieldId()).resolves.toBe(
        'customfield_10016'
      )
    })

    test('Should ignore system fields and return null when none match', async () => {
      const jira = fieldsClient([
        { id: 'summary', name: 'Story Points', custom: false },
        { id: 'customfield_5', name: 'Sprint', custom: true }
      ])

      await expect(jira.getStoryPointsFieldId()).resolves.toBeNull()
    })

    test('Should return null for an unexpected response', async () => {
      await expect(fieldsClient({}).getStoryPointsFieldId()).resolves.toBeNull()
    })

    test('Should return null when not configured without a request', async () => {
      const fetch = vi.fn()

      await expect(
        client({ baseUrl: '', fetch }).getStoryPointsFieldId()
      ).resolves.toBeNull()
      expect(fetch).not.toHaveBeenCalled()
    })
  })

  describe('#getBoardSprints', () => {
    test('Should page through active and closed sprints', async () => {
      const fetch = vi
        .fn()
        .mockResolvedValueOnce(
          jsonResponse({ values: [{ id: 1 }], isLast: false })
        )
        .mockResolvedValueOnce(
          jsonResponse({ values: [{ id: 2 }], isLast: true })
        )

      const sprints = await client({ fetch }).getBoardSprints(7)

      expect(sprints).toEqual([{ id: 1 }, { id: 2 }])
      expect(fetch.mock.calls[0][0]).toBe(
        `${BASE}/rest/agile/1.0/board/7/sprint?state=active,closed&maxResults=50&startAt=0`
      )
      expect(fetch.mock.calls[1][0]).toContain('startAt=1')
    })
  })

  describe('Truncated changelog', () => {
    const fetchByKey = (jira, db, key) =>
      jira.fetchIssuesByKey(db, {
        projectSlug: 'mmo',
        projectKeys: ['MMO'],
        issueKeys: [key]
      })
    const statusChange = (created, fromString, toString) => ({
      created,
      items: [{ field: 'status', fromString, toString }]
    })
    const searchWith = (changelog) =>
      jsonResponse({
        issues: [
          {
            key: 'MMO-4',
            fields: {
              status: { name: 'Done', statusCategory: { key: 'done' } },
              created: '2026-07-01T09:00:00.000Z'
            },
            changelog
          }
        ],
        isLast: true
      })

    test('Should fetch every page of a changelog the search cut short', async () => {
      const fetch = vi
        .fn()
        .mockResolvedValueOnce(
          searchWith({
            total: 3,
            histories: [
              statusChange('2026-07-01T10:00:00.000Z', 'To Do', 'In Dev')
            ]
          })
        )
        .mockResolvedValueOnce(
          jsonResponse({
            values: [
              statusChange('2026-07-01T10:00:00.000Z', 'To Do', 'In Dev'),
              statusChange('2026-07-02T10:00:00.000Z', 'In Dev', 'In Test')
            ],
            isLast: false
          })
        )
        .mockResolvedValueOnce(
          jsonResponse({
            values: [
              statusChange('2026-07-03T10:00:00.000Z', 'In Test', 'Done')
            ],
            isLast: true
          })
        )
      const db = fakeDb()

      await fetchByKey(client({ fetch }), db, 'MMO-4')

      expect(fetch.mock.calls[1][0]).toBe(
        `${BASE}/rest/api/3/issue/MMO-4/changelog?startAt=0&maxResults=100`
      )
      expect(fetch.mock.calls[2][0]).toContain('startAt=2')
      expect(db.docs[0].statusHistory.map((c) => c.to)).toEqual([
        'In Dev',
        'In Test',
        'Done'
      ])
    })

    test('Should not fetch a changelog that is complete', async () => {
      const fetch = vi.fn(async () =>
        searchWith({
          total: 1,
          histories: [statusChange('2026-07-01T10:00:00.000Z', 'To Do', 'Done')]
        })
      )

      await fetchByKey(client({ fetch }), fakeDb(), 'MMO-4')

      expect(fetch).toHaveBeenCalledTimes(1)
    })

    test('Should keep an issue with an invalid key without fetching its changelog', async () => {
      const fetch = vi.fn(async () =>
        jsonResponse({
          issues: [
            {
              key: '../admin',
              fields: {
                status: { name: 'Done', statusCategory: { key: 'done' } },
                created: '2026-07-01T09:00:00.000Z'
              },
              changelog: {
                total: 5,
                histories: [
                  statusChange('2026-07-01T10:00:00.000Z', 'To Do', 'Done')
                ]
              }
            }
          ],
          isLast: true
        })
      )
      const db = fakeDb()

      await fetchByKey(client({ fetch }), db, 'MMO-4')

      expect(fetch).toHaveBeenCalledTimes(1)
      expect(db.docs).toHaveLength(1)
      expect(db.docs[0].statusHistory).toHaveLength(1)
    })
  })

  describe('#getProjectStatuses', () => {
    test('Should flatten statuses across issue types with their categories', async () => {
      const fetch = vi.fn(async () =>
        jsonResponse([
          {
            name: 'Story',
            statuses: [
              { name: 'To Do', statusCategory: { key: 'new' } },
              { name: 'In Dev', statusCategory: { key: 'indeterminate' } }
            ]
          },
          {
            name: 'Bug',
            statuses: [
              { name: 'Done', statusCategory: { key: 'done' } },
              { name: 'Odd', statusCategory: { key: 'undefined' } },
              { statusCategory: { key: 'new' } }
            ]
          },
          { name: 'Epic' }
        ])
      )

      const statuses = await client({ fetch }).getProjectStatuses('MMO')

      expect(fetch.mock.calls[0][0]).toBe(
        `${BASE}/rest/api/3/project/MMO/statuses`
      )
      expect(statuses).toEqual([
        { name: 'To Do', categoryKey: 'new', issueType: 'Story' },
        { name: 'In Dev', categoryKey: 'indeterminate', issueType: 'Story' },
        { name: 'Done', categoryKey: 'done', issueType: 'Bug' },
        { name: 'Odd', categoryKey: null, issueType: 'Bug' }
      ])
    })

    test('Should return nothing for an unexpected response', async () => {
      const fetch = vi.fn(async () => jsonResponse({}))

      await expect(
        client({ fetch }).getProjectStatuses('MMO')
      ).resolves.toEqual([])
    })

    test('Should not call Jira when unconfigured or for a malformed key', async () => {
      const fetch = vi.fn()

      await expect(
        client({ fetch, baseUrl: '' }).getProjectStatuses('MMO')
      ).resolves.toEqual([])
      await expect(
        client({ fetch }).getProjectStatuses('../x')
      ).resolves.toEqual([])
      expect(fetch).not.toHaveBeenCalled()
    })
  })
})
