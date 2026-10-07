import assert from 'node:assert/strict'
import {
  acceptSessionHello,
  completeDevicePairing,
  completeSessionHello,
  createDesktopPairingResponse,
  createP256KeyPair,
  createPairingStartEnvelope,
  createSessionHello,
  openDesktopPairingStart,
  publicKeyFromPrivate,
  verifyPairingProof
} from '../main/core/remote/cryptoSession.js'
import {
  REMOTE_PROTOCOL_VERSION,
  normalizeRemoteSettings,
  remoteError
} from '../main/core/remote/protocol.js'

function expectCode(callback, code) {
  assert.throws(callback, (error) => error?.code === code)
}

function buildPairingFixture() {
  const desktop = createP256KeyPair()
  const device = createP256KeyPair()
  const clientEphemeral = createP256KeyPair()
  const context = {
    pairingId: 'pairing-remote-v2-fixture-0001',
    pairingChallenge: 'Q2hhbmdlTWUtcmVtb3RlLXYyLWNoYWxsZW5nZQ',
    desktopId: 'desktop-remote-v2-fixture-0001'
  }

  const desktopResponse = createDesktopPairingResponse({
    desktopPrivateKey: desktop.privateKey,
    desktopPublicKey: desktop.publicKey,
    devicePublicKey: device.publicKey,
    clientEphemeralPublicKey: clientEphemeral.publicKey,
    context
  })
  const deviceResponse = completeDevicePairing({
    devicePrivateKey: device.privateKey,
    desktopPublicKey: desktop.publicKey,
    serverEphemeralPublicKey: desktopResponse.serverEphemeralPublicKey,
    clientEphemeralPrivateKey: clientEphemeral.privateKey,
    devicePublicKey: device.publicKey,
    context,
    desktopProof: desktopResponse.desktopProof
  })

  return { desktop, device, clientEphemeral, context, desktopResponse, deviceResponse }
}

function createConnectedSessions({ rootSecret, deviceId, desktopId }) {
  const clientHandshake = createSessionHello({ rootSecret, deviceId, desktopId })
  const accepted = acceptSessionHello({
    rootSecret,
    hello: clientHandshake.hello,
    expectedDeviceId: deviceId,
    expectedDesktopId: desktopId
  })
  const deviceSession = completeSessionHello({
    state: clientHandshake.state,
    accept: accepted.accept,
    expectedDeviceId: deviceId,
    expectedDesktopId: desktopId
  })
  return { clientHandshake, accepted, deviceSession }
}

