import { PAYLOADS_COLLECTION, toPayload } from '#/services/payloads.js'
import {
  PROJECTS_COLLECTION,
  findProjectPayloads
} from '#/services/projects.js'
import { computeFlowMetrics } from '#/services/flow-metrics.js'
import { computeComplexityScore } from '#/services/complexity.js'
import { summariseUnmapped } from '#/services/workflow-stages.js'
import {
  deliveryUnitKey,
  isBugType,
  isStoryType,
  loadScopedIssues,
  parsePrId,
  prId
} from '#/services/jira-scope.js'

const SONAR_PR_SNAPSHOTS_COLLECTION = 'sonar-pr-snapshots'
const SPRINT_SCOPE_COLLECTION = 'jira-sprint-scope'
const round1 = (n) => Math.round(n * 10) / 10

function addTo(map, key, value) {
  if (!map.has(key)) {
    map.set(key, new Set())
  }
  map.get(key).add(value)
}

// The newest document per PR, so a PR with payload history reads its latest.
async function findByPrIds(db, collection, ids) {
  const found = new Map()
  if (ids.length === 0) {
    return found
  }
  const docs = await db
    .collection(collection)
    .find({ $or: ids.map(parsePrId) })
    .sort({ calculatedAt: -1 })
    .toArray()
  for (const doc of docs) {
    const id = prId(doc.repository, doc.prNumber)
    if (!found.has(id)) {
      found.set(id, doc)
    }
  }
  return found
}

function sumLines(commits, field) {
  return (commits ?? []).reduce(
    (total, commit) => total + (commit[field] ?? 0),
    0
  )
}

// Calculates median value of an array of numbers rounded to 1 decimal place.
function calculateMedian(values) {
  if (!values || values.length === 0) {
    return 0
  }
  const sorted = [...values].sort((a, b) => a - b)
  const mid = Math.floor(sorted.length / 2)
  const median =
    sorted.length % 2 !== 0 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2
  return Math.round(median * 10) / 10
}

// Q_Sonar inputs (docs/metrics.md): a failed gate keeps this share of credit;
// blocker/high issues per KLOC above this count remove all of it.
const FAILED_GATE_FACTOR = 0.2
const MAX_BLOCKERS_PER_KLOC = 5
const LINES_PER_KLOC = 1000
// A story Done the moment it started still takes some time.
const MIN_CYCLE_DAYS = 0.1

const roundTo = (value, places) => {
  const factor = 10 ** places
  return Math.round(value * factor) / factor
}
const ratio = (part, whole, places) =>
  whole > 0 ? roundTo(part / whole, places) : 0
const percent1 = (part, whole) => ratio(part * 100, whole, 1)
const gateStatus = (sonar) =>
  sonar.qualityGate || sonar.alert_status || sonar.measures?.alert_status
const isPassed = (status) => status === 'passed' || status === 'OK'
const clamp = (value, max) => Math.min(max, Math.max(0, Number(value) || 0))

// Computes the SonarCloud quality multiplier Q_Sonar for a PR.
function computeSonarMultiplier(sonar, linesAdded, k) {
  if (!sonar) {
    return 1.0
  }
  const qgFactor = isPassed(gateStatus(sonar)) ? 1.0 : FAILED_GATE_FACTOR
  const tdr = clamp(sonar.measures?.new_sqale_debt_ratio, 1)
  const dup = clamp(sonar.measures?.new_duplicated_lines_density, 100)
  const blockerHigh =
    (Number(sonar.measures?.new_software_quality_blocker_issues) || 0) +
    (Number(sonar.measures?.new_software_quality_high_issues) || 0)
  const kloc = linesAdded / k / LINES_PER_KLOC
  const defectPenalty =
    kloc > 0 ? Math.min(1.0, blockerHigh / (kloc * MAX_BLOCKERS_PER_KLOC)) : 0

  return Math.max(
    0,
    qgFactor * (1 - tdr) * (1 - dup / 100) * (1 - defectPenalty)
  )
}

const doneInWindowFor = (from, to) => {
  const fromDate = from ? new Date(from) : null
  const toDate = to ? new Date(to) : null
  return ({ flow }) =>
    flow.stageKind === 'done' &&
    Boolean(flow.doneAt) &&
    (!fromDate || flow.doneAt >= fromDate) &&
    (!toDate || flow.doneAt < toDate)
}

