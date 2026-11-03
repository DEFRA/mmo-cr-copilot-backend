// Jira and SonarCloud scenario data for scripts/seed-mock-data.js. Pure data: no
// database access, so mock-data.test.js can check the fixtures directly.

const MMOCR = 'FES'
const AGENT = 'CRAR'

const DASH = 'DEFRA/mmo-cr-copilot-dashboard'
const BACKEND = 'DEFRA/mmo-cr-copilot-backend'
const ADMIN = 'DEFRA/mmo-cr-internal-admin'
const REFDATA = 'DEFRA/mmo-cr-reference-data'
const CORE = 'DEFRA/mmo-agentic-core'
const WORKER = 'DEFRA/mmo-agentic-worker'

const d = (iso) => new Date(`2026-${iso}:00.000Z`)
const DAY_MS = 86400000

const CATEGORY = { Done: 'done', 'To Do': 'new' }

/**
 * A stored Jira issue shaped like the sync output. `history` rows are
 * [at, from, to]; started, firstDoneAt, resolved and reopens derive from them.
 */
function issue({
  key,
  project,
  summary,
  type = 'Story',
  points = null,
  priority = 'Medium',
  created,
  history = [],
  links = []
}) {
  const statusHistory = history.map(([at, from, to]) => ({
    at: d(at),
    from,
    to
  }))
  const current = statusHistory.at(-1)?.to ?? 'To Do'
  const categoryKey = CATEGORY[current] ?? 'indeterminate'
  const dones = statusHistory.filter((h) => h.to === 'Done')
  const createdAt = created
    ? d(created)
    : new Date(
        (statusHistory[0]?.at ?? d('10-01T09:00')).getTime() - 2 * DAY_MS
      )
  return {
    key,
    projectSlug: project,
    summary,
    issueType: type,
    priority,
    status: { name: current, categoryKey },
    storyPoints: points,
    created: createdAt,
    started: statusHistory.find((h) => h.to === 'In Progress')?.at ?? createdAt,
    firstDoneAt: dones[0]?.at ?? null,
    resolved: categoryKey === 'done' ? dones.at(-1).at : null,
    reopenCount: statusHistory.filter((h) => h.from === 'Done').length,
    statusHistory,
    issueLinks: links.map(([linkKey, issueType, direction]) => ({
      key: linkKey,
      type: 'Relates',
      direction,
      issueType
    })),
    updated: statusHistory.at(-1)?.at ?? createdAt,
    syncedAt: new Date()
  }
}

