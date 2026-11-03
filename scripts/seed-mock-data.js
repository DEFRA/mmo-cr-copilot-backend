import { MongoClient } from 'mongodb'
import { computeComplexityScore } from '#/services/complexity.js'
import {
  JIRA_ISSUES,
  JIRA_SCENARIO_PAYLOAD_SPECS,
  JIRA_SPRINT_SCOPES,
  buildPrJiraLinks,
  buildScenarioPrSnapshots,
  buildSonarSprintSnapshots
} from './mock-data/jira-sonar.js'

const MONGO_URI = process.env.MONGO_URI || 'mongodb://127.0.0.1:27017/'
const DATABASE_NAME = process.env.MONGO_DATABASE || 'mmo-cr-copilot-backend'
// Same setting the service bootstraps from, so a real Entra group can be seeded as admin.
const ADMIN_GROUP =
  process.env.AUTH_BOOTSTRAP_ADMIN_GROUP ||
  'AG-Users-CopilotAnalytics-Dashboard-Admin'

const client = new MongoClient(MONGO_URI)

// 1. Projects
const PROJECTS = [
  {
    slug: 'FES',
    name: 'MMO Catch Recording',
    type: 'ai-adopted',
    adoptionStartDate: new Date('2026-01-01T00:00:00.000Z'),
    sprintCalendar: {
      cadenceDays: 14,
      anchorDate: new Date('2026-07-08T00:00:00.000Z')
    },
    jira: {
      projectKeys: ['MMOCR'],
      storyPointsField: 'customfield_10016'
    },
    createdAt: new Date('2026-01-01T00:00:00.000Z'),
    updatedAt: new Date('2026-10-29T00:00:00.000Z'),
    archivedAt: null
  },
  {
    slug: 'CRAR',
    name: 'MMO Agentic Delivery',
    type: 'ai-native',
    adoptionStartDate: null,
    sprintCalendar: {
      cadenceDays: 14,
      anchorDate: new Date('2026-07-08T00:00:00.000Z')
    },
    jira: {
      projectKeys: ['AGENT'],
      storyPointsField: 'customfield_10016'
    },
    createdAt: new Date('2026-06-01T00:00:00.000Z'),
    updatedAt: new Date('2026-10-29T00:00:00.000Z'),
    archivedAt: null
  }
]

const ROLE_MAPPINGS = [
  [ADMIN_GROUP, 'Dashboard.Admin', 'global'],
  ['AG-Users-CopilotAnalytics-CRAR-Admin', 'project-admin', 'project', 'CRAR'],
  ['AG-Users-CopilotAnalytics-CRAR-Reader', 'project-user', 'project', 'CRAR'],
  ['AG-Users-CopilotAnalytics-FES-Admin', 'project-admin', 'project', 'FES'],
  ['AG-Users-CopilotAnalytics-FES-Reader', 'project-user', 'project', 'FES']
].map(([groupName, role, scope, projectSlug = null]) => ({
  groupName,
  role,
  scope,
  projectSlug,
  description: `${groupName} mapped to ${role}`
}))

// 2. Mapped Repositories
const REPOSITORIES = [
  {
    fullName: 'DEFRA/mmo-cr-copilot-dashboard',
    projectSlug: 'FES',
    sonarProjectKey: 'DEFRA_mmo-cr-copilot-dashboard',
    mappedAt: new Date('2026-01-05T00:00:00.000Z'),
    mappedBy: 'admin-lead'
  },
  {
    fullName: 'DEFRA/mmo-cr-copilot-backend',
    projectSlug: 'FES',
    sonarProjectKey: 'DEFRA_mmo-cr-copilot-backend',
    mappedAt: new Date('2026-01-05T00:00:00.000Z'),
    mappedBy: 'admin-lead'
  },
  {
    fullName: 'DEFRA/mmo-cr-internal-admin',
    projectSlug: 'FES',
    sonarProjectKey: 'DEFRA_mmo-cr-internal-admin',
    mappedAt: new Date('2026-01-05T00:00:00.000Z'),
    mappedBy: 'admin-lead'
  },
  {
    fullName: 'DEFRA/mmo-cr-reference-data',
    projectSlug: 'FES',
    sonarProjectKey: 'DEFRA_mmo-cr-reference-data',
    mappedAt: new Date('2026-01-05T00:00:00.000Z'),
    mappedBy: 'admin-lead'
  },
  {
    fullName: 'DEFRA/mmo-agentic-core',
    projectSlug: 'CRAR',
    sonarProjectKey: 'DEFRA_mmo-agentic-core',
    mappedAt: new Date('2026-06-10T00:00:00.000Z'),
    mappedBy: 'admin-lead'
  },
  {
    fullName: 'DEFRA/mmo-agentic-worker',
    projectSlug: 'CRAR',
    sonarProjectKey: 'DEFRA_mmo-agentic-worker',
    mappedAt: new Date('2026-06-10T00:00:00.000Z'),
    mappedBy: 'admin-lead'
  }
]

// 3. Personas (scoped to one project)
const PERSONA_PROJECT = 'FES'
const PERSONA_MAPPINGS = [
  { githubHandle: 'ada', persona: 'developer' },
  { githubHandle: 'bob', persona: 'developer' },
  { githubHandle: 'charlie', persona: 'devops' },
  { githubHandle: 'dana', persona: 'qa' },
  { githubHandle: 'eve', persona: 'developer' },
  { githubHandle: 'rhododendron', persona: 'developer' }
]

const usageModel = (
  model,
  requests,
  inputTokens,
  outputTokens,
  cacheReadTokens = 0,
  cacheCreationTokens = 0,
  reasoningTokens = 0
) => ({
  model,
  requests,
  inputTokens,
  outputTokens,
  cacheReadTokens,
  cacheCreationTokens,
  reasoningTokens
})

const usage = (models, sessions = 1) => ({
  models,
  sessions,
  commitsWithUsage: 1
})

