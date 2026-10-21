import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import vm from 'node:vm'
import { shallowRef, ref, computed, watch } from 'vue'

import {replaceConversationEditableText} from '../render/window/utils/conversationEditableText.js'

const source = await fs.readFile(new URL('../render/window/App.vue', import.meta.url), 'utf8')

const mobileControlDeclaration = source.indexOf('const mobileControlActive = ref(false);')
const mobileControlWatch = source.indexOf('  mobileControlActive,', source.indexOf('watch(['))
assert.ok(mobileControlDeclaration >= 0 && mobileControlWatch > mobileControlDeclaration, 'mobileControlActive must initialize before the status watch reads it')
const block = source.slice(source.indexOf('const activeRemoteCommand ='), source.indexOf('const stopConversationLeaseHeartbeat ='))
assert.ok(block.includes('persistRemoteTranscript'))

// Execute the actual response finalization path; adapter-only stubs miss TDZ bugs.
const finalizationStart = source.indexOf('      emitRemoteAssistantDelta(', source.indexOf('// Chat Completions'));
const bubbleStart = source.indexOf('      // --- 更新 UI 气泡 ---', source.indexOf('// Chat Completions'));
const finalizationEnd = source.indexOf('      if (responseMessage.tool_calls', bubbleStart);
assert.ok(finalizationStart > bubbleStart, 'terminal delta must follow currentBubble initialization');
for (const responseMessage of [
  { content: 'final plain reply', reasoning_content: '' },
  { content: [{ type: 'text', text: 'tool reply' }], reasoning_content: 'final reason', tool_calls: [{}] }
]) {
  const emitted = [];
  vm.runInNewContext(source.slice(bubbleStart, finalizationEnd), {
    chat_show: { value: [{ id: 'bubble-fixture', content: [], status: 'retrying' }] },
    currentAssistantChatShowIndex: 0, responseMessage, turnRemoteCommand: {},
    applyTokenUsageToAssistantMessage() {},
    extractRemoteText: (parts) => parts.map((part) => part.text || '').join(''),
    emitRemoteAssistantDelta: (...args) => emitted.push(args)
  });
  assert.equal(emitted.length, 1);
  assert.equal(emitted[0][1], typeof responseMessage.content === 'string' ? responseMessage.content : 'tool reply');
  assert.equal(emitted[0][4], 'bubble-fixture');

  const streamed = [];
  vm.runInNewContext(`
    const chat_show = { value: [{ id: 'stream-bubble', storageId: 'stream-storage', content: [], status: '' }] };
    let currentAssistantChatShowIndex = 0;
    let aggregatedContent = 'delta';
    let aggregatedReasoningContent = 'thinking';
    const aggregatedMedia = [];
    let lastUpdateTime = 0;
    const isTurnAborted = () => false;
    const turnRemoteCommand = {};
    const syncStickyScrollAfterRender = () => {};
    const scheduleLoadingAutoSave = () => {};
    const emitRemoteAssistantDelta = (...args) => streamed.push(args);
    ${source.slice(source.indexOf('        const flushStreamingDisplay ='), source.indexOf('        // Receive every chunk immediately', source.indexOf('        const flushStreamingDisplay =')))}
    flushStreamingDisplay();
  `, {streamed, Date});
  assert.equal(streamed.length, 1);
  assert.equal(streamed[0][4], 'stream-storage');
}

// Execute the real askAI finalizer, including exceptions before busy release.
const turnFinalizerStart = source.indexOf('    try {\n      cancelPendingStreamingDisplay?.();', source.indexOf('const askAI ='))
const turnFinalizerEnd = source.indexOf('\n  }\n};\n\nconst cancelAskAI', turnFinalizerStart)
assert.ok(turnFinalizerStart > 0 && turnFinalizerEnd > turnFinalizerStart)
for (const failure of ['focus', 'mcp', 'compact', 'none']) {
  const command = {}, meta = {resolveSettlement: () => { finalized.settled = true }}
  const finalized = {
    console: {error() {}}, activeAssistantTurnMeta: meta, turnMeta: meta, turnRemoteCommand: command,
    loading: {value: true}, signalController: {value: null}, requestAbortController: {},
    cancelPendingStreamingDisplay: () => {}, isModelIterationConfigLocked: {value: true},
    pendingApplyMcpRequest: {value: failure === 'mcp'}, isApplyMcpRunning: {value: false},
    requestApplyMcpTools: async () => {throw new Error('fixture-mcp-finalize')},
    currentAssistantChatShowIndex: -1, nextTick: async () => {},
    focusChatInputIfSafe: () => {if (failure === 'focus') throw new Error('fixture-focus-finalize')},
    currentTaskConfig: {value: null}, scheduleAutoSave: () => {},
    maybeAutoCompactAfterTurn: async () => {if (failure === 'compact') throw new Error('fixture-compact-finalize')},
    currentConversationStorage: {value: {revision: 7}}, syncAutoCloseOnBlurListener: () => {},
    flushAppendBuffer: async () => {}, settled: false
  }
  const run = vm.runInNewContext(`(async () => {${source.slice(turnFinalizerStart, turnFinalizerEnd)}})()`, finalized)
  await run
  if (failure !== 'none') assert.equal(command.__remoteTerminalPayload.code, 'remote_assistant_finalize_failed')
  assert.equal(finalized.loading.value, false, 'finalizer failure cannot strand writer busy')
  assert.equal(finalized.activeAssistantTurnMeta, null)
  assert.equal(finalized.settled, true)
}


