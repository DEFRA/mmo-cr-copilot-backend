// Jira workflow stages and per-issue flow (ADR 0011). Pure: no database or config.

import { DAY_MS } from '#/common/helpers/time.js'
import {
  MAX_STATUSES_TOTAL,
  STAGE_IDS,
  STATUS_BASELINE,
  WORKFLOW_STAGES
} from './workflow-baseline.js'

export {
  MAX_DETECTED_STATUSES,
  MAX_STATUS_LENGTH,
  MAX_STATUSES_PER_STAGE,
  MAX_STATUSES_TOTAL,
  STAGE_IDS,
  STATUS_BASELINE,
  WORKFLOW_STAGES
} from './workflow-baseline.js'

const CATEGORY_KIND = { new: 'todo', indeterminate: 'active', done: 'done' }
const CATEGORY_STAGE = {
  new: 'todo',
  indeterminate: 'in-progress',
  done: 'done'
}
const STARTED_KINDS = new Set(['active', 'waiting', 'done', 'unmapped'])
const ACTIVE_KINDS = new Set(['active', 'unmapped'])

export const normaliseStatus = (name) =>
  String(name ?? '')
    .trim()
    .replace(/\s+/g, ' ')
    .toLowerCase()
export const tidyStatus = (name) =>
  String(name ?? '')
    .trim()
    .replace(/\s+/g, ' ')

const round1 = (n) => Math.round(n * 10) / 10
const toTime = (value) => (value ? new Date(value).getTime() : Number.NaN)
const toDateOrNull = (time) => (Number.isFinite(time) ? new Date(time) : null)
const days = (ms) => round1(Math.max(0, ms) / DAY_MS)
// Whole days from `start` to `end`, or null when either is unknown.
const spanDays = (end, start) =>
  Number.isFinite(end) && Number.isFinite(start) ? days(end - start) : null

/** First rule a stage list breaks, or null. Messages are shown to users. */
export function workflowStagesError(stages) {
  const byId = new Map(stages.map((s) => [s.id, s.statuses ?? []]))
  if ((byId.get('todo')?.length ?? 0) === 0) {
    return 'To Do needs at least one status'
  }
  if ((byId.get('done')?.length ?? 0) === 0) {
    return 'Done needs at least one status'
  }
  const seen = new Set()
  let total = 0
  for (const stage of stages) {
    for (const status of stage.statuses ?? []) {
      const key = normaliseStatus(status)
      if (seen.has(key)) {
        return `'${tidyStatus(status)}' is in more than one stage`
      }
      seen.add(key)
      total += 1
    }
  }
  return total > MAX_STATUSES_TOTAL
    ? `A workflow can have at most ${MAX_STATUSES_TOTAL} statuses`
    : null
}

const withMeta = (statusesFor) =>
  WORKFLOW_STAGES.map((meta) => ({ ...meta, statuses: statusesFor(meta.id) }))

const isSavedMapping = (mapping) =>
  Number.isInteger(mapping?.version) && Array.isArray(mapping?.stages)

const baselineStages = () => withMeta((id) => [...STATUS_BASELINE[id]])

function detectedStages(detected) {
  const baseline = buildStageIndex(baselineStages())
  const lists = Object.fromEntries(STAGE_IDS.map((id) => [id, []]))
  const seen = new Set()
  const placed = detected.map((status) => {
    const name = tidyStatus(status?.name)
    const key = normaliseStatus(name)
    return {
      name,
      key,
      stageId: baseline.get(key)?.stageId ?? CATEGORY_STAGE[status?.categoryKey]
    }
  })
  for (const { name, key, stageId } of placed) {
    if (name && stageId && !seen.has(key)) {
      seen.add(key)
      lists[stageId].push(name)
    }
  }
  // Metrics need a start and an end, so an empty required stage takes the baseline names.
  for (const id of ['todo', 'done'].filter((stage) => !lists[stage].length)) {
    lists[id] = STATUS_BASELINE[id].filter((s) => !seen.has(normaliseStatus(s)))
  }
  return withMeta((id) => lists[id])
}

/**
 * Effective workflow: the project's saved mapping, else the statuses detected
 * from Jira, else the baseline.
 */
export function resolveWorkflow(project) {
  const jira = project?.jira ?? {}
  const saved = jira.statusMapping
  if (isSavedMapping(saved)) {
    return {
      source: 'project',
      version: saved.version,
      updatedAt: saved.updatedAt ?? null,
      updatedBy: saved.updatedBy?.name ? { name: saved.updatedBy.name } : null,
      stages: withMeta((id) => [
        ...(saved.stages.find((s) => s.id === id)?.statuses ?? [])
      ])
    }
  }
  const unsaved = { version: 0, updatedAt: null, updatedBy: null }
  if (Array.isArray(jira.detectedStatuses) && jira.detectedStatuses.length) {
    return {
      source: 'detected',
      ...unsaved,
      stages: detectedStages(jira.detectedStatuses)
    }
  }
  return { source: 'default', ...unsaved, stages: baselineStages() }
}

