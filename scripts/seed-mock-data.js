import { MongoClient } from 'mongodb'

const MONGO_URI = process.env.MONGO_URI || 'mongodb://127.0.0.1:27017/'
const DATABASE_NAME = process.env.MONGO_DATABASE || 'mmo-cr-copilot-backend'

const client = new MongoClient(MONGO_URI)

const PERSONA_MAPPINGS = [
  { githubHandle: 'ada', persona: 'developer' },
  { githubHandle: 'bob', persona: 'developer' },
  { githubHandle: 'charlie', persona: 'devops' },
  { githubHandle: 'dana', persona: 'qa' },
  { githubHandle: 'eve', persona: 'developer' }
]

function createPayload({
  prNumber,
  repository,
  sourceBranch,
  targetBranch = 'main',
  buildId,
  calculatedAt,
  prCreatedAt,
  firstCommitAt,
  lastCommitAt,
  prMergedAt,
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

  return {
    prNumber,
    repository,
    sourceBranch,
    targetBranch,
    buildId,
    calculatedAt: new Date(calculatedAt),
    prCreatedAt: prCreatedAt ? new Date(prCreatedAt) : undefined,
    firstCommitAt: firstCommitAt ? new Date(firstCommitAt) : undefined,
    lastCommitAt: lastCommitAt ? new Date(lastCommitAt) : undefined,
    prMergedAt: prMergedAt ? new Date(prMergedAt) : undefined,
    receivedAt: new Date(),
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
      ...c,
      committedAt: c.committedAt ? new Date(c.committedAt) : undefined,
      linesTouched: c.linesAdded + c.linesDeleted,
      netLines: c.linesAdded - c.linesDeleted
    }))
  }
}