const events = [], actions = [], consumedUploads = [], appendedMessages = []
const context = {
  shallowRef, ref, computed, watch, console, setTimeout, clearTimeout,
  window: { api: {
    emitRemoteRendererEvent: async (event) => { events.push(structuredClone(event)); actions.push(event.event); return {ok: true} },
    consumeRemoteUpload: async (input) => {
      consumedUploads.push(structuredClone(input))
      return { uploadId: input.uploadId, content: { type: 'image_url', image_url: { url: 'data:image/png;base64,UE5HREFUQQ==' } } }
    },
    renameConversation: async (input) => {
      actions.push(`rename-conversation:${input.title}`)
      return { ok: true, title: input.title, revision: Number(input.expectedRevision) + 1 }
    },
    deleteConversation: async (input) => {
      actions.push(`delete-conversation:${input.conversationId}`)
      return { ok: true, removed: true }
    }
  } },
  currentConversationStorage: ref({ conversationId: 'conversation-renderer-fixture', revision: 0, dirPath: 'fixture-dir' }),
  conversationLease: ref({ leaseEpoch: 4 }),
  conversationInstanceId: 'renderer-instance-fixture',
  isWindowBootstrapped: ref(true), isClosingWindow: ref(false), loading: ref(false), compacting: ref(false),
  isPreparingSend: ref(false), isMcpLoading: ref(false), chat_show: ref([]),
  desktopTakeoverPending: ref(false), mobileControlActive: ref(false),
  scheduleConversationWindowStatusSync() {}, buildConversationWindowStatus: () => ({}),
  showDismissibleMessage: {info() {}, success() {}, error() {}}, deepCloneSafe: value => structuredClone(value),
  sessionMutationVersion: 0, lastPersistedSessionVersion: 0,
  isAutoApproveTools: ref(false),
  ensureConversationWriteAccess: () => true,
  clearScheduledAutoSave: () => {},
  scheduledAutoSaveRequest: null,
  autoSaveExecutionPromise: null,
  conversationPersistenceTracker: {
    markRequired: () => {},
    markPersisted: () => {},
    getState: () => ({ persistedFullSnapshotVersion: context.lastPersistedSessionVersion })
  },
  autoSaveMutationQueue: { whenIdle: async () => {} },
  stopConversationLeaseHeartbeat: () => actions.push('lease-heartbeat-stop'),
  createLinkedUserMessagePair: ({ storageId, uiId, historyContent, uiContent, timestamp }) => ({
    historyMessage: { role: 'user', storageId, content: historyContent },
    uiMessage: { id: uiId, role: 'user', storageId, content: uiContent, timestamp }
  }),
  appendFullHistory: (message) => { appendedMessages.push(structuredClone(message)); actions.push(`user:${message.content}`) },
  flushAppendBuffer: async () => actions.push('buffer-flush'),
  syncAutoCloseOnBlurListener: () => {},
  closePage: async () => actions.push('window-close'),
  model: ref('provider|model-a'), modelMap: ref({ 'provider|model-a': {}, 'provider|model-b': {} }),
  modelList: ref([{ value: 'provider|model-a', label: 'Model A' }, { value: 'provider|model-b', label: 'Model B' }]),
  tempReasoningEffort: ref('default'), selectedVoice: ref(''),
  sessionMcpServerIds: ref(['mcp-a']), tempSessionMcpServerIds: ref(['mcp-a']),
  sessionSkillIds: ref(['Skill A']), tempSessionSkillIds: ref(['Skill A']),
  currentSystemPrompt: ref('Old system'), sourcePromptConfig: ref({ prompt: 'Old system' }),
  defaultConversationName: ref('Fixture conversation'),
  compactConfig: ref({ autoCompactEnabled: true, triggerRatio: 0.9, contextLength: 262144, keepRecentRounds: 3, hideCompactedMessages: true, compactPrompt: '' }),
  CODE: ref('FixtureAgent'),
  currentConfig: ref({
    voiceList: ['Voice A'],
    prompts: { FixtureAgent: { defaultMcpServers: ['mcp-a'] } },
    mcpServers: {
      'mcp-a': { isActive: true, name: 'MCP A', tags: ['Research'], env: { SECRET: 'MUST_NOT_LEAK' } },
      'mcp-b': { isActive: true, name: 'MCP B', labels: ['文件'] }
    }
  }),
  availableMcpServers: computed(() => [
    { id: 'mcp-a', name: 'MCP A', tags: ['Research'], env: { SECRET: 'MUST_NOT_LEAK' } },
    { id: 'mcp-b', name: 'MCP B', labels: ['文件'] }
  ]),
  allSkillsList: ref([{ id: 'skill-a', name: 'Skill A' }, { id: 'skill-b', name: 'Skill B' }]),
  fullHistory: ref([{ role: 'system', content: 'Old system' }]),
  messageIdCounter: ref(20),
  syncHistoryFromFullHistory: () => {},
  handleChangeModel: (value) => { context.model.value = value },
  applyNormalizedSkillSelection: (values) => { context.sessionSkillIds.value = values.map((item) => item === 'skill-b' ? 'Skill B' : item); context.tempSessionSkillIds.value = [...context.sessionSkillIds.value]; return context.sessionSkillIds.value },
  requestApplyMcpTools: async () => {},
  normalizeCompactConfigState: (value) => ({ ...value }),
  compactConfigLoadVersion: 0,
  compactConfigModelValue: '',

  compactProgress: ref({ percent: 0, stage: '', message: '' }),
  runConversationCompact: async () => { context.compacting.value = true; context.compactProgress.value = { percent: 55, stage: 'cascade', message: 'fixture' }; await Promise.resolve(); context.compacting.value = false; return true },
  handleCancelCompact: () => { context.__compactAbort = true },


  cancelAskAI: () => { context.loading.value = false; actions.push('cancel') }
}
context.executeAutoSaveRequest = async (request) => {
  actions.push(request.reason)
  context.lastPersistedSessionVersion = request.version
  context.currentConversationStorage.value.revision += 1
  return true
}
const ctx = vm.createContext(context)
vm.runInContext(block + '\n globalThis.adapter = { runRemoteConversationCommand, emitRemoteAssistantDelta, activeRemoteCommand, remoteHiddenWriter, pendingRemoteConfigPatch, applyPendingRemoteConfig, getRemoteSessionConfigSnapshot };', ctx)
const adapter = context.adapter
context.askAI = async () => {
  adapter.activeRemoteCommand.value.__remoteStarted = true
  adapter.emitRemoteAssistantDelta(adapter.activeRemoteCommand.value, 'first', 'reason', 'end', 'bubble-1')
  adapter.emitRemoteAssistantDelta(adapter.activeRemoteCommand.value, 'first!', 'reason', 'end', 'bubble-1')
  adapter.emitRemoteAssistantDelta(adapter.activeRemoteCommand.value, 'second', '', 'end', 'bubble-2')
}
const command = { type: 'conversation.send', conversationId: 'conversation-renderer-fixture', requestId: 'renderer-request-1', text: 'Hello', autoApproveTools: true }

