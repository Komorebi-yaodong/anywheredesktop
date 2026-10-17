import crypto from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'
import { decodeBase64Url, normalizeIdentifier, remoteError } from './protocol.js'

export const REMOTE_UPLOAD_MAX_FILE_BYTES = 25 * 1024 * 1024
export const REMOTE_UPLOAD_MAX_DEVICE_BYTES = 64 * 1024 * 1024
export const REMOTE_UPLOAD_MAX_CONCURRENT = 8
export const REMOTE_UPLOAD_MAX_RETAINED = 32
export const REMOTE_UPLOAD_MAX_CHUNK_BYTES = 128 * 1024
export const REMOTE_UPLOAD_TTL_MS = 10 * 60 * 1000

const MIME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9!#$&^_.+-]{0,126}\/[A-Za-z0-9][A-Za-z0-9!#$&^_.+-]{0,126}$/
const CONTROL_PATTERN = /[\u0000-\u001f\u007f]/

function object(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw remoteError('remote_parameter_invalid')
  return value
}

function parameters(value, allowed) {
  const source = object(value)
  for (const key of Object.keys(source)) {
    if (!allowed.includes(key)) throw remoteError('remote_parameter_unknown')
  }
  return source
}

function identifier(value, field) {
  const minLength = field === 'requestId' ? 8 : field === 'windowRef' ? 1 : 16
  return normalizeIdentifier(value, field, { minLength, maxLength: 160 })
}

function normalizeFileName(value) {
  const name = typeof value === 'string' ? value.trim() : ''
  if (
    !name || name === '.' || name === '..' || name.length > 255 ||
    Buffer.byteLength(name, 'utf8') > 255 || CONTROL_PATTERN.test(name) ||
    name.includes('/') || name.includes('\\') || path.basename(name) !== name
  ) {
    throw remoteError('remote_upload_name_invalid')
  }
  return name
}

function normalizeMimeType(value) {
  const mimeType = typeof value === 'string' && value.trim() ? value.trim() : 'application/octet-stream'
  if (mimeType.length > 160 || !MIME_PATTERN.test(mimeType)) throw remoteError('remote_upload_type_invalid')
  return mimeType.toLowerCase()
}

function normalizeSize(value, maximum) {
  const size = Number(value)
  if (!Number.isSafeInteger(size) || size < 1 || size > maximum) throw remoteError('remote_upload_size_invalid')
  return size
}

function normalizeDigest(value) {
  const digest = typeof value === 'string' ? value : ''
  decodeBase64Url(digest, 'sha256', { minBytes: 32, maxBytes: 32 })
  return digest
}

function publicRecord(record, maxChunkBytes) {
  return {
    uploadId: record.uploadId,
    name: record.name,
    type: record.type,
    size: record.size,
    sha256: record.expectedSha256,
    state: record.state,
    receivedBytes: record.receivedBytes,
    nextChunkIndex: record.nextChunkIndex,
    maxChunkBytes,
    expiresAt: new Date(record.expiresAtMs).toISOString()
  }
}

/**
 * Owns application-layer encrypted Remote attachment staging.
 * Caller-controlled paths are never accepted or returned.
 */
