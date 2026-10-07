import crypto from 'node:crypto'
import {
  REMOTE_MAX_FRAME_BYTES,
  REMOTE_PROTOCOL_VERSION,
  buildFrameAad,
  canonicalBuffer,
  decodeBase64Url,
  encodeBase64Url,
  normalizeIdentifier,
  normalizeSequence,
  randomBase64Url,
  remoteError,
  sha256Base64Url,
  timingSafeEqualBase64Url
} from './protocol.js'

const CURVE = 'prime256v1'
const PUBLIC_KEY_BYTES = 65
const SHARED_SECRET_BYTES = 32
const SESSION_KEY_BYTES = 32
const NONCE_BYTES = 12
const TAG_BYTES = 16
const HANDSHAKE_LABEL = 'anywhere-remote-v2/handshake'
const SESSION_LABEL = 'anywhere-remote-v2/session'

function exportUncompressedPublicKey(keyObject) {
  const exported = keyObject.export({ format: 'jwk' })
  const x = decodeBase64Url(exported.x, 'publicKey.x', { minBytes: 32, maxBytes: 32 })
  const y = decodeBase64Url(exported.y, 'publicKey.y', { minBytes: 32, maxBytes: 32 })
  return Buffer.concat([Buffer.from([0x04]), x, y])
}

function importUncompressedPublicKey(value, field = 'publicKey') {
  const raw = typeof value === 'string'
    ? decodeBase64Url(value, field, { minBytes: PUBLIC_KEY_BYTES, maxBytes: PUBLIC_KEY_BYTES })
    : Buffer.isBuffer(value)
      ? Buffer.from(value)
      : null

  if (!raw || raw.length !== PUBLIC_KEY_BYTES || raw[0] !== 0x04) {
    throw remoteError('remote_public_key_invalid', `${field} must be an uncompressed P-256 public key`)
  }

  const x = raw.subarray(1, 33).toString('base64url')
  const y = raw.subarray(33, 65).toString('base64url')
  return crypto.createPublicKey({ key: { kty: 'EC', crv: 'P-256', x, y }, format: 'jwk' })
}

function exportPrivateKey(keyObject) {
  return keyObject.export({ format: 'jwk' })
}

function importPrivateKey(jwk, field = 'privateKey') {
  if (!jwk || typeof jwk !== 'object' || jwk.kty !== 'EC' || jwk.crv !== 'P-256' || typeof jwk.d !== 'string') {
    throw remoteError('remote_private_key_invalid', `${field} must be a P-256 private JWK`)
  }
  return crypto.createPrivateKey({ key: jwk, format: 'jwk' })
}

function normalizeSecret(value, field = 'secret') {
  const secret = Buffer.isBuffer(value)
    ? Buffer.from(value)
    : decodeBase64Url(value, field, { minBytes: SESSION_KEY_BYTES, maxBytes: SESSION_KEY_BYTES })
  if (secret.length !== SESSION_KEY_BYTES) throw remoteError('remote_root_secret_invalid')
  return secret
}

function hkdf(ikm, { salt, info, length = SESSION_KEY_BYTES }) {
  const safeSalt = Buffer.isBuffer(salt) ? salt : Buffer.from(salt || '')
  const safeInfo = Buffer.isBuffer(info) ? info : Buffer.from(info || '')
  return Buffer.from(crypto.hkdfSync('sha256', ikm, safeSalt, safeInfo, length))
}

function hmac(key, value) {
  return crypto.createHmac('sha256', key).update(value).digest()
}

function deriveSharedSecret(privateKey, publicKey) {
  const secret = crypto.diffieHellman({ privateKey, publicKey })
  if (!Buffer.isBuffer(secret) || secret.length !== SHARED_SECRET_BYTES) {
    throw remoteError('remote_ecdh_failed')
  }
  return secret
}

function normalizeHandshakeContext(context = {}) {
  const pairingId = normalizeIdentifier(context.pairingId, 'pairingId', { minLength: 16, maxLength: 160 })
  const pairingChallenge = typeof context.pairingChallenge === 'string' ? context.pairingChallenge : ''
  const desktopId = normalizeIdentifier(context.desktopId, 'desktopId', { minLength: 16, maxLength: 160 })
  decodeBase64Url(pairingChallenge, 'pairingChallenge', { minBytes: 16, maxBytes: 128 })
  return { pairingId, pairingChallenge, desktopId }
}