// Per-commit model usage, keyed by commit SHA, for extension-attributed commits.
// Tuned so every dashboard superlative has a clear winner (>= 2 PRs per model).
const COMMIT_USAGE = {
  // Token Heavyweight: claude-sonnet-4.5. Token Economiser: gpt-4o-mini.
  a1b2c3d: usage([
    usageModel('claude-sonnet-4.5', 14, 182000, 21000, 70000, 25000),
    usageModel('gpt-4o-mini', 6, 4200, 1500)
  ]),
  b2c3d4e: usage([
    usageModel('claude-sonnet-4.5', 9, 96000, 12000, 38000, 10000),
    usageModel('gpt-4o-mini', 3, 2100, 700)
  ]),
  // Cache Champion: gpt-5 (>80% cache reads).
  e7f8a9b: usage([usageModel('gpt-5', 7, 52000, 6500, 44000, 4000, 2400)]),
  // Deep Thinker: o3-mini (reasoning dominates output).
  d4e5f6a: usage(
    [
      usageModel('claude-sonnet-4.5', 18, 240000, 30000, 96000, 30000),
      usageModel('gpt-5', 5, 31000, 4200, 27000, 2000, 1500),
      usageModel('o3-mini', 3, 5000, 2600, 0, 0, 2300)
    ],
    2
  ),
  e1f2a3b: usage(
    [
      usageModel('claude-sonnet-4.5', 22, 310000, 38000, 120000, 40000),
      usageModel('o3-mini', 4, 9000, 5200, 0, 0, 4600)
    ],
    2
  ),
  f2a3b4c: usage([
    usageModel('o3-mini', 3, 6000, 3800, 0, 0, 3300),
    usageModel('gpt-4o-mini', 5, 3000, 900)
  ]),
  '99a8b7c': usage([
    usageModel('gpt-5', 8, 60000, 7000, 52000, 3000, 2800),
    usageModel('gpt-4o-mini', 4, 2400, 800)
  ]),
  '77a8b9c': usage([
    usageModel('claude-sonnet-4.5', 11, 130000, 15000, 55000, 15000)
  ]),
  aa11bb2: usage(
    [
      usageModel('claude-sonnet-4.5', 30, 420000, 52000, 190000, 60000),
      usageModel('gpt-5', 6, 38000, 5000, 31000, 2000, 2200)
    ],
    3
  ),
  bb22cc3: usage([
    usageModel('claude-sonnet-4.5', 12, 140000, 16000, 60000, 15000)
  ]),
  cc33dd4: usage([
    usageModel('gpt-5', 10, 70000, 9000, 60000, 4000, 3500),
    usageModel('claude-haiku-4.5', 8, 12000, 3000, 6000)
  ]),
  dd44ee5: usage([usageModel('claude-haiku-4.5', 6, 9000, 2000, 4000)]),
  ff66aa7: usage([
    usageModel('claude-sonnet-4.5', 5, 60000, 7000, 20000, 6000)
  ]),
  // Current sprint. Night Owl Model: gemini-2.5-pro (commits 22:40 and 02:15).
  c0de501: usage(
    [
      usageModel('claude-sonnet-4.5', 16, 205000, 26000, 82000, 28000),
      usageModel('gpt-4o-mini', 5, 3000, 1000)
    ],
    2
  ),
  c0de502: usage([
    usageModel('gemini-2.5-pro', 6, 48000, 6000, 20000, 5000, 1800)
  ]),
  c0de511: usage(
    [
      usageModel('claude-sonnet-4.5', 12, 150000, 18000, 60000, 20000),
      usageModel('gpt-5', 6, 40000, 5000, 36000, 2000, 2000)
    ],
    2
  ),
  c0de512: usage([
    usageModel('gemini-2.5-pro', 7, 36000, 4500, 14000, 3000, 1500)
  ])
}

function withUsage(commit) {
  const attribution = commit.attribution || {
    source:
      commit.classification === 'Copilot-assisted' ? 'legacy-trailer' : 'none'
  }
  const commitUsage = COMMIT_USAGE[commit.commit]
  return attribution.source === 'extension' && commitUsage
    ? { ...attribution, usage: commitUsage }
    : attribution
}

function createPayloadDoc({
  schemaVersion = 2,
  source = 'live',
  prNumber,
  prTitle,
  repository,
  projectSlug,
  jiraKeys = [],
  sourceBranch,
  targetBranch = 'main',
  buildId,
  calculatedAt,
  prCreatedAt,
  firstCommitAt,
  lastCommitAt,
  prMergedAt,
  files,
  commits
}) {
  const contributorMap = new Map()

  let totalCommits = 0
  let copilotAssistedCommits = 0
  let humanAuthoredCommits = 0
  let totalLinesTouched = 0
  let copilotAssistedLines = 0
  let humanAuthoredLines = 0

  for (const c of commits) {
    const isCopilot = c.classification === 'Copilot-assisted'
    const linesTouched = c.linesAdded + c.linesDeleted
    const netLines = c.linesAdded - c.linesDeleted

    totalCommits += 1
    totalLinesTouched += linesTouched

    if (isCopilot) {
      copilotAssistedCommits += 1
      copilotAssistedLines += linesTouched
    } else {
      humanAuthoredCommits += 1
      humanAuthoredLines += linesTouched
    }

    if (!contributorMap.has(c.author)) {
      contributorMap.set(c.author, {
        contributor: c.author,
        totalCommits: 0,
        copilotAssisted: 0,
        humanAuthored: 0,
        linesAdded: 0,
        linesDeleted: 0,
        linesTouched: 0,
        netLines: 0,
        copilotAssistedLines: 0,
        humanAuthoredLines: 0
      })
    }

    const contributor = contributorMap.get(c.author)
    contributor.totalCommits += 1
    contributor.linesAdded += c.linesAdded
    contributor.linesDeleted += c.linesDeleted
    contributor.linesTouched += linesTouched
    contributor.netLines += netLines

    if (isCopilot) {
      contributor.copilotAssisted += 1
      contributor.copilotAssistedLines += linesTouched
    } else {
      contributor.humanAuthored += 1
      contributor.humanAuthoredLines += linesTouched
    }
  }

  const copilotAssistedRate =
    totalCommits > 0
      ? Math.round((copilotAssistedCommits / totalCommits) * 1000) / 10
      : 0
  const copilotAssistedLineRate =
    totalLinesTouched > 0
      ? Math.round((copilotAssistedLines / totalLinesTouched) * 1000) / 10
      : 0

  const resolvedFiles = files || {
    changed: commits.reduce((acc, c) => acc + (c.filesChanged || 1), 0),
    linesTouched: totalLinesTouched,
    testFilesChanged: 1,
    testLinesTouched: Math.round(totalLinesTouched * 0.25),
    modulesTouched: 2,
    excluded: { filesChanged: 0, linesTouched: 0 }
  }

  const complexity = computeComplexityScore(resolvedFiles)

  const calcDate = new Date(calculatedAt)
  const firstDate = firstCommitAt ? new Date(firstCommitAt) : undefined
  const lastDate = lastCommitAt ? new Date(lastCommitAt) : undefined
  const codingCycleHours =
    firstDate && lastDate
      ? Math.max(0.1, (lastDate - firstDate) / (1000 * 60 * 60))
      : 2.5

  return {
    schemaVersion,
    source,
    prNumber,
    prTitle: prTitle || `PR #${prNumber}: updates`,
    repository,
    projectSlug,
    jiraKeys,
    sourceBranch: sourceBranch || `feature/pr-${prNumber}`,
    targetBranch,
    buildId: buildId || `build-${prNumber}`,
    calculatedAt: calcDate,
    prCreatedAt: prCreatedAt ? new Date(prCreatedAt) : undefined,
    firstCommitAt: firstDate,
    lastCommitAt: lastDate,
    prMergedAt: prMergedAt ? new Date(prMergedAt) : undefined,
    receivedAt: new Date(),
    codingCycleTimeHours: Math.round(codingCycleHours * 10) / 10,
    files: resolvedFiles,
    complexity,
    summary: {
      totalCommits,
      copilotAssistedCommits,
      humanAuthoredCommits,
      copilotAssistedRate,
      totalLinesTouched,
      copilotAssistedLines,
      humanAuthoredLines,
      copilotAssistedLineRate
    },
    contributorBreakdown: Array.from(contributorMap.values()),
    commitBreakdown: commits.map((c) => ({
      commit: c.commit,
      committedAt: c.committedAt ? new Date(c.committedAt) : undefined,
      authoredAt: c.authoredAt ? new Date(c.authoredAt) : undefined,
      author: c.author,
      subject: c.subject,
      classification: c.classification,
      filesChanged: c.filesChanged || 1,
      linesAdded: c.linesAdded,
      linesDeleted: c.linesDeleted,
      linesTouched: c.linesAdded + c.linesDeleted,
      netLines: c.linesAdded - c.linesDeleted,
      attribution: withUsage(c)
    }))
  }
}

