import assert from 'node:assert/strict'
import { createRemoteSessionManager } from '../main/core/remote/sessionManager.js'

const CID = 'conversation-session-fixture-0001'
const DEVICE = 'device-session-fixture-0001'
function fixture({ existing = false, dispatchFailure = false, stalled = false, uploadManager = null } = {}) {
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
    uploadManager,
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

  const mutations = fixture({ existing: true })
  const edited = await mutations.manager.editMessage({ deviceId: DEVICE, requestId: 'request-edit-fixture', params: {
    conversationId: CID, uiMessageId: 'ui-message-fixture-0001', content: 'Edited text'
  } })
  assert.equal(edited.operation, 'conversation.message.edit')
  assert.equal(mutations.commands.at(-1).content, 'Edited text')
  mutations.manager.handleRendererEvent({ windowRef: 'window-existing', payload: {
    conversationId: CID, requestId: 'request-edit-fixture', event: 'conversation.operation.completed',
    payload: { operation: 'conversation.message.edit', uiMessageId: 'ui-message-fixture-0001', revision: 8 }
  } })
  assert.equal(mutations.manager.getRequest({ deviceId: DEVICE, params: { requestId: 'request-edit-fixture' } }).terminal, true)
  assert.equal((await mutations.manager.editMessage({ deviceId: DEVICE, requestId: 'request-edit-fixture', params: {
    conversationId: CID, uiMessageId: 'ui-message-fixture-0001', content: 'Edited text'
  } })).duplicate, true)
  await assert.rejects(mutations.manager.editMessage({ deviceId: DEVICE, requestId: 'request-edit-fixture', params: {
    conversationId: CID, uiMessageId: 'ui-message-fixture-0001', content: 'Conflict'
  } }), { code: 'remote_request_id_conflict' })
  await mutations.manager.deleteMessage({ deviceId: DEVICE, requestId: 'request-delete-fixture', params: {
    conversationId: CID, uiMessageId: 'ui-message-fixture-0002'
  } })
  assert.equal(mutations.commands.at(-1).type, 'conversation.message.delete')
  mutations.manager.handleRendererEvent({ windowRef: 'window-existing', payload: {
    conversationId: CID, requestId: 'request-delete-fixture', event: 'conversation.operation.completed', payload: { revision: 9 }
  } })
  await mutations.manager.reaskMessage({ deviceId: DEVICE, requestId: 'request-reask-fixture', params: {
    conversationId: CID, uiMessageId: 'ui-message-fixture-0003'
  } })
  assert.equal(mutations.commands.at(-1).type, 'conversation.message.reask')
  await assert.rejects(mutations.manager.deleteMessage({ deviceId: DEVICE, requestId: 'request-index-forbidden', params: {
    conversationId: CID, uiMessageId: 'ui-message-fixture-0003', index: 2
  } }), { code: 'remote_parameter_unknown' })
  mutations.manager.handleRendererEvent({ windowRef: 'window-existing', payload: {
    conversationId: CID, requestId: 'request-reask-fixture', event: 'assistant.failed', payload: { code: 'remote_test_failure' }
  } })


  const configFixture = fixture({ existing: true })
  await assert.rejects(configFixture.manager.patchConfig({ deviceId: DEVICE, requestId: 'request-config-bad-1', params: {
    conversationId: CID, patch: { compact: { unknown: true } }
  } }), { code: 'remote_parameter_unknown' })
  await assert.rejects(configFixture.manager.patchConfig({ deviceId: DEVICE, requestId: 'request-config-bad-2', params: {
    conversationId: CID, patch: { compact: { triggerRatio: 2 } }
  } }), { code: 'remote_session_config_invalid' })
  const configAccepted = await configFixture.manager.patchConfig({ deviceId: DEVICE, requestId: 'request-config-patch', params: {
    conversationId: CID,
    patch: { model: 'provider|model', reasoningEffort: 'high', voice: '', mcpServerIds: ['mcp-1'], skillIds: ['Skill One'], systemPrompt: 'Session only', compact: { triggerRatio: 0.8, keepRecentRounds: 4 } }
  } })
  assert.equal(configAccepted.operation, 'conversation.config.patch')
  assert.equal(configFixture.commands.at(-1).patch.systemPrompt, 'Session only')
  configFixture.manager.handleRendererEvent({ windowRef: 'window-existing', payload: {
    conversationId: CID, requestId: 'request-config-patch', event: 'conversation.config.result', payload: {
      revision: 10, patched: ['model', 'systemPrompt'],
      config: { model: 'provider|model', reasoningEffort: 'high', voice: '', mcpServerIds: ['mcp-1'], skillIds: ['Skill One'], systemPrompt: 'Session only', compact: { triggerRatio: 0.8, keepRecentRounds: 4, secret: 'NO' } },
      options: { models: [{ value: 'provider|model', label: 'Model', api_key: 'NO' }], reasoningEfforts: ['default', 'high'], voices: [], mcpServers: [{ id: 'mcp-1', name: 'MCP', env: { SECRET: 'NO' } }], skills: [{ id: 'skill-1', name: 'Skill One', path: 'NO' }] }
    }
  } })
  const configState = configFixture.manager.getRequest({ deviceId: DEVICE, params: { requestId: 'request-config-patch' } })
  assert.equal(configState.result.config.systemPrompt, 'Session only')
  assert.equal(JSON.stringify(configState).includes('NO'), false)
  await configFixture.manager.getConfig({ deviceId: DEVICE, requestId: 'request-config-get', params: { conversationId: CID } })
  assert.equal(configFixture.commands.at(-1).type, 'conversation.config.get')
  configFixture.manager.handleRendererEvent({ windowRef: 'window-existing', payload: {
    conversationId: CID, requestId: 'request-config-get', event: 'conversation.config.result',
    payload: { revision: 10, config: {}, options: {} }
  } })


  const compactFixture = fixture({ existing: true })
  await compactFixture.manager.compact({ deviceId: DEVICE, requestId: 'request-compact-fixture', params: { conversationId: CID } })
  assert.equal(compactFixture.commands.at(-1).type, 'conversation.compact')
  compactFixture.manager.handleRendererEvent({ windowRef: 'window-existing', payload: {
    conversationId: CID, requestId: 'request-compact-fixture', event: 'conversation.compact.progress',
    payload: { percent: 44, stage: 'cascade', message: 'fixture', secret: 'NO' }
  } })
  const compactState = compactFixture.manager.getRequest({ deviceId: DEVICE, params: { requestId: 'request-compact-fixture' } })
  assert.equal(compactState.event, 'conversation.compact.progress')
  assert.equal(compactFixture.events.at(-1).payload.percent, 44)
  assert.equal(JSON.stringify(compactFixture.events.at(-1)).includes('NO'), false)
  await assert.rejects(compactFixture.manager.cancelCompact({ deviceId: 'device-other-fixture', requestId: 'cancel-compact-other', params: { conversationId: CID } }), { code: 'remote_request_owner_mismatch' })
  await compactFixture.manager.cancelCompact({ deviceId: DEVICE, requestId: 'cancel-compact-fixture', params: { conversationId: CID } })
  assert.equal(compactFixture.commands.at(-1).type, 'conversation.compact.cancel')
  compactFixture.manager.handleRendererEvent({ windowRef: 'window-existing', payload: {
    conversationId: CID, requestId: 'request-compact-fixture', event: 'conversation.compact.cancelled', payload: { revision: 11 }
  } })
  assert.equal(compactFixture.manager.getRequest({ deviceId: DEVICE, params: { requestId: 'request-compact-fixture' } }).terminal, true)


  const compactRevoked = fixture({ existing: true })
  await compactRevoked.manager.compact({ deviceId: DEVICE, requestId: 'request-compact-revoke', params: { conversationId: CID } })
  await compactRevoked.manager.revokeDevice(DEVICE)
  assert.equal(compactRevoked.commands.at(-1).type, 'conversation.compact.cancel')

  const compactShutdown = fixture({ existing: true })
  await compactShutdown.manager.compact({ deviceId: DEVICE, requestId: 'request-compact-shutdown', params: { conversationId: CID } })
  const compactClosing = compactShutdown.manager.closeAll()
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(compactShutdown.commands.at(-1).type, 'conversation.compact.cancel')
  compactShutdown.manager.handleRendererEvent({ windowRef: 'window-existing', payload: {
    conversationId: CID, requestId: 'request-compact-shutdown', event: 'conversation.compact.cancelled', payload: { revision: 12 }
  } })
  await compactClosing


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


  const uploadCalls = []
  const uploadManager = {
    async authorizeForRequest(input) { uploadCalls.push({ method: 'authorize', ...structuredClone(input) }); return [] },
    async releaseRequest(input) { uploadCalls.push({ method: 'release', ...structuredClone(input) }); return { ok: true } },
    async cleanupRequest(input) { uploadCalls.push({ method: 'cleanupRequest', ...structuredClone(input) }); return { ok: true } },
    async cleanupDevice(deviceId) { uploadCalls.push({ method: 'cleanupDevice', deviceId }); return { ok: true } },
    async cleanupWindow(windowRef) { uploadCalls.push({ method: 'cleanupWindow', windowRef }); return { ok: true } }
  }
  const withUploads = fixture({ existing: true, uploadManager })
  const uploadIds = ['upload-session-fixture-0001', 'upload-session-fixture-0002']
  await withUploads.manager.send({
    deviceId: DEVICE, requestId: 'request-upload-session-1',
    params: { conversationId: CID, text: '', uploadIds }
  })
  assert.deepEqual(uploadCalls[0], {
    method: 'authorize', deviceId: DEVICE, requestId: 'request-upload-session-1',
    windowRef: 'window-existing', uploadIds
  })
  assert.deepEqual(withUploads.commands.at(-1).uploadIds, uploadIds)
  assert.equal(withUploads.commands.at(-1).text, '')
  assert.equal((await withUploads.manager.send({
    deviceId: DEVICE, requestId: 'request-upload-session-1', params: { conversationId: CID, text: '', uploadIds }
  })).duplicate, true)
  await assert.rejects(withUploads.manager.send({
    deviceId: DEVICE, requestId: 'request-upload-session-1', params: { conversationId: CID, text: '', uploadIds: [uploadIds[0]] }
  }), { code: 'remote_request_id_conflict' })
  withUploads.manager.handleRendererEvent({ windowRef: 'window-existing', payload: {
    conversationId: CID, requestId: 'request-upload-session-1', event: 'assistant.completed', payload: { revision: 12 }
  } })
  await new Promise((resolve) => setImmediate(resolve))
  assert.ok(uploadCalls.some((item) => item.method === 'cleanupRequest' && item.requestId === 'request-upload-session-1'))
  await assert.rejects(withUploads.manager.send({
    deviceId: DEVICE, requestId: 'request-upload-duplicate',
    params: { conversationId: CID, text: 'duplicate', uploadIds: [uploadIds[0], uploadIds[0]] }
  }), { code: 'remote_upload_ids_invalid' })

  const uploadFailureCalls = []
  const uploadFailureManager = {
    ...uploadManager,
    async authorizeForRequest(input) { uploadFailureCalls.push({ method: 'authorize', ...structuredClone(input) }); return [] },
    async releaseRequest(input) { uploadFailureCalls.push({ method: 'release', ...structuredClone(input) }); return { ok: true } }
  }
  const uploadDispatchFailed = fixture({ existing: true, dispatchFailure: true, uploadManager: uploadFailureManager })
  await assert.rejects(uploadDispatchFailed.manager.send({
    deviceId: DEVICE, requestId: 'request-upload-dispatch-fail',
    params: { conversationId: CID, text: 'retryable', uploadIds: [uploadIds[0]] }
  }), { code: 'remote_renderer_dispatch_failed' })
  assert.equal(uploadFailureCalls[0].method, 'authorize')
  assert.equal(uploadFailureCalls[1].method, 'release')

  const failed = fixture({ dispatchFailure: true })
  await assert.rejects(send(failed.manager), { code: 'remote_renderer_dispatch_failed' })
  assert.equal(failed.manager.getSession(CID).activeRequestId, '')
  const readonly = fixture({ existing: true })
  readonly.items[0].readOnly = true
  await assert.rejects(send(readonly.manager), { code: 'remote_conversation_read_only' })
  console.log(JSON.stringify({ ok: true, suite: 'remote-session-manager' }))
}
await run()
