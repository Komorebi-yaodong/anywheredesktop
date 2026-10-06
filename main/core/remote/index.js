import crypto from 'node:crypto'
import https from 'node:https'
import os from 'node:os'
import QRCode from 'qrcode'
import selfsigned from 'selfsigned'
import { WebSocketServer } from 'ws'
import {
  REMOTE_DEFAULT_PORT,
  REMOTE_HEALTH_PATH,
  REMOTE_MAX_DEVICES,
  REMOTE_MAX_FRAME_BYTES,
  REMOTE_MAX_REQUEST_BYTES,
  REMOTE_PAIRING_PATH,
  REMOTE_PAIRING_TTL_MS,
  REMOTE_PROTOCOL_VERSION,
  REMOTE_SOCKET_PATH,
  decodeBase64Url,
  normalizeDisplayName,
  normalizeIdentifier,
  normalizeRemoteDevice,
  normalizeRemoteSettings,
  parseJsonBuffer,
  randomBase64Url,
  remoteError,
  sanitizeRemoteSettingsForConfig,
  sha256Base64Url,
  timingSafeEqualBase64Url
} from './protocol.js'
import {
  acceptSessionHello,
  createDesktopPairingResponse,
  createP256KeyPair,
  openDesktopPairingStart,
  publicKeyFromPrivate,
  verifyPairingProof
} from './cryptoSession.js'

const IDENTITY_STORAGE_KEY = 'remote:v2:identity'
const TLS_STORAGE_KEY = 'remote:v2:tls'
const DEVICES_STORAGE_KEY = 'remote:v2:devices'
const AUDIT_STORAGE_KEY = 'remote:v2:audit'
const PAIR_ATTEMPT_TTL_MS = 90 * 1000
const HANDSHAKE_TIMEOUT_MS = 12 * 1000
const MAX_AUDIT_ENTRIES = 200
const MAX_PAIRING_FAILURES = 5
const MAX_PAIRING_ATTEMPTS_PER_CODE = 4
const MAX_UNAUTHENTICATED_SOCKETS = 32
const MAX_AUTHENTICATED_SOCKETS = REMOTE_MAX_DEVICES * 2
const SESSION_HELLO_REPLAY_TTL_MS = 10 * 60 * 1000

function clone(value) {
  return JSON.parse(JSON.stringify(value))
}

function nowIso() {
  return new Date().toISOString()
}

function isOpen(socket) {
  return Boolean(socket) && socket.readyState === 1
}

function safeSocketClose(socket, code = 1000, reason = '') {
  if (!socket) return
  try {
    socket.close(code, reason.slice(0, 120))
  } catch {
    try {
      socket.terminate()
    } catch {
      // ignore close races
    }
  }
}

function getLanIpv4Addresses() {
  const addresses = new Set()
  for (const items of Object.values(os.networkInterfaces())) {
    for (const item of items || []) {
      if (!item || item.family !== 'IPv4' || item.internal || !item.address) continue
      if (item.address.startsWith('169.254.')) continue
      addresses.add(item.address)
    }
  }
  return [...addresses].sort((left, right) => left.localeCompare(right, undefined, { numeric: true }))
}

function normalizeFingerprint(value = '') {
  const normalized = String(value || '').replace(/[^a-fA-F0-9]/g, '').toUpperCase()
  if (!/^[A-F0-9]{64}$/.test(normalized)) throw remoteError('remote_certificate_invalid')
  return normalized
}

function certificateFingerprint(cert = '') {
  const parsed = new crypto.X509Certificate(cert)
  return normalizeFingerprint(parsed.fingerprint256)
}

function createStoppedRuntime() {
  return {
    running: false,
    enabled: false,
    host: '0.0.0.0',
    port: REMOTE_DEFAULT_PORT,
    publicEndpoint: '',
    endpoints: [],
    certificateFingerprint: '',
    desktopId: '',
    desktopPublicKey: '',
    lastError: '',
    startedAt: '',
    protocolVersion: REMOTE_PROTOCOL_VERSION
  }
}

function buildEndpoints(settings = {}) {
  const endpoints = []
  if (settings.publicEndpoint) endpoints.push(settings.publicEndpoint)

  const hosts = settings.host === '0.0.0.0' || settings.host === '::'
    ? getLanIpv4Addresses()
    : [settings.host]
  for (const host of hosts) {
    const endpoint = `https://${host}:${settings.port}`
    if (!endpoints.includes(endpoint)) endpoints.push(endpoint)
  }
  return endpoints
}

function statusErrorCode(error) {
  if (error?.code === 'EADDRINUSE') return 'remote_port_in_use'
  if (typeof error?.code === 'string' && error.code.startsWith('remote_')) return error.code
  return 'remote_start_failed'
}

function validatePairingCode(value) {
  const code = typeof value === 'string' ? value.replace(/\s/g, '') : ''
  if (!/^\d{6}$/.test(code)) throw remoteError('remote_pairing_invalid')
  return code
}

function normalizePairingStartInput(input = {}) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw remoteError('remote_pairing_start_invalid')
  if (input.type !== 'remote.pair.start' || Number(input.v) !== REMOTE_PROTOCOL_VERSION) {
    throw remoteError('remote_pairing_start_invalid')
  }
  return {
    v: REMOTE_PROTOCOL_VERSION,
    type: 'remote.pair.start',
    pairingId: normalizeIdentifier(input.pairingId, 'pairingId', { minLength: 16, maxLength: 160 }),
    clientEphemeralPublicKey: typeof input.clientEphemeralPublicKey === 'string' ? input.clientEphemeralPublicKey.trim() : '',
    nonce: typeof input.nonce === 'string' ? input.nonce : '',
    ciphertext: typeof input.ciphertext === 'string' ? input.ciphertext : '',
    tag: typeof input.tag === 'string' ? input.tag : ''
  }
}