// Delivery units (ADR 0012) and their PRs, from the PR-referenced Jira keys.
function mapUnits(referenced, byKey, doneInWindow) {
  const unitPrs = new Map()
  const prUnits = new Map()
  const linkedPrIds = new Set()
  let otherItemsDelivered = 0
  for (const [key, ids] of referenced) {
    ids.forEach((id) => linkedPrIds.add(id))
    const issue = byKey.get(key)
    const unit = issue ? deliveryUnitKey(issue, byKey) : null
    if (unit) {
      ids.forEach((id) => {
        addTo(unitPrs, unit, id)
        addTo(prUnits, id, unit)
      })
    } else if (issue && doneInWindow(issue)) {
      otherItemsDelivered += 1
    } else {
      // Unknown keys, and other items not done in the window, are not counted.
    }
  }
  return { unitPrs, prUnits, linkedPrIds, otherItemsDelivered }
}

const prIdsOf = (units, unitPrs) => [
  ...new Set(units.flatMap((unit) => [...unitPrs.get(unit.key)]))
]

// Stories and stand-alone bugs done in the window; stories come first.
function doneUnitsOf(units, doneInWindow) {
  const done = units.filter(doneInWindow)
  const doneStories = done.filter((unit) => isStoryType(unit.issueType))
  const doneBugs = done.filter(
    (unit) => !isStoryType(unit.issueType) && isBugType(unit.issueType)
  )
  return { doneStories, doneUnits: [...doneStories, ...doneBugs] }
}

// Window payloads plus the newest payload of any linked PR outside the window.
async function payloadsById(db, payloads, prIds) {
  const payloadMap = new Map(
    payloads.map((p) => [prId(p.repository, p.prNumber), p])
  )
  const outsideWindow = await findByPrIds(
    db,
    PAYLOADS_COLLECTION,
    prIds.filter((id) => !payloadMap.has(id))
  )
  for (const [id, doc] of outsideWindow) {
    payloadMap.set(id, toPayload(doc))
  }
  return payloadMap
}

function linkPrs(doneUnits, unitPrs, payloadMap) {
  const prsByKey = new Map()
  const warnings = []
  for (const unit of doneUnits) {
    const prs = [...unitPrs.get(unit.key)]
      .map((id) => payloadMap.get(id))
      .filter(Boolean)
    prsByKey.set(unit.key, prs)
    if (prs.some((p) => !p.prMergedAt)) {
      warnings.push({ key: unit.key, type: 'done-with-open-pr' })
    }
  }
  return { prsByKey, warnings }
}

// One PR's quality-weighted lines, split across the units it serves.
function scorePr(id, { payloadMap, prUnits, snapshots }) {
  const p = payloadMap.get(id)
  const linesAdded =
    p?.summary?.linesAdded ?? sumLines(p?.commitBreakdown, 'linesAdded')
  const linesDeleted =
    p?.summary?.linesDeleted ?? sumLines(p?.commitBreakdown, 'linesDeleted')
  const k = prUnits.get(id)?.size || 1
  const netLines = Math.max(0, linesAdded - linesDeleted) / k
  const sonar = snapshots.get(id)
  const qualityELoc = netLines * computeSonarMultiplier(sonar, linesAdded, k)
  const complexityScore =
    p?.complexity?.score ??
    (p?.files ? computeComplexityScore(p.files).score : null)
  return {
    qualityELoc,
    complexityELoc: complexityScore > 0 ? qualityELoc / complexityScore : null,
    hasSnapshot: Boolean(sonar),
    passed: Boolean(sonar) && isPassed(gateStatus(sonar)),
    firstScanPassed: Boolean(sonar) && isPassed(sonar.firstScanQualityGate)
  }
}

const sumOf = (list, pick) =>
  list.reduce((total, item) => total + pick(item), 0)

function scoreStory(story, unitPrs, context) {
  const prs = [...unitPrs.get(story.key)].map((id) => scorePr(id, context))
  const scored = prs.filter((pr) => pr.complexityELoc !== null)
  const gated = prs.some((pr) => pr.hasSnapshot)
  return {
    cycleDays: Math.max(MIN_CYCLE_DAYS, story.flow.cycleDays ?? MIN_CYCLE_DAYS),
    leadDays: story.flow.leadDays,
    storyPoints: Number(story.storyPoints) || 0,
    reopened: story.flow.reopenCount > 0,
    qualityELoc: sumOf(prs, (pr) => pr.qualityELoc),
    // QANT_comp counts only stories whose linked PRs carry a complexity score.
    complexityELoc: scored.length
      ? sumOf(scored, (pr) => pr.complexityELoc)
      : null,
    sdu: gated && prs.every((pr) => pr.passed),
    firstScanPassed: gated && prs.every((pr) => pr.firstScanPassed)
  }
}

