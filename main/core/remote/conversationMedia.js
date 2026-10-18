import crypto from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'
import { normalizeIdentifier, remoteError } from './protocol.js'

const REF_TTL_MS = 7 * 24 * 60 * 60 * 1000
const MAX_MEDIA_BYTES = 25 * 1024 * 1024
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

/**
 * Holds only short-lived, server-private source paths. A paired device sees
 * random media IDs and byte chunks, never file paths or names.
 */
export function createRemoteConversationMediaService() {
  const refs = new Map()
  const idsByPrivateKey = new Map()

  function prune() {
    const now = Date.now()
    for (const [mediaId, entry] of refs) {
      if (entry.expiresAtMs > now) continue
      refs.delete(mediaId)
      if (idsByPrivateKey.get(entry.privateKey) === mediaId) idsByPrivateKey.delete(entry.privateKey)
    }
    while (refs.size > MAX_REFS) {
      const mediaId = refs.keys().next().value
      const entry = refs.get(mediaId)
      refs.delete(mediaId)
      if (entry && idsByPrivateKey.get(entry.privateKey) === mediaId) idsByPrivateKey.delete(entry.privateKey)
    }
  }

  function register({ deviceId, conversationId, source } = {}) {
    const safeDeviceId = normalizeIdentifier(deviceId, 'deviceId', { minLength: 16, maxLength: 160 })
    const safeConversationId = normalizeIdentifier(conversationId, 'conversationId', { minLength: 16, maxLength: 160 })
    const filePath = normalizeLocalMediaPath(source)
    const mimeType = mediaTypeFor(filePath)
    if (!filePath || !mimeType) return null
    prune()
    const privateKey = `${safeDeviceId}\u0000${safeConversationId}\u0000${filePath}`
    const existingId = idsByPrivateKey.get(privateKey)
    const existing = existingId ? refs.get(existingId) : null
    const mediaId = existing?.deviceId === safeDeviceId && existing.conversationId === safeConversationId
      ? existingId
      : crypto.randomBytes(24).toString('base64url')
    const kind = mimeType.startsWith('image/') ? 'image' : mimeType.startsWith('video/') ? 'video' : 'audio'
    refs.set(mediaId, { deviceId: safeDeviceId, conversationId: safeConversationId, filePath, mimeType, privateKey, expiresAtMs: Date.now() + REF_TTL_MS })
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
