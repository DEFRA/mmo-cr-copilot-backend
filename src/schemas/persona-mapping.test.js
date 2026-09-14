import {
  githubHandleParamSchema,
  personaMappingPayloadSchema
} from './persona-mapping.js'

describe('#githubHandleParamSchema', () => {
  const validate = (githubHandle) =>
    githubHandleParamSchema.validate({ githubHandle })

  test('Should accept a simple handle', () => {
    expect(validate('octocat').error).toBeUndefined()
  })

  test('Should accept a handle with a hyphen', () => {
    expect(validate('randhir-patel').error).toBeUndefined()
  })

  test('Should reject a handle starting with a hyphen', () => {
    expect(validate('-octocat').error).toBeDefined()
  })

  test('Should reject a handle with consecutive hyphens', () => {
    expect(validate('octo--cat').error).toBeDefined()
  })

  test('Should reject an empty handle', () => {
    expect(validate('').error).toBeDefined()
  })

  test('Should reject a handle longer than 39 characters', () => {
    expect(validate('a'.repeat(40)).error).toBeDefined()
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
