import {
  JIRA_ISSUE_KEY_PATTERN,
  JIRA_PROJECT_KEY_PATTERN
} from '#/schemas/project.js'
import { JIRA_ISSUES_COLLECTION, toJiraIssue } from '#/services/jira.js'
import { PR_JIRA_LINKS_COLLECTION } from '#/services/pr-jira-links.js'
import { PAYLOADS_COLLECTION } from '#/services/payloads.js'
import { findProjectPayloads } from '#/services/projects.js'
import { attachIssueFlow } from '#/services/workflow-stages.js'

export const isStoryType = (type) =>
  /^(user )?story$/i.test(String(type ?? '').trim())
export const isBugType = (type) => /bug|defect/i.test(String(type ?? ''))
export const issueKeyPrefix = (key) => key.slice(0, key.lastIndexOf('-'))
export const prId = (repository, prNumber) => `${repository}#${prNumber}`
export function parsePrId(id) {
  const at = id.lastIndexOf('#')
  return { repository: id.slice(0, at), prNumber: Number(id.slice(at + 1)) }
}

export const projectJiraKeys = (project) =>
  (project?.jira?.projectKeys ?? []).filter((key) =>
    JIRA_PROJECT_KEY_PATTERN.test(key)
  )

/** Well-formed issue keys in the project's Jira projects; any well-formed key when it has none. */
export function inProjectKeys(keys, project) {
  const allowed = new Set(projectJiraKeys(project))
  return [...new Set(keys ?? [])].filter(
    (key) =>
      typeof key === 'string' &&
      JIRA_ISSUE_KEY_PATTERN.test(key) &&
      (allowed.size === 0 || allowed.has(issueKeyPrefix(key)))
  )
}

const LINK_PROJECTION = { _id: 0, jiraKey: 1, repository: 1, prNumber: 1 }

/**
 * Map of issue key to the PR ids that reference it, from payload keys and
 * pr-jira-links. With a window, only PRs active in it; otherwise all time.
 */
export async function referencedKeys(db, project, { from, to } = {}) {
  const links = db.collection(PR_JIRA_LINKS_COLLECTION)
  let payloadRows
  let linkRows
  if (from || to) {
    payloadRows = await findProjectPayloads(db, project.slug, { from, to })
    linkRows =
      payloadRows.length === 0
        ? []
        : await links
            .find(
              {
                projectSlug: project.slug,
                $or: payloadRows.map((p) => ({
                  repository: p.repository,
                  prNumber: p.prNumber
                }))
              },
              { projection: LINK_PROJECTION }
            )
            .toArray()
  } else {
    ;[payloadRows, linkRows] = await Promise.all([
      db
        .collection(PAYLOADS_COLLECTION)
        .find(
          { projectSlug: project.slug, 'jiraKeys.0': { $exists: true } },
          { projection: { _id: 0, repository: 1, prNumber: 1, jiraKeys: 1 } }
        )
        .toArray(),
      links
        .find({ projectSlug: project.slug }, { projection: LINK_PROJECTION })
        .toArray()
    ])
  }
  const byKey = new Map()
  const add = (key, id) => {
    if (!byKey.has(key)) byKey.set(key, new Set())
    byKey.get(key).add(id)
  }
  for (const row of payloadRows) {
    for (const key of inProjectKeys(row.jiraKeys, project)) {
      add(key, prId(row.repository, row.prNumber))
    }
  }
  for (const row of linkRows) {
    for (const key of inProjectKeys([row.jiraKey], project)) {
      add(key, prId(row.repository, row.prNumber))
    }
  }
  return byKey
}

/** Stored issues the project's PRs reference plus their Story or Bug parents, each with flow. */
export async function loadScopedIssues(db, project, now = new Date()) {
  const prsByKey = await referencedKeys(db, project)
  const collection = db.collection(JIRA_ISSUES_COLLECTION)
  const projection = { projection: { _id: 0 } }
  const referenced = prsByKey.size
    ? await collection
        .find({ key: { $in: [...prsByKey.keys()] } }, projection)
        .toArray()
    : []
  const have = new Set(referenced.map((doc) => doc.key))
  const parentKeys = inProjectKeys(
    referenced
      .filter((doc) => doc.parentKey && !have.has(doc.parentKey))
      .filter(
        (doc) =>
          isStoryType(doc.parentIssueType) || isBugType(doc.parentIssueType)
      )
      .map((doc) => doc.parentKey),
    project
  )
  const parents = parentKeys.length
    ? await collection.find({ key: { $in: parentKeys } }, projection).toArray()
    : []
  const { workflow, issues } = attachIssueFlow(
    [...referenced, ...parents],
    project,
    now
  )
  return { workflow, issues, prsByKey }
}

/** The Story or Bug key a referenced issue is delivered as, or null. */
export function deliveryUnitKey(issue, byKey) {
  if (isStoryType(issue.issueType) || isBugType(issue.issueType)) {
    return issue.key
  }
  const parent = issue.parentKey ? byKey.get(issue.parentKey) : null
  if (
    parent &&
    (isStoryType(parent.issueType) || isBugType(parent.issueType))
  ) {
    return parent.key
  }
  return null
}

const time = (value) => (value ? new Date(value).getTime() : 0)

/** A project's PR-scoped Jira issues, newest resolved first, each with its flow. */
export async function listProjectJiraIssues(db, project) {
  const { issues } = await loadScopedIssues(db, project)
  return issues
    .sort(
      (a, b) =>
        time(b.resolved) - time(a.resolved) || time(b.updated) - time(a.updated)
    )
    .map(toJiraIssue)
}