const liveTools = [{ id: 'tool-live-renderer-0001', name: 'safe_tool', approvalStatus: 'executing', args: '{"query":"fixture"}', result: 'SECRET result' }]
adapter.activeRemoteCommand.value = { ...command, requestId: 'renderer-tool-snapshot', __remoteStarted: true }
adapter.emitRemoteAssistantDelta(adapter.activeRemoteCommand.value, '', '', '', 'tool-only-bubble', liveTools)
assert.equal(events.at(-1).event, 'assistant.delta')
assert.equal(events.at(-1).payload.textDelta, '')
assert.deepEqual(events.at(-1).payload.toolCalls, [{ id: 'tool-live-renderer-0001', name: 'safe_tool', approvalStatus: 'executing', args: '[参数已隐藏]' }])
adapter.activeRemoteCommand.value = null

await adapter.runRemoteConversationCommand(command)
assert.equal(adapter.activeRemoteCommand.value, null, 'shallowRef preserves identity for finalization')
assert.equal(events.at(-1).event, 'assistant.completed')
assert.equal(events.filter((event) => event.event === 'assistant.delta').map((event) => event.payload.textDelta || '').join(''), 'first!second')
assert.ok(actions.indexOf('remote-turn-finalized') < actions.indexOf('assistant.completed'))
assert.equal(events.at(-1).payload.revision, 2)


