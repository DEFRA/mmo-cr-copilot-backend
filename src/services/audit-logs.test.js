describe('#audit-logs service', () => {
  let server
  let db
  let service

  const event = (overrides = {}) => ({
    action: 'persona-mapping.upserted',
    entity: 'persona-mapping',
    entityId: 'octocat',
    summary: "Role 'devops' assigned to 'octocat'",
    before: null,
    after: { persona: 'devops' },
    ...overrides
  })

  beforeAll(async () => {
    // Dynamic import needed due to config being updated by vitest-mongodb
    const { createServer } = await import('#/server.js')

    service = await import('./audit-logs.js')
    server = await createServer()
    await server.initialize()
    db = server.db
  })

  afterAll(async () => {
    await server.stop({ timeout: 1000 })
  })

  beforeEach(async () => {
    await db.collection(service.AUDIT_LOGS_COLLECTION).deleteMany({})
  })

  // Inserted directly so each entry gets a known timestamp to filter on.
  const at = (isoDate, overrides) =>
    db.collection(service.AUDIT_LOGS_COLLECTION).insertOne({
      ...event(overrides),
      actor: 'dashboard',
      occurredAt: new Date(isoDate)
    })

  describe('#recordAuditEvent', () => {
    test('Should persist the change with an actor and a timestamp', async () => {
      await service.recordAuditEvent(db, event())

      const stored = await db
        .collection(service.AUDIT_LOGS_COLLECTION)
        .findOne({})

      expect(stored).toMatchObject({
        action: 'persona-mapping.upserted',
        entityId: 'octocat',
        after: { persona: 'devops' },
        actor: 'dashboard'
      })
      expect(stored.occurredAt).toBeInstanceOf(Date)
    })

    test('Should log and swallow a write failure rather than fail the change', async () => {
      const logger = { error: vi.fn() }
      const brokenDb = {
        collection: () => ({
          insertOne: () => Promise.reject(new Error('mongo is down'))
        })
      }

      await expect(
        service.recordAuditEvent(brokenDb, event(), logger)
      ).resolves.toBeUndefined()
      expect(logger.error).toHaveBeenCalled()
    })
  })

  describe('#findAuditLogs', () => {
    test('Should return an empty first page when nothing is audited', async () => {
      await expect(service.findAuditLogs(db)).resolves.toEqual({
        entries: [],
        page: 1,
        pageSize: 25,
        total: 0,
        totalPages: 1
      })
    })

    test('Should return entries newest first with ISO timestamps', async () => {
      await at('2026-01-01T00:00:00.000Z', { entityId: 'oldest' })
      await at('2026-03-01T00:00:00.000Z', { entityId: 'newest' })

      const { entries, total } = await service.findAuditLogs(db)

      expect(total).toBe(2)
      expect(entries.map((e) => e.entityId)).toEqual(['newest', 'oldest'])
      expect(entries[0].occurredAt).toBe('2026-03-01T00:00:00.000Z')
      expect(entries[0].id).toEqual(expect.any(String))
    })

    test('Should page through the trail', async () => {
      await at('2026-01-01T00:00:00.000Z', { entityId: 'a' })
      await at('2026-01-02T00:00:00.000Z', { entityId: 'b' })
      await at('2026-01-03T00:00:00.000Z', { entityId: 'c' })

      const first = await service.findAuditLogs(db, { page: 1, pageSize: 2 })
      const second = await service.findAuditLogs(db, { page: 2, pageSize: 2 })

      expect(first.entries.map((e) => e.entityId)).toEqual(['c', 'b'])
      expect(first.totalPages).toBe(2)
      expect(second.entries.map((e) => e.entityId)).toEqual(['a'])
    })

    test('Should clamp a page beyond the end rather than return nothing', async () => {
      await at('2026-01-01T00:00:00.000Z', { entityId: 'only' })

      const { entries, page } = await service.findAuditLogs(db, {
        page: 99,
        pageSize: 10
      })

      expect(page).toBe(1)
      expect(entries).toHaveLength(1)
    })

    test('Should apply the half-open [from, to) window', async () => {
      await at('2026-01-01T00:00:00.000Z', { entityId: 'before' })
      await at('2026-02-01T00:00:00.000Z', { entityId: 'inside' })
      await at('2026-03-01T00:00:00.000Z', { entityId: 'on-the-end-bound' })

      const { entries } = await service.findAuditLogs(db, {
        from: new Date('2026-02-01T00:00:00.000Z'),
        to: new Date('2026-03-01T00:00:00.000Z')
      })

      expect(entries.map((e) => e.entityId)).toEqual(['inside'])
    })
  })
})
