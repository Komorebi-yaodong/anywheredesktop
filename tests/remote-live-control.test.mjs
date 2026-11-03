import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import { createRemoteSessionManager } from '../main/core/remote/sessionManager.js'
const cid = 'conversation-live-control-fixture',
  device = 'device-live-control-fixture',
  other = 'device-other-live-fixture'
const item = {
  id: 'writer-live-control',
  type: 'window',
  conversationId: cid,
  rendererReady: true,
  busy: true,
  generating: true
}
const commands = [],
  events = []
let mode = 'ok'
const manager = createRemoteSessionManager({
  getConfig: async () => ({}),
  openConversation: async () => {
    throw new Error('must reuse writer')
  },
  listWindows: () => [item],
  getWindowByRef: () => ({ isDestroyed: () => false }),
  openWindow: async () => {
    throw new Error('must not replace writer')
  },
  readinessTimeoutMs: 100,
  revealRemoteConversationWindow: () => ({ ok: true }),
  broadcastToDevice: (deviceId, event, payload) => events.push({ deviceId, event, payload }),
  dispatchRemoteCommandToWindow: async (windowRef, command) => {
    commands.push(command)
    if (
      [
        'conversation.mobile.takeover',
        'conversation.mobile.handoff',
        'conversation.desktop.takeover'
      ].includes(command.type)
    ) {
      const event =
        command.type === 'conversation.mobile.takeover'
          ? 'conversation.mobile.control.result'
          : command.type === 'conversation.mobile.handoff'
            ? 'conversation.handoff.control.result'
            : 'conversation.desktop.control.result'
      const emit = (payload, ref = windowRef) =>
        manager.handleRendererEvent({
          windowRef: ref,
          payload: { conversationId: cid, requestId: command.requestId, event, payload }
        })
      assert.equal(emit({ ok: true, controlEpoch: 'spoof' }).ok, false)
      assert.equal(
        emit({ ok: true, controlEpoch: command.controlEpoch }, 'foreign-window').ok,
        false
      )
      if (mode !== 'timeout')
        emit({
          ok: mode === 'ok',
          controlEpoch: command.controlEpoch,
          code: 'remote_conversation_save_failed'
        })
    }
    return { ok: true }
  }
})
const render = (event, requestId, payload = {}) =>
  manager.handleRendererEvent({
    windowRef: item.id,
    payload: { conversationId: cid, requestId, event, payload }
  })
const runtime = (who) => manager.runtimeSnapshot({ deviceId: who, params: { conversationId: cid } })
const localId = `desktop-turn-${crypto.randomUUID()}`
assert.equal(render('conversation.execution.started', localId).ok, true)
assert.equal(
  render('assistant.delta', localId, { textDelta: 'before transfer', segmentId: 'local-segment' })
    .ok,
  true
)
assert.equal(
  render('conversation.choice.required', localId, {
    toolCallId: 'tool-choice-live',
    questions: [{ question: 'Continue?', options: [{ label: 'yes' }] }]
  }).ok,
  true
)
await manager.takeover({ deviceId: device, params: { conversationId: cid } })
assert.equal(runtime(device).execution.operationId, localId)
assert.equal(runtime(device).pendingChoices.length, 1)
assert.equal(runtime(device).control.canWrite, true)
assert.equal(
  manager.getRequest({ deviceId: device, params: { requestId: localId } }).text,
  'before transfer'
)
assert.throws(() => manager.getRequest({ deviceId: other, params: { requestId: localId } }), {
  code: 'remote_request_not_found'
})
const epoch = runtime(device).control.epoch
await manager.send({
  deviceId: device,
  requestId: 'queued-live-control-input',
  params: { conversationId: cid, text: 'accepted follow-up' }
})
await manager.handoff({ deviceId: device, params: { conversationId: cid } })
assert.equal(manager.getSession(cid).activeRequestId, localId)
assert.equal(runtime(device).control.owner, 'desktop')
assert.notEqual(runtime(device).control.epoch, epoch)
await assert.rejects(
  manager.cancel({
    deviceId: device,
    requestId: 'cancel-old-owner',
    params: { conversationId: cid }
  }),
  { code: 'remote_conversation_takeover_required' }
)
await assert.rejects(
  manager.submitChoice({
    deviceId: device,
    params: {
      conversationId: cid,
      toolCallId: 'tool-choice-live',
      responses: [{ questionIndex: 0, type: 'options', selected: ['yes'] }]
    }
  }),
  { code: 'remote_conversation_takeover_required' }
)
const drain = await render('conversation.queue.drain', localId)
assert.equal(drain.ok, true)
assert.equal(drain.items.length, 1)
assert.equal((await render('conversation.queue.drain', localId)).items.length, 0)
assert.equal(
  render('conversation.queue.appended', 'queued-live-control-input', { revision: 2 }).ok,
  true
)
await manager.takeover({ deviceId: device, params: { conversationId: cid } })
await manager.submitChoice({
  deviceId: device,
  params: {
    conversationId: cid,
    toolCallId: 'tool-choice-live',
    responses: [{ questionIndex: 0, type: 'options', selected: ['yes'] }]
  }
})
assert.equal(commands.at(-1).type, 'conversation.choice.submit')
mode = 'failed'
await assert.rejects(manager.takeoverOnDesktop({ conversationId: cid, confirmed: true }), {
  code: 'remote_conversation_save_failed'
})
assert.equal(runtime(device).control.canWrite, true)
mode = 'timeout'
await assert.rejects(manager.handoff({ deviceId: device, params: { conversationId: cid } }), {
  code: 'remote_control_transfer_timeout'
})
const expired = commands.at(-1)
assert.equal(
  render('conversation.handoff.control.result', expired.requestId, {
    ok: true,
    controlEpoch: expired.controlEpoch
  }).ok,
  false
)
assert.equal(runtime(device).control.canWrite, true)
mode = 'ok'
await manager.takeoverOnDesktop({ conversationId: cid, confirmed: true })
assert.equal(manager.getSession(cid).activeRequestId, localId)
assert.equal(
  render('assistant.delta', localId, { textDelta: ' after transfer', segmentId: 'local-segment' })
    .ok,
  true
)
assert.equal(render('assistant.completed', localId, { revision: 3 }).ok, true)
assert.equal(render('assistant.completed', localId).ok, false)
assert.equal(
  events.filter((e) => e.payload.requestId === localId && e.event === 'assistant.completed').length,
  1
)
assert.equal(
  commands.some((c) =>
    ['conversation.cancel', 'conversation.compact.cancel', 'conversation.send'].includes(c.type)
  ),
  false
)
assert.equal(item.generating, true, 'control transfer never changes request execution flags')
const nextLocal = `desktop-turn-${crypto.randomUUID()}`
assert.equal(render('conversation.execution.started', nextLocal).ok, true)
const beforeStop = commands.length
await manager.closeAll()
assert.equal(
  commands.length,
  beforeStop,
  'Remote stop never cancels an unclaimed ordinary local run'
)
assert.equal(manager.getSession(cid).activeRequestId, nextLocal)
assert.deepEqual(await render('conversation.queue.drain', nextLocal), { ok: true, items: [] })
assert.equal(render('assistant.completed', nextLocal, { revision: 4 }).ok, true)
manager.handleWindowClosed(item.id)
console.log(
  JSON.stringify({
    ok: true,
    suite: 'remote-live-control',
    localRun: true,
    threeDirections: true,
    queueExactlyOnce: true,
    failureAndTimeout: true
  })
)
