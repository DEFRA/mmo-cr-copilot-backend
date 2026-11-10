import { describe, expect, test } from 'vitest'

import {
  TIMED_OUT,
  mapWithConcurrency,
  withinBudget
} from '#/common/helpers/concurrency.js'

const delay = (ms, value) =>
  new Promise((resolve) => setTimeout(() => resolve(value), ms))

describe('#concurrency', () => {
  test('Should keep input order', async () => {
    const delays = [30, 5, 20, 1, 10]
    const results = await mapWithConcurrency(delays, 3, (ms) => delay(ms, ms))
    expect(results).toEqual(delays)
  })

  test('Should never run more than the limit at once', async () => {
    let inFlight = 0
    let peak = 0
    await mapWithConcurrency([1, 2, 3, 4, 5, 6], 2, async () => {
      inFlight += 1
      peak = Math.max(peak, inFlight)
      await delay(5)
      inFlight -= 1
    })
    expect(peak).toBe(2)
  })

  test('Should return an empty array for no items', async () => {
    expect(await mapWithConcurrency([], 4, async () => 1)).toEqual([])
  })

  test('Should return the value when the promise wins', async () => {
    expect(await withinBudget(Promise.resolve(1), 50)).toBe(1)
  })

  test('Should return TIMED_OUT when the budget runs out', async () => {
    expect(await withinBudget(delay(200, 1), 10)).toBe(TIMED_OUT)
  })
})
