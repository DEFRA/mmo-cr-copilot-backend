import { config } from '#/config.js'
import { createLogger } from '#/common/helpers/logging/logger.js'
import { createProxyDispatcher } from '#/common/helpers/proxy.js'
import { JIRA_PROJECT_KEY_PATTERN } from '#/schemas/project.js'
import { attachIssueFlow } from '#/services/workflow-stages.js'

export {
  PR_JIRA_LINKS_COLLECTION,
  linkPrsToJiraIssues
} from './pr-jira-links.js'
export const JIRA_ISSUES_COLLECTION = 'jira-issues'

const JIRA_ISSUE_KEY = /^[A-Z][A-Z0-9_]+-\d+$/
const STATUS_CATEGORIES = new Set(['new', 'indeterminate', 'done'])

// JQL date literals take "yyyy/MM/dd HH:mm" (UTC here).
function jqlDateTime(date) {
  const iso = date.toISOString()
  return `${iso.slice(0, 10).replaceAll('-', '/')} ${iso.slice(11, 16)}`
}

const isPlaceholder = (val) =>
  typeof val === 'string' && val.includes('<') && val.includes('>')

const toIso = (val) => (val instanceof Date ? val.toISOString() : val)
const toDate = (val) => (val ? new Date(val) : null)

// Formats a stored Jira issue document for API callers.
function toJiraIssue(doc) {
  if (!doc) return null
  const { _id, ...rest } = doc
  return {
    ...rest,
    ...(rest.created ? { created: toIso(rest.created) } : {}),
    ...(rest.resolved ? { resolved: toIso(rest.resolved) } : {}),
    ...(rest.updated ? { updated: toIso(rest.updated) } : {}),
    ...(rest.syncedAt ? { syncedAt: toIso(rest.syncedAt) } : {}),
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
function normalizeIssue(issue, projectSlug, storyPointsField) {
  if (issue.fields) {
    const f = issue.fields
    const histories = issue.changelog?.histories || []
    const spRaw = f[storyPointsField] ?? f.customfield_10016 ?? f.storyPoints
    const sp = typeof spRaw === 'number' ? spRaw : Number(spRaw) || null

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
      syncedAt: new Date()
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

// A project's Jira issues, newest resolved first, each with its flow under the project's workflow.
export async function listProjectJiraIssues(db, projectSlug, project = null) {
  const docs = await db
    .collection(JIRA_ISSUES_COLLECTION)
    .find({ projectSlug })
    .sort({ resolved: -1, updated: -1 })
    .toArray()

  const { issues } = attachIssueFlow(docs, project)
  return issues.map(toJiraIssue)
}

// Creates a Jira Cloud client instance for issue search and project sync.
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
        throw new Error(
          `Jira API error: ${response.status} ${response.statusText}`
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
      !JIRA_ISSUE_KEY.test(issue.key ?? '') ||
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
    let pageToken
    let totalSynced = 0

    do {
      const result = await searchIssues(jql, {
        nextPageToken: pageToken,
        maxResults: 50,
        fields: [
          'summary',
          'status',
          'issuetype',
          'created',
          'resolutiondate',
          'resolved',
          'updated',
          'issuelinks',
          'priority',
          storyPointsField
        ],
        expand: 'changelog'
      })

      const issues = result.issues || []
      for (const issue of issues) {
        const doc = normalizeIssue(
          await withFullChangelog(issue),
          projectSlug,
          storyPointsField
        )
        await db
          .collection(JIRA_ISSUES_COLLECTION)
          .updateOne({ key: doc.key }, { $set: doc }, { upsert: true })
        totalSynced += 1
      }

      if (result.isLast || !result.nextPageToken) {
        break
      }
      pageToken = result.nextPageToken
    } while (pageToken)

    return totalSynced
  }

  /**
   * Stores every issue of the project's Jira projects, or only those updated
   * since `updatedSince` for an incremental sync.
   */
  async function syncProjectIssues(
    db,
    projectSlug,
    projectKeys = [],
    storyPointsField = 'customfield_10016',
    { updatedSince } = {}
  ) {
    if (!isConfigured()) {
      return {
        synced: 0,
        configured: false,
        message: 'Jira integration is not configured'
      }
    }

    // Keys are interpolated into JQL, so anything but a plain project key is dropped.
    const keys = (projectKeys ?? []).filter((k) =>
      JIRA_PROJECT_KEY_PATTERN.test(k)
    )
    if (keys.length === 0) {
      return {
        synced: 0,
        configured: true,
        message: 'No Jira project keys configured'
      }
    }

    const since = updatedSince
      ? ` AND updated >= "${jqlDateTime(new Date(updatedSince))}"`
      : ''
    const jql = `project in (${keys.map((k) => `"${k}"`).join(',')})${since} ORDER BY updated DESC`
    const synced = await storeMatchingIssues(
      db,
      projectSlug,
      jql,
      storyPointsField
    )

    logger.info(`Synced ${synced} Jira issue(s) for project '${projectSlug}'`)
    return { synced, configured: true }
  }

  /** Fetches and stores specific issues, such as keys first seen at ingest. */
  async function syncIssuesByKey(
    db,
    projectSlug,
    issueKeys = [],
    storyPointsField = 'customfield_10016'
  ) {
    const keys = [...new Set(issueKeys)].filter((k) => JIRA_ISSUE_KEY.test(k))
    if (!isConfigured() || keys.length === 0) return { synced: 0 }
    const jql = `key in (${keys.map((k) => `"${k}"`).join(',')})`
    return {
      synced: await storeMatchingIssues(db, projectSlug, jql, storyPointsField)
    }
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
    syncProjectIssues,
    syncIssuesByKey,
    getBoardSprints,
    getProjectStatuses,
    listProjectJiraIssues: (db, slug, project) =>
      listProjectJiraIssues(db, slug, project)
  }
}
