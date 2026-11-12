import { config } from '#/config.js'
import { HTTP_STATUS } from '#/common/constants/http-status.js'
import { createLogger } from '#/common/helpers/logging/logger.js'
import { createProxyDispatcher } from '#/common/helpers/proxy.js'
import { mapWithConcurrency } from '#/common/helpers/concurrency.js'
import { MINUTE_MS, SECOND_MS } from '#/common/helpers/time.js'
import { trimTrailingSlashes } from '#/common/helpers/url.js'
import {
  JIRA_ISSUE_KEY_PATTERN,
  JIRA_PROJECT_KEY_PATTERN
} from '#/schemas/project.js'
import { normalizeIssue } from './jira-issue.js'

export { toJiraIssue } from './jira-issue.js'
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
const VISIBLE_FOR_MINUTES = 10
const VISIBLE_FOR_MS = VISIBLE_FOR_MINUTES * MINUTE_MS
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
const SEARCH_PAGE_SIZE = 50
const SPRINT_PAGE_SIZE = 50
const RETRY_BASE_MS = 500
const RETRY_JITTER = 0.3
const THROTTLED = new Set([
  HTTP_STATUS.tooManyRequests,
  HTTP_STATUS.serviceUnavailable
])
const quoted = (value) => `"${value}"`
const projectKeyOf = (issueKey) => issueKey.slice(0, issueKey.lastIndexOf('-'))

const isPlaceholder = (val) =>
  typeof val === 'string' && val.includes('<') && val.includes('>')

// Issue keys Jira names in its error messages.
const keysIn = (messages) =>
  messages
    .join(' ')
    .split(/[^A-Z0-9_-]+/)
    .filter((token) => JIRA_ISSUE_KEY_PATTERN.test(token))

function retryDelayMs(response, attempt) {
  const header = response.headers.get('retry-after')
  const retryAfter = header === null ? Number.NaN : Number(header)
  if (Number.isFinite(retryAfter) && retryAfter >= 0) {
    return retryAfter * SECOND_MS
  }
  const base = RETRY_BASE_MS * 2 ** attempt
  return base + Math.random() * base * RETRY_JITTER
}

async function jiraError(response) {
  const body =
    response.status === HTTP_STATUS.badRequest
      ? await response.json().catch(() => ({}))
      : {}
  return Object.assign(
    new Error(`Jira API error: ${response.status} ${response.statusText}`),
    {
      status: response.status,
      jiraMessages: Array.isArray(body.errorMessages)
        ? body.errorMessages.map(String)
        : []
    }
  )
}

/**
 * One Jira Cloud request. A 429 or 503 is retried up to `retries` times,
 * honouring `Retry-After`, otherwise backing off exponentially with jitter.
 */
function createRequester(settings) {
  const { apiBase, email, apiToken, requestTimeoutMs, dispatcher } = settings
  const { fetch, sleep, retries, logger } = settings
  const auth = Buffer.from(`${email}:${apiToken}`).toString('base64')
  const request = async (pathname, init = {}, attempt = 0) => {
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
    if (response.ok) {
      return response.json()
    }
    if (!THROTTLED.has(response.status) || attempt >= retries) {
      throw await jiraError(response)
    }
    const delay = retryDelayMs(response, attempt)
    logger.warn(
      `Jira returned ${response.status}; retrying in ${Math.round(delay)} ms`
    )
    await sleep(delay)
    return request(pathname, init, attempt + 1)
  }
  return request
}

// Every `values` entry of a startAt-paged Jira endpoint.
async function collectPages(load, startAt = 0) {
  const page = await load(startAt)
  const values = Array.isArray(page?.values) ? page.values : []
  if (page?.isLast !== false || values.length === 0) {
    return values
  }
  return [...values, ...(await collectPages(load, startAt + values.length))]
}

