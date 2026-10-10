import assert from 'node:assert/strict'
import { createRemoteSessionManager } from '../main/core/remote/sessionManager.js'

const CID = 'conversation-session-fixture-0001'
const DEVICE = 'device-session-fixture-0001'
function fixture({ existing = false, dispatchFailure = false, stalled = false } = {}) {
  const items = existing ? [{ id: 'window-existing', type: 'window', conversationId: CID, rendererReady: true, leasePending: false, remoteHidden: false }] : []
  const commands = [], events = [], opens = []
  let blocked = null
  const blocker = stalled ? new Promise((resolve) => { blocked = resolve }) : null
  const manager = createRemoteSessionManager({
    getConfig: async () => ({ config: { webdav: { localChatPath: 'fixture-only-path' } } }),
    openConversation: async (input) => {
      assert.equal(input.dirPath, 'fixture-only-path')
      if (blocker) await blocker
      return { descriptor: { conversationId: CID, title: 'Fixture' }, sessionData: { CODE: 'AI' } }
    },
    listWindows: () => items,
    getWindowByRef: (ref) => items.some((item) => item.id === ref) ? { isDestroyed: () => false } : null,
    openWindow: async (type, payload) => {
      opens.push(payload)
      const item = { id: `window-created-${opens.length}`, type, conversationId: CID, remoteHidden: true, rendererReady: true }
      items.push(item)
      return { ok: true, id: item.id }
    },
    dispatchRemoteCommandToWindow: async (windowRef, command) => {
      commands.push({ windowRef, ...command })
      if (command.type === 'remote.shutdown') items.splice(items.findIndex((item) => item.id === windowRef), 1)
      return { ok: !dispatchFailure }
    },
    revealRemoteConversationWindow: (ref) => { items.find((item) => item.id === ref).remoteHidden = false; return { ok: true } },
    broadcastToDevice: (deviceId, event, payload) => events.push({ deviceId, event, payload }),
    readinessTimeoutMs: 100
  })
  return { manager, items, commands, events, opens, unblock: () => blocked?.() }
}
const send = (manager, requestId = 'request-fixture-0001', deviceId = DEVICE, text = 'Hello') => manager.send({
  deviceId, requestId, params: { conversationId: CID, text }
})
function renderer(f, event, payload = {}, requestId = 'request-fixture-0001', windowRef = f.items[0].id) {
  return f.manager.handleRendererEvent({ windowRef, payload: { conversationId: CID, requestId, event, payload } })
}

async function run() {
  const f = fixture()
  const results = await Promise.allSettled([send(f.manager), send(f.manager, 'request-fixture-0002')])
  assert.equal(results[0].status, 'fulfilled')
  assert.equal(results[1].reason.code, 'remote_conversation_busy')
  assert.equal(f.opens.length, 1)
  assert.equal(f.commands.filter((item) => item.type === 'conversation.send').length, 1)
  assert.equal(f.opens[0].remoteHidden, true)
  assert.equal(f.commands[0].autoApproveTools, true)
  assert.equal((await send(f.manager)).duplicate, true)
  await assert.rejects(send(f.manager, 'request-fixture-0001', DEVICE, 'Changed'), { code: 'remote_request_id_conflict' })
  await assert.rejects(f.manager.send({ deviceId: DEVICE, requestId: 'request-forbidden', params: { conversationId: CID, text: 'hi', dirPath: 'C:/other' } }), { code: 'remote_path_parameter_forbidden' })
  assert.equal(renderer(f, 'assistant.delta', {}, 'request-fixture-0001', 'window-spoof').ok, false)
  assert.equal(renderer(f, 'assistant.delta', {}, 'request-spoof').ok, false)
  renderer(f, 'assistant.started', { startedAt: 'fixture' })
  renderer(f, 'assistant.delta', { textDelta: 'Hello', reasoningDelta: 'Thought', password: 'SECRET', segmentId: 'bubble-1' })
  renderer(f, 'assistant.delta', { textDelta: ' World', segmentId: 'bubble-2' })
  const state = f.manager.getRequest({ deviceId: DEVICE, params: { requestId: 'request-fixture-0001' } })
  assert.equal(state.text, 'Hello World')
  assert.equal(state.reasoning, 'Thought')
  assert.equal(state.terminal, false)
  assert.equal(JSON.stringify(f.events).includes('SECRET'), false)
  assert.throws(() => f.manager.getRequest({ deviceId: 'device-other-fixture', params: { requestId: 'request-fixture-0001' } }), { code: 'remote_request_not_found' })
  renderer(f, 'assistant.completed', { revision: 3, completedAt: 'fixture' })
  assert.equal(f.manager.getRequest({ deviceId: DEVICE, params: { requestId: 'request-fixture-0001' } }).result.revision, 3)
  assert.equal(renderer(f, 'assistant.delta', { textDelta: 'late' }).ok, false)
  await send(f.manager, 'request-fixture-0003')
  await assert.rejects(f.manager.cancel({ deviceId: 'device-other-fixture', requestId: 'cancel-fixture', params: { conversationId: CID } }), { code: 'remote_request_owner_mismatch' })
  await f.manager.cancel({ deviceId: DEVICE, requestId: 'cancel-fixture', params: { conversationId: CID } })
  assert.equal(f.commands.at(-1).targetRequestId, 'request-fixture-0003')
  renderer(f, 'assistant.cancelled', {}, 'request-fixture-0003')
  f.manager.showOnDesktop({ params: { conversationId: CID } })
  await f.manager.closeAll()
  assert.equal(f.commands.filter((command) => command.type === 'remote.shutdown').length, 0, 'revealed window belongs to Desktop')
  await assert.rejects(send(f.manager, 'request-stopped'), { code: 'remote_gateway_stopped' })

  const reused = fixture({ existing: true })
  await send(reused.manager)
  assert.equal(reused.opens.length, 0)
  await reused.manager.revokeDevice(DEVICE)
  assert.equal(reused.commands.at(-1).type, 'conversation.cancel')
  await assert.rejects(send(reused.manager, 'request-revoked'), { code: 'remote_device_revoked' })
  reused.manager.authorizeDevice(DEVICE)
  reused.manager.handleWindowClosed('window-existing')
  assert.equal(reused.events.at(-1).payload.code, 'remote_renderer_closed')

  const hidden = fixture()
  await send(hidden.manager)
  await hidden.manager.closeAll()
  assert.equal(hidden.commands.at(-1).type, 'remote.shutdown')
  assert.equal(hidden.items.length, 0)

  const racing = fixture({ stalled: true })
  const pending = send(racing.manager)
  await new Promise((resolve) => setTimeout(resolve, 5))
  const closing = racing.manager.closeAll()
  racing.unblock()
  await assert.rejects(pending, { code: 'remote_gateway_stopped' })
  await closing
  assert.equal(racing.commands.length, 0, 'stop invalidates a command waiting for repository')

  const failed = fixture({ dispatchFailure: true })
  await assert.rejects(send(failed.manager), { code: 'remote_renderer_dispatch_failed' })
  assert.equal(failed.manager.getSession(CID).activeRequestId, '')
  const readonly = fixture({ existing: true })
  readonly.items[0].readOnly = true
  await assert.rejects(send(readonly.manager), { code: 'remote_conversation_read_only' })
  console.log(JSON.stringify({ ok: true, suite: 'remote-session-manager' }))
}
await run()
