import { Collection } from 'mongodb'

import { PAYLOADS_COLLECTION } from '#/services/payloads.js'

describe('#projects service', () => {
  let server
  let db
  let service

  beforeAll(async () => {
    const { createServer } = await import('#/server.js')

    service = await import('./projects.js')
    server = await createServer()
    await server.initialize()
    db = server.db
  })

  afterAll(async () => {
    await server.stop({ timeout: 1000 })
  })

  beforeEach(async () => {
    await db.collection(service.PROJECTS_COLLECTION).deleteMany({})
    await db.collection(service.REPOSITORIES_COLLECTION).deleteMany({})
    await db.collection(PAYLOADS_COLLECTION).deleteMany({})
  })

  describe('#createProject and #findProject', () => {
    test('Should create and retrieve a project with ISO dates', async () => {
      const projectData = {
        slug: 'test-project',
        name: 'Test Project',
        type: 'ai-adopted',
        adoptionStartDate: '2026-01-01T00:00:00.000Z',
        sprintCalendar: {
          cadenceDays: 14,
          anchorDate: '2026-07-08T00:00:00.000Z'
        },
        jira: {
          projectKeys: ['TEST'],
          storyPointsField: 'customfield_10016'
        }
      }

      const created = await service.createProject(db, projectData)
      expect(created).toMatchObject({
        slug: 'test-project',
        name: 'Test Project',
        type: 'ai-adopted',
        adoptionStartDate: '2026-01-01T00:00:00.000Z'
      })
      expect(created.createdAt).toBeDefined()
      expect(created.updatedAt).toBeDefined()
      expect(created.archivedAt == null).toBe(true)

      const found = await service.findProject(db, 'test-project')
      expect(found).toEqual(created)
    })

    test('Should return null when project does not exist', async () => {
      const found = await service.findProject(db, 'non-existent')
      expect(found).toBeNull()
    })

    test('Should turn a duplicate slug from a concurrent create into a conflict', async () => {
      await service.createProject(db, { slug: 'DUPE', name: 'First' })

      await expect(
        service.createProject(db, { slug: 'DUPE', name: 'Second' })
      ).rejects.toMatchObject({
        output: {
          statusCode: 409,
          payload: { message: 'That project slug is already in use' }
        }
      })
    })

    test('Should rethrow any other create failure', async () => {
      vi.spyOn(Collection.prototype, 'insertOne').mockRejectedValueOnce(
        new Error('connection lost')
      )

      await expect(
        service.createProject(db, { slug: 'FAIL', name: 'Fail' })
      ).rejects.toThrow('connection lost')
      vi.restoreAllMocks()
    })
  })

  describe('#listProjects', () => {
    test('Should return active projects sorted by name', async () => {
      await service.createProject(db, {
        slug: 'zeta-project',
        name: 'Zeta Project',
        type: 'ai-native'
      })
      await service.createProject(db, {
        slug: 'alpha-project',
        name: 'Alpha Project',
        type: 'ai-native'
      })
      await service.createProject(db, {
        slug: 'archived-project',
        name: 'Archived Project',
        type: 'ai-native'
      })
      await service.deleteProject(db, 'archived-project')

      const projects = await service.listProjects(db)
      expect(projects.map((p) => p.slug)).toEqual([
        'alpha-project',
        'zeta-project'
      ])
    })
  })

  describe('#updateProject', () => {
    test('Should update project fields and updatedAt timestamp', async () => {
      await service.createProject(db, {
        slug: 'update-project',
        name: 'Initial Name',
        type: 'ai-native'
      })

      const updated = await service.updateProject(db, 'update-project', {
        name: 'Updated Name',
        adoptionStartDate: '2026-02-01T00:00:00.000Z'
      })

      expect(updated.name).toBe('Updated Name')
      expect(updated.adoptionStartDate).toBe('2026-02-01T00:00:00.000Z')

      const updatedNullDate = await service.updateProject(
        db,
        'update-project',
        { adoptionStartDate: null }
      )
      expect(updatedNullDate.adoptionStartDate == null).toBe(true)
    })

    test('Should return null when updating non-existent project', async () => {
      const result = await service.updateProject(db, 'missing', {
        name: 'New'
      })
      expect(result).toBeNull()
    })

    test('Should update Jira fields one by one and keep the rest', async () => {
      const lastSyncedAt = new Date('2026-10-01T09:00:00.000Z')
      await db.collection(service.PROJECTS_COLLECTION).insertOne({
        slug: 'JIRA',
        jira: {
          projectKeys: [],
          storyPointsField: 'customfield_1',
          lastSyncedAt
        }
      })

      const updated = await service.updateProject(db, 'JIRA', {
        jira: { projectKeys: ['NEW'] }
      })

      expect(updated.jira).toEqual({
        projectKeys: ['NEW'],
        storyPointsField: 'customfield_1',
        lastSyncedAt
      })
    })

    test('Should refuse a first Jira key once another write has set one', async () => {
      await db.collection(service.PROJECTS_COLLECTION).insertOne({
        slug: 'RACE',
        name: 'Race',
        jira: { projectKeys: ['WON'] }
      })

      await expect(
        service.updateProject(db, 'RACE', {
          name: 'Lost',
          jira: { projectKeys: ['LOST'] }
        })
      ).rejects.toMatchObject({
        output: {
          statusCode: 400,
          payload: { message: 'The Jira project key cannot be changed' }
        }
      })
      const stored = await db
        .collection(service.PROJECTS_COLLECTION)
        .findOne({ slug: 'RACE' })
      expect(stored).toMatchObject({
        name: 'Race',
        jira: { projectKeys: ['WON'] }
      })
    })

    test('Should return null for a missing project when Jira keys are sent', async () => {
      await expect(
        service.updateProject(db, 'GONE', { jira: { projectKeys: ['KEY'] } })
      ).resolves.toBeNull()
    })

    test('Should set Jira fields on a project whose jira is null', async () => {
      await db
        .collection(service.PROJECTS_COLLECTION)
        .insertOne({ slug: 'NULJ', jira: null })

      const updated = await service.updateProject(db, 'NULJ', {
        jira: { projectKeys: ['KEY'] }
      })

      expect(updated.jira).toEqual({ projectKeys: ['KEY'] })
    })
  })

  describe('#deleteProject', () => {
    test('Should soft-delete project setting archivedAt', async () => {
      await service.createProject(db, {
        slug: 'to-delete',
        name: 'To Delete',
        type: 'ai-native'
      })

      const deleted = await service.deleteProject(db, 'to-delete')
      expect(deleted.archivedAt).toBeDefined()

      const activeProjects = await service.listProjects(db)
      expect(activeProjects).toHaveLength(0)
    })

    test('Should return null when deleting non-existent project', async () => {
      const result = await service.deleteProject(db, 'missing')
      expect(result).toBeNull()
    })
  })

  describe('Repository mapping methods', () => {
    test('Should map repository and stamp matching payloads', async () => {
      await db.collection(PAYLOADS_COLLECTION).insertOne({
        repository: 'DEFRA/test-repo',
        prNumber: 1,
        calculatedAt: new Date('2026-01-01T00:00:00.000Z'),
        commitBreakdown: []
      })

      const repo = await service.mapRepository(db, {
        fullName: 'DEFRA/test-repo',
        projectSlug: 'test-project',
        mappedBy: 'admin'
      })

      expect(repo).toMatchObject({
        fullName: 'DEFRA/test-repo',
        projectSlug: 'test-project',
        mappedBy: 'admin'
      })
      expect(repo.sonarProjectKey).toBeUndefined()
      expect(repo.mappedAt).toBeDefined()

      const payload = await db
        .collection(PAYLOADS_COLLECTION)
        .findOne({ repository: 'DEFRA/test-repo' })
      expect(payload.projectSlug).toBe('test-project')

      const found = await service.findRepository(db, 'DEFRA/test-repo')
      expect(found).toEqual(repo)
    })

    test('Should list repositories and unmap repository', async () => {
      await service.mapRepository(db, {
        fullName: 'DEFRA/repo-b',
        projectSlug: 'project-b'
      })
      await service.mapRepository(db, {
        fullName: 'DEFRA/repo-a',
        projectSlug: 'project-a'
      })

      const list = await service.listRepositories(db)
      expect(list.map((r) => r.fullName)).toEqual([
        'DEFRA/repo-a',
        'DEFRA/repo-b'
      ])

      const unmapped = await service.unmapRepository(db, 'DEFRA/repo-a')
      expect(unmapped).toBe(true)

      const remaining = await service.listRepositories(db)
      expect(remaining.map((r) => r.fullName)).toEqual(['DEFRA/repo-b'])

      const unmappedMissing = await service.unmapRepository(
        db,
        'DEFRA/non-existent'
      )
      expect(unmappedMissing).toBe(false)
    })

    test('Should return null when finding non-existent repository', async () => {
      const found = await service.findRepository(db, 'DEFRA/missing')
      expect(found).toBeNull()
    })
  })

  describe('SonarCloud project keys', () => {
    const repositories = () => db.collection(service.REPOSITORIES_COLLECTION)

    afterEach(() => {
      vi.restoreAllMocks()
    })

    test.each([
      [undefined, undefined],
      [null, null],
      ['', null],
      ['   ', null],
      [' DEFRA_key ', 'DEFRA_key']
    ])('Should normalise %j to %j', (input, expected) => {
      expect(service.normaliseSonarKey(input)).toBe(expected)
    })

    test('Should keep the stored key when a repository is re-mapped', async () => {
      await repositories().insertOne({
        fullName: 'DEFRA/own',
        projectSlug: 'PROJ',
        sonarProjectKey: 'DEFRA_own'
      })

      const remapped = await service.mapRepository(db, {
        fullName: 'DEFRA/own',
        projectSlug: 'OTHR',
        sonarProjectKey: 'IGNORED'
      })

      expect(remapped).toMatchObject({
        projectSlug: 'OTHR',
        sonarProjectKey: 'DEFRA_own'
      })
    })

    test('Should set, change and clear the key of a repository', async () => {
      await repositories().insertOne({
        fullName: 'DEFRA/repo',
        projectSlug: 'PROJ'
      })

      const set = await service.setRepositorySonarKey(db, 'DEFRA/repo', 'A')
      const changed = await service.setRepositorySonarKey(
        db,
        'DEFRA/repo',
        ' B '
      )
      const cleared = await service.setRepositorySonarKey(db, 'DEFRA/repo', '')

      expect(set.sonarProjectKey).toBe('A')
      expect(changed.sonarProjectKey).toBe('B')
      expect(cleared).toEqual({
        fullName: 'DEFRA/repo',
        projectSlug: 'PROJ',
        sonarProjectKey: null
      })
    })

    test('Should return null for an unknown repository without creating it', async () => {
      const result = await service.setRepositorySonarKey(
        db,
        'DEFRA/ghost',
        'GHOST'
      )

      expect(result).toBeNull()
      await expect(repositories().countDocuments()).resolves.toBe(0)
    })

    test('Should map a duplicate key error from a concurrent write to a conflict', async () => {
      await repositories().insertMany([
        { fullName: 'DEFRA/a', sonarProjectKey: 'TAKEN' },
        { fullName: 'DEFRA/b' }
      ])
      // Skip the pre-check so the unique index has to catch the duplicate.
      vi.spyOn(Collection.prototype, 'findOne').mockResolvedValueOnce(null)

      await expect(
        service.setRepositorySonarKey(db, 'DEFRA/b', 'TAKEN')
      ).rejects.toMatchObject({
        output: {
          statusCode: 409,
          payload: {
            message: 'That SonarCloud project key is already in use'
          }
        }
      })
    })

    test('Should rethrow any other write failure', async () => {
      await repositories().insertOne({ fullName: 'DEFRA/a' })
      vi.spyOn(Collection.prototype, 'findOneAndUpdate').mockRejectedValueOnce(
        new Error('connection lost')
      )

      await expect(
        service.setRepositorySonarKey(db, 'DEFRA/a', 'KEY')
      ).rejects.toThrow('connection lost')
    })

    test('Should allow many repositories without a key', async () => {
      await repositories().insertMany([
        { fullName: 'DEFRA/x', sonarProjectKey: null },
        { fullName: 'DEFRA/y', sonarProjectKey: null },
        { fullName: 'DEFRA/z', sonarProjectKey: '' },
        { fullName: 'DEFRA/w', sonarProjectKey: '' },
        { fullName: 'DEFRA/v' }
      ])

      await expect(repositories().countDocuments()).resolves.toBe(5)
    })
  })

  describe('#findUnassignedRepositories', () => {
    test('Should return distinct repositories from payloads without project mapping', async () => {
      await db.collection(PAYLOADS_COLLECTION).insertMany([
        {
          repository: 'DEFRA/assigned-repo',
          prNumber: 1,
          projectSlug: 'test-project',
          calculatedAt: new Date()
        },
        {
          repository: 'DEFRA/unassigned-1',
          prNumber: 2,
          projectSlug: null,
          calculatedAt: new Date()
        },
        {
          repository: 'DEFRA/unassigned-2',
          prNumber: 3,
          calculatedAt: new Date()
        }
      ])

      await service.mapRepository(db, {
        fullName: 'DEFRA/assigned-repo',
        projectSlug: 'test-project'
      })

      const unassigned = await service.findUnassignedRepositories(db)
      expect(unassigned).toEqual(['DEFRA/unassigned-1', 'DEFRA/unassigned-2'])
    })
  })

  describe('#findProjectPayloads', () => {
    test('Should query payloads scoped to project returning latest per PR and date filtering', async () => {
      await db.collection(PAYLOADS_COLLECTION).insertMany([
        {
          repository: 'DEFRA/repo-1',
          prNumber: 1,
          projectSlug: 'project-x',
          calculatedAt: new Date('2026-01-15T00:00:00.000Z'),
          commitBreakdown: []
        },
        {
          repository: 'DEFRA/repo-1',
          prNumber: 2,
          projectSlug: 'project-x',
          calculatedAt: new Date('2026-01-20T00:00:00.000Z'),
          commitBreakdown: []
        },
        {
          repository: 'DEFRA/repo-2',
          prNumber: 1,
          projectSlug: 'other-project',
          calculatedAt: new Date('2026-01-15T00:00:00.000Z'),
          commitBreakdown: []
        },
        {
          repository: 'DEFRA/other-repo',
          prNumber: 1,
          projectSlug: 'other-project',
          calculatedAt: new Date('2026-01-10T00:00:00.000Z'),
          commitBreakdown: []
        }
      ])

      const allProjectPayloads = await service.findProjectPayloads(
        db,
        'project-x'
      )
      expect(allProjectPayloads).toHaveLength(2)
      expect(allProjectPayloads[0].calculatedAt).toBe(
        '2026-01-20T00:00:00.000Z'
      )
      expect(allProjectPayloads[1].calculatedAt).toBe(
        '2026-01-15T00:00:00.000Z'
      )

      const filtered = await service.findProjectPayloads(db, 'project-x', {
        from: '2026-01-12T00:00:00.000Z',
        to: '2026-01-18T00:00:00.000Z'
      })
      expect(filtered).toHaveLength(1)
      expect(filtered[0].prNumber).toBe(1)
    })

    test('Should window a backfilled PR by its commit dates, not its analysis time', async () => {
      const commit = (committedAt) => ({
        commit: committedAt.slice(0, 10),
        committedAt: new Date(committedAt)
      })
      await db.collection(PAYLOADS_COLLECTION).insertMany([
        {
          repository: 'DEFRA/repo-1',
          prNumber: 7,
          projectSlug: 'backfill',
          calculatedAt: new Date('2026-11-01T00:00:00.000Z'),
          commitBreakdown: [
            commit('2026-01-29T10:00:00.000Z'),
            commit('2026-02-03T10:00:00.000Z')
          ]
        },
        {
          repository: 'DEFRA/repo-1',
          prNumber: 8,
          projectSlug: 'backfill',
          calculatedAt: new Date('2026-11-01T00:00:00.000Z'),
          commitBreakdown: [commit('2026-03-10T10:00:00.000Z')]
        }
      ])

      const window = (from, to) =>
        service.findProjectPayloads(db, 'backfill', { from, to })

      const january = await window('2026-01-22T00:00:00Z', '2026-02-01T00:00Z')
      const february = await window('2026-02-01T00:00:00Z', '2026-02-15T00:00Z')
      const current = await window('2026-10-28T00:00:00Z', '2026-11-11T00:00Z')

      expect(january.map((p) => p.prNumber)).toEqual([7])
      expect(february.map((p) => p.prNumber)).toEqual([7])
      expect(current).toEqual([])
    })
  })

  describe('#resolveProjectSprints', () => {
    const now = new Date('2026-07-30T12:00:00.000Z')
    const project = { jira: { boardId: 7 } }
    const jira = (getBoardSprints) => ({
      isConfigured: () => true,
      getBoardSprints
    })

    test('Should map board sprints newest first', async () => {
      const client = jira(async () => [
        {
          id: 1,
          name: 'MMO 1',
          startDate: '2026-07-01T09:00:00.000Z',
          endDate: '2026-07-15T09:00:00.000Z',
          completeDate: '2026-07-14T16:00:00.000Z'
        },
        {
          id: 2,
          name: 'MMO 2',
          startDate: '2026-07-15T09:00:00.000Z',
          endDate: '2026-07-29T09:00:00.000Z'
        },
        { id: 3, name: 'Future' }
      ])

      const sprints = await service.resolveProjectSprints(project, client, {
        count: 5,
        now
      })

      expect(sprints).toEqual([
        {
          index: 2,
          name: 'MMO 2',
          label: 'MMO 2',
          start: new Date('2026-07-15T09:00:00.000Z'),
          end: new Date('2026-07-29T09:00:00.000Z')
        },
        {
          index: 1,
          name: 'MMO 1',
          label: 'MMO 1',
          start: new Date('2026-07-01T09:00:00.000Z'),
          end: new Date('2026-07-14T16:00:00.000Z')
        }
      ])
    })

    test('Should use the cadence without a board or when Jira fails', async () => {
      const cadence = service.getProjectSprints({}, 2, now)
      const failing = jira(async () => {
        throw new Error('down')
      })
      const logger = { warn: vi.fn() }

      await expect(
        service.resolveProjectSprints({}, failing, { count: 2, now })
      ).resolves.toEqual(cadence)
      await expect(
        service.resolveProjectSprints(project, null, { count: 2, now })
      ).resolves.toEqual(cadence)
      await expect(
        service.resolveProjectSprints(project, failing, {
          count: 2,
          now,
          logger
        })
      ).resolves.toEqual(cadence)
      expect(logger.warn).toHaveBeenCalled()
    })
  })

  describe('#getProjectSprints', () => {
    test('Should return the current sprint first, then earlier ones', () => {
      const now = new Date('2026-07-30T12:00:00.000Z')
      const sprints = service.getProjectSprints({}, 3, now)
      expect(sprints).toHaveLength(3)
      expect(sprints[0]).toMatchObject({
        index: 2,
        label: 'Sprint 2',
        start: new Date('2026-07-22T00:00:00.000Z'),
        end: new Date('2026-08-05T00:00:00.000Z')
      })
      expect(sprints[1].end).toEqual(sprints[0].start)
      expect(sprints[2].label).toBe('Sprint 0')
    })

    test('Should generate sprint windows with custom calendar', () => {
      const project = {
        sprintCalendar: {
          cadenceDays: 7,
          anchorDate: '2026-01-01T00:00:00.000Z'
        }
      }
      const now = new Date('2026-01-03T00:00:00.000Z')
      const sprints = service.getProjectSprints(project, 2, now)
      expect(sprints).toHaveLength(2)
      expect(sprints[0].start).toEqual(new Date('2026-01-01T00:00:00.000Z'))
      expect(sprints[0].end).toEqual(new Date('2026-01-08T00:00:00.000Z'))
      expect(sprints[1].end).toEqual(new Date('2026-01-01T00:00:00.000Z'))
    })
  })
})