const RAW_PAYLOADS = [
  // PR 1: DEFRA/mmo-cr-copilot-dashboard #12 - Cycle Time & Scatter chart
  {
    prNumber: 12,
    repository: 'DEFRA/mmo-cr-copilot-dashboard',
    sourceBranch: 'feat/cycle-time-scatter',
    buildId: 'build-201',
    calculatedAt: '2026-09-12T11:30:00.000Z',
    prCreatedAt: '2026-09-10T09:00:00.000Z',
    firstCommitAt: '2026-09-10T09:15:00.000Z',
    lastCommitAt: '2026-09-12T11:00:00.000Z',
    prMergedAt: '2026-09-12T11:45:00.000Z',
    commits: [
      {
        commit: 'a1b2c3d',
        committedAt: '2026-09-10T09:15:00.000Z',
        author: 'ada',
        subject: 'feat: add cycle time scatter chart component',
        classification: 'Copilot-assisted',
        filesChanged: 3,
        linesAdded: 180,
        linesDeleted: 15
      },
      {
        commit: 'b2c3d4e',
        committedAt: '2026-09-11T14:20:00.000Z',
        author: 'ada',
        subject: 'test: add vitest unit tests for cycle time math',
        classification: 'Copilot-assisted',
        filesChanged: 2,
        linesAdded: 95,
        linesDeleted: 8
      },
      {
        commit: 'c3d4e5f',
        committedAt: '2026-09-12T11:00:00.000Z',
        author: 'dana',
        subject: 'test: verify accessible table alternative for scatter plot',
        classification: 'Human-authored',
        filesChanged: 1,
        linesAdded: 40,
        linesDeleted: 5
      }
    ]
  },

  // PR 2: DEFRA/mmo-cr-copilot-dashboard #14 - Responsive Treemap breakdown
  {
    prNumber: 14,
    repository: 'DEFRA/mmo-cr-copilot-dashboard',
    sourceBranch: 'feat/treemap-breakdown',
    buildId: 'build-202',
    calculatedAt: '2026-09-14T08:45:00.000Z',
    prCreatedAt: '2026-09-13T10:00:00.000Z',
    firstCommitAt: '2026-09-13T10:30:00.000Z',
    lastCommitAt: '2026-09-14T08:30:00.000Z',
    prMergedAt: '2026-09-14T09:00:00.000Z',
    commits: [
      {
        commit: 'd4e5f6a',
        committedAt: '2026-09-13T10:30:00.000Z',
        author: 'bob',
        subject: 'feat: add breakdown treemap for contributor lines',
        classification: 'Copilot-assisted',
        filesChanged: 4,
        linesAdded: 210,
        linesDeleted: 35
      },
      {
        commit: 'e5f6a7b',
        committedAt: '2026-09-14T08:30:00.000Z',
        author: 'bob',
        subject: 'style: apply token palette to treemap nodes',
        classification: 'Human-authored',
        filesChanged: 2,
        linesAdded: 45,
        linesDeleted: 12
      }
    ]
  },

  // PR 3: DEFRA/mmo-cr-copilot-backend #25 - Ingest pipeline optimizations
  {
    prNumber: 25,
    repository: 'DEFRA/mmo-cr-copilot-backend',
    sourceBranch: 'perf/ingest-aggregation',
    buildId: 'build-301',
    calculatedAt: '2026-09-11T16:20:00.000Z',
    prCreatedAt: '2026-09-09T14:00:00.000Z',
    firstCommitAt: '2026-09-09T14:30:00.000Z',
    lastCommitAt: '2026-09-11T16:00:00.000Z',
    prMergedAt: '2026-09-11T16:40:00.000Z',
    commits: [
      {
        commit: 'f6a7b8c',
        committedAt: '2026-09-09T14:30:00.000Z',
        author: 'charlie',
        subject:
          'feat: add compound index for repository and prNumber history rollup',
        classification: 'Copilot-assisted',
        filesChanged: 2,
        linesAdded: 60,
        linesDeleted: 10
      },
      {
        commit: 'a7b8c9d',
        committedAt: '2026-09-10T11:15:00.000Z',
        author: 'charlie',
        subject:
          'refactor: streamline mongo aggregation pipeline for latest payloads',
        classification: 'Copilot-assisted',
        filesChanged: 1,
        linesAdded: 110,
        linesDeleted: 45
      },
      {
        commit: 'b8c9d0e',
        committedAt: '2026-09-11T16:00:00.000Z',
        author: 'ada',
        subject: 'fix: ensure ISO timezone preservation on date transforms',
        classification: 'Human-authored',
        filesChanged: 2,
        linesAdded: 30,
        linesDeleted: 15
      }
    ]
  },

  // PR 4: DEFRA/mmo-cr-copilot-backend #28 - Sonar proxy retry resilience
  {
    prNumber: 28,
    repository: 'DEFRA/mmo-cr-copilot-backend',
    sourceBranch: 'fix/sonar-proxy-cache',
    buildId: 'build-302',
    calculatedAt: '2026-09-13T15:10:00.000Z',
    prCreatedAt: '2026-09-12T13:00:00.000Z',
    firstCommitAt: '2026-09-12T13:40:00.000Z',
    lastCommitAt: '2026-09-13T14:50:00.000Z',
    prMergedAt: '2026-09-13T15:30:00.000Z',
    commits: [
      {
        commit: 'c9d0e1f',
        committedAt: '2026-09-12T13:40:00.000Z',
        author: 'eve',
        subject: 'feat: cache SonarCloud responses and handle 404 gracefully',
        classification: 'Copilot-assisted',
        filesChanged: 3,
        linesAdded: 140,
        linesDeleted: 20
      },
      {
        commit: 'd0e1f2a',
        committedAt: '2026-09-13T14:50:00.000Z',
        author: 'eve',
        subject: 'test: add unit tests for Sonar client anonymous fallback',
        classification: 'Copilot-assisted',
        filesChanged: 1,
        linesAdded: 85,
        linesDeleted: 5
      }
    ]
  },

  // PR 5: DEFRA/mmo-cr-internal-admin #45 - Batch export service
  {
    prNumber: 45,
    repository: 'DEFRA/mmo-cr-internal-admin',
    sourceBranch: 'feat/batch-export',
    buildId: 'build-401',
    calculatedAt: '2026-09-08T16:00:00.000Z',
    prCreatedAt: '2026-09-05T10:00:00.000Z',
    firstCommitAt: '2026-09-05T10:45:00.000Z',
    lastCommitAt: '2026-09-08T15:30:00.000Z',
    prMergedAt: '2026-09-08T16:30:00.000Z',
    commits: [
      {
        commit: 'e1f2a3b',
        committedAt: '2026-09-05T10:45:00.000Z',
        author: 'eve',
        subject: 'feat: add CSV stream exporter for landing reports',
        classification: 'Copilot-assisted',
        filesChanged: 5,
        linesAdded: 320,
        linesDeleted: 40
      },
      {
        commit: 'f2a3b4c',
        committedAt: '2026-09-06T14:15:00.000Z',
        author: 'bob',
        subject: 'feat: integrate S3 presigned URL download generation',
        classification: 'Copilot-assisted',
        filesChanged: 2,
        linesAdded: 120,
        linesDeleted: 15
      },
      {
        commit: 'a3b4c5d',
        committedAt: '2026-09-08T15:30:00.000Z',
        author: 'dana',
        subject: 'test: end-to-end audit verification tests',
        classification: 'Human-authored',
        filesChanged: 2,
        linesAdded: 75,
        linesDeleted: 8
      }
    ]
  },

  // PR 6: DEFRA/mmo-cr-reference-data #18 - Species code update
  {
    prNumber: 18,
    repository: 'DEFRA/mmo-cr-reference-data',
    sourceBranch: 'chore/species-codes-2026',
    buildId: 'build-501',
    calculatedAt: '2026-09-06T12:00:00.000Z',
    prCreatedAt: '2026-09-04T08:00:00.000Z',
    firstCommitAt: '2026-09-04T08:30:00.000Z',
    lastCommitAt: '2026-09-06T11:30:00.000Z',
    prMergedAt: '2026-09-06T12:30:00.000Z',
    commits: [
      {
        commit: 'b4c5d6e',
        committedAt: '2026-09-04T08:30:00.000Z',
        author: 'charlie',
        subject: 'chore: sync FAO species codes for North Sea fisheries',
        classification: 'Copilot-assisted',
        filesChanged: 3,
        linesAdded: 450,
        linesDeleted: 120
      },
      {
        commit: 'c5d6e7f',
        committedAt: '2026-09-06T11:30:00.000Z',
        author: 'charlie',
        subject: 'ci: update validation schema for species lookup tables',
        classification: 'Human-authored',
        filesChanged: 1,
        linesAdded: 35,
        linesDeleted: 10
      }
    ]
  },

  // Previous Sprint PR 7: DEFRA/mmo-cr-copilot-dashboard #9 (late August 2026)
  {
    prNumber: 9,
    repository: 'DEFRA/mmo-cr-copilot-dashboard',
    sourceBranch: 'feat/kpi-cards',
    buildId: 'build-190',
    calculatedAt: '2026-08-27T16:00:00.000Z',
    prCreatedAt: '2026-08-25T09:00:00.000Z',
    firstCommitAt: '2026-08-25T09:30:00.000Z',
    lastCommitAt: '2026-08-27T15:45:00.000Z',
    prMergedAt: '2026-08-27T16:30:00.000Z',
    commits: [
      {
        commit: 'd6e7f8a',
        committedAt: '2026-08-25T09:30:00.000Z',
        author: 'ada',
        subject: 'feat: KPI card metrics for Copilot adoption rate',
        classification: 'Copilot-assisted',
        filesChanged: 4,
        linesAdded: 280,
        linesDeleted: 30
      },
      {
        commit: 'e7f8a9b',
        committedAt: '2026-08-27T15:45:00.000Z',
        author: 'bob',
        subject: 'style: polish tooltip focus states and contrast',
        classification: 'Human-authored',
        filesChanged: 2,
        linesAdded: 50,
        linesDeleted: 15
      }
    ]
  }
]

