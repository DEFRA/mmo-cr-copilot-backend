import { config } from '#/config.js'
import { TIMED_OUT, withinBudget } from '#/common/helpers/concurrency.js'
import { JIRA_ISSUES_COLLECTION, JiraAccessError } from '#/services/jira.js'
import { detectProjectStatuses } from '#/services/jira-workflow.js'
import { PROJECTS_COLLECTION, findProject } from '#/services/projects.js'
import {
  inProjectKeys,
  isBugType,
  isStoryType,
  projectJiraKeys,
  referencedKeys
} from '#/services/jira-scope.js'
import { attachIssueFlow } from '#/services/workflow-stages.js'

export const JIRA_UNRESOLVED_KEYS_COLLECTION = 'jira-unresolved-keys'
const SPRINT_SCOPE_COLLECTION = 'jira-sprint-scope'
const DUPLICATE_KEY_ERROR = 11000
const DETECT_EVERY_MS = 24 * 60 * 60 * 1000
const SCOPE_CHECK_EVERY_MS = 60 * 60 * 1000
const SETTLE_MS = 5000

const inflightWindows = new Map()
const inflightKeys = new Set()
const background = new Set()
const lastScopeCheck = new Map()

const NOT_CONFIGURED = {
  configured: false,
  stale: false,
  pending: false,
  error: null,
  refreshedAt: null
}
const time = (value) => (value ? new Date(value).getTime() : 0)

/** Keys to fetch, most urgent first, at most `maxKeys` (ADR 0012). */
export function planIssueRefresh({
  windowKeys,
  otherKeys,
  docsByKey,
  doneKeys,
  unresolved,
  storyPointsField,
  now,
  freshMs,
  maxKeys
}) {
  const needsRefetch = (key) => {
    const doc = docsByKey.get(key)
    return (
      !doc ||
      !doc.fetchedAt ||
      (doc.storyPointsField ?? null) !== (storyPointsField ?? null)
    )
  }
  const staleOpen = (key) =>
    docsByKey.has(key) &&
    !doneKeys.has(key) &&
    now.getTime() - time(docsByKey.get(key).fetchedAt) > freshMs
  const tiers = [
    windowKeys.filter(needsRefetch),
    windowKeys.filter(staleOpen),
    otherKeys.filter(staleOpen),
    otherKeys.filter(needsRefetch)
  ]
  const plan = []
  const seen = new Set()
  for (const key of tiers.flat()) {
    if (seen.has(key) || unresolved.has(key)) continue
    seen.add(key)
    plan.push(key)
    if (plan.length >= maxKeys) break
  }
  return plan
}

async function recordUnresolved(db, projectSlug, keys, now) {
  if (keys.length === 0) return
  await db.collection(JIRA_UNRESOLVED_KEYS_COLLECTION).bulkWrite(
    keys.map((key) => ({
      updateOne: {
        filter: { key },
        update: { $set: { key, projectSlug, checkedAt: now } },
        upsert: true
      }
    })),
    { ordered: false }
  )
}

async function fetchClaimed({ db, client, project, field, keys, now }) {
  const claimed = keys.filter((key) => !inflightKeys.has(key))
  if (claimed.length === 0) return []
  claimed.forEach((key) => inflightKeys.add(key))
  try {
    const { fetched, unresolved } = await client.fetchIssuesByKey(db, {
      projectSlug: project.slug,
      projectKeys: projectJiraKeys(project),
      issueKeys: claimed,
      storyPointsField: field
    })
    await recordUnresolved(db, project.slug, unresolved, now)
    return fetched
  } finally {
    claimed.forEach((key) => inflightKeys.delete(key))
  }
}

async function refreshKeys({
  db,
  client,
  project,
  field,
  windowKeys,
  otherKeys,
  now
}) {
  const all = [...windowKeys, ...otherKeys]
  if (all.length === 0) return []
  const [docs, unresolved] = await Promise.all([
    db
      .collection(JIRA_ISSUES_COLLECTION)
      .find({ key: { $in: all } }, { projection: { _id: 0 } })
      .toArray(),
    db
      .collection(JIRA_UNRESOLVED_KEYS_COLLECTION)
      .find({ key: { $in: all } }, { projection: { _id: 0, key: 1 } })
      .toArray()
  ])
  const { issues } = attachIssueFlow(docs, project, now)
  const plan = planIssueRefresh({
    windowKeys,
    otherKeys,
    docsByKey: new Map(docs.map((doc) => [doc.key, doc])),
    doneKeys: new Set(
      issues.filter((i) => i.flow.stageKind === 'done').map((i) => i.key)
    ),
    unresolved: new Set(unresolved.map((doc) => doc.key)),
    storyPointsField: field,
    now,
    freshMs: config.get('jira.freshnessMinutes') * 60 * 1000,
    maxKeys: config.get('jira.lazyFetchMaxKeys')
  })
  return fetchClaimed({ db, client, project, field, keys: plan, now })
}

