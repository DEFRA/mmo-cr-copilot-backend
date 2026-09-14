import { isTokenValid } from './verify-token.js'

describe('#isTokenValid', () => {
  test('Should accept an exact match', () => {
    expect(isTokenValid('s3cret', 's3cret')).toBe(true)
  })

  test('Should reject a different token of the same length', () => {
    expect(isTokenValid('s3cret', 's3crey')).toBe(false)
  })

  test('Should reject a token of a different length', () => {
    expect(isTokenValid('s3cre', 's3cret')).toBe(false)
  })

  test.each([undefined, null, 123, {}, []])(
    'Should reject the non-string value %s',
    (value) => {
      expect(isTokenValid(value, 's3cret')).toBe(false)
      expect(isTokenValid('s3cret', value)).toBe(false)
    }
  )
})
