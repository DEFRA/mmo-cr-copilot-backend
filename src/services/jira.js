import { config } from '#/config.js'
import { createLogger } from '#/common/helpers/logging/logger.js'
import { createProxyDispatcher } from '#/common/helpers/proxy.js'
import { mapWithConcurrency } from '#/common/helpers/concurrency.js'
import {
  JIRA_ISSUE_KEY_PATTERN,
  JIRA_PROJECT_KEY_PATTERN
} from '#/schemas/project.js'

export {
  PR_JIRA_LINKS_COLLECTION,
  linkPrsToJiraIssues
} from './pr-jira-links.js'
export const JIRA_ISSUES_COLLECTION = 'jira-issues'

/** Jira refused the credentials, or none of a project's Jira keys is visible to them. */
export class JiraAccessError extends Error {
  constructor(message, kind) {
    super(message)
    this.name = 'JiraAccessError'
    this.kind = kind // 'credentials' | 'not-visible'
  }
}

const STATUS_CATEGORIES = new Set(['new', 'indeterminate', 'done'])
const KEY_BATCH_SIZE = 100
const PAGE_SIZE = 100
const CHANGELOG_CONCURRENCY = 4
const VISIBLE_FOR_MS = 10 * 60 * 1000
const STORY_POINT_FIELD_NAMES = ['story points', 'story point estimate']
const ISSUE_FIELDS = [
  'summary',
  'status',
  'issuetype',
  'created',
  'resolutiondate',
  'updated',
  'issuelinks',
  'priority',
  'parent'
]
const DUPLICATE_KEY_ERROR = 11000
const quoted = (value) => `"${value}"`

const isPlaceholder = (val) =>
  typeof val === 'string' && val.includes('<') && val.includes('>')

const toIso = (val) => (val instanceof Date ? val.toISOString() : val)
const toDate = (val) => (val ? new Date(val) : null)

// Formats a stored Jira issue document for API callers.
export function toJiraIssue(doc) {
  if (!doc) return null
  const { _id, ...rest } = doc
  return {
    ...rest,
    ...(rest.created ? { created: toIso(rest.created) } : {}),
    ...(rest.resolved ? { resolved: toIso(rest.resolved) } : {}),
    ...(rest.updated ? { updated: toIso(rest.updated) } : {}),
    ...(rest.syncedAt ? { syncedAt: toIso(rest.syncedAt) } : {}),
    ...(rest.fetchedAt ? { fetchedAt: toIso(rest.fetchedAt) } : {}),
    ...(rest.flow
      ? {
          flow: {
            ...rest.flow,
            startedAt: toIso(rest.flow.startedAt),
            doneAt: toIso(rest.flow.doneAt),
            firstDoneAt: toIso(rest.flow.firstDoneAt)
          }
        }
      : {})
  }
}

// Jira clears the resolution whenever an issue leaves Done, so each cleared
// resolution in the changelog is one reopen.
function countReopens(histories) {
  let count = 0
  for (const h of histories) {
    for (const it of h.items ?? []) {
      if (it.field === 'resolution' && it.from !== null && it.to === null) {
        count += 1
      }
    }
  }
  return count
}

// Status transitions oldest first; the changelog carries names, not categories.
function statusHistory(histories) {
  const changes = []
  for (const h of histories) {
    for (const it of h.items ?? []) {
      if (it.field === 'status' && h.created) {
        changes.push({
          at: toDate(h.created),
          from: it.fromString ?? '',
          to: it.toString ?? ''
        })
      }
    }
  }
  return changes.sort((a, b) => a.at - b.at)
}

// The first time a resolution was set is when the ticket first reached Done.
function firstDoneAt(histories) {
  const times = histories
    .filter((h) =>
      h.items?.some((it) => it.field === 'resolution' && it.to !== null)
    )
    .map((h) => toDate(h.created))
    .filter(Boolean)
    .sort((a, b) => a - b)
  return times[0] ?? null
}

function issueLinks(links = []) {
  return links
    .map((link) => {
      const other = link.inwardIssue ?? link.outwardIssue
      if (!other?.key) return null
      return {
        key: other.key,
        type: link.type?.name ?? '',
        direction: link.inwardIssue ? 'inward' : 'outward',
        issueType: other.fields?.issuetype?.name ?? ''
      }
    })
    .filter(Boolean)
}