async function refreshParents({ db, client, project, field, keys, now }) {
  if (keys.length === 0) return []
  const children = await db
    .collection(JIRA_ISSUES_COLLECTION)
    .find(
      { key: { $in: keys }, parentKey: { $type: 'string' } },
      { projection: { _id: 0, parentKey: 1, parentIssueType: 1 } }
    )
    .toArray()
  const parentKeys = inProjectKeys(
    children
      .filter(
        (c) => isStoryType(c.parentIssueType) || isBugType(c.parentIssueType)
      )
      .map((c) => c.parentKey),
    project
  )
  return refreshKeys({
    db,
    client,
    project,
    field,
    windowKeys: parentKeys,
    otherKeys: [],
    now
  })
}

/** The project's story points field: the admin's choice, else detected from Jira at most daily. */
export async function resolveStoryPointsField({
  db,
  client,
  project,
  logger,
  now = new Date()
}) {
  const jira = project.jira ?? {}
  const current = jira.storyPointsField ?? null
  if (jira.storyPointsFieldSource === 'admin') return current
  const detectedAt = time(jira.storyPointsFieldDetectedAt)
  if (detectedAt && now.getTime() - detectedAt < DETECT_EVERY_MS) return current
  try {
    const detected = await client.getStoryPointsFieldId()
    await db.collection(PROJECTS_COLLECTION).updateOne(
      { slug: project.slug, 'jira.storyPointsFieldSource': { $ne: 'admin' } },
      {
        $set: {
          'jira.storyPointsField': detected,
          'jira.storyPointsFieldSource': 'detected',
          'jira.storyPointsFieldDetectedAt': now
        }
      }
    )
    if (!detected) {
      logger.warn(
        `No story points field found in Jira for project ${project.slug}`
      )
    }
    return detected
  } catch (err) {
    logger.warn(
      { err },
      `Could not detect the Jira story points field for project ${project.slug}`
    )
    return current
  }
}

/**
 * Records the issues in each active sprint the first time it is seen, so
 * sprint predictability compares delivery against the scope committed at start.
 */
export async function captureSprintScope({ db, client, project }) {
  const sprints = await client.getBoardSprints(project.jira.boardId)
  const scope = db.collection(SPRINT_SCOPE_COLLECTION)
  for (const sprint of sprints) {
    if (sprint.state !== 'active' || !Number.isInteger(sprint.id)) continue
    if (await scope.findOne({ sprintId: sprint.id })) continue

    const issueKeys = []
    let nextPageToken
    do {
      const page = await client.searchIssues(`sprint = ${sprint.id}`, {
        fields: ['key'],
        expand: '',
        nextPageToken
      })
      issueKeys.push(...(page.issues ?? []).map((issue) => issue.key))
      nextPageToken = page.isLast === false ? page.nextPageToken : undefined
    } while (nextPageToken)

    try {
      await scope.insertOne({
        sprintId: sprint.id,
        projectSlug: project.slug,
        name: sprint.name,
        startDate: sprint.startDate ? new Date(sprint.startDate) : null,
        endDate: sprint.endDate ? new Date(sprint.endDate) : null,
        issueKeys,
        capturedAt: new Date()
      })
    } catch (err) {
      if (err?.code !== DUPLICATE_KEY_ERROR) throw err
    }
  }
}

async function refreshProjectMetadata({ db, client, project, logger, now }) {
  const jira = project.jira ?? {}
  if (now.getTime() - time(jira.detectedStatusesAt) >= DETECT_EVERY_MS) {
    // A failed or empty status fetch keeps the previously detected statuses.
    const detected = await detectProjectStatuses(client, project, logger)
    if (detected?.length) {
      await db.collection(PROJECTS_COLLECTION).updateOne(
        { slug: project.slug },
        {
          $set: {
            'jira.detectedStatuses': detected,
            'jira.detectedStatusesAt': now
          }
        }
      )
    } else if (detected) {
      logger.warn(`Jira returned no statuses for project ${project.slug}`)
    }
  }
  if (
    jira.boardId &&
    now.getTime() - (lastScopeCheck.get(project.slug) ?? 0) >=
      SCOPE_CHECK_EVERY_MS
  ) {
    lastScopeCheck.set(project.slug, now.getTime())
    try {
      await captureSprintScope({ db, client, project })
    } catch (err) {
      logger.warn(
        { err },
        `Could not capture sprint scope for project ${project.slug}`
      )
    }
  }
}