// Full set of mock payloads covering all historical and live scenarios
const PAYLOAD_SPECS = [
  // --- HISTORICAL PRE-ADOPTION BASELINES (Late 2025: pre-adoptionStartDate 2026-01-01) ---
  {
    schemaVersion: 1,
    source: 'backfill',
    prNumber: 1,
    prTitle: 'refactor: legacy database connection retry strategy',
    repository: 'DEFRA/mmo-cr-copilot-backend',
    projectSlug: 'FES',
    jiraKeys: ['MMOCR-50'],
    calculatedAt: '2025-11-15T10:00:00.000Z',
    prCreatedAt: '2025-11-10T09:00:00.000Z',
    firstCommitAt: '2025-11-10T09:30:00.000Z',
    lastCommitAt: '2025-11-15T09:00:00.000Z',
    prMergedAt: '2025-11-15T10:30:00.000Z',
    files: {
      changed: 3,
      linesTouched: 95,
      testFilesChanged: 1,
      testLinesTouched: 20,
      modulesTouched: 1,
      excluded: { filesChanged: 0, linesTouched: 0 }
    },
    commits: [
      {
        commit: '111111a',
        committedAt: '2025-11-10T09:30:00.000Z',
        author: 'bob',
        subject: 'refactor: database connection pool retries',
        classification: 'Human-authored',
        filesChanged: 2,
        linesAdded: 70,
        linesDeleted: 15
      },
      {
        commit: '111111b',
        committedAt: '2025-11-15T09:00:00.000Z',
        author: 'bob',
        subject: 'test: add integration test for mongo reconnect',
        classification: 'Human-authored',
        filesChanged: 1,
        linesAdded: 10,
        linesDeleted: 0
      }
    ]
  },
  {
    schemaVersion: 1,
    source: 'backfill',
    prNumber: 2,
    prTitle: 'feat: Nunjucks error templates and standard layouts',
    repository: 'DEFRA/mmo-cr-copilot-dashboard',
    projectSlug: 'FES',
    jiraKeys: ['MMOCR-55'],
    calculatedAt: '2025-12-05T14:00:00.000Z',
    prCreatedAt: '2025-12-01T10:00:00.000Z',
    firstCommitAt: '2025-12-01T10:30:00.000Z',
    lastCommitAt: '2025-12-05T13:30:00.000Z',
    prMergedAt: '2025-12-05T14:30:00.000Z',
    files: {
      changed: 6,
      linesTouched: 240,
      testFilesChanged: 2,
      testLinesTouched: 50,
      modulesTouched: 2,
      excluded: { filesChanged: 0, linesTouched: 0 }
    },
    commits: [
      {
        commit: '222222a',
        committedAt: '2025-12-01T10:30:00.000Z',
        author: 'ada',
        subject: 'feat: base error template',
        classification: 'Human-authored',
        filesChanged: 3,
        linesAdded: 160,
        linesDeleted: 20
      },
      {
        commit: '222222b',
        committedAt: '2025-12-05T13:30:00.000Z',
        author: 'ada',
        subject: 'style: align error pages with typography',
        classification: 'Human-authored',
        filesChanged: 3,
        linesAdded: 50,
        linesDeleted: 10
      }
    ]
  },

  // --- PREVIOUS SPRINT 5 (2026-09-02 to 2026-09-16) ---
  {
    schemaVersion: 2,
    source: 'live',
    prNumber: 12,
    prTitle: 'feat: cycle time scatter chart and accessible alternative',
    repository: 'DEFRA/mmo-cr-copilot-dashboard',
    projectSlug: 'FES',
    jiraKeys: ['MMOCR-101'],
    sourceBranch: 'feat/cycle-time-scatter',
    calculatedAt: '2026-09-12T11:30:00.000Z',
    prCreatedAt: '2026-09-10T09:00:00.000Z',
    firstCommitAt: '2026-09-10T09:15:00.000Z',
    lastCommitAt: '2026-09-12T11:00:00.000Z',
    prMergedAt: '2026-09-12T11:45:00.000Z',
    files: {
      changed: 8,
      linesTouched: 413,
      testFilesChanged: 2,
      testLinesTouched: 103,
      modulesTouched: 2,
      excluded: { filesChanged: 0, linesTouched: 0 }
    },
    commits: [
      {
        commit: 'a1b2c3d',
        committedAt: '2026-09-10T09:15:00.000Z',
        author: 'ada',
        subject: 'feat: add cycle time scatter chart component',
        classification: 'Copilot-assisted',
        filesChanged: 3,
        linesAdded: 180,
        linesDeleted: 15,
        attribution: {
          source: 'extension',
          version: 1,
          aiCompletionLines: 90,
          aiChatLines: 40,
          aiAgentLines: 35,
          pastedLines: 10,
          typedLines: 20
        }
      },
      {
        commit: 'b2c3d4e',
        committedAt: '2026-09-11T14:20:00.000Z',
        author: 'ada',
        subject: 'test: add vitest unit tests for cycle time math',
        classification: 'Copilot-assisted',
        filesChanged: 2,
        linesAdded: 95,
        linesDeleted: 8,
        attribution: {
          source: 'extension',
          version: 1,
          aiCompletionLines: 50,
          aiChatLines: 20,
          aiAgentLines: 25,
          pastedLines: 0,
          typedLines: 8
        }
      },
      {
        commit: 'e7f8a9b',
        committedAt: '2026-09-11T16:40:00.000Z',
        author: 'rhododendron',
        subject: 'feat: scatter chart tooltip and keyboard focus ring',
        classification: 'Copilot-assisted',
        filesChanged: 2,
        linesAdded: 60,
        linesDeleted: 10,
        attribution: {
          source: 'extension',
          version: 1,
          aiCompletionLines: 35,
          aiChatLines: 15,
          aiAgentLines: 0,
          pastedLines: 0,
          typedLines: 20
        }
      },
      {
        commit: 'c3d4e5f',
        committedAt: '2026-09-12T11:00:00.000Z',
        author: 'dana',
        subject: 'test: verify accessible table alternative for scatter plot',
        classification: 'Human-authored',
        filesChanged: 1,
        linesAdded: 40,
        linesDeleted: 5,
        attribution: { source: 'none' }
      }
    ]
  },
  {
    schemaVersion: 2,
    source: 'live',
    prNumber: 25,
    prTitle: 'perf: mongo aggregation optimization for payloads query',
    repository: 'DEFRA/mmo-cr-copilot-backend',
    projectSlug: 'FES',
    jiraKeys: ['MMOCR-103'],
    sourceBranch: 'perf/ingest-aggregation',
    calculatedAt: '2026-09-11T16:20:00.000Z',
    prCreatedAt: '2026-09-09T14:00:00.000Z',
    firstCommitAt: '2026-09-09T14:30:00.000Z',
    lastCommitAt: '2026-09-11T16:00:00.000Z',
    prMergedAt: '2026-09-11T16:40:00.000Z',
    files: {
      changed: 5,
      linesTouched: 270,
      testFilesChanged: 1,
      testLinesTouched: 45,
      modulesTouched: 2,
      excluded: { filesChanged: 0, linesTouched: 0 }
    },
    commits: [
      {
        commit: 'f6a7b8c',
        committedAt: '2026-09-09T14:30:00.000Z',
        author: 'charlie',
        subject: 'feat: compound index for repository and prNumber history',
        classification: 'Copilot-assisted',
        filesChanged: 2,
        linesAdded: 60,
        linesDeleted: 10,
        attribution: { source: 'legacy-trailer' }
      },
      {
        commit: 'a7b8c9d',
        committedAt: '2026-09-10T11:15:00.000Z',
        author: 'charlie',
        subject: 'refactor: streamline aggregation pipeline for payloads',
        classification: 'Copilot-assisted',
        filesChanged: 1,
        linesAdded: 110,
        linesDeleted: 45,
        attribution: { source: 'legacy-trailer' }
      },
      {
        commit: 'b8c9d0e',
        committedAt: '2026-09-11T16:00:00.000Z',
        author: 'ada',
        subject: 'fix: ensure ISO timezone preservation on date transforms',
        classification: 'Human-authored',
        filesChanged: 2,
        linesAdded: 30,
        linesDeleted: 15,
        attribution: { source: 'none' }
      }
    ]
  },

  // --- PREVIOUS SPRINT 6 (2026-09-16 to 2026-09-30) ---
  {
    schemaVersion: 2,
    source: 'live',
    prNumber: 14,
    prTitle: 'feat: contributor breakdown treemap and color tokens',
    repository: 'DEFRA/mmo-cr-copilot-dashboard',
    projectSlug: 'FES',
    jiraKeys: ['MMOCR-102'],
    sourceBranch: 'feat/treemap-breakdown',
    calculatedAt: '2026-09-20T08:45:00.000Z',
    prCreatedAt: '2026-09-18T10:00:00.000Z',
    firstCommitAt: '2026-09-18T10:30:00.000Z',
    lastCommitAt: '2026-09-20T08:30:00.000Z',
    prMergedAt: '2026-09-20T09:00:00.000Z',
    files: {
      changed: 6,
      linesTouched: 302,
      testFilesChanged: 2,
      testLinesTouched: 57,
      modulesTouched: 2,
      excluded: { filesChanged: 0, linesTouched: 0 }
    },
    commits: [
      {
        commit: 'd4e5f6a',
        committedAt: '2026-09-18T10:30:00.000Z',
        author: 'bob',
        subject: 'feat: add breakdown treemap for contributor lines',
        classification: 'Copilot-assisted',
        filesChanged: 4,
        linesAdded: 210,
        linesDeleted: 35,
        attribution: {
          source: 'extension',
          version: 1,
          aiCompletionLines: 120,
          aiChatLines: 50,
          aiAgentLines: 40,
          pastedLines: 15,
          typedLines: 20
        }
      },
      {
        commit: 'e5f6a7b',
        committedAt: '2026-09-20T08:30:00.000Z',
        author: 'bob',
        subject: 'style: apply token palette to treemap nodes',
        classification: 'Human-authored',
        filesChanged: 2,
        linesAdded: 45,
        linesDeleted: 12,
        attribution: { source: 'none' }
      }
    ]
  },
  {
    schemaVersion: 2,
    source: 'live',
    prNumber: 28,
    prTitle: 'fix: SonarCloud proxy retry resilience and cache',
    repository: 'DEFRA/mmo-cr-copilot-backend',
    projectSlug: 'FES',
    jiraKeys: ['MMOCR-104'],
    sourceBranch: 'fix/sonar-proxy-cache',
    calculatedAt: '2026-09-22T15:10:00.000Z',
    prCreatedAt: '2026-09-21T13:00:00.000Z',
    firstCommitAt: '2026-09-21T13:40:00.000Z',
    lastCommitAt: '2026-09-22T14:50:00.000Z',
    prMergedAt: '2026-09-22T15:30:00.000Z',
    files: {
      changed: 4,
      linesTouched: 250,
      testFilesChanged: 1,
      testLinesTouched: 90,
      modulesTouched: 2,
      excluded: { filesChanged: 0, linesTouched: 0 }
    },
    commits: [
      {
        commit: 'c9d0e1f',
        committedAt: '2026-09-21T13:40:00.000Z',
        author: 'eve',
        subject: 'feat: cache SonarCloud responses and handle 404 gracefully',
        classification: 'Copilot-assisted',
        filesChanged: 3,
        linesAdded: 140,
        linesDeleted: 20,
        attribution: { source: 'legacy-trailer' }
      },
      {
        commit: 'd0e1f2a',
        committedAt: '2026-09-22T14:50:00.000Z',
        author: 'eve',
        subject: 'test: unit tests for Sonar client anonymous fallback',
        classification: 'Copilot-assisted',
        filesChanged: 1,
        linesAdded: 85,
        linesDeleted: 5,
        attribution: { source: 'legacy-trailer' }
      }
    ]
  },

  // --- PREVIOUS SPRINT 7 (2026-09-30 to 2026-10-14) ---
  {
    schemaVersion: 2,
    source: 'live',
    prNumber: 45,
    prTitle: 'feat: batch CSV stream exporter for landing catch reports',
    repository: 'DEFRA/mmo-cr-internal-admin',
    projectSlug: 'FES',
    jiraKeys: ['MMOCR-105'],
    calculatedAt: '2026-10-05T16:00:00.000Z',
    prCreatedAt: '2026-10-02T10:00:00.000Z',
    firstCommitAt: '2026-10-02T10:45:00.000Z',
    lastCommitAt: '2026-10-05T15:30:00.000Z',
    prMergedAt: '2026-10-05T16:30:00.000Z',
    files: {
      changed: 9,
      linesTouched: 518,
      testFilesChanged: 2,
      testLinesTouched: 83,
      modulesTouched: 3,
      excluded: { filesChanged: 0, linesTouched: 0 }
    },
    commits: [
      {
        commit: 'e1f2a3b',
        committedAt: '2026-10-02T10:45:00.000Z',
        author: 'eve',
        subject: 'feat: add CSV stream exporter for landing reports',
        classification: 'Copilot-assisted',
        filesChanged: 5,
        linesAdded: 320,
        linesDeleted: 40,
        attribution: {
          source: 'extension',
          version: 1,
          aiCompletionLines: 150,
          aiChatLines: 80,
          aiAgentLines: 90,
          pastedLines: 20,
          typedLines: 20
        }
      },
      {
        commit: 'f2a3b4c',
        committedAt: '2026-10-03T14:15:00.000Z',
        author: 'bob',
        subject: 'feat: integrate S3 presigned URL download generation',
        classification: 'Copilot-assisted',
        filesChanged: 2,
        linesAdded: 120,
        linesDeleted: 15,
        attribution: {
          source: 'extension',
          version: 1,
          aiCompletionLines: 70,
          aiChatLines: 20,
          aiAgentLines: 30,
          pastedLines: 5,
          typedLines: 10
        }
      },
      {
        commit: 'a3b4c5d',
        committedAt: '2026-10-05T15:30:00.000Z',
        author: 'dana',
        subject: 'test: end-to-end audit verification tests',
        classification: 'Human-authored',
        filesChanged: 2,
        linesAdded: 75,
        linesDeleted: 8,
        attribution: { source: 'none' }
      }
    ]
  },
  {
    schemaVersion: 2,
    source: 'live',
    prNumber: 18,
    prTitle: 'chore: sync FAO species codes for North Sea fisheries',
    repository: 'DEFRA/mmo-cr-reference-data',
    projectSlug: 'FES',
    jiraKeys: [], // Intentionally unlinked to provide realistic unlinkedPrRate
    calculatedAt: '2026-10-08T12:00:00.000Z',
    prCreatedAt: '2026-10-06T08:00:00.000Z',
    firstCommitAt: '2026-10-06T08:30:00.000Z',
    lastCommitAt: '2026-10-08T11:30:00.000Z',
    prMergedAt: '2026-10-08T12:30:00.000Z',
    files: {
      changed: 4,
      linesTouched: 615,
      testFilesChanged: 1,
      testLinesTouched: 45,
      modulesTouched: 1,
      excluded: { filesChanged: 0, linesTouched: 0 }
    },
    commits: [
      {
        commit: 'b4c5d6e',
        committedAt: '2026-10-06T08:30:00.000Z',
        author: 'charlie',
        subject: 'chore: sync FAO species codes for North Sea fisheries',
        classification: 'Copilot-assisted',
        filesChanged: 3,
        linesAdded: 450,
        linesDeleted: 120,
        attribution: { source: 'legacy-trailer' }
      },
      {
        commit: 'c5d6e7f',
        committedAt: '2026-10-08T11:30:00.000Z',
        author: 'charlie',
        subject: 'ci: update validation schema for species lookup tables',
        classification: 'Human-authored',
        filesChanged: 1,
        linesAdded: 35,
        linesDeleted: 10,
        attribution: { source: 'none' }
      }
    ]
  },

  // --- CURRENT LIVE SPRINT 8 (2026-10-14 to 2026-10-28) ---
  {
    schemaVersion: 2,
    source: 'live',
    prNumber: 35,
    prTitle: 'feat: add GOV.UK Frontend 6.6 responsive shell and token bands',
    repository: 'DEFRA/mmo-cr-copilot-dashboard',
    projectSlug: 'FES',
    jiraKeys: ['MMOCR-107'],
    sourceBranch: 'feat/govuk-v6-shell',
    calculatedAt: '2026-10-15T14:30:00.000Z',
    prCreatedAt: '2026-10-14T10:00:00.000Z',
    firstCommitAt: '2026-10-14T10:30:00.000Z',
    lastCommitAt: '2026-10-15T14:00:00.000Z',
    prMergedAt: '2026-10-15T15:00:00.000Z',
    files: {
      changed: 7,
      linesTouched: 380,
      testFilesChanged: 2,
      testLinesTouched: 95,
      modulesTouched: 2,
      excluded: { filesChanged: 0, linesTouched: 0 }
    },
    commits: [
      {
        commit: '99a8b7c',
        committedAt: '2026-10-14T10:30:00.000Z',
        author: 'ada',
        subject: 'feat: apply GOV.UK template and navigation',
        classification: 'Copilot-assisted',
        filesChanged: 3,
        linesAdded: 160,
        linesDeleted: 25,
        attribution: {
          source: 'extension',
          version: 1,
          aiCompletionLines: 100,
          aiChatLines: 30,
          aiAgentLines: 30,
          pastedLines: 10,
          typedLines: 15
        }
      },
      {
        commit: '77a8b9c',
        committedAt: '2026-10-15T11:15:00.000Z',
        author: 'rhododendron',
        subject: 'feat: responsive service navigation',
        classification: 'Copilot-assisted',
        filesChanged: 2,
        linesAdded: 90,
        linesDeleted: 10,
        attribution: {
          source: 'extension',
          version: 1,
          aiCompletionLines: 60,
          aiChatLines: 20,
          aiAgentLines: 0,
          pastedLines: 0,
          typedLines: 20
        }
      },
      {
        commit: '88b7c6d',
        committedAt: '2026-10-15T14:00:00.000Z',
        author: 'dana',
        subject: 'test: accessibility validation for header and skip link',
        classification: 'Human-authored',
        filesChanged: 2,
        linesAdded: 80,
        linesDeleted: 15,
        attribution: { source: 'none' }
      }
    ]
  },

  // --- CURRENT LIVE SPRINT 9 (2026-10-28 to 2026-11-11) ---
  {
    schemaVersion: 2,
    source: 'live',
    prNumber: 50,
    prTitle: 'feat: Copilot usage superlatives cards and model leaderboard',
    repository: 'DEFRA/mmo-cr-copilot-dashboard',
    projectSlug: 'FES',
    jiraKeys: ['MMOCR-114'],
    sourceBranch: 'feat/copilot-superlatives',
    calculatedAt: '2026-10-29T08:40:00.000Z',
    prCreatedAt: '2026-10-28T09:00:00.000Z',
    firstCommitAt: '2026-10-28T09:30:00.000Z',
    lastCommitAt: '2026-10-29T08:20:00.000Z',
    prMergedAt: '2026-10-29T08:45:00.000Z',
    files: {
      changed: 6,
      linesTouched: 330,
      testFilesChanged: 2,
      testLinesTouched: 90,
      modulesTouched: 2,
      excluded: { filesChanged: 0, linesTouched: 0 }
    },
    commits: [
      {
        commit: 'c0de501',
        committedAt: '2026-10-28T09:30:00.000Z',
        author: 'ada',
        subject: 'feat: model leaderboard and superlative cards',
        classification: 'Copilot-assisted',
        filesChanged: 4,
        linesAdded: 190,
        linesDeleted: 20,
        attribution: {
          source: 'extension',
          version: 1,
          aiCompletionLines: 90,
          aiChatLines: 50,
          aiAgentLines: 30,
          pastedLines: 5,
          typedLines: 15
        }
      },
      {
        commit: 'c0de502',
        committedAt: '2026-10-28T22:40:00.000Z',
        author: 'rhododendron',
        subject: 'fix: superlative card wording and empty state',
        classification: 'Copilot-assisted',
        filesChanged: 2,
        linesAdded: 55,
        linesDeleted: 15,
        attribution: {
          source: 'extension',
          version: 1,
          aiCompletionLines: 30,
          aiChatLines: 20,
          aiAgentLines: 0,
          pastedLines: 0,
          typedLines: 20
        }
      },
      {
        commit: 'c0de503',
        committedAt: '2026-10-29T08:20:00.000Z',
        author: 'dana',
        subject: 'test: accessibility checks for superlative cards',
        classification: 'Human-authored',
        filesChanged: 2,
        linesAdded: 40,
        linesDeleted: 10,
        attribution: { source: 'none' }
      }
    ]
  },
  {
    schemaVersion: 2,
    source: 'live',
    prNumber: 51,
    prTitle: 'feat: expose per-model token usage in payload queries',
    repository: 'DEFRA/mmo-cr-copilot-backend',
    projectSlug: 'FES',
    jiraKeys: ['MMOCR-115'],
    sourceBranch: 'feat/usage-payload-query',
    calculatedAt: '2026-10-29T09:05:00.000Z',
    prCreatedAt: '2026-10-28T13:30:00.000Z',
    firstCommitAt: '2026-10-28T14:10:00.000Z',
    lastCommitAt: '2026-10-29T08:35:00.000Z',
    prMergedAt: '2026-10-29T09:10:00.000Z',
    files: {
      changed: 5,
      linesTouched: 290,
      testFilesChanged: 2,
      testLinesTouched: 80,
      modulesTouched: 2,
      excluded: { filesChanged: 0, linesTouched: 0 }
    },
    commits: [
      {
        commit: 'c0de511',
        committedAt: '2026-10-28T14:10:00.000Z',
        author: 'bob',
        subject: 'feat: validate and persist attribution usage blocks',
        classification: 'Copilot-assisted',
        filesChanged: 3,
        linesAdded: 170,
        linesDeleted: 25,
        attribution: {
          source: 'extension',
          version: 1,
          aiCompletionLines: 80,
          aiChatLines: 40,
          aiAgentLines: 35,
          pastedLines: 5,
          typedLines: 15
        }
      },
      {
        commit: 'c0de512',
        committedAt: '2026-10-29T02:15:00.000Z',
        author: 'eve',
        subject: 'test: usage schema bounds and model name pattern',
        classification: 'Copilot-assisted',
        filesChanged: 2,
        linesAdded: 70,
        linesDeleted: 5,
        attribution: {
          source: 'extension',
          version: 1,
          aiCompletionLines: 40,
          aiChatLines: 20,
          aiAgentLines: 10,
          pastedLines: 0,
          typedLines: 5
        }
      },
      {
        commit: 'c0de513',
        committedAt: '2026-10-29T08:35:00.000Z',
        author: 'ada',
        subject: 'docs: describe usage block in the payload contract',
        classification: 'Human-authored',
        filesChanged: 1,
        linesAdded: 20,
        linesDeleted: 5,
        attribution: { source: 'none' }
      }
    ]
  },

  // --- AI-NATIVE PROJECT: CRAR ---
  {
    schemaVersion: 2,
    source: 'live',
    prNumber: 1,
    prTitle: 'feat: autonomous agent workflow orchestrator engine',
    repository: 'DEFRA/mmo-agentic-core',
    projectSlug: 'CRAR',
    jiraKeys: ['AGENT-201'],
    sourceBranch: 'feat/agent-orchestrator',
    calculatedAt: '2026-10-12T10:00:00.000Z',
    prCreatedAt: '2026-10-11T08:00:00.000Z',
    firstCommitAt: '2026-10-11T08:15:00.000Z',
    lastCommitAt: '2026-10-12T09:30:00.000Z',
    prMergedAt: '2026-10-12T10:15:00.000Z',
    files: {
      changed: 4,
      linesTouched: 360,
      testFilesChanged: 2,
      testLinesTouched: 110,
      modulesTouched: 2,
      excluded: { filesChanged: 0, linesTouched: 0 }
    },
    commits: [
      {
        commit: 'aa11bb2',
        committedAt: '2026-10-11T08:15:00.000Z',
        author: 'eve',
        subject: 'feat: agent task dispatch graph and tool runtime',
        classification: 'Copilot-assisted',
        filesChanged: 2,
        linesAdded: 210,
        linesDeleted: 40,
        attribution: {
          source: 'extension',
          version: 1,
          aiCompletionLines: 30,
          aiChatLines: 20,
          aiAgentLines: 160,
          pastedLines: 10,
          typedLines: 30
        }
      },
      {
        commit: 'bb22cc3',
        committedAt: '2026-10-12T09:30:00.000Z',
        author: 'eve',
        subject: 'test: agentic session lifecycle unit tests',
        classification: 'Copilot-assisted',
        filesChanged: 2,
        linesAdded: 95,
        linesDeleted: 15,
        attribution: {
          source: 'extension',
          version: 1,
          aiCompletionLines: 15,
          aiChatLines: 10,
          aiAgentLines: 70,
          pastedLines: 5,
          typedLines: 10
        }
      }
    ]
  },
  {
    schemaVersion: 2,
    source: 'live',
    prNumber: 2,
    prTitle: 'feat: streaming tool runner worker with sandbox telemetry',
    repository: 'DEFRA/mmo-agentic-worker',
    projectSlug: 'CRAR',
    jiraKeys: ['AGENT-202'],
    sourceBranch: 'feat/worker-sandbox',
    calculatedAt: '2026-10-15T11:00:00.000Z',
    prCreatedAt: '2026-10-13T09:00:00.000Z',
    firstCommitAt: '2026-10-13T09:30:00.000Z',
    lastCommitAt: '2026-10-15T10:30:00.000Z',
    prMergedAt: '2026-10-15T11:30:00.000Z',
    files: {
      changed: 3,
      linesTouched: 215,
      testFilesChanged: 1,
      testLinesTouched: 55,
      modulesTouched: 1,
      excluded: { filesChanged: 0, linesTouched: 0 }
    },
    commits: [
      {
        commit: 'cc33dd4',
        committedAt: '2026-10-13T09:30:00.000Z',
        author: 'eve',
        subject: 'feat: containerized subagent executor sandbox',
        classification: 'Copilot-assisted',
        filesChanged: 2,
        linesAdded: 140,
        linesDeleted: 20,
        attribution: {
          source: 'extension',
          version: 1,
          aiCompletionLines: 20,
          aiChatLines: 15,
          aiAgentLines: 105,
          pastedLines: 5,
          typedLines: 15
        }
      },
      {
        commit: 'dd44ee5',
        committedAt: '2026-10-15T10:30:00.000Z',
        author: 'eve',
        subject: 'test: worker process execution timeout tests',
        classification: 'Copilot-assisted',
        filesChanged: 1,
        linesAdded: 50,
        linesDeleted: 5,
        attribution: {
          source: 'extension',
          version: 1,
          aiCompletionLines: 10,
          aiChatLines: 5,
          aiAgentLines: 35,
          pastedLines: 0,
          typedLines: 5
        }
      }
    ]
  },

  // --- UNASSIGNED REPOSITORIES (projectSlug: null) ---
  {
    schemaVersion: 2,
    source: 'live',
    prNumber: 5,
    prTitle: 'fix: patch memory leak in legacy reporting daemon',
    repository: 'DEFRA/mmo-cr-legacy-service',
    projectSlug: null,
    jiraKeys: [],
    calculatedAt: '2026-10-14T09:00:00.000Z',
    prCreatedAt: '2026-10-13T10:00:00.000Z',
    firstCommitAt: '2026-10-13T10:30:00.000Z',
    lastCommitAt: '2026-10-14T08:45:00.000Z',
    prMergedAt: '2026-10-14T09:30:00.000Z',
    files: {
      changed: 2,
      linesTouched: 60,
      testFilesChanged: 1,
      testLinesTouched: 20,
      modulesTouched: 1,
      excluded: { filesChanged: 0, linesTouched: 0 }
    },
    commits: [
      {
        commit: 'ee55ff6',
        committedAt: '2026-10-13T10:30:00.000Z',
        author: 'bob',
        subject: 'fix: clear timer handle on daemon teardown',
        classification: 'Human-authored',
        filesChanged: 2,
        linesAdded: 50,
        linesDeleted: 10,
        attribution: { source: 'none' }
      }
    ]
  },
  {
    schemaVersion: 2,
    source: 'live',
    prNumber: 3,
    prTitle: 'experiment: prototype semantic embedding index for audit logs',
    repository: 'DEFRA/mmo-cr-experimental-tool',
    projectSlug: null,
    jiraKeys: [],
    calculatedAt: '2026-10-15T08:00:00.000Z',
    prCreatedAt: '2026-10-14T11:00:00.000Z',
    firstCommitAt: '2026-10-14T11:30:00.000Z',
    lastCommitAt: '2026-10-15T07:45:00.000Z',
    prMergedAt: '2026-10-15T08:15:00.000Z',
    files: {
      changed: 3,
      linesTouched: 145,
      testFilesChanged: 1,
      testLinesTouched: 30,
      modulesTouched: 1,
      excluded: { filesChanged: 0, linesTouched: 0 }
    },
    commits: [
      {
        commit: 'ff66aa7',
        committedAt: '2026-10-14T11:30:00.000Z',
        author: 'ada',
        subject: 'experiment: vector embeddings prototype',
        classification: 'Copilot-assisted',
        filesChanged: 3,
        linesAdded: 130,
        linesDeleted: 15,
        attribution: {
          source: 'extension',
          version: 1,
          aiCompletionLines: 70,
          aiChatLines: 30,
          aiAgentLines: 20,
          pastedLines: 5,
          typedLines: 20
        }
      }
    ]
  }
]

