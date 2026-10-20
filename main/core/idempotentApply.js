export function createIdempotentSerialApplier({ normalize, getFingerprint, apply }) {
  if (typeof normalize !== 'function') throw new TypeError('normalize_required')
  if (typeof getFingerprint !== 'function') throw new TypeError('get_fingerprint_required')
  if (typeof apply !== 'function') throw new TypeError('apply_required')

  let queue = Promise.resolve()
  let hasApplied = false
  let lastAppliedFingerprint = ''

  return (input) => {
    const normalizedValue = normalize(input)
    const fingerprint = String(getFingerprint(normalizedValue))

    const task = queue.then(async () => {
      if (hasApplied && fingerprint === lastAppliedFingerprint) {
        return normalizedValue
      }

      // A failed change may have partially updated the target; never trust its old fingerprint.
      hasApplied = false
      await apply(normalizedValue)
      lastAppliedFingerprint = fingerprint
      hasApplied = true
      return normalizedValue
    })

    // A failed apply must reject its own caller without poisoning later config updates.
    queue = task.catch(() => {})
    return task
  }
}
