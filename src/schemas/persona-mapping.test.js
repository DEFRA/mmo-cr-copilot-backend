import {
  githubHandleParamSchema,
  personaMappingPayloadSchema
} from './persona-mapping.js'

describe('#githubHandleParamSchema', () => {
  const validate = (githubHandle) =>
    githubHandleParamSchema.validate({ githubHandle })

  test.each([
    'octocat',
    'randhir-patel',
    'Jeevan K R',
    'Zoë O’Brien',
    '-x',
    'a'.repeat(100)
  ])('Should accept the git config name %s', (handle) => {
    expect(validate(handle).error).toBeUndefined()
  })

  test.each([
    '',
    '.',
    '..',
    'a/b',
    'a\\b',
    ' leading',
    'trailing ',
    'new\nline',
    'a'.repeat(101)
  ])('Should reject %j', (handle) => {
    expect(validate(handle).error).toBeDefined()
  })
})

describe('#personaMappingPayloadSchema', () => {
  const validate = (payload) => personaMappingPayloadSchema.validate(payload)

  test.each(['developer', 'devops', 'qa'])(
    'Should accept the persona %s',
    (persona) => {
      expect(validate({ persona }).error).toBeUndefined()
    }
  )

  test('Should reject an unknown persona', () => {
    expect(validate({ persona: 'manager' }).error).toBeDefined()
  })

  test('Should require a persona', () => {
    expect(validate({}).error).toBeDefined()
  })

  test('Should strip unknown keys', () => {
    const { value } = validate({ persona: 'qa', injected: true })

    expect(value).not.toHaveProperty('injected')
  })
})
