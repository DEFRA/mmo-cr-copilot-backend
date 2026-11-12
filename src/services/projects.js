import Boom from '@hapi/boom'

import { PAYLOADS_COLLECTION, toPayload } from '#/services/payloads.js'

export const PROJECTS_COLLECTION = 'projects'
export const REPOSITORIES_COLLECTION = 'repositories'

export const PROJECT_SLUG_CONFLICT_MESSAGE =
  'That project slug is already in use'
export const SONAR_KEY_CONFLICT_MESSAGE =
  'That SonarCloud project key is already in use'
export const JIRA_KEY_CONFLICT_MESSAGE =
  'The Jira project key was changed by someone else'

const sameKeys = (a, b) =>
  a.length === b.length && a.every((key, i) => key === b[i])

const DUPLICATE_KEY_ERROR = 11000

const toDate = (value) => (value ? new Date(value) : undefined)
const toIso = (value) => (value instanceof Date ? value.toISOString() : value)

// Strips Mongo storage internals and converts BSON dates to ISO strings.
function toProject(doc) {
  if (!doc) return null
  const { _id, ...rest } = doc
  return {
    ...rest,
    ...(rest.createdAt !== undefined
      ? { createdAt: toIso(rest.createdAt) }
      : {}),
    ...(rest.updatedAt !== undefined
      ? { updatedAt: toIso(rest.updatedAt) }
      : {}),
    ...(rest.archivedAt !== undefined
      ? { archivedAt: toIso(rest.archivedAt) }
      : {}),
    ...(rest.adoptionStartDate !== undefined
      ? { adoptionStartDate: toIso(rest.adoptionStartDate) }
      : {})
  }
}

// Formats a mapped repository record for API callers.
function toRepository(doc) {
  if (!doc) return null
  const { _id, ...rest } = doc
  return {
    ...rest,
    ...(rest.mappedAt !== undefined ? { mappedAt: toIso(rest.mappedAt) } : {})
  }
}

// Returns all active projects sorted alphabetically by name.
export async function listProjects(db) {
  const docs = await db
    .collection(PROJECTS_COLLECTION)
    .find({ archivedAt: null })
    .sort({ name: 1 })
    .toArray()

  return docs.map(toProject)
}

// Returns project matching slug or null when not found.
export async function findProject(db, slug) {
  const doc = await db.collection(PROJECTS_COLLECTION).findOne({ slug })
  return doc ? toProject(doc) : null
}

// Creates an active project with creation and update timestamps.
export async function createProject(db, projectData) {
  const now = new Date()
  const document = {
    ...projectData,
    createdAt: now,
    updatedAt: now,
    archivedAt: null
  }
  if (projectData.adoptionStartDate) {
    document.adoptionStartDate = toDate(projectData.adoptionStartDate)
  }
  if (document.jira?.storyPointsField) {
    document.jira = { ...document.jira, storyPointsFieldSource: 'admin' }
  }
  try {
    await db.collection(PROJECTS_COLLECTION).insertOne(document)
  } catch (error) {
    if (error?.code === DUPLICATE_KEY_ERROR) {
      throw Boom.conflict(PROJECT_SLUG_CONFLICT_MESSAGE)
    }
    throw error
  }
  return toProject(document)
}

// Updates an existing project and stamps updatedAt.
export async function updateProject(db, slug, updateData) {
  const now = new Date()
  const { jira, ...rest } = updateData
  const $set = {
    ...rest,
    updatedAt: now
  }
  // Per-field paths, so sync-owned fields such as jira.lastSyncedAt survive an edit.
  for (const [key, value] of Object.entries(jira ?? {})) {
    $set[`jira.${key}`] = value
  }
  // An admin's field wins over detection; null hands the choice back to detection.
  if (jira && Object.hasOwn(jira, 'storyPointsField')) {
    $set['jira.storyPointsFieldSource'] =
      jira.storyPointsField === null ? null : 'admin'
    if (jira.storyPointsField === null) {
      $set['jira.storyPointsFieldDetectedAt'] = null
    }
  }
  if (updateData.adoptionStartDate !== undefined) {
    $set.adoptionStartDate = updateData.adoptionStartDate
      ? toDate(updateData.adoptionStartDate)
      : null
  }
  const collection = db.collection(PROJECTS_COLLECTION)
  if (jira) {
    // A dotted path cannot be created inside a null sub-document.
    await collection.updateOne(
      { slug, jira: { $type: 'null' } },
      { $set: { jira: {} } }
    )
  }
  const requestedKeys = jira?.projectKeys
  const $unset = {}
  let filter = { slug }
  if (requestedKeys !== undefined) {
    const current = await collection.findOne(
      { slug },
      { projection: { 'jira.projectKeys': 1 } }
    )
    if (!current) return null
    const storedKeys = current.jira?.projectKeys ?? []
    // Pinned to the key just read, so the resets below belong to the key they replace (ADR 0013).
    filter = storedKeys.length
      ? { slug, 'jira.projectKeys': storedKeys }
      : { slug, 'jira.projectKeys.0': { $exists: false } }
    if (storedKeys.length > 0 && !sameKeys(storedKeys, requestedKeys)) {
      $set['jira.lastSyncedAt'] = null
      $set['jira.detectedStatuses'] = []
      $set['jira.detectedStatusesAt'] = null
      if (jira.boardId === undefined) $unset['jira.boardId'] = ''
    }
  }
  const result = await collection.findOneAndUpdate(
    filter,
    Object.keys($unset).length ? { $set, $unset } : { $set },
    { returnDocument: 'after' }
  )
  if (!result && requestedKeys !== undefined) {
    throw Boom.conflict(JIRA_KEY_CONFLICT_MESSAGE)
  }
  return result ? toProject(result) : null
}

