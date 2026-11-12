import {
  JIRA_ISSUES,
  JIRA_SCENARIO_PAYLOAD_SPECS,
  JIRA_SPRINT_SCOPES,
  SONAR_CUTOFFS,
  buildPrJiraLinks,
  buildSonarSprintSnapshots
} from './jira-sonar.js'

const keys = new Set(JIRA_ISSUES.map((i) => i.key))
const window = (from, to) => ({
  from: `2026-${from}T00:00:00.000Z`,
  to: `2026-${to}T00:00:00.000Z`
})

describe('#mock data fixtures', () => {
  test('Should only reference seeded Jira issues', () => {
    for (const s of JIRA_SPRINT_SCOPES) {
      for (const key of s.issueKeys) {
        expect(keys).toContain(key)
      }
    }
    for (const spec of JIRA_SCENARIO_PAYLOAD_SPECS) {
      for (const key of spec.jiraKeys) {
        expect(keys).toContain(key)
      }
    }
    for (const issue of JIRA_ISSUES) {
      for (const link of issue.issueLinks) {
        expect(keys).toContain(link.key)
      }
    }
  })

  test('Should keep each issue history ordered and consistent', () => {
    for (const issue of JIRA_ISSUES) {
      const times = issue.statusHistory.map((h) => h.at.getTime())
      expect(times).toEqual([...times].sort((a, b) => a - b))
      if (issue.resolved) {
        expect(issue.firstDoneAt.getTime()).toBeLessThanOrEqual(
          issue.resolved.getTime()
        )
      }
    }
    expect(JIRA_ISSUES.find((i) => i.key === 'MMOCR-110').reopenCount).toBe(1)
  })

  test('Should freeze a different Sonar state at each sprint end', () => {
    const snaps = buildSonarSprintSnapshots([])
    const gatesAt = (cutoff) =>
      snaps
        .filter((s) => s.asOf.getTime() === cutoff.getTime())
        .map((s) => s.qualityGate)
    expect(gatesAt(SONAR_CUTOFFS[2])).toContain('failed')
    expect(gatesAt(SONAR_CUTOFFS[2])).toContain('warning')
    expect(gatesAt(SONAR_CUTOFFS[3])).not.toEqual(gatesAt(SONAR_CUTOFFS[4]))
  })

  test('Should derive one link per PR and ticket', () => {
    const links = buildPrJiraLinks(JIRA_SCENARIO_PAYLOAD_SPECS)
    expect(links.filter((l) => l.jiraKey === 'MMOCR-110')).toHaveLength(2)
    expect(links.some((l) => l.repository.endsWith('reference-data'))).toBe(
      false
    )
  })

  describe('When delivery metrics run over the seeded data', () => {
    let server
    let db
    let computeDeliveryMetrics
    let savedProjects

    beforeAll(async () => {
      // Dynamic imports: config must be read after vitest-mongodb sets MONGO_URI
      ;({ computeDeliveryMetrics } =
        await import('#/services/delivery-metrics.js'))
      const { createServer } = await import('#/server.js')
      server = await createServer()
      await server.initialize()
      db = server.db

      for (const name of [
        'jira-issues',
        'jira-sprint-scope',
        'payloads',
        'pr-jira-links',
        'sonar-pr-snapshots'
      ]) {
        await db.collection(name).deleteMany({})
      }
      // Metrics read only PR-referenced issues within the project's Jira keys.
      savedProjects = await db
        .collection('projects')
        .find({ slug: { $in: ['FES', 'CRAR'] } })
        .toArray()
      await db
        .collection('projects')
        .deleteMany({ slug: { $in: ['FES', 'CRAR'] } })
      await db.collection('projects').insertMany([
        { slug: 'FES', archivedAt: null, jira: { projectKeys: ['MMOCR'] } },
        { slug: 'CRAR', archivedAt: null, jira: { projectKeys: ['AGENT'] } }
      ])
      await db
        .collection('jira-issues')
        .insertMany(structuredClone(JIRA_ISSUES))
      await db
        .collection('jira-sprint-scope')
        .insertMany(structuredClone(JIRA_SPRINT_SCOPES))
      await db.collection('payloads').insertMany(
        JIRA_SCENARIO_PAYLOAD_SPECS.map((s) => ({
          repository: s.repository,
          prNumber: s.prNumber,
          projectSlug: s.projectSlug,
          jiraKeys: s.jiraKeys,
          calculatedAt: new Date(s.calculatedAt),
          prCreatedAt: new Date(s.prCreatedAt),
          firstCommitAt: new Date(s.firstCommitAt),
          lastCommitAt: new Date(s.lastCommitAt),
          ...(s.prMergedAt && { prMergedAt: new Date(s.prMergedAt) })
        }))
      )
      await db
        .collection('pr-jira-links')
        .insertMany(buildPrJiraLinks(JIRA_SCENARIO_PAYLOAD_SPECS))
      // Tickets the full seed links through its other payloads.
      await db.collection('pr-jira-links').insertMany(
        [
          'MMOCR-101',
          'MMOCR-102',
          'MMOCR-103',
          'MMOCR-104',
          'MMOCR-105',
          'MMOCR-106',
          'AGENT-201'
        ].map((jiraKey, i) => ({
          projectSlug: jiraKey.startsWith('AGENT') ? 'CRAR' : 'FES',
          jiraKey,
          repository: 'DEFRA/seed-history',
          prNumber: 500 + i,
          source: 'manual'
        }))
      )
    })

    afterAll(async () => {
      await db
        .collection('projects')
        .deleteMany({ slug: { $in: ['FES', 'CRAR'] } })
      if (savedProjects.length > 0) {
        await db.collection('projects').insertMany(savedProjects)
      }
      await server.stop({ timeout: 1000 })
    })

    test('Should show predictability, change fail and the open-PR warning in Sprint 7', async () => {
      const result = await computeDeliveryMetrics(
        db,
        'FES',
        window('09-30', '10-14')
      )

      expect(result.sprintPredictability).toBe(80)
      expect(result.changeFailRate).toBe(40)
      expect(result.failedTickets.sort()).toEqual(['MMOCR-105', 'MMOCR-110'])
      expect(result.warnings).toContainEqual({
        key: 'MMOCR-112',
        type: 'done-with-open-pr'
      })
      expect(result.reopenRate).toBeGreaterThan(0)
      // MMOCR-110 has two merged PRs; MMOCR-112's PR is open, so it adds none.
      expect(result.prsPerTicket).toBe(1)
      expect(result.flowEfficiency).not.toBeNull()
    })

    test('Should show defect recovery and predictability in Sprint 6', async () => {
      const result = await computeDeliveryMetrics(
        db,
        'FES',
        window('09-16', '09-30')
      )

      expect(result.sprintPredictability).toBe(75)
      expect(result.defectRecoveryTimeDays).toBe(2.2)
      expect(result.deliveryReworkRate).toBeGreaterThan(0)
    })

    test('Should cover the AI-Native project as well', async () => {
      const s7 = await computeDeliveryMetrics(
        db,
        'CRAR',
        window('09-30', '10-14')
      )

      expect(s7.sprintPredictability).toBe(100)
      expect(s7.changeFailRate).toBeGreaterThan(0)
    })
  })
})
