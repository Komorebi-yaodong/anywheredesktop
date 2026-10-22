import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import https from 'node:https'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { once } from 'node:events'
import { WebSocket } from 'ws'
import { createRemoteGateway } from '../../main/core/remote/index.js'
import { createRemoteSessionManager } from '../../main/core/remote/sessionManager.js'
import { createRemoteUploadManager } from '../../main/core/remote/uploadManager.js'
import { createRemoteBusinessConfigService } from '../../main/core/remote/businessConfig.js'
import { createRemoteManagementService } from '../../main/core/remote/management.js'
import {
  completeDevicePairing,
  completeSessionHello,
  createP256KeyPair,
  createPairingStartEnvelope,
  createSessionHello
} from '../../main/core/remote/cryptoSession.js'

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
  const events = []
  const response = new Promise((resolve, reject) => {
    const timer = setTimeout(() => { cleanup(); reject(new Error('rpc_timeout')) }, 5000)
    const onMessage = (raw) => {
      try {
        const frame = JSON.parse(raw.toString())
        if (frame.type !== 'remote.encrypted') return
        const message = session.decrypt(frame)
        if (message.kind === 'response' && message.requestId === requestId) { cleanup(); resolve(message) }
        else events.push(message)
      } catch (error) { cleanup(); reject(error) }
    }
    const cleanup = () => { clearTimeout(timer); socket.off('message', onMessage) }
    socket.on('message', onMessage)
  })
  socket.send(JSON.stringify(session.encrypt({ kind: 'request', requestId, method, params })))
  const result = await response
  result.events = events
  return result
}

async function readServerCertificate(endpoint) {
  return new Promise((resolve, reject) => {
    // The fixture's public self-signed cert is inspected here. No global TLS override.
    const request = https.get(`${endpoint}/health`, { rejectUnauthorized: false, agent: false }, (response) => {
      const cert = new crypto.X509Certificate(response.socket.getPeerCertificate().raw)
      response.resume()
      response.on('end', () => resolve(cert))
    })
    request.on('error', reject)
  })
}


async function verifyPersistedTlsLifecycle() {
  const storage = createStorage()
  const safeStorage = createMemorySecureStorage()
  const port = await findFreePort()
  let lanAddress = '127.0.0.2'
  const makeGateway = () => createRemoteGateway({
    app: { getPath: () => process.cwd(), getName: () => 'TLS Fixture' },
    safeStorage, dbStorageGetItem: storage.get, dbStorageSetItem: storage.set,
    getLanAddresses: () => [lanAddress],
    logger: { log() {}, warn() {}, error() {} }
  })
  const config = { remote: { enabled: true, host: '127.0.0.1', port } }
  let gateway = makeGateway()
  try {
    let status = await gateway.configure(config)
    assert.equal(status.running, true)
    const firstFingerprint = status.certificateFingerprint
    await gateway.stop()
    lanAddress = '127.0.0.3'
    gateway = makeGateway()
    status = await gateway.configure(config)
    assert.notEqual(status.certificateFingerprint, firstFingerprint, 'a new process must refresh persisted stale SANs before advertising a QR')
    const pinnedFingerprint = status.certificateFingerprint
    await gateway.stop()
    // Synthetic trusted-device metadata only: no actual device/root secrets.
    await storage.set('remote:v2:devices', { version: 2, devices: [{ deviceId: 'device-tls-fixture-0001' }] })
    lanAddress = '127.0.0.4'
    gateway = makeGateway()
    status = await gateway.configure({ remote: { enabled: true, host: '0.0.0.0', port } })
    assert.equal(status.running, true)
    assert.equal(status.certificateFingerprint, pinnedFingerprint)
    assert.deepEqual(status.endpoints, [], 'an uncovered direct endpoint must never enter the QR')
    await assert.rejects(gateway.createPairing(), { code: 'remote_certificate_lan_address_changed' })
    assert.equal(gateway.getStatus().certificateFingerprint, pinnedFingerprint)
    const tunnel = 'https://tunnel.fixture.test'
    await gateway.configure({ remote: { enabled: true, host: '0.0.0.0', port, publicEndpoint: tunnel } })
    const retainedTunnelStatus = gateway.getStatus()
    assert.equal(retainedTunnelStatus.publicEndpoint, tunnel)
    assert.equal(retainedTunnelStatus.configuredSettings.publicEndpoint, tunnel)
    assert.deepEqual(retainedTunnelStatus.lanAddresses, ['127.0.0.4'])
    assert.deepEqual(retainedTunnelStatus.certificateCoveredLanAddresses, [])

    const pairing = await gateway.createPairing()
    assert.deepEqual(pairing.endpoints, [tunnel], 'system-TLS tunnels remain independent of the LAN certificate SAN')
    assert.equal(pairing.certificateFingerprint, pinnedFingerprint)
  } finally {
    await gateway.stop()
  }
}