// Replaces an active project's sprint calendar; null when the project is gone.
export async function setSprintCalendar(db, slug, sprintCalendar) {
  const result = await db
    .collection(PROJECTS_COLLECTION)
    .findOneAndUpdate(
      { slug, archivedAt: null },
      { $set: { sprintCalendar, updatedAt: new Date() } },
      { returnDocument: 'after' }
    )
  return result ? toProject(result) : null
}

// Soft-deletes a project by setting archivedAt and updatedAt.
export async function deleteProject(db, slug) {
  const now = new Date()
  const result = await db
    .collection(PROJECTS_COLLECTION)
    .findOneAndUpdate(
      { slug },
      { $set: { archivedAt: now, updatedAt: now } },
      { returnDocument: 'after' }
    )
  return result ? toProject(result) : null
}

// Returns all mapped repositories sorted by full name.
export async function listRepositories(db) {
  const docs = await db
    .collection(REPOSITORIES_COLLECTION)
    .find({})
    .sort({ fullName: 1 })
    .toArray()

  return docs.map(toRepository)
}

// Returns repository record matching fullName or null.
export async function findRepository(db, fullName) {
  const doc = await db.collection(REPOSITORIES_COLLECTION).findOne({ fullName })
  return doc ? toRepository(doc) : null
}

/** A trimmed SonarCloud key, or null for '', whitespace and null; undefined passes through. */
export function normaliseSonarKey(key) {
  if (key === undefined) return undefined
  const trimmed = typeof key === 'string' ? key.trim() : ''
  return trimmed || null
}

const sonarKeyConflict = () => Boom.conflict(SONAR_KEY_CONFLICT_MESSAGE)

// One SonarCloud project per repository; the unique index is the backstop for races.
async function assertSonarKeyFree(db, fullName, sonarProjectKey) {
  if (!sonarProjectKey) return
  const taken = await db
    .collection(REPOSITORIES_COLLECTION)
    .findOne({ sonarProjectKey, fullName: { $ne: fullName } })
  if (taken) throw sonarKeyConflict()
}

async function writeRepository(db, fullName, update) {
  try {
    return await db
      .collection(REPOSITORIES_COLLECTION)
      .findOneAndUpdate({ fullName }, update, { returnDocument: 'after' })
  } catch (error) {
    if (error?.code === DUPLICATE_KEY_ERROR) throw sonarKeyConflict()
    throw error
  }
}

// Upserts a repository mapping and updates existing payloads; any SonarCloud key is kept.
export async function mapRepository(db, { fullName, projectSlug, mappedBy }) {
  const mappedAt = new Date()
  const $set = {
    fullName,
    projectSlug,
    mappedAt,
    ...(mappedBy !== undefined ? { mappedBy } : {})
  }

  const doc = await db
    .collection(REPOSITORIES_COLLECTION)
    .findOneAndUpdate(
      { fullName },
      { $set },
      { upsert: true, returnDocument: 'after' }
    )

  await db
    .collection(PAYLOADS_COLLECTION)
    .updateMany({ repository: fullName }, { $set: { projectSlug } })

  return toRepository(doc)
}

/** Sets or clears one repository's SonarCloud key; null when the repository is unknown. */
export async function setRepositorySonarKey(db, fullName, sonarProjectKey) {
  const key = normaliseSonarKey(sonarProjectKey) ?? null
  await assertSonarKeyFree(db, fullName, key)
  const doc = await writeRepository(db, fullName, {
    $set: { sonarProjectKey: key }
  })
  return toRepository(doc)
}

