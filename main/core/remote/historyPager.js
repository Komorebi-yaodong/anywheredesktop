import crypto from 'node:crypto'
import {remoteError} from './protocol.js'
import {structuredPage} from './contentBlocks.js'

// Leave room for view/runtime/RPC metadata, escaping and base64url expansion.
const PAGE_BYTES = 160 * 1024
const CACHE_BYTES = 64 * 1024 * 1024
const TTL_MS = 5 * 60 * 1000
const bytes = value => Buffer.byteLength(JSON.stringify(value), 'utf8')
export function createHistoryPager() {
  const refs = new Map()
  function prune() {for (const [key, entry] of refs) if (entry.expires <= Date.now()) refs.delete(key)}
  function deferred(message, deviceId, conversationId) {
    const text = JSON.stringify(message.payload)
    const sha256 = crypto.createHash('sha256').update(text).digest('hex')
    const key = crypto.createHash('sha256').update(`${deviceId}:${conversationId}:${message.uiMessageId}:${sha256}`).digest('hex')
    prune()
    if (!refs.has(key)) {
      if ([...refs.values()].reduce((sum, entry) => sum + entry.bytes, 0) + Buffer.byteLength(text) > CACHE_BYTES) throw remoteError('remote_history_cache_full')
      refs.set(key, {deviceId, conversationId, text, sha256, bytes: Buffer.byteLength(text), expires: Date.now() + TTL_MS})
    }
    refs.get(key).expires = Date.now() + TTL_MS
    return {...message, payload: {content: '[正在完整加载长消息…]', reasoningContent: '', summary: '', summaryPrefix: '', timestamp: message.payload.timestamp || '', completedTimestamp: message.payload.completedTimestamp || '', aiName: message.payload.aiName || '', voiceName: '', status: message.payload.status || '', toolCalls: [],
      fullPayload: {id: key, totalChars: text.length, sha256}}}
  }
  function page(value, deviceId, conversationId) {
    const selected = []
    // Oversized page metadata is handled by the negotiated result transfer.
    // It must not force every tiny message into a fullPayload reference.
    const metadataBytes = Math.max(bytes({...value, messages: []}), bytes(structuredPage({...value, messages: []})))
    const messageBase = metadataBytes > PAGE_BYTES ? {...value, tasks: []} : value
    const size = messages => Math.max(bytes({...messageBase, messages}), bytes(structuredPage({...messageBase, messages})))
    for (let index = value.messages.length - 1; index >= 0; index--) {
      let message = value.messages[index]
      if (size([message]) > PAGE_BYTES) message = deferred(message, deviceId, conversationId)
      if (selected.length && size([message, ...selected]) > PAGE_BYTES) break
      selected.unshift(message)
    }
    const trimmed = selected.length < value.messages.length
    const hasMore = trimmed || value.page.hasMore
    return {...value, messages: selected, page: {...value.page, hasMore, nextBeforeUiOrder: hasMore ? selected[0]?.order ?? value.page.nextBeforeUiOrder : null}}
  }
  function chunk({deviceId, params}) {
    if (!params || Object.keys(params).some(key => !['conversationId', 'id', 'offset'].includes(key))) throw remoteError('remote_parameter_unknown')
    prune()
    const entry = refs.get(params.id)
    if (!entry || entry.deviceId !== deviceId || entry.conversationId !== params.conversationId) throw remoteError('remote_history_part_expired')
    const offset = params.offset
    if (!Number.isSafeInteger(offset) || offset < 0 || offset >= entry.text.length) throw remoteError('remote_history_range_invalid')
    // Code-unit slicing is reassembled before JSON parse/hash; surrogate pairs
    // are JSON-escaped by the transport and are never decoded independently.
    const text = entry.text.slice(offset, offset + 16384)
    entry.expires = Date.now() + TTL_MS
    return {id: params.id, offset, totalChars: entry.text.length, sha256: entry.sha256, text, nextOffset: offset + text.length}
  }
  return {page, chunk}
}
