// Converts Jira API issues and stored issue documents to and from the storage shape.

const toIso = (val) => (val instanceof Date ? val.toISOString() : val)
const toDate = (val) => (val ? new Date(val) : null)

const ISO_FIELDS = ['created', 'resolved', 'updated', 'syncedAt', 'fetchedAt']

// Formats a stored Jira issue document for API callers.
export function toJiraIssue(doc) {
  if (!doc) {
    return null
  }
  const { _id, ...rest } = doc
  const dates = Object.fromEntries(
    ISO_FIELDS.filter((field) => rest[field]).map((field) => [
      field,
      toIso(rest[field])
    ])
  )
  const flow = rest.flow && {
    flow: {
      ...rest.flow,
      startedAt: toIso(rest.flow.startedAt),
      doneAt: toIso(rest.flow.doneAt),
      firstDoneAt: toIso(rest.flow.firstDoneAt)
    }
  }
  return { ...rest, ...dates, ...flow }
}

const changeItems = (histories) =>
  histories.flatMap((h) => (h.items ?? []).map((item) => ({ h, item })))

// Jira clears the resolution whenever an issue leaves Done, so each cleared
// resolution in the changelog is one reopen.
function countReopens(histories) {
  return changeItems(histories).filter(
    ({ item }) =>
      item.field === 'resolution' && item.from !== null && item.to === null
  ).length
}

// Status transitions oldest first; the changelog carries names, not categories.
function statusHistory(histories) {
  return changeItems(histories)
    .filter(({ h, item }) => item.field === 'status' && h.created)
    .map(({ h, item }) => ({
      at: toDate(h.created),
      from: item.fromString ?? '',
      to: item.toString ?? ''
    }))
    .sort((a, b) => a.at - b.at)
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
      if (!other?.key) {
        return null
      }
      return {
        key: other.key,
        type: link.type?.name ?? '',
        direction: link.inwardIssue ? 'inward' : 'outward',
        issueType: other.fields?.issuetype?.name ?? ''
      }
    })
    .filter(Boolean)
}

// Story points arrive as a number, or as a numeric string from some sites.
function toStoryPoints(raw) {
  if (typeof raw === 'number') {
    return raw
  }
  const numeric =
    typeof raw === 'string' && raw.trim() !== '' && Number.isFinite(Number(raw))
  return numeric ? Number(raw) : null
}

const categoryOf = (status) =>
  (status?.statusCategory?.key ?? status?.categoryKey ?? '').toLowerCase()

const parentOf = (parent) => ({
  parentKey: parent?.key ?? null,
  parentIssueType: parent?.fields?.issuetype?.name ?? null
})

const describe = (f) => ({
  summary: f.summary ?? '',
  issueType: f.issuetype?.name ?? 'Story',
  priority: f.priority?.name ?? '',
  status: { name: f.status?.name ?? '', categoryKey: categoryOf(f.status) }
})

function fromJiraFields(issue, projectSlug, storyPointsField, now) {
  const f = issue.fields
  const histories = issue.changelog?.histories || []
  return {
    key: issue.key,
    projectSlug,
    ...describe(f),
    created: toDate(f.created),
    resolved: toDate(f.resolutiondate || f.resolved),
    storyPoints: toStoryPoints(storyPointsField ? f[storyPointsField] : null),
    updated: toDate(f.updated) || new Date(),
    reopenCount: countReopens(histories),
    statusHistory: statusHistory(histories),
    firstDoneAt: firstDoneAt(histories),
    issueLinks: issueLinks(f.issuelinks),
    ...parentOf(f.parent),
    storyPointsField: storyPointsField ?? null,
    fetchedAt: now,
    syncedAt: now
  }
}

// Normalises Jira API issue fields or plain objects into the storage shape.
export function normalizeIssue(issue, projectSlug, storyPointsField, now) {
  if (issue.fields) {
    return fromJiraFields(issue, projectSlug, storyPointsField, now)
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