export function createRemoteUploadManager({
  tempRoot,
  getTempRoot,
  now = () => Date.now(),
  randomBytes = crypto.randomBytes,
  maxFileBytes = REMOTE_UPLOAD_MAX_FILE_BYTES,
  maxDeviceBytes = REMOTE_UPLOAD_MAX_DEVICE_BYTES,
  maxConcurrent = REMOTE_UPLOAD_MAX_CONCURRENT,
  maxRetained = REMOTE_UPLOAD_MAX_RETAINED,
  maxChunkBytes = REMOTE_UPLOAD_MAX_CHUNK_BYTES,
  ttlMs = REMOTE_UPLOAD_TTL_MS,
  cleanupIntervalMs = Math.min(60 * 1000, REMOTE_UPLOAD_TTL_MS)
} = {}) {
  if ((!tempRoot || typeof tempRoot !== 'string') && typeof getTempRoot !== 'function') {
    throw new Error('remote_upload_temp_root_required')
  }
  for (const [field, value] of Object.entries({ maxFileBytes, maxDeviceBytes, maxConcurrent, maxRetained, maxChunkBytes, ttlMs })) {
    if (!Number.isSafeInteger(value) || value < 1) throw new Error(`remote_upload_${field}_invalid`)
  }

  const uploads = new Map()
  const beginRequests = new Map()
  let root = ''
  let initialized = false
  let initializePromise = null
  let cleanupTimer = null
  let cleanupPromise = null
  let stopPromise = null
  let stopped = false
  let operationTail = Promise.resolve()

  function runOperation(operation) {
    const execute = async () => {
      if (stopped) throw remoteError('remote_gateway_stopped')
      return operation()
    }
    const result = operationTail.then(execute, execute)
    operationTail = result.catch(() => {})
    return result
  }


  function resolveRoot() {
    const configured = typeof getTempRoot === 'function' ? getTempRoot() : tempRoot
    if (typeof configured !== 'string' || !configured.trim()) throw new Error('remote_upload_temp_root_required')
    return path.resolve(configured)
  }

  async function initialize() {
    if (initialized && !stopped) return { ok: true }
    if (initializePromise) return initializePromise
    stopped = true
    initialized = false
    initializePromise = (async () => {
      if (stopPromise) await stopPromise.catch(() => {})
      await operationTail.catch(() => {})
      root = resolveRoot()
      await fs.rm(root, { recursive: true, force: true })
      await fs.mkdir(root, { recursive: true, mode: 0o700 })
      initialized = true
      stopped = false
      if (!cleanupTimer) {
        cleanupTimer = setInterval(() => { runOperation(cleanupExpired).catch(() => {}) }, Math.max(1000, cleanupIntervalMs))
        cleanupTimer.unref?.()
      }
      return { ok: true }
    })().finally(() => { initializePromise = null })
    return initializePromise
  }

  async function ensureInitialized() {
    if (!initialized) await initialize()
  }

  function deviceRecords(deviceId) {
    return [...uploads.values()].filter((record) => record.deviceId === deviceId)
  }

  function getOwnedRecord(deviceId, uploadId) {
    const safeDeviceId = identifier(deviceId, 'deviceId')
    const safeUploadId = identifier(uploadId, 'uploadId')
    const record = uploads.get(safeUploadId)
    if (!record || record.deviceId !== safeDeviceId) throw remoteError('remote_upload_not_found')
    if (record.expiresAtMs <= now() && !record.reservation) throw remoteError('remote_upload_expired')
    return record
  }

  async function removeRecord(record) {
    if (!record) return false
    uploads.delete(record.uploadId)
    if (record.beginRequestKey) beginRequests.delete(record.beginRequestKey)
    record.state = 'removed'
    record.hash = null
    await fs.rm(record.filePath, { force: true }).catch(() => {})
    return true
  }

  async function cleanupExpired() {
    if (cleanupPromise) return cleanupPromise
    cleanupPromise = (async () => {
      const current = now()
      const expired = [...uploads.values()].filter((record) => !Number.isFinite(record.expiresAtMs) || record.expiresAtMs <= current && !record.reservation)
      await Promise.all(expired.map((record) => removeRecord(record)))
      return { ok: true, removed: expired.length }
    })().finally(() => { cleanupPromise = null })
    return cleanupPromise
  }

  function touch(record) {
    record.expiresAtMs = now() + ttlMs
  }

  async function begin({ deviceId, requestId, params = {} } = {}) {
    await ensureInitialized()
    await cleanupExpired()
    const source = parameters(params, ['name', 'type', 'size', 'sha256'])
    const safeDeviceId = identifier(deviceId, 'deviceId')
    const safeRequestId = identifier(requestId, 'requestId')
    const name = normalizeFileName(source.name)
    const type = normalizeMimeType(source.type)
    const size = normalizeSize(source.size, maxFileBytes)
    const expectedSha256 = normalizeDigest(source.sha256)
    const beginRequestKey = `${safeDeviceId}:${safeRequestId}`
    const beginFingerprint = crypto.createHash('sha256').update(JSON.stringify({ name, type, size, sha256: expectedSha256 })).digest('hex')
    const previousUploadId = beginRequests.get(beginRequestKey)
    if (previousUploadId) {
      const previous = uploads.get(previousUploadId)
      if (!previous) beginRequests.delete(beginRequestKey)
      else {
        if (previous.beginFingerprint !== beginFingerprint) throw remoteError('remote_request_id_conflict')
        touch(previous)
        return { ok: true, upload: publicRecord(previous, maxChunkBytes), duplicate: true }
      }
    }
    const current = deviceRecords(safeDeviceId)
    if (current.length >= maxRetained) throw remoteError('remote_upload_count_exceeded')
    if (current.filter((record) => record.state === 'uploading').length >= maxConcurrent) {
      throw remoteError('remote_upload_concurrency_exceeded')
    }
    const reservedBytes = current.reduce((total, record) => total + record.size, 0)
    if (reservedBytes + size > maxDeviceBytes) throw remoteError('remote_upload_quota_exceeded')

    let uploadId = ''
    do uploadId = randomBytes(24).toString('base64url')
    while (uploads.has(uploadId))
    const filePath = path.join(root, `${uploadId}.part`)
    await fs.writeFile(filePath, Buffer.alloc(0), { flag: 'wx', mode: 0o600 })
    const record = {
      uploadId,
      deviceId: safeDeviceId,
      beginRequestKey,
      beginFingerprint,
      name,
      type,
      size,
      expectedSha256,
      computedSha256: '',
      state: 'uploading',
      receivedBytes: 0,
      nextChunkIndex: 0,
      lastChunk: null,
      hash: crypto.createHash('sha256'),
      filePath,
      expiresAtMs: now() + ttlMs,
      busy: false,
      authorization: null
    }
    uploads.set(uploadId, record)
    beginRequests.set(beginRequestKey, uploadId)
    return { ok: true, upload: publicRecord(record, maxChunkBytes) }
  }

  async function chunk({ deviceId, params = {} } = {}) {
    await ensureInitialized()
    await cleanupExpired()
    const source = parameters(params, ['uploadId', 'index', 'data'])
    const record = getOwnedRecord(deviceId, source.uploadId)
    if (record.state !== 'uploading') throw remoteError('remote_upload_state_invalid')
    const index = Number(source.index)
    if (!Number.isSafeInteger(index) || index < 0) throw remoteError('remote_upload_chunk_order_invalid')
    const data = decodeBase64Url(source.data, 'data', { minBytes: 1, maxBytes: maxChunkBytes })
    if (index === record.nextChunkIndex - 1 && record.lastChunk?.index === index) {
      const chunkSha256 = crypto.createHash('sha256').update(data).digest('base64url')
      if (record.lastChunk.size !== data.length || record.lastChunk.sha256 !== chunkSha256) {
        throw remoteError('remote_upload_chunk_conflict')
      }
      touch(record)
      return { ok: true, upload: publicRecord(record, maxChunkBytes), duplicate: true }
    }
    if (index !== record.nextChunkIndex) throw remoteError('remote_upload_chunk_order_invalid')
    if (record.receivedBytes + data.length > record.size) {
      await removeRecord(record)
      throw remoteError('remote_upload_size_mismatch')
    }
    if (record.busy) throw remoteError('remote_upload_busy')
    record.busy = true
    try {
      await fs.appendFile(record.filePath, data)
      record.hash.update(data)
      record.receivedBytes += data.length
      record.lastChunk = {
        index,
        size: data.length,
        sha256: crypto.createHash('sha256').update(data).digest('base64url')
      }
      record.nextChunkIndex += 1
      touch(record)
      return { ok: true, upload: publicRecord(record, maxChunkBytes) }
    } catch (error) {
      await removeRecord(record)
      if (error?.code?.startsWith?.('remote_')) throw error
      throw remoteError('remote_upload_write_failed')
    } finally {
      record.busy = false
    }
  }

  async function complete({ deviceId, params = {} } = {}) {
    await ensureInitialized()
    await cleanupExpired()
    const source = parameters(params, ['uploadId'])
    const record = getOwnedRecord(deviceId, source.uploadId)
    if (record.state === 'completed') return { ok: true, upload: publicRecord(record, maxChunkBytes), duplicate: true }
    if (record.state !== 'uploading' || record.busy) throw remoteError('remote_upload_state_invalid')
    if (record.receivedBytes !== record.size) {
      await removeRecord(record)
      throw remoteError('remote_upload_size_mismatch')
    }
    const computedSha256 = record.hash.digest('base64url')
    record.hash = null
    if (computedSha256 !== record.expectedSha256) {
      await removeRecord(record)
      throw remoteError('remote_upload_integrity_failed')
    }
    record.computedSha256 = computedSha256
    record.state = 'completed'
    touch(record)
    return { ok: true, upload: publicRecord(record, maxChunkBytes) }
  }

  async function abort({ deviceId, params = {} } = {}) {
    await ensureInitialized()
    await cleanupExpired()
    const source = parameters(params, ['uploadId'])
    const record = getOwnedRecord(deviceId, source.uploadId)
    await removeRecord(record)
    return { ok: true, uploadId: record.uploadId }
  }

  async function reserveForRequest({deviceId, requestId, uploadIds = []}) {
    await ensureInitialized()
    await cleanupExpired()
    const device = identifier(deviceId, 'deviceId'), request = identifier(requestId, 'requestId')
    if (!Array.isArray(uploadIds) || uploadIds.length > 16 || new Set(uploadIds).size !== uploadIds.length) throw remoteError('remote_upload_ids_invalid')
    const records = uploadIds.map(uploadId => getOwnedRecord(device, uploadId))
    if (records.some(record => record.state !== 'completed' || record.authorization || record.reservation && record.reservation.requestId !== request)) throw remoteError('remote_upload_unavailable')
    for (const record of records) {record.reservation = {deviceId: device, requestId: request}; touch(record)}
    return {ok: true}
  }
  async function releaseReservation({deviceId, requestId}) {
    for (const record of uploads.values()) if (record.reservation?.deviceId === deviceId && record.reservation.requestId === requestId) {record.reservation = null; touch(record)}
    return {ok: true}
  }


  async function authorizeForRequest({ deviceId, requestId, windowRef, uploadIds = [] } = {}) {
    await ensureInitialized()
    await cleanupExpired()
    const safeDeviceId = identifier(deviceId, 'deviceId')
    const safeRequestId = identifier(requestId, 'requestId')
    const safeWindowRef = identifier(windowRef, 'windowRef')
    if (!Array.isArray(uploadIds) || uploadIds.length > 16) throw remoteError('remote_upload_ids_invalid')
    const normalizedIds = uploadIds.map((uploadId) => identifier(uploadId, 'uploadId'))
    if (new Set(normalizedIds).size !== normalizedIds.length) throw remoteError('remote_upload_ids_invalid')
    const records = normalizedIds.map((uploadId) => getOwnedRecord(safeDeviceId, uploadId))
    for (const record of records) {
      if (record.state !== 'completed' || record.authorization || record.reservation && record.reservation.requestId !== safeRequestId) throw remoteError('remote_upload_unavailable')
    }
    for (const record of records) {
      record.reservation = null
      record.authorization = { deviceId: safeDeviceId, requestId: safeRequestId, windowRef: safeWindowRef }
      touch(record)
    }
    return records.map((record) => ({ uploadId: record.uploadId, name: record.name, type: record.type, size: record.size }))
  }

  async function releaseRequest({ deviceId, requestId, windowRef } = {}) {
    const safeDeviceId = identifier(deviceId, 'deviceId')
    const safeRequestId = identifier(requestId, 'requestId')
    const safeWindowRef = windowRef ? identifier(windowRef, 'windowRef') : ''
    let released = 0
    for (const record of uploads.values()) {
      const authorization = record.authorization
      if (!authorization || authorization.deviceId !== safeDeviceId || authorization.requestId !== safeRequestId) continue
      if (safeWindowRef && authorization.windowRef !== safeWindowRef) continue
      record.authorization = null
      touch(record)
      released += 1
    }
    return { ok: true, released }
  }

  async function cleanupRequest({ deviceId, requestId, windowRef } = {}) {
    const safeDeviceId = identifier(deviceId, 'deviceId')
    const safeRequestId = identifier(requestId, 'requestId')
    const safeWindowRef = windowRef ? identifier(windowRef, 'windowRef') : ''
    const records = [...uploads.values()].filter((record) => {
      const authorization = record.authorization
      return authorization && authorization.deviceId === safeDeviceId && authorization.requestId === safeRequestId &&
        (!safeWindowRef || authorization.windowRef === safeWindowRef)
    })
    await Promise.all(records.map((record) => removeRecord(record)))
    return { ok: true, removed: records.length }
  }

  async function consumeForRenderer({ windowRef, requestId, uploadId } = {}) {
    await ensureInitialized()
    await cleanupExpired()
    const safeWindowRef = identifier(windowRef, 'windowRef')
    const safeRequestId = identifier(requestId, 'requestId')
    const safeUploadId = identifier(uploadId, 'uploadId')
    const record = uploads.get(safeUploadId)
    const authorization = record?.authorization
    if (
      !record || record.state !== 'completed' || !authorization ||
      authorization.windowRef !== safeWindowRef || authorization.requestId !== safeRequestId
    ) {
      throw remoteError('remote_upload_not_authorized')
    }
    if (record.busy) throw remoteError('remote_upload_busy')
    record.busy = true
    try {
      const data = await fs.readFile(record.filePath)
      const digest = crypto.createHash('sha256').update(data).digest('base64url')
      if (data.length !== record.size || digest !== record.expectedSha256) {
        throw remoteError('remote_upload_integrity_failed')
      }
      const result = {
        uploadId: record.uploadId,
        name: record.name,
        type: record.type,
        size: record.size,
        base64: data.toString('base64')
      }
      await removeRecord(record)
      return result
    } catch (error) {
      await removeRecord(record)
      if (error?.code?.startsWith?.('remote_')) throw error
      throw remoteError('remote_upload_read_failed')
    } finally {
      record.busy = false
    }
  }

  async function cleanupDevice(deviceId) {
    const safeDeviceId = identifier(deviceId, 'deviceId')
    const records = [...uploads.values()].filter((record) => record.deviceId === safeDeviceId)
    await Promise.all(records.map((record) => removeRecord(record)))
    return { ok: true, removed: records.length }
  }

  async function cleanupWindow(windowRef) {
    const safeWindowRef = identifier(windowRef, 'windowRef')
    const records = [...uploads.values()].filter((record) => record.authorization?.windowRef === safeWindowRef)
    await Promise.all(records.map((record) => removeRecord(record)))
    return { ok: true, removed: records.length }
  }

  async function queued(operation) {
    if (!initialized) {
      if (initializePromise) await initializePromise
      else {
        if (stopped) throw remoteError('remote_gateway_stopped')
        await initialize()
      }
    }
    return runOperation(operation)
  }

  function stop() {
    if (stopPromise) return stopPromise
    stopped = true
    if (cleanupTimer) clearInterval(cleanupTimer)
    cleanupTimer = null
    stopPromise = (async () => {
      if (initializePromise) await initializePromise.catch(() => {})
      stopped = true
      await operationTail.catch(() => {})
      const records = [...uploads.values()]
      await Promise.all(records.map((record) => removeRecord(record)))
      uploads.clear()
      beginRequests.clear()
      if (root) await fs.rm(root, { recursive: true, force: true }).catch(() => {})
      initialized = false
      return { ok: true, removed: records.length }
    })().finally(() => { stopPromise = null })
    return stopPromise
  }

  return {
    initialize,
    begin: (input) => queued(() => begin(input)),
    chunk: (input) => queued(() => chunk(input)),
    complete: (input) => queued(() => complete(input)),
    abort: (input) => queued(() => abort(input)),
    reserveForRequest: input => queued(() => reserveForRequest(input)),
    releaseReservation: input => queued(() => releaseReservation(input)),

    authorizeForRequest: (input) => queued(() => authorizeForRequest(input)),
    releaseRequest: (input) => queued(() => releaseRequest(input)),
    cleanupRequest: (input) => queued(() => cleanupRequest(input)),
    consumeForRenderer: (input) => queued(() => consumeForRenderer(input)),
    cleanupDevice: (deviceId) => queued(() => cleanupDevice(deviceId)),
    cleanupWindow: (windowRef) => queued(() => cleanupWindow(windowRef)),
    cleanupExpired: () => queued(cleanupExpired),
    stop,
    getUpload: (uploadId) => {
      const record = uploads.get(uploadId)
      return record ? publicRecord(record, maxChunkBytes) : null
    }
  }
}
