import path from 'node:path'
import {randomUUID} from 'node:crypto'

const fail = code => new Error(code)
const directoryKey = value => {
  const resolved = path.resolve(value)
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved
}

// Local metadata requests do not take Mobile control or borrow another Renderer's lease.
// Main routes once, then waits for an authenticated completion from the existing writer.
export function createConversationMetadataRouter({listWindows, getConversationDirectory, dispatch, rename, onRenamed = () => {}, timeoutMs = 30_000}) {
  const pending = new Map()
  const findSender = senderRef => listWindows().find(item => item.id === senderRef)
  const matchesDirectory = (item, input) => {
    const directory = getConversationDirectory(item.id, input.conversationId)
    return directory && directoryKey(directory) === directoryKey(input.dirPath)
  }
  const validate = input => {
    if (!input || typeof input !== 'object' || Array.isArray(input)
      || Object.keys(input).some(key => !['dirPath', 'conversationId', 'title', 'projectId', 'expectedRevision', 'holderInstanceId', 'leaseEpoch'].includes(key))) throw fail('conversation_metadata_invalid')
    if (typeof input.dirPath !== 'string' || !input.dirPath.trim() || typeof input.conversationId !== 'string' || !input.conversationId.trim()) throw fail('conversation_metadata_invalid')
    if (typeof input.title !== 'string' || !input.title.trim()) throw fail('conversation_title_required')
    if (Object.hasOwn(input, 'projectId') && (typeof input.projectId !== 'string' || input.projectId.length > 160)) throw fail('conversation_project_invalid')
    return {dirPath: input.dirPath.trim(), conversationId: input.conversationId.trim(), title: input.title.trim(), ...(Object.hasOwn(input, 'projectId') ? {projectId: input.projectId} : {})}
  }
  const report = result => {
    // Never broadcast private directories/lease holders from an internal store result.
    try {onRenamed({conversationId: result.conversationId, title: result.title, revision: result.revision, updatedAt: result.updatedAt})} catch { /* observers cannot change a committed result */ }
  }
  const request = async (senderRef, rawInput) => {
    const input = validate(rawInput)
    const sender = findSender(senderRef)
    if (!sender || !['main', 'window'].includes(sender.type)) throw fail('conversation_local_window_required')
    if (sender.type === 'window') {
      // The writer's own IPC call is the only direct path while a window is alive.
      if (sender.conversationId !== input.conversationId || !matchesDirectory(sender, input)) throw fail('conversation_metadata_window_mismatch')
      if (!rawInput.holderInstanceId || !Number.isFinite(Number(rawInput.leaseEpoch))) throw fail('conversation_write_lease_lost')
      const result = await rename({...input, holderInstanceId: rawInput.holderInstanceId, leaseEpoch: rawInput.leaseEpoch, expectedRevision: rawInput.expectedRevision})
      report(result)
      return result
    }
    const candidates = listWindows().filter(item => item.type === 'window' && item.conversationId === input.conversationId)
    // Missing private scope during startup is unknown, not proof that no writer exists.
    if (candidates.some(item => !getConversationDirectory(item.id, input.conversationId))) throw fail('conversation_writer_not_ready')
    const scoped = candidates.filter(item => matchesDirectory(item, input))
    if (!scoped.length) {
      const result = await rename(input)
      report(result)
      return result
    }
    const writers = scoped.filter(item => !item.readOnly)
    if (writers.length !== 1 || writers[0].leasePending || !writers[0].rendererReady) throw fail('conversation_writer_not_ready')
    const writer = writers[0]
    const requestId = randomUUID()
    const expiresAt = Date.now() + timeoutMs
    return new Promise((resolve, reject) => {
      const settle = (error, result) => {
        if (!pending.delete(requestId)) return
        clearTimeout(timer)
        if (error) reject(error)
        else resolve(result)
      }
      const timer = setTimeout(() => settle(fail('conversation_metadata_result_timeout')), timeoutMs)
      const record = {input, writerRef: writer.id, expiresAt, settle}
      pending.set(requestId, record)
      Promise.resolve().then(() => dispatch(writer.id, {requestId, ...input, dirPath: getConversationDirectory(writer.id, input.conversationId), expiresAt})).then(result => {
        if (!result?.ok) settle(fail('conversation_metadata_dispatch_failed'))
      }).catch(() => settle(fail('conversation_metadata_dispatch_failed')))
    })
  }
  const check = (senderRef, input = {}) => {
    const record = pending.get(input.requestId)
    const writer = findSender(senderRef)
    if (!record || Date.now() >= record.expiresAt || record.writerRef !== senderRef
      || record.input.conversationId !== input.conversationId || !writer || writer.readOnly || writer.leasePending
      || writer.conversationId !== record.input.conversationId || !matchesDirectory(writer, record.input)) return {ok: false}
    return {ok: true}
  }
  const complete = (senderRef, input = {}) => {
    const record = pending.get(input.requestId)
    const writer = findSender(senderRef)
    if (!record || Date.now() >= record.expiresAt || record.writerRef !== senderRef
      || record.input.conversationId !== input.conversationId || !writer
      || writer.conversationId !== record.input.conversationId || !matchesDirectory(writer, record.input)) return {ok: false}
    if (input.ok !== true) {
      const code = typeof input.code === 'string' && /^conversation_[a-z_]+$/.test(input.code) ? input.code : 'conversation_metadata_failed'
      record.settle(fail(code))
      return {ok: true}
    }
    const result = input.result
    if (!result || result.conversationId !== record.input.conversationId || result.title !== record.input.title
      || !Number.isInteger(result.revision) || result.revision < 1) return {ok: false}
    report(result)
    record.settle(null, {ok: true, conversationId: result.conversationId, title: result.title, revision: result.revision,
      ...(typeof result.dbFile === 'string' ? {dbFile: result.dbFile} : {}), ...(typeof result.updatedAt === 'string' ? {updatedAt: result.updatedAt} : {})})
    return {ok: true}
  }
  return {request, check, complete}
}