async function searchIssues(ctx, jql, searchOptions = {}) {
  if (!ctx.isConfigured()) {
    return { issues: [], isLast: true, total: 0 }
  }
  const {
    nextPageToken,
    maxResults = SEARCH_PAGE_SIZE,
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
  return ctx.request('/rest/api/3/search/jql', {
    method: 'POST',
    body: JSON.stringify(body)
  })
}

async function withFullChangelog(ctx, issue) {
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
  const all = await collectPages((startAt) =>
    ctx.request(
      `/rest/api/3/issue/${encodeURIComponent(issue.key)}/changelog?startAt=${startAt}&maxResults=${PAGE_SIZE}`
    )
  )
  return { ...issue, changelog: { ...issue.changelog, histories: all } }
}

/** Statuses of a Jira project across its issue types, with their categories. */
async function getProjectStatuses(ctx, projectKey) {
  if (!ctx.isConfigured() || !JIRA_PROJECT_KEY_PATTERN.test(projectKey ?? '')) {
    return []
  }
  const types = await ctx.request(
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

async function upsertIssues(db, docs) {
  if (docs.length === 0) {
    return
  }
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
    if (!err.writeErrors?.every?.((e) => e.code === DUPLICATE_KEY_ERROR)) {
      throw err
    }
  }
}

async function storeMatchingIssues(ctx, db, query, nextPageToken) {
  const { projectSlug, jql, storyPointsField } = query
  const page = await searchIssues(ctx, jql, {
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
        await withFullChangelog(ctx, issue),
        projectSlug,
        storyPointsField,
        now
      )
  )
  await upsertIssues(db, docs)
  const stored = docs.map((doc) => doc.key)
  if (page.isLast !== false || !page.nextPageToken) {
    return stored
  }
  return [
    ...stored,
    ...(await storeMatchingIssues(ctx, db, query, page.nextPageToken))
  ]
}

async function isVisible(ctx, key) {
  if ((ctx.visibleUntil.get(key) ?? 0) > Date.now()) {
    return true
  }
  try {
    await ctx.request(`/rest/api/3/project/${encodeURIComponent(key)}`)
    ctx.visibleUntil.set(key, Date.now() + VISIBLE_FOR_MS)
    return true
  } catch (err) {
    if (
      err.status === HTTP_STATUS.unauthorized ||
      err.status === HTTP_STATUS.forbidden
    ) {
      throw new JiraAccessError(
        'Jira rejected the configured credentials. Check JIRA_EMAIL and JIRA_API_TOKEN.',
        'credentials'
      )
    }
    if (err.status !== HTTP_STATUS.notFound) {
      throw err
    }
    ctx.logger.warn(`Jira project ${key} is not visible to the Jira account`)
    return false
  }
}

// Jira Cloud serves unrecognised credentials as anonymous, so a search finds nothing instead of failing.
async function visibleProjectKeys(ctx, keys) {
  const flags = await Promise.all(keys.map((key) => isVisible(ctx, key)))
  const visible = keys.filter((_, i) => flags[i])
  if (visible.length === 0) {
    throw new JiraAccessError(
      `Jira project ${keys.join(', ')} is not visible to the Jira account. Check it has Browse Projects.`,
      'not-visible'
    )
  }
  return visible
}

// Keys are pattern-checked by the caller, so quoting them into JQL is safe.
async function fetchBatch(ctx, db, query, batch, retried = false) {
  const { projectSlug, projectKeys, storyPointsField } = query
  const jql = `project in (${projectKeys.map(quoted).join(',')}) AND key in (${batch.map(quoted).join(',')})`
  try {
    const stored = await storeMatchingIssues(ctx, db, {
      projectSlug,
      jql,
      storyPointsField
    })
    const got = new Set(stored)
    return { fetched: stored, unresolved: batch.filter((k) => !got.has(k)) }
  } catch (err) {
    if (err.status !== HTTP_STATUS.badRequest) {
      throw err
    }
    return retryWithoutNamedKeys(ctx, db, query, batch, retried, err)
  }
}

// Jira refuses a whole search over one bad key; retry once without the keys it names.
async function retryWithoutNamedKeys(ctx, db, query, batch, retried, err) {
  const named = new Set(keysIn(err.jiraMessages ?? []))
  const rest = batch.filter((k) => !named.has(k))
  if (retried || named.size === 0 || rest.length === batch.length) {
    ctx.logger.warn(`Jira refused a search for ${batch.length} issue key(s)`)
    return { fetched: [], unresolved: batch }
  }
  const retry = rest.length
    ? await fetchBatch(ctx, db, query, rest, true)
    : { fetched: [], unresolved: [] }
  return {
    fetched: retry.fetched,
    unresolved: [...batch.filter((k) => named.has(k)), ...retry.unresolved]
  }
}

/** Fetches and stores the named issues of the project's Jira projects; returns stored and unresolved keys. */
async function fetchIssuesByKey(
  ctx,
  db,
  { projectSlug, projectKeys = [], issueKeys = [], storyPointsField = null }
) {
  const prefixes = projectKeys.filter((k) => JIRA_PROJECT_KEY_PATTERN.test(k))
  const wanted = [...new Set(issueKeys)].filter(
    (k) => JIRA_ISSUE_KEY_PATTERN.test(k) && prefixes.includes(projectKeyOf(k))
  )
  if (!ctx.isConfigured() || wanted.length === 0) {
    return { fetched: [], unresolved: [] }
  }
  const visible = await visibleProjectKeys(ctx, prefixes)
  const keys = wanted.filter((k) => visible.includes(projectKeyOf(k)))
  const batches = Array.from(
    { length: Math.ceil(keys.length / KEY_BATCH_SIZE) },
    (_, i) => keys.slice(i * KEY_BATCH_SIZE, (i + 1) * KEY_BATCH_SIZE)
  )
  const query = { projectSlug, projectKeys: visible, storyPointsField }
  const results = await mapWithConcurrency(batches, 1, (batch) =>
    fetchBatch(ctx, db, query, batch)
  )
  return {
    fetched: results.flatMap((r) => r.fetched),
    unresolved: [
      ...wanted.filter((k) => !keys.includes(k)),
      ...results.flatMap((r) => r.unresolved)
    ]
  }
}

const isStoryPointsField = (name) => (f) =>
  f?.custom === true &&
  typeof f.id === 'string' &&
  String(f.name ?? '')
    .trim()
    .toLowerCase() === name

/** Id of the site's story points field ("Story Points", else "Story point estimate"), or null. */
async function getStoryPointsFieldId(ctx) {
  if (!ctx.isConfigured()) {
    return null
  }
  const fields = await ctx.request('/rest/api/3/field')
  const list = Array.isArray(fields) ? fields : []
  const numericFirst = (a, b) =>
    Number(b.schema?.type === 'number') - Number(a.schema?.type === 'number')
  const match = STORY_POINT_FIELD_NAMES.map(
    (name) => list.filter(isStoryPointsField(name)).sort(numericFirst)[0]
  ).find(Boolean)
  return match?.id ?? null
}

/** Active and closed sprints of a Jira board, oldest first. */
async function getBoardSprints(ctx, boardId) {
  if (!ctx.isConfigured() || !Number.isInteger(boardId) || boardId < 1) {
    return []
  }
  return collectPages((startAt) =>
    ctx.request(
      `/rest/agile/1.0/board/${boardId}/sprint?state=active,closed&maxResults=${SPRINT_PAGE_SIZE}&startAt=${startAt}`
    )
  )
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

  const isConfigured = () =>
    [baseUrl, email, apiToken].every(
      (value) => Boolean(value?.trim()) && !isPlaceholder(value)
    )
  const ctx = {
    isConfigured,
    logger,
    visibleUntil: new Map(),
    request: createRequester({
      apiBase: baseUrl ? trimTrailingSlashes(baseUrl) : '',
      email,
      apiToken,
      requestTimeoutMs,
      dispatcher,
      fetch,
      sleep,
      retries,
      logger
    })
  }

  return {
    isConfigured,
    searchIssues: (jql, searchOptions) => searchIssues(ctx, jql, searchOptions),
    fetchIssuesByKey: (db, request) => fetchIssuesByKey(ctx, db, request),
    visibleProjectKeys: (keys) => visibleProjectKeys(ctx, keys),
    getStoryPointsFieldId: () => getStoryPointsFieldId(ctx),
    getBoardSprints: (boardId) => getBoardSprints(ctx, boardId),
    getProjectStatuses: (projectKey) => getProjectStatuses(ctx, projectKey)
  }
}
