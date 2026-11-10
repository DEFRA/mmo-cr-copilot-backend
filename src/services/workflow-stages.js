// Jira workflow stages and per-issue flow (ADR 0011). Pure: no database or config.

const DAY_MS = 24 * 60 * 60 * 1000

export const WORKFLOW_STAGES = [
  { id: 'todo', label: 'To Do', kind: 'todo', required: true },
  { id: 'in-progress', label: 'In Progress', kind: 'active', required: false },
  {
    id: 'ready-for-review',
    label: 'Ready for Review',
    kind: 'waiting',
    required: false
  },
  { id: 'in-review', label: 'In Review', kind: 'active', required: false },
  {
    id: 'ready-for-test',
    label: 'Ready for Test',
    kind: 'waiting',
    required: false
  },
  { id: 'in-test', label: 'In Test', kind: 'active', required: false },
  {
    id: 'ready-for-release',
    label: 'Ready for Release',
    kind: 'waiting',
    required: false
  },
  {
    id: 'blocked',
    label: 'Blocked or On Hold',
    kind: 'waiting',
    required: false
  },
  { id: 'done', label: 'Done', kind: 'done', required: true },
  { id: 'cancelled', label: 'Cancelled', kind: 'excluded', required: false }
]

export const STAGE_IDS = WORKFLOW_STAGES.map((s) => s.id)
export const MAX_STATUS_LENGTH = 60
export const MAX_STATUSES_PER_STAGE = 40
export const MAX_STATUSES_TOTAL = 150
export const MAX_DETECTED_STATUSES = 500

// Atlassian defaults plus common naming; see ADR 0011 for sources.
export const STATUS_BASELINE = {
  todo: [
    'To Do',
    'Backlog',
    'Open',
    'New',
    'Selected for Development',
    'Ready for Development',
    'Ready for Dev',
    'Ready',
    'Refined',
    'Refinement',
    'Triage',
    'Requested',
    'Planned',
    'Reopened'
  ],
  'in-progress': [
    'In Progress',
    'In Dev',
    'In Development',
    'Development',
    'Dev',
    'Doing',
    'Started',
    'Work in Progress',
    'WIP',
    'Implementing',
    'Building',
    'Coding',
    'Fixing'
  ],
  'ready-for-review': [
    'Ready for Review',
    'Awaiting Review',
    'Waiting for Review',
    'Ready for Code Review',
    'Review Ready'
  ],
  'in-review': [
    'In Review',
    'Under Review',
    'Code Review',
    'Peer Review',
    'Review',
    'PR Review',
    'In Code Review',
    'Second Review'
  ],
  'ready-for-test': [
    'Ready for Test',
    'Ready to Test',
    'Ready for Testing',
    'Ready for QA',
    'QA Ready',
    'Awaiting QA',
    'Awaiting Test',
    'Waiting for QA',
    'Dev Complete',
    'Dev Done'
  ],
  'in-test': [
    'In Test',
    'Testing',
    'In Testing',
    'In QA',
    'QA',
    'Under Test',
    'Verification',
    'Verifying',
    'UAT',
    'In UAT',
    'User Acceptance Testing',
    'Acceptance Testing',
    'System Test',
    'SIT'
  ],
  'ready-for-release': [
    'Ready for Release',
    'Awaiting Release',
    'Ready to Release',
    'Ready for Deployment',
    'Ready to Deploy',
    'Awaiting Deployment',
    'Ready for Production',
    'Ready for Prod',
    'Staged'
  ],
  blocked: [
    'Blocked',
    'On Hold',
    'Waiting',
    'Pending',
    'Paused',
    'Parked',
    'Impeded',
    'Waiting for Info',
    'Awaiting Info',
    'Waiting for Customer',
    'Waiting for Support',
    'Waiting for Approval',
    'Awaiting Approval',
    'Awaiting CAB Approval'
  ],
  done: [
    'Done',
    'Completed',
    'Complete',
    'Closed',
    'Resolved',
    'Released',
    'Deployed',
    'Delivered',
    'Live',
    'In Production',
    'Accepted',
    'Approved',
    'Finished',
    'Shipped',
    'Published'
  ],
  cancelled: [
    'Cancelled',
    'Canceled',
    'Rejected',
    "Won't Do",
    "Won't Fix",
    'Duplicate',
    'Declined',
    'Abandoned',
    'Obsolete',
    'Invalid',
    'Cannot Reproduce'
  ]
}

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
const toTime = (value) => (value ? new Date(value).getTime() : NaN)
const toDateOrNull = (time) => (Number.isFinite(time) ? new Date(time) : null)
const days = (ms) => round1(Math.max(0, ms) / DAY_MS)