export function createPairingTranscript({ context, desktopPublicKey, devicePublicKey, clientEphemeralPublicKey, serverEphemeralPublicKey }) {
  const normalizedContext = normalizeHandshakeContext(context)
  // Validate all public key encodings before canonicalization. This avoids accepting an invalid
  // key in one code path and failing only after a secret has already been derived.
  importUncompressedPublicKey(desktopPublicKey, 'desktopPublicKey')
  importUncompressedPublicKey(devicePublicKey, 'device.publicKey')
  importUncompressedPublicKey(clientEphemeralPublicKey, 'clientEphemeralPublicKey')
  importUncompressedPublicKey(serverEphemeralPublicKey, 'serverEphemeralPublicKey')

  return canonicalBuffer({
    v: REMOTE_PROTOCOL_VERSION,
    label: HANDSHAKE_LABEL,
    pairingId: normalizedContext.pairingId,
    pairingChallenge: normalizedContext.pairingChallenge,
    desktopId: normalizedContext.desktopId,
    desktopPublicKey,
    devicePublicKey,
    clientEphemeralPublicKey,
    serverEphemeralPublicKey
  })
}

function derivePairingRootSecret({ desktopPrivateKey, devicePublicKey, clientEphemeralPublicKey, serverEphemeralPrivateKey, transcript }) {
  const staticSecret = deriveSharedSecret(desktopPrivateKey, importUncompressedPublicKey(devicePublicKey, 'device.publicKey'))
  const ephemeralSecret = deriveSharedSecret(serverEphemeralPrivateKey, importUncompressedPublicKey(clientEphemeralPublicKey, 'clientEphemeralPublicKey'))
  const ikm = Buffer.concat([staticSecret, ephemeralSecret])
  const salt = crypto.createHash('sha256').update(transcript).digest()
  return hkdf(ikm, { salt, info: Buffer.from(`${HANDSHAKE_LABEL}/root`, 'utf8') })
}

function deriveClientPairingRootSecret({ devicePrivateKey, desktopPublicKey, serverEphemeralPublicKey, clientEphemeralPrivateKey, transcript }) {
  const staticSecret = deriveSharedSecret(devicePrivateKey, importUncompressedPublicKey(desktopPublicKey, 'desktopPublicKey'))
  const ephemeralSecret = deriveSharedSecret(clientEphemeralPrivateKey, importUncompressedPublicKey(serverEphemeralPublicKey, 'serverEphemeralPublicKey'))
  const ikm = Buffer.concat([staticSecret, ephemeralSecret])
  const salt = crypto.createHash('sha256').update(transcript).digest()
  return hkdf(ikm, { salt, info: Buffer.from(`${HANDSHAKE_LABEL}/root`, 'utf8') })
}

const PAIRING_START_LABEL = 'anywhere-remote-v2/pair-start'

function createPairingStartAad({ context, desktopPublicKey, clientEphemeralPublicKey }) {
  const normalizedContext = normalizeHandshakeContext(context)
  importUncompressedPublicKey(desktopPublicKey, 'desktopPublicKey')
  importUncompressedPublicKey(clientEphemeralPublicKey, 'clientEphemeralPublicKey')
  return canonicalBuffer({
    v: REMOTE_PROTOCOL_VERSION,
    type: 'remote.pair.start',
    label: PAIRING_START_LABEL,
    pairingId: normalizedContext.pairingId,
    pairingChallenge: normalizedContext.pairingChallenge,
    desktopId: normalizedContext.desktopId,
    desktopPublicKey,
    clientEphemeralPublicKey
  })
}

function derivePairingStartKey({ privateKey, peerPublicKey, aad }) {
  const sharedSecret = deriveSharedSecret(privateKey, importUncompressedPublicKey(peerPublicKey, 'pairingStartPeerPublicKey'))
  const salt = crypto.createHash('sha256').update(aad).digest()
  return hkdf(sharedSecret, {
    salt,
    info: Buffer.from(`${PAIRING_START_LABEL}/key`, 'utf8')
  })
}