const attachmentCommand = {
  ...command,
  requestId: 'renderer-request-attachment',
  text: 'With image',
  uploadIds: ['upload-renderer-fixture-0001']
}
await adapter.runRemoteConversationCommand(attachmentCommand)
assert.deepEqual(consumedUploads.at(-1), {
  requestId: attachmentCommand.requestId,
  uploadId: attachmentCommand.uploadIds[0]
})
assert.equal(appendedMessages.at(-1).content[0].text, 'With image')
assert.equal(appendedMessages.at(-1).content[1].type, 'image_url')
assert.equal(context.chat_show.value.at(-1).content[1].type, 'image_url')

await adapter.runRemoteConversationCommand({
  ...command,
  requestId: 'renderer-request-attachment-only',
  text: '',
  uploadIds: ['upload-renderer-fixture-0002']
})
assert.equal(appendedMessages.at(-1).content.length, 1)
assert.equal(appendedMessages.at(-1).content[0].type, 'image_url')

const appendedBeforeAttachmentFailure = appendedMessages.length
context.window.api.consumeRemoteUpload = async () => { throw new Error('remote_upload_not_authorized') }
await adapter.runRemoteConversationCommand({
  ...command,
  requestId: 'renderer-request-attachment-fail',
  uploadIds: ['upload-renderer-fixture-0003']
})
assert.equal(events.at(-1).event, 'assistant.failed')
assert.equal(events.at(-1).payload.code, 'remote_attachment_unavailable')
assert.equal(appendedMessages.length, appendedBeforeAttachmentFailure, 'failed attachment preparation must not append a partial user message')
assert.doesNotMatch(block, /fileList\.value/, 'Remote commands must not mutate the Desktop draft attachment list')
context.window.api.consumeRemoteUpload = async (input) => {
  consumedUploads.push(structuredClone(input))
  return { uploadId: input.uploadId, content: { type: 'image_url', image_url: { url: 'data:image/png;base64,UE5HREFUQQ==' } } }
}

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

const activeBeforeRead = adapter.activeRemoteCommand.value
await adapter.runRemoteConversationCommand({ type: 'conversation.config.get', conversationId: command.conversationId, requestId: 'renderer-busy-config-read' })
assert.equal(events.at(-1).event, 'conversation.config.result')
assert.equal(events.at(-1).payload.busy, true)
assert.equal(adapter.activeRemoteCommand.value, activeBeforeRead)
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
// Run the real deletion function: a stub returning true masked the missing
// success return even though Desktop had already mutated and persisted history.
context.ensureLocalConversationWriteAccess = () => true
context.showDismissibleMessage = { warning() {}, info() {}, error() {}, success() {} }
context.resolveSafeConversationMutationTarget = (_history, ui, index) => context.fullHistory.value.findIndex(item => item.storageId === ui[index]?.storageId)
context.isToolMediaMessage = () => false
context.markOutermostCanRestore = () => {}
context.collapsedMessages = ref(new Set())
context.focusedMessageIndex = ref(null)
context.scheduleAutoSave = () => actions.push('delete-save-scheduled')
vm.runInContext(source.slice(source.indexOf('const deleteMessage ='), source.indexOf('const clearHistory =')) + '\nglobalThis.deleteMessage = deleteMessage;', ctx)
for (const item of context.chat_show.value) item.storageId = item.uiStorageId
context.fullHistory.value = context.chat_show.value.map(item => ({...item}))
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
assert.equal(events.at(-1).payload.code, 'remote_reask_latest_visible_required')
await adapter.runRemoteConversationCommand({
  type: 'conversation.message.reask', conversationId: command.conversationId, requestId: 'renderer-reask-last',
  uiMessageId: 'ui-assistant-last01'
})
assert.equal(events.at(-1).event, 'assistant.completed')
assert.ok(events.some((item) => item.requestId === 'renderer-reask-last' && item.event === 'assistant.delta' && item.payload.textDelta === 'reasked'))

