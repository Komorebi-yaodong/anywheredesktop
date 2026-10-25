import crypto from 'node:crypto'
import {remoteError, stableStringify} from './protocol.js'

const RETENTION_MS = 7 * 24 * 60 * 60 * 1000
const MAX_AGE_MS = 24 * 60 * 60 * 1000
const FUTURE_MS = 60 * 1000

/** Encrypted by the supplied storage adapter; never persists raw command params. */
export function createOperationJournal({load, save, now = Date.now}) {
  const records = new Map()
  let initialized
  let queue = Promise.resolve()
  const live = new Map()
  const key = (deviceId, commandId) => `${deviceId}:${commandId}`
  const serial = fn => {
    const next = queue.catch(() => {}).then(fn)
    queue = next.catch(() => {})
    return next
  }
  const bounded = value => value && Buffer.byteLength(JSON.stringify(value), 'utf8') > 16384 ? {refreshRequired: true} : value
  const compact = record => ({...record, receipt: record.method === 'conversation.config.get' || record.method === 'conversation.config.patch' || record.method === 'conversation.context.refresh' ? null : bounded(record.receipt),
    progress: record.progress ? {...record.progress, text: '', reasoning: '', toolCalls: [], truncated: true, result: ['conversation.config.get', 'conversation.config.patch', 'conversation.context.refresh'].includes(record.method) ? {refreshRequired: true} : bounded(record.progress.result)} : null})
  let storageFailed = false
  const persist = async () => {try {await save({version: 1, records: [...records.values()].map(compact)}); storageFailed = false} catch {storageFailed = true; throw remoteError('remote_operation_storage_failed')}}
  async function initialize() {
    if (!initialized) initialized = (async () => {
      const data = await load()
      if (data !== null && (data?.version !== 1 || !Array.isArray(data.records))) throw remoteError('remote_operation_storage_invalid')
      const list = data?.records || []
      for (const record of list) {
        if (!record || typeof record.deviceId !== 'string' || typeof record.commandId !== 'string' || !Number.isFinite(record.acceptedAt)) throw remoteError('remote_operation_storage_invalid')
        if (now() - record.acceptedAt > RETENTION_MS) continue
        if (!record.terminal) {
          record.terminal = true
          record.state = 'interrupted'
          record.code = 'remote_operation_interrupted'
          record.progress = null
          record.receipt = null
        }
        records.set(key(record.deviceId, record.commandId), record)
      }
      await persist()
    })()
    return initialized
  }
  function safeRecord(record) {
    return {operationId: record.commandId, conversationId: record.conversationId || null,
      state: record.state, terminal: record.terminal, code: record.code || null,
      receipt: record.receipt || null, progress: record.progress || null,
      acceptedAt: record.acceptedAt, expiresAt: record.acceptedAt + RETENTION_MS}
  }
  async function execute({deviceId, commandId, issuedAt, method, params}, dispatch, asynchronous = false) {
    await initialize()
    const fingerprint = crypto.createHash('sha256').update(stableStringify({method, params})).digest('hex')
    const recordKey = key(deviceId, commandId)
    let created = false
    const record = await serial(async () => {
      const previous = records.get(recordKey)
      if (previous) {
        if (previous.fingerprint !== fingerprint) throw remoteError('remote_command_id_conflict')
        return previous
      }
      if (!Number.isFinite(issuedAt) || issuedAt < now() - MAX_AGE_MS || issuedAt > now() + FUTURE_MS) throw remoteError('remote_command_expired')
      for (const [id, item] of records) if (now() - item.acceptedAt > RETENTION_MS) records.delete(id)
      // Retained dedupe history is not a usage quota; keep valid records without
      // refusing new commands or evicting IDs that still prevent duplicate execution.
      const next = {deviceId, commandId, fingerprint, method, conversationId: typeof params.conversationId === 'string' ? params.conversationId : null,
        acceptedAt: now(), state: 'accepted', terminal: false, receipt: null, progress: null, code: null}
      records.set(recordKey, next)
      try {await persist()} catch (error) {records.delete(recordKey); throw error}
      created = true
      return next
    })
    if (!created) {
      if (live.has(recordKey)) await live.get(recordKey)
      if (storageFailed) await serial(persist)
      return safeRecord(record)
    }
    const run = (async () => {
      try {
        const receipt = await dispatch()
        await serial(async () => {
          // Renderer terminal can arrive before the dispatch acknowledgment.
          record.receipt = receipt
          if (typeof receipt?.conversationId === 'string') record.conversationId = receipt.conversationId
          if (!record.terminal) {record.state = asynchronous ? 'running' : 'succeeded'; record.terminal = !asynchronous}
          await persist()
        })
      } catch (error) {
        if (error?.code === 'remote_operation_storage_failed') throw error
        await serial(async () => {
          if (!record.terminal) {record.state = 'failed'; record.terminal = true; record.code = /^remote_[a-z0-9_]+$/.test(error?.code) ? error.code : 'remote_command_failed'}
          await persist()
        })
      }
    })()
    live.set(recordKey, run)
    try {await run} finally {live.delete(recordKey)}
    if (storageFailed) throw remoteError('remote_operation_storage_failed')
    return safeRecord(record)
  }
  async function update(deviceId, commandId, progress) {
    await initialize()
    await serial(async () => {
      const record = records.get(key(deviceId, commandId))
      if (!record || record.terminal) return
      record.conversationId = progress.conversationId || record.conversationId
      record.progress = {...progress, text: String(progress.text || '').slice(-4096), reasoning: String(progress.reasoning || '').slice(-4096),
        truncated: progress.truncated === true || String(progress.text || '').length > 4096 || String(progress.reasoning || '').length > 4096}
      record.terminal = progress.terminal === true
      record.state = record.terminal ? progress.event.endsWith('.failed') ? 'failed' : progress.event.endsWith('.cancelled') ? 'cancelled' : 'succeeded'
        : progress.event === 'conversation.queue.pending' ? 'queued' : 'running'
      record.code = progress.terminal && progress.result?.code || null
      await persist()
    })
  }
  async function interrupt(deviceId, commandId) {
    await initialize()
    await serial(async () => {
      const record = records.get(key(deviceId, commandId))
      if (!record || record.terminal || live.has(key(deviceId, commandId))) return
      record.state = 'interrupted'; record.terminal = true; record.code = 'remote_operation_interrupted'; record.progress = null
      await persist()
    })
  }

  async function get(deviceId, commandId) {
    await initialize()
    await queue
    if (storageFailed) await serial(persist)
    const record = records.get(key(deviceId, commandId))
    if (!record || now() - record.acceptedAt > RETENTION_MS) throw remoteError('remote_operation_not_found')
    return safeRecord(record)
  }
  return {execute, update, interrupt, get, initialize, limits: {retentionMs: RETENTION_MS, maxCommandAgeMs: MAX_AGE_MS}}
}