function normalizePairingConfirmation(input = {}) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw remoteError('remote_pairing_invalid')
  if (Number(input.v) !== REMOTE_PROTOCOL_VERSION) throw remoteError('remote_protocol_version_unsupported')
  return {
    pairingId: normalizeIdentifier(input.pairingId, 'pairingId', { minLength: 16, maxLength: 160 }),
    pairingAttemptId: normalizeIdentifier(input.pairingAttemptId, 'pairingAttemptId', { minLength: 16, maxLength: 160 }),
    deviceId: normalizeIdentifier(input.deviceId, 'deviceId', { minLength: 16, maxLength: 160 }),
    deviceProof: typeof input.deviceProof === 'string' ? input.deviceProof.trim() : ''
  }
}

function parsePlainSocketMessage(raw) {
  const data = Buffer.isBuffer(raw) ? raw : Buffer.from(raw)
  return parseJsonBuffer(data, { maxBytes: REMOTE_MAX_FRAME_BYTES, code: 'remote_socket_message_invalid' })
}

function createJsonResponse(response, statusCode, payload) {
  const text = JSON.stringify(payload)
  response.writeHead(statusCode, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store, max-age=0',
    'Content-Length': Buffer.byteLength(text)
  })
  response.end(text)
}

function createHttpError(response, error, fallback = 'remote_request_failed') {
  const code = typeof error?.code === 'string' && error.code.startsWith('remote_') ? error.code : fallback
  const statusCode = new Set([
    'remote_pairing_invalid',
    'remote_pairing_expired',
    'remote_pairing_attempt_expired',
    'remote_pairing_proof_invalid',
    'remote_pairing_already_used',
    'remote_device_limit_reached',
    'remote_protocol_version_unsupported',
    'remote_pairing_start_invalid',
    'remote_frame_auth_failed',
    'remote_request_too_large',
    'remote_identity_unavailable'
  ]).has(code) ? 400 : 500
  createJsonResponse(response, statusCode, { ok: false, error: code })
}