// 6. Sonar PR Snapshots (New-code measures & Clean as You Code)
const SONAR_PR_SNAPSHOTS = [
  {
    repository: 'DEFRA/mmo-cr-copilot-dashboard',
    prNumber: 12,
    projectKey: 'DEFRA_mmo-cr-copilot-dashboard',
    qualityGate: 'passed',
    firstScanQualityGate: 'passed',
    alert_status: 'OK',
    ratings: { reliability: 'A', security: 'A', maintainability: 'A' },
    measures: {
      new_coverage: 94.5,
      new_duplicated_lines_density: 0.8,
      new_sqale_debt_ratio: 0.02,
      new_software_quality_blocker_issues: 0,
      new_software_quality_high_issues: 0,
      new_bugs: 0,
      new_vulnerabilities: 0,
      new_code_smells: 1
    },
    capturedAt: new Date('2026-09-12T11:45:00.000Z')
  },
  {
    repository: 'DEFRA/mmo-cr-copilot-dashboard',
    prNumber: 14,
    projectKey: 'DEFRA_mmo-cr-copilot-dashboard',
    qualityGate: 'passed',
    firstScanQualityGate: 'passed',
    alert_status: 'OK',
    ratings: { reliability: 'A', security: 'A', maintainability: 'A' },
    measures: {
      new_coverage: 91.2,
      new_duplicated_lines_density: 1.2,
      new_sqale_debt_ratio: 0.03,
      new_software_quality_blocker_issues: 0,
      new_software_quality_high_issues: 1,
      new_bugs: 0,
      new_vulnerabilities: 0,
      new_code_smells: 2
    },
    capturedAt: new Date('2026-09-20T09:00:00.000Z')
  },
  {
    repository: 'DEFRA/mmo-cr-copilot-backend',
    prNumber: 25,
    projectKey: 'DEFRA_mmo-cr-copilot-backend',
    qualityGate: 'passed',
    firstScanQualityGate: 'passed',
    alert_status: 'OK',
    ratings: { reliability: 'A', security: 'A', maintainability: 'A' },
    measures: {
      new_coverage: 96.0,
      new_duplicated_lines_density: 0.0,
      new_sqale_debt_ratio: 0.01,
      new_software_quality_blocker_issues: 0,
      new_software_quality_high_issues: 0,
      new_bugs: 0,
      new_vulnerabilities: 0,
      new_code_smells: 0
    },
    capturedAt: new Date('2026-09-11T16:40:00.000Z')
  },
  {
    repository: 'DEFRA/mmo-cr-copilot-backend',
    prNumber: 28,
    projectKey: 'DEFRA_mmo-cr-copilot-backend',
    qualityGate: 'failed',
    firstScanQualityGate: 'failed',
    alert_status: 'ERROR',
    ratings: { reliability: 'B', security: 'A', maintainability: 'B' },
    measures: {
      new_coverage: 72.0,
      new_duplicated_lines_density: 2.5,
      new_sqale_debt_ratio: 0.08,
      new_software_quality_blocker_issues: 1,
      new_software_quality_high_issues: 2,
      new_bugs: 1,
      new_vulnerabilities: 0,
      new_code_smells: 4
    },
    capturedAt: new Date('2026-09-22T15:30:00.000Z')
  },
  {
    repository: 'DEFRA/mmo-cr-internal-admin',
    prNumber: 45,
    projectKey: 'DEFRA_mmo-cr-internal-admin',
    qualityGate: 'passed',
    firstScanQualityGate: 'passed',
    alert_status: 'OK',
    ratings: { reliability: 'A', security: 'A', maintainability: 'A' },
    measures: {
      new_coverage: 90.0,
      new_duplicated_lines_density: 1.0,
      new_sqale_debt_ratio: 0.03,
      new_software_quality_blocker_issues: 0,
      new_software_quality_high_issues: 0,
      new_bugs: 0,
      new_vulnerabilities: 0,
      new_code_smells: 2
    },
    capturedAt: new Date('2026-10-05T16:30:00.000Z')
  },
  {
    repository: 'DEFRA/mmo-agentic-core',
    prNumber: 1,
    projectKey: 'DEFRA_mmo-agentic-core',
    qualityGate: 'passed',
    firstScanQualityGate: 'passed',
    alert_status: 'OK',
    ratings: { reliability: 'A', security: 'A', maintainability: 'A' },
    measures: {
      new_coverage: 98.0,
      new_duplicated_lines_density: 0.4,
      new_sqale_debt_ratio: 0.01,
      new_software_quality_blocker_issues: 0,
      new_software_quality_high_issues: 0,
      new_bugs: 0,
      new_vulnerabilities: 0,
      new_code_smells: 0
    },
    capturedAt: new Date('2026-10-12T10:15:00.000Z')
  },
  {
    repository: 'DEFRA/mmo-agentic-worker',
    prNumber: 2,
    projectKey: 'DEFRA_mmo-agentic-worker',
    qualityGate: 'passed',
    firstScanQualityGate: 'passed',
    alert_status: 'OK',
    ratings: { reliability: 'A', security: 'A', maintainability: 'A' },
    measures: {
      new_coverage: 95.0,
      new_duplicated_lines_density: 0.6,
      new_sqale_debt_ratio: 0.02,
      new_software_quality_blocker_issues: 0,
      new_software_quality_high_issues: 0,
      new_bugs: 0,
      new_vulnerabilities: 0,
      new_code_smells: 1
    },
    capturedAt: new Date('2026-10-15T11:30:00.000Z')
  }
]

