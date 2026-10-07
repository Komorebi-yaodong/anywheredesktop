import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import https from 'node:https'
import { once } from 'node:events'
import { WebSocket } from 'ws'
import { createRemoteGateway } from '../main/core/remote/index.js'
import {
  completeDevicePairing,
  completeSessionHello,
  createP256KeyPair,
  createPairingStartEnvelope,
  createSessionHello
} from '../main/core/remote/cryptoSession.js'

function createMemorySecureStorage() {
  const key = crypto.randomBytes(32)
  return {
    isEncryptionAvailable: () => true,
    encryptString(value) {
      const nonce = crypto.randomBytes(12)
      const cipher = crypto.createCipheriv('aes-256-gcm', key, nonce)
      const body = Buffer.concat([cipher.update(String(value), 'utf8'), cipher.final()])
      return Buffer.concat([nonce, cipher.getAuthTag(), body])
    },
    decryptString(buffer) {
      const data = Buffer.from(buffer)
      const nonce = data.subarray(0, 12)
      const tag = data.subarray(12, 28)
      const body = data.subarray(28)
      const decipher = crypto.createDecipheriv('aes-256-gcm', key, nonce)
      decipher.setAuthTag(tag)
      return Buffer.concat([decipher.update(body), decipher.final()]).toString('utf8')
    }
  }
}

function createStorage() {
  const map = new Map()
  return {
    async get(key, fallback) {
      return { ok: true, value: map.has(key) ? structuredClone(map.get(key)) : structuredClone(fallback) }
    },
    async set(key, value) {
      map.set(key, structuredClone(value))
      return { ok: true, key }
    }
  }
}

async function findFreePort() {
  const server = https.createServer()
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const address = server.address()
  await new Promise((resolve) => server.close(resolve))
  return address.port
}

function requestSelfSignedJson({ url, method = 'GET', body = null }) {
  return new Promise((resolve, reject) => {
    const target = new URL(url)
    const text = body ? JSON.stringify(body) : ''
    const request = https.request({
      hostname: target.hostname,
      port: target.port,
      path: `${target.pathname}${target.search}`,
      method,
      rejectUnauthorized: false,
      headers: body ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(text) } : undefined
    }, (response) => {
      const chunks = []
      response.on('data', (chunk) => chunks.push(chunk))
      response.on('end', () => {
        try {
          resolve({ status: response.statusCode || 0, body: JSON.parse(Buffer.concat(chunks).toString('utf8')) })
        } catch (error) {
          reject(error)
        }
      })
    })
    request.on('error', reject)
    request.end(text || undefined)
  })
}

function waitForMessage(socket, predicate, timeoutMs = 5000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanup()
      reject(new Error('timed_out_waiting_for_websocket_message'))
    }, timeoutMs)
    const onMessage = (raw) => {
      try {
        const parsed = JSON.parse(raw.toString())
        if (!predicate(parsed)) return
        cleanup()
        resolve(parsed)
      } catch {
        // Ignore unrelated malformed frames in this isolated test transport.
      }
    }
    const onError = (error) => {
      cleanup()
      reject(error)
    }
    const cleanup = () => {
      clearTimeout(timer)
      socket.off('message', onMessage)
      socket.off('error', onError)
    }
    socket.on('message', onMessage)
    socket.on('error', onError)
  })
}

async function connectEncrypted({ endpoint, rootSecret, deviceId, desktopId }) {
  const socket = new WebSocket(`${endpoint.replace(/^https:/, 'wss:')}/api/v2/socket`, { rejectUnauthorized: false })
  await once(socket, 'open')
  const clientHandshake = createSessionHello({ rootSecret, deviceId, desktopId })
  socket.send(JSON.stringify(clientHandshake.hello))
  const accept = await waitForMessage(socket, (message) => message.type === 'remote.session.accept')
  const session = completeSessionHello({
    state: clientHandshake.state,
    accept,
    expectedDeviceId: deviceId,
    expectedDesktopId: desktopId
  })
  const welcomeFrame = await waitForMessage(socket, (message) => message.type === 'remote.encrypted')
  const welcome = session.decrypt(welcomeFrame)
  assert.equal(welcome.kind, 'event')
  assert.equal(welcome.event, 'remote.welcome', JSON.stringify(welcome))
  return { socket, session, welcome }
}

