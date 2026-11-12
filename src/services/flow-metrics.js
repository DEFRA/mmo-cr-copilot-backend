// Ticket flow metrics from stored Jira issues with derived flow (docs/metrics.md §8.2, ADR 0011).

import { DAY_MS, HOUR_MS, WEEK_MS } from '#/common/helpers/time.js'

// Provisional (metrics.md): a ticket counts as failed when a bug is linked to it
// within this many days of Done.
export const CHANGE_FAIL_WINDOW_DAYS = 14

const WIP_KINDS = new Set(['active', 'waiting', 'unmapped'])

const toTime = (value) => (value ? new Date(value).getTime() : Number.NaN)
const round1 = (n) => Math.round(n * 10) / 10
const pct = (part, whole) => (whole > 0 ? round1((part / whole) * 100) : 0)
const doneTime = (issue) => toTime(issue.flow.doneAt)
const reopens = (issue) => issue.flow.reopenCount ?? 0
const firstDoneTime = (issue) => toTime(issue?.flow?.firstDoneAt)
const isInProgress = (issue) => WIP_KINDS.has(issue.flow?.stageKind)

export function median(values) {
  const nums = values.filter(Number.isFinite).sort((a, b) => a - b)
  if (nums.length === 0) {
    return null
  }
  const mid = Math.floor(nums.length / 2)
  return round1(nums.length % 2 ? nums[mid] : (nums[mid - 1] + nums[mid]) / 2)
}

const isBug = (issue) => /bug|defect/i.test(issue?.issueType ?? '')

// Lead time from first commit to Done, and PRs per ticket, over linked tickets.
function linkedTicketStats(done, prsByKey) {
  const changeLeadDays = []
  let linkedTickets = 0
  let linkedMergedPrs = 0
  for (const story of done) {
    const prs = prsByKey.get(story.key) ?? []
    if (prs.length > 0) {
      linkedTickets += 1
      linkedMergedPrs += prs.filter((p) => p.prMergedAt).length
      const firstCommit = Math.min(...prs.map((p) => toTime(p.firstCommitAt)))
      const resolved = doneTime(story)
      if (Number.isFinite(firstCommit) && Number.isFinite(resolved)) {
        changeLeadDays.push(Math.max(0, resolved - firstCommit) / DAY_MS)
      }
    }
  }
  return {
    changeLeadTimeDays: median(changeLeadDays),
    prsPerTicket:
      linkedTickets > 0 ? round1(linkedMergedPrs / linkedTickets) : null
  }
}

// A bug linked within the window after Done (or of unknown date) fails the ticket.
function hasLinkedBug(story, byKey) {
  const resolved = doneTime(story)
  return (story.issueLinks ?? []).some((link) => {
    const linked = byKey.get(link.key)
    if (!isBug(linked ?? { issueType: link.issueType })) {
      return false
    }
    const created = toTime(linked?.created)
    return (
      !Number.isFinite(created) ||
      (created >= resolved &&
        created - resolved <= CHANGE_FAIL_WINDOW_DAYS * DAY_MS)
    )
  })
}

function deliveryWeeks(done, from, to) {
  const resolvedTimes = done.map(doneTime).filter(Number.isFinite)
  const spanStart = from ? toTime(from) : Math.min(...resolvedTimes)
  const spanEnd = to ? toTime(to) : Math.max(...resolvedTimes)
  return Math.max(1, (spanEnd - spanStart) / WEEK_MS)
}

// Predictability exists once a sprint has ended; a sprint belongs to the window its end falls in: (from, to].
function endedInWindow(end, { from, to, now }) {
  return (
    Number.isFinite(end) &&
    end <= now.getTime() &&
    !(from && end <= toTime(from)) &&
    !(to && end > toTime(to))
  )
}

function sprintPredictability(scopes, byKey, window) {
  const sprints = scopes
    .filter((scope) => endedInWindow(toTime(scope.endDate), window))
    .map((scope) => {
      const end = toTime(scope.endDate)
      const keys = (scope.issueKeys ?? []).filter((key) => byKey.has(key))
      const doneByEnd = keys.filter((key) => {
        const at = firstDoneTime(byKey.get(key))
        return Number.isFinite(at) && at <= end
      }).length
      return {
        name: scope.name,
        committed: keys.length,
        done: doneByEnd,
        predictability: pct(doneByEnd, keys.length)
      }
    })
  const committed = sprints.reduce((sum, s) => sum + s.committed, 0)
  const committedDone = sprints.reduce((sum, s) => sum + s.done, 0)
  return {
    sprintPredictability: committed > 0 ? pct(committedDone, committed) : null,
    sprints
  }
}

/**
 * Flow metrics for tickets Done in a window. Every issue carries `flow`
 * (workflow-stages.js); `prsByKey` maps a ticket key to its linked PR
 * payloads; `scopes` are sprint scopes captured at sprint start; only keys
 * among `issues` count as committed.
 */
export function computeFlowMetrics({
  done,
  issues,
  prsByKey,
  payloads,
  scopes = [],
  from,
  to,
  now = new Date()
}) {
  const byKey = new Map(issues.map((issue) => [issue.key, issue]))
  const { changeLeadTimeDays, prsPerTicket } = linkedTicketStats(done, prsByKey)
  const bugs = done.filter(isBug)
  const failed = done.filter(
    (story) => reopens(story) > 0 || hasLinkedBug(story, byKey)
  )
  const flow = done
    .map((story) => story.flow.flowEfficiency)
    .filter((v) => v !== null && v !== undefined)
  const weeks = deliveryWeeks(done, from, to)
  const { sprintPredictability: predictability, sprints } =
    sprintPredictability(scopes, byKey, { from, to, now })

  const prCycleHours = payloads
    .filter((p) => p.prMergedAt && p.prCreatedAt)
    .map((p) => (toTime(p.prMergedAt) - toTime(p.prCreatedAt)) / HOUR_MS)

  return {
    changeLeadTimeDays,
    deliveryFrequencyPerWeek: done.length > 0 ? round1(done.length / weeks) : 0,
    defectRecoveryTimeDays: median(
      bugs.map((b) => (doneTime(b) - toTime(b.created)) / DAY_MS)
    ),
    bugsDelivered: bugs.length,
    changeFailRate: pct(failed.length, done.length),
    failedTickets: failed.map((s) => s.key),
    deliveryReworkRate: pct(bugs.length, done.length),
    workInProgress: issues.filter(isInProgress).length,
    flowEfficiency: flow.length > 0 ? median(flow) : null,
    sprintPredictability: predictability,
    sprints,
    prsPerTicket,
    prCycleTimeHours: median(prCycleHours)
  }
}
