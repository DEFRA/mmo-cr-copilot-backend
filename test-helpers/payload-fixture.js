/**
 * Builds a valid analytics payload. Pass overrides to exercise edge cases
 * without restating the whole (large) shape in every test.
 */
export function buildPayload(overrides = {}) {
  return {
    prNumber: 42,
    repository: 'DEFRA/mmo-cr-copilot-dashboard',
    sourceBranch: 'feature/charts',
    targetBranch: 'main',
    buildId: 'build-1001',
    calculatedAt: '2026-01-15T10:00:00.000Z',
    prCreatedAt: '2026-01-12T09:00:00.000Z',
    firstCommitAt: '2026-01-12T09:30:00.000Z',
    lastCommitAt: '2026-01-15T09:45:00.000Z',
    prMergedAt: '2026-01-15T10:15:00.000Z',
    summary: {
      totalCommits: 4,
      copilotAssistedCommits: 3,
      humanAuthoredCommits: 1,
      copilotAssistedRate: 75,
      totalLinesTouched: 400,
      copilotAssistedLines: 300,
      humanAuthoredLines: 100,
      copilotAssistedLineRate: 75
    },
    contributorBreakdown: [
      {
        contributor: 'ada',
        totalCommits: 4,
        copilotAssisted: 3,
        humanAuthored: 1,
        linesAdded: 320,
        linesDeleted: 80,
        linesTouched: 400,
        netLines: 240,
        copilotAssistedLines: 300,
        humanAuthoredLines: 100
      }
    ],
    commitBreakdown: [
      {
        commit: 'abc1234',
        committedAt: '2026-01-15T09:45:00.000Z',
        author: 'ada',
        subject: 'Add cycle time scatter',
        classification: 'Copilot-assisted',
        filesChanged: 3,
        linesAdded: 220,
        linesDeleted: 20,
        linesTouched: 240,
        netLines: 200
      }
    ],
    ...overrides
  }
}

export function buildAttribution(overrides = {}) {
  return { source: 'legacy-trailer', ...overrides }
}

/** A valid contract v2 payload; `buildPayload` stays the v1 shape. */
export function buildPayloadV2(overrides = {}) {
  const base = buildPayload()

  return {
    ...base,
    schemaVersion: 2,
    source: 'live',
    prTitle: 'MMO-123 Add cycle time scatter',
    jiraKeys: ['MMO-123'],
    files: {
      changed: 3,
      linesTouched: 180,
      testFilesChanged: 1,
      testLinesTouched: 40,
      modulesTouched: 2,
      excluded: { filesChanged: 1, linesTouched: 20 }
    },
    commitBreakdown: base.commitBreakdown.map((commit) => ({
      ...commit,
      attribution: buildAttribution()
    })),
    ...overrides
  }
}