function run() {
  const fixture = buildPairingFixture()
  const desktopRootSecret = fixture.desktopResponse.secrets.rootSecret.toString('base64url')
  assert.equal(desktopRootSecret, fixture.deviceResponse.rootSecret)
  assert.equal(fixture.desktopResponse.transcriptHash, fixture.deviceResponse.transcriptHash)
  assert.equal(
    verifyPairingProof({
      rootSecret: fixture.desktopResponse.secrets.rootSecret,
      transcript: fixture.desktopResponse.secrets.transcript,
      role: 'device',
      proof: fixture.deviceResponse.deviceProof
    }),
    true,
    'device proof must verify only against the exact pairing transcript'
  )
  assert.equal(
    verifyPairingProof({
      rootSecret: fixture.desktopResponse.secrets.rootSecret,
      transcript: Buffer.from('tampered transcript', 'utf8'),
      role: 'device',
      proof: fixture.deviceResponse.deviceProof
    }),
    false,
    'proof must bind the exact transcript'
  )

  const pairStart = createPairingStartEnvelope({
    desktopPublicKey: fixture.desktop.publicKey,
    clientEphemeralPrivateKey: fixture.clientEphemeral.privateKey,
    context: fixture.context,
    pairingCode: '123 456',
    device: {
      deviceId: 'device-remote-v2-fixture-0001',
      displayName: 'Fixture Phone',
      platform: 'android',
      appVersion: 'test',
      publicKey: fixture.device.publicKey
    }
  })
  assert.equal(JSON.stringify(pairStart).includes('123456'), false, 'pair-start must not expose the human code')
  const openedPairStart = openDesktopPairingStart({
    desktopPrivateKey: fixture.desktop.privateKey,
    desktopPublicKey: fixture.desktop.publicKey,
    context: fixture.context,
    input: pairStart
  })
  assert.equal(openedPairStart.pairingCode, '123456')
  assert.equal(openedPairStart.device.deviceId, 'device-remote-v2-fixture-0001')
  const tamperedPairStart = { ...pairStart, tag: `${pairStart.tag.slice(0, -1)}${pairStart.tag.endsWith('A') ? 'B' : 'A'}` }
  expectCode(() => openDesktopPairingStart({
    desktopPrivateKey: fixture.desktop.privateKey,
    desktopPublicKey: fixture.desktop.publicKey,
    context: fixture.context,
    input: tamperedPairStart
  }), 'remote_frame_auth_failed')


  const deviceId = 'device-remote-v2-fixture-0001'
  const { accepted, deviceSession } = createConnectedSessions({
    rootSecret: fixture.deviceResponse.rootSecret,
    deviceId,
    desktopId: fixture.context.desktopId
  })

  const encryptedRequest = deviceSession.encrypt({
    kind: 'request',
    method: 'remote.status.get',
    params: { includeDevices: true },
    requestId: 'request-remote-v2-fixture-0001'
  })
  assert.equal(encryptedRequest.v, REMOTE_PROTOCOL_VERSION)
  assert.deepEqual(accepted.session.decrypt(encryptedRequest), {
    kind: 'request',
    method: 'remote.status.get',
    params: { includeDevices: true },
    requestId: 'request-remote-v2-fixture-0001'
  })
  expectCode(() => accepted.session.decrypt(encryptedRequest), 'remote_frame_replayed')

  const encryptedResponse = accepted.session.encrypt({
    kind: 'response',
    ok: true,
    result: { running: true }
  })
  assert.deepEqual(deviceSession.decrypt(encryptedResponse), {
    kind: 'response',
    ok: true,
    result: { running: true }
  })

  // A rejected oversize send must not consume a sequence number.
  const sequenceConnection = createConnectedSessions({
    rootSecret: fixture.deviceResponse.rootSecret,
    deviceId,
    desktopId: fixture.context.desktopId
  })
  expectCode(() => sequenceConnection.deviceSession.encrypt({ content: 'x'.repeat(300 * 1024) }), 'remote_payload_size_invalid')
  const postFailureFrame = sequenceConnection.deviceSession.encrypt({ kind: 'request', method: 'remote.ping', requestId: 'request-sequence-safe-0001' })
  assert.equal(postFailureFrame.sequence, 1)
  assert.equal(sequenceConnection.accepted.session.decrypt(postFailureFrame).method, 'remote.ping')

  // A fresh WSS connection uses new ephemeral key material even for the same paired device.
  const nextConnection = createConnectedSessions({
    rootSecret: fixture.deviceResponse.rootSecret,
    deviceId,
    desktopId: fixture.context.desktopId
  })
  const oldFrame = deviceSession.encrypt({ kind: 'request', method: 'remote.ping', requestId: 'request-old-session-0001' })
  expectCode(() => nextConnection.accepted.session.decrypt(oldFrame), 'remote_session_mismatch')

  // Authentication failures and sequence gaps intentionally require a new transport session.
  const failureConnection = createConnectedSessions({
    rootSecret: fixture.deviceResponse.rootSecret,
    deviceId,
    desktopId: fixture.context.desktopId
  })
  const tampered = failureConnection.deviceSession.encrypt({ kind: 'request', method: 'remote.status.get', requestId: 'request-tampered-0001' })
  tampered.tag = `${tampered.tag.slice(0, -1)}${tampered.tag.endsWith('A') ? 'B' : 'A'}`
  expectCode(() => failureConnection.accepted.session.decrypt(tampered), 'remote_frame_auth_failed')
  const nextFrame = failureConnection.deviceSession.encrypt({ kind: 'request', method: 'remote.status.get', requestId: 'request-after-tamper-0001' })
  expectCode(() => failureConnection.accepted.session.decrypt(nextFrame), 'remote_frame_out_of_order')

  const orderConnection = createConnectedSessions({
    rootSecret: fixture.deviceResponse.rootSecret,
    deviceId,
    desktopId: fixture.context.desktopId
  })
  const orderFrame = orderConnection.deviceSession.encrypt({ kind: 'request', method: 'remote.status.get', requestId: 'request-order-0001' })
  const outOfOrder = { ...orderFrame, sequence: orderFrame.sequence + 1 }
  expectCode(() => orderConnection.accepted.session.decrypt(outOfOrder), 'remote_frame_out_of_order')
  assert.deepEqual(orderConnection.accepted.session.decrypt(orderFrame), {
    kind: 'request',
    method: 'remote.status.get',
    requestId: 'request-order-0001'
  })

  assert.equal(publicKeyFromPrivate(fixture.desktop.privateKey), fixture.desktop.publicKey)
  assert.deepEqual(normalizeRemoteSettings({ remote: { enabled: true, host: '', port: 17860 } }), {
    enabled: true,
    host: '0.0.0.0',
    port: 17860,
    publicEndpoint: ''
  })
  assert.equal(remoteError('fixture').code, 'fixture')

  accepted.session.close()
  deviceSession.close()
  expectCode(() => deviceSession.encrypt({ kind: 'request', method: 'after.close', requestId: 'request-after-close-0001' }), 'remote_session_closed')

  console.log(JSON.stringify({ ok: true, suite: 'remote-crypto', protocolVersion: REMOTE_PROTOCOL_VERSION }))
}

run()
