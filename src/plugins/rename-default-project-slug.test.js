const LEGACY = {
  slug: 'FES',
  name: 'MMO Catch Recording',
  type: 'ai-adopted',
  adoptionStartDate: new Date('2026-01-01T00:00:00.000Z'),
  jira: { projectKeys: ['MMOCR'] }
}
const REPO = 'DEFRA/mmo-cr-ios'
const SLUG_COLLECTIONS = [
  'repositories',
  'payloads',
  'jira-issues',
  'jira-sprint-scope',
  'pr-jira-links',
  'ai_survival'
]
const RESET = [
  'projects',
  'role_mappings',
  'persona-mappings',
  'audit-logs',
  ...SLUG_COLLECTIONS
]

describe('#renameDefaultProjectSlug', () => {
  let server
  let db
  let renameDefaultProjectSlug

  const count = (name, filter) => db.collection(name).countDocuments(filter)

  async function seedLegacyDatabase() {
    await db.collection('projects').insertOne({ ...LEGACY })
    await db
      .collection('repositories')
      .insertOne({ fullName: REPO, projectSlug: 'FES' })
    await db
      .collection('payloads')
      .insertOne({ repository: REPO, prNumber: 1, projectSlug: 'FES' })
    await db
      .collection('jira-issues')
      .insertOne({ key: 'MMOCR-1', projectSlug: 'FES' })
    await db
      .collection('jira-sprint-scope')
      .insertOne({ sprintId: 1, projectSlug: 'FES' })
    await db.collection('pr-jira-links').insertOne({
      projectSlug: 'FES',
      jiraKey: 'MMOCR-1',
      repository: REPO,
      prNumber: 1
    })
    await db.collection('ai_survival').insertOne({
      repository: REPO,
      prNumber: 1,
      windowDays: 21,
      projectSlug: 'FES'
    })
    await db.collection('persona-mappings').insertOne({
      _id: 'FES:octocat',
      githubHandle: 'octocat',
      persona: 'developer',
      projectSlug: 'FES'
    })
    await db.collection('role_mappings').insertMany([
      {
        groupName: 'AG-Users-CopilotAnalytics-CR-Leads',
        role: 'project-admin',
        scope: 'project',
        projectSlug: 'FES'
      },
      {
        groupName: 'AG-Users-CopilotAnalytics-FES-Admin',
        role: 'project-admin',
        scope: 'project',
        projectSlug: 'FES'
      }
    ])
    await db.collection('audit-logs').insertOne({
      action: 'project.created',
      projectSlug: 'FES',
      occurredAt: new Date()
    })
  }

  beforeAll(async () => {
    // Dynamic imports: config must be read after vitest-mongodb sets MONGO_URI.
    const { createServer } = await import('#/server.js')
    ;({ renameDefaultProjectSlug } =
      await import('./rename-default-project-slug.js'))
    server = await createServer()
    await server.initialize()
    db = server.db
  })

  beforeEach(async () => {
    for (const name of RESET) await db.collection(name).deleteMany({})
  })

  afterAll(async () => {
    for (const name of RESET) await db.collection(name).deleteMany({})
    await server.stop({ timeout: 1000 })
  })

  describe('When the default project is still FES', () => {
    beforeEach(async () => {
      await seedLegacyDatabase()
      expect(await renameDefaultProjectSlug(db)).toBe(true)
    })

    test('Should rename the project and every record that refers to it', async () => {
      const project = await db.collection('projects').findOne({ slug: 'CRAR' })
      expect(project.name).toBe('MMO Catch Recording')
      expect(await count('projects', { slug: 'FES' })).toBe(0)

      for (const name of SLUG_COLLECTIONS) {
        expect(await count(name, { projectSlug: 'FES' })).toBe(0)
        expect(await count(name, { projectSlug: 'CRAR' })).toBe(1)
      }
    })

    test('Should make the project AI-Native with no adoption date', async () => {
      const project = await db.collection('projects').findOne({ slug: 'CRAR' })

      expect(project).toMatchObject({
        type: 'ai-native',
        adoptionStartDate: null,
        jira: { projectKeys: ['MMOCR'] }
      })
    })

    test('Should move persona mappings to the key of the new slug', async () => {
      const personas = await db.collection('persona-mappings').find().toArray()

      expect(personas).toEqual([
        expect.objectContaining({ _id: 'CRAR:octocat', projectSlug: 'CRAR' })
      ])
    })

    test('Should move CR role mappings, keep FES groups on FES and add the CRAR groups', async () => {
      const mappings = await db
        .collection('role_mappings')
        .find(
          {},
          { projection: { _id: 0, groupName: 1, projectSlug: 1, role: 1 } }
        )
        .sort({ groupName: 1 })
        .toArray()

      expect(mappings).toEqual([
        {
          groupName: 'AG-Users-CopilotAnalytics-CR-Leads',
          role: 'project-admin',
          projectSlug: 'CRAR'
        },
        {
          groupName: 'AG-Users-CopilotAnalytics-CRAR-Admin',
          role: 'project-admin',
          projectSlug: 'CRAR'
        },
        {
          groupName: 'AG-Users-CopilotAnalytics-CRAR-Reader',
          role: 'project-user',
          projectSlug: 'CRAR'
        },
        {
          groupName: 'AG-Users-CopilotAnalytics-FES-Admin',
          role: 'project-admin',
          projectSlug: 'FES'
        }
      ])
    })

    test('Should keep existing audit entries and record the rename', async () => {
      expect(
        await count('audit-logs', {
          action: 'project.created',
          projectSlug: 'FES'
        })
      ).toBe(1)
      expect(
        await count('audit-logs', {
          action: 'project.updated',
          projectSlug: 'CRAR'
        })
      ).toBe(2)
      expect(
        await count('audit-logs', {
          action: 'role-mapping.migrated',
          projectSlug: 'CRAR'
        })
      ).toBe(1)
    })

    test('Should do nothing on a second run', async () => {
      expect(await renameDefaultProjectSlug(db)).toBe(false)
      expect(await count('role_mappings', { projectSlug: 'CRAR' })).toBe(3)
      expect(await count('audit-logs', { action: 'project.updated' })).toBe(2)
    })
  })

  describe('When an earlier build already renamed the project', () => {
    beforeEach(async () => {
      await db.collection('projects').insertOne({ ...LEGACY, slug: 'CRAR' })
    })

    test('Should make it AI-Native with no adoption date', async () => {
      expect(await renameDefaultProjectSlug(db)).toBe(true)

      const project = await db.collection('projects').findOne({ slug: 'CRAR' })
      expect(project).toMatchObject({
        type: 'ai-native',
        adoptionStartDate: null
      })
      expect(
        await db
          .collection('audit-logs')
          .findOne({ action: 'project.updated', projectSlug: 'CRAR' })
      ).toMatchObject({
        before: { type: 'ai-adopted' },
        after: { type: 'ai-native' }
      })
    })

    test('Should do nothing once it is AI-Native', async () => {
      await renameDefaultProjectSlug(db)

      expect(await renameDefaultProjectSlug(db)).toBe(false)
      expect(await count('audit-logs', { action: 'project.updated' })).toBe(1)
    })
  })

  test('Should leave a CRAR project without the CR Jira key alone', async () => {
    await db.collection('projects').insertOne({
      slug: 'CRAR',
      type: 'ai-adopted',
      jira: { projectKeys: ['OTHER'] }
    })

    expect(await renameDefaultProjectSlug(db)).toBe(false)
    expect(
      await db.collection('projects').findOne({ slug: 'CRAR' })
    ).toMatchObject({ type: 'ai-adopted' })
  })

  test('Should finish a rename that stopped before the project was renamed', async () => {
    await seedLegacyDatabase()
    await db
      .collection('repositories')
      .updateMany({}, { $set: { projectSlug: 'CRAR' } })
    await db.collection('role_mappings').insertOne({
      groupName: 'AG-Users-CopilotAnalytics-CRAR-Admin',
      role: 'project-admin',
      scope: 'project',
      projectSlug: 'CRAR'
    })

    expect(await renameDefaultProjectSlug(db)).toBe(true)
    expect(await count('projects', { slug: 'CRAR' })).toBe(1)
    expect(await count('payloads', { projectSlug: 'CRAR' })).toBe(1)
    expect(
      await count('role_mappings', {
        groupName: 'AG-Users-CopilotAnalytics-CRAR-Admin'
      })
    ).toBe(1)
  })

  test('Should leave a genuine FES project alone', async () => {
    await db.collection('projects').insertOne({
      slug: 'FES',
      name: 'FES',
      jira: { projectKeys: ['FI0'] }
    })

    expect(await renameDefaultProjectSlug(db)).toBe(false)
    expect(await count('projects', { slug: 'FES' })).toBe(1)
  })

  test('Should not rename when a CRAR project already exists', async () => {
    await seedLegacyDatabase()
    await db.collection('projects').insertOne({ slug: 'CRAR', name: 'Other' })
    const logger = { warn: vi.fn(), info: vi.fn(), error: vi.fn() }

    expect(await renameDefaultProjectSlug(db, logger)).toBe(false)
    expect(await count('payloads', { projectSlug: 'FES' })).toBe(1)
    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringContaining('CRAR already exists')
    )
  })
})
