import crypto from 'node:crypto'
import {TRANSFER_MAX_CHUNK_BYTES} from './transferLimits.js'
import fs from 'node:fs/promises'
import path from 'node:path'
import { normalizeIdentifier, remoteError } from './protocol.js'

const REF_TTL_MS = 7 * 24 * 60 * 60 * 1000
const MAX_MEDIA_BYTES = 25 * 1024 * 1024
// A single Mobile conversation may legitimately render many images at once.
// Keep enough decoded in-memory media for ten near-limit (25 MiB) images.
const MAX_MEMORY_MEDIA_BYTES = 256 * 1024 * 1024
const MAX_CHUNK_BYTES = 96 * 1024
const MAX_REFS = 2048
const MEDIA_VERSION_ALGORITHM = 'sha256'

const MEDIA_TYPES = new Map([
  ['.png', 'image/png'], ['.jpg', 'image/jpeg'], ['.jpeg', 'image/jpeg'], ['.webp', 'image/webp'], ['.gif', 'image/gif'],
  ['.mp4', 'video/mp4'], ['.webm', 'video/webm'], ['.mov', 'video/quicktime'], ['.m4v', 'video/x-m4v'],
  ['.mp3', 'audio/mpeg'], ['.wav', 'audio/wav'], ['.m4a', 'audio/mp4'], ['.aac', 'audio/aac'], ['.ogg', 'audio/ogg'], ['.webm', 'video/webm']
])

function mediaTypeFor(filePath = '') {
  return MEDIA_TYPES.get(path.extname(filePath).toLowerCase()) || ''
}

