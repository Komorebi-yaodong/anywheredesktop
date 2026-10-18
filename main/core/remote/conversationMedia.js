import crypto from 'node:crypto'
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

const MEDIA_TYPES = new Map([
  ['.png', 'image/png'], ['.jpg', 'image/jpeg'], ['.jpeg', 'image/jpeg'], ['.webp', 'image/webp'], ['.gif', 'image/gif'],
  ['.mp4', 'video/mp4'], ['.webm', 'video/webm'], ['.mov', 'video/quicktime'], ['.m4v', 'video/x-m4v'],
  ['.mp3', 'audio/mpeg'], ['.wav', 'audio/wav'], ['.m4a', 'audio/mp4'], ['.aac', 'audio/aac'], ['.ogg', 'audio/ogg'], ['.webm', 'video/webm']
])

function mediaTypeFor(filePath = '') {
  return MEDIA_TYPES.get(path.extname(filePath).toLowerCase()) || ''
}

function normalizeLocalMediaPath(value = '') {
  const source = typeof value === 'string' ? value.trim() : ''
  if (!source || source.length > 4096) return ''
  // Renderer history may contain file:///C:/..., file://C:/..., or file:C:/...
  // forms. Normalize them only inside Desktop before issuing an opaque media ID.
  const decoded = (() => {
    try { return decodeURIComponent(source) } catch { return '' }
  })()
  if (!decoded) return ''
  const local = /^file:/i.test(decoded)
    ? decoded.replace(/^file:(?:\/\/)?/i, '').replace(/^\//, '')
    : decoded
  return /^[A-Za-z]:[\\/]/.test(local) ? local : ''
}


function normalizeDataImage(value = '') {
  const source = typeof value === 'string' ? value.trim() : ''
  const match = /^data:(image\/(?:png|jpe?g|webp|gif));base64,([A-Za-z0-9+/=\r\n]+)$/i.exec(source)
  if (!match) return null
  const bytes = Buffer.from(match[2].replace(/\s+/g, ''), 'base64')
  if (bytes.length < 1 || bytes.length > MAX_MEDIA_BYTES) return null
  return { mimeType: match[1].toLowerCase(), bytes }
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
    const inline = normalizeDataImage(source)
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
      expiresAtMs: Date.now() + REF_TTL_MS
    })
    idsByPrivateKey.set(privateKey, mediaId)
    return { mediaId, mimeType, uri: `anywhere-media://${mediaId}?type=${kind}` }
  }

  async function get({ deviceId, params = {} } = {}) {
    if (!params || typeof params !== 'object' || Array.isArray(params) || Object.keys(params).some((key) => !['conversationId', 'mediaId', 'offset', 'length'].includes(key))) {
      throw remoteError('remote_parameter_unknown')
    }
    const safeDeviceId = normalizeIdentifier(deviceId, 'deviceId', { minLength: 16, maxLength: 160 })
    const conversationId = normalizeIdentifier(params.conversationId, 'conversationId', { minLength: 16, maxLength: 160 })
    const mediaId = normalizeIdentifier(params.mediaId, 'mediaId', { minLength: 16, maxLength: 160 })
    const offset = Math.floor(Number(params.offset))
    const length = Math.floor(Number(params.length))
    if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(length) || length < 1 || length > MAX_CHUNK_BYTES) throw remoteError('remote_media_range_invalid')
    prune()
    const entry = refs.get(mediaId)
    if (!entry || entry.deviceId !== safeDeviceId || entry.conversationId !== conversationId) throw remoteError('remote_media_not_found')
    let handle
    try {
      if (Buffer.isBuffer(entry.buffer)) {
        if (entry.buffer.length < 1 || entry.buffer.length > MAX_MEDIA_BYTES || offset >= entry.buffer.length) throw remoteError('remote_media_not_available')
        const chunk = entry.buffer.subarray(offset, Math.min(offset + length, entry.buffer.length))
        entry.expiresAtMs = Date.now() + REF_TTL_MS
        return {
          ok: true,
          mediaId,
          mimeType: entry.mimeType,
          totalBytes: entry.buffer.length,
          offset,
          byteLength: chunk.length,
          data: chunk.toString('base64url')
        }
      }
      const [stats, linkStats] = await Promise.all([fs.stat(entry.filePath), fs.lstat(entry.filePath)])
      if (linkStats.isSymbolicLink() || !stats.isFile() || stats.size < 1 || stats.size > MAX_MEDIA_BYTES || offset >= stats.size) throw remoteError('remote_media_not_available')
      const byteLength = Math.min(length, stats.size - offset)
      const buffer = Buffer.allocUnsafe(byteLength)
      handle = await fs.open(entry.filePath, 'r')
      const result = await handle.read(buffer, 0, byteLength, offset)
      if (result.bytesRead !== byteLength) throw remoteError('remote_media_not_available')
      entry.expiresAtMs = Date.now() + REF_TTL_MS
      return {
        ok: true,
        mediaId,
        mimeType: entry.mimeType,
        totalBytes: stats.size,
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