function summariseStories(stories) {
  const count = (test) => stories.filter(test).length
  const withComplexity = stories.filter((s) => s.complexityELoc !== null)
  const totalQualityELoc = sumOf(stories, (s) => s.qualityELoc)
  const totalStoryPoints = sumOf(stories, (s) => s.storyPoints)
  return {
    qant: ratio(
      totalQualityELoc,
      sumOf(stories, (s) => s.cycleDays),
      1
    ),
    qantComp: ratio(
      sumOf(withComplexity, (s) => s.complexityELoc),
      sumOf(withComplexity, (s) => s.cycleDays),
      2
    ),
    storyPointVelocity: ratio(totalQualityELoc, totalStoryPoints, 1),
    standardDeployableUnits: count((s) => s.sdu),
    leadTimeToDoneDays: calculateMedian(
      stories.map((s) => s.leadDays).filter(Number.isFinite)
    ),
    cycleTimeDays: calculateMedian(stories.map((s) => s.cycleDays)),
    storiesDelivered: stories.length,
    storyPointsDelivered: round1(totalStoryPoints),
    firstScanPassRate: percent1(
      count((s) => s.firstScanPassed),
      stories.length
    ),
    reopenRate: percent1(
      count((s) => s.reopened),
      stories.length
    )
  }
}

/**
 * QANT, SDU and delivery DORA metrics for a project in a window. The unit is
 * the Story reached from PR-referenced keys, directly or as a parent (ADR 0012).
 * `prGates`, when given, captures missing SonarCloud PR gates first.
 */
export async function computeDeliveryMetrics(
  db,
  projectSlug,
  { from, to } = {},
  { prGates } = {}
) {
  const project = (await db
    .collection(PROJECTS_COLLECTION)
    .findOne({ slug: projectSlug })) ?? { slug: projectSlug }
  const [{ workflow, issues, prsByKey: referenced }, scopes, payloads] =
    await Promise.all([
      loadScopedIssues(db, project),
      db.collection(SPRINT_SCOPE_COLLECTION).find({ projectSlug }).toArray(),
      findProjectPayloads(db, projectSlug, { from, to })
    ])
  const doneInWindow = doneInWindowFor(from, to)
  const byKey = new Map(issues.map((issue) => [issue.key, issue]))
  const { unitPrs, prUnits, linkedPrIds, otherItemsDelivered } = mapUnits(
    referenced,
    byKey,
    doneInWindow
  )
  const units = [...unitPrs.keys()].map((key) => byKey.get(key))
  const { doneStories, doneUnits } = doneUnitsOf(units, doneInWindow)

  const unlinkedPrs = payloads.filter(
    (p) => !linkedPrIds.has(prId(p.repository, p.prNumber))
  ).length
  const payloadMap = await payloadsById(
    db,
    payloads,
    prIdsOf(doneUnits, unitPrs)
  )

  const storyPrIds = prIdsOf(doneStories, unitPrs)
  const gates = prGates
    ? await prGates(storyPrIds.map(parsePrId))
    : { stale: false }
  const snapshots = await findByPrIds(
    db,
    SONAR_PR_SNAPSHOTS_COLLECTION,
    storyPrIds
  )

  const { prsByKey, warnings } = linkPrs(doneUnits, unitPrs, payloadMap)
  const summary = summariseStories(
    doneStories.map((story) =>
      scoreStory(story, unitPrs, { payloadMap, prUnits, snapshots })
    )
  )
  const flow = computeFlowMetrics({
    done: doneUnits,
    issues,
    prsByKey,
    payloads,
    scopes,
    from,
    to
  })

  return {
    projectSlug,
    window: { from: from || null, to: to || null },
    ...summary,
    otherItemsDelivered,
    unlinkedPrRate: percent1(unlinkedPrs, payloads.length),
    ...flow,
    workflow: {
      source: workflow.source,
      version: workflow.version,
      unmappedStatuses: summariseUnmapped(issues)
    },
    sonar: { stale: gates.stale },
    warnings
  }
}
