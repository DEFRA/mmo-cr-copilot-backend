import {
  buildAttribution,
  buildPayload,
  buildPayloadV2
} from '#/test-helpers/payload-fixture.js'

describe('#payloads service', () => {
  let server
  let db
  let service

  beforeAll(async () => {
    // Dynamic import needed due to config being updated by vitest-mongodb
    const { createServer } = await import('#/server.js')

    service = await import('./payloads.js')
    server = await createServer()
    await server.initialize()
    db = server.db
  })

  afterAll(async () => {
    await server.stop({ timeout: 1000 })
  })

  const latestPayloads = async (database) =>
    (
      await database
        .collection(service.PAYLOADS_COLLECTION)
        .find({})
        .sort({ calculatedAt: -1 })
        .toArray()
    ).map(service.toPayload)

  beforeEach(async () => {
    await db.collection(service.PAYLOADS_COLLECTION).deleteMany({})
  })

  describe('#savePayload', () => {
    test('Should skip a backfill when a live merged payload exists', async () => {
      await service.savePayload(db, buildPayloadV2(), server.logger)

      const result = await service.savePayload(
        db,
        buildPayloadV2({
          source: 'backfill',
          calculatedAt: '2026-02-01T00:00:00.000Z',
          prTitle: 'Backfilled'
        }),
        server.logger
      )

      expect(result.stored).toBe(false)
      const stored = await db
        .collection(service.PAYLOADS_COLLECTION)
        .findOne({})
      expect(stored.prTitle).toBe('MMO-123 Add cycle time scatter')
    })

    test('Should store a backfill when no live payload exists', async () => {
      const result = await service.savePayload(
        db,
        buildPayloadV2({ source: 'backfill' }),
        server.logger
      )

      expect(result.stored).toBe(true)
    })
    test('Should link the PR to its Jira keys when the repository is mapped', async () => {
      const { PR_JIRA_LINKS_COLLECTION, findPrLinks } =
        await import('./pr-jira-links.js')
      await db.collection('repositories').deleteMany({})
      await db.collection(PR_JIRA_LINKS_COLLECTION).deleteMany({})
      await db.collection('repositories').insertOne({
        fullName: 'DEFRA/mmo-cr-copilot-dashboard',
        projectSlug: 'mmo'
      })

      const result = await service.savePayload(
        db,
        buildPayloadV2(),
        server.logger
      )

      expect(result.projectSlug).toBe('mmo')
      await expect(
        findPrLinks(db, {
          projectSlug: 'mmo',
          repository: 'DEFRA/mmo-cr-copilot-dashboard',
          prNumber: 42
        })
      ).resolves.toEqual([{ jiraKey: 'MMO-123', source: 'payload' }])
      await db.collection('repositories').deleteMany({})
    })

    test('Should store dates as BSON dates so they sort chronologically', async () => {
      await service.savePayload(db, buildPayload(), server.logger)

      const stored = await db
        .collection(service.PAYLOADS_COLLECTION)
        .findOne({})

      expect(stored.calculatedAt).toBeInstanceOf(Date)
      expect(stored.commitBreakdown[0].committedAt).toBeInstanceOf(Date)
      expect(stored.receivedAt).toBeInstanceOf(Date)
    })

    test('Should omit optional dates that were not provided', async () => {
      const payload = buildPayload()
      delete payload.prMergedAt

      await service.savePayload(db, payload, server.logger)
      const stored = await db
        .collection(service.PAYLOADS_COLLECTION)
        .findOne({})

      expect(stored).not.toHaveProperty('prMergedAt')
    })

    test('Should keep one record per PR, replacing it when newer data arrives', async () => {
      await service.savePayload(db, buildPayload(), server.logger)
      await service.savePayload(
        db,
        buildPayload({
          buildId: 'build-1002',
          calculatedAt: '2026-01-16T10:00:00.000Z'
        }),
        server.logger
      )

      await expect(
        db.collection(service.PAYLOADS_COLLECTION).countDocuments()
      ).resolves.toBe(1)

      const stored = await db
        .collection(service.PAYLOADS_COLLECTION)
        .findOne({})

      expect(stored.buildId).toBe('build-1002')
      expect(stored.updateCount).toBe(2)
    })

    test('Should ignore a payload older than the stored record', async () => {
      await service.savePayload(
        db,
        buildPayload({
          buildId: 'merged',
          calculatedAt: '2026-01-16T10:00:00.000Z'
        }),
        server.logger
      )

      const result = await service.savePayload(
        db,
        buildPayload({
          buildId: 'late-pre-merge',
          calculatedAt: '2026-01-15T10:00:00.000Z'
        }),
        server.logger
      )

      expect(result.stored).toBe(false)

      const stored = await db
        .collection(service.PAYLOADS_COLLECTION)
        .findOne({})

      expect(stored.buildId).toBe('merged')
    })

    test('Should be idempotent when the same payload is delivered twice', async () => {
      const payload = buildPayload()

      const first = await service.savePayload(db, payload, server.logger)
      const second = await service.savePayload(db, payload, server.logger)

      expect(first.stored).toBe(true)
      expect(second.stored).toBe(false)
      await expect(
        db.collection(service.PAYLOADS_COLLECTION).countDocuments()
      ).resolves.toBe(1)
    })

    test('Should backfill a missing sourceBranch from the previous message', async () => {
      await service.savePayload(db, buildPayload(), server.logger)

      const merged = buildPayload({
        buildId: 'build-1002',
        calculatedAt: '2026-01-16T10:00:00.000Z'
      })
      delete merged.sourceBranch

      const { record } = await service.savePayload(db, merged, server.logger)

      expect(record.sourceBranch).toBe('feature/charts')
    })

    test('Should warn and store without sourceBranch when there is no history', async () => {
      const warn = vi.spyOn(server.logger, 'warn')
      const payload = buildPayload()
      delete payload.sourceBranch

      const { record } = await service.savePayload(db, payload, server.logger)

      expect(record.sourceBranch).toBeUndefined()
      expect(warn).toHaveBeenCalledWith(
        expect.stringContaining('no previous message was found')
      )
    })

    test('Should not require a logger', async () => {
      await expect(
        service.savePayload(db, buildPayload())
      ).resolves.toBeDefined()
    })
  })

  describe('When payloads use contract v2', () => {
    test('Should round-trip every v2 field', async () => {
      const payload = buildPayloadV2()
      await service.savePayload(db, payload, server.logger)

      const [result] = await latestPayloads(db)

      expect(result).toMatchObject({
        schemaVersion: 2,
        source: 'live',
        prTitle: payload.prTitle,
        jiraKeys: payload.jiraKeys,
        files: payload.files
      })
      expect(result.commitBreakdown[0].attribution).toEqual(buildAttribution())
    })

    test('Should read a stored v1 document as v1 without inventing v2 fields', async () => {
      const doc = buildPayload()
      await db.collection(service.PAYLOADS_COLLECTION).insertOne({
        ...doc,
        calculatedAt: new Date(doc.calculatedAt)
      })

      const [result] = await latestPayloads(db)

      expect(result.schemaVersion).toBe(1)
      expect(result).not.toHaveProperty('jiraKeys')
      expect(result).not.toHaveProperty('files')
      expect(result).not.toHaveProperty('source')
      expect(result).not.toHaveProperty('prTitle')
      expect(result.commitBreakdown[0]).not.toHaveProperty('attribution')
    })

    test('Should replace a stored v1 record with a newer v2 payload', async () => {
      await service.savePayload(db, buildPayload(), server.logger)
      await service.savePayload(
        db,
        buildPayloadV2({ calculatedAt: '2026-01-16T10:00:00.000Z' }),
        server.logger
      )

      const [result] = await latestPayloads(db)

      expect(result.schemaVersion).toBe(2)
      expect(result.jiraKeys).toEqual(['MMO-123'])
    })
  })

  describe('#findPayloadHistory', () => {
    test('Should return the current record for a PR and ignore other PRs', async () => {
      await service.savePayload(db, buildPayload({ buildId: 'first' }))
      await service.savePayload(
        db,
        buildPayload({
          buildId: 'second',
          calculatedAt: '2026-01-16T10:00:00.000Z'
        })
      )
      await service.savePayload(
        db,
        buildPayload({ prNumber: 99, buildId: 'other' })
      )

      const results = await service.findPayloadHistory(
        db,
        'DEFRA/mmo-cr-copilot-dashboard',
        42
      )

      expect(results.map((payload) => payload.buildId)).toEqual(['second'])
    })
  })

  describe('#findLatestPayloadForPr', () => {
    test('Should return null for an unknown PR', async () => {
      await expect(
        service.findLatestPayloadForPr(db, 'DEFRA/unknown', 1)
      ).resolves.toBeNull()
    })
  })

  describe('#updateCommitClassification', () => {
    const REPOSITORY = 'DEFRA/mmo-cr-copilot-dashboard'

    const twoCommitPayload = (overrides = {}) =>
      buildPayload({
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
          },
          {
            commit: 'def5678',
            committedAt: '2026-01-15T09:50:00.000Z',
            author: 'bob',
            subject: 'Fix axis labels',
            classification: 'Human-authored',
            filesChanged: 1,
            linesAdded: 40,
            linesDeleted: 20,
            linesTouched: 60,
            netLines: 20
          }
        ],
        ...overrides
      })

    const update = (overrides = {}) =>
      service.updateCommitClassification(db, {
        repository: REPOSITORY,
        prNumber: 42,
        commit: 'def5678',
        classification: 'Copilot-assisted',
        ...overrides
      })

    test('Should report an unknown pull request', async () => {
      await expect(update({ prNumber: 999 })).resolves.toEqual({
        status: 'pr-not-found'
      })
    })

    test('Should refuse to change a pull request that is not merged', async () => {
      const payload = twoCommitPayload()
      delete payload.prMergedAt
      await service.savePayload(db, payload, server.logger)

      await expect(update()).resolves.toEqual({ status: 'pr-not-merged' })
    })

    test('Should report an unknown commit', async () => {
      await service.savePayload(db, twoCommitPayload(), server.logger)

      await expect(update({ commit: 'ffffff0' })).resolves.toEqual({
        status: 'commit-not-found'
      })
    })

    test('Should report no change when the classification already matches', async () => {
      await service.savePayload(db, twoCommitPayload(), server.logger)

      const { status } = await update({ classification: 'Human-authored' })

      expect(status).toBe('unchanged')
    })

    test('Should re-classify the commit and rebuild the summary', async () => {
      await service.savePayload(db, twoCommitPayload(), server.logger)

      const { status, previousClassification, payload } = await update()

      expect(status).toBe('updated')
      expect(previousClassification).toBe('Human-authored')
      expect(payload.summary).toMatchObject({
        totalCommits: 2,
        copilotAssistedCommits: 2,
        humanAuthoredCommits: 0,
        copilotAssistedRate: 100,
        totalLinesTouched: 300,
        copilotAssistedLines: 300,
        humanAuthoredLines: 0,
        copilotAssistedLineRate: 100
      })
    })

    test('Should rebuild the contributor breakdown around the change', async () => {
      await service.savePayload(db, twoCommitPayload(), server.logger)

      const { payload } = await update()
      const bob = payload.contributorBreakdown.find(
        (c) => c.contributor === 'bob'
      )

      expect(bob).toMatchObject({
        totalCommits: 1,
        copilotAssisted: 1,
        humanAuthored: 0,
        copilotAssistedLines: 60,
        humanAuthoredLines: 0
      })
    })

    test('Should exclude a commit re-classified as Rebase from every total', async () => {
      await service.savePayload(db, twoCommitPayload(), server.logger)

      const { payload } = await update({ classification: 'Rebase' })

      expect(payload.summary).toMatchObject({
        totalCommits: 1,
        totalLinesTouched: 240,
        excludedCommits: 1,
        rebaseCommits: 1,
        dependabotCommits: 0
      })
      expect(payload.contributorBreakdown.map((c) => c.contributor)).toEqual([
        'ada'
      ])
    })

    test('Should not expose the override bookkeeping in the returned payload', async () => {
      await service.savePayload(db, twoCommitPayload(), server.logger)

      const { payload } = await update()

      expect(payload).not.toHaveProperty('classificationOverrides')
    })

    test('Should re-apply the correction when the producer sends the PR again', async () => {
      await service.savePayload(db, twoCommitPayload(), server.logger)
      await update()

      await service.savePayload(
        db,
        twoCommitPayload({
          buildId: 'build-1002',
          calculatedAt: '2026-01-16T10:00:00.000Z'
        }),
        server.logger
      )

      const stored = await service.findLatestPayloadForPr(db, REPOSITORY, 42)
      const commit = stored.commitBreakdown.find((c) => c.commit === 'def5678')

      expect(commit.classification).toBe('Copilot-assisted')
      expect(stored.summary.copilotAssistedCommits).toBe(2)
    })

    describe('When the payload carries attribution', () => {
      const withAttribution = (overrides = {}) => {
        const payload = twoCommitPayload(overrides)
        return buildPayloadV2({
          ...payload,
          commitBreakdown: payload.commitBreakdown.map((commit) => ({
            ...commit,
            attribution: buildAttribution({ source: 'none' })
          }))
        })
      }

      test('Should keep attribution when a commit is re-classified', async () => {
        await service.savePayload(db, withAttribution(), server.logger)

        const { payload } = await update()
        const commit = payload.commitBreakdown.find(
          (c) => c.commit === 'def5678'
        )

        expect(commit.classification).toBe('Copilot-assisted')
        expect(commit.attribution).toEqual({ source: 'none' })
      })

      test('Should keep attribution when a correction is re-applied on ingest', async () => {
        await service.savePayload(db, withAttribution(), server.logger)
        await update()

        await service.savePayload(
          db,
          withAttribution({
            buildId: 'build-1002',
            calculatedAt: '2026-01-16T10:00:00.000Z'
          }),
          server.logger
        )

        const stored = await service.findLatestPayloadForPr(db, REPOSITORY, 42)
        const commit = stored.commitBreakdown.find(
          (c) => c.commit === 'def5678'
        )

        expect(commit.classification).toBe('Copilot-assisted')
        expect(commit.attribution).toEqual({ source: 'none' })
      })
    })
  })
})