/** Map of normalised status name to `{ stageId, kind }`; the first stage wins. */
export function buildStageIndex(stages) {
  const index = new Map()
  for (const stage of stages) {
    for (const status of stage.statuses ?? []) {
      const key = normaliseStatus(status)
      if (!index.has(key)) {
        index.set(key, { stageId: stage.id, kind: stage.kind })
      }
    }
  }
  return index
}

/**
 * The index metrics classify against. A detected workflow falls back to the
 * baseline synonyms for statuses seen in history but not detected.
 */
export function buildWorkflowIndex(workflow) {
  const index = buildStageIndex(workflow.stages)
  if (workflow.source !== 'detected') {
    return index
  }
  for (const [key, value] of buildStageIndex(baselineStages())) {
    if (!index.has(key)) {
      index.set(key, { ...value, inferred: true })
    }
  }
  return index
}

/** Map of normalised current status name to its Jira category; the first issue wins. */
export function buildStatusCatalogue(issues) {
  const catalogue = new Map()
  for (const issue of issues) {
    const key = normaliseStatus(issue?.status?.name)
    const category = issue?.status?.categoryKey
    if (key && CATEGORY_KIND[category] && !catalogue.has(key)) {
      catalogue.set(key, category)
    }
  }
  return catalogue
}

export function classifyStatus(name, index, catalogue = new Map()) {
  const key = normaliseStatus(name)
  const hit = index.get(key)
  if (hit) {
    return {
      stageId: hit.stageId,
      kind: hit.kind,
      inferred: Boolean(hit.inferred)
    }
  }
  const kind = CATEGORY_KIND[catalogue.get(key)]
  if (kind) {
    return { stageId: null, kind, inferred: true }
  }
  return { stageId: null, kind: 'unmapped', inferred: false }
}

function currentStatus(issue, index, catalogue, categoryFallback = true) {
  const current = classifyStatus(issue.status?.name, index, catalogue)
  const ownKind = CATEGORY_KIND[issue.status?.categoryKey]
  return categoryFallback && current.kind === 'unmapped' && ownKind
    ? { stageId: null, kind: ownKind, inferred: true }
    : current
}

const unmappedCurrent = (issue, current) => {
  const name = tidyStatus(issue.status?.name)
  return current.kind === 'unmapped' && name ? [name] : []
}

function legacyFlow(issue, current) {
  const created = toTime(issue.created)
  const started = STARTED_KINDS.has(current.kind) ? created : Number.NaN
  const done =
    current.kind === 'done'
      ? toTime(issue.resolved || issue.updated)
      : Number.NaN
  const firstDoneAt = toTime(issue.firstDoneAt)
  return {
    stageId: current.stageId,
    stageKind: current.kind,
    startedAt: toDateOrNull(started),
    doneAt: toDateOrNull(done),
    firstDoneAt: toDateOrNull(
      Number.isFinite(firstDoneAt) ? firstDoneAt : done
    ),
    cycleDays: spanDays(done, started),
    leadDays: spanDays(done, created),
    activeDays: null,
    waitingDays: null,
    flowEfficiency: null,
    reopenCount: issue.reopenCount ?? 0,
    unmappedStatuses: unmappedCurrent(issue, current)
  }
}

function buildSegments(issue, history, index, catalogue, current) {
  const createdTime = toTime(issue.created)
  const segments = [
    {
      name: history[0].from,
      start: Number.isFinite(createdTime) ? createdTime : history[0].at,
      kind: classifyStatus(history[0].from, index, catalogue).kind
    },
    ...history.map((change) => ({
      name: change.to,
      start: change.at,
      kind: classifyStatus(change.to, index, catalogue).kind
    }))
  ]
  const last = segments.at(-1)
  const name = tidyStatus(issue.status?.name)
  if (!name) {
    return segments
  }
  if (normaliseStatus(last.name) === normaliseStatus(name)) {
    last.kind = current.kind
    return segments
  }
  // History lags the current status, so the change it missed happened by the last update.
  const at = toTime(issue.resolved || issue.updated)
  segments.push({
    name,
    start: Number.isFinite(at) ? Math.max(at, last.start) : last.start,
    kind: current.kind
  })
  return segments
}

// Leaving Done for Done or Cancelled is not a reopen.
const NOT_REOPENED_KINDS = new Set(['done', 'excluded'])

