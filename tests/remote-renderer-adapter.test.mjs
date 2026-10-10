import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import vm from 'node:vm'
import { shallowRef, ref } from 'vue'

const source = await fs.readFile(new URL('../render/window/App.vue', import.meta.url), 'utf8')
const block = source.slice(source.indexOf('const activeRemoteCommand ='), source.indexOf('const stopConversationLeaseHeartbeat ='))
assert.ok(block.includes('persistRemoteTranscript'))
const events = [], actions = []
const context = {
  shallowRef, ref, console, setTimeout, clearTimeout,
  window: { api: { emitRemoteRendererEvent: async (event) => { events.push(structuredClone(event)); actions.push(event.event) } } },
  currentConversationStorage: ref({ conversationId: 'conversation-renderer-fixture', revision: 0 }),
  isWindowBootstrapped: ref(true), isClosingWindow: ref(false), loading: ref(false), compacting: ref(false),
  isPreparingSend: ref(false), isMcpLoading: ref(false), chat_show: ref([]), messageIdCounter: ref(1),
  sessionMutationVersion: 0, lastPersistedSessionVersion: 0,
  ensureConversationWriteAccess: () => true,
  clearScheduledAutoSave: () => {},
  appendFullHistory: (message) => actions.push(`user:${message.content}`),
  flushAppendBuffer: async () => actions.push('buffer-flush'),
  syncAutoCloseOnBlurListener: () => {},
  closePage: async () => actions.push('window-close'),
  cancelAskAI: () => { context.loading.value = false; actions.push('cancel') }
}
context.executeAutoSaveRequest = async (request) => {
  actions.push(request.reason)
  context.lastPersistedSessionVersion = request.version
  context.currentConversationStorage.value.revision += 1
  return true
}
const ctx = vm.createContext(context)
vm.runInContext(block + '\n globalThis.adapter = { runRemoteConversationCommand, emitRemoteAssistantDelta, activeRemoteCommand, remoteHiddenWriter };', ctx)
const adapter = context.adapter
context.askAI = async () => {
  adapter.activeRemoteCommand.value.__remoteStarted = true
  adapter.emitRemoteAssistantDelta(adapter.activeRemoteCommand.value, 'first', 'reason', 'end', 'bubble-1')
  adapter.emitRemoteAssistantDelta(adapter.activeRemoteCommand.value, 'first!', 'reason', 'end', 'bubble-1')
  adapter.emitRemoteAssistantDelta(adapter.activeRemoteCommand.value, 'second', '', 'end', 'bubble-2')
}
const command = { type: 'conversation.send', conversationId: 'conversation-renderer-fixture', requestId: 'renderer-request-1', text: 'Hello', autoApproveTools: true }
await adapter.runRemoteConversationCommand(command)
assert.equal(adapter.activeRemoteCommand.value, null, 'shallowRef preserves identity for finalization')
assert.equal(events.at(-1).event, 'assistant.completed')
assert.equal(events.filter((event) => event.event === 'assistant.delta').map((event) => event.payload.textDelta || '').join(''), 'first!second')
assert.ok(actions.indexOf('remote-turn-finalized') < actions.indexOf('assistant.completed'))
assert.equal(events.at(-1).payload.revision, 2)

context.executeAutoSaveRequest = async () => false
await adapter.runRemoteConversationCommand({ ...command, requestId: 'renderer-fail-save' })
assert.equal(events.at(-1).event, 'assistant.failed')
assert.equal(events.at(-1).payload.code, 'remote_conversation_save_failed')

context.executeAutoSaveRequest = async (request) => { context.lastPersistedSessionVersion = request.version; return true }
let release, entered
const enter = new Promise((resolve) => { entered = resolve })
context.askAI = async () => {
  context.loading.value = true
  entered()
  await new Promise((resolve) => { release = resolve })
  context.loading.value = false
}
const pending = adapter.runRemoteConversationCommand({ ...command, requestId: 'renderer-cancel' })
await enter
await adapter.runRemoteConversationCommand({ type: 'conversation.cancel', conversationId: command.conversationId, requestId: 'cancel-1', targetRequestId: 'renderer-cancel' })
assert.equal(adapter.activeRemoteCommand.value.requestId, 'renderer-cancel', 'keep ownership until save completes')
release()
await pending
assert.equal(events.at(-1).event, 'assistant.cancelled')
adapter.remoteHiddenWriter.value = true
await adapter.runRemoteConversationCommand({ type: 'remote.revealed', conversationId: command.conversationId })
assert.equal(adapter.remoteHiddenWriter.value, false)
await adapter.runRemoteConversationCommand({ type: 'remote.shutdown', conversationId: command.conversationId })
assert.equal(actions.includes('window-close'), false)
adapter.remoteHiddenWriter.value = true
await adapter.runRemoteConversationCommand({ type: 'remote.shutdown', conversationId: command.conversationId })
assert.equal(actions.at(-1), 'window-close')

assert.match(source, /if \(!turnRemoteCommand\) await flushAppendBuffer\(\)/)
assert.match(source, /approvalStatus: autoApproveThisTurn\(\)/)
assert.doesNotMatch(block, /isAutoApproveTools\.value = true/)
const windowSource = await fs.readFile(new URL('../main/windowManager.js', import.meta.url), 'utf8')
assert.match(windowSource, /setBackgroundThrottling\(false\)/)
assert.match(windowSource, /type: 'remote.revealed'/)
console.log(JSON.stringify({ ok: true, suite: 'remote-renderer-adapter' }))
