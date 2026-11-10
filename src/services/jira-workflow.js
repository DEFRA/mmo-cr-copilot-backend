import Boom from '@hapi/boom'

import { JIRA_PROJECT_KEY_PATTERN } from '#/schemas/project.js'
import { loadScopedIssues } from '#/services/jira-scope.js'
import { PROJECTS_COLLECTION } from '#/services/projects.js'
import {
  MAX_DETECTED_STATUSES,
  MAX_STATUS_LENGTH,
  STAGE_IDS,
  normaliseStatus,
  tidyStatus
} from '#/services/workflow-stages.js'

const CATEGORY_ORDER = { new: 0, indeterminate: 1, done: 2 }
const categoryRank = (key) => CATEGORY_ORDER[key] ?? 3
const projectKeysOf = (project) =>
  (project?.jira?.projectKeys ?? []).filter((key) =>
    JIRA_PROJECT_KEY_PATTERN.test(key)
  )

/**
 * Saves a project's workflow if it is still at `version` (0 when nothing is
 * saved), so two admins editing at once cannot overwrite each other.
 */
export async function saveProjectWorkflow(
  db,
  slug,
  { version, stages },
  actor
) {
  const now = new Date()
  const next = {
    version: version + 1,
    stages: STAGE_IDS.map((id) => ({
      id,
      statuses: stages.find((s) => s.id === id)?.statuses ?? []
    })),
    updatedAt: now,
    updatedBy: actor
  }
  const filter =
    version === 0
      ? {
          slug,
          archivedAt: null,
          'jira.statusMapping.version': { $exists: false }
        }
      : { slug, archivedAt: null, 'jira.statusMapping.version': version }
  const before = await db
    .collection(PROJECTS_COLLECTION)
    .findOneAndUpdate(
      filter,
      { $set: { 'jira.statusMapping': next, updatedAt: now } },
      { returnDocument: 'before' }
    )
  if (!before) {
    const active = await db
      .collection(PROJECTS_COLLECTION)
      .findOne({ slug, archivedAt: null }, { projection: { _id: 1 } })
    if (!active) throw Boom.notFound(`Project '${slug}' not found`)
    throw Boom.conflict(
      'The Jira workflow was changed by someone else. Reload to see the latest version.'
    )
  }
  const previous = before.jira?.statusMapping
  return {
    before: Number.isInteger(previous?.version) ? previous : null,
    after: next
  }
}

/**
 * The statuses of the project's Jira projects as `{ name, categoryKey }`,
 * unique by name, or null when Jira could not be asked.
 */
export async function detectProjectStatuses(client, project, logger) {
  try {
    const detected = []
    const seen = new Set()
    for (const key of projectKeysOf(project)) {
      for (const status of await client.getProjectStatuses(key)) {
        const name = tidyStatus(status.name)
        const normalised = normaliseStatus(name)
        if (!name || name.length > MAX_STATUS_LENGTH || seen.has(normalised)) {
          continue
        }
        seen.add(normalised)
        detected.push({ name, categoryKey: status.categoryKey ?? null })
        if (detected.length >= MAX_DETECTED_STATUSES) return detected
      }
    }
    return detected
  } catch (err) {
    logger.warn(
      { err },
      `Could not detect Jira statuses for project ${project?.slug}`
    )
    return null
  }
}

async function observedStatuses(db, project) {
  const { issues } = await loadScopedIssues(db, project)
  const current = new Map()
  const history = new Set()
  for (const issue of issues) {
    const name = issue.status?.name
    if (name) {
      const entry = current.get(name) ?? {
        name,
        categoryKey: issue.status.categoryKey,
        issueCount: 0
      }
      entry.issueCount += 1
      current.set(name, entry)
    }
    for (const change of issue.statusHistory ?? []) {
      if (change.from) history.add(change.from)
      if (change.to) history.add(change.to)
    }
  }
  return [
    ...current.values(),
    ...[...history].map((name) => ({ name, issueCount: 0 }))
  ]
}

async function liveJiraStatuses(project, client, logger) {
  if (!client?.isConfigured()) {
    return { jiraConfigured: false, jiraAvailable: false, statuses: [] }
  }
  try {
    const statuses = []
    for (const key of projectKeysOf(project)) {
      statuses.push(...(await client.getProjectStatuses(key)))
    }
    return { jiraConfigured: true, jiraAvailable: true, statuses }
  } catch (err) {
    logger.warn({ err }, 'Jira project statuses unavailable')
    return { jiraConfigured: true, jiraAvailable: false, statuses: [] }
  }
}

/**
 * Every status known for a project: seen on stored issues, detected at the
 * last sync, and live from Jira when it can be reached.
 */
export async function listProjectStatuses(db, project, client, logger) {
  const [observed, live] = await Promise.all([
    observedStatuses(db, project),
    liveJiraStatuses(project, client, logger)
  ])
  const merged = new Map()
  const entry = (rawName) => {
    const name = tidyStatus(rawName)
    const key = normaliseStatus(name)
    if (!name || name.length > MAX_STATUS_LENGTH) return null
    if (!merged.has(key)) {
      merged.set(key, {
        name,
        categoryKey: null,
        issueTypes: new Set(),
        inJira: false,
        issueCount: 0
      })
    }
    return merged.get(key)
  }
  const fromJira = (status) => {
    const found = entry(status.name)
    if (!found) return
    if (!found.inJira) found.name = tidyStatus(status.name)
    found.inJira = true
    if (CATEGORY_ORDER[status.categoryKey] !== undefined) {
      found.categoryKey = status.categoryKey
    }
    if (status.issueType) found.issueTypes.add(status.issueType)
  }

  live.statuses.forEach(fromJira)
  ;(project.jira?.detectedStatuses ?? []).forEach(fromJira)
  for (const status of observed) {
    const found = entry(status.name)
    if (!found) continue
    found.issueCount += status.issueCount
    if (
      !found.categoryKey &&
      CATEGORY_ORDER[status.categoryKey] !== undefined
    ) {
      found.categoryKey = status.categoryKey
    }
  }

  const statuses = [...merged.values()]
    .map((s) => ({ ...s, issueTypes: [...s.issueTypes].sort() }))
    .sort(
      (a, b) =>
        categoryRank(a.categoryKey) - categoryRank(b.categoryKey) ||
        a.name.localeCompare(b.name)
    )
    .slice(0, MAX_DETECTED_STATUSES)
  return {
    jiraConfigured: live.jiraConfigured,
    jiraAvailable: live.jiraAvailable,
    statuses
  }
}
