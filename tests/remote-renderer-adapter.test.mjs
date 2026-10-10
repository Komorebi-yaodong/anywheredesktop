import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import vm from 'node:vm'
import { shallowRef, ref, computed } from 'vue'

const source = await fs.readFile(new URL('../render/window/App.vue', import.meta.url), 'utf8')
const block = source.slice(source.indexOf('const activeRemoteCommand ='), source.indexOf('const stopConversationLeaseHeartbeat ='))
assert.ok(block.includes('persistRemoteTranscript'))
const events = [], actions = []
const context = {
  shallowRef, ref, computed, console, setTimeout, clearTimeout,
  window: { api: { emitRemoteRendererEvent: async (event) => { events.push(structuredClone(event)); actions.push(event.event) } } },
  currentConversationStorage: ref({ conversationId: 'conversation-renderer-fixture', revision: 0 }),
  isWindowBootstrapped: ref(true), isClosingWindow: ref(false), loading: ref(false), compacting: ref(false),
  isPreparingSend: ref(false), isMcpLoading: ref(false), chat_show: ref([]),
  sessionMutationVersion: 0, lastPersistedSessionVersion: 0,
  ensureConversationWriteAccess: () => true,
  clearScheduledAutoSave: () => {},
  appendFullHistory: (message) => actions.push(`user:${message.content}`),
  flushAppendBuffer: async () => actions.push('buffer-flush'),
  syncAutoCloseOnBlurListener: () => {},
  closePage: async () => actions.push('window-close'),
  model: ref('provider|model-a'), modelMap: ref({ 'provider|model-a': {}, 'provider|model-b': {} }),
  modelList: ref([{ value: 'provider|model-a', label: 'Model A' }, { value: 'provider|model-b', label: 'Model B' }]),
  tempReasoningEffort: ref('default'), selectedVoice: ref(''),
  sessionMcpServerIds: ref(['mcp-a']), tempSessionMcpServerIds: ref(['mcp-a']),
  sessionSkillIds: ref(['Skill A']), tempSessionSkillIds: ref(['Skill A']),
  currentSystemPrompt: ref('Old system'), sourcePromptConfig: ref({ prompt: 'Old system' }),
  compactConfig: ref({ autoCompactEnabled: true, triggerRatio: 0.9, contextLength: 262144, keepRecentRounds: 3, hideCompactedMessages: true, compactPrompt: '' }),
  currentConfig: ref({ voiceList: ['Voice A'], mcpServers: { 'mcp-a': { isActive: true, name: 'MCP A' }, 'mcp-b': { isActive: true, name: 'MCP B' } } }),
  availableMcpServers: computed(() => [{ id: 'mcp-a', name: 'MCP A' }, { id: 'mcp-b', name: 'MCP B' }]),
  allSkillsList: ref([{ id: 'skill-a', name: 'Skill A' }, { id: 'skill-b', name: 'Skill B' }]),
  fullHistory: ref([{ role: 'system', content: 'Old system' }]),
  messageIdCounter: ref(20),
  syncHistoryFromFullHistory: () => {},
  handleChangeModel: (value) => { context.model.value = value },
  applyNormalizedSkillSelection: (values) => { context.sessionSkillIds.value = values.map((item) => item === 'skill-b' ? 'Skill B' : item); context.tempSessionSkillIds.value = [...context.sessionSkillIds.value]; return context.sessionSkillIds.value },
  requestApplyMcpTools: async () => {},
  normalizeCompactConfigState: (value) => ({ ...value }),

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
context.executeAutoSaveRequest = async (request) => {
  actions.push(request.reason)
  context.lastPersistedSessionVersion = request.version
  context.currentConversationStorage.value.revision += 1
  return true
}

context.chat_show.value = [
  { id: 10, uiStorageId: 'ui-user-00000001', role: 'user', content: 'before' },
  { id: 11, uiStorageId: 'ui-assistant-old-01', role: 'assistant', content: 'old' },
  { id: 12, uiStorageId: 'ui-user-00000002', role: 'user', content: 'latest user' },
  { id: 13, uiStorageId: 'ui-assistant-last01', role: 'assistant', content: 'latest assistant' }
]
context.handleEditMessage = (index, content) => { context.chat_show.value[index].content = content; actions.push(`edit:${index}`); return true }
context.deleteMessage = (index) => { context.chat_show.value.splice(index, 1); actions.push(`delete:${index}`); return true }
context.reaskAI = async (_id, remoteCommand) => {
  remoteCommand.__remoteStarted = true
  remoteCommand.__remoteTerminalEvent = 'assistant.completed'
  adapter.emitRemoteAssistantDelta(remoteCommand, 'reasked', '', 'end', 'reask-bubble')
}
await adapter.runRemoteConversationCommand({
  type: 'conversation.message.edit', conversationId: command.conversationId, requestId: 'renderer-edit-1',
  uiMessageId: 'ui-user-00000001', content: 'after'
})
assert.equal(context.chat_show.value[0].content, 'after')
assert.equal(events.at(-1).event, 'conversation.operation.completed')
assert.ok(actions.indexOf('edit:0') < actions.lastIndexOf('remote-message-operation'))
await adapter.runRemoteConversationCommand({
  type: 'conversation.message.delete', conversationId: command.conversationId, requestId: 'renderer-delete-1',
  uiMessageId: 'ui-user-00000002'
})
assert.equal(context.chat_show.value.some((item) => item.uiStorageId === 'ui-user-00000002'), false)
assert.equal(events.at(-1).event, 'conversation.operation.completed')
await adapter.runRemoteConversationCommand({
  type: 'conversation.message.edit', conversationId: command.conversationId, requestId: 'renderer-missing-1',
  uiMessageId: 'ui-missing-0000001', content: 'no'
})
assert.equal(events.at(-1).event, 'conversation.operation.failed')
assert.equal(events.at(-1).payload.code, 'remote_message_not_found')
await adapter.runRemoteConversationCommand({
  type: 'conversation.message.reask', conversationId: command.conversationId, requestId: 'renderer-reask-old',
  uiMessageId: 'ui-assistant-old-01'
})
assert.equal(events.at(-1).payload.code, 'remote_reask_latest_assistant_required')
await adapter.runRemoteConversationCommand({
  type: 'conversation.message.reask', conversationId: command.conversationId, requestId: 'renderer-reask-last',
  uiMessageId: 'ui-assistant-last01'
})
assert.equal(events.at(-1).event, 'assistant.completed')
assert.ok(events.some((item) => item.requestId === 'renderer-reask-last' && item.event === 'assistant.delta' && item.payload.textDelta === 'reasked'))


const saveCountBeforeConfigGet = actions.filter((item) => item === 'remote-turn-finalized' || item === 'remote-config-patch').length
await adapter.runRemoteConversationCommand({ type: 'conversation.config.get', conversationId: command.conversationId, requestId: 'renderer-config-get' })
assert.equal(events.at(-1).event, 'conversation.config.result')
assert.equal(events.at(-1).payload.config.model, 'provider|model-a')
assert.equal(actions.filter((item) => item === 'remote-turn-finalized' || item === 'remote-config-patch').length, saveCountBeforeConfigGet)
await adapter.runRemoteConversationCommand({
  type: 'conversation.config.patch', conversationId: command.conversationId, requestId: 'renderer-config-patch',
  patch: { model: 'provider|model-b', reasoningEffort: 'high', voice: 'Voice A', mcpServerIds: ['mcp-b'], skillIds: ['skill-b'], systemPrompt: 'Session prompt only', compact: { triggerRatio: 0.8, keepRecentRounds: 4 } }
})
assert.equal(events.at(-1).event, 'conversation.config.result')
assert.equal(context.model.value, 'provider|model-b')
assert.equal(context.currentSystemPrompt.value, 'Session prompt only')
assert.equal(context.fullHistory.value[0].content, 'Session prompt only')
assert.deepEqual(Array.from(context.sessionMcpServerIds.value), ['mcp-b'])
assert.deepEqual(Array.from(context.sessionSkillIds.value), ['Skill B'])
assert.equal(context.compactConfig.value.triggerRatio, 0.8)
assert.equal(events.at(-1).payload.config.systemPrompt, 'Session prompt only')
assert.equal(JSON.stringify(events.at(-1).payload).includes('api_key'), false)
await adapter.runRemoteConversationCommand({
  type: 'conversation.config.patch', conversationId: command.conversationId, requestId: 'renderer-config-invalid',
  patch: { model: 'provider|missing' }
})
assert.equal(events.at(-1).event, 'conversation.operation.failed')
assert.equal(events.at(-1).payload.code, 'remote_model_unavailable')
assert.equal(context.model.value, 'provider|model-b', 'invalid patch rolls back')


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