function normalizePairingStartEnvelope(input = {}) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw remoteError('remote_pairing_start_invalid')
  if (input.type !== 'remote.pair.start' || Number(input.v) !== REMOTE_PROTOCOL_VERSION) {
    throw remoteError('remote_pairing_start_invalid')
  }
  return {
    pairingId: normalizeIdentifier(input.pairingId, 'pairingId', { minLength: 16, maxLength: 160 }),
    clientEphemeralPublicKey: typeof input.clientEphemeralPublicKey === 'string' ? input.clientEphemeralPublicKey : '',
    nonce: typeof input.nonce === 'string' ? input.nonce : '',
    ciphertext: typeof input.ciphertext === 'string' ? input.ciphertext : '',
    tag: typeof input.tag === 'string' ? input.tag : ''
  }
}

/**
 * Encrypt the human confirmation code and device identity before they leave the
 * mobile process. A TLS-terminating tunnel can route this frame but cannot read
 * or replay its plaintext against a different Desktop identity/QR challenge.
 */
export function createPairingStartEnvelope({ desktopPublicKey, clientEphemeralPrivateKey, context, pairingCode, device }) {
  const clientEphemeralPublicKey = publicKeyFromPrivate(clientEphemeralPrivateKey)
  const aad = createPairingStartAad({ context, desktopPublicKey, clientEphemeralPublicKey })
  const key = derivePairingStartKey({
    privateKey: importPrivateKey(clientEphemeralPrivateKey, 'clientEphemeralPrivateKey'),
    peerPublicKey: desktopPublicKey,
    aad
  })
  const plaintext = canonicalBuffer({
    pairingCode: typeof pairingCode === 'string' ? pairingCode.replace(/\s/g, '') : '',
    pairingChallenge: context?.pairingChallenge || '',
    device
  })
  try {
    return {
      v: REMOTE_PROTOCOL_VERSION,
      type: 'remote.pair.start',
      pairingId: normalizeHandshakeContext(context).pairingId,
      clientEphemeralPublicKey,
      ...encryptAead({ key, plaintext, aad })
    }
  } finally {
    key.fill(0)
    plaintext.fill(0)
  }
}

/** Desktop-side decrypt/validation helper for the E2EE pairing start envelope. */
export function openDesktopPairingStart({ desktopPrivateKey, desktopPublicKey, context, input }) {
  const envelope = normalizePairingStartEnvelope(input)
  const normalizedContext = normalizeHandshakeContext(context)
  if (envelope.pairingId !== normalizedContext.pairingId) throw remoteError('remote_pairing_start_invalid')
  const actualDesktopPublicKey = desktopPublicKey || publicKeyFromPrivate(desktopPrivateKey)
  const aad = createPairingStartAad({
    context: normalizedContext,
    desktopPublicKey: actualDesktopPublicKey,
    clientEphemeralPublicKey: envelope.clientEphemeralPublicKey
  })
  const key = derivePairingStartKey({
    privateKey: importPrivateKey(desktopPrivateKey, 'desktopPrivateKey'),
    peerPublicKey: envelope.clientEphemeralPublicKey,
    aad
  })
  let plaintext = null
  try {
    plaintext = decryptAead({ key, nonce: envelope.nonce, ciphertext: envelope.ciphertext, tag: envelope.tag, aad })
    let payload
    try {
      payload = JSON.parse(plaintext.toString('utf8'))
    } catch {
      throw remoteError('remote_pairing_start_invalid')
    }
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) throw remoteError('remote_pairing_start_invalid')
    return {
      pairingId: envelope.pairingId,
      clientEphemeralPublicKey: envelope.clientEphemeralPublicKey,
      pairingCode: typeof payload.pairingCode === 'string' ? payload.pairingCode : '',
      pairingChallenge: typeof payload.pairingChallenge === 'string' ? payload.pairingChallenge : '',
      device: payload.device
    }
  } finally {
    key.fill(0)
    plaintext?.fill?.(0)
  }
}


function createSessionHelloProofPayload({ deviceId, desktopId, clientNonce, clientEphemeralPublicKey }) {
  return canonicalBuffer({
    v: REMOTE_PROTOCOL_VERSION,
    type: 'remote.session.hello',
    deviceId,
    desktopId,
    clientNonce,
    clientEphemeralPublicKey
  })
}

function createSessionAcceptProofPayload({ deviceId, desktopId, sessionId, clientNonce, serverNonce, clientEphemeralPublicKey, serverEphemeralPublicKey }) {
  return canonicalBuffer({
    v: REMOTE_PROTOCOL_VERSION,
    type: 'remote.session.accept',
    deviceId,
    desktopId,
    sessionId,
    clientNonce,
    serverNonce,
    clientEphemeralPublicKey,
    serverEphemeralPublicKey
  })
}