export const JIRA_ISSUES = [
  issue({
    key: 'MMOCR-100',
    project: MMOCR,
    summary: 'Payload contract v2 ingest validation',
    points: 3,
    history: [
      ['09-08T09:00', 'To Do', 'In Progress'],
      ['09-15T10:00', 'In Progress', 'Ready for Review'],
      ['09-18T10:00', 'Ready for Review', 'Done']
    ]
  }),
  issue({
    key: 'MMOCR-101',
    project: MMOCR,
    summary: 'Cycle time scatter plot and accessible table alternative',
    points: 5,
    created: '09-08T09:00',
    history: [
      ['09-10T09:00', 'To Do', 'In Progress'],
      ['09-11T15:00', 'In Progress', 'Ready for Review'],
      ['09-12T12:00', 'Ready for Review', 'Done']
    ],
    links: [['MMOCR-104', 'Bug', 'inward']]
  }),
  issue({
    key: 'MMOCR-102',
    project: MMOCR,
    summary: 'Contributor breakdown treemap with colour token palette',
    points: 3,
    created: '09-15T09:00',
    history: [
      ['09-18T10:00', 'To Do', 'In Progress'],
      ['09-18T16:00', 'In Progress', 'Blocked'],
      ['09-19T10:00', 'Blocked', 'In Progress'],
      ['09-20T10:00', 'In Progress', 'Done']
    ]
  }),
  issue({
    key: 'MMOCR-103',
    project: MMOCR,
    summary: 'Performance optimisations for MongoDB analytics queries',
    points: 8,
    created: '09-06T14:00',
    history: [
      ['09-09T14:00', 'To Do', 'In Progress'],
      ['09-11T17:00', 'In Progress', 'Done']
    ]
  }),
  issue({
    key: 'MMOCR-104',
    project: MMOCR,
    summary: 'SonarCloud proxy returns 502 on transient connection loss',
    type: 'Bug',
    points: 2,
    priority: 'High',
    created: '09-20T11:00',
    history: [
      ['09-21T13:00', 'To Do', 'In Progress'],
      ['09-22T10:00', 'In Progress', 'Ready for Test'],
      ['09-22T16:00', 'Ready for Test', 'Done']
    ],
    links: [['MMOCR-101', 'Story', 'outward']]
  }),
  issue({
    key: 'MMOCR-105',
    project: MMOCR,
    summary: 'CSV batch stream exporter for landing report downloads',
    points: 5,
    created: '09-30T10:00',
    history: [
      ['10-02T10:00', 'To Do', 'In Progress'],
      ['10-04T09:00', 'In Progress', 'Ready for Review'],
      ['10-05T17:00', 'Ready for Review', 'Done']
    ],
    links: [['MMOCR-111', 'Bug', 'inward']]
  }),
  issue({
    key: 'MMOCR-106',
    project: MMOCR,
    summary: 'Update the service runbook for the ingest token rotation',
    type: 'Task',
    points: 2,
    created: '09-16T09:00',
    history: [
      ['09-24T09:00', 'To Do', 'In Progress'],
      ['09-26T15:00', 'In Progress', 'Done']
    ]
  }),
  issue({
    key: 'MMOCR-107',
    project: MMOCR,
    summary: 'GOV.UK Frontend responsive page shell and token bands',
    points: 5,
    created: '10-12T09:00',
    history: [
      ['10-14T10:00', 'To Do', 'In Progress'],
      ['10-15T16:00', 'In Progress', 'Done']
    ],
    links: [['MMOCR-116', 'Bug', 'inward']]
  }),
  issue({
    key: 'MMOCR-108',
    project: MMOCR,
    summary: 'Automated security headers verification and scanning',
    type: 'Task',
    points: 3,
    created: '10-14T11:00',
    history: [['10-15T09:00', 'To Do', 'In Progress']]
  }),
  issue({
    key: 'MMOCR-109',
    project: MMOCR,
    summary: 'Catch certificate PDF renderer with accessible tagging',
    points: 5,
    created: '09-14T09:00',
    history: [
      ['09-22T09:00', 'To Do', 'In Progress'],
      ['09-25T10:00', 'In Progress', 'On Hold'],
      ['09-29T09:00', 'On Hold', 'In Progress'],
      ['10-02T11:00', 'In Progress', 'Done']
    ]
  }),
  issue({
    key: 'MMOCR-110',
    project: MMOCR,
    summary: 'Vessel licence lookup with cached reference data',
    points: 3,
    history: [
      ['10-01T09:00', 'To Do', 'In Progress'],
      ['10-06T12:00', 'In Progress', 'Done'],
      ['10-08T09:00', 'Done', 'In Progress'],
      ['10-10T15:00', 'In Progress', 'Done']
    ]
  }),
  issue({
    key: 'MMOCR-111',
    project: MMOCR,
    summary: 'CSV export drops rows with commas in vessel names',
    type: 'Bug',
    points: 1,
    priority: 'High',
    created: '10-09T09:00',
    history: [
      ['10-09T13:00', 'To Do', 'In Progress'],
      ['10-11T11:00', 'In Progress', 'Done']
    ],
    links: [['MMOCR-105', 'Story', 'outward']]
  }),
  issue({
    key: 'MMOCR-112',
    project: MMOCR,
    summary: 'Landing declaration bulk upload with progress feedback',
    points: 8,
    history: [
      ['10-06T09:00', 'To Do', 'In Progress'],
      ['10-09T09:00', 'In Progress', 'Ready for Review'],
      ['10-12T15:00', 'Ready for Review', 'Done']
    ]
  }),
  issue({
    key: 'MMOCR-113',
    project: MMOCR,
    summary: 'Sales note reconciliation report',
    points: 5,
    history: [
      ['10-08T09:00', 'To Do', 'In Progress'],
      ['10-17T11:00', 'In Progress', 'Ready for Review']
    ]
  }),
  issue({
    key: 'MMOCR-114',
    project: MMOCR,
    summary: 'Port of landing autocomplete',
    points: 3,
    created: '10-13T09:00'
  }),
  issue({
    key: 'MMOCR-115',
    project: MMOCR,
    summary: 'Species code validation against reference data',
    points: 2,
    history: [
      ['10-15T09:00', 'To Do', 'In Progress'],
      ['10-17T16:00', 'In Progress', 'Ready for Test']
    ]
  }),
  issue({
    key: 'MMOCR-116',
    project: MMOCR,
    summary: 'Page shell header overlaps the project switcher on mobile',
    type: 'Bug',
    points: 1,
    priority: 'High',
    created: '10-16T09:00',
    history: [
      ['10-16T11:00', 'To Do', 'In Progress'],
      ['10-17T12:00', 'In Progress', 'Done']
    ],
    links: [['MMOCR-107', 'Story', 'outward']]
  }),
  issue({
    key: 'AGENT-198',
    project: AGENT,
    summary: 'Agent prompt library with versioned templates',
    points: 3,
    history: [
      ['09-21T09:00', 'To Do', 'In Progress'],
      ['09-24T15:00', 'In Progress', 'Done']
    ]
  }),
  issue({
    key: 'AGENT-199',
    project: AGENT,
    summary: 'Worker retry policy with dead-letter queue',
    points: 5,
    history: [
      ['09-25T09:00', 'To Do', 'In Progress'],
      ['09-29T09:00', 'In Progress', 'Blocked'],
      ['10-01T09:00', 'Blocked', 'In Progress'],
      ['10-03T14:00', 'In Progress', 'Done']
    ]
  }),
  issue({
    key: 'AGENT-200',
    project: AGENT,
    summary: 'Tool permission model for sandboxed agents',
    points: 3,
    history: [
      ['10-01T09:00', 'To Do', 'In Progress'],
      ['10-06T10:00', 'In Progress', 'Done'],
      ['10-07T09:00', 'Done', 'In Progress'],
      ['10-08T12:00', 'In Progress', 'Done']
    ]
  }),
  issue({
    key: 'AGENT-201',
    project: AGENT,
    summary: 'Autonomous agent task graph orchestrator engine',
    points: 5,
    created: '10-09T08:00',
    history: [
      ['10-11T08:00', 'To Do', 'In Progress'],
      ['10-12T09:00', 'In Progress', 'Ready for Review'],
      ['10-12T11:00', 'Ready for Review', 'Done']
    ],
    links: [['AGENT-204', 'Bug', 'inward']]
  }),
  issue({
    key: 'AGENT-202',
    project: AGENT,
    summary: 'Streaming tool runner worker with sandbox telemetry',
    points: 8,
    created: '10-11T09:00',
    history: [
      ['10-13T09:00', 'To Do', 'In Progress'],
      ['10-15T12:00', 'In Progress', 'Done']
    ]
  }),
  issue({
    key: 'AGENT-203',
    project: AGENT,
    summary: 'Subagent trace telemetry exporter to OpenTelemetry collector',
    type: 'Task',
    points: 5,
    created: '10-14T10:00',
    history: [['10-15T08:00', 'To Do', 'In Progress']]
  }),
  issue({
    key: 'AGENT-204',
    project: AGENT,
    summary: 'Orchestrator drops tasks when two graphs share a node',
    type: 'Bug',
    points: 1,
    priority: 'High',
    created: '10-14T09:00',
    history: [
      ['10-15T09:00', 'To Do', 'In Progress'],
      ['10-16T15:00', 'In Progress', 'Done']
    ],
    links: [['AGENT-201', 'Story', 'outward']]
  }),
  issue({
    key: 'AGENT-205',
    project: AGENT,
    summary: 'Cost dashboard for agent token usage',
    points: 5,
    created: '10-14T10:00'
  })
]