export function createRemoteGateway({
  app,
  safeStorage,
  dbStorageGetItem,
  dbStorageSetItem,
  getAppVersion = () => '',
  onStatusChanged = null,
  onPairingCreated = null,
  logger = console
} = {}) {
  if (!app || typeof app.getPath !== 'function') throw new Error('remote_app_required')
  if (!safeStorage || typeof safeStorage.isEncryptionAvailable !== 'function') throw new Error('remote_safe_storage_required')
  if (typeof dbStorageGetItem !== 'function' || typeof dbStorageSetItem !== 'function') throw new Error('remote_storage_required')

  let server = null
  let webSocketServer = null
  let runtime = createStoppedRuntime()
  let configuredSettings = { enabled: false, host: '0.0.0.0', port: REMOTE_DEFAULT_PORT, publicEndpoint: '' }
  let operationQueue = Promise.resolve()
  let pairingQueue = Promise.resolve()
  let identityCache = null
  let tlsCache = null
  const pairings = new Map()
  const pairingAttempts = new Map()
  const socketContexts = new WeakMap()
  const activeSocketsByDeviceId = new Map()
  const seenSessionHelloNonces = new Map()
  let unauthenticatedSocketCount = 0

  function log(level, message, details = null) {
    const writer = logger?.[level] || logger?.log
    try {
      if (details === null || details === undefined) writer?.call(logger, `[remote-v2] ${message}`)
      else writer?.call(logger, `[remote-v2] ${message}`, details)
    } catch {
      // never fail a remote operation because logging failed
    }
  }

  function queue(operation) {
    const next = operationQueue.then(operation, operation)
    operationQueue = next.catch(() => {})
    return next
  }

  function notifyStatus() {
    if (typeof onStatusChanged !== 'function') return
    try {
      onStatusChanged(getStatus())
    } catch {
      // renderer teardown cannot break the gateway
    }
  }

  function queuePairing(operation) {
    const next = pairingQueue.then(operation, operation)
    pairingQueue = next.catch(() => {})
    return next
  }

  function assertSecureStorage() {
    if (!safeStorage.isEncryptionAvailable()) throw remoteError('remote_secure_storage_unavailable')
  }

  function encryptLocalSecret(value) {
    assertSecureStorage()
    return safeStorage.encryptString(String(value)).toString('base64')
  }

  function decryptLocalSecret(value) {
    assertSecureStorage()
    if (typeof value !== 'string' || !value) throw remoteError('remote_secure_record_invalid')
    try {
      return safeStorage.decryptString(Buffer.from(value, 'base64'))
    } catch {
      throw remoteError('remote_secure_record_invalid')
    }
  }

  async function storageGet(key, fallback) {
    const result = await dbStorageGetItem(key, fallback)
    return result?.value === undefined ? clone(fallback) : result.value
  }

  async function storageSet(key, value) {
    await dbStorageSetItem(key, value)
  }

  async function getIdentity() {
    if (identityCache) return identityCache
    const stored = await storageGet(IDENTITY_STORAGE_KEY, null)
    if (stored && typeof stored === 'object') {
      try {
        const privateKey = JSON.parse(decryptLocalSecret(stored.encryptedPrivateKey))
        const desktopId = normalizeIdentifier(stored.desktopId, 'desktopId', { minLength: 16, maxLength: 160 })
        const publicKey = typeof stored.publicKey === 'string' ? stored.publicKey : ''
        const derivedPublicKey = publicKeyFromPrivate(privateKey)
        if (!timingSafeEqualBase64Url(publicKey, derivedPublicKey)) throw remoteError('remote_identity_unavailable')
        identityCache = { desktopId, publicKey, privateKey }
        return identityCache
      } catch (error) {
        if (error?.code === 'remote_secure_record_invalid') throw error
        throw remoteError('remote_identity_unavailable')
      }
    }

    const pair = createP256KeyPair()
    identityCache = {
      desktopId: randomBase64Url(24),
      publicKey: pair.publicKey,
      privateKey: pair.privateKey
    }
    await storageSet(IDENTITY_STORAGE_KEY, {
      version: REMOTE_PROTOCOL_VERSION,
      desktopId: identityCache.desktopId,
      publicKey: identityCache.publicKey,
      encryptedPrivateKey: encryptLocalSecret(JSON.stringify(identityCache.privateKey)),
      createdAt: nowIso()
    })
    return identityCache
  }

  async function getTlsMaterial() {
    if (tlsCache) return tlsCache
    const stored = await storageGet(TLS_STORAGE_KEY, null)
    if (stored && typeof stored === 'object') {
      try {
        const decoded = JSON.parse(decryptLocalSecret(stored.encryptedPem))
        const key = typeof decoded?.key === 'string' ? decoded.key : ''
        const cert = typeof decoded?.cert === 'string' ? decoded.cert : ''
        if (!key || !cert) throw remoteError('remote_secure_record_invalid')
        tlsCache = { key, cert, fingerprint: certificateFingerprint(cert) }
        return tlsCache
      } catch (error) {
        log('warn', 'stored TLS material unavailable; regenerating certificate', { code: error?.code || 'unknown' })
      }
    }

    assertSecureStorage()
    const altNames = [
      { type: 2, value: 'localhost' },
      { type: 7, ip: '127.0.0.1' },
      ...getLanIpv4Addresses().map((ip) => ({ type: 7, ip }))
    ]
    const generated = await selfsigned.generate(
      [{ name: 'commonName', value: 'Anywhere Desktop Remote v2' }],
      {
        algorithm: 'sha256',
        keySize: 2048,
        extensions: [
          { name: 'basicConstraints', cA: false },
          { name: 'keyUsage', digitalSignature: true, keyEncipherment: true },
          { name: 'extKeyUsage', serverAuth: true },
          { name: 'subjectAltName', altNames }
        ]
      }
    )
    const key = typeof generated?.private === 'string' ? generated.private : generated?.privateKey
    const cert = generated?.cert
    if (typeof key !== 'string' || typeof cert !== 'string') throw remoteError('remote_certificate_generate_failed')
    tlsCache = { key, cert, fingerprint: certificateFingerprint(cert) }
    await storageSet(TLS_STORAGE_KEY, {
      version: REMOTE_PROTOCOL_VERSION,
      encryptedPem: encryptLocalSecret(JSON.stringify({ key, cert })),
      createdAt: nowIso()
    })
    return tlsCache
  }

  async function readDevices() {
    const stored = await storageGet(DEVICES_STORAGE_KEY, { version: REMOTE_PROTOCOL_VERSION, devices: [] })
    const source = stored && typeof stored === 'object' ? stored : {}
    return {
      version: REMOTE_PROTOCOL_VERSION,
      devices: Array.isArray(source.devices) ? source.devices.filter((item) => item && typeof item === 'object') : []
    }
  }

  async function writeDevices(data) {
    const devices = Array.isArray(data?.devices) ? data.devices.slice(0, REMOTE_MAX_DEVICES) : []
    await storageSet(DEVICES_STORAGE_KEY, { version: REMOTE_PROTOCOL_VERSION, devices })
  }

  async function appendAudit(type, details = {}) {
    try {
      const existing = await storageGet(AUDIT_STORAGE_KEY, { version: REMOTE_PROTOCOL_VERSION, entries: [] })
      const entries = Array.isArray(existing?.entries) ? existing.entries : []
      const entry = {
        at: nowIso(),
        type: String(type || 'remote.unknown').slice(0, 80),
        deviceId: typeof details?.deviceId === 'string' ? details.deviceId.slice(0, 160) : '',
        result: typeof details?.result === 'string' ? details.result.slice(0, 80) : '',
        meta: details?.meta && typeof details.meta === 'object' ? clone(details.meta) : {}
      }
      entries.unshift(entry)
      await storageSet(AUDIT_STORAGE_KEY, {
        version: REMOTE_PROTOCOL_VERSION,
        entries: entries.slice(0, MAX_AUDIT_ENTRIES)
      })
    } catch {
      // audit storage is best effort and must not interrupt a trusted action
    }
  }

  function publicDevice(device) {
    const sockets = activeSocketsByDeviceId.get(device.deviceId)
    return {
      deviceId: device.deviceId,
      displayName: normalizeDisplayName(device.displayName),
      platform: normalizeDisplayName(device.platform, 'unknown').slice(0, 40),
      appVersion: typeof device.appVersion === 'string' ? device.appVersion : '',
      createdAt: typeof device.createdAt === 'string' ? device.createdAt : '',
      lastSeenAt: typeof device.lastSeenAt === 'string' ? device.lastSeenAt : '',
      online: Boolean(sockets?.size)
    }
  }

  async function getDevice(deviceId) {
    const normalizedId = normalizeIdentifier(deviceId, 'deviceId', { minLength: 16, maxLength: 160 })
    const data = await readDevices()
    return data.devices.find((device) => device.deviceId === normalizedId) || null
  }

  function getRootSecret(device) {
    const serialized = decryptLocalSecret(device?.encryptedRootSecret)
    return decodeBase64Url(serialized, 'device.rootSecret', { minBytes: 32, maxBytes: 32 })
  }

  async function touchDevice(deviceId) {
    const data = await readDevices()
    const index = data.devices.findIndex((device) => device.deviceId === deviceId)
    if (index < 0) return
    data.devices[index] = { ...data.devices[index], lastSeenAt: nowIso() }
    await writeDevices(data)
  }

  function zeroPairingAttempt(attempt) {
    try {
      attempt?.rootSecret?.fill?.(0)
      attempt?.transcript?.fill?.(0)
    } catch {
      // best effort secret cleanup
    }
  }

  function cleanupExpiredPairings() {
    const now = Date.now()
    for (const [pairingId, pairing] of pairings) {
      if (!pairing || pairing.expiresAtMs <= now) pairings.delete(pairingId)
    }
    for (const [attemptId, attempt] of pairingAttempts) {
      if (!attempt || attempt.expiresAtMs <= now) {
        zeroPairingAttempt(attempt)
        pairingAttempts.delete(attemptId)
      }
    }
    for (const [nonceKey, expiresAtMs] of seenSessionHelloNonces) {
      if (!Number.isFinite(expiresAtMs) || expiresAtMs <= now) seenSessionHelloNonces.delete(nonceKey)
    }
  }

  function closeDeviceSockets(deviceId, code = 4001, reason = 'device_revoked') {
    const sockets = activeSocketsByDeviceId.get(deviceId)
    if (!sockets) return
    for (const socket of [...sockets]) safeSocketClose(socket, code, reason)
    activeSocketsByDeviceId.delete(deviceId)
  }

  function removeSocketContext(socket) {
    const context = socketContexts.get(socket)
    if (!context) return
    context.closed = true
    if (context.handshakeTimer) clearTimeout(context.handshakeTimer)
    if (context.authenticated) {
      const sockets = activeSocketsByDeviceId.get(context.device?.deviceId)
      if (sockets) {
        sockets.delete(socket)
        if (sockets.size === 0) activeSocketsByDeviceId.delete(context.device.deviceId)
      }
      try {
        context.session?.close?.()
      } catch {
        // ignore session close races
      }
    } else {
      unauthenticatedSocketCount = Math.max(0, unauthenticatedSocketCount - 1)
    }
    socketContexts.delete(socket)
    notifyStatus()
  }

  function sendPlain(socket, payload) {
    if (!isOpen(socket)) return false
    try {
      const text = JSON.stringify(payload)
      if (Buffer.byteLength(text) > REMOTE_MAX_FRAME_BYTES) return false
      socket.send(text)
      return true
    } catch {
      return false
    }
  }

  function sendEncrypted(socket, context, payload) {
    if (!isOpen(socket) || !context?.session) return false
    try {
      const frame = context.session.encrypt(payload)
      return sendPlain(socket, frame)
    } catch {
      return false
    }
  }

  function getStatus() {
    const devicesOnline = [...activeSocketsByDeviceId.values()].filter((sockets) => sockets.size > 0).length
    return {
      ...clone(runtime),
      ...clone(configuredSettings),
      // Runtime values win for a live listener; configured settings remain useful while stopped.
      ...(runtime.running ? {
        host: runtime.host,
        port: runtime.port,
        publicEndpoint: runtime.publicEndpoint,
        endpoints: runtime.endpoints
      } : {}),
      running: runtime.running,
      enabled: configuredSettings.enabled,
      devicesOnline,
      protocolVersion: REMOTE_PROTOCOL_VERSION
    }
  }

  async function createPairing() {
    if (!runtime.running) throw remoteError(runtime.lastError || 'remote_gateway_not_running')
    cleanupExpiredPairings()
    const identity = await getIdentity()
    const pairingId = randomBase64Url(24)
    const pairingCode = String(crypto.randomInt(0, 1_000_000)).padStart(6, '0')
    const pairingChallenge = randomBase64Url(32)
    const expiresAtMs = Date.now() + REMOTE_PAIRING_TTL_MS
    const endpoint = runtime.endpoints[0]
    if (!endpoint) throw remoteError('remote_endpoint_unavailable')

    const payload = {
      v: REMOTE_PROTOCOL_VERSION,
      desktopId: identity.desktopId,
      desktopName: app.getName?.() || 'Anywhere Desktop',
      endpoint,
      endpoints: [...runtime.endpoints],
      pairingId,
      pairingChallenge,
      certificateFingerprint: runtime.certificateFingerprint,
      desktopIdentityPublicKey: identity.publicKey,
      transportHints: {
        lan: 'certificate-pin+e2ee',
        tunnel: 'system-tls+e2ee'
      },
      expiresAt: new Date(expiresAtMs).toISOString()
    }

    pairings.set(pairingId, {
      pairingId,
      pairingCodeHash: sha256Base64Url(pairingCode),
      pairingChallenge,
      endpoint,
      expiresAtMs,
      failureCount: 0,
      attemptCount: 0
    })
    await appendAudit('remote.pairing.created', { result: 'ok' })
    if (typeof onPairingCreated === 'function') {
      try {
        onPairingCreated(clone(payload))
      } catch {
        // Test/diagnostic observer failures cannot affect the production pairing flow.
      }
    }

    const qrDataUrl = await QRCode.toDataURL(JSON.stringify(payload), {
      errorCorrectionLevel: 'M',
      margin: 1,
      width: 320,
      color: { dark: '#171717', light: '#ffffff' }
    })

    return {
      ok: true,
      endpoint,
      endpoints: [...runtime.endpoints],
      pairingCode: `${pairingCode.slice(0, 3)} ${pairingCode.slice(3)}`,
      qrDataUrl,
      expiresAt: payload.expiresAt,
      certificateFingerprint: runtime.certificateFingerprint,
      desktopIdentityPublicKey: identity.publicKey
    }
  }

  async function beginPairing(input) {
    cleanupExpiredPairings()
    const envelope = normalizePairingStartInput(input)
    const pairing = pairings.get(envelope.pairingId)
    if (!pairing || pairing.expiresAtMs <= Date.now()) throw remoteError('remote_pairing_expired')

    const identity = await getIdentity()
    let request
    try {
      request = openDesktopPairingStart({
        desktopPrivateKey: identity.privateKey,
        desktopPublicKey: identity.publicKey,
        context: {
          pairingId: envelope.pairingId,
          pairingChallenge: pairing.pairingChallenge,
          desktopId: identity.desktopId
        },
        input: envelope
      })
    } catch (error) {
      pairing.failureCount = Number(pairing.failureCount || 0) + 1
      if (pairing.failureCount >= MAX_PAIRING_FAILURES) pairings.delete(envelope.pairingId)
      throw error?.code ? error : remoteError('remote_pairing_invalid')
    }

    let pairingCode = ''
    try {
      pairingCode = validatePairingCode(request.pairingCode)
      const isCodeValid = timingSafeEqualBase64Url(pairing.pairingCodeHash, sha256Base64Url(pairingCode))
      const isChallengeValid = timingSafeEqualBase64Url(
        sha256Base64Url(pairing.pairingChallenge),
        sha256Base64Url(request.pairingChallenge)
      )
      if (!isCodeValid || !isChallengeValid) throw remoteError('remote_pairing_invalid')
      request.device = normalizeRemoteDevice(request.device)
    } catch (error) {
      pairing.failureCount = Number(pairing.failureCount || 0) + 1
      if (pairing.failureCount >= MAX_PAIRING_FAILURES) pairings.delete(envelope.pairingId)
      throw error?.code ? error : remoteError('remote_pairing_invalid')
    }
    if (Number(pairing.attemptCount || 0) >= MAX_PAIRING_ATTEMPTS_PER_CODE) {
      throw remoteError('remote_pairing_attempt_limit_reached')
    }

    const devices = await readDevices()
    const existing = devices.devices.find((device) => device.deviceId === request.device.deviceId)
    if (!existing && devices.devices.length >= REMOTE_MAX_DEVICES) {
      throw remoteError('remote_device_limit_reached')
    }

    const response = createDesktopPairingResponse({
      desktopPrivateKey: identity.privateKey,
      desktopPublicKey: identity.publicKey,
      devicePublicKey: request.device.publicKey,
      clientEphemeralPublicKey: envelope.clientEphemeralPublicKey,
      context: {
        pairingId: envelope.pairingId,
        pairingChallenge: pairing.pairingChallenge,
        desktopId: identity.desktopId
      }
    })

    const attemptId = randomBase64Url(24)
    const expiresAtMs = Math.min(pairing.expiresAtMs, Date.now() + PAIR_ATTEMPT_TTL_MS)
    pairing.attemptCount = Number(pairing.attemptCount || 0) + 1
    pairingAttempts.set(attemptId, {
      attemptId,
      pairingId: envelope.pairingId,
      device: request.device,
      rootSecret: response.secrets.rootSecret,
      transcript: response.secrets.transcript,
      expiresAtMs
    })

    return {
      v: REMOTE_PROTOCOL_VERSION,
      pairingAttemptId: attemptId,
      desktopId: identity.desktopId,
      desktopName: app.getName?.() || 'Anywhere Desktop',
      desktopIdentityPublicKey: identity.publicKey,
      serverEphemeralPublicKey: response.serverEphemeralPublicKey,
      desktopProof: response.desktopProof,
      transcriptHash: response.transcriptHash,
      certificateFingerprint: runtime.certificateFingerprint,
      expiresAt: new Date(expiresAtMs).toISOString()
    }
  }

  async function confirmPairing(input) {
    cleanupExpiredPairings()
    const confirmation = normalizePairingConfirmation(input)
    const pairing = pairings.get(confirmation.pairingId)
    if (!pairing || pairing.expiresAtMs <= Date.now()) throw remoteError('remote_pairing_expired')
    const attempt = pairingAttempts.get(confirmation.pairingAttemptId)
    if (!attempt || attempt.expiresAtMs <= Date.now()) throw remoteError('remote_pairing_attempt_expired')
    if (attempt.pairingId !== confirmation.pairingId || attempt.device.deviceId !== confirmation.deviceId) {
      throw remoteError('remote_pairing_invalid')
    }
    if (!verifyPairingProof({
      rootSecret: attempt.rootSecret,
      transcript: attempt.transcript,
      role: 'device',
      proof: confirmation.deviceProof
    })) {
      pairingAttempts.delete(confirmation.pairingAttemptId)
      zeroPairingAttempt(attempt)
      throw remoteError('remote_pairing_proof_invalid')
    }

    // Consume before any awaited storage write. A second concurrent confirm cannot reuse this proof.
    pairingAttempts.delete(confirmation.pairingAttemptId)
    const persistedRootSecret = attempt.rootSecret.toString('base64url')
    const identity = await getIdentity()
    const devices = await readDevices()
    const existingIndex = devices.devices.findIndex((device) => device.deviceId === attempt.device.deviceId)
    const createdAt = existingIndex >= 0 ? devices.devices[existingIndex].createdAt || nowIso() : nowIso()
    const nextDevice = {
      ...(existingIndex >= 0 ? devices.devices[existingIndex] : {}),
      ...attempt.device,
      rootSecretVersion: REMOTE_PROTOCOL_VERSION,
      encryptedRootSecret: encryptLocalSecret(persistedRootSecret),
      createdAt,
      lastSeenAt: nowIso()
    }
    if (existingIndex >= 0) devices.devices.splice(existingIndex, 1, nextDevice)
    else devices.devices.push(nextDevice)
    await writeDevices(devices)

    pairings.delete(attempt.pairingId)
    for (const [attemptId, candidate] of pairingAttempts) {
      if (candidate?.pairingId !== attempt.pairingId) continue
      pairingAttempts.delete(attemptId)
      zeroPairingAttempt(candidate)
    }
    zeroPairingAttempt(attempt)
    closeDeviceSockets(nextDevice.deviceId, 4002, 'device_repaired')
    await appendAudit('remote.device.paired', { deviceId: nextDevice.deviceId, result: 'ok' })
    notifyStatus()

    return {
      v: REMOTE_PROTOCOL_VERSION,
      desktopId: identity.desktopId,
      desktopName: app.getName?.() || 'Anywhere Desktop',
      device: publicDevice(nextDevice),
      certificateFingerprint: runtime.certificateFingerprint,
      desktopIdentityPublicKey: identity.publicKey
    }
  }

  async function handleHttp(request, response) {
    try {
      const parsed = new URL(request.url || '/', 'https://localhost')
      if (request.method === 'GET' && parsed.pathname === REMOTE_HEALTH_PATH) {
        createJsonResponse(response, 200, {
          ok: true,
          service: 'anywhere-desktop-remote',
          protocolVersion: REMOTE_PROTOCOL_VERSION
        })
        return
      }

      if (request.method === 'POST' && parsed.pathname === `${REMOTE_PAIRING_PATH}/start`) {
        const body = await readJsonRequest(request)
        const result = await queuePairing(() => beginPairing(body))
        createJsonResponse(response, 201, { ok: true, ...result })
        return
      }

      if (request.method === 'POST' && parsed.pathname === `${REMOTE_PAIRING_PATH}/confirm`) {
        const body = await readJsonRequest(request)
        const result = await queuePairing(() => confirmPairing(body))
        createJsonResponse(response, 201, { ok: true, ...result })
        return
      }

      createJsonResponse(response, 404, { ok: false, error: 'remote_not_found' })
    } catch (error) {
      createHttpError(response, error)
    }
  }

  async function readJsonRequest(request) {
    const chunks = []
    let total = 0
    for await (const chunk of request) {
      total += chunk.length
      if (total > REMOTE_MAX_REQUEST_BYTES) throw remoteError('remote_request_too_large')
      chunks.push(chunk)
    }
    return parseJsonBuffer(Buffer.concat(chunks), { maxBytes: REMOTE_MAX_REQUEST_BYTES })
  }

  async function handleEncryptedRpc({ socket, context, request }) {
    const requestId = normalizeIdentifier(request.requestId, 'requestId', { minLength: 8, maxLength: 160 })
    const method = typeof request.method === 'string' ? request.method.trim() : ''
    const params = request.params && typeof request.params === 'object' && !Array.isArray(request.params) ? request.params : {}
    // Validate the payload shape even though the phase-1 methods currently have no parameters.
    void params

    let result
    switch (method) {
      case 'remote.ping':
        result = { at: nowIso() }
        break
      case 'remote.status.get':
        result = {
          status: getStatus(),
          device: publicDevice(context.device),
          capabilities: ['remote.ping', 'remote.status.get', 'remote.device.self.get']
        }
        break
      case 'remote.device.self.get':
        result = { device: publicDevice(context.device) }
        break
      default:
        throw remoteError('remote_method_unavailable')
    }

    if (!sendEncrypted(socket, context, { kind: 'response', requestId, ok: true, result })) {
      safeSocketClose(socket, 1011, 'response_send_failed')
    }
    await appendAudit('remote.rpc', { deviceId: context.device.deviceId, result: 'ok', meta: { method } })
  }

  async function authenticateSocket(socket, context, hello) {
    if (context.closed || context.authenticating || context.authenticated) {
      throw remoteError('remote_session_state_invalid')
    }
    context.authenticating = true
    let helloReplayKey = ''
    let helloReplayExpiry = 0
    try {
      const deviceId = normalizeIdentifier(hello?.deviceId, 'deviceId', { minLength: 16, maxLength: 160 })
      const clientNonce = typeof hello?.clientNonce === 'string' ? hello.clientNonce : ''
      decodeBase64Url(clientNonce, 'clientNonce', { minBytes: 16, maxBytes: 64 })
      cleanupExpiredPairings()
      helloReplayKey = `${deviceId}:${clientNonce}`
      if (seenSessionHelloNonces.has(helloReplayKey)) throw remoteError('remote_session_hello_replayed')
      helloReplayExpiry = Date.now() + SESSION_HELLO_REPLAY_TTL_MS
      // Reserve before any awaited lookup. Concurrent sockets cannot race the same hello.
      seenSessionHelloNonces.set(helloReplayKey, helloReplayExpiry)

      const device = await getDevice(deviceId)
      if (!device) throw remoteError('remote_device_not_found')
      const identity = await getIdentity()
      const rootSecretBuffer = getRootSecret(device)
      let accepted
      try {
        accepted = acceptSessionHello({
          rootSecret: rootSecretBuffer,
          hello,
          expectedDeviceId: device.deviceId,
          expectedDesktopId: identity.desktopId
        })
      } finally {
        rootSecretBuffer.fill(0)
      }
      if (!sendPlain(socket, accepted.accept)) throw remoteError('remote_session_accept_send_failed')

      if (context.handshakeTimer) clearTimeout(context.handshakeTimer)
      context.authenticated = true
      context.device = device
      context.session = accepted.session
      unauthenticatedSocketCount = Math.max(0, unauthenticatedSocketCount - 1)
      closeDeviceSockets(device.deviceId, 4002, 'device_session_replaced')
      const sockets = activeSocketsByDeviceId.get(device.deviceId) || new Set()
      sockets.add(socket)
      activeSocketsByDeviceId.set(device.deviceId, sockets)
      await touchDevice(device.deviceId)
      notifyStatus()
      await appendAudit('remote.session.opened', { deviceId: device.deviceId, result: 'ok' })

      if (!sendEncrypted(socket, context, {
        kind: 'event',
        event: 'remote.welcome',
        payload: {
          protocolVersion: REMOTE_PROTOCOL_VERSION,
          desktopId: identity.desktopId,
          device: publicDevice(device),
          capabilities: ['remote.ping', 'remote.status.get', 'remote.device.self.get']
        }
      })) {
        throw remoteError('remote_welcome_send_failed')
      }
    } catch (error) {
      if (!context.authenticated && helloReplayKey && seenSessionHelloNonces.get(helloReplayKey) === helloReplayExpiry) {
        seenSessionHelloNonces.delete(helloReplayKey)
      }
      throw error
    } finally {
      context.authenticating = false
    }
  }

  async function handleSocketMessage(socket, raw) {
    const context = socketContexts.get(socket)
    if (!context) return
    try {
      const message = parsePlainSocketMessage(raw)
      if (!context.authenticated) {
        await authenticateSocket(socket, context, message)
        return
      }

      const request = context.session.decrypt(message)
      if (request.kind !== 'request') throw remoteError('remote_request_invalid')
      await handleEncryptedRpc({ socket, context, request })
    } catch (error) {
      const code = typeof error?.code === 'string' ? error.code : 'remote_socket_error'
      log('warn', 'socket message rejected', { code, deviceId: context.device?.deviceId || '' })
      if (context.authenticated) {
        sendEncrypted(socket, context, { kind: 'event', event: 'remote.error', payload: { code } })
      }
      safeSocketClose(socket, 4003, code)
    }
  }

  function attachWebSocketHandlers(wss) {
    wss.on('connection', (socket, request) => {
      if (unauthenticatedSocketCount >= MAX_UNAUTHENTICATED_SOCKETS) {
        safeSocketClose(socket, 1013, 'too_many_pending_connections')
        return
      }
      const activeCount = [...activeSocketsByDeviceId.values()].reduce((count, sockets) => count + sockets.size, 0)
      if (activeCount >= MAX_AUTHENTICATED_SOCKETS) {
        safeSocketClose(socket, 1013, 'too_many_connections')
        return
      }

      const context = {
        closed: false,
        authenticated: false,
        authenticating: false,
        device: null,
        session: null,
        messageQueue: Promise.resolve(),
        remoteAddress: typeof request?.socket?.remoteAddress === 'string' ? request.socket.remoteAddress : ''
      }
      unauthenticatedSocketCount += 1
      context.handshakeTimer = setTimeout(() => {
        if (!context.authenticated) safeSocketClose(socket, 4008, 'session_handshake_timeout')
      }, HANDSHAKE_TIMEOUT_MS)
      socketContexts.set(socket, context)

      socket.on('message', (raw, isBinary) => {
        if (isBinary) {
          safeSocketClose(socket, 1003, 'binary_frames_not_supported')
          return
        }
        // ws emits message callbacks without awaiting async handlers. Serialize per socket so
        // AEAD sequence checks observe the exact arrival order and fail closed on a bad frame.
        context.messageQueue = context.messageQueue
          .then(async () => {
            if (!context.closed) await handleSocketMessage(socket, raw)
          })
          .catch(() => {})
      })
      socket.on('close', () => removeSocketContext(socket))
      socket.on('error', () => removeSocketContext(socket))
    })

    wss.on('wsClientError', (_error, socket) => {
      try {
        socket.destroy()
      } catch {
        // ignore malformed upgrade races
      }
    })
  }

  async function startServer(settings) {
    assertSecureStorage()
    const [identity, tls] = await Promise.all([getIdentity(), getTlsMaterial()])
    const nextServer = https.createServer({ key: tls.key, cert: tls.cert }, handleHttp)
    const nextWebSocketServer = new WebSocketServer({
      noServer: true,
      maxPayload: REMOTE_MAX_FRAME_BYTES,
      perMessageDeflate: false
    })
    attachWebSocketHandlers(nextWebSocketServer)

    nextServer.on('upgrade', (request, socket, head) => {
      try {
        const parsed = new URL(request.url || '/', 'wss://localhost')
        if (parsed.pathname !== REMOTE_SOCKET_PATH) {
          socket.destroy()
          return
        }
        nextWebSocketServer.handleUpgrade(request, socket, head, (webSocket) => {
          nextWebSocketServer.emit('connection', webSocket, request)
        })
      } catch {
        socket.destroy()
      }
    })

    await new Promise((resolve, reject) => {
      const onError = (error) => {
        nextServer.off('listening', onListening)
        reject(error)
      }
      const onListening = () => {
        nextServer.off('error', onError)
        resolve()
      }
      nextServer.once('error', onError)
      nextServer.once('listening', onListening)
      nextServer.listen(settings.port, settings.host)
    })

    server = nextServer
    webSocketServer = nextWebSocketServer
    runtime = {
      running: true,
      enabled: true,
      host: settings.host,
      port: settings.port,
      publicEndpoint: settings.publicEndpoint,
      endpoints: buildEndpoints(settings),
      certificateFingerprint: tls.fingerprint,
      desktopId: identity.desktopId,
      desktopPublicKey: identity.publicKey,
      lastError: '',
      startedAt: nowIso(),
      protocolVersion: REMOTE_PROTOCOL_VERSION
    }
    await appendAudit('remote.gateway.started', { result: 'ok', meta: { host: settings.host, port: settings.port } })
    notifyStatus()
  }

  async function stopNow({ clearEnabled = false } = {}) {
    cleanupExpiredPairings()
    pairings.clear()
    for (const attempt of pairingAttempts.values()) zeroPairingAttempt(attempt)
    pairingAttempts.clear()

    for (const deviceId of [...activeSocketsByDeviceId.keys()]) closeDeviceSockets(deviceId, 4000, 'gateway_stopped')
    const closingWss = webSocketServer
    const closingServer = server
    webSocketServer = null
    server = null
    unauthenticatedSocketCount = 0

    if (closingWss) {
      try {
        closingWss.clients.forEach((socket) => safeSocketClose(socket, 4000, 'gateway_stopped'))
        closingWss.close()
      } catch {
        // ignore close race
      }
    }
    if (closingServer) {
      await new Promise((resolve) => {
        try {
          closingServer.close(() => resolve())
        } catch {
          resolve()
        }
      })
    }

    if (clearEnabled) configuredSettings = { ...configuredSettings, enabled: false }
    runtime = {
      ...createStoppedRuntime(),
      host: configuredSettings.host,
      port: configuredSettings.port,
      publicEndpoint: configuredSettings.publicEndpoint,
      enabled: configuredSettings.enabled,
      protocolVersion: REMOTE_PROTOCOL_VERSION
    }
    notifyStatus()
  }

  async function configureNow(config = {}) {
    const settings = normalizeRemoteSettings(config)
    configuredSettings = { ...settings }
    const sameListener = runtime.running && runtime.host === settings.host && runtime.port === settings.port
    if (!settings.enabled) {
      await stopNow({ clearEnabled: true })
      return getStatus()
    }

    if (sameListener) {
      runtime = {
        ...runtime,
        enabled: true,
        publicEndpoint: settings.publicEndpoint,
        endpoints: buildEndpoints(settings),
        lastError: ''
      }
      notifyStatus()
      return getStatus()
    }

    await stopNow()
    try {
      await startServer(settings)
    } catch (error) {
      runtime = {
        ...createStoppedRuntime(),
        enabled: true,
        host: settings.host,
        port: settings.port,
        publicEndpoint: settings.publicEndpoint,
        endpoints: buildEndpoints(settings),
        lastError: statusErrorCode(error),
        protocolVersion: REMOTE_PROTOCOL_VERSION
      }
      log('error', 'gateway startup failed', { code: runtime.lastError })
      notifyStatus()
    }
    return getStatus()
  }

  async function listDevices() {
    const data = await readDevices()
    return {
      ok: true,
      devices: data.devices.map(publicDevice).sort((left, right) => String(right.lastSeenAt).localeCompare(String(left.lastSeenAt)))
    }
  }

  async function revokeDevice(deviceId) {
    const normalizedId = normalizeIdentifier(deviceId, 'deviceId', { minLength: 16, maxLength: 160 })
    const data = await readDevices()
    const nextDevices = data.devices.filter((device) => device.deviceId !== normalizedId)
    const removed = nextDevices.length !== data.devices.length
    if (removed) {
      await writeDevices({ version: REMOTE_PROTOCOL_VERSION, devices: nextDevices })
      closeDeviceSockets(normalizedId, 4001, 'device_revoked')
      await appendAudit('remote.device.revoked', { deviceId: normalizedId, result: 'ok' })
      notifyStatus()
    }
    return { ok: true, removed, deviceId: normalizedId }
  }

  async function renameDevice(deviceId, displayName) {
    const normalizedId = normalizeIdentifier(deviceId, 'deviceId', { minLength: 16, maxLength: 160 })
    const normalizedName = normalizeDisplayName(displayName, '')
    if (!normalizedName) throw remoteError('remote_device_name_required')
    const data = await readDevices()
    const index = data.devices.findIndex((device) => device.deviceId === normalizedId)
    if (index < 0) throw remoteError('remote_device_not_found')
    data.devices[index] = { ...data.devices[index], displayName: normalizedName }
    await writeDevices(data)
    await appendAudit('remote.device.renamed', { deviceId: normalizedId, result: 'ok' })
    notifyStatus()
    return { ok: true, device: publicDevice(data.devices[index]) }
  }

  async function getAuditLog() {
    const stored = await storageGet(AUDIT_STORAGE_KEY, { version: REMOTE_PROTOCOL_VERSION, entries: [] })
    return {
      ok: true,
      entries: Array.isArray(stored?.entries) ? stored.entries.map((entry) => clone(entry)) : []
    }
  }

  return {
    configure: (config = {}) => queue(() => configureNow(config)),
    stop: () => queue(() => stopNow({ clearEnabled: false })),
    getStatus,
    getPublicSettings: () => sanitizeRemoteSettingsForConfig(configuredSettings),
    createPairing: () => queue(() => createPairing()),
    listDevices,
    revokeDevice: (deviceId) => queue(() => revokeDevice(deviceId)),
    renameDevice: (deviceId, displayName) => queue(() => renameDevice(deviceId, displayName)),
    getAuditLog,
    // Pairing endpoints are intentionally internal to the HTTPS request handler.
    // Exporting no direct secret/root-key API prevents accidental IPC exposure.
    get protocolVersion() {
      return REMOTE_PROTOCOL_VERSION
    },
    get appVersion() {
      return String(getAppVersion?.() || '')
    }
  }
}