async function sendEncryptedRequest({ socket, session, requestId, method, params = {} }) {
  const responsePromise = waitForMessage(socket, (message) => message.type === 'remote.encrypted')
  socket.send(JSON.stringify(session.encrypt({ kind: 'request', requestId, method, params })))
  return session.decrypt(await responsePromise)
}

async function main() {
  const storage = createStorage()
  const port = await findFreePort()
  const app = {
    getPath: () => process.cwd(),
    getName: () => 'Anywhere Remote Test'
  }
  let observedPairing = null
  const conversationCalls = []
  const conversationReadService = {
    async listConversations(params = {}) {
      conversationCalls.push({ method: 'conversation.list', params: structuredClone(params) })
      if (Object.hasOwn(params, 'dirPath')) {
        const error = new Error('remote_path_parameter_forbidden')
        error.code = 'remote_path_parameter_forbidden'
        throw error
      }
      return {
        ok: true,
        configured: true,
        conversations: [{
          conversationId: 'conversation-gateway-fixture-0001',
          title: 'Gateway Fixture',
          revision: 3,
          format: 'sqlite'
        }],
        projects: [],
        page: { hasMore: false, nextCursor: null }
      }
    },
    async listMessages(params = {}) {
      conversationCalls.push({ method: 'conversation.messages.list', params: structuredClone(params) })
      return {
        ok: true,
        conversation: { conversationId: params.conversationId, title: 'Gateway Fixture', revision: 3 },
        messages: [{ messageId: 'message-1', role: 'user', order: 1, payload: { content: 'hello' } }],
        page: { hasMore: false, nextBeforeUiOrder: null }
      }
    },
    getWindows() {
      conversationCalls.push({ method: 'conversation.windows.list', params: {} })
      return {
        ok: true,
        windows: [{
          windowId: 'window-fixture',
          conversationId: 'conversation-gateway-fixture-0001',
          title: 'Gateway Fixture',
          revision: 3,
          visible: true,
          busy: false,
          generating: false,
          compacting: false,
          readOnly: false,
          leasePending: false,
          promptCode: 'AI'
        }]
      }
    }
  }

  const gateway = createRemoteGateway({
    app,
    safeStorage: createMemorySecureStorage(),
    dbStorageGetItem: storage.get,
    dbStorageSetItem: storage.set,
    conversationReadService,
    onPairingCreated: (payload) => { observedPairing = payload },
    logger: { log() {}, warn() {}, error() {} }
  })

  try {
    const started = await gateway.configure({ remote: { enabled: true, host: '127.0.0.1', port } })
    assert.equal(started.running, true)
    assert.equal(started.protocolVersion, 2)
    assert.equal(started.endpoints.length, 1)
    const endpoint = started.endpoints[0]

    const health = await requestSelfSignedJson({ url: `${endpoint}/health` })
    assert.equal(health.status, 200)
    assert.equal(health.body.protocolVersion, 2)

    const pairing = await gateway.createPairing()
    assert.equal(pairing.ok, true)
    assert.ok(observedPairing)
    assert.equal(Object.hasOwn(observedPairing, 'pairingCode'), false, 'QR payload must not contain the human confirmation code')
    assert.equal(pairing.qrDataUrl.includes(pairing.pairingCode.replace(/\s/g, '')), false, 'PNG transport must not contain the human code as plain text')

    const device = createP256KeyPair()
    const clientEphemeral = createP256KeyPair()
    const deviceId = 'device-remote-gateway-fixture-0001'
    const deviceDescriptor = {
      deviceId,
      displayName: 'Test Phone',
      platform: 'android',
      appVersion: 'test',
      publicKey: device.publicKey
    }
    const startBody = createPairingStartEnvelope({
      desktopPublicKey: observedPairing.desktopIdentityPublicKey,
      clientEphemeralPrivateKey: clientEphemeral.privateKey,
      context: {
        pairingId: observedPairing.pairingId,
        pairingChallenge: observedPairing.pairingChallenge,
        desktopId: observedPairing.desktopId
      },
      pairingCode: pairing.pairingCode,
      device: deviceDescriptor
    })
    assert.equal(JSON.stringify(startBody).includes(pairing.pairingCode.replace(/\s/g, '')), false)
    assert.equal(JSON.stringify(startBody).includes(observedPairing.pairingChallenge), false)
    assert.equal(JSON.stringify(startBody).includes(device.publicKey), false)

    const start = await requestSelfSignedJson({ url: `${endpoint}/api/v2/pair/start`, method: 'POST', body: startBody })
    assert.equal(start.status, 201, JSON.stringify(start.body))
    assert.equal(start.body.ok, true, JSON.stringify(start.body))
    assert.equal(start.body.desktopId, observedPairing.desktopId)

    const mobilePairing = completeDevicePairing({
      devicePrivateKey: device.privateKey,
      desktopPublicKey: observedPairing.desktopIdentityPublicKey,
      serverEphemeralPublicKey: start.body.serverEphemeralPublicKey,
      clientEphemeralPrivateKey: clientEphemeral.privateKey,
      devicePublicKey: device.publicKey,
      context: {
        pairingId: observedPairing.pairingId,
        pairingChallenge: observedPairing.pairingChallenge,
        desktopId: observedPairing.desktopId
      },
      desktopProof: start.body.desktopProof
    })

    const rejected = await requestSelfSignedJson({
      url: `${endpoint}/api/v2/pair/confirm`,
      method: 'POST',
      body: {
        v: 2,
        pairingId: observedPairing.pairingId,
        pairingAttemptId: start.body.pairingAttemptId,
        deviceId,
        deviceProof: `${mobilePairing.deviceProof.slice(0, -1)}${mobilePairing.deviceProof.endsWith('A') ? 'B' : 'A'}`
      }
    })
    assert.equal(rejected.status, 400)
    assert.equal(rejected.body.error, 'remote_pairing_proof_invalid')

    // Start a fresh pairing after the deliberately rejected proof consumed the prior attempt.
    observedPairing = null
    const pairing2 = await gateway.createPairing()
    const qr2 = observedPairing
    const clientEphemeral2 = createP256KeyPair()
    const startBody2 = createPairingStartEnvelope({
      desktopPublicKey: qr2.desktopIdentityPublicKey,
      clientEphemeralPrivateKey: clientEphemeral2.privateKey,
      context: {
        pairingId: qr2.pairingId,
        pairingChallenge: qr2.pairingChallenge,
        desktopId: qr2.desktopId
      },
      pairingCode: pairing2.pairingCode,
      device: deviceDescriptor
    })
    const start2 = await requestSelfSignedJson({
      url: `${endpoint}/api/v2/pair/start`,
      method: 'POST',
      body: startBody2
    })
    assert.equal(start2.status, 201)
    const mobilePairing2 = completeDevicePairing({
      devicePrivateKey: device.privateKey,
      desktopPublicKey: qr2.desktopIdentityPublicKey,
      serverEphemeralPublicKey: start2.body.serverEphemeralPublicKey,
      clientEphemeralPrivateKey: clientEphemeral2.privateKey,
      devicePublicKey: device.publicKey,
      context: { pairingId: qr2.pairingId, pairingChallenge: qr2.pairingChallenge, desktopId: qr2.desktopId },
      desktopProof: start2.body.desktopProof
    })
    const confirm = await requestSelfSignedJson({
      url: `${endpoint}/api/v2/pair/confirm`,
      method: 'POST',
      body: {
        v: 2,
        pairingId: qr2.pairingId,
        pairingAttemptId: start2.body.pairingAttemptId,
        deviceId,
        deviceProof: mobilePairing2.deviceProof
      }
    })
    assert.equal(confirm.status, 201)
    assert.equal(confirm.body.ok, true)

    const devices = await gateway.listDevices()
    assert.equal(devices.devices.length, 1)
    assert.equal(devices.devices[0].deviceId, deviceId)

    const { socket, session, welcome } = await connectEncrypted({
      endpoint,
      rootSecret: mobilePairing2.rootSecret,
      deviceId,
      desktopId: qr2.desktopId
    })
    assert.ok(welcome.payload.capabilities.includes('conversation.list'))
    assert.ok(welcome.payload.capabilities.includes('conversation.messages.list'))
    assert.ok(welcome.payload.capabilities.includes('conversation.windows.list'))

    const statusResponse = await sendEncryptedRequest({
      socket,
      session,
      requestId: 'request-remote-gateway-status-0001',
      method: 'remote.status.get'
    })
    assert.equal(statusResponse.kind, 'response')
    assert.equal(statusResponse.result.device.deviceId, deviceId)
    assert.ok(statusResponse.result.capabilities.includes('conversation.list'))

    const listResponse = await sendEncryptedRequest({
      socket,
      session,
      requestId: 'request-conversation-list-0001',
      method: 'conversation.list',
      params: { limit: 20 }
    })
    assert.equal(listResponse.ok, true)
    assert.equal(listResponse.result.conversations[0].conversationId, 'conversation-gateway-fixture-0001')

    const messagesResponse = await sendEncryptedRequest({
      socket,
      session,
      requestId: 'request-conversation-messages-0001',
      method: 'conversation.messages.list',
      params: { conversationId: 'conversation-gateway-fixture-0001', pageSize: 25 }
    })
    assert.equal(messagesResponse.ok, true)
    assert.equal(messagesResponse.result.messages[0].payload.content, 'hello')

    const windowsResponse = await sendEncryptedRequest({
      socket,
      session,
      requestId: 'request-conversation-windows-0001',
      method: 'conversation.windows.list'
    })
    assert.equal(windowsResponse.ok, true)
    assert.equal(windowsResponse.result.windows[0].windowId, 'window-fixture')

    const forbiddenResponse = await sendEncryptedRequest({
      socket,
      session,
      requestId: 'request-conversation-forbidden-0001',
      method: 'conversation.list',
      params: { dirPath: 'C:/attacker' }
    })
    assert.equal(forbiddenResponse.ok, false)
    assert.equal(forbiddenResponse.error.code, 'remote_path_parameter_forbidden')

    const pingAfterError = await sendEncryptedRequest({
      socket,
      session,
      requestId: 'request-ping-after-error-0001',
      method: 'remote.ping'
    })
    assert.equal(pingAfterError.ok, true)

    const eventPromise = waitForMessage(socket, (message) => message.type === 'remote.encrypted')
    const broadcast = gateway.broadcastEvent('conversation.windows.changed', {
      reason: 'updated',
      windows: [{ windowId: 'window-fixture', conversationId: 'conversation-gateway-fixture-0001', busy: true }]
    })
    assert.equal(broadcast.sent, 1)
    const windowEvent = session.decrypt(await eventPromise)
    assert.equal(windowEvent.kind, 'event')
    assert.equal(windowEvent.event, 'conversation.windows.changed')
    assert.equal(windowEvent.payload.windows[0].busy, true)

    assert.deepEqual(conversationCalls.map((item) => item.method), [
      'conversation.list',
      'conversation.messages.list',
      'conversation.windows.list',
      'conversation.list'
    ])

    const revoked = await gateway.revokeDevice(deviceId)
    assert.equal(revoked.removed, true)
    const [closeCode] = await once(socket, 'close')
    assert.equal(closeCode, 4001)
    session.close()

    const audit = await gateway.getAuditLog()
    assert.ok(audit.entries.some((entry) => entry.type === 'remote.device.paired'))
    assert.ok(audit.entries.every((entry) => !JSON.stringify(entry).includes(mobilePairing2.rootSecret)))

    const stopped = await gateway.configure({ remote: { enabled: false, host: '127.0.0.1', port, publicEndpoint: 'https://tunnel.example.test' } })
    assert.equal(stopped.running, false)
    assert.equal(stopped.enabled, false)
    assert.equal(stopped.port, port)
    assert.equal(stopped.publicEndpoint, 'https://tunnel.example.test')

    console.log(JSON.stringify({ ok: true, suite: 'remote-gateway', protocolVersion: 2 }))
  } finally {
    await gateway.stop()
  }
}

main().catch((error) => {
  console.error(error?.stack || error)
  process.exitCode = 1
})
