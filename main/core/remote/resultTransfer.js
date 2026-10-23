import crypto from 'node:crypto'
import {canonicalBuffer, normalizeIdentifier, remoteError} from './protocol.js'

export const RESULT_TRANSFER_CAPABILITY = 'remote.transfer.v1'
export const RESULT_TRANSFER_CHUNK_BYTES = 48 * 1024
export const RESULT_TRANSFER_MAX_BYTES = 32 * 1024 * 1024
const MAX_TOTAL_BYTES = 64 * 1024 * 1024
const MAX_ENTRIES = 64
const MAX_OWNER_ENTRIES = 16
const TTL_MS = 5 * 60 * 1000

/** Immutable, sanitized JSON only. References are scoped to an authenticated socket. */
export function createResultTransfers({now = Date.now, maxTotalBytes = MAX_TOTAL_BYTES} = {}) {
  const entries = new Map()
  let totalBytes = 0
  const remove = id => {
    const entry = entries.get(id)
    if (entry) {totalBytes -= entry.bytes.length; entries.delete(id)}
  }
  const prune = () => {
    for (const [id, entry] of entries) if (entry.expires <= now()) remove(id)
  }
  function put(owner, payload) {
    prune()
    let bytes
    try {bytes = canonicalBuffer(payload)} catch {throw remoteError('remote_response_invalid')}
    if (bytes.length > RESULT_TRANSFER_MAX_BYTES) throw remoteError('remote_response_too_large')
    const owned = [...entries.values()].filter(entry => entry.owner === owner)
    if (entries.size >= MAX_ENTRIES || owned.length >= MAX_OWNER_ENTRIES ||
        owned.reduce((sum, entry) => sum + entry.bytes.length, 0) + bytes.length > RESULT_TRANSFER_MAX_BYTES ||
        totalBytes + bytes.length > maxTotalBytes) throw remoteError('remote_transfer_capacity')
    const id = crypto.randomBytes(24).toString('base64url')
    const sha256 = crypto.createHash('sha256').update(bytes).digest('hex')
    entries.set(id, {owner, bytes, sha256, expires: now() + TTL_MS})
    totalBytes += bytes.length
    return {id, totalBytes: bytes.length, sha256, chunkBytes: RESULT_TRANSFER_CHUNK_BYTES}
  }
  function owned(owner, params, keys) {
    prune()
    if (!params || typeof params !== 'object' || Array.isArray(params) || Object.keys(params).some(key => !keys.includes(key))) throw remoteError('remote_parameter_unknown')
    const id = normalizeIdentifier(params.id, 'transferId', {minLength: 32, maxLength: 32})
    const entry = entries.get(id)
    if (!entry || entry.owner !== owner) throw remoteError('remote_transfer_expired')
    return {id, entry}
  }
  function chunk(owner, params) {
    const {id, entry} = owned(owner, params, ['id', 'offset'])
    const offset = params.offset
    if (!Number.isSafeInteger(offset) || offset < 0 || offset >= entry.bytes.length) throw remoteError('remote_transfer_range_invalid')
    const bytes = entry.bytes.subarray(offset, offset + RESULT_TRANSFER_CHUNK_BYTES)
    return {id, offset, totalBytes: entry.bytes.length, sha256: entry.sha256, byteLength: bytes.length, data: bytes.toString('base64url')}
  }
  function release(owner, params) {const {id} = owned(owner, params, ['id']); remove(id); return {ok: true}}
  function clearOwner(owner) {for (const [id, entry] of entries) if (entry.owner === owner) remove(id)}
  return {put, chunk, release, clearOwner, clear: () => {entries.clear(); totalBytes = 0}}
}
