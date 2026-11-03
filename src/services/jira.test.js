import { createJiraClient } from './jira.js'

const BASE = 'https://defra.atlassian.net'

const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() }

const client = (options = {}) =>
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

const jsonResponse = (body, init = {}) =>
  new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
    ...init
  })

function fakeDb() {
  const docs = []
  return {
    docs,
    collection: () => ({
      updateOne: vi.fn(async (filter, update) => {
        docs.push(update.$set)
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
        jira.syncProjectIssues(fakeDb(), 'p', ['MMO'])
      ).resolves.toMatchObject({ configured: false })
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

  describe('#syncProjectIssues', () => {
    test('Should only ask for issues updated since the last sync', async () => {
      const fetch = vi.fn(async () =>
        jsonResponse({
          issues: [
            {
              key: 'MMO-1',
              fields: {
                summary: 'One',
                status: { name: 'Done', statusCategory: { key: 'done' } },
                created: '2026-07-01T10:00:00.000Z',
                updated: '2026-07-02T10:00:00.000Z'
              }
            }
          ],
          isLast: true
        })
      )
      const db = fakeDb()

      const result = await client({ fetch }).syncProjectIssues(
        db,
        'mmo',
        ['MMO', 'bad"key'],
        'customfield_10016',
        { updatedSince: '2026-07-01T09:30:00.000Z' }
      )

      expect(result).toEqual({ synced: 1, configured: true })
      const { jql } = JSON.parse(fetch.mock.calls[0][1].body)
      expect(jql).toBe(
        'project in ("MMO") AND updated >= "2026/07/01 09:30" ORDER BY updated DESC'
      )
      expect(db.docs[0]).toMatchObject({ key: 'MMO-1', projectSlug: 'mmo' })
    })

    test('Should count each cleared resolution as a reopen', async () => {
      const resolution = (from, to) => ({
        items: [{ field: 'resolution', from, to }]
      })
      const fetch = vi.fn(async () =>
        jsonResponse({
          issues: [
            {
              key: 'MMO-2',
              fields: {
                status: { name: 'Done', statusCategory: { key: 'done' } },
                created: '2026-07-01T10:00:00.000Z'
              },
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

      await client({ fetch }).syncProjectIssues(db, 'mmo', ['MMO'])

      expect(db.docs[0].reopenCount).toBe(2)
    })

    test('Should keep status history, first Done time and issue links', async () => {
      const fetch = vi.fn(async () =>
        jsonResponse({
          issues: [
            {
              key: 'MMO-3',
              fields: {
                status: { name: 'Done', statusCategory: { key: 'done' } },
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
              },
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

      await client({ fetch }).syncProjectIssues(db, 'mmo', ['MMO'])

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
  })

  describe('#syncIssuesByKey', () => {
    test('Should fetch only well-formed keys', async () => {
      const fetch = vi.fn(async () =>
        jsonResponse({ issues: [], isLast: true })
      )

      await client({ fetch }).syncIssuesByKey(fakeDb(), 'mmo', [
        'MMO-1',
        'MMO-1',
        'x) OR 1=1'
      ])

      expect(JSON.parse(fetch.mock.calls[0][1].body).jql).toBe(
        'key in ("MMO-1")'
      )
    })

    test('Should do nothing without keys', async () => {
      const fetch = vi.fn()

      await expect(
        client({ fetch }).syncIssuesByKey(fakeDb(), 'mmo', [])
      ).resolves.toEqual({ synced: 0 })
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
})