function stageTransitions(segments) {
  const into = []
  let excludedAt = Number.NaN
  let reopens = 0
  segments.forEach((segment, i) => {
    const previous = segments[i - 1]?.kind
    if (segment.kind === 'excluded' && previous !== 'excluded') {
      excludedAt = segment.start
    }
    if (i === 0) {
      return
    }
    if (previous !== 'done' && segment.kind === 'done') {
      into.push(segment.start)
    }
    if (previous === 'done' && !NOT_REOPENED_KINDS.has(segment.kind)) {
      reopens += 1
    }
  })
  return { into, excludedAt, reopens }
}

function timeInFlow(segments, started, end) {
  let active = 0
  let waiting = 0
  segments.forEach((segment, i) => {
    const until = i + 1 < segments.length ? segments[i + 1].start : end
    const span = Math.min(until, end) - Math.max(segment.start, started)
    if (span <= 0) {
      return
    }
    if (ACTIVE_KINDS.has(segment.kind)) {
      active += span
    } else {
      waiting += span
    }
  })
  return { active, waiting }
}

// Flow time stops at Done, at cancellation, or now for work still open.
function flowEnd(current, done, excludedAt, now) {
  if (Number.isFinite(done)) {
    return done
  }
  if (current.kind === 'excluded' && Number.isFinite(excludedAt)) {
    return excludedAt
  }
  return now.getTime()
}

const NO_FLOW_TIMES = {
  activeDays: null,
  waitingDays: null,
  flowEfficiency: null
}

function flowTimesFor(segments, started, end) {
  if (!Number.isFinite(started)) {
    return NO_FLOW_TIMES
  }
  const { active, waiting } = timeInFlow(segments, started, end)
  return {
    activeDays: days(active),
    waitingDays: days(waiting),
    flowEfficiency:
      active + waiting > 0 ? round1((active / (active + waiting)) * 100) : null
  }
}

const unmappedSegments = (segments) =>
  [
    ...new Set(
      segments
        .filter((s) => s.kind === 'unmapped')
        .map((s) => tidyStatus(s.name))
        .filter(Boolean)
    )
  ].sort((a, b) => a.localeCompare(b))

const sortedHistory = (issue) =>
  (issue.statusHistory ?? [])
    .map((change) => ({ ...change, at: toTime(change.at) }))
    .filter((change) => Number.isFinite(change.at))
    .sort((a, b) => a.at - b.at)

/** Start, end and time in flow of one issue under a workflow index. Never mutates `issue`. */
export function deriveIssueFlow(
  issue,
  index,
  catalogue,
  now = new Date(),
  { categoryFallback = true } = {}
) {
  const current = currentStatus(issue, index, catalogue, categoryFallback)
  const history = sortedHistory(issue)
  if (history.length === 0) {
    return legacyFlow(issue, current)
  }

  const segments = buildSegments(issue, history, index, catalogue, current)
  const startSegment = segments.find((s) => STARTED_KINDS.has(s.kind))
  const started = startSegment ? startSegment.start : Number.NaN
  const { into, excludedAt, reopens } = stageTransitions(segments)
  const done =
    current.kind === 'done'
      ? (into.at(-1) ?? toTime(issue.resolved || issue.updated))
      : Number.NaN
  const end = flowEnd(current, done, excludedAt, now)

  return {
    stageId: current.stageId,
    stageKind: current.kind,
    startedAt: toDateOrNull(started),
    doneAt: toDateOrNull(done),
    firstDoneAt: toDateOrNull(into.length > 0 ? into[0] : done),
    cycleDays: spanDays(done, started),
    leadDays: spanDays(done, toTime(issue.created)),
    ...flowTimesFor(segments, started, end),
    reopenCount: reopens,
    unmappedStatuses: unmappedSegments(segments)
  }
}

/** Issues with a `flow` block under the project's effective workflow. A saved mapping is authoritative: no category fallback. */
export function attachIssueFlow(issues, project, now = new Date()) {
  const workflow = resolveWorkflow(project)
  const index = buildWorkflowIndex(workflow)
  const categoryFallback = workflow.source !== 'project'
  const catalogue = categoryFallback ? buildStatusCatalogue(issues) : new Map()
  return {
    workflow,
    issues: issues.map((issue) => ({
      ...issue,
      flow: deriveIssueFlow(issue, index, catalogue, now, { categoryFallback })
    }))
  }
}

/** Statuses outside every stage, by number of issues that passed through them. */
export function summariseUnmapped(issues, limit = 20) {
  const counts = new Map()
  for (const issue of issues) {
    for (const name of issue.flow?.unmappedStatuses ?? []) {
      counts.set(name, (counts.get(name) ?? 0) + 1)
    }
  }
  return [...counts]
    .map(([name, count]) => ({ name, issues: count }))
    .sort((a, b) => b.issues - a.issues || a.name.localeCompare(b.name))
    .slice(0, limit)
}
