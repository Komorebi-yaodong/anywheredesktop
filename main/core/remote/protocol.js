import crypto from 'node:crypto'

export const REMOTE_PROTOCOL_VERSION = 2
export const REMOTE_PAIRING_PATH = '/api/v2/pair'
export const REMOTE_SOCKET_PATH = '/api/v2/socket'
export const REMOTE_HEALTH_PATH = '/health'
export const REMOTE_DEFAULT_PORT = 17860
export const REMOTE_PAIRING_TTL_MS = 2 * 60 * 1000
export const REMOTE_MAX_DEVICES = 20
export const REMOTE_MAX_FRAME_BYTES = 256 * 1024
export const REMOTE_MAX_REQUEST_BYTES = 128 * 1024

const BASE64URL_PATTERN = /^[A-Za-z0-9_-]+$/
const SAFE_IDENTIFIER_PATTERN = /^[A-Za-z0-9._:-]+$/

export class RemoteProtocolError extends Error {
  constructor(code, message = code) {
    super(message)
    this.name = 'RemoteProtocolError'
    this.code = code
  }
}

export function remoteError(code, message = code) {
  return new RemoteProtocolError(code, message)
}

export function encodeBase64Url(value) {
  return Buffer.from(value).toString('base64url')
}

export function decodeBase64Url(value, field = 'base64url', { minBytes = 1, maxBytes = 1024 * 1024 } = {}) {
  if (typeof value !== 'string' || !BASE64URL_PATTERN.test(value)) {
    throw remoteError('remote_invalid_base64url', `${field} must be an unpadded base64url string`)
  }

  const decoded = Buffer.from(value, 'base64url')
  if (decoded.length < minBytes || decoded.length > maxBytes || decoded.toString('base64url') !== value) {
    throw remoteError('remote_invalid_base64url', `${field} has an invalid byte length or encoding`)
  }

  return decoded
}

export function randomBase64Url(bytes = 32) {
  const size = Number(bytes)
  if (!Number.isInteger(size) || size < 16 || size > 4096) {
    throw remoteError('remote_random_size_invalid')
  }
  return crypto.randomBytes(size).toString('base64url')
}

export function sha256Base64Url(value) {
  return crypto.createHash('sha256').update(value).digest('base64url')
}

export function timingSafeEqualBase64Url(left, right) {
  try {
    const leftBuffer = decodeBase64Url(left, 'left')
    const rightBuffer = decodeBase64Url(right, 'right')
    return leftBuffer.length === rightBuffer.length && crypto.timingSafeEqual(leftBuffer, rightBuffer)
  } catch {
    return false
  }
}

export function normalizeIdentifier(value, field = 'identifier', { minLength = 1, maxLength = 160 } = {}) {
  const normalized = typeof value === 'string' ? value.trim() : ''
  if (
    normalized.length < minLength ||
    normalized.length > maxLength ||
    !SAFE_IDENTIFIER_PATTERN.test(normalized)
  ) {
    throw remoteError('remote_identifier_invalid', `${field} is invalid`)
  }
  return normalized
}

export function normalizeDisplayName(value, fallback = '移动设备') {
  const normalized = typeof value === 'string' ? value.trim().replace(/\s+/g, ' ') : ''
  return (normalized || fallback).slice(0, 80)
}

export function normalizePlatform(value) {
  const normalized = typeof value === 'string' ? value.trim().replace(/\s+/g, ' ') : ''
  return (normalized || 'unknown').slice(0, 40)
}

export function normalizeAppVersion(value) {
  const normalized = typeof value === 'string' ? value.trim().replace(/\s+/g, ' ') : ''
  return normalized.slice(0, 80)
}

export function normalizeRemoteEndpoint(value, field = 'endpoint') {
  let url
  try {
    url = new URL(String(value || '').trim())
  } catch {
    throw remoteError('remote_endpoint_invalid', `${field} must be an HTTPS URL`)
  }

  if (url.protocol !== 'https:' || !url.hostname || url.username || url.password || url.search || url.hash) {
    throw remoteError('remote_endpoint_invalid', `${field} must be an HTTPS origin without credentials, query, or fragment`)
  }

  const pathname = url.pathname.replace(/\/$/, '')
  return `${url.protocol}//${url.host}${pathname}`
}

export function normalizePort(value, fallback = REMOTE_DEFAULT_PORT) {
  const port = Number(value)
  return Number.isInteger(port) && port >= 1024 && port <= 65535 ? port : fallback
}

