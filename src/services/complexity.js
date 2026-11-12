import { DAY_MS, HOUR_MS } from '#/common/helpers/time.js'
import { DEFAULT_SPRINT_LENGTH_DAYS } from '#/schemas/project.js'
import { findProject } from '#/services/projects.js'
import { PAYLOADS_COLLECTION } from '#/services/payloads.js'
import { listSurvival } from '#/services/survival.js'

// ADR 0005 D10: above this share of AI lines rewritten within the window, the
// delivered volume is discounted by (1 − CCR).
export const CHURN_PENALTY_THRESHOLD_PERCENT = 25
const CHURN_WINDOW_DAYS = 21
const ORIGINS = ['aiAgent', 'aiCompletion', 'aiChat']
const MIN_SCORE = 1
const MAX_SCORE = 100
// Upper score bound of each band; anything above the last is XL.
const BAND_LIMITS = Object.entries({ XS: 20, S: 40, M: 60, L: 80 })
const BULK_BATCH_SIZE = 500
const DEFAULT_ADOPTION_DATE = '2026-01-01T00:00:00.000Z'

const round1 = (value) => Math.round(value * 10) / 10
const round3 = (value) => Math.round(value * 1000) / 1000
const churnPercent = (merged, surviving) =>
  merged > 0 ? round1((100 * (merged - surviving)) / merged) : null

// PR coding cycle time (metrics.md): last minus first counted commit, in hours.
export function codingCycleHours(p) {
  if (Number(p.codingCycleTimeHours) > 0) {
    return Number(p.codingCycleTimeHours)
  }
  const first = new Date(p.firstCommitAt).getTime()
  const last = new Date(p.lastCommitAt).getTime()
  return Number.isFinite(first) && Number.isFinite(last) && last > first
    ? (last - first) / HOUR_MS
    : 0
}

function sat(val, cap) {
  const x = Math.max(0, Number(val) || 0)
  return Math.min(1, Math.log(1 + x) / Math.log(1 + cap))
}

// ADR 0004 defaults; a project may override them (E6-S7).
export const DEFAULT_COMPLEXITY_MODEL = Object.freeze({
  lineCap: 400,
  fileCap: 25,
  moduleCap: 5,
  weights: Object.freeze({ lines: 0.5, files: 0.3, modules: 0.2 }),
  hardCapLines: 400,
  hardCapFiles: 50,
  version: 1
})

export function computeComplexityScore(
  files = {},
  model = DEFAULT_COMPLEXITY_MODEL
) {
  const m = { ...DEFAULT_COMPLEXITY_MODEL, ...model }
  const w = { ...DEFAULT_COMPLEXITY_MODEL.weights, ...model.weights }
  const L = Math.max(0, Number(files.linesTouched) || 0)
  const F = Math.max(0, Number(files.changed) || 0)
  const M = Math.max(0, Number(files.modulesTouched) || 0)

  if (L > m.hardCapLines || F > m.hardCapFiles) {
    return {
      score: MAX_SCORE,
      band: 'XL',
      version: m.version,
      inputs: { L, F, M }
    }
  }

  const raw =
    MIN_SCORE +
    (MAX_SCORE - MIN_SCORE) *
      (w.lines * sat(L, m.lineCap) +
        w.files * sat(F, m.fileCap) +
        w.modules * sat(M, m.moduleCap))
  const score = Math.min(MAX_SCORE, Math.max(MIN_SCORE, Math.round(raw)))
  const band = BAND_LIMITS.find(([, limit]) => score <= limit)?.[0] ?? 'XL'

  return { score, band, version: m.version, inputs: { L, F, M } }
}

