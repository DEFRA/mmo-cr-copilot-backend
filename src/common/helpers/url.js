// Without a regex: `/\/+$/` backtracks super-linearly on long inputs.
export function trimTrailingSlashes(value) {
  let end = value.length
  while (end > 0 && value[end - 1] === '/') {
    end -= 1
  }
  return value.slice(0, end)
}