export function normalizeLocalMediaPath(value = '') {
  const source = typeof value === 'string' ? value.trim() : ''
  if (!source || source.length > 4096 || /^https?:\/\//i.test(source)) return ''
  const decoded = (() => {
    try { return decodeURIComponent(source) } catch { return '' }
  })()
  if (!decoded) return ''
  const normalizeBarePath = (candidate = '') => {
    // The second slash guard is essential: without it, the `s://` inside an
    // HTTPS URL can be mistaken for a Windows S: drive path.
    if (/^[A-Za-z]:[\\/](?![\\/])/.test(candidate)) return candidate
    if (/^\/[A-Za-z]:[\\/](?![\\/])/.test(candidate)) return candidate.slice(1)
    return /^\/(?!\/)/.test(candidate) ? candidate : ''
  }
  if (/^file:/i.test(decoded)) {
    try {
      const url = new URL(decoded)
      if (url.protocol !== 'file:') return ''
      const pathname = decodeURIComponent(url.pathname || '')
      if (!url.host || url.host.toLowerCase() === 'localhost') return normalizeBarePath(pathname)
      // Support legacy Windows file://C:/… spelling, but not UNC hosts.
      if (/^[A-Za-z]$/.test(url.host)) return normalizeBarePath(`${url.host.toUpperCase()}:${pathname}`)
      return ''
    } catch {
      return normalizeBarePath(decoded.replace(/^file:(?:\/\/)?/i, ''))
    }
  }
  return normalizeBarePath(decoded)
}


function normalizeDataMedia(value = '') {
  const source = typeof value === 'string' ? value.trim() : ''
  const match = /^data:((?:image\/(?:png|jpe?g|webp|gif))|(?:audio\/(?:mpeg|mp3|wav|x-wav|mp4|m4a|aac|ogg|webm))|(?:video\/(?:mp4|webm|quicktime|x-m4v)));base64,([A-Za-z0-9+/=\r\n]+)$/i.exec(source)
  if (!match) return null
  const bytes = Buffer.from(match[2].replace(/\s+/g, ''), 'base64')
  if (bytes.length < 1 || bytes.length > MAX_MEDIA_BYTES) return null
  const rawType = match[1].toLowerCase()
  const mimeType = ({'image/jpg': 'image/jpeg', 'audio/mp3': 'audio/mpeg', 'audio/x-wav': 'audio/wav', 'audio/m4a': 'audio/mp4'})[rawType] || rawType
  return {mimeType, bytes}
}

/**
 * Holds only short-lived, server-private source paths. A paired device sees
 * random media IDs and byte chunks, never file paths or names.
 */
export function createRemoteConversationMediaService() {
  const refs = new Map()
  const idsByPrivateKey = new Map()

  function remove(mediaId, entry = refs.get(mediaId)) {
    refs.delete(mediaId)
    if (entry && idsByPrivateKey.get(entry.privateKey) === mediaId) idsByPrivateKey.delete(entry.privateKey)
  }

  function memoryBytes() {
    return [...refs.values()].reduce((total, entry) => total + (entry.buffer?.length || 0), 0)
  }

  function prune() {
    const now = Date.now()
    for (const [mediaId, entry] of refs) {
      if (entry.expiresAtMs <= now) remove(mediaId, entry)
    }
    while (refs.size > MAX_REFS) {
      const mediaId = refs.keys().next().value
      remove(mediaId)
    }
    while (memoryBytes() > MAX_MEMORY_MEDIA_BYTES) {
      const entry = [...refs.entries()].find(([, candidate]) => candidate.buffer)
      if (!entry) break
      remove(entry[0], entry[1])
    }
  }

  function register({ deviceId, conversationId, source } = {}) {
    const safeDeviceId = normalizeIdentifier(deviceId, 'deviceId', { minLength: 16, maxLength: 160 })
    const safeConversationId = normalizeIdentifier(conversationId, 'conversationId', { minLength: 16, maxLength: 160 })
    const inline = normalizeDataMedia(source)
    const filePath = inline ? '' : normalizeLocalMediaPath(source)
    const mimeType = inline?.mimeType || mediaTypeFor(filePath)
    if (!mimeType || (!inline && !filePath)) return null
    prune()
    const sourceKey = inline
      ? `data:${crypto.createHash('sha256').update(inline.bytes).digest('hex')}`
      : `path:${filePath}`
    const privateKey = `${safeDeviceId}\u0000${safeConversationId}\u0000${sourceKey}`
    const existingId = idsByPrivateKey.get(privateKey)
    const existing = existingId ? refs.get(existingId) : null
    const mediaId = existing?.deviceId === safeDeviceId && existing.conversationId === safeConversationId
      ? existingId
      : crypto.randomBytes(24).toString('base64url')
    const kind = mimeType.startsWith('image/') ? 'image' : mimeType.startsWith('video/') ? 'video' : 'audio'
    if (inline && !existing && memoryBytes() + inline.bytes.length > MAX_MEMORY_MEDIA_BYTES) {
      while (memoryBytes() + inline.bytes.length > MAX_MEMORY_MEDIA_BYTES) {
        const entry = [...refs.entries()].find(([, candidate]) => candidate.buffer)
        if (!entry) break
        remove(entry[0], entry[1])
      }
    }
    refs.set(mediaId, {
      deviceId: safeDeviceId,
      conversationId: safeConversationId,
      filePath,
      ...(inline ? { buffer: inline.bytes } : {}),
      mimeType,
      privateKey,
      ...(inline ? {contentHash: sourceKey.slice(5)} : existing?.contentHash ? {contentHash: existing.contentHash, contentHashMarker: existing.contentHashMarker} : {}),
      expiresAtMs: Date.now() + REF_TTL_MS
    })
    idsByPrivateKey.set(privateKey, mediaId)
    return { mediaId, mimeType, uri: `anywhere-media://${mediaId}?type=${kind}` }
  }

  async function contentHash(entry, stats = null) {
    // Inline buffers are immutable and already content-hashed when registered.
    if (Buffer.isBuffer(entry.buffer)) return entry.contentHash
    const marker = `${stats?.size || 0}:${stats?.mtimeMs || 0}:${stats?.ctimeMs || 0}`
    if (entry.contentHash && entry.contentHashMarker === marker) return entry.contentHash
    const bytes = await fs.readFile(entry.filePath)
    if (!stats || bytes.length !== stats.size || bytes.length < 1 || bytes.length > MAX_MEDIA_BYTES) throw remoteError('remote_media_not_available')
    entry.contentHash = crypto.createHash(MEDIA_VERSION_ALGORITHM).update(bytes).digest('hex')
    entry.contentHashMarker = marker
    return entry.contentHash
  }


  async function get({ deviceId, params = {}, adaptive = false } = {}) {
    if (!params || typeof params !== 'object' || Array.isArray(params) || Object.keys(params).some((key) => !['conversationId', 'mediaId', 'offset', 'length'].includes(key))) {
      throw remoteError('remote_parameter_unknown')
    }
    const safeDeviceId = normalizeIdentifier(deviceId, 'deviceId', { minLength: 16, maxLength: 160 })
    const conversationId = normalizeIdentifier(params.conversationId, 'conversationId', { minLength: 16, maxLength: 160 })
    const mediaId = normalizeIdentifier(params.mediaId, 'mediaId', { minLength: 16, maxLength: 160 })
    const offset = Math.floor(Number(params.offset))
    const length = Math.floor(Number(params.length))
    if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(length) || length < 0 || length > (adaptive ? TRANSFER_MAX_CHUNK_BYTES : MAX_CHUNK_BYTES) || (length === 0 && offset !== 0)) throw remoteError('remote_media_range_invalid')
    prune()
    const entry = refs.get(mediaId)
    if (!entry || entry.deviceId !== safeDeviceId || entry.conversationId !== conversationId) throw remoteError('remote_media_not_found')
    let handle
    try {
      if (Buffer.isBuffer(entry.buffer)) {
        if (entry.buffer.length < 1 || entry.buffer.length > MAX_MEDIA_BYTES || (length > 0 && offset >= entry.buffer.length)) throw remoteError('remote_media_not_available')
        const version = await contentHash(entry)
        const chunk = length === 0 ? Buffer.alloc(0) : entry.buffer.subarray(offset, Math.min(offset + length, entry.buffer.length))
        entry.expiresAtMs = Date.now() + REF_TTL_MS
        return {
          ok: true,
          mediaId,
          ...(adaptive ? {adaptive: true, maxChunkBytes: TRANSFER_MAX_CHUNK_BYTES} : {}),
          mimeType: entry.mimeType,
          totalBytes: entry.buffer.length,
          sha256: version,
          offset,
          byteLength: chunk.length,
          data: chunk.toString('base64url')
        }
      }
      const [stats, linkStats] = await Promise.all([fs.stat(entry.filePath), fs.lstat(entry.filePath)])
      if (linkStats.isSymbolicLink() || !stats.isFile() || stats.size < 1 || stats.size > MAX_MEDIA_BYTES || (length > 0 && offset >= stats.size)) throw remoteError('remote_media_not_available')
      const version = await contentHash(entry, stats)
      const byteLength = length === 0 ? 0 : Math.min(length, stats.size - offset)
      const buffer = Buffer.allocUnsafe(byteLength)
      if (byteLength > 0) {
        handle = await fs.open(entry.filePath, 'r')
        const result = await handle.read(buffer, 0, byteLength, offset)
        if (result.bytesRead !== byteLength) throw remoteError('remote_media_not_available')
      }
      entry.expiresAtMs = Date.now() + REF_TTL_MS
      return {
        ok: true,
        mediaId,
        ...(adaptive ? {adaptive: true, maxChunkBytes: TRANSFER_MAX_CHUNK_BYTES} : {}),
        mimeType: entry.mimeType,
        totalBytes: stats.size,
        sha256: version,
        offset,
        byteLength,
        data: buffer.toString('base64url')
      }
    } catch (error) {
      if (error?.code?.startsWith?.('remote_')) throw error
      throw remoteError('remote_media_not_available')
    } finally {
      await handle?.close().catch(() => {})
    }
  }

  return { register, get, prune }
}
