import { timingSafeEqual } from 'node:crypto'

/**
 * Constant-time comparison of a presented token against the expected secret.
 * Lengths are compared first because `timingSafeEqual` throws on a mismatch;
 * that leaks only the length, not the contents.
 */
export function isTokenValid(presented, expected) {
  if (typeof presented !== 'string' || typeof expected !== 'string') {
    return false
  }

  const presentedBytes = Buffer.from(presented, 'utf8')
  const expectedBytes = Buffer.from(expected, 'utf8')

  if (presentedBytes.length !== expectedBytes.length) {
    return false
  }

  return timingSafeEqual(presentedBytes, expectedBytes)
}
