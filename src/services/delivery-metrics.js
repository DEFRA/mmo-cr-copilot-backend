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
  if (!map.has(key)) map.set(key, new Set())
  map.get(key).add(value)
}

// The newest document per PR, so a PR with payload history reads its latest.
async function findByPrIds(db, collection, ids) {
  const found = new Map()
  if (ids.length === 0) return found
  const docs = await db
    .collection(collection)
    .find({ $or: ids.map(parsePrId) })
    .sort({ calculatedAt: -1 })
    .toArray()
  for (const doc of docs) {
    const id = prId(doc.repository, doc.prNumber)
    if (!found.has(id)) found.set(id, doc)
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
  if (!values || values.length === 0) return 0
  const sorted = [...values].sort((a, b) => a - b)
  const mid = Math.floor(sorted.length / 2)
  const median =
    sorted.length % 2 !== 0 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2
  return Math.round(median * 10) / 10
}

// Computes the SonarCloud quality multiplier Q_Sonar for a PR.
function computeSonarMultiplier(sonar, linesAdded, k) {
  if (!sonar) return 1.0

  const status =
    sonar.qualityGate || sonar.alert_status || sonar.measures?.alert_status
  const isPassed = status === 'passed' || status === 'OK'
  const qgFactor = isPassed ? 1.0 : 0.2

  const tdr = Math.min(
    1.0,
    Math.max(0, Number(sonar.measures?.new_sqale_debt_ratio) || 0)
  )
  const dup = Math.min(
    100,
    Math.max(0, Number(sonar.measures?.new_duplicated_lines_density) || 0)
  )
  const blockerHigh =
    (Number(sonar.measures?.new_software_quality_blocker_issues) || 0) +
    (Number(sonar.measures?.new_software_quality_high_issues) || 0)
  const kloc = linesAdded / k / 1000
  const defectPenalty = kloc > 0 ? Math.min(1.0, blockerHigh / (kloc * 5)) : 0

  return Math.max(
    0,
    qgFactor * (1 - tdr) * (1 - dup / 100) * (1 - defectPenalty)
  )
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
  const fromDate = from ? new Date(from) : null
  const toDate = to ? new Date(to) : null
  const doneInWindow = ({ flow }) =>
    flow.stageKind === 'done' &&
    flow.doneAt &&
    (!fromDate || flow.doneAt >= fromDate) &&
    (!toDate || flow.doneAt < toDate)

  const byKey = new Map(issues.map((issue) => [issue.key, issue]))
  const unitPrs = new Map()
  const prUnits = new Map()
  const linkedPrIds = new Set()
  let otherItemsDelivered = 0
  for (const [key, ids] of referenced) {
    ids.forEach((id) => linkedPrIds.add(id))
    const issue = byKey.get(key)
    if (!issue) continue
    const unit = deliveryUnitKey(issue, byKey)
    if (!unit) {
      if (doneInWindow(issue)) otherItemsDelivered += 1
      continue
    }
    for (const id of ids) {
      addTo(unitPrs, unit, id)
      addTo(prUnits, id, unit)
    }
  }
  const units = [...unitPrs.keys()].map((key) => byKey.get(key))
  const doneStories = units.filter(
    (unit) => isStoryType(unit.issueType) && doneInWindow(unit)
  )
  const doneBugs = units.filter(
    (unit) =>
      !isStoryType(unit.issueType) &&
      isBugType(unit.issueType) &&
      doneInWindow(unit)
  )
  const doneUnits = [...doneStories, ...doneBugs]

  const unlinkedPrs = payloads.filter(
    (p) => !linkedPrIds.has(prId(p.repository, p.prNumber))
  ).length
  const totalPrs = payloads.length
  const unlinkedPrRate =
    totalPrs > 0 ? Math.round((unlinkedPrs / totalPrs) * 1000) / 10 : 0

  const payloadMap = new Map(
    payloads.map((p) => [prId(p.repository, p.prNumber), p])
  )
  const unitPrIds = [
    ...new Set(doneUnits.flatMap((unit) => [...unitPrs.get(unit.key)]))
  ]
  const outsideWindow = await findByPrIds(
    db,
    PAYLOADS_COLLECTION,
    unitPrIds.filter((id) => !payloadMap.has(id))
  )
  for (const [id, doc] of outsideWindow) payloadMap.set(id, toPayload(doc))

  const storyPrIds = [
    ...new Set(doneStories.flatMap((story) => [...unitPrs.get(story.key)]))
  ]
  const gates = prGates
    ? await prGates(storyPrIds.map(parsePrId))
    : { stale: false }
  const snapshots = await findByPrIds(
    db,
    SONAR_PR_SNAPSHOTS_COLLECTION,
    storyPrIds
  )

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

  let totalQualityELoc = 0
  let totalCycleDays = 0
  let totalStoryPoints = 0
  let complexityAdjustedELoc = 0
  let complexityCycleDays = 0
  let sduCount = 0
  let firstScanPassedStoriesCount = 0
  let reopenedStories = 0
  const leadTimes = []
  const cycleTimes = []

  for (const story of doneStories) {
    const cycleTime = Math.max(0.1, story.flow.cycleDays ?? 0.1)

    if (Number.isFinite(story.flow.leadDays)) {
      leadTimes.push(story.flow.leadDays)
    }
    cycleTimes.push(cycleTime)
    totalCycleDays += cycleTime

    const sp =
      typeof story.storyPoints === 'number'
        ? story.storyPoints
        : Number(story.storyPoints) || 0
    totalStoryPoints += sp

    if (story.flow.reopenCount > 0) reopenedStories += 1

    const storyPrIdList = [...unitPrs.get(story.key)]

    let storyQualityELoc = 0
    let storyComplexityELoc = 0
    let hasComplexityScore = false
    let hasSonarSnapshots = false
    let allSonarPassed = storyPrIdList.length > 0
    let allFirstScanPassed = storyPrIdList.length > 0

    for (const id of storyPrIdList) {
      const p = payloadMap.get(id)

      const linesAdded =
        p?.summary?.linesAdded ?? sumLines(p?.commitBreakdown, 'linesAdded')
      const linesDeleted =
        p?.summary?.linesDeleted ?? sumLines(p?.commitBreakdown, 'linesDeleted')
      const k = prUnits.get(id)?.size || 1
      const netLines = Math.max(0, linesAdded - linesDeleted) / k

      const sonar = snapshots.get(id)

      if (sonar) {
        hasSonarSnapshots = true
        const status =
          sonar.qualityGate ||
          sonar.alert_status ||
          sonar.measures?.alert_status
        const passedGate = status === 'passed' || status === 'OK'
        const firstScanPassed =
          sonar.firstScanQualityGate === 'passed' ||
          sonar.firstScanQualityGate === 'OK'

        if (!passedGate) allSonarPassed = false
        if (!firstScanPassed) allFirstScanPassed = false
      } else {
        allSonarPassed = false
        allFirstScanPassed = false
      }

      const qSonar = computeSonarMultiplier(sonar, linesAdded, k)
      storyQualityELoc += netLines * qSonar

      const complexityScore =
        p?.complexity?.score ??
        (p?.files ? computeComplexityScore(p.files).score : null)
      if (complexityScore > 0) {
        hasComplexityScore = true
        storyComplexityELoc += (netLines * qSonar) / complexityScore
      }
    }

    // QANT_comp counts only stories whose linked PRs carry a complexity score.
    if (hasComplexityScore) {
      complexityAdjustedELoc += storyComplexityELoc
      complexityCycleDays += cycleTime
    }

    if (hasSonarSnapshots && allSonarPassed) {
      sduCount += 1
    }
    if (hasSonarSnapshots && allFirstScanPassed) {
      firstScanPassedStoriesCount += 1
    }

    totalQualityELoc += storyQualityELoc
  }

  const storiesDelivered = doneStories.length
  const qant =
    totalCycleDays > 0
      ? Math.round((totalQualityELoc / totalCycleDays) * 10) / 10
      : 0
  const qantComp =
    complexityCycleDays > 0
      ? Math.round((complexityAdjustedELoc / complexityCycleDays) * 100) / 100
      : 0
  const storyPointVelocity =
    totalStoryPoints > 0
      ? Math.round((totalQualityELoc / totalStoryPoints) * 10) / 10
      : 0
  const leadTimeToDoneDays = calculateMedian(leadTimes)
  const cycleTimeDays = calculateMedian(cycleTimes)
  const firstScanPassRate =
    storiesDelivered > 0
      ? Math.round((firstScanPassedStoriesCount / storiesDelivered) * 1000) / 10
      : 0
  const reopenRate =
    storiesDelivered > 0
      ? Math.round((reopenedStories / storiesDelivered) * 1000) / 10
      : 0
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
    qant,
    qantComp,
    storyPointVelocity,
    standardDeployableUnits: sduCount,
    leadTimeToDoneDays,
    cycleTimeDays,
    storiesDelivered,
    storyPointsDelivered: round1(totalStoryPoints),
    otherItemsDelivered,
    unlinkedPrRate,
    firstScanPassRate,
    reopenRate,
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