/** Fetches the window's PR-referenced issues and their parents as ADR 0012 sets out. */
export async function refreshJiraWindow({
  db,
  client,
  project,
  from,
  to,
  logger,
  now = new Date()
}) {
  const field = await resolveStoryPointsField({
    db,
    client,
    project,
    logger,
    now
  })
  const [windowRefs, allRefs] = await Promise.all([
    from || to ? referencedKeys(db, project, { from, to }) : null,
    referencedKeys(db, project)
  ])
  const windowKeys = [...(windowRefs ?? allRefs).keys()]
  const inWindow = new Set(windowKeys)
  const otherKeys = [...allRefs.keys()].filter((key) => !inWindow.has(key))
  const children = await refreshKeys({
    db,
    client,
    project,
    field,
    windowKeys,
    otherKeys,
    now
  })
  const parents = await refreshParents({
    db,
    client,
    project,
    field,
    keys: [...allRefs.keys()],
    now
  })
  await refreshProjectMetadata({ db, client, project, logger, now })
  return { fetched: children.length + parents.length }
}

const windowId = (slug, from, to) =>
  `${slug}|${from ? new Date(from).toISOString() : ''}|${to ? new Date(to).toISOString() : ''}`

/** Refreshes a window once per process at a time; waits at most `budgetMs`, then serves what is stored. */
export async function ensureJiraWindowFresh({
  db,
  client,
  project,
  from,
  to,
  logger,
  budgetMs = config.get('jira.lazyFetchBudgetMs')
}) {
  if (!client?.isConfigured() || projectJiraKeys(project).length === 0) {
    return NOT_CONFIGURED
  }
  const id = windowId(project.slug, from, to)
  let work = inflightWindows.get(id)
  if (!work) {
    work = refreshJiraWindow({ db, client, project, from, to, logger })
      .then(() => ({ error: null }))
      .catch((err) => {
        if (err instanceof JiraAccessError) {
          logger.error(
            { err },
            `Jira refused access for project ${project.slug}`
          )
          return { error: err.kind }
        }
        logger.warn({ err }, `Jira refresh failed for project ${project.slug}`)
        return { error: 'unavailable' }
      })
      .finally(() => inflightWindows.delete(id))
    inflightWindows.set(id, work)
  }
  const outcome = await withinBudget(work, budgetMs)
  if (outcome === TIMED_OUT) {
    return {
      configured: true,
      stale: true,
      pending: true,
      error: null,
      refreshedAt: null
    }
  }
  return {
    configured: true,
    stale: outcome.error !== null,
    pending: false,
    error: outcome.error,
    refreshedAt: outcome.error ? null : new Date().toISOString()
  }
}

async function fetchUnknown({
  db,
  client,
  projectSlug,
  jiraKeys,
  logger,
  now = new Date()
}) {
  if (!projectSlug || !client?.isConfigured() || !jiraKeys?.length) return
  const project = await findProject(db, projectSlug)
  if (!project || project.archivedAt || projectJiraKeys(project).length === 0) {
    return
  }
  const keys = inProjectKeys(jiraKeys, project)
  if (keys.length === 0) return
  const field = await resolveStoryPointsField({
    db,
    client,
    project,
    logger,
    now
  })
  await refreshKeys({
    db,
    client,
    project,
    field,
    windowKeys: keys,
    otherKeys: [],
    now
  })
  await refreshParents({ db, client, project, field, keys, now })
}

/** Fetches the project's issues for keys seen in a payload, and their parents. Never rejects. */
export function fetchUnknownJiraIssues(options) {
  const task = fetchUnknown(options)
    .catch((err) =>
      options.logger.warn(
        { err },
        'Could not fetch Jira issues first seen at ingest'
      )
    )
    .finally(() => background.delete(task))
  background.add(task)
  return task
}

/** Waits, at most a few seconds, for background Jira work to finish. */
export async function settleJiraRefreshes() {
  await withinBudget(
    Promise.allSettled([...inflightWindows.values(), ...background]),
    SETTLE_MS
  )
}
