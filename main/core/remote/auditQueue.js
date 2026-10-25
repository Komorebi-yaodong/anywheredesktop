/** Coalesce best-effort audit writes without making any RPC wait on storage. */
export function createAuditQueue({load, save, filter, delayMs = 1000, maxEntries = 200}) {
  let pending = [], running, timer
  function append(entry) {
    pending.push(entry)
    if (pending.length > maxEntries) pending.splice(0, pending.length - maxEntries)
    if (!timer && !running) {
      timer = setTimeout(() => {timer = null; void flush()}, delayMs)
      timer.unref?.()
    }
  }
  function flush() {
    if (timer) clearTimeout(timer)
    timer = null
    if (running) return running
    if (!pending.length) return Promise.resolve()
    const batch = pending.splice(0)
    running = (async () => {
      try {await save(filter([...batch.reverse(), ...await load()]))} catch { /* best effort */ }
    })().finally(() => {
      running = null
      if (pending.length && !timer) {
        timer = setTimeout(() => {timer = null; void flush()}, delayMs)
        timer.unref?.()
      }
    })
    return running
  }
  return {append, flush}
}