// 8. Audit Logs
const AUDIT_LOGS = [
  {
    action: 'project.created',
    entity: 'project',
    entityId: 'FES',
    projectSlug: 'FES',
    occurredAt: new Date('2026-01-01T00:00:00.000Z'),
    actor: { oid: 'admin-oid-1', name: 'Lead Dev' },
    summary: "Project 'MMO Catch Recording' created"
  },
  {
    action: 'project.created',
    entity: 'project',
    entityId: 'CRAR',
    projectSlug: 'CRAR',
    occurredAt: new Date('2026-06-01T00:00:00.000Z'),
    actor: { oid: 'admin-oid-1', name: 'Lead Dev' },
    summary: "Project 'MMO Agentic Delivery' created"
  },
  {
    action: 'persona-mapping.created',
    entity: 'persona-mapping',
    entityId: 'ada',
    projectSlug: 'FES',
    occurredAt: new Date('2026-01-05T09:00:00.000Z'),
    actor: { oid: 'admin-oid-1', name: 'Lead Dev' },
    summary: "Assigned persona 'developer' to octocat 'ada'"
  },
  {
    action: 'commit-classification.updated',
    entity: 'commit-classification',
    entityId: 'DEFRA/mmo-cr-copilot-dashboard#12@c3d4e5f',
    projectSlug: 'FES',
    occurredAt: new Date('2026-09-12T12:00:00.000Z'),
    actor: { oid: 'admin-oid-1', name: 'Lead Dev' },
    summary:
      'Re-classified commit c3d4e5f on DEFRA/mmo-cr-copilot-dashboard#12 as Human-authored'
  }
]