const scope = (sprintId, projectSlug, name, start, end, keys) => ({
  sprintId,
  projectSlug,
  name,
  startDate: d(`${start}T00:00`),
  endDate: d(`${end}T00:00`),
  issueKeys: keys,
  capturedAt: d(`${start}T00:00`)
})

export const JIRA_SPRINT_SCOPES = [
  scope(1005, MMOCR, 'Sprint 5', '09-02', '09-16', [
    'MMOCR-100',
    'MMOCR-101',
    'MMOCR-103'
  ]),
  scope(1006, MMOCR, 'Sprint 6', '09-16', '09-30', [
    'MMOCR-100',
    'MMOCR-102',
    'MMOCR-106',
    'MMOCR-109'
  ]),
  scope(1007, MMOCR, 'Sprint 7', '09-30', '10-14', [
    'MMOCR-105',
    'MMOCR-109',
    'MMOCR-110',
    'MMOCR-112',
    'MMOCR-113'
  ]),
  scope(1008, MMOCR, 'Sprint 8', '10-14', '10-28', [
    'MMOCR-107',
    'MMOCR-108',
    'MMOCR-113',
    'MMOCR-114',
    'MMOCR-115'
  ]),
  scope(2006, AGENT, 'Sprint 6', '09-16', '09-30', ['AGENT-198', 'AGENT-199']),
  scope(2007, AGENT, 'Sprint 7', '09-30', '10-14', [
    'AGENT-199',
    'AGENT-200',
    'AGENT-201'
  ]),
  scope(2008, AGENT, 'Sprint 8', '10-14', '10-28', [
    'AGENT-202',
    'AGENT-203',
    'AGENT-205'
  ])
]