context.chat_show.value = [
  { id: 20, uiStorageId: 'ui-user-before-reask', role: 'user', content: 'before resend' },
  { id: 21, uiStorageId: 'ui-user-final-reask', role: 'user', content: 'final user resend' }
]
await adapter.runRemoteConversationCommand({
  type: 'conversation.message.reask', conversationId: command.conversationId, requestId: 'renderer-reask-user-old',
  uiMessageId: 'ui-user-before-reask'
})
assert.equal(events.at(-1).payload.code, 'remote_reask_latest_visible_required')
await adapter.runRemoteConversationCommand({
  type: 'conversation.message.reask', conversationId: command.conversationId, requestId: 'renderer-reask-user-final',
  uiMessageId: 'ui-user-final-reask'
})
assert.equal(events.at(-1).event, 'assistant.completed')
assert.ok(events.some((item) => item.requestId === 'renderer-reask-user-final' && item.event === 'assistant.delta' && item.payload.textDelta === 'reasked'))



const saveCountBeforeConfigGet = actions.filter((item) => item === 'remote-turn-finalized' || item === 'remote-config-patch').length
await adapter.runRemoteConversationCommand({ type: 'conversation.config.get', conversationId: command.conversationId, requestId: 'renderer-config-get' })
assert.equal(events.at(-1).event, 'conversation.config.result')
assert.equal(events.at(-1).payload.config.model, 'provider|model-a')
assert.deepEqual(events.at(-1).payload.options.mcpServers, [
  { id: 'mcp-a', name: 'MCP A', tags: ['Research'], preset: true },
  { id: 'mcp-b', name: 'MCP B', tags: ['文件'], preset: false }
])
assert.equal(JSON.stringify(events.at(-1).payload.options.mcpServers).includes('MUST_NOT_LEAK'), false)
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


const cachedContextWrites = []
context.window.api.updateModelCompactConfig = async (_model, patch) => { cachedContextWrites.push(structuredClone(patch)); return { ok: true } }
await adapter.runRemoteConversationCommand({ type: 'conversation.config.patch', conversationId: command.conversationId, requestId: 'renderer-manual-context', patch: { compact: { contextLength: 65536 } } })
assert.equal(context.compactConfig.value.contextLength, 65536)
assert.equal(context.compactConfig.value.contextLengthSource, 'manual')
assert.equal(cachedContextWrites.at(-1).contextLengthManual, true)
context.window.api.resolveModelContext = async (model, options) => {
  assert.equal(model, 'provider|model-b')
  assert.equal(options.requireApi, true)
  return { ok: true, contextLength: 131072, source: 'api' }
}
context.refreshPromptTokenBreakdown = async () => { throw new Error('context lookup must not recount the transcript') }
await adapter.runRemoteConversationCommand({ type: 'conversation.context.refresh', conversationId: command.conversationId, requestId: 'renderer-fetch-context' })
assert.equal(context.compactConfig.value.contextLength, 131072)
assert.equal(events.at(-1).payload.config.compact.contextLengthSource, 'api')
context.window.api.resolveModelContext = async () => ({ ok: true, contextLength: 262144, source: 'default' })
await adapter.runRemoteConversationCommand({ type: 'conversation.context.refresh', conversationId: command.conversationId, requestId: 'renderer-fetch-context-failed' })
assert.equal(events.at(-1).event, 'conversation.operation.failed')
assert.equal(events.at(-1).payload.code, 'remote_context_resolve_failed')
assert.equal(context.compactConfig.value.contextLength, 131072, 'failed lookup preserves the prior context length')


const beforeFailedLookupWrites = cachedContextWrites.length

for (const code of ['context_lookup_timeout', 'context_network_unavailable', 'context_model_not_found']) {
  context.window.api.resolveModelContext = async () => ({ok: false, code})
  await adapter.runRemoteConversationCommand({type: 'conversation.context.refresh', conversationId: command.conversationId, requestId: `renderer-${code}`})
  assert.equal(events.at(-1).payload.code, `remote_${code}`)
  assert.equal(context.compactConfig.value.contextLength, 131072)
}
context.window.api.resolveModelContext = async () => ({ok: false, code: 'private/secret/should-not-leak'})
await adapter.runRemoteConversationCommand({type: 'conversation.context.refresh', conversationId: command.conversationId, requestId: 'renderer-context-safe-code'})
assert.equal(events.at(-1).payload.code, 'remote_context_resolve_failed')


assert.equal(cachedContextWrites.length, beforeFailedLookupWrites, 'failed lookup does not rewrite the model cache')
context.refreshPromptTokenBreakdown = async () => {}