async function seedData() {
  try {
    console.log(`Connecting to MongoDB at ${MONGO_URI}...`)
    await client.connect()
    const db = client.db(DATABASE_NAME)

    console.log('\n--- Clearing previous mock data ---')
    const collectionsToClean = [
      'projects',
      'repositories',
      'payloads',
      'jira-issues',
      'pr-jira-links',
      'jira-sprint-scope',
      'sonar-snapshots',
      'sonar-pr-snapshots',
      'audit-logs',
      'persona-mappings',
      'role_mappings'
    ]
    for (const name of collectionsToClean) {
      const res = await db.collection(name).deleteMany({})
      console.log(`  Cleared ${res.deletedCount} from '${name}'`)
    }

    console.log('\n--- 1. Seeding Projects ---')
    await db.collection('role_mappings').insertMany(ROLE_MAPPINGS)
    console.log(`  Inserted ${ROLE_MAPPINGS.length} role mappings`)

    await db.collection('projects').insertMany(PROJECTS)
    console.log(`  Inserted ${PROJECTS.length} projects:`)
    for (const p of PROJECTS) {
      console.log(`    - ${p.name} [${p.type}] (slug: ${p.slug})`)
    }

    console.log('\n--- 2. Seeding Mapped Repositories ---')
    await db.collection('repositories').insertMany(REPOSITORIES)
    console.log(`  Inserted ${REPOSITORIES.length} repositories:`)
    for (const r of REPOSITORIES) {
      console.log(`    - ${r.fullName} -> ${r.projectSlug}`)
    }

    console.log('\n--- 3. Seeding Persona Mappings ---')
    for (const m of PERSONA_MAPPINGS) {
      await db.collection('persona-mappings').updateOne(
        { _id: `${PERSONA_PROJECT}:${m.githubHandle.toLowerCase()}` },
        {
          $set: { ...m, projectSlug: PERSONA_PROJECT, updatedAt: new Date() }
        },
        { upsert: true }
      )
    }
    console.log(`  Inserted ${PERSONA_MAPPINGS.length} persona mappings.`)

    console.log('\n--- 4. Seeding Analytics Payloads ---')
    const specs = [...PAYLOAD_SPECS, ...JIRA_SCENARIO_PAYLOAD_SPECS]
    const payloadDocs = specs.map(createPayloadDoc)
    await db.collection('payloads').insertMany(payloadDocs)
    console.log(
      `  Inserted ${payloadDocs.length} analytics payloads across historical baseline, previous sprints, live sprint, AI-native, and unassigned:`
    )
    for (const p of payloadDocs) {
      console.log(
        `    - PR #${p.prNumber} on ${p.repository} [${p.projectSlug || 'UNASSIGNED'}] (complexity: ${p.complexity?.score} ${p.complexity?.band}, keys: ${p.jiraKeys?.join(',') || 'none'})`
      )
    }

    console.log('\n--- 5. Seeding Jira Cloud Issues ---')
    await db.collection('jira-issues').insertMany(JIRA_ISSUES)
    console.log(`  Inserted ${JIRA_ISSUES.length} Jira issues:`)
    for (const j of JIRA_ISSUES) {
      console.log(
        `    - ${j.key} (${j.issueType}, ${j.status.name}, ${j.storyPoints || 0} pts, project: ${j.projectSlug})`
      )
    }

    await db.collection('jira-sprint-scope').insertMany(JIRA_SPRINT_SCOPES)
    console.log(`  Inserted ${JIRA_SPRINT_SCOPES.length} sprint scopes.`)

    console.log('\n--- 6. Seeding PR-Jira Links ---')
    const prJiraLinks = buildPrJiraLinks(specs)
    await db.collection('pr-jira-links').insertMany(prJiraLinks)
    console.log(`  Inserted ${prJiraLinks.length} PR-Jira links.`)

    console.log('\n--- 7. Seeding SonarCloud Snapshots ---')
    const sprintSnaps = buildSonarSprintSnapshots(REPOSITORIES)
    const prSnaps = [
      ...SONAR_PR_SNAPSHOTS,
      ...buildScenarioPrSnapshots(REPOSITORIES)
    ]
    await db.collection('sonar-snapshots').insertMany(sprintSnaps)
    await db.collection('sonar-pr-snapshots').insertMany(prSnaps)
    console.log(
      `  Inserted ${sprintSnaps.length} sprint cutoff snapshots and ${prSnaps.length} PR Clean as You Code snapshots.`
    )

    console.log('\n--- 8. Seeding Audit Logs ---')
    await db.collection('audit-logs').insertMany(AUDIT_LOGS)
    console.log(`  Inserted ${AUDIT_LOGS.length} audit trail records.`)

    console.log(
      '\n================================================================'
    )
    console.log('✅ DATABASE SUCCESSFULLY SEEDED WITH COMPREHENSIVE MOCK DATA!')
    console.log(
      '================================================================'
    )
    console.log('Covered Scenarios:')
    console.log('  1. AI-adopted project (MMO Catch Recording) with baseline')
    console.log(
      '  2. AI-native project (MMO Agentic Delivery) with delivery quadrant'
    )
    console.log('  3. Multi-sprint time travel (Live + Sprints 7, 6, 5)')
    console.log('  4. Complexity scoring (XS to XL bands) & Leverage v2')
    console.log('  5. VS Code extension attribution line breakdowns')
    console.log(
      '  6. Jira Cloud stories, bugs, story points & cycle times for QANT'
    )
    console.log(
      '  7. Sonar Clean as You Code snapshots (passed and failed gates)'
    )
    console.log(
      '  8. Discovered unassigned repositories ready for admin onboarding'
    )
    console.log('  9. Admin audit log entries with user context')
    console.log(
      '================================================================'
    )
  } catch (error) {
    console.error('Error seeding data:', error)
    process.exitCode = 1
  } finally {
    await client.close()
  }
}

seedData()