let shaSeed = 0x5a1000
const sha = () => (shaSeed++).toString(16).padStart(7, '0')

/** A payload spec in the seed's format, with one Copilot and one human commit. */
function pr({
  repository,
  project,
  prNumber,
  title,
  keys = [],
  firstCommit,
  merged,
  created,
  calculated,
  lastCommit,
  author = 'ada',
  reviewer = 'grace'
}) {
  const first = `2026-${firstCommit}:00.000Z`
  const last = `2026-${lastCommit ?? merged ?? calculated}:00.000Z`
  return {
    prNumber,
    prTitle: title,
    repository,
    projectSlug: project,
    jiraKeys: keys,
    sourceBranch: `feature/${(keys[0] ?? `pr-${prNumber}`).toLowerCase()}`,
    calculatedAt: `2026-${calculated ?? merged}:00.000Z`,
    prCreatedAt: `2026-${created ?? firstCommit}:00.000Z`,
    firstCommitAt: first,
    lastCommitAt: last,
    ...(merged && { prMergedAt: `2026-${merged}:00.000Z` }),
    commits: [
      {
        commit: sha(),
        committedAt: first,
        author,
        subject: `feat: ${title.toLowerCase()}`,
        classification: 'Copilot-assisted',
        filesChanged: 3,
        linesAdded: 90 + (prNumber % 7) * 15,
        linesDeleted: 12 + (prNumber % 5) * 4
      },
      {
        commit: sha(),
        committedAt: last,
        author: reviewer,
        subject: 'test: cover edge cases',
        classification: 'Human-authored',
        filesChanged: 1,
        linesAdded: 30 + (prNumber % 3) * 10,
        linesDeleted: 4
      }
    ]
  }
}

