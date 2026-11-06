import {
  jiraWorkflowPayloadSchema,
  workflowFailAction
} from './jira-workflow.js'

const payload = (stages = [], overrides = {}) => ({
  version: 0,
  stages: [
    { id: 'todo', statuses: ['To Do'] },
    { id: 'done', statuses: ['Done'] },
    ...stages
  ],
  ...overrides
})

const validate = (value) => jiraWorkflowPayloadSchema.validate(value)

describe('#jiraWorkflowPayloadSchema', () => {
  test('Should accept a valid payload and tidy status names', () => {
    const { error, value } = validate(
      payload([{ id: 'in-review', statuses: ['  In   Review '] }])
    )

    expect(error).toBeUndefined()
    expect(value.stages[2].statuses).toEqual(['In Review'])
  })

  test('Should strip unknown keys', () => {
    const { value } = validate({
      ...payload(),
      source: 'project',
      stages: [
        { id: 'todo', statuses: ['To Do'], label: 'x' },
        { id: 'done', statuses: ['Done'] }
      ]
    })

    expect(value).not.toHaveProperty('source')
    expect(value.stages[0]).not.toHaveProperty('label')
  })

  test.each([
    ['an unknown stage id', payload([{ id: 'qa', statuses: ['QA'] }])],
    ['a repeated stage id', payload([{ id: 'todo', statuses: ['Backlog'] }])],
    [
      'a status over 60 characters',
      payload([{ id: 'blocked', statuses: ['x'.repeat(61)] }])
    ],
    [
      'a control character',
      payload([{ id: 'blocked', statuses: ['On\u0007Hold'] }])
    ],
    [
      'more than 40 statuses in one stage',
      payload([
        {
          id: 'blocked',
          statuses: Array.from({ length: 41 }, (_, i) => `S${i}`)
        }
      ])
    ],
    ['a negative version', payload([], { version: -1 })],
    ['a missing version', { stages: payload().stages }]
  ])('Should reject %s', (_, value) => {
    expect(validate(value).error).toBeDefined()
  })

  test.each([
    [
      [
        { id: 'todo', statuses: [] },
        { id: 'done', statuses: ['Done'] }
      ],
      'To Do needs at least one status'
    ],
    [
      [
        { id: 'todo', statuses: ['To Do'] },
        { id: 'blocked', statuses: ['Blocked'] }
      ],
      'Done needs at least one status'
    ],
    [
      [
        { id: 'todo', statuses: ['To Do'] },
        { id: 'done', statuses: ['to  do'] }
      ],
      "'to do' is in more than one stage"
    ],
    [
      [
        { id: 'todo', statuses: ['To Do'] },
        { id: 'done', statuses: ['Done'] },
        ...['in-progress', 'in-review', 'in-test', 'blocked'].map((id) => ({
          id,
          statuses: Array.from({ length: 40 }, (_, i) => `${id} ${i}`)
        }))
      ],
      'A workflow can have at most 150 statuses'
    ]
  ])('Should explain a broken workflow rule', (stages, message) => {
    expect(validate({ version: 1, stages }).error.message).toBe(message)
  })

  test('Should not treat a status name as a message template', () => {
    const { error } = validate({
      version: 1,
      stages: [
        { id: 'todo', statuses: ['{a} {#label}'] },
        { id: 'done', statuses: ['{A} {#LABEL}'] }
      ]
    })

    expect(error.message).toBe("'{A} {#LABEL}' is in more than one stage")
  })

  describe('#workflowFailAction', () => {
    const request = () => ({ logger: { warn: vi.fn() } })

    test('Should show a broken workflow rule without echoing the payload to logs', () => {
      const req = request()
      const { error } = validate(
        payload([{ id: 'blocked', statuses: ['Done'] }])
      )

      expect(() => workflowFailAction(req, null, error)).toThrow(
        "'Done' is in more than one stage"
      )
      expect(req.logger.warn).toHaveBeenCalledWith(
        { validation: { paths: [{ path: 'stages', type: 'workflow.rule' }] } },
        'Request failed validation'
      )
    })

    test('Should keep the generic message for any other validation error', () => {
      const { error } = validate(payload([{ id: 'qa', statuses: [] }]))

      expect(() => workflowFailAction(request(), null, error)).toThrow(
        'Invalid request input'
      )
    })
  })
})