// A busy config command persists a next-turn patch without mutating runtime
// values, tools, transcript, or the current generation's request identity.
const beforeNextTurn = {model: context.model.value, system: context.currentSystemPrompt.value, reasoning: context.tempReasoningEffort.value};
const activeGeneration = {type: 'conversation.send', conversationId: command.conversationId, requestId: 'renderer-current-generation'};
adapter.activeRemoteCommand.value = activeGeneration;
context.loading.value = true;
await adapter.runRemoteConversationCommand({type: 'conversation.config.patch', conversationId: command.conversationId, requestId: 'renderer-next-turn-model', patch: {model: 'provider|model-a', systemPrompt: 'Next system', reasoningEffort: 'low'}});
assert.equal(adapter.activeRemoteCommand.value, activeGeneration);
assert.equal(context.loading.value, true);
assert.equal(context.model.value, beforeNextTurn.model);
assert.equal(context.currentSystemPrompt.value, beforeNextTurn.system);
assert.equal(context.tempReasoningEffort.value, beforeNextTurn.reasoning);
assert.equal(events.at(-1).payload.deferred, true);
assert.equal(events.at(-1).payload.config.model, 'provider|model-a');
assert.equal(events.at(-1).requestId, 'renderer-next-turn-model');
assert.ok(actions.includes('remote-next-turn-config'));
await adapter.runRemoteConversationCommand({type: 'conversation.config.patch', conversationId: command.conversationId, requestId: 'renderer-next-turn-merge', patch: {voice: 'Voice A', compact: {contextLength: 65536}}});
assert.equal(adapter.pendingRemoteConfigPatch.value.systemPrompt, 'Next system');
assert.equal(adapter.getRemoteSessionConfigSnapshot().config.compact.contextLengthSource, 'manual');
const savedExecutor = context.executeAutoSaveRequest;
context.executeAutoSaveRequest = async () => false;
await adapter.runRemoteConversationCommand({type: 'conversation.config.patch', conversationId: command.conversationId, requestId: 'renderer-next-turn-fail', patch: {systemPrompt: 'Must not replace'}});
assert.equal(events.at(-1).event, 'conversation.operation.failed');
assert.equal(adapter.pendingRemoteConfigPatch.value.systemPrompt, 'Next system');
context.executeAutoSaveRequest = savedExecutor;
context.loading.value = false;
adapter.activeRemoteCommand.value = null;
await adapter.applyPendingRemoteConfig();
assert.equal(context.model.value, 'provider|model-a');
assert.equal(context.currentSystemPrompt.value, 'Next system');
assert.equal(context.selectedVoice.value, 'Voice A');
assert.equal(adapter.pendingRemoteConfigPatch.value, null);
assert.ok(actions.includes('remote-next-turn-applied'));
context.activeAssistantTurnMeta = null;
context.mobileControlActive.value = true;
await adapter.runRemoteConversationCommand({type: 'conversation.desktop.takeover', conversationId: command.conversationId, requestId: 'renderer-desktop-control'});
assert.equal(context.mobileControlActive.value, false);
assert.equal(events.at(-1).event, 'conversation.desktop.control.result');
assert.equal(events.at(-1).payload.ok, true);
context.mobileControlActive.value = true;
context.executeAutoSaveRequest = async () => false;
await adapter.runRemoteConversationCommand({type: 'conversation.desktop.takeover', conversationId: command.conversationId, requestId: 'renderer-desktop-control-fail'});
assert.equal(context.mobileControlActive.value, true);
assert.equal(events.at(-1).payload.ok, false);
context.executeAutoSaveRequest = savedExecutor;
const savedEmitter = context.window.api.emitRemoteRendererEvent;
context.window.api.emitRemoteRendererEvent = async event => {events.push(structuredClone(event)); return {ok: false}};
await adapter.runRemoteConversationCommand({type: 'conversation.desktop.takeover', conversationId: command.conversationId, requestId: 'renderer-control-expired'});
assert.equal(context.mobileControlActive.value, true, 'expired local takeover receipt cannot unlock Desktop');
context.window.api.emitRemoteRendererEvent = savedEmitter;

// Mobile takeover must acknowledge the actual idle lease-owning Renderer.
context.conversationReadOnly = ref(false);
context.mobileControlActive.value = false;
const mobileTakeoverCommand = {type: 'conversation.mobile.takeover', conversationId: command.conversationId, requestId: 'renderer-mobile-control'};
context.loading.value = true;
await adapter.runRemoteConversationCommand(mobileTakeoverCommand);
assert.equal(events.at(-1).payload.code, 'remote_conversation_busy');
assert.equal(context.mobileControlActive.value, false);
context.loading.value = false;
context.executeAutoSaveRequest = async () => false;
await adapter.runRemoteConversationCommand(mobileTakeoverCommand);
assert.equal(events.at(-1).payload.code, 'remote_conversation_save_failed');
assert.equal(context.mobileControlActive.value, false);
context.executeAutoSaveRequest = savedExecutor;
context.window.api.emitRemoteRendererEvent = async event => {events.push(structuredClone(event)); return {ok: false}};
await adapter.runRemoteConversationCommand(mobileTakeoverCommand);
assert.equal(context.mobileControlActive.value, false, 'expired mobile receipt cannot seize control');
context.window.api.emitRemoteRendererEvent = savedEmitter;
await adapter.runRemoteConversationCommand(mobileTakeoverCommand);
assert.equal(events.at(-1).event, 'conversation.mobile.control.result');
assert.equal(events.at(-1).payload.ok, true);
assert.equal(context.mobileControlActive.value, true);
assert.equal(context.desktopTakeoverPending.value, false);