function deriveSessionMaterial({ rootSecret, sessionId, clientNonce, serverNonce, ephemeralSecret }) {
  const safeSessionId = normalizeIdentifier(sessionId, 'sessionId', { minLength: 16, maxLength: 128 })
  const clientNonceBytes = decodeBase64Url(clientNonce, 'clientNonce', { minBytes: 16, maxBytes: 64 })
  const serverNonceBytes = decodeBase64Url(serverNonce, 'serverNonce', { minBytes: 16, maxBytes: 64 })
  const root = normalizeSecret(rootSecret, 'rootSecret')
  if (!Buffer.isBuffer(ephemeralSecret) || ephemeralSecret.length !== SHARED_SECRET_BYTES) {
    throw remoteError('remote_ecdh_failed')
  }
  const salt = crypto.createHash('sha256').update(Buffer.concat([clientNonceBytes, serverNonceBytes])).digest()
  const material = hkdf(Buffer.concat([root, ephemeralSecret]), {
    salt,
    info: canonicalBuffer({ v: REMOTE_PROTOCOL_VERSION, label: SESSION_LABEL, sessionId: safeSessionId }),
    length: SESSION_KEY_BYTES * 2
  })
  return {
    sessionId: safeSessionId,
    clientToDesktopKey: material.subarray(0, SESSION_KEY_BYTES),
    desktopToClientKey: material.subarray(SESSION_KEY_BYTES, SESSION_KEY_BYTES * 2)
  }
}

function encryptAead({ key, plaintext, aad }) {
  const nonce = crypto.randomBytes(NONCE_BYTES)
  const cipher = crypto.createCipheriv('aes-256-gcm', key, nonce)
  cipher.setAAD(aad)
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()])
  const tag = cipher.getAuthTag()
  return {
    nonce: encodeBase64Url(nonce),
    ciphertext: encodeBase64Url(ciphertext),
    tag: encodeBase64Url(tag)
  }
}

function decryptAead({ key, nonce, ciphertext, tag, aad }) {
  const safeNonce = decodeBase64Url(nonce, 'frame.nonce', { minBytes: NONCE_BYTES, maxBytes: NONCE_BYTES })
  const safeCiphertext = decodeBase64Url(ciphertext, 'frame.ciphertext', { minBytes: 1, maxBytes: REMOTE_MAX_FRAME_BYTES })
  const safeTag = decodeBase64Url(tag, 'frame.tag', { minBytes: TAG_BYTES, maxBytes: TAG_BYTES })
  try {
    const decipher = crypto.createDecipheriv('aes-256-gcm', key, safeNonce)
    decipher.setAAD(aad)
    decipher.setAuthTag(safeTag)
    return Buffer.concat([decipher.update(safeCiphertext), decipher.final()])
  } catch {
    throw remoteError('remote_frame_auth_failed')
  }
}

export function createP256KeyPair() {
  const pair = crypto.generateKeyPairSync('ec', { namedCurve: CURVE })
  return {
    publicKey: encodeBase64Url(exportUncompressedPublicKey(pair.publicKey)),
    privateKey: exportPrivateKey(pair.privateKey)
  }
}

export function publicKeyFromPrivate(privateKey) {
  const privateKeyObject = importPrivateKey(privateKey)
  return encodeBase64Url(exportUncompressedPublicKey(crypto.createPublicKey(privateKeyObject)))
}

export function createPairingProof({ rootSecret, transcript, role }) {
  const root = normalizeSecret(rootSecret, 'rootSecret')
  if (!Buffer.isBuffer(transcript) || transcript.length === 0) throw remoteError('remote_pairing_transcript_invalid')
  if (role !== 'device' && role !== 'desktop') throw remoteError('remote_handshake_role_invalid')
  return encodeBase64Url(hmac(root, Buffer.concat([Buffer.from(`${HANDSHAKE_LABEL}/${role}\n`, 'utf8'), transcript])))
}

export function verifyPairingProof({ rootSecret, transcript, role, proof }) {
  const expected = createPairingProof({ rootSecret, transcript, role })
  return timingSafeEqualBase64Url(expected, proof)
}