async function main() {
  await verifyPersistedTlsLifecycle()

  const storage = createStorage()
  const port = await findFreePort()
  const sandbox = await fs.mkdtemp(path.join(os.tmpdir(), 'anywhere-remote-gateway-test-'))
  const uploadManager = createRemoteUploadManager({ tempRoot: path.join(sandbox, 'uploads') })

  let businessConfig = {
    language: 'zh',
    remote: { enabled: true, host: '127.0.0.1', port },
    skillPath: 'E:/PRIVATE_SKILLS',
    webdav: { url: 'https://dav.fixture', username: 'user', password: 'WEBDAV_SECRET', localChatPath: 'E:/PRIVATE_CHATS' },
    providers: { p1: { name: 'Provider', api_key: 'PROVIDER_SECRET', headers: { Authorization: 'HEADER_SECRET' } } },
    prompts: { AI: { prompt: 'Fixture prompt' } },
    mcpServers: { m1: { name: 'MCP', env: { TOKEN: 'MCP_SECRET' } } },
    tasks: {}
  }
  const businessConfigService = createRemoteBusinessConfigService({
    getConfig: async () => ({ config: structuredClone(businessConfig) }),
    updateConfig: async ({ config }) => { businessConfig = structuredClone(config); return { success: true, config: structuredClone(config) } }
  })
  const remoteManagementService = createRemoteManagementService({
    getConfig: async () => ({config:structuredClone(businessConfig)}),
    updateConfig: async ({config}) => {businessConfig=structuredClone(config);return {success:true}},
    readProjects: async () => ({projects:[]}),
    skills:{list:async()=>[],get:async()=>null},setTaskEnabled(){},getTaskDevice:()=>({})
  })

  const app = {
    getPath: () => process.cwd(),
    getName: () => 'Anywhere Remote Test'
  }
  let observedPairing = null
  const conversationCalls = []
  let fixtureLanAddress = '127.0.0.1'

  let responseFailureFixture = ''

  const conversationReadService = {
    async listConversations(params = {}) {
      conversationCalls.push({ method: 'conversation.list', params: structuredClone(params) })

      if (responseFailureFixture === 'wire_size') return { ok: true, synthetic: 'x'.repeat(200 * 1024) }
      if (responseFailureFixture === 'plaintext_size') return { ok: true, synthetic: 'x'.repeat(300 * 1024) }
      if (responseFailureFixture === 'invalid_value') return { ok: true, synthetic: NaN }
      if (responseFailureFixture === 'circular') { const value = { ok: true }; value.self = value; return value }
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
    uploadManager,
    businessConfigService,
    remoteManagementService,
    getDesktopDisplayName: async () => 'Fixture Workspace',
    onPairingCreated: (payload) => { observedPairing = payload },
    getLanAddresses: () => [fixtureLanAddress],
    logger: { log() {}, warn() {}, error() {} }
  })

  const writerCommands = []
  let mobileUsageRecords = 0
  const writerWindows = [
    { id: 'window-fixture', type: 'window', conversationId: 'conversation-gateway-fixture-0001', rendererReady: true, remoteHidden: false },
    { id: 'window-fixture-revoke', type: 'window', conversationId: 'conversation-gateway-fixture-0002', rendererReady: true, remoteHidden: false }
  ]
  const sessionManager = createRemoteSessionManager({
    getConfig: async () => ({ config: {webdav: {localChatPath: 'PRIVATE_FIXTURE_PATH'}, desktop: {quickAssistantUsage: {}}, providers: {fixture: {name: 'Fixture Provider'}}, prompts: {Code: {name: 'Code Agent', prompt: 'PRIVATE_FIXTURE_PROMPT', model: 'fixture|model', icon: 'https://example.test/code.png', autoSaveProjectId: 'fixture-project', defaultMcpServers: ['mcp-a'], defaultSkills: ['skill-a']}, QuickOnly: {name: 'Quick Only', showMode: 'fastinput'}}} }),
    openConversation: async () => { throw new Error('existing_writer_expected') },
    openWindow: async (type, payload) => {
      assert.equal(payload.remoteCreate, true)
      assert.equal(payload.code, 'Code')
      const item = {id: 'window-created-fixture', type, conversationId: 'conversation-created-gateway-fixture',
        conversationTitle: payload.conversationTitle, rendererReady: true, remoteHidden: true}
      writerWindows.push(item)
      return {ok: true, id: item.id}
    },
    listWindows: () => writerWindows,
    getWindowByRef: () => ({ isDestroyed: () => false }),
    readLocalProjects: async () => ({ projects: [{id: 'fixture-project', name: 'Fixture Project'}] }),
    recordAssistantUsage: async () => { mobileUsageRecords += 1 },
    revealRemoteConversationWindow: () => ({ ok: true }),
    uploadManager,
    broadcastToDevice: (deviceId, event, payload) => gateway.sendEventToDevice(deviceId, event, payload),
    dispatchRemoteCommandToWindow: async (windowRef, command) => {
      writerCommands.push(command)

      if (command.type === 'conversation.mobile.takeover') {
        const receipt = sessionManager.handleRendererEvent({windowRef, payload: {
          conversationId: command.conversationId, requestId: command.requestId,
          event: 'conversation.mobile.control.result', payload: {ok: true}
        }})
        assert.equal(receipt.ok, true, 'encrypted takeover waits for the actual writer receipt')
      }

      if (command.type === 'conversation.compact') {
        sessionManager.handleRendererEvent({ windowRef, payload: {
          conversationId: command.conversationId, requestId: command.requestId,
          event: 'conversation.compact.progress', payload: { percent: 50, stage: 'cascade', message: 'fixture' }
        } })
        sessionManager.handleRendererEvent({ windowRef, payload: {
          conversationId: command.conversationId, requestId: command.requestId,
          event: 'conversation.compact.completed', payload: { changed: true, revision: 7 }
        } })
      }

      if (command.type === 'conversation.config.get' || command.type === 'conversation.config.patch') {
        sessionManager.handleRendererEvent({ windowRef, payload: {
          conversationId: command.conversationId, requestId: command.requestId,
          event: 'conversation.config.result',
          payload: {
            revision: 6,
            patched: command.patch ? Object.keys(command.patch) : [],
            config: { model: command.patch?.model || 'provider|model-a', reasoningEffort: command.patch?.reasoningEffort || 'default', voice: '', mcpServerIds: [], skillIds: [], systemPrompt: command.patch?.systemPrompt || 'session prompt', compact: { triggerRatio: 0.8 } },
            options: { models: [{ value: 'provider|model-a', label: 'Model A', api_key: 'MUST_NOT_LEAK' }], reasoningEfforts: ['default', 'high'], voices: [], mcpServers: [], skills: [] }
          }
        } })
      }

      if (command.type === 'conversation.message.edit') {
        sessionManager.handleRendererEvent({ windowRef, payload: {
          conversationId: command.conversationId, requestId: command.requestId,
          event: 'conversation.operation.completed',
          payload: { operation: command.type, uiMessageId: command.uiMessageId, revision: 5 }
        } })
      }

      if (command.type === 'conversation.rename' || command.type === 'conversation.delete') {
        sessionManager.handleRendererEvent({ windowRef, payload: {
          conversationId: command.conversationId, requestId: command.requestId,
          event: 'conversation.operation.completed',
          payload: command.type === 'conversation.rename'
            ? { operation: command.type, title: command.title, revision: 8 }
            : { operation: command.type, deleted: true, revision: 8 }
        } })
      }

      if (command.type === 'remote.shutdown') {
        const index = writerWindows.findIndex((item) => item.id === windowRef)
        if (index >= 0) writerWindows.splice(index, 1)
        sessionManager.handleWindowClosed(windowRef)
      }


      if (command.type === 'conversation.cancel') {
        sessionManager.handleRendererEvent({ windowRef, payload: {
          conversationId: command.conversationId, requestId: command.targetRequestId,
          event: 'assistant.cancelled', payload: { revision: 4 }
        } })
      }
      return { ok: true }
    }
  })
  gateway.setSessionManager(sessionManager)


  try {
    const started = await gateway.configure({ remote: { enabled: true, host: '127.0.0.1', port } })
    assert.equal(started.running, true)
    assert.equal(started.protocolVersion, 2)
    assert.equal(started.endpoints.length, 1)
    const endpoint = started.endpoints[0]

    const health = await requestSelfSignedJson({ url: `${endpoint}/health` })
    assert.equal(health.status, 200)
    assert.equal(health.body.protocolVersion, 2)

    const initialCertificate = await readServerCertificate(endpoint)
    const initialFingerprint = gateway.getStatus().certificateFingerprint
    fixtureLanAddress = '127.0.0.2'
    const rotatedPairing = await gateway.createPairing()
    assert.notEqual(rotatedPairing.certificateFingerprint, initialFingerprint, 'zero-device LAN changes must refresh the persisted TLS certificate')
    const rotatedCertificate = await readServerCertificate(endpoint)
    assert.equal(rotatedCertificate.checkIP(fixtureLanAddress), fixtureLanAddress)
    assert.notEqual(rotatedCertificate.fingerprint256, initialCertificate.fingerprint256, 'the active HTTPS context must use the new certificate')
    fixtureLanAddress = '127.0.0.1'
    await gateway.stop()
    fixtureLanAddress = '127.0.0.4'
    const restarted = await gateway.configure({ remote: { enabled: true, host: '127.0.0.1', port } })
    assert.equal(restarted.running, true)
    assert.notEqual(restarted.certificateFingerprint, rotatedPairing.certificateFingerprint, 'startup must also refresh stale persisted SANs with zero devices')
    assert.equal((await readServerCertificate(endpoint)).checkIP(fixtureLanAddress), fixtureLanAddress)
    fixtureLanAddress = '127.0.0.1'


    const pairing = await gateway.createPairing()
    assert.equal(pairing.ok, true)
    assert.ok(observedPairing)
    assert.equal(JSON.parse(pairing.qrPayload).n, 'Fixture Workspace')
    assert.equal(observedPairing.desktopName, 'Fixture Workspace')


    assert.equal(Object.hasOwn(JSON.parse(pairing.qrPayload), 'pairingCode'), false)
    const qrPng = Buffer.from(pairing.qrDataUrl.split(',')[1], 'base64')
    assert.equal(qrPng.readUInt32BE(16), 1024)
    assert.equal(qrPng.readUInt32BE(20), 1024)
    const compactQr = JSON.parse(pairing.qrPayload)
    assert.deepEqual(Object.keys(compactQr).sort(), ['c', 'd', 'e', 'endpoints', 'f', 'i', 'k', 'n', 'v', 'x'])
    assert.deepEqual(compactQr.endpoints, pairing.endpoints)
    assert.ok(JSON.stringify(compactQr).length < JSON.stringify(observedPairing).length)

    assert.equal(Object.hasOwn(observedPairing, 'pairingCode'), false, 'QR payload must not contain the human confirmation code')
    assert.equal(pairing.qrDataUrl.includes(pairing.pairingCode.replace(/\s/g, '')), false, 'PNG transport must not contain the human code as plain text')

    const device = createP256KeyPair()
    const clientEphemeral = createP256KeyPair()
    const deviceId = 'device-remote-gateway-fixture-0001'
    const deviceDescriptor = {
      deviceId,
      displayName: 'Test Phone',
      platform: 'android',
      deviceModel: 'Fixture Phone Model',
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
    assert.equal(start.body.desktopName, 'Fixture Workspace')


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
    assert.equal(confirm.body.desktopName, 'Fixture Workspace')


    const devices = await gateway.listDevices()
    assert.equal(devices.devices.length, 1)
    assert.equal(devices.devices[0].deviceId, deviceId)

    fixtureLanAddress = '127.0.0.3'
    const pairedFingerprint = gateway.getStatus().certificateFingerprint
    await gateway.createPairing()
    assert.equal(gateway.getStatus().certificateFingerprint, pairedFingerprint, 'LAN changes must never silently invalidate paired-device TLS pins')
    assert.equal(gateway.getStatus().lastError, 'remote_certificate_lan_address_changed')
    assert.deepEqual(gateway.getStatus().endpoints, [endpoint], 'only covered direct endpoints may be published')
    assert.equal((await readServerCertificate(endpoint)).checkIP(fixtureLanAddress), undefined)
    fixtureLanAddress = '127.0.0.1'


    const { socket, session, welcome } = await connectEncrypted({
      endpoint,
      rootSecret: mobilePairing2.rootSecret,
      deviceId,
      desktopId: qr2.desktopId
    })
    assert.ok(welcome.payload.capabilities.includes('conversation.create'))
    const assistantList = await sendEncryptedRequest({socket, session, requestId: 'request-list-assistants', method: 'conversation.assistants.list'})
    assert.deepEqual(assistantList.result.assistants, [{code: 'Code', name: 'Code Agent', icon: 'https://example.test/code.png', model: 'Fixture Provider | model', defaultProjectName: 'Fixture Project', mcpCount: 1, skillCount: 1, usageWeight: 0}])
    assert.equal(JSON.stringify(assistantList).includes('PRIVATE'), false)
    const createdConversation = await sendEncryptedRequest({socket, session, requestId: 'request-create-conversation',
      method: 'conversation.create', params: {promptCode: 'Code'}})
    assert.equal(createdConversation.result.conversationId, 'conversation-created-gateway-fixture')
    assert.equal(createdConversation.result.promptCode, 'Code')
    assert.equal(JSON.stringify(createdConversation.result).includes('PRIVATE'), false)
    assert.equal(mobileUsageRecords, 1)
    const duplicateCreate = await sendEncryptedRequest({socket, session, requestId: 'request-create-conversation', method: 'conversation.create', params: {promptCode: 'Code'}})
    assert.equal(duplicateCreate.result.duplicate, true)
    assert.equal(mobileUsageRecords, 1)



    assert.ok(welcome.payload.capabilities.includes('conversation.list'))
    assert.ok(welcome.payload.capabilities.includes('conversation.messages.list'))
    assert.ok(welcome.payload.capabilities.includes('conversation.windows.list'))

    assert.ok(welcome.payload.capabilities.includes('attachment.begin'))
    assert.ok(welcome.payload.capabilities.includes('attachment.chunk'))
    assert.ok(welcome.payload.capabilities.includes('attachment.complete'))
    assert.ok(welcome.payload.capabilities.includes('attachment.abort'))

    assert.ok(welcome.payload.capabilities.includes('management.catalog'))
    const structuredCatalog=await sendEncryptedRequest({socket,session,requestId:'request-management-catalog',method:'management.catalog',params:{section:'providers'}})
    assert.equal(structuredCatalog.ok,true)
    assert.equal(JSON.stringify(structuredCatalog).includes('PROVIDER_SECRET'),false)
    const structuredCreate=await sendEncryptedRequest({socket,session,requestId:'request-management-create',method:'management.mutate',params:{section:'assistants',id:'GatewayAssistant',operation:'create',patch:{name:'Fixture'}}})
    assert.equal(structuredCreate.ok,true)
    assert.equal(businessConfig.prompts.GatewayAssistant.name,'Fixture')

    assert.ok(welcome.payload.capabilities.includes('business.config.get'))
    assert.ok(welcome.payload.capabilities.includes('business.config.replace'))

    const businessManifest = await sendEncryptedRequest({
      socket, session,
      requestId: 'request-business-manifest',
      method: 'business.config.get',
      params: {}
    })
    assert.deepEqual(businessManifest.result.sections.map((item) => item.name), ['general', 'providers', 'prompts', 'mcpServers', 'tasks'])
    const businessGeneral = await sendEncryptedRequest({
      socket, session,
      requestId: 'request-business-general',
      method: 'business.config.get',
      params: { section: 'general' }
    })
    assert.equal(businessGeneral.result.value.webdav.password, 'WEBDAV_SECRET')
    assert.equal(JSON.stringify(businessGeneral.result).includes('PRIVATE_CHATS'), false)
    assert.equal(JSON.stringify(businessGeneral.result).includes('PRIVATE_SKILLS'), false)
    assert.equal(Object.hasOwn(businessGeneral.result.value, 'remote'), false)
    const businessProviders = await sendEncryptedRequest({
      socket, session,
      requestId: 'request-business-providers',
      method: 'business.config.get',
      params: { section: 'providers' }
    })
    assert.equal(businessProviders.result.value.p1.api_key, 'PROVIDER_SECRET')
    const businessProviderReplacement = {
      p2: { name: 'Remote Provider', api_key: 'REMOTE_PROVIDER_SECRET', headers: { Authorization: 'REMOTE_HEADER' } }
    }
    const businessReplaced = await sendEncryptedRequest({
      socket, session,
      requestId: 'request-business-replace',
      method: 'business.config.replace',
      params: { section: 'providers', expectedRevision: businessProviders.result.revision, value: businessProviderReplacement }
    })
    assert.equal(businessReplaced.result.value.p2.api_key, 'REMOTE_PROVIDER_SECRET')
    assert.equal(businessConfig.remote.port, port)
    assert.equal(businessConfig.skillPath, 'E:/PRIVATE_SKILLS')
    assert.equal(businessConfig.webdav.localChatPath, 'E:/PRIVATE_CHATS')
    const businessStale = await sendEncryptedRequest({
      socket, session,
      requestId: 'request-business-stale',
      method: 'business.config.replace',
      params: { section: 'providers', expectedRevision: businessProviders.result.revision, value: businessProviderReplacement }
    })
    assert.equal(businessStale.ok, false)
    assert.equal(businessStale.error.code, 'remote_business_config_revision_conflict')

    const statusResponse = await sendEncryptedRequest({
      socket,
      session,
      requestId: 'request-remote-gateway-status-0001',
      method: 'remote.status.get'
    })
    assert.equal(statusResponse.kind, 'response')
    assert.equal(statusResponse.result.device.deviceId, deviceId)

    const profileUpdated = await sendEncryptedRequest({
      socket, session, requestId: 'request-device-profile-update-0001', method: 'remote.device.profile.update',
      params: { platform: 'android', deviceModel: 'Fixture Phone Model', appVersion: 'test.1' }
    })
    assert.equal(profileUpdated.result.device.deviceModel, 'Fixture Phone Model')

    assert.equal(profileUpdated.result.device.appVersion, 'test.1')
    const invalidProfile = await sendEncryptedRequest({
      socket, session, requestId: 'request-device-profile-invalid-0001', method: 'remote.device.profile.update',
      params: { serial: 'MUST_NOT_ACCEPT' }
    })
    assert.equal(invalidProfile.ok, false)
    assert.equal(invalidProfile.error.code, 'remote_parameter_unknown')

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

    // An unrepresentable RPC response is not a transport failure. Reject only
    // that request and prove the same strict-sequence session still works.
    for (const [fixture, code] of [
      ['wire_size', 'remote_response_too_large'],
      ['plaintext_size', 'remote_response_too_large'],
      ['invalid_value', 'remote_response_invalid'],
      ['circular', 'remote_response_invalid']
    ]) {
      responseFailureFixture = fixture
      const rejected = await sendEncryptedRequest({ socket, session,
        requestId: `request-response-failure-${fixture}`, method: 'conversation.list' })
      assert.equal(rejected.ok, false, fixture)
      assert.equal(rejected.error.code, code, fixture)
      assert.equal(socket.readyState, WebSocket.OPEN, fixture)
      responseFailureFixture = ''
      const ping = await sendEncryptedRequest({ socket, session,
        requestId: `request-ping-after-${fixture}`, method: 'remote.ping' })
      assert.equal(ping.ok, true, fixture)
      assert.equal(socket.readyState, WebSocket.OPEN, fixture)
    }


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
      ...Array(4).fill('conversation.list'),
      'conversation.messages.list',
      'conversation.windows.list',
      'conversation.list'
    ])

    assert.ok(welcome.payload.capabilities.includes('conversation.request.get'))
    assert.ok(welcome.payload.capabilities.includes('conversation.open'))
    assert.ok(welcome.payload.capabilities.includes('conversation.opened.list'))
    assert.ok(welcome.payload.capabilities.includes('conversation.takeover'))
    assert.ok(welcome.payload.capabilities.includes('conversation.handoff'))
    assert.ok(welcome.payload.capabilities.includes('conversation.close'))
    const remoteRequestId = 'request-send-gateway-fixture'
    const sendInput = { conversationId: 'conversation-gateway-fixture-0001', text: 'Synthetic message only' }
    const openedForMobile = await sendEncryptedRequest({ socket, session, requestId: 'request-open-gateway-fixture', method: 'conversation.open', params: {conversationId: sendInput.conversationId} })
    assert.equal(openedForMobile.ok, true)
    assert.equal(openedForMobile.result.mobileControlled, false)
    const beforeTakeover = await sendEncryptedRequest({ socket, session, requestId: 'request-send-before-takeover', method: 'conversation.send', params: sendInput })
    assert.equal(beforeTakeover.ok, false)
    assert.equal(beforeTakeover.error.code, 'remote_conversation_takeover_required')
    const takenOver = await sendEncryptedRequest({ socket, session, requestId: 'request-takeover-gateway-fixture', method: 'conversation.takeover', params: {conversationId: sendInput.conversationId} })
    assert.equal(takenOver.ok, true)
    assert.equal(takenOver.result.mobileControlled, true)
    assert.equal(writerCommands.at(-1).type, 'conversation.mobile.takeover')
    const sent = await sendEncryptedRequest({ socket, session, requestId: remoteRequestId, method: 'conversation.send', params: sendInput })
    assert.equal(sent.ok, true)
    assert.equal(sent.events[0].event, 'conversation.command.accepted')
    assert.equal(writerCommands.at(-1).text, sendInput.text)
    const deltaPromise = waitForMessage(socket, (frame) => frame.type === 'remote.encrypted')
    gateway.handleRendererEvent({ windowRef: 'window-fixture', payload: {
      event: 'assistant.delta', requestId: remoteRequestId, conversationId: sendInput.conversationId,
      payload: { textDelta: 'Fixture reply', segmentId: 'bubble-1' }
    } })
    assert.equal(session.decrypt(await deltaPromise).payload.textDelta, 'Fixture reply')
    const disconnected = once(socket, 'close')
    socket.close()
    await disconnected
    session.close()
    // Accepted work continues without a transport; recovery state is owned by this paired device.
    gateway.handleRendererEvent({ windowRef: 'window-fixture', payload: {
      event: 'assistant.completed', requestId: remoteRequestId, conversationId: sendInput.conversationId,
      payload: { revision: 4 }
    } })
    const reconnected = await connectEncrypted({ endpoint, rootSecret: mobilePairing2.rootSecret, deviceId, desktopId: qr2.desktopId })
    const recovered = await sendEncryptedRequest({ ...reconnected, requestId: 'request-recover-fixture', method: 'conversation.request.get', params: { requestId: remoteRequestId } })
    assert.equal(recovered.result.terminal, true)
    assert.equal(recovered.result.text, 'Fixture reply')
    const retry = await sendEncryptedRequest({ ...reconnected, requestId: remoteRequestId, method: 'conversation.send', params: sendInput })
    assert.equal(retry.result.duplicate, true)
    assert.equal(writerCommands.filter((command) => command.type === 'conversation.send').length, 1)


    const invalidAttachment = Buffer.from('invalid attachment payload')
    const invalidBegin = await sendEncryptedRequest({
      ...reconnected,
      requestId: 'request-attachment-invalid-begin',
      method: 'attachment.begin',
      params: {
        name: 'invalid.txt', type: 'text/plain', size: invalidAttachment.length,
        sha256: crypto.createHash('sha256').update('different').digest('base64url')
      }
    })
    const invalidUploadId = invalidBegin.result.upload.uploadId
    await sendEncryptedRequest({
      ...reconnected,
      requestId: 'request-attachment-invalid-chunk',
      method: 'attachment.chunk',
      params: { uploadId: invalidUploadId, index: 0, data: invalidAttachment.toString('base64url') }
    })
    const invalidComplete = await sendEncryptedRequest({
      ...reconnected,
      requestId: 'request-attachment-invalid-complete',
      method: 'attachment.complete',
      params: { uploadId: invalidUploadId }
    })
    assert.equal(invalidComplete.ok, false)
    assert.equal(invalidComplete.error.code, 'remote_upload_integrity_failed')
    assert.equal(uploadManager.getUpload(invalidUploadId), null)

    const attachmentPayload = Buffer.alloc(128 * 1024, 0x5a)
    const attachmentBegin = await sendEncryptedRequest({
      ...reconnected,
      requestId: 'request-attachment-begin',
      method: 'attachment.begin',
      params: {
        name: 'remote-note.txt', type: 'text/plain', size: attachmentPayload.length,
        sha256: crypto.createHash('sha256').update(attachmentPayload).digest('base64url')
      }
    })
    const attachmentUploadId = attachmentBegin.result.upload.uploadId
    assert.equal(JSON.stringify(attachmentBegin).includes(sandbox), false)
    const attachmentChunk = await sendEncryptedRequest({
      ...reconnected,
      requestId: 'request-attachment-chunk',
      method: 'attachment.chunk',
      params: { uploadId: attachmentUploadId, index: 0, data: attachmentPayload.toString('base64url') }
    })
    assert.equal(attachmentChunk.result.upload.receivedBytes, attachmentPayload.length)
    const attachmentComplete = await sendEncryptedRequest({
      ...reconnected,
      requestId: 'request-attachment-complete',
      method: 'attachment.complete',
      params: { uploadId: attachmentUploadId }
    })
    assert.equal(attachmentComplete.result.upload.state, 'completed')

    const attachmentSendRequestId = 'request-send-attachment-gateway'
    const attachmentSend = await sendEncryptedRequest({
      ...reconnected,
      requestId: attachmentSendRequestId,
      method: 'conversation.send',
      params: { conversationId: sendInput.conversationId, text: '', uploadIds: [attachmentUploadId] }
    })
    assert.equal(attachmentSend.ok, true)
    assert.deepEqual(writerCommands.at(-1).uploadIds, [attachmentUploadId])
    assert.equal(writerCommands.at(-1).text, '')
    const rendererAttachment = await uploadManager.consumeForRenderer({
      windowRef: 'window-fixture', requestId: attachmentSendRequestId, uploadId: attachmentUploadId
    })
    assert.equal(rendererAttachment.base64, attachmentPayload.toString('base64'))
    assert.equal(Object.hasOwn(rendererAttachment, 'path'), false)
    assert.equal(Object.hasOwn(rendererAttachment, 'url'), false)
    gateway.handleRendererEvent({ windowRef: 'window-fixture', payload: {
      event: 'assistant.completed', requestId: attachmentSendRequestId, conversationId: sendInput.conversationId,
      payload: { revision: 5 }
    } })
    const attachmentRetry = await sendEncryptedRequest({
      ...reconnected,
      requestId: attachmentSendRequestId,
      method: 'conversation.send',
      params: { conversationId: sendInput.conversationId, text: '', uploadIds: [attachmentUploadId] }
    })
    assert.equal(attachmentRetry.result.duplicate, true)

    assert.ok(welcome.payload.capabilities.includes('conversation.compact'))
    assert.ok(welcome.payload.capabilities.includes('conversation.compact.cancel'))
    const compactRequestId = 'request-compact-gateway'
    const compactResponse = await sendEncryptedRequest({
      ...reconnected, requestId: compactRequestId, method: 'conversation.compact', params: { conversationId: sendInput.conversationId }
    })
    assert.equal(compactResponse.ok, true)
    assert.ok(compactResponse.events.some((item) => item.event === 'conversation.compact.progress'))
    const compactState = await sendEncryptedRequest({
      ...reconnected, requestId: 'request-compact-state', method: 'conversation.request.get', params: { requestId: compactRequestId }
    })
    assert.equal(compactState.result.terminal, true)
    assert.equal(compactState.result.result.changed, true)
    assert.equal(compactState.result.result.revision, 7)


    assert.ok(welcome.payload.capabilities.includes('conversation.config.get'))
    assert.ok(welcome.payload.capabilities.includes('conversation.config.patch'))
    const configGetId = 'request-config-get-gateway'
    const configGet = await sendEncryptedRequest({
      ...reconnected, requestId: configGetId, method: 'conversation.config.get', params: { conversationId: sendInput.conversationId }
    })
    assert.equal(configGet.ok, true)
    const configGetState = await sendEncryptedRequest({
      ...reconnected, requestId: 'request-config-get-state', method: 'conversation.request.get', params: { requestId: configGetId }
    })
    assert.equal(configGetState.result.result.config.model, 'provider|model-a')
    assert.equal(JSON.stringify(configGetState).includes('MUST_NOT_LEAK'), false)
    const configPatchId = 'request-config-patch-gateway'
    await sendEncryptedRequest({
      ...reconnected, requestId: configPatchId, method: 'conversation.config.patch',
      params: { conversationId: sendInput.conversationId, patch: { model: 'provider|model-a', reasoningEffort: 'high', systemPrompt: 'session only' } }
    })
    const configPatchState = await sendEncryptedRequest({
      ...reconnected, requestId: 'request-config-patch-state', method: 'conversation.request.get', params: { requestId: configPatchId }
    })
    assert.equal(configPatchState.result.result.config.reasoningEffort, 'high')
    assert.equal(configPatchState.result.result.config.systemPrompt, 'session only')


    assert.ok(welcome.payload.capabilities.includes('conversation.message.edit'))
    assert.ok(welcome.payload.capabilities.includes('conversation.message.delete'))
    assert.ok(welcome.payload.capabilities.includes('conversation.message.reask'))
    const editRequestId = 'request-edit-gateway-fixture'
    const editResponse = await sendEncryptedRequest({
      ...reconnected, requestId: editRequestId, method: 'conversation.message.edit',
      params: { conversationId: sendInput.conversationId, uiMessageId: 'ui-message-gateway-0001', content: 'Edited over E2EE' }
    })
    assert.equal(editResponse.ok, true)
    assert.equal(writerCommands.at(-1).type, 'conversation.message.edit')
    assert.equal(writerCommands.at(-1).content, 'Edited over E2EE')
    const editState = await sendEncryptedRequest({
      ...reconnected, requestId: 'request-edit-state-fixture', method: 'conversation.request.get', params: { requestId: editRequestId }
    })
    assert.equal(editState.result.terminal, true)
    assert.equal(editState.result.result.operation, 'conversation.message.edit')


    assert.ok(welcome.payload.capabilities.includes('conversation.rename'))
    assert.ok(welcome.payload.capabilities.includes('conversation.delete'))
    const renameConversationId = 'request-rename-conversation-gateway'
    const renameConversationResponse = await sendEncryptedRequest({
      ...reconnected,
      requestId: renameConversationId,
      method: 'conversation.rename',
      params: { conversationId: sendInput.conversationId, title: 'Remote renamed conversation' }
    })
    assert.equal(renameConversationResponse.ok, true)
    assert.equal(writerCommands.at(-1).type, 'conversation.rename')
    assert.equal(writerCommands.at(-1).title, 'Remote renamed conversation')
    const renameConversationState = await sendEncryptedRequest({
      ...reconnected,
      requestId: 'request-rename-conversation-state',
      method: 'conversation.request.get',
      params: { requestId: renameConversationId }
    })
    assert.equal(renameConversationState.result.result.title, 'Remote renamed conversation')
    assert.equal(renameConversationState.result.result.revision, 8)

    const unconfirmedDelete = await sendEncryptedRequest({
      ...reconnected,
      requestId: 'request-delete-conversation-unconfirmed',
      method: 'conversation.delete',
      params: { conversationId: sendInput.conversationId, confirmed: false }
    })
    assert.equal(unconfirmedDelete.ok, false)
    assert.equal(unconfirmedDelete.error.code, 'remote_confirmation_required')
    const deleteConversationRequestId = 'request-delete-conversation-gateway'
    const deleteConversationResponse = await sendEncryptedRequest({
      ...reconnected,
      requestId: deleteConversationRequestId,
      method: 'conversation.delete',
      params: { conversationId: sendInput.conversationId, confirmed: true }
    })
    assert.equal(deleteConversationResponse.ok, true)
    assert.equal(writerCommands.at(-1).type, 'conversation.delete')
    const deleteConversationState = await sendEncryptedRequest({
      ...reconnected,
      requestId: 'request-delete-conversation-state',
      method: 'conversation.request.get',
      params: { requestId: deleteConversationRequestId }
    })
    assert.equal(deleteConversationState.result.result.deleted, true)
    const afterDelete = await sendEncryptedRequest({
      ...reconnected,
      requestId: 'request-after-conversation-delete',
      method: 'conversation.send',
      params: sendInput
    })
    assert.equal(afterDelete.ok, false)
    assert.equal(afterDelete.error.code, 'remote_conversation_not_found')


    const revokeConversationId = 'conversation-gateway-fixture-0002'
    const openedForRevoke = await sendEncryptedRequest({
      ...reconnected,
      requestId: 'request-open-revoke-fixture',
      method: 'conversation.open',
      params: { conversationId: revokeConversationId }
    })
    assert.equal(openedForRevoke.result.mobileControlled, false)
    const takenForRevoke = await sendEncryptedRequest({
      ...reconnected,
      requestId: 'request-takeover-revoke-fixture',
      method: 'conversation.takeover',
      params: { conversationId: revokeConversationId }
    })
    assert.equal(takenForRevoke.result.mobileControlled, true)
    await sendEncryptedRequest({
      ...reconnected,
      requestId: 'request-revoke-active',
      method: 'conversation.send',
      params: { conversationId: revokeConversationId, text: 'Revoke this active turn' }
    })

    const pendingRevokePayload = Buffer.from('pending revoke')
    const pendingRevokeUpload = await sendEncryptedRequest({
      ...reconnected,
      requestId: 'request-attachment-pending-revoke',
      method: 'attachment.begin',
      params: {
        name: 'pending.txt', type: 'text/plain', size: pendingRevokePayload.length,
        sha256: crypto.createHash('sha256').update(pendingRevokePayload).digest('base64url')
      }
    })
    const pendingRevokeUploadId = pendingRevokeUpload.result.upload.uploadId


    const revokedClose = once(reconnected.socket, 'close')
    const revoked = await gateway.revokeDevice(deviceId)
    assert.equal(revoked.removed, true)
    const [closeCode] = await revokedClose
    assert.equal(closeCode, 4001)
    reconnected.session.close()
    assert.equal(writerCommands.at(-1).type, 'conversation.cancel')

    assert.equal(uploadManager.getUpload(pendingRevokeUploadId), null, 'device revocation must delete pending uploads')

    const audit = await gateway.getAuditLog()
    assert.ok(audit.entries.some((entry) => entry.action === '新手机已配对'))

    const pairedAudit = audit.entries.find((entry) => entry.action === '新手机已配对')
    assert.equal(pairedAudit.deviceModel, 'Fixture Phone Model')
    assert.equal(pairedAudit.appVersion, 'test.1')
    assert.ok(audit.entries.every((entry) => !Object.hasOwn(entry, 'deviceId')))
    assert.ok(audit.entries.every((entry) => !JSON.stringify(entry).includes(mobilePairing2.rootSecret)))

    const stopped = await gateway.configure({ remote: { enabled: false, host: '127.0.0.1', port, publicEndpoint: 'https://tunnel.example.test' } })
    assert.equal(stopped.running, false)
    assert.equal(stopped.enabled, false)
    assert.equal(stopped.port, port)
    assert.equal(stopped.publicEndpoint, 'https://tunnel.example.test')

    console.log(JSON.stringify({ ok: true, suite: 'frozen-legacy-v2-consumer', protocolVersion: 2 }))
  } finally {
    await gateway.stop().catch(() => {})
    await uploadManager.stop().catch(() => {})
    await fs.rm(sandbox, { recursive: true, force: true })
  }
}

main().catch((error) => {
  console.error(error?.stack || error)
  process.exitCode = 1
})