async function seedData() {
  try {
    console.log(`Connecting to MongoDB at ${MONGO_URI}...`)
    await client.connect()
    const db = client.db(DATABASE_NAME)

    // 1. Seed persona mappings
    const personaCollection = db.collection('persona-mappings')
    console.log('Seeding persona mappings...')
    for (const mapping of PERSONA_MAPPINGS) {
      await personaCollection.updateOne(
        { _id: mapping.githubHandle.toLowerCase() },
        {
          $set: {
            githubHandle: mapping.githubHandle,
            persona: mapping.persona,
            updatedAt: new Date()
          }
        },
        { upsert: true }
      )
      console.log(
        `  - Set persona '${mapping.persona}' for handle '${mapping.githubHandle}'`
      )
    }

    // 2. Seed payloads
    const payloadCollection = db.collection('payloads')
    console.log('\nSeeding analytics payloads...')

    const documents = RAW_PAYLOADS.map(createPayload)

    const insertResult = await payloadCollection.insertMany(documents)
    console.log(
      `Successfully inserted ${insertResult.insertedCount} mock PR analytics payload(s).`
    )

    console.log('\nSummary of seeded repositories & PRs:')
    for (const p of RAW_PAYLOADS) {
      console.log(
        `  - ${p.repository} #${p.prNumber} (${p.commits.length} commits, calc: ${p.calculatedAt})`
      )
    }

    console.log('\nTo clear this mock data at any time, run:')
    console.log('  node scripts/clear-mock-data.js')
  } catch (error) {
    console.error('Error seeding data:', error)
    process.exitCode = 1
  } finally {
    await client.close()
  }
}

seedData()
