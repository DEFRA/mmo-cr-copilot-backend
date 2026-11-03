import {
  JIRA_ISSUES_COLLECTION,
  PR_JIRA_LINKS_COLLECTION
} from '#/services/jira.js'
import { PAYLOADS_COLLECTION, toPayload } from '#/services/payloads.js'
import { findProjectPayloads } from '#/services/projects.js'
import { computeFlowMetrics } from '#/services/flow-metrics.js'
import { computeComplexityScore } from '#/services/complexity.js'

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

// Computes QANT, SDU, and delivery DORA metrics for a project in a window.
export async function computeDeliveryMetrics(
  db,
  projectSlug,
  { from, to } = {}
) {
  const issueFilter = {
    projectSlug,
    'status.categoryKey': 'done'
  }
  const resolvedFilter = {}
  if (from) resolvedFilter.$gte = new Date(from)
  if (to) resolvedFilter.$lt = new Date(to)
  if (Object.keys(resolvedFilter).length > 0) {
    issueFilter.resolved = resolvedFilter
  }

  const doneStories = await db
    .collection(JIRA_ISSUES_COLLECTION)
    .find(issueFilter)
    .toArray()

  const links = await db
    .collection(PR_JIRA_LINKS_COLLECTION)
    .find({ projectSlug })
    .toArray()

  const payloads = await findProjectPayloads(db, projectSlug, { from, to })

  const payloadMap = new Map()
  for (const p of payloads) {
    payloadMap.set(`${p.repository}#${p.prNumber}`, p)
  }

  const jiraKeyToPrs = new Map()
  const prToJiraKeys = new Map()

  const recordLink = (jiraKey, prId) => {
    if (!jiraKeyToPrs.has(jiraKey)) jiraKeyToPrs.set(jiraKey, new Set())
    jiraKeyToPrs.get(jiraKey).add(prId)

    if (!prToJiraKeys.has(prId)) prToJiraKeys.set(prId, new Set())
    prToJiraKeys.get(prId).add(jiraKey)
  }

  for (const link of links) {
    recordLink(link.jiraKey, `${link.repository}#${link.prNumber}`)
  }

  for (const p of payloads) {
    const prId = `${p.repository}#${p.prNumber}`
    if (Array.isArray(p.jiraKeys)) {
      for (const key of p.jiraKeys) {
        recordLink(key, prId)
      }
    }
  }

  let unlinkedPrs = 0
  for (const p of payloads) {
    const prId = `${p.repository}#${p.prNumber}`
    const keys = prToJiraKeys.get(prId)
    if (!keys || keys.size === 0) {
      unlinkedPrs += 1
    }
  }
  const totalPrs = payloads.length
  const unlinkedPrRate =
    totalPrs > 0 ? Math.round((unlinkedPrs / totalPrs) * 1000) / 10 : 0

  let totalQualityELoc = 0
  let totalCycleDays = 0
  let totalStoryPoints = 0
  let complexityAdjustedELoc = 0
  let complexityCycleDays = 0
  let sduCount = 0
  let firstScanPassedStoriesCount = 0
  let reopenedStories = 0
  const warnings = []
  const prsByKey = new Map()
  const leadTimes = []
  const cycleTimes = []

  for (const story of doneStories) {
    const created = story.created ? new Date(story.created) : null
    const resolved = story.resolved
      ? new Date(story.resolved)
      : story.updated
        ? new Date(story.updated)
        : null
    const started = story.started ? new Date(story.started) : created

    const leadTime =
      created && resolved
        ? Math.max(0, (resolved - created) / (1000 * 60 * 60 * 24))
        : 0
    const cycleTime =
      started && resolved
        ? Math.max(0.1, (resolved - started) / (1000 * 60 * 60 * 24))
        : 0.1

    leadTimes.push(leadTime)
    cycleTimes.push(cycleTime)
    totalCycleDays += cycleTime

    const sp =
      typeof story.storyPoints === 'number'
        ? story.storyPoints
        : Number(story.storyPoints) || 0
    totalStoryPoints += sp

    if (story.reopenCount > 0) reopenedStories += 1

    const linkedPrIds = jiraKeyToPrs.has(story.key)
      ? [...jiraKeyToPrs.get(story.key)]
      : []

    let storyQualityELoc = 0
    let storyComplexityELoc = 0
    let hasComplexityScore = false
    let hasOpenPr = false
    let hasSonarSnapshots = false
    let allSonarPassed = linkedPrIds.length > 0
    let allFirstScanPassed = linkedPrIds.length > 0

    for (const prId of linkedPrIds) {
      const [repo, prNumStr] = prId.split('#')
      const prNum = Number(prNumStr)
      let p = payloadMap.get(prId)
      if (!p) {
        const doc = await db
          .collection(PAYLOADS_COLLECTION)
          .findOne({ repository: repo, prNumber: prNum })
        if (doc) p = toPayload(doc)
      }
      if (p && !p.prMergedAt) hasOpenPr = true
      if (p) {
        if (!prsByKey.has(story.key)) prsByKey.set(story.key, [])
        prsByKey.get(story.key).push(p)
      }

      const linesAdded =
        p?.summary?.linesAdded ?? sumLines(p?.commitBreakdown, 'linesAdded')
      const linesDeleted =
        p?.summary?.linesDeleted ?? sumLines(p?.commitBreakdown, 'linesDeleted')
      const k = prToJiraKeys.get(prId)?.size || 1
      const netLines = Math.max(0, linesAdded - linesDeleted) / k

      const sonar = await db
        .collection('sonar-pr-snapshots')
        .findOne({ repository: repo, prNumber: prNum })

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

    if (hasOpenPr) {
      warnings.push({ key: story.key, type: 'done-with-open-pr' })
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
  const [allIssues, scopes, project] = await Promise.all([
    db.collection(JIRA_ISSUES_COLLECTION).find({ projectSlug }).toArray(),
    db.collection('jira-sprint-scope').find({ projectSlug }).toArray(),
    db.collection('projects').findOne({ slug: projectSlug })
  ])
  const flow = computeFlowMetrics({
    done: doneStories,
    issues: allIssues,
    prsByKey,
    payloads,
    scopes,
    from,
    to,
    ...(project?.jira?.waitingStatuses?.length
      ? { waitingStatuses: project.jira.waitingStatuses }
      : {})
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
    unlinkedPrRate,
    firstScanPassRate,
    reopenRate,
    ...flow,
    warnings
  }
}