// Serialize next-turn application with a newer patch arriving during tool apply.
context.loading.value = true;
await adapter.runRemoteConversationCommand({type: 'conversation.config.patch', conversationId: command.conversationId, requestId: 'renderer-serial-first', patch: {mcpServerIds: ['mcp-b'], systemPrompt: 'First pending'}});
assert.equal(events.at(-1).event, 'conversation.config.result', JSON.stringify(events.at(-1)));
assert.deepEqual(Array.from(adapter.pendingRemoteConfigPatch.value.mcpServerIds), ['mcp-b']);
context.loading.value = false;
let resumeApply;
const savedApplyTools = context.requestApplyMcpTools;
context.requestApplyMcpTools = async () => new Promise(resolve => {resumeApply = resolve});
const application = adapter.applyPendingRemoteConfig();
await new Promise(resolve => setImmediate(resolve));
context.loading.value = true;
const newerPatch = adapter.runRemoteConversationCommand({type: 'conversation.config.patch', conversationId: command.conversationId, requestId: 'renderer-serial-new', patch: {systemPrompt: 'Newer pending'}});
resumeApply();
await application;
await newerPatch;
assert.equal(context.currentSystemPrompt.value, 'First pending');
assert.equal(adapter.pendingRemoteConfigPatch.value.systemPrompt, 'Newer pending');
context.requestApplyMcpTools = savedApplyTools;
context.loading.value = false;
await adapter.applyPendingRemoteConfig();
assert.equal(context.currentSystemPrompt.value, 'Newer pending');
assert.equal(adapter.pendingRemoteConfigPatch.value, null);


context.mobileControlActive.value = false;


const compactEventStart = events.length
await adapter.runRemoteConversationCommand({ type: 'conversation.compact', conversationId: command.conversationId, requestId: 'renderer-compact' })
const compactEvents = events.slice(compactEventStart)
assert.ok(compactEvents.some((item) => item.event === 'conversation.compact.progress' && item.payload.percent === 55))
assert.equal(compactEvents.at(-1).event, 'conversation.compact.completed')
assert.equal(compactEvents.at(-1).payload.changed, true)
context.runConversationCompact = async () => { const error = new Error('Aborted'); error.name = 'AbortError'; throw error }
await adapter.runRemoteConversationCommand({ type: 'conversation.compact', conversationId: command.conversationId, requestId: 'renderer-compact-cancelled' })
assert.equal(events.at(-1).event, 'conversation.compact.cancelled')
context.activeRemoteCommand = adapter.activeRemoteCommand
adapter.activeRemoteCommand.value = { type: 'conversation.compact', conversationId: command.conversationId, requestId: 'renderer-compact-active' }
context.compacting.value = true
await adapter.runRemoteConversationCommand({ type: 'conversation.compact.cancel', conversationId: command.conversationId, requestId: 'cancel-compact', targetRequestId: 'renderer-compact-active' })
assert.equal(context.__compactAbort, true)
adapter.activeRemoteCommand.value = null
context.compacting.value = false