/** Rescores every payload with its project's current model; returns the count. */
export async function recomputeComplexity(db) {
  const models = new Map()
  const projects = await db
    .collection('projects')
    .find({}, { projection: { slug: 1, complexity: 1 } })
    .toArray()
  for (const p of projects) {
    models.set(p.slug, p.complexity)
  }

  const collection = db.collection(PAYLOADS_COLLECTION)
  const cursor = collection.find(
    { files: { $exists: true } },
    { projection: { files: 1, projectSlug: 1 } }
  )
  let updated = 0
  let batch = []
  for await (const doc of cursor) {
    const complexity = computeComplexityScore(
      doc.files,
      models.get(doc.projectSlug) ?? DEFAULT_COMPLEXITY_MODEL
    )
    batch.push({
      updateOne: { filter: { _id: doc._id }, update: { $set: { complexity } } }
    })
    if (batch.length === BULK_BATCH_SIZE) {
      updated += (await collection.bulkWrite(batch)).modifiedCount
      batch = []
    }
  }
  if (batch.length > 0) {
    updated += (await collection.bulkWrite(batch)).modifiedCount
  }
  return updated
}

function median(values) {
  if (!values.length) {
    return 0
  }
  const sorted = [...values].sort((a, b) => a - b)
  const mid = Math.floor(sorted.length / 2)
  return sorted.length % 2 !== 0
    ? sorted[mid]
    : (sorted[mid - 1] + sorted[mid]) / 2
}

// ADR 0004: a band is compared only with at least 5 PRs on each side.
const MIN_BAND_SAMPLE = 5

// PR rework ratio (metrics.md): lines deleted ÷ lines added across counted commits.
export function prReworkRatio(p) {
  const commits = p.commitBreakdown ?? []
  const added = commits.reduce((n, c) => n + (Number(c.linesAdded) || 0), 0)
  const deleted = commits.reduce((n, c) => n + (Number(c.linesDeleted) || 0), 0)
  return added > 0 ? deleted / added : null
}

const BANDS = ['XS', 'S', 'M', 'L', 'XL']

// Only merged work counts: an open PR has no finished cycle to compare.
function splitCohorts(payloads, adoptionDate, { from, to }) {
  const baseline = []
  const adopted = []
  const inWindow = (merged) =>
    (!from || merged >= new Date(from)) && (!to || merged < new Date(to))
  for (const p of payloads.filter((payload) => payload.prMergedAt)) {
    const merged = new Date(p.prMergedAt)
    const scored = {
      ...p,
      complexity: p.complexity || computeComplexityScore(p.files || {})
    }
    if (merged < adoptionDate) {
      baseline.push(scored)
    } else if (inWindow(merged)) {
      adopted.push(scored)
    } else {
      // Adopted-era PRs outside the window are not compared.
    }
  }
  return { baseline, adopted }
}

const medianOf = (prs, measure, keep) => median(prs.map(measure).filter(keep))
const positive = (value) => value > 0
const measured = (value) => value !== null

function compareBand(band, baseline, adopted) {
  const baseInBand = baseline.filter((p) => p.complexity.band === band)
  const adoptInBand = adopted.filter((p) => p.complexity.band === band)
  const baseMedCycle = medianOf(baseInBand, codingCycleHours, positive)
  const adoptMedCycle = medianOf(adoptInBand, codingCycleHours, positive)
  const baseMedRework = medianOf(baseInBand, prReworkRatio, measured)
  const adoptMedRework = medianOf(adoptInBand, prReworkRatio, measured)
  const speedup =
    baseMedCycle > 0 && adoptMedCycle > 0 ? baseMedCycle / adoptMedCycle : 1
  return {
    weight: adoptInBand.length,
    speedup,
    baseMedRework,
    adoptMedRework,
    summary: {
      baselineCount: baseInBand.length,
      adoptedCount: adoptInBand.length,
      baselineMedianCycleHours: baseMedCycle,
      adoptedMedianCycleHours: adoptMedCycle,
      baselineMedianReworkRatio: Number(baseMedRework.toFixed(2)),
      adoptedMedianReworkRatio: Number(adoptMedRework.toFixed(2)),
      speedup: Number(speedup.toFixed(2)),
      comparable:
        baseInBand.length >= MIN_BAND_SAMPLE &&
        adoptInBand.length >= MIN_BAND_SAMPLE
    }
  }
}

// Direct standardisation: each comparable band counts by its share of the adopted cohort.
function standardise(bands) {
  const comparable = bands.filter((b) => b.summary.comparable)
  const weight = comparable.reduce((sum, b) => sum + b.weight, 0)
  const weighted = (pick) =>
    Number(
      (
        comparable.reduce((sum, b) => sum + pick(b) * b.weight, 0) / weight
      ).toFixed(2)
    )
  if (comparable.length === 0) {
    return { comparableBands: 0, score: null, rework: null }
  }
  return {
    comparableBands: comparable.length,
    score: weighted((b) => b.speedup),
    rework: {
      baseline: weighted((b) => b.baseMedRework),
      adopted: weighted((b) => b.adoptMedRework)
    }
  }
}