export const JIRA_SCENARIO_PAYLOAD_SPECS = [
  pr({
    repository: ADMIN,
    project: MMOCR,
    prNumber: 13,
    title: 'Payload contract v2 ingest validation',
    keys: ['MMOCR-100'],
    firstCommit: '09-08T10:00',
    created: '09-14T09:00',
    merged: '09-17T15:00'
  }),
  pr({
    repository: BACKEND,
    project: MMOCR,
    prNumber: 30,
    title: 'Catch certificate PDF renderer',
    keys: ['MMOCR-109'],
    firstCommit: '09-22T10:00',
    created: '09-29T09:00',
    merged: '10-01T16:00',
    author: 'bob'
  }),
  pr({
    repository: DASH,
    project: MMOCR,
    prNumber: 31,
    title: 'Vessel licence lookup',
    keys: ['MMOCR-110'],
    firstCommit: '10-01T10:00',
    merged: '10-05T16:00',
    author: 'eve'
  }),
  pr({
    repository: DASH,
    project: MMOCR,
    prNumber: 32,
    title: 'Fix vessel licence cache expiry after reopen',
    keys: ['MMOCR-110'],
    firstCommit: '10-08T10:00',
    merged: '10-09T17:00',
    author: 'eve'
  }),
  pr({
    repository: ADMIN,
    project: MMOCR,
    prNumber: 47,
    title: 'Quote vessel names in CSV export',
    keys: ['MMOCR-111'],
    firstCommit: '10-09T14:00',
    merged: '10-11T10:00',
    author: 'dana'
  }),
  pr({
    repository: BACKEND,
    project: MMOCR,
    prNumber: 33,
    title: 'Landing declaration bulk upload',
    keys: ['MMOCR-112'],
    firstCommit: '10-06T10:00',
    created: '10-09T09:00',
    lastCommit: '10-12T13:00',
    calculated: '10-12T14:00',
    author: 'bob'
  }),
  pr({
    repository: DASH,
    project: MMOCR,
    prNumber: 36,
    title: 'Sales note reconciliation report',
    keys: ['MMOCR-113'],
    firstCommit: '10-08T10:00',
    created: '10-16T09:00',
    lastCommit: '10-17T09:30',
    calculated: '10-17T10:00'
  }),
  pr({
    repository: BACKEND,
    project: MMOCR,
    prNumber: 37,
    title: 'Species code validation',
    keys: ['MMOCR-115'],
    firstCommit: '10-15T10:00',
    merged: '10-17T15:00',
    author: 'bob'
  }),
  pr({
    repository: DASH,
    project: MMOCR,
    prNumber: 38,
    title: 'Fix header overlap on mobile',
    keys: ['MMOCR-116'],
    firstCommit: '10-16T11:30',
    merged: '10-17T11:00',
    author: 'eve'
  }),
  pr({
    repository: REFDATA,
    project: MMOCR,
    prNumber: 39,
    title: 'Bump Node.js base image',
    firstCommit: '10-16T09:00',
    merged: '10-16T15:00',
    author: 'charlie'
  }),
  pr({
    repository: CORE,
    project: AGENT,
    prNumber: 3,
    title: 'Agent prompt library',
    keys: ['AGENT-198'],
    firstCommit: '09-21T10:00',
    merged: '09-24T12:00',
    author: 'frank'
  }),
  pr({
    repository: WORKER,
    project: AGENT,
    prNumber: 4,
    title: 'Worker retry policy',
    keys: ['AGENT-199'],
    firstCommit: '09-25T10:00',
    merged: '10-03T11:00',
    author: 'frank'
  }),
  pr({
    repository: CORE,
    project: AGENT,
    prNumber: 5,
    title: 'Tool permission model',
    keys: ['AGENT-200'],
    firstCommit: '10-01T10:00',
    merged: '10-05T15:00',
    author: 'frank'
  }),
  pr({
    repository: CORE,
    project: AGENT,
    prNumber: 7,
    title: 'Fix shared node task drop',
    keys: ['AGENT-204'],
    firstCommit: '10-15T10:00',
    merged: '10-16T13:00',
    author: 'frank'
  }),
  pr({
    repository: WORKER,
    project: AGENT,
    prNumber: 6,
    title: 'Tidy worker logging',
    firstCommit: '10-17T09:00',
    merged: '10-17T16:00',
    author: 'frank'
  })
]

/** PR-to-ticket links derived from the payload specs, so the two cannot drift. */
export function buildPrJiraLinks(specs) {
  return specs
    .filter((s) => s.projectSlug && s.jiraKeys?.length)
    .flatMap((s) =>
      s.jiraKeys.map((jiraKey) => ({
        projectSlug: s.projectSlug,
        jiraKey,
        repository: s.repository,
        prNumber: s.prNumber,
        linkedAt: new Date(s.firstCommitAt)
      }))
    )
}

const FIRST_SCAN_FAILED = new Set([`${DASH}#31`, `${WORKER}#4`])