export function normalizeHost(value, fallback = '0.0.0.0') {
  const host = typeof value === 'string' ? value.trim() : ''
  return host || fallback
}

export function stableStringify(value) {
  if (value === null) return 'null'

  const type = typeof value
  if (type === 'string') return JSON.stringify(value)
  if (type === 'boolean') return value ? 'true' : 'false'
  if (type === 'number') {
    if (!Number.isFinite(value)) throw remoteError('remote_canonical_value_invalid')
    return JSON.stringify(value)
  }
  if (type === 'bigint' || type === 'undefined' || type === 'function' || type === 'symbol') {
    throw remoteError('remote_canonical_value_invalid')
  }

  if (Array.isArray(value)) {
    return `[${value.map((item) => stableStringify(item)).join(',')}]`
  }

  if (type === 'object') {
    const entries = Object.entries(value)
      .filter(([, item]) => item !== undefined)
      .sort(([left], [right]) => left.localeCompare(right))
    return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${stableStringify(item)}`).join(',')}}`
  }

  throw remoteError('remote_canonical_value_invalid')
}

export function canonicalBuffer(value) {
  return Buffer.from(stableStringify(value), 'utf8')
}

export function parseJsonBuffer(buffer, { maxBytes = REMOTE_MAX_REQUEST_BYTES, code = 'remote_invalid_json' } = {}) {
  if (!Buffer.isBuffer(buffer)) throw remoteError(code)
  if (buffer.length === 0 || buffer.length > maxBytes) throw remoteError('remote_payload_size_invalid')

  try {
    const parsed = JSON.parse(buffer.toString('utf8'))
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw remoteError(code)
    return parsed
  } catch (error) {
    if (error instanceof RemoteProtocolError) throw error
    throw remoteError(code)
  }
}

export function parsePlainJson(value, { maxBytes = REMOTE_MAX_REQUEST_BYTES, code = 'remote_invalid_json' } = {}) {
  if (typeof value !== 'string') throw remoteError(code)
  return parseJsonBuffer(Buffer.from(value, 'utf8'), { maxBytes, code })
}

export function normalizeSequence(value) {
  const sequence = Number(value)
  if (!Number.isSafeInteger(sequence) || sequence < 1) {
    throw remoteError('remote_sequence_invalid')
  }
  return sequence
}

export function buildFrameAad({ sessionId, sequence, direction }) {
  const safeSessionId = normalizeIdentifier(sessionId, 'sessionId', { minLength: 16, maxLength: 128 })
  const safeSequence = normalizeSequence(sequence)
  if (direction !== 'client-to-desktop' && direction !== 'desktop-to-client') {
    throw remoteError('remote_frame_direction_invalid')
  }

  return canonicalBuffer({
    v: REMOTE_PROTOCOL_VERSION,
    type: 'remote.encrypted',
    sessionId: safeSessionId,
    sequence: safeSequence,
    direction
  })
}

export function normalizeRemoteDevice(input = {}) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw remoteError('remote_device_invalid')
  }

  const deviceId = normalizeIdentifier(input.deviceId, 'deviceId', { minLength: 16, maxLength: 160 })
  const publicKey = typeof input.publicKey === 'string' ? input.publicKey.trim() : ''
  decodeBase64Url(publicKey, 'device.publicKey', { minBytes: 65, maxBytes: 65 })

  return {
    deviceId,
    displayName: normalizeDisplayName(input.displayName),
    platform: normalizePlatform(input.platform),
    appVersion: normalizeAppVersion(input.appVersion),
    publicKey
  }
}

export function normalizeRemoteSettings(config = {}) {
  const source = config?.remote && typeof config.remote === 'object' && !Array.isArray(config.remote)
    ? config.remote
    : {}
  const publicEndpoint = typeof source.publicEndpoint === 'string' && source.publicEndpoint.trim()
    ? normalizeRemoteEndpoint(source.publicEndpoint, 'publicEndpoint')
    : ''

  return {
    enabled: source.enabled === true,
    host: normalizeHost(source.host),
    port: normalizePort(source.port),
    publicEndpoint
  }
}

export function sanitizeRemoteSettingsForConfig(settings = {}) {
  const normalized = normalizeRemoteSettings({ remote: settings })
  return {
    enabled: normalized.enabled,
    host: normalized.host,
    port: normalized.port,
    publicEndpoint: normalized.publicEndpoint
  }
}