/**
 * Copilot Leverage v2 (ADR 0004). Merged PRs before the adoption date are the
 * baseline and merged PRs in the window the adopted cohort. Within each
 * complexity band the medians are compared, and the bands that have enough PRs
 * on both sides are combined by direct standardisation: each band counts in
 * proportion to its share of the adopted cohort, so a run of small PRs cannot
 * look like a gain. `repository` narrows both cohorts to one repository.
 */
export async function computeLeverageV2(
  db,
  projectSlug,
  { from, to, repository } = {}
) {
  const project = await findProject(db, projectSlug)
  if (!project) {
    return null
  }

  const adoptionDate = new Date(
    project.adoptionStartDate ?? DEFAULT_ADOPTION_DATE
  )

  const payloads = await db
    .collection(PAYLOADS_COLLECTION)
    .find({ projectSlug, ...(repository ? { repository } : {}) })
    .sort({ calculatedAt: -1 })
    .toArray()

  const { baseline, adopted } = splitCohorts(payloads, adoptionDate, {
    from,
    to
  })
  const bands = BANDS.map((band) => compareBand(band, baseline, adopted))
  const { comparableBands, score, rework } = standardise(bands)
  const enoughData = comparableBands > 0

  return {
    projectSlug,
    ...(repository ? { repository } : {}),
    adoptionStartDate: adoptionDate.toISOString(),
    // null, not 1.0, when nothing is comparable: "no change" would be a claim.
    overallLeverageScore: score,
    enoughData,
    comparableBands,
    standardisedReworkRatio: rework,
    bandComparison: Object.fromEntries(
      BANDS.map((band, i) => [band, bands[i].summary])
    ),
    sampleSize: { baseline: baseline.length, adopted: adopted.length }
  }
}

/**
 * AI code churn rate CCR_N (ADR 0005, D10): the share of AI-written lines in
 * merged pull requests that were rewritten or deleted within N days. Computed
 * from the survival records the scheduled workflow posts (ADR 0007).
 * Above 25% the delivered volume is discounted by (1 − CCR); with no
 * measured pull request nothing is claimed and no discount applies.
 */
export async function computeCodeChurn(
  db,
  projectSlug,
  { windowDays = CHURN_WINDOW_DAYS, from, to } = {}
) {
  const days = Number(windowDays)
  const records = await listSurvival(db, {
    projectSlug,
    windowDays: days,
    from,
    to
  })

  const sum = (pick) => records.reduce((total, r) => total + pick(r), 0)
  const aiMerged = sum((r) => r.aiLinesMerged)

  if (aiMerged === 0) {
    return {
      projectSlug,
      windowDays: days,
      available: false,
      reason: `No AI lines merged in this period have reached ${days} days yet`,
      churnRatePercent: null,
      // The 25% threshold discounts delivered volume by (1 − CCR); with no
      // CCR there is nothing to discount.
      churnPenaltyPercent: 0,
      effectiveMultiplier: 1,
      prCount: records.length
    }
  }

  const aiSurviving = sum((r) => r.aiLinesSurviving)
  const churnRatePercent = churnPercent(aiMerged, aiSurviving)
  const penaltyApplied = churnRatePercent > CHURN_PENALTY_THRESHOLD_PERCENT

  const byOrigin = Object.fromEntries(
    ORIGINS.map((origin) => {
      const merged = sum((r) => r.byOrigin?.[origin]?.merged ?? 0)
      const surviving = sum((r) => r.byOrigin?.[origin]?.surviving ?? 0)
      return [
        origin,
        { merged, surviving, churnPercent: churnPercent(merged, surviving) }
      ]
    })
  )

  return {
    projectSlug,
    windowDays: days,
    available: true,
    prCount: records.length,
    aiLinesMerged: aiMerged,
    aiLinesSurviving: aiSurviving,
    churnRatePercent,
    humanChurnPercent: churnPercent(
      sum((r) => r.humanLinesMerged),
      sum((r) => r.humanLinesSurviving)
    ),
    penaltyApplied,
    churnPenaltyPercent: penaltyApplied ? churnRatePercent : 0,
    effectiveMultiplier: penaltyApplied
      ? round3(1 - churnRatePercent / 100)
      : 1,
    byOrigin
  }
}

