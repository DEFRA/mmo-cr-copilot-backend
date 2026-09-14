import { buildPayload } from '#/test-helpers/payload-fixture.js'

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

  beforeEach(async () => {
    await db.collection(service.PAYLOADS_COLLECTION).deleteMany({})
  })

  describe('#savePayload', () => {
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

    test('Should append rather than overwrite history for a PR', async () => {
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
      ).resolves.toBe(2)
    })

    test('Should backfill a missing sourceBranch from the previous message', async () => {
      await service.savePayload(db, buildPayload(), server.logger)

      const merged = buildPayload({
        buildId: 'build-1002',
        calculatedAt: '2026-01-16T10:00:00.000Z'
      })
      delete merged.sourceBranch

      const record = await service.savePayload(db, merged, server.logger)

      expect(record.sourceBranch).toBe('feature/charts')
    })

    test('Should warn and store without sourceBranch when there is no history', async () => {
      const warn = vi.spyOn(server.logger, 'warn')
      const payload = buildPayload()
      delete payload.sourceBranch

      const record = await service.savePayload(db, payload, server.logger)

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

  describe('#findLatestPayloads', () => {
    test('Should return the newest payload per repository and PR, newest first', async () => {
      await service.savePayload(db, buildPayload({ buildId: 'old' }))
      await service.savePayload(
        db,
        buildPayload({
          buildId: 'new',
          calculatedAt: '2026-01-16T10:00:00.000Z'
        })
      )
      await service.savePayload(
        db,
        buildPayload({
          prNumber: 43,
          buildId: 'other-pr',
          calculatedAt: '2026-01-17T10:00:00.000Z'
        })
      )

      const results = await service.findLatestPayloads(db)

      expect(results.map((payload) => payload.buildId)).toEqual([
        'other-pr',
        'new'
      ])
    })

    test('Should return ISO strings and strip storage internals', async () => {
      await service.savePayload(db, buildPayload())

      const [result] = await service.findLatestPayloads(db)

      expect(result.calculatedAt).toBe('2026-01-15T10:00:00.000Z')
      expect(result.commitBreakdown[0].committedAt).toBe(
        '2026-01-15T09:45:00.000Z'
      )
      expect(result).not.toHaveProperty('_id')
      expect(result).not.toHaveProperty('receivedAt')
    })

    test('Should return an empty array when nothing is stored', async () => {
      await expect(service.findLatestPayloads(db)).resolves.toEqual([])
    })
  })

  describe('#findPayloadHistory', () => {
    test('Should return every payload for a PR, newest first', async () => {
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

      expect(results.map((payload) => payload.buildId)).toEqual([
        'second',
        'first'
      ])
    })
  })

  describe('#findLatestPayloadForPr', () => {
    test('Should return null for an unknown PR', async () => {
      await expect(
        service.findLatestPayloadForPr(db, 'DEFRA/unknown', 1)
      ).resolves.toBeNull()
    })
  })
})
