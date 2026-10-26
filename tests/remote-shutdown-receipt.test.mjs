import assert from 'node:assert/strict'
import { createRemoteSessionManager } from '../main/core/remote/sessionManager.js'

const conversationId = 'shutdown-conversation-fixture'
const deviceId = 'shutdown-device-fixture'
function fixture(hidden) {
  let mode = 'ok'
  const item = {id: 'shutdown-window-fixture', type: 'window', conversationId, rendererReady: true, remoteHidden: hidden}
  const windows = [item], commands = [], receipts = []
  const manager = createRemoteSessionManager({
    getConfig: async () => ({}), openConversation: async () => ({}), listWindows: () => windows,
    openWindow: async () => ({}), getWindowByRef: () => ({isDestroyed: () => false}),
    revealRemoteConversationWindow: () => ({}), broadcastToDevice: () => {},
    dispatchRemoteCommandToWindow: async (windowRef, command) => {
      commands.push(command)
      const emit = (requestId, ok, ref = windowRef) => manager.handleRendererEvent({windowRef: ref, payload: {conversationId, requestId, event: 'conversation.shutdown.result', payload: {ok}}})
      if (command.type === 'conversation.mobile.takeover') manager.handleRendererEvent({windowRef, payload: {conversationId, requestId: command.requestId, event: 'conversation.mobile.control.result', payload: {ok: true}}})
      if (command.type === 'remote.shutdown') {
        receipts.push(emit('stale-stop-attempt', false))
        receipts.push(emit(command.requestId, false, 'foreign-window'))
        if (mode === 'dispatch-failed') return {ok: false}
        receipts.push(emit(command.requestId, mode === 'ok'))
        if (mode === 'ok' && hidden) windows.splice(0)
      }
      return {ok: true}
    }
  })
  return {manager, item, windows, commands, receipts, mode: value => {mode = value}}
}
for (const hidden of [true, false]) {
  const f = fixture(hidden)
  await f.manager.openForMobile({deviceId, params: {conversationId}})
  if (!hidden) await f.manager.takeover({deviceId, params: {conversationId}})
  f.mode('save-failed')
  await assert.rejects(f.manager.closeAll(), {code: 'remote_conversation_save_failed'})
  assert.equal(f.windows.length, 1, 'failed save cannot destroy writer')
  assert.equal(f.manager.getSession(conversationId).mobileControlled, true)
  assert.equal(f.manager.getSession(conversationId).shutdownReceipt, null)
  f.manager.resume()
  f.mode('dispatch-failed')
  await assert.rejects(f.manager.closeAll(), {code: 'remote_renderer_dispatch_failed'})
  assert.equal(f.windows.length, 1)
  f.manager.resume()
  f.mode('ok')
  await f.manager.closeAll()
  assert.equal(f.windows.length, hidden ? 0 : 1)
  assert.equal(f.commands.at(-1).closeHidden, hidden)
  assert.equal(f.receipts.filter(result => result.ok === false).length, 6, 'all stale/foreign receipts rejected')
  if (!hidden) assert.equal(f.manager.getSession(conversationId).mobileControlled, false)
}
console.log('PASS remote shutdown hidden/visible save receipt, safe failure, dispatch error, retry, stale/foreign rejection')