// Removes a repository mapping and unassigns existing payloads.
export async function unmapRepository(db, fullName) {
  const { deletedCount } = await db
    .collection(REPOSITORIES_COLLECTION)
    .deleteOne({ fullName })

  await db
    .collection(PAYLOADS_COLLECTION)
    .updateMany({ repository: fullName }, { $set: { projectSlug: null } })

  return deletedCount > 0
}

// Finds distinct repositories in payloads that are not currently mapped.
export async function findUnassignedRepositories(db) {
  const mapped = await db
    .collection(REPOSITORIES_COLLECTION)
    .distinct('fullName')
  const mappedSet = new Set(mapped)

  const unassignedInPayloads = await db
    .collection(PAYLOADS_COLLECTION)
    .distinct('repository', {
      $or: [{ projectSlug: null }, { projectSlug: { $exists: false } }]
    })

  const allPayloadRepos = await db
    .collection(PAYLOADS_COLLECTION)
    .distinct('repository')

  const unassigned = new Set(unassignedInPayloads)
  for (const repo of allPayloadRepos) {
    if (!mappedSet.has(repo)) {
      unassigned.add(repo)
    }
  }

  return [...unassigned].filter(Boolean).sort()
}

// A PR is in a window when any commit lands in it; backfills share one calculatedAt.
function activityInWindow(range) {
  return {
    $or: [
      { commitBreakdown: { $elemMatch: { committedAt: range } } },
      { 'commitBreakdown.committedAt': { $exists: false }, calculatedAt: range }
    ]
  }
}

// Queries payloads scoped to projectSlug returning latest payload per PR.
export async function findProjectPayloads(db, projectSlug, { from, to } = {}) {
  const range = {}
  if (from) range.$gte = new Date(from)
  if (to) range.$lt = new Date(to)
  const windowed = Object.keys(range).length > 0

  const pipeline = [
    { $match: { projectSlug } },
    { $sort: { calculatedAt: -1 } },
    {
      $group: {
        _id: { repository: '$repository', prNumber: '$prNumber' },
        doc: { $first: '$$ROOT' }
      }
    },
    { $replaceRoot: { newRoot: '$doc' } },
    ...(windowed ? [{ $match: activityInWindow(range) }] : []),
    { $sort: { calculatedAt: -1 } }
  ]

  const docs = await db
    .collection(PAYLOADS_COLLECTION)
    .aggregate(pipeline)
    .toArray()

  return docs.map(toPayload)
}

// Generates count sprint objects based on the project sprint calendar.
export function getProjectSprints(project, count = 5, now = new Date()) {
  const calendar = project?.sprintCalendar || {
    cadenceDays: 14,
    anchorDate: new Date('2026-07-08T00:00:00.000Z')
  }
  const cadenceDays = calendar.cadenceDays ?? 14
  const anchorDate = calendar.anchorDate
    ? new Date(calendar.anchorDate)
    : new Date('2026-07-08T00:00:00.000Z')

  const sprintLengthMs = cadenceDays * 24 * 60 * 60 * 1000
  const current = Math.floor(
    (now.getTime() - anchorDate.getTime()) / sprintLengthMs
  )
  const sprints = []

  // Newest first: the sprint containing `now`, then the ones before it.
  for (let i = 0; i < count; i += 1) {
    const offset = current - i
    const start = new Date(anchorDate.getTime() + offset * sprintLengthMs)
    const end = new Date(start.getTime() + sprintLengthMs)
    sprints.push({
      index: offset + 1,
      start,
      end,
      label: `Sprint ${offset + 1}`
    })
  }

  return sprints
}

/**
 * Sprints from the project's Jira board when one is set, newest first, or the
 * fixed cadence when Jira is unset or unreachable.
 */
export async function resolveProjectSprints(
  project,
  jira,
  { count = 5, now = new Date(), logger } = {}
) {
  const boardId = project?.jira?.boardId
  if (!boardId || !jira?.isConfigured()) {
    return getProjectSprints(project, count, now)
  }
  try {
    const board = await jira.getBoardSprints(boardId)
    const mapped = board
      .filter((s) => s.startDate)
      .sort((a, b) => new Date(a.startDate) - new Date(b.startDate))
      .map((s, i) => ({
        index: i + 1,
        name: s.name,
        label: s.name,
        start: new Date(s.startDate),
        end: new Date(s.completeDate || s.endDate || now)
      }))
    if (mapped.length === 0) return getProjectSprints(project, count, now)
    return mapped.reverse().slice(0, count)
  } catch (err) {
    logger?.warn({ err }, 'Jira board sprints unavailable; using the cadence')
    return getProjectSprints(project, count, now)
  }
}