// Normalises Jira API issue fields or plain objects into the storage shape.
function normalizeIssue(issue, projectSlug, storyPointsField, now) {
  if (issue.fields) {
    const f = issue.fields
    const histories = issue.changelog?.histories || []
    const spRaw = storyPointsField ? f[storyPointsField] : null
    const sp =
      typeof spRaw === 'number'
        ? spRaw
        : typeof spRaw === 'string' &&
            spRaw.trim() !== '' &&
            Number.isFinite(Number(spRaw))
          ? Number(spRaw)
          : null

    return {
      key: issue.key,
      projectSlug,
      summary: f.summary ?? '',
      issueType: f.issuetype?.name ?? 'Story',
      priority: f.priority?.name ?? '',
      status: {
        name: f.status?.name ?? '',
        categoryKey: (
          f.status?.statusCategory?.key ??
          f.status?.categoryKey ??
          ''
        ).toLowerCase()
      },
      created: toDate(f.created),
      resolved: toDate(f.resolutiondate || f.resolved),
      storyPoints: sp,
      updated: toDate(f.updated) || new Date(),
      reopenCount: countReopens(histories),
      statusHistory: statusHistory(histories),
      firstDoneAt: firstDoneAt(histories),
      issueLinks: issueLinks(f.issuelinks),
      parentKey: f.parent?.key ?? null,
      parentIssueType: f.parent?.fields?.issuetype?.name ?? null,
      storyPointsField: storyPointsField ?? null,
      fetchedAt: now,
      syncedAt: now
    }
  }

  return {
    ...issue,
    projectSlug: issue.projectSlug || projectSlug,
    created: toDate(issue.created),
    resolved: toDate(issue.resolved),
    status: {
      name: issue.status?.name ?? '',
      categoryKey: (issue.status?.categoryKey ?? '').toLowerCase()
    },
    syncedAt: new Date()
  }
}

