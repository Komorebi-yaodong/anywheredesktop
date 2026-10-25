import {remoteError} from './protocol.js'

/** One read-only scan per configured directory; never block Main's event loop. */
export function createCatalogReader(createWorker, {timeoutMs = 15000} = {}) {
  const pending = new Map()
  return function read(directory) {
    if (!pending.has(directory)) {
      const task = new Promise((resolve, reject) => {
        const worker = createWorker()
        let settled = false
        const finish = (error, value) => {
          if (settled) return
          settled = true
          clearTimeout(timer)
          void worker.terminate()
          if (error) reject(error)
          else resolve(value)
        }
        const timer = setTimeout(() => finish(remoteError('remote_catalog_read_timeout')), timeoutMs)
        worker.once('message', message => {
          if (!message?.ok || !Array.isArray(message.value)) finish(remoteError('remote_catalog_read_failed'))
          else finish(null, message.value)
        })
        worker.once('error', () => finish(remoteError('remote_catalog_read_failed')))
        worker.once('exit', () => {if (!settled) finish(remoteError('remote_catalog_read_failed'))})
        worker.postMessage(directory)
      }).finally(() => pending.delete(directory))
      pending.set(directory, task)
    }
    // Each projection may filter/mutate its own copy of the shared scan.
    return pending.get(directory).then(value => structuredClone(value))
  }
}