// Run the actual edit implementation on authoritative UI/canonical messages.
const originalEditStub = context.handleEditMessage;
context.replaceConversationEditableText = replaceConversationEditableText;
context.resolveEditableFullHistoryIndex = index => index;
vm.runInContext(source.slice(source.indexOf('const handleEditMessage ='), source.indexOf('const handleEditStart =')) + '\nglobalThis.realEditMessage = handleEditMessage;', ctx);
const beforeEditUi = context.chat_show.value;
const beforeEditHistory = context.fullHistory.value;
const documentOne = {type: 'text', text: 'file name:one.docx\nfile content:\nORIGINAL_DOCUMENT_ONE\nfile end'};
const documentTwo = {type: 'text', text: 'file name:two.xlsx\nfile content:\nORIGINAL_DOCUMENT_TWO\nfile end'};
const mixed = [{type: 'text', text: 'old prose'}, documentOne, documentTwo, {type: 'image_url', image_url: {url: 'fixture-image'}}];
context.chat_show.value = [{id: 900, role: 'user', content: structuredClone(mixed)}];
context.fullHistory.value = [{role: 'user', content: structuredClone(mixed)}];
context.handleEditMessage = context.realEditMessage;
assert.equal(context.handleEditMessage(0, 'new prose', {}), true);
for (const message of [context.chat_show.value[0], context.fullHistory.value[0]]) {
  assert.equal(message.content[0].text, 'new prose');
  assert.equal(message.content[1].text, documentOne.text);
  assert.equal(message.content[2].text, documentTwo.text);
  assert.equal(message.content[3].image_url.url, 'fixture-image');
}
assert.equal(context.handleEditMessage(0, 'newest prose', {}), true);
assert.equal(context.fullHistory.value[0].content[1].text, documentOne.text);
context.chat_show.value[0].content = documentOne.text;
context.fullHistory.value[0].content = documentOne.text;
assert.equal(context.handleEditMessage(0, 'added prose', {}), true);
assert.equal(context.fullHistory.value[0].content[0].text, documentOne.text);
assert.equal(context.fullHistory.value[0].content[1].text, 'added prose');
const standaloneFile = {type: 'file', file: {filename: 'standalone.pdf', file_data: 'ORIGINAL_FILE_DATA'}};
assert.deepEqual(replaceConversationEditableText(standaloneFile, 'added input'), [standaloneFile, {type: 'text', text: 'added input'}]);

context.handleEditMessage = originalEditStub;
context.chat_show.value = beforeEditUi;
context.fullHistory.value = beforeEditHistory;


const metadataEventStart = events.length
const revisionBeforeRemoteRename = context.currentConversationStorage.value.revision
await adapter.runRemoteConversationCommand({
  type: 'conversation.rename', conversationId: command.conversationId,
  requestId: 'renderer-conversation-rename', title: 'Renamed conversation'
})
assert.equal(context.defaultConversationName.value, 'Renamed conversation')
assert.equal(context.currentConversationStorage.value.title, 'Renamed conversation')
assert.equal(context.currentConversationStorage.value.revision, revisionBeforeRemoteRename + 1)
assert.equal(events.slice(metadataEventStart).at(-1).event, 'conversation.operation.completed')
assert.equal(events.slice(metadataEventStart).at(-1).payload.title, 'Renamed conversation')
assert.ok(actions.includes('rename-conversation:Renamed conversation'))

adapter.remoteHiddenWriter.value = true
await adapter.runRemoteConversationCommand({ type: 'remote.revealed', conversationId: command.conversationId })
assert.equal(adapter.remoteHiddenWriter.value, false)
await adapter.runRemoteConversationCommand({ type: 'remote.shutdown', conversationId: command.conversationId })
assert.equal(actions.includes('window-close'), false)
adapter.remoteHiddenWriter.value = true
await adapter.runRemoteConversationCommand({ type: 'remote.shutdown', conversationId: command.conversationId })
assert.equal(actions.at(-1), 'window-close')


const windowCloseCountBeforeDelete = actions.filter((item) => item === 'window-close').length
await adapter.runRemoteConversationCommand({
  type: 'conversation.delete', conversationId: command.conversationId,
  requestId: 'renderer-conversation-delete-unconfirmed', confirmed: false
})
assert.equal(events.at(-1).payload.code, 'remote_confirmation_required')

await adapter.runRemoteConversationCommand({
  type: 'conversation.delete', conversationId: command.conversationId,
  requestId: 'renderer-conversation-delete', confirmed: true
})
assert.equal(events.at(-1).event, 'conversation.operation.completed')
assert.equal(events.at(-1).payload.deleted, true)
assert.ok(actions.includes(`delete-conversation:${command.conversationId}`))
assert.ok(actions.includes('lease-heartbeat-stop'))
assert.equal(context.conversationLease.value, null)
assert.equal(actions.at(-1), 'buffer-flush')
assert.equal(actions.filter((item) => item === 'window-close').length, windowCloseCountBeforeDelete + 1)

assert.match(source, /if \(!turnRemoteCommand\) await flushAppendBuffer\(\)/)
assert.match(source, /approvalStatus: autoApproveThisTurn\(\)/)
assert.doesNotMatch(block, /isAutoApproveTools\.value = true/)
const windowSource = await fs.readFile(new URL('../main/windowManager.js', import.meta.url), 'utf8')
assert.match(windowSource, /setBackgroundThrottling\(false\)/)
assert.match(windowSource, /type: 'remote.revealed'/)
console.log(JSON.stringify({ ok: true, suite: 'remote-renderer-adapter' }))
