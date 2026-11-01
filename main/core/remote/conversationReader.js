import {remoteError} from './protocol.js'

/** Bounded, disposable read workers. Media sources stay private to Main/worker. */
export function createConversationReader(createWorker, {timeoutMs = 20000, concurrency = 2, maxQueued = 16} = {}) {
  let running = 0
  const queue = []
  function pump() {
    while (running < concurrency && queue.length) {
      const job = queue.shift()
      if (Date.now() >= job.deadline) {job.reject(remoteError('remote_conversation_read_timeout')); continue}
      running++
      let worker, timer, settled = false
      const finish = (error, message) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        void worker?.terminate()
        running--
        if (error) job.reject(error)
        else job.resolve(message)
        pump()
      }
      try {
        worker = createWorker()
        timer = setTimeout(() => finish(remoteError('remote_conversation_read_timeout')), Math.max(1, job.deadline - Date.now()))
        worker.once('message', message => {
          if (!message?.ok) finish(remoteError(message?.code === 'conversation_not_found' ? 'remote_conversation_not_found' : 'remote_conversation_read_failed'))
          else finish(null, message)
        })
        worker.once('error', () => finish(remoteError('remote_conversation_read_failed')))
        worker.once('exit', () => {if (!settled) finish(remoteError('remote_conversation_read_failed'))})
        worker.postMessage({operation: job.operation, params: job.params})
      } catch {finish(remoteError('remote_conversation_read_failed'))}
    }
  }
  async function read(operation, options) {
    // Functions cannot cross the worker boundary. Register only after the read
    // returns, with the original authenticated device/conversation closure.
    const {registerMedia, ...params} = options
    if (queue.length >= maxQueued) throw remoteError('remote_conversation_read_busy')
    const message = await new Promise((resolve, reject) => {
      queue.push({operation, params, resolve, reject, deadline: Date.now() + timeoutMs})
      pump()
    })
    if (operation === 'open') return message.value
    const refs = new Map()
    for (const item of message.media || []) {
      const registered = typeof registerMedia === 'function' ? registerMedia(item.source) : null
      refs.set(item.uri, registered?.uri || '')
    }
    function replace(value) {
      if (typeof value === 'string') return value.replace(/anywhere-media:\/\/[A-Za-z0-9_-]{16,160}(?:\?type=(?:image|audio|video))?/g, uri => refs.get(uri) ?? uri)
      if (Array.isArray(value)) return value.map(replace)
      if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, replace(item)]))
      return value
    }
    return replace(message.value)
  }
  return {open: params => read('open', params), page: params => read('page', params)}
}