// Creates a Jira Cloud client for issue search and PR-scoped issue fetching.
export function createJiraClient(options = {}) {
  const {
    baseUrl = config.get('jira.baseUrl'),
    email = config.get('jira.email'),
    apiToken = config.get('jira.apiToken'),
    requestTimeoutMs = config.get('jira.requestTimeoutMs'),
    dispatcher = createProxyDispatcher(),
    logger = createLogger(),
    fetch = globalThis.fetch,
    sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    retries = 3
  } = options

  const apiBase = baseUrl ? baseUrl.replace(/\/+$/, '') : ''
  const visibleUntil = new Map()

  function isConfigured() {
    return Boolean(
      baseUrl?.trim() &&
      email?.trim() &&
      apiToken?.trim() &&
      !isPlaceholder(baseUrl) &&
      !isPlaceholder(email) &&
      !isPlaceholder(apiToken)
    )
  }

  async function searchIssues(jql, searchOptions = {}) {
    if (!isConfigured()) {
      return { issues: [], isLast: true, total: 0 }
    }

    const {
      nextPageToken,
      maxResults = 50,
      fields,
      expand = 'changelog'
    } = searchOptions

    const body = {
      jql,
      maxResults,
      ...(nextPageToken ? { nextPageToken } : {}),
      ...(fields ? { fields } : {}),
      ...(expand ? { expand } : {})
    }

    return jiraRequest('/rest/api/3/search/jql', {
      method: 'POST',
      body: JSON.stringify(body)
    })
  }

  function retryDelayMs(response, attempt) {
    const header = response.headers.get('retry-after')
    const retryAfter = header === null ? NaN : Number(header)
    if (Number.isFinite(retryAfter) && retryAfter >= 0) return retryAfter * 1000
    const base = 500 * 2 ** attempt
    return base + Math.random() * base * 0.3
  }

  /**
   * One Jira Cloud request. A 429 or 503 is retried up to `retries` times,
   * honouring `Retry-After`, otherwise backing off exponentially with jitter.
   */
  async function jiraRequest(pathname, init = {}) {
    const auth = Buffer.from(`${email}:${apiToken}`).toString('base64')
    for (let attempt = 0; ; attempt += 1) {
      const response = await fetch(`${apiBase}${pathname}`, {
        ...init,
        headers: {
          Accept: 'application/json',
          ...(init.body ? { 'Content-Type': 'application/json' } : {}),
          Authorization: `Basic ${auth}`
        },
        signal: AbortSignal.timeout(requestTimeoutMs),
        ...(dispatcher ? { dispatcher } : {})
      })
      if (response.ok) return await response.json()

      const throttled = response.status === 429 || response.status === 503
      if (!throttled || attempt >= retries) {
        const body =
          response.status === 400 ? await response.json().catch(() => ({})) : {}
        throw Object.assign(
          new Error(
            `Jira API error: ${response.status} ${response.statusText}`
          ),
          {
            status: response.status,
            jiraMessages: Array.isArray(body.errorMessages)
              ? body.errorMessages.map(String)
              : []
          }
        )
      }
      const delay = retryDelayMs(response, attempt)
      logger.warn(
        `Jira returned ${response.status}; retrying in ${Math.round(delay)} ms`
      )
      await sleep(delay)
    }
  }

  async function fetchFullChangelog(issueKey) {
    const histories = []
    for (let startAt = 0; ;) {
      const page = await jiraRequest(
        `/rest/api/3/issue/${encodeURIComponent(issueKey)}/changelog?startAt=${startAt}&maxResults=100`
      )
      const values = Array.isArray(page?.values) ? page.values : []
      histories.push(...values)
      if (page?.isLast !== false || values.length === 0) break
      startAt += values.length
    }
    return histories
  }

  async function withFullChangelog(issue) {
    const { total, histories } = issue.changelog ?? {}
    if (
      !JIRA_ISSUE_KEY_PATTERN.test(issue.key ?? '') ||
      !Number.isInteger(total) ||
      !Array.isArray(histories) ||
      total <= histories.length
    ) {
      return issue
    }
    // Search caps the embedded changelog; the changelog endpoint pages through all of it.
    return {
      ...issue,
      changelog: {
        ...issue.changelog,
        histories: await fetchFullChangelog(issue.key)
      }
    }
  }

  /** Statuses of a Jira project across its issue types, with their categories. */
  async function getProjectStatuses(projectKey) {
    if (!isConfigured() || !JIRA_PROJECT_KEY_PATTERN.test(projectKey ?? '')) {
      return []
    }
    const types = await jiraRequest(
      `/rest/api/3/project/${encodeURIComponent(projectKey)}/statuses`
    )
    return (Array.isArray(types) ? types : [])
      .flatMap((type) =>
        (type?.statuses ?? []).map((status) => ({
          name: status?.name ?? '',
          categoryKey: STATUS_CATEGORIES.has(status?.statusCategory?.key)
            ? status.statusCategory.key
            : null,
          issueType: type?.name ?? ''
        }))
      )
      .filter((status) => status.name)
  }

  async function storeMatchingIssues(db, projectSlug, jql, storyPointsField) {
    const stored = []
    let nextPageToken
    do {
      const page = await searchIssues(jql, {
        nextPageToken,
        maxResults: PAGE_SIZE,
        fields: storyPointsField
          ? [...ISSUE_FIELDS, storyPointsField]
          : ISSUE_FIELDS,
        expand: 'changelog'
      })
      const now = new Date()
      const docs = await mapWithConcurrency(
        page.issues ?? [],
        CHANGELOG_CONCURRENCY,
        async (issue) =>
          normalizeIssue(
            await withFullChangelog(issue),
            projectSlug,
            storyPointsField,
            now
          )
      )
      if (docs.length) {
        try {
          await db.collection(JIRA_ISSUES_COLLECTION).bulkWrite(
            docs.map((doc) => ({
              updateOne: {
                filter: { key: doc.key },
                update: { $set: doc },
                upsert: true
              }
            })),
            { ordered: false }
          )
        } catch (err) {
          // Two views upserting the same new key at once: the other write already stored it.
          if (
            !err.writeErrors?.every?.((e) => e.code === DUPLICATE_KEY_ERROR)
          ) {
            throw err
          }
        }
        stored.push(...docs.map((doc) => doc.key))
      }
      nextPageToken = page.isLast === false ? page.nextPageToken : undefined
    } while (nextPageToken)
    return stored
  }

  // Jira Cloud serves unrecognised credentials as anonymous, so a search finds nothing instead of failing.
  async function visibleProjectKeys(keys) {
    const visible = []
    for (const key of keys) {
      if ((visibleUntil.get(key) ?? 0) > Date.now()) {
        visible.push(key)
        continue
      }
      try {
        await jiraRequest(`/rest/api/3/project/${encodeURIComponent(key)}`)
        visibleUntil.set(key, Date.now() + VISIBLE_FOR_MS)
        visible.push(key)
      } catch (err) {
        if (err.status === 401 || err.status === 403) {
          throw new JiraAccessError(
            'Jira rejected the configured credentials. Check JIRA_EMAIL and JIRA_API_TOKEN.',
            'credentials'
          )
        }
        if (err.status !== 404) throw err
        logger.warn(`Jira project ${key} is not visible to the Jira account`)
      }
    }
    if (visible.length === 0) {
      throw new JiraAccessError(
        `Jira project ${keys.join(', ')} is not visible to the Jira account. Check it has Browse Projects.`,
        'not-visible'
      )
    }
    return visible
  }

  /** Fetches and stores the named issues of the project's Jira projects; returns stored and unresolved keys. */
  async function fetchIssuesByKey(
    db,
    { projectSlug, projectKeys = [], issueKeys = [], storyPointsField = null }
  ) {
    const prefixes = projectKeys.filter((k) => JIRA_PROJECT_KEY_PATTERN.test(k))
    const wanted = [...new Set(issueKeys)].filter(
      (k) =>
        JIRA_ISSUE_KEY_PATTERN.test(k) &&
        prefixes.includes(k.slice(0, k.lastIndexOf('-')))
    )
    if (!isConfigured() || wanted.length === 0) {
      return { fetched: [], unresolved: [] }
    }
    const visible = await visibleProjectKeys(prefixes)
    const keys = wanted.filter((k) =>
      visible.includes(k.slice(0, k.lastIndexOf('-')))
    )
    const fetched = []
    const unresolved = wanted.filter((k) => !keys.includes(k))
    for (let i = 0; i < keys.length; i += KEY_BATCH_SIZE) {
      const result = await fetchBatch(
        db,
        projectSlug,
        visible,
        keys.slice(i, i + KEY_BATCH_SIZE),
        storyPointsField
      )
      fetched.push(...result.fetched)
      unresolved.push(...result.unresolved)
    }
    return { fetched, unresolved }
  }

  // Keys are pattern-checked above, so quoting them into JQL is safe.
  async function fetchBatch(
    db,
    projectSlug,
    projectKeys,
    batch,
    storyPointsField,
    retried = false
  ) {
    const jql = `project in (${projectKeys.map(quoted).join(',')}) AND key in (${batch.map(quoted).join(',')})`
    try {
      const stored = await storeMatchingIssues(
        db,
        projectSlug,
        jql,
        storyPointsField
      )
      const got = new Set(stored)
      return { fetched: stored, unresolved: batch.filter((k) => !got.has(k)) }
    } catch (err) {
      if (err.status !== 400) throw err
      const named = new Set(
        (err.jiraMessages ?? []).join(' ').match(/[A-Z][A-Z0-9_]+-\d+/g) ?? []
      )
      const rest = batch.filter((k) => !named.has(k))
      if (retried || named.size === 0 || rest.length === batch.length) {
        logger.warn(`Jira refused a search for ${batch.length} issue key(s)`)
        return { fetched: [], unresolved: batch }
      }
      const retry = rest.length
        ? await fetchBatch(
            db,
            projectSlug,
            projectKeys,
            rest,
            storyPointsField,
            true
          )
        : { fetched: [], unresolved: [] }
      return {
        fetched: retry.fetched,
        unresolved: [...batch.filter((k) => named.has(k)), ...retry.unresolved]
      }
    }
  }

  /** Id of the site's story points field ("Story Points", else "Story point estimate"), or null. */
  async function getStoryPointsFieldId() {
    if (!isConfigured()) return null
    const fields = await jiraRequest('/rest/api/3/field')
    const list = Array.isArray(fields) ? fields : []
    for (const name of STORY_POINT_FIELD_NAMES) {
      const matches = list
        .filter(
          (f) =>
            f?.custom === true &&
            typeof f.id === 'string' &&
            String(f.name ?? '')
              .trim()
              .toLowerCase() === name
        )
        .sort(
          (a, b) =>
            Number(b.schema?.type === 'number') -
            Number(a.schema?.type === 'number')
        )
      if (matches.length) return matches[0].id
    }
    return null
  }

  /** Active and closed sprints of a Jira board, oldest first. */
  async function getBoardSprints(boardId) {
    if (!isConfigured() || !Number.isInteger(boardId) || boardId < 1) return []
    const sprints = []
    for (let startAt = 0; ;) {
      const page = await jiraRequest(
        `/rest/agile/1.0/board/${boardId}/sprint?state=active,closed&maxResults=50&startAt=${startAt}`
      )
      const values = Array.isArray(page?.values) ? page.values : []
      sprints.push(...values)
      if (page?.isLast !== false || values.length === 0) break
      startAt += values.length
    }
    return sprints
  }

  return {
    isConfigured,
    searchIssues,
    fetchIssuesByKey,
    visibleProjectKeys,
    getStoryPointsFieldId,
    getBoardSprints,
    getProjectStatuses
  }
}