/** First rule a stage list breaks, or null. Messages are shown to users. */
export function workflowStagesError(stages) {
  const byId = new Map(stages.map((s) => [s.id, s.statuses ?? []]))
  if (!(byId.get('todo')?.length > 0)) return 'To Do needs at least one status'
  if (!(byId.get('done')?.length > 0)) return 'Done needs at least one status'
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
  for (const status of detected) {
    const name = tidyStatus(status?.name)
    const key = normaliseStatus(name)
    if (!name || seen.has(key)) continue
    const stageId =
      baseline.get(key)?.stageId ?? CATEGORY_STAGE[status?.categoryKey]
    if (!stageId) continue
    seen.add(key)
    lists[stageId].push(name)
  }
  // Metrics need a start and an end, so an empty required stage takes the baseline names.
  for (const id of ['todo', 'done']) {
    if (lists[id].length > 0) continue
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
  if (workflow.source !== 'detected') return index
  for (const [key, value] of buildStageIndex(baselineStages())) {
    if (!index.has(key)) index.set(key, { ...value, inferred: true })
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
  if (kind) return { stageId: null, kind, inferred: true }
  return { stageId: null, kind: 'unmapped', inferred: false }
}

function currentStatus(issue, index, catalogue, categoryFallback = true) {
  const current = classifyStatus(issue.status?.name, index, catalogue)
  const ownKind = CATEGORY_KIND[issue.status?.categoryKey]
  return categoryFallback && current.kind === 'unmapped' && ownKind
    ? { stageId: null, kind: ownKind, inferred: true }
    : current
}

function legacyFlow(issue, current) {
  const created = toTime(issue.created)
  const started = STARTED_KINDS.has(current.kind) ? created : NaN
  const done =
    current.kind === 'done' ? toTime(issue.resolved || issue.updated) : NaN
  const firstDone = Number.isFinite(toTime(issue.firstDoneAt))
    ? toTime(issue.firstDoneAt)
    : done
  return {
    stageId: current.stageId,
    stageKind: current.kind,
    startedAt: toDateOrNull(started),
    doneAt: toDateOrNull(done),
    firstDoneAt: toDateOrNull(firstDone),
    cycleDays:
      Number.isFinite(done) && Number.isFinite(started)
        ? days(done - started)
        : null,
    leadDays:
      Number.isFinite(done) && Number.isFinite(created)
        ? days(done - created)
        : null,
    activeDays: null,
    waitingDays: null,
    flowEfficiency: null,
    reopenCount: issue.reopenCount ?? 0,
    unmappedStatuses:
      current.kind === 'unmapped' && tidyStatus(issue.status?.name)
        ? [tidyStatus(issue.status?.name)]
        : []
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
  if (!name) return segments
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
  let excludedAt = NaN
  let reopens = 0
  segments.forEach((segment, i) => {
    const previous = segments[i - 1]?.kind
    if (segment.kind === 'excluded' && previous !== 'excluded') {
      excludedAt = segment.start
    }
    if (i === 0) return
    if (previous !== 'done' && segment.kind === 'done') into.push(segment.start)
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
    if (span <= 0) return
    if (ACTIVE_KINDS.has(segment.kind)) active += span
    else waiting += span
  })
  return { active, waiting }
}

/** Start, end and time in flow of one issue under a workflow index. Never mutates `issue`. */
export function deriveIssueFlow(
  issue,
  index,
  catalogue,
  now = new Date(),
  { categoryFallback = true } = {}
) {
  const current = currentStatus(issue, index, catalogue, categoryFallback)
  const history = (issue.statusHistory ?? [])
    .map((change) => ({ ...change, at: toTime(change.at) }))
    .filter((change) => Number.isFinite(change.at))
    .sort((a, b) => a.at - b.at)
  if (history.length === 0) return legacyFlow(issue, current)

  const segments = buildSegments(issue, history, index, catalogue, current)
  const startSegment = segments.find((s) => STARTED_KINDS.has(s.kind))
  const started = startSegment ? startSegment.start : NaN
  const { into, excludedAt, reopens } = stageTransitions(segments)
  const done =
    current.kind === 'done'
      ? (into.at(-1) ?? toTime(issue.resolved || issue.updated))
      : NaN
  const firstDone = into.length > 0 ? into[0] : done

  let flowTimes = { activeDays: null, waitingDays: null, flowEfficiency: null }
  if (Number.isFinite(started)) {
    let end = now.getTime()
    if (Number.isFinite(done)) end = done
    else if (current.kind === 'excluded' && Number.isFinite(excludedAt)) {
      end = excludedAt
    }
    const { active, waiting } = timeInFlow(segments, started, end)
    flowTimes = {
      activeDays: days(active),
      waitingDays: days(waiting),
      flowEfficiency:
        active + waiting > 0
          ? round1((active / (active + waiting)) * 100)
          : null
    }
  }

  const unmapped = new Set(
    segments
      .filter((s) => s.kind === 'unmapped')
      .map((s) => tidyStatus(s.name))
      .filter(Boolean)
  )
  const created = toTime(issue.created)
  return {
    stageId: current.stageId,
    stageKind: current.kind,
    startedAt: toDateOrNull(started),
    doneAt: toDateOrNull(done),
    firstDoneAt: toDateOrNull(firstDone),
    cycleDays:
      Number.isFinite(done) && Number.isFinite(started)
        ? days(done - started)
        : null,
    leadDays:
      Number.isFinite(done) && Number.isFinite(created)
        ? days(done - created)
        : null,
    ...flowTimes,
    reopenCount: reopens,
    unmappedStatuses: [...unmapped].sort()
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