// Own baseline: the project's first N sprints of activity (ADR 0004).
function ownBaseline(project, all, inWindow, time, baselineSprintCount) {
  const cadenceMs =
    (project.sprintCalendar?.cadenceDays ?? DEFAULT_SPRINT_LENGTH_DAYS) * DAY_MS
  const baselineEnd = all.length
    ? time(all[0]) + Number(baselineSprintCount) * cadenceMs
    : 0
  const cycles = (prs) => prs.map(codingCycleHours).filter(positive)
  const baselineCycles = cycles(all.filter((p) => time(p) < baselineEnd))
  const currentCycles = cycles(inWindow.filter((p) => time(p) >= baselineEnd))
  const baselineMedian = median(baselineCycles)
  const currentMedian = median(currentCycles)
  const comparable =
    baselineCycles.length >= MIN_BAND_SAMPLE &&
    currentCycles.length >= MIN_BAND_SAMPLE
  return {
    baselineSprintCount: Number(baselineSprintCount),
    baselineMedianCycleHours: Number(baselineMedian.toFixed(1)),
    currentMedianCycleHours: Number(currentMedian.toFixed(1)),
    baselineCount: baselineCycles.length,
    currentCount: currentCycles.length,
    comparable,
    speedup:
      comparable && currentMedian > 0
        ? Number((baselineMedian / currentMedian).toFixed(2))
        : null
  }
}

// Survival of AI lines after merge (ADR 0007); unavailable until one PR is measured.
function codeDurability(churn) {
  if (!churn.available) {
    return { available: false }
  }
  return {
    available: true,
    windowDays: churn.windowDays,
    prCount: churn.prCount,
    aiSurvivalPercent: round1(MAX_SCORE - churn.churnRatePercent),
    humanSurvivalPercent:
      churn.humanChurnPercent === null
        ? null
        : round1(MAX_SCORE - churn.humanChurnPercent)
  }
}

export async function computeAiNativeDeliveryLeverage(
  db,
  projectSlug,
  { baselineSprintCount = 3, from, to } = {}
) {
  const project = await findProject(db, projectSlug)
  if (!project) {
    return null
  }

  // Last commit, not analysis time: a backfill analyses months of PRs at once.
  const time = (p) => new Date(p.lastCommitAt ?? p.calculatedAt).getTime()
  const all = (
    await db.collection(PAYLOADS_COLLECTION).find({ projectSlug }).toArray()
  ).sort((a, b) => time(a) - time(b))
  const inWindow = all.filter(
    (p) =>
      (!from || time(p) >= new Date(from).getTime()) &&
      (!to || time(p) < new Date(to).getTime())
  )

  const complexityWeightedThroughput = inWindow
    .filter((p) => p.prMergedAt)
    .reduce(
      (sum, p) =>
        sum + (p.complexity ?? computeComplexityScore(p.files ?? {})).score,
      0
    )

  // Imported lazily: delivery metrics pull in the Jira client and its config,
  // which payloads.js (an importer of this module) must not load eagerly.
  const { computeDeliveryMetrics } =
    await import('#/services/delivery-metrics.js')
  const delivery = await computeDeliveryMetrics(db, projectSlug, { from, to })
  const churn = await computeCodeChurn(db, projectSlug, { from, to })

  return {
    projectSlug,
    projectType: project.type,
    ownBaseline: ownBaseline(project, all, inWindow, time, baselineSprintCount),
    complexityWeightedThroughput,
    mergedPullRequests: inWindow.filter((p) => p.prMergedAt).length,
    deliveryQuality: {
      changeFailRate: delivery.changeFailRate,
      deliveryReworkRate: delivery.deliveryReworkRate,
      reopenRate: delivery.reopenRate
    },
    codeDurability: codeDurability(churn)
  }
}
