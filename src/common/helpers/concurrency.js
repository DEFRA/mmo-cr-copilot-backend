/** Runs `fn` over `items` with at most `limit` in flight; results keep input order. */
export async function mapWithConcurrency(items, limit, fn) {
  const results = new Array(items.length)
  let next = 0
  const worker = async () => {
    while (next < items.length) {
      const index = next
      next += 1
      results[index] = await fn(items[index], index)
    }
  }
  const workers = Math.max(0, Math.min(limit, items.length))
  await Promise.all(Array.from({ length: workers }, worker))
  return results
}

export const TIMED_OUT = Symbol('timed-out')

/** The promise's value, or TIMED_OUT after `ms`; the promise keeps running. Callers pass promises that never reject. */
export async function withinBudget(promise, ms) {
  let timer
  const timeout = new Promise((resolve) => {
    timer = setTimeout(() => resolve(TIMED_OUT), ms)
  })
  try {
    return await Promise.race([promise, timeout])
  } finally {
    clearTimeout(timer)
  }
}
