import {
  hasRequiredJiraKey,
  projectCreateSchema,
  projectSlugParamSchema,
  projectUpdateSchema,
  repositoryMapSchema,
  repositorySonarKeySchema
} from './project.js'

describe('#project schemas', () => {
  describe('#projectCreateSchema', () => {
    const create = (extra) =>
      projectCreateSchema.validate({
        slug: 'ABCD',
        name: 'Project',
        type: 'ai-adopted',
        ...extra
      })

    test.each(['ABC', 'ABCD'])('Should accept the slug %s', (slug) => {
      expect(create({ slug }).error).toBeUndefined()
    })

    test.each(['AB', 'ABCDE', 'AB1', 'A1B2', 'abc', 'AB C'])(
      'Should reject the slug %s',
      (slug) => {
        expect(create({ slug }).error).toBeDefined()
      }
    )

    test('Should default the Jira block to no keys', () => {
      expect(create().value.jira).toEqual({ projectKeys: [] })
    })

    test('Should reject a story points field that is not a custom field id', () => {
      const { error } = create({ jira: { storyPointsField: 'Story Points' } })

      expect(error.details[0].type).toBe('string.pattern.base')
    })

    test('Should accept one Jira key and reject two', () => {
      const one = create({ jira: { projectKeys: ['MMO_CR2'] } })
      const two = create({ jira: { projectKeys: ['ONE', 'TWO'] } })

      expect(one.error).toBeUndefined()
      expect(two.error.details[0].type).toBe('array.max')
    })

    test.each(['FI0', 'A1', 'AB12_3'])(
      'Should accept the alphanumeric Jira key %s',
      (key) => {
        expect(create({ jira: { projectKeys: [key] } }).error).toBeUndefined()
      }
    )

    test.each(['0FI', 'fi0', 'F', 'FI-0'])(
      'Should reject the Jira key %s',
      (key) => {
        expect(create({ jira: { projectKeys: [key] } }).error).toBeDefined()
      }
    )
  })

  describe('#projectSlugParamSchema', () => {
    test('Should still accept a legacy slug with digits', () => {
      expect(projectSlugParamSchema.validate({ slug: 'CR01' }).error).toBe(
        undefined
      )
    })
  })

  describe('#projectUpdateSchema', () => {
    test('Should add no Jira defaults to a partial update', () => {
      const { value } = projectUpdateSchema.validate({ jira: { boardId: 3 } })

      expect(value).toEqual({ jira: { boardId: 3 } })
    })

    test('Should strip sync-owned Jira fields', () => {
      const { value } = projectUpdateSchema.validate({
        jira: {
          projectKeys: ['KEY'],
          statusMapping: { Done: 'done' },
          detectedStatuses: ['Done'],
          lastSyncedAt: '2026-01-01T00:00:00.000Z'
        }
      })

      expect(value).toEqual({ jira: { projectKeys: ['KEY'] } })
    })

    test('Should reject more than one Jira key', () => {
      const { error } = projectUpdateSchema.validate({
        jira: { projectKeys: ['ONE', 'TWO'] }
      })

      expect(error.details[0].type).toBe('array.max')
    })

    test('Should accept null on update to restore detection', () => {
      const { error, value } = projectUpdateSchema.validate({
        jira: { storyPointsField: null }
      })

      expect(error).toBeUndefined()
      expect(value).toEqual({ jira: { storyPointsField: null } })
    })
  })

  describe('#hasRequiredJiraKey', () => {
    test.each([
      [{ type: 'ai-adopted' }, true],
      [{ type: 'ai-adopted', jira: { projectKeys: [] } }, true],
      [{ type: 'ai-native', jira: { projectKeys: ['KEY'] } }, true],
      [{ type: 'ai-native' }, false],
      [{ type: 'ai-native', jira: { projectKeys: [] } }, false],
      [{ type: 'ai-native', jira: { projectKeys: ['A', 'B'] } }, false],
      [undefined, true]
    ])('Should judge %j as %s', (project, expected) => {
      expect(hasRequiredJiraKey(project)).toBe(expected)
    })
  })

  describe('SonarCloud project key', () => {
    test.each([
      ['  DEFRA_mmo-cr.backend:main  ', 'DEFRA_mmo-cr.backend:main'],
      ['', ''],
      ['   ', ''],
      [null, null]
    ])('Should accept %j as %j', (sonarProjectKey, expected) => {
      const { error, value } = repositorySonarKeySchema.validate({
        sonarProjectKey
      })

      expect(error).toBeUndefined()
      expect(value.sonarProjectKey).toBe(expected)
    })

    test.each([
      ['a space', 'has space'],
      ['a slash', 'DEFRA/repo'],
      ['256 characters', 'k'.repeat(256)],
      ['a number', 42]
    ])('Should reject a key with %s', (_, sonarProjectKey) => {
      expect(
        repositorySonarKeySchema.validate({ sonarProjectKey }).error
      ).toBeDefined()
    })

    test('Should accept a key of exactly 255 characters', () => {
      expect(
        repositorySonarKeySchema.validate({ sonarProjectKey: 'k'.repeat(255) })
          .error
      ).toBeUndefined()
    })

    test('Should require the key on the dedicated endpoint only', () => {
      expect(repositorySonarKeySchema.validate({}).error).toBeDefined()
      expect(
        repositoryMapSchema.validate({ projectSlug: 'MINE' }).error
      ).toBeUndefined()
    })

    test('Should strip any key sent when mapping a repository', () => {
      const { error, value } = repositoryMapSchema.validate({
        projectSlug: 'MINE',
        sonarProjectKey: 'has space'
      })

      expect(error).toBeUndefined()
      expect(value).toEqual({ projectSlug: 'MINE' })
    })
  })
})
