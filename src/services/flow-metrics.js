// Ticket flow metrics from stored Jira issues (docs/metrics.md §8.2).

const DAY_MS = 24 * 60 * 60 * 1000
const HOUR_MS = 60 * 60 * 1000

// Provisional (metrics.md): a ticket counts as failed when a bug is linked to it
// within this many days of Done.
export const CHANGE_FAIL_WINDOW_DAYS = 14

// Provisional (metrics.md): queue states that count as waiting for flow efficiency.
export const DEFAULT_WAITING_STATUSES = [
  'blocked',
  'on hold',
  'waiting',
  'ready for review',
  'ready for test',
  'awaiting release',
  'ready for release'
]

const toTime = (value) => (value ? new Date(value).getTime() : NaN)
const round1 = (n) => Math.round(n * 10) / 10
const pct = (part, whole) => (whole > 0 ? round1((part / whole) * 100) : 0)

export function median(values) {
  const nums = values.filter(Number.isFinite).sort((a, b) => a - b)
  if (nums.length === 0) return null
  const mid = Math.floor(nums.length / 2)
  return round1(nums.length % 2 ? nums[mid] : (nums[mid - 1] + nums[mid]) / 2)
}

const isBug = (issue) => /bug|defect/i.test(issue?.issueType ?? '')

/** Share of a ticket's cycle time not spent in a waiting status, or null. */
export function ticketFlowEfficiency(
  issue,
  waiting = DEFAULT_WAITING_STATUSES
) {
  const history = issue.statusHistory ?? []
  const end = toTime(issue.resolved)
  if (history.length === 0 || !Number.isFinite(end)) return null
  const start = toTime(history[0].at)
  if (!(end > start)) return null

  const waitingSet = new Set(waiting.map((s) => s.toLowerCase()))
  let waited = 0
  history.forEach((change, i) => {
    if (!waitingSet.has(String(change.to).toLowerCase())) return
    const from = toTime(change.at)
    const until = i + 1 < history.length ? toTime(history[i + 1].at) : end
    waited += Math.max(0, Math.min(until, end) - from)
  })
  return pct(end - start - waited, end - start)
}

/**
 * Flow metrics for tickets Done in a window. `prsByKey` maps a ticket key to
 * its linked PR payloads; `scopes` are sprint scopes captured at sprint start.
 */
export function computeFlowMetrics({
  done,
  issues,
  prsByKey,
  payloads,
  scopes = [],
  from,
  to,
  now = new Date(),
  waitingStatuses = DEFAULT_WAITING_STATUSES
}) {
  const byKey = new Map(issues.map((issue) => [issue.key, issue]))

  const changeLeadDays = []
  let linkedTickets = 0
  let linkedMergedPrs = 0
  for (const story of done) {
    const prs = prsByKey.get(story.key) ?? []
    if (prs.length === 0) continue
    linkedTickets += 1
    linkedMergedPrs += prs.filter((p) => p.prMergedAt).length
    const firstCommit = Math.min(...prs.map((p) => toTime(p.firstCommitAt)))
    const resolved = toTime(story.resolved)
    if (Number.isFinite(firstCommit) && Number.isFinite(resolved)) {
      changeLeadDays.push(Math.max(0, resolved - firstCommit) / DAY_MS)
    }
  }

  const bugs = done.filter(isBug)
  const failed = done.filter((story) => {
    if (story.reopenCount > 0) return true
    const resolved = toTime(story.resolved)
    return (story.issueLinks ?? []).some((link) => {
      const linked = byKey.get(link.key)
      if (!isBug(linked ?? { issueType: link.issueType })) return false
      const created = toTime(linked?.created)
      return (
        !Number.isFinite(created) ||
        (created >= resolved &&
          created - resolved <= CHANGE_FAIL_WINDOW_DAYS * DAY_MS)
      )
    })
  })

  const flow = done
    .map((story) => ticketFlowEfficiency(story, waitingStatuses))
    .filter((v) => v !== null)

  const resolvedTimes = done
    .map((s) => toTime(s.resolved))
    .filter(Number.isFinite)
  const spanStart = from ? toTime(from) : Math.min(...resolvedTimes)
  const spanEnd = to ? toTime(to) : Math.max(...resolvedTimes)
  const weeks = Math.max(1, (spanEnd - spanStart) / (7 * DAY_MS))

  let committed = 0
  let committedDone = 0
  const sprints = []
  for (const scope of scopes) {
    const end = toTime(scope.endDate)
    if (!Number.isFinite(end)) continue
    // Predictability exists only once a sprint has ended.
    if (end > now.getTime()) continue
    // A sprint belongs to the window its end falls in: (from, to].
    if (from && end <= toTime(from)) continue
    if (to && end > toTime(to)) continue
    const keys = scope.issueKeys ?? []
    const doneByEnd = keys.filter((key) => {
      const issue = byKey.get(key)
      const at = toTime(issue?.firstDoneAt ?? issue?.resolved)
      return Number.isFinite(at) && at <= end
    }).length
    committed += keys.length
    committedDone += doneByEnd
    sprints.push({
      name: scope.name,
      committed: keys.length,
      done: doneByEnd,
      predictability: pct(doneByEnd, keys.length)
    })
  }

  const prCycleHours = payloads
    .filter((p) => p.prMergedAt && p.prCreatedAt)
    .map((p) => (toTime(p.prMergedAt) - toTime(p.prCreatedAt)) / HOUR_MS)

  return {
    changeLeadTimeDays: median(changeLeadDays),
    deliveryFrequencyPerWeek: done.length > 0 ? round1(done.length / weeks) : 0,
    defectRecoveryTimeDays: median(
      bugs.map((b) => (toTime(b.resolved) - toTime(b.created)) / DAY_MS)
    ),
    bugsDelivered: bugs.length,
    changeFailRate: pct(failed.length, done.length),
    failedTickets: failed.map((s) => s.key),
    deliveryReworkRate: pct(bugs.length, done.length),
    workInProgress: issues.filter(
      (i) => i.status?.categoryKey === 'indeterminate'
    ).length,
    flowEfficiency: flow.length > 0 ? median(flow) : null,
    sprintPredictability: committed > 0 ? pct(committedDone, committed) : null,
    sprints,
    prsPerTicket:
      linkedTickets > 0 ? round1(linkedMergedPrs / linkedTickets) : null,
    prCycleTimeHours: median(prCycleHours)
  }
}