/** New-code snapshots for every merged scenario PR; open PRs stay unanalysed. */
export function buildScenarioPrSnapshots(repositories) {
  const keys = new Map(repositories.map((r) => [r.fullName, r.sonarProjectKey]))
  return JIRA_SCENARIO_PAYLOAD_SPECS.filter((s) => s.prMergedAt).map((s) => {
    const firstScanFailed = FIRST_SCAN_FAILED.has(
      `${s.repository}#${s.prNumber}`
    )
    return {
      repository: s.repository,
      prNumber: s.prNumber,
      projectKey: keys.get(s.repository),
      analyzed: true,
      qualityGate: 'passed',
      firstScanQualityGate: firstScanFailed ? 'failed' : 'passed',
      alert_status: 'OK',
      ratings: { reliability: 'A', security: 'A', maintainability: 'A' },
      measures: {
        new_coverage: firstScanFailed ? 81.5 : 92.0,
        new_duplicated_lines_density: firstScanFailed ? 3.4 : 0.9,
        new_sqale_debt_ratio: 0.02,
        new_software_quality_blocker_issues: 0,
        new_software_quality_high_issues: firstScanFailed ? 1 : 0,
        new_bugs: 0,
        new_vulnerabilities: 0,
        new_code_smells: firstScanFailed ? 4 : 1
      },
      capturedAt: new Date(s.prMergedAt)
    }
  })
}

// Sprint-end cut-offs (the dashboard asks for window end − 1s) and "now".
export const SONAR_CUTOFFS = [
  new Date('2026-09-01T23:59:59.000Z'),
  new Date('2026-09-15T23:59:59.000Z'),
  new Date('2026-09-29T23:59:59.000Z'),
  new Date('2026-10-13T23:59:59.000Z'),
  new Date('2026-10-18T09:00:00.000Z')
]

// Gate (P/W/F) and coverage per cut-off; null means no analysis yet.
const SONAR_HISTORY = {
  [DASH]: [
    ['P', 86.0],
    ['P', 87.3],
    ['P', 88.9],
    ['P', 90.2],
    ['P', 91.5]
  ],
  [BACKEND]: [
    ['P', 84.1],
    ['P', 85.0],
    ['F', 78.6],
    ['P', 86.4],
    ['P', 87.0]
  ],
  [ADMIN]: [null, ['P', 81.2], ['W', 79.0], ['P', 82.5], ['F', 74.8]],
  [REFDATA]: [
    ['P', 90.5],
    ['P', 90.8],
    ['P', 91.0],
    ['F', 89.7],
    ['P', 90.9]
  ],
  [CORE]: [null, null, ['P', 93.0], ['P', 94.1], ['P', 95.2]],
  [WORKER]: [null, null, ['F', 76.4], ['P', 88.0], ['P', 89.1]]
}

const GATE = { P: 'passed', W: 'warning', F: 'failed' }

/** Main-branch snapshots at each cut-off, so past periods show frozen values. */
export function buildSonarSprintSnapshots(repositories) {
  const keys = new Map(repositories.map((r) => [r.fullName, r.sonarProjectKey]))
  return Object.entries(SONAR_HISTORY).flatMap(([repository, points]) =>
    points.flatMap((point, i) => {
      if (!point) return []
      const [gate, coverage] = point
      const asOf = SONAR_CUTOFFS[i]
      const failing = gate === 'F'
      const duplication = repository === REFDATA && failing ? 6.2 : 1.1
      const analysisDate = new Date(asOf)
      if (i === SONAR_CUTOFFS.length - 1) {
        analysisDate.setUTCDate(17)
      }
      analysisDate.setUTCHours(16, 45, 0, 0)
      return [
        {
          repository,
          projectKey: keys.get(repository),
          asOf,
          analysisDate,
          qualityGate: GATE[gate],
          ratings: {
            reliability: failing && repository !== REFDATA ? 'C' : 'A',
            security: 'A',
            maintainability: gate === 'W' || failing ? 'B' : 'A'
          },
          measures: {
            coverage: coverage.toFixed(1),
            bugs: String(failing && repository !== REFDATA ? 2 : 0),
            vulnerabilities: '0',
            code_smells: String(failing ? 14 : 3 + i),
            security_hotspots: '0',
            duplicated_lines_density: duplication.toFixed(1),
            ncloc: String(12000 + i * 650)
          },
          capturedAt: asOf
        }
      ]
    })
  )
}