/**
 * Desktop-side pairing start. `secrets` never crosses the HTTP boundary: the
 * gateway keeps it only until the device proves ownership in `/pair/confirm`.
 */
export function createDesktopPairingResponse({ desktopPrivateKey, desktopPublicKey, devicePublicKey, clientEphemeralPublicKey, context }) {
  const normalizedContext = normalizeHandshakeContext(context)
  const actualDesktopPublicKey = desktopPublicKey || publicKeyFromPrivate(desktopPrivateKey)
  const serverEphemeral = createP256KeyPair()
  const transcript = createPairingTranscript({
    context: normalizedContext,
    desktopPublicKey: actualDesktopPublicKey,
    devicePublicKey,
    clientEphemeralPublicKey,
    serverEphemeralPublicKey: serverEphemeral.publicKey
  })
  const rootSecret = derivePairingRootSecret({
    desktopPrivateKey: importPrivateKey(desktopPrivateKey, 'desktopPrivateKey'),
    devicePublicKey,
    clientEphemeralPublicKey,
    serverEphemeralPrivateKey: importPrivateKey(serverEphemeral.privateKey, 'serverEphemeralPrivateKey'),
    transcript
  })

  return {
    serverEphemeralPublicKey: serverEphemeral.publicKey,
    desktopProof: createPairingProof({ rootSecret, transcript, role: 'desktop' }),
    transcriptHash: sha256Base64Url(transcript),
    secrets: { rootSecret, transcript }
  }
}

/** Mobile-side helper used by contract regression tests and future native adapters. */
export function completeDevicePairing({ devicePrivateKey, desktopPublicKey, serverEphemeralPublicKey, clientEphemeralPrivateKey, devicePublicKey, context, desktopProof }) {
  const normalizedContext = normalizeHandshakeContext(context)
  const clientEphemeralPublicKey = publicKeyFromPrivate(clientEphemeralPrivateKey)
  const transcript = createPairingTranscript({
    context: normalizedContext,
    desktopPublicKey,
    devicePublicKey,
    clientEphemeralPublicKey,
    serverEphemeralPublicKey
  })
  const rootSecret = deriveClientPairingRootSecret({
    devicePrivateKey: importPrivateKey(devicePrivateKey, 'devicePrivateKey'),
    desktopPublicKey,
    serverEphemeralPublicKey,
    clientEphemeralPrivateKey: importPrivateKey(clientEphemeralPrivateKey, 'clientEphemeralPrivateKey'),
    transcript
  })

  if (!verifyPairingProof({ rootSecret, transcript, role: 'desktop', proof: desktopProof })) {
    throw remoteError('remote_pairing_proof_invalid')
  }

  return {
    deviceProof: createPairingProof({ rootSecret, transcript, role: 'device' }),
    rootSecret: encodeBase64Url(rootSecret),
    transcriptHash: sha256Base64Url(transcript)
  }
}

/**
 * Create the first message for each fresh WSS connection. The ephemeral private
 * key belongs only in mobile process memory until `completeSessionHello` returns.
 */
export function createSessionHello({ rootSecret, deviceId, desktopId }) {
  const safeDeviceId = normalizeIdentifier(deviceId, 'deviceId', { minLength: 16, maxLength: 160 })
  const safeDesktopId = normalizeIdentifier(desktopId, 'desktopId', { minLength: 16, maxLength: 160 })
  const root = normalizeSecret(rootSecret, 'rootSecret')
  const ephemeral = createP256KeyPair()
  const clientNonce = randomBase64Url(32)
  const proofPayload = createSessionHelloProofPayload({
    deviceId: safeDeviceId,
    desktopId: safeDesktopId,
    clientNonce,
    clientEphemeralPublicKey: ephemeral.publicKey
  })

  return {
    hello: {
      type: 'remote.session.hello',
      v: REMOTE_PROTOCOL_VERSION,
      deviceId: safeDeviceId,
      desktopId: safeDesktopId,
      clientNonce,
      clientEphemeralPublicKey: ephemeral.publicKey,
      proof: encodeBase64Url(hmac(root, proofPayload))
    },
    state: {
      rootSecret: encodeBase64Url(root),
      deviceId: safeDeviceId,
      desktopId: safeDesktopId,
      clientNonce,
      clientEphemeralPrivateKey: ephemeral.privateKey,
      clientEphemeralPublicKey: ephemeral.publicKey
    }
  }
}

export function acceptSessionHello({ rootSecret, hello, expectedDeviceId, expectedDesktopId }) {
  if (!hello || typeof hello !== 'object' || hello.type !== 'remote.session.hello' || Number(hello.v) !== REMOTE_PROTOCOL_VERSION) {
    throw remoteError('remote_session_hello_invalid')
  }

  const deviceId = normalizeIdentifier(hello.deviceId, 'deviceId', { minLength: 16, maxLength: 160 })
  const desktopId = normalizeIdentifier(hello.desktopId, 'desktopId', { minLength: 16, maxLength: 160 })
  if (expectedDeviceId && deviceId !== expectedDeviceId) throw remoteError('remote_device_mismatch')
  if (expectedDesktopId && desktopId !== expectedDesktopId) throw remoteError('remote_desktop_mismatch')

  const clientNonce = typeof hello.clientNonce === 'string' ? hello.clientNonce : ''
  const clientEphemeralPublicKey = typeof hello.clientEphemeralPublicKey === 'string' ? hello.clientEphemeralPublicKey : ''
  importUncompressedPublicKey(clientEphemeralPublicKey, 'clientEphemeralPublicKey')
  const root = normalizeSecret(rootSecret, 'rootSecret')
  const proofPayload = createSessionHelloProofPayload({ deviceId, desktopId, clientNonce, clientEphemeralPublicKey })
  const expectedProof = encodeBase64Url(hmac(root, proofPayload))
  if (!timingSafeEqualBase64Url(expectedProof, hello.proof)) throw remoteError('remote_session_proof_invalid')

  const serverEphemeral = createP256KeyPair()
  const sessionId = randomBase64Url(24)
  const serverNonce = randomBase64Url(32)
  const ephemeralSecret = deriveSharedSecret(
    importPrivateKey(serverEphemeral.privateKey, 'serverEphemeralPrivateKey'),
    importUncompressedPublicKey(clientEphemeralPublicKey, 'clientEphemeralPublicKey')
  )
  const material = deriveSessionMaterial({ rootSecret: root, sessionId, clientNonce, serverNonce, ephemeralSecret })
  const ackPayload = createSessionAcceptProofPayload({
    deviceId,
    desktopId,
    sessionId,
    clientNonce,
    serverNonce,
    clientEphemeralPublicKey,
    serverEphemeralPublicKey: serverEphemeral.publicKey
  })

  return {
    accept: {
      type: 'remote.session.accept',
      v: REMOTE_PROTOCOL_VERSION,
      sessionId,
      serverNonce,
      serverEphemeralPublicKey: serverEphemeral.publicKey,
      proof: encodeBase64Url(hmac(root, ackPayload))
    },
    session: createRemoteCryptoSession({
      sessionId,
      sendKey: material.desktopToClientKey,
      receiveKey: material.clientToDesktopKey,
      sendDirection: 'desktop-to-client',
      receiveDirection: 'client-to-desktop'
    })
  }
}

export function completeSessionHello({ state, accept, expectedDeviceId, expectedDesktopId }) {
  if (!state || typeof state !== 'object') throw remoteError('remote_session_state_invalid')
  if (!accept || typeof accept !== 'object' || accept.type !== 'remote.session.accept' || Number(accept.v) !== REMOTE_PROTOCOL_VERSION) {
    throw remoteError('remote_session_accept_invalid')
  }

  const deviceId = normalizeIdentifier(state.deviceId, 'deviceId', { minLength: 16, maxLength: 160 })
  const desktopId = normalizeIdentifier(state.desktopId, 'desktopId', { minLength: 16, maxLength: 160 })
  if (expectedDeviceId && deviceId !== expectedDeviceId) throw remoteError('remote_device_mismatch')
  if (expectedDesktopId && desktopId !== expectedDesktopId) throw remoteError('remote_desktop_mismatch')

  const root = normalizeSecret(state.rootSecret, 'rootSecret')
  const sessionId = normalizeIdentifier(accept.sessionId, 'sessionId', { minLength: 16, maxLength: 128 })
  const serverNonce = typeof accept.serverNonce === 'string' ? accept.serverNonce : ''
  const serverEphemeralPublicKey = typeof accept.serverEphemeralPublicKey === 'string' ? accept.serverEphemeralPublicKey : ''
  importUncompressedPublicKey(serverEphemeralPublicKey, 'serverEphemeralPublicKey')
  const ackPayload = createSessionAcceptProofPayload({
    deviceId,
    desktopId,
    sessionId,
    clientNonce: state.clientNonce,
    serverNonce,
    clientEphemeralPublicKey: state.clientEphemeralPublicKey,
    serverEphemeralPublicKey
  })
  const expectedProof = encodeBase64Url(hmac(root, ackPayload))
  if (!timingSafeEqualBase64Url(expectedProof, accept.proof)) throw remoteError('remote_session_proof_invalid')

  const ephemeralSecret = deriveSharedSecret(
    importPrivateKey(state.clientEphemeralPrivateKey, 'clientEphemeralPrivateKey'),
    importUncompressedPublicKey(serverEphemeralPublicKey, 'serverEphemeralPublicKey')
  )
  const material = deriveSessionMaterial({
    rootSecret: root,
    sessionId,
    clientNonce: state.clientNonce,
    serverNonce,
    ephemeralSecret
  })
  return createRemoteCryptoSession({
    sessionId,
    sendKey: material.clientToDesktopKey,
    receiveKey: material.desktopToClientKey,
    sendDirection: 'client-to-desktop',
    receiveDirection: 'desktop-to-client'
  })
}

export function createRemoteCryptoSession({ sessionId, sendKey, receiveKey, sendDirection, receiveDirection }) {
  const safeSessionId = normalizeIdentifier(sessionId, 'sessionId', { minLength: 16, maxLength: 128 })
  if (!Buffer.isBuffer(sendKey) || sendKey.length !== SESSION_KEY_BYTES || !Buffer.isBuffer(receiveKey) || receiveKey.length !== SESSION_KEY_BYTES) {
    throw remoteError('remote_session_key_invalid')
  }

  let nextSendSequence = 1
  let nextReceiveSequence = 1
  let closed = false

  function assertOpen() {
    if (closed) throw remoteError('remote_session_closed')
  }

  return {
    get sessionId() {
      return safeSessionId
    },
    get expectedReceiveSequence() {
      return nextReceiveSequence
    },
    close() {
      if (closed) return
      closed = true
      sendKey.fill(0)
      receiveKey.fill(0)
    },
    encrypt(payload) {
      assertOpen()
      const sequence = nextSendSequence
      const plaintext = canonicalBuffer(payload)
      if (plaintext.length > REMOTE_MAX_FRAME_BYTES) throw remoteError('remote_payload_size_invalid')
      const aad = buildFrameAad({ sessionId: safeSessionId, sequence, direction: sendDirection })
      const encrypted = encryptAead({ key: sendKey, plaintext, aad })
      nextSendSequence += 1
      return {
        v: REMOTE_PROTOCOL_VERSION,
        type: 'remote.encrypted',
        sessionId: safeSessionId,
        sequence,
        ...encrypted
      }
    },
    decrypt(frame) {
      assertOpen()
      if (!frame || typeof frame !== 'object' || frame.type !== 'remote.encrypted' || Number(frame.v) !== REMOTE_PROTOCOL_VERSION) {
        throw remoteError('remote_frame_invalid')
      }
      const frameSessionId = normalizeIdentifier(frame.sessionId, 'sessionId', { minLength: 16, maxLength: 128 })
      if (frameSessionId !== safeSessionId) throw remoteError('remote_session_mismatch')
      const sequence = normalizeSequence(frame.sequence)
      if (sequence !== nextReceiveSequence) {
        throw remoteError(sequence < nextReceiveSequence ? 'remote_frame_replayed' : 'remote_frame_out_of_order')
      }
      const aad = buildFrameAad({ sessionId: safeSessionId, sequence, direction: receiveDirection })
      const plaintext = decryptAead({ key: receiveKey, nonce: frame.nonce, ciphertext: frame.ciphertext, tag: frame.tag, aad })
      let payload
      try {
        payload = JSON.parse(plaintext.toString('utf8'))
      } catch {
        throw remoteError('remote_frame_payload_invalid')
      }
      if (!payload || typeof payload !== 'object' || Array.isArray(payload)) throw remoteError('remote_frame_payload_invalid')
      nextReceiveSequence += 1
      return payload
    }
  }
}
