import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import vm from 'node:vm'
import {resolveSafeConversationMutationTarget} from '../render/window/utils/conversationMessageTarget.js'
import {recoverMissingToolProjection} from '../packages/conversation-core/toolProjection.js'
import * as store from '../main/core/conversationStore.js'

const source = (await fs.readFile(new URL('../render/window/App.vue', import.meta.url), 'utf8')).replace(/\r\n/g, '\n')
const ref = value => ({value})
const clone = value => structuredClone(value)
const projection = source.slice(source.indexOf('const toRequestMessageFromFullHistory ='), source.indexOf('const reloadConversationWindowFromStore ='))
const catchStart = source.indexOf('    // A queued frame must never overwrite')
const errorBlock = source.slice(catchStart, source.indexOf('\n  } finally {', catchStart))
const helpers = source.slice(source.indexOf('const normalizeAssistantMessageContent ='), source.indexOf('const getCurrentAssistantDisplayName ='))
const terminal = source.slice(source.indexOf('const ensureAssistantTerminalBubble ='), source.indexOf('// view_image results become'))
const retryBlock = source.slice(source.indexOf('const reaskAI ='), source.indexOf('const deleteMessage ='))
const deleteBlock = source.slice(source.indexOf('const deleteMessage ='), source.indexOf('const clearHistory ='))
const user = {role: 'user', storageId: 'user-1', content: 'synthetic user'}
const tool = {role: 'assistant', storageId: 'assistant-tool', content: null, tool_calls: [{id: 'call-1', type: 'function', function: {name: 'synthetic_tool', arguments: '{}'}}]}
const toolResult = {role: 'tool', storageId: 'tool-result', tool_call_id: 'call-1', name: 'synthetic_tool', content: 'synthetic result'}
const userUi = {...user, id: 1, uiStorageId: 'ui-user', content: [{type: 'text', text: user.content}]}
const toolUi = {...tool, id: 2, uiStorageId: 'ui-tool', content: [], tool_calls: [{id: 'call-1', name: 'synthetic_tool', args: '{}', result: 'synthetic result', approvalStatus: 'finished'}]}
function fixture(stage) {
  let full = [user], ui = [userUi, {id: 2, storageId: 'assistant-plain', role: 'assistant', content: [], tool_calls: []}]
  if (stage === 'partial-text') ui[1].content = [{type: 'text', text: 'partial text'}]
  if (stage.startsWith('tool-')) {full = [user, tool, toolResult]; ui = [userUi, toolUi]}
  if (stage === 'tool-boundary-failed-result') {
    full = [user, tool, {...toolResult, content: 'synthetic tool failure'}]
    ui = [userUi, {...toolUi, tool_calls: [{...toolUi.tool_calls[0], result: 'synthetic tool failure'}]}]
  }
  if (stage === 'tool-next-request') ui.push({id: 3, storageId: 'assistant-next', role: 'assistant', content: [], tool_calls: []})
  const requests = [], warnings = []
  let counter = 0
  const c = {console, Set, Date, Error, fullHistory: ref(clone(full)), chat_show: ref(clone(ui)), history: ref([]),
    loading: ref(false), compacting: ref(false), isMcpLoading: ref(false), isPreparingSend: ref(false), isReasking: false,
    collapsedMessages: ref(new Set()), focusedMessageIndex: ref(null), messageIdCounter: ref(10),
    ensureConversationWriteAccess: () => true, ensureLocalConversationWriteAccess: () => true,
    deepCloneSafe: clone, DEFAULT_SUMMARY_PREFIX: 'summary', createConversationStorageId: () => `new-${++counter}`,
    showDismissibleMessage: {warning: text => warnings.push(text), info() {}},
    resolveSafeConversationMutationTarget, isToolMediaMessage: () => false,
    markOutermostCanRestore() {}, scheduleAutoSave() {}, ensureLatestTailUserBubble() {},
    getComparableRenderableSignature: message => JSON.stringify({role: message.role, content: message.content}),
    findTailUiMessageIndexBySignature: () => -1, getCurrentAssistantDisplayName: () => 'Synthetic', selectedVoice: ref(''),
    currentAssistantChatShowIndex: ui.length - 1, cancelPendingStreamingDisplay: null,
    isAbortError: () => false, isCurrentAssistantTurn: () => true, turnMeta: {assistantMessageId: ui.at(-1).id}, turnRemoteCommand: null,
    formatErrorMessageForDisplay: error => error.message, buildMissingToolAbortMessages: () => [],
    askAI: async () => {requests.push(clone(c.project()))}, requests, warnings}
  c.appendFullHistory = (...messages) => {c.fullHistory.value.push(...messages.map(clone)); c.history.value = c.project()}
  c.findAssistantTurnBubbleIndex = turn => c.chat_show.value.findIndex(m => m.id === turn.assistantMessageId)
  vm.runInNewContext(projection + helpers + terminal + '\n' + retryBlock + deleteBlock + '\n' +
    'globalThis.project = projectFullHistoryToRequestHistory; globalThis.retry = reaskAI; globalThis.remove = deleteMessage; globalThis.cancel = () => finalizeCancelledAssistantTurn(turnMeta); globalThis.fail = async (error) => {' + errorBlock + '};' +
    'globalThis.syncHistoryFromFullHistory = () => {history.value = projectFullHistoryToRequestHistory();};', c)
  return c
}
function assertConsistent(c) {
  assert.equal(new Set(c.fullHistory.value.map(m => m.storageId)).size, c.fullHistory.value.length, 'canonical IDs must remain unique')
  for (const message of c.fullHistory.value.filter(m => m.role === 'assistant')) {
    const index = c.chat_show.value.findIndex(ui => ui.storageId === message.storageId)
    assert.notEqual(index, -1, 'every synthetic assistant segment must remain visible')
    assert.equal(resolveSafeConversationMutationTarget(c.fullHistory.value, c.chat_show.value, index), c.fullHistory.value.indexOf(message))
  }
}
let cases = 0
for (const stage of ['before-output', 'partial-text', 'tool-boundary', 'tool-boundary-failed-result', 'tool-next-request']) {
  for (const message of ['remote_buffered_message_unavailable', 'HTTP 500 synthetic failure']) {
    for (const operation of ['retry', 'delete']) {
      const c = fixture(stage)
      await c.fail(new Error(message))
      assertConsistent(c)
      if (operation === 'retry') {await c.retry(c.chat_show.value.at(-1).id); assert.equal(c.requests.length, 1)}
      else assert.equal(c.remove(c.chat_show.value.length - 1), true)
      assertConsistent(c)
      assert.equal(c.project().some(m => m.role === 'tool'), stage.startsWith('tool-'))
      assert.equal(c.project().some(m => JSON.stringify(m.content).includes(message)), false, 'removed error cannot leak into the next request')
      if (stage.startsWith('tool-')) {
        const toolIndex = c.chat_show.value.findIndex(m => m.storageId === tool.storageId)
        assert.equal(c.remove(toolIndex), true)
        assert.equal(c.project().some(m => m.role === 'tool' || m.tool_calls?.length), false, 'delete tool card removes exact call and results')
      }
      cases++
    }
  }
}
for (const stage of ['before-output', 'tool-boundary', 'tool-next-request']) {
  const c = fixture(stage)
  c.cancel()
  assertConsistent(c)
  const size = c.fullHistory.value.length
  c.cancel()
  assert.equal(c.fullHistory.value.length, size, 'cancellation terminal is idempotent')
  await c.retry(c.chat_show.value.at(-1).id)
  assertConsistent(c)
}
const foreignResult = fixture('tool-boundary')
foreignResult.fullHistory.value.splice(2, 0, {role: 'tool', storageId: 'foreign-result', tool_call_id: 'foreign-call', content: 'must remain'})
foreignResult.chat_show.value.push({role: 'tool', tool_call_id: 'foreign-call', content: 'must remain'})
assert.equal(foreignResult.remove(1), true)
assert.equal(foreignResult.fullHistory.value.some(m => m.storageId === 'foreign-result'), true)
assert.equal(foreignResult.chat_show.value.some(m => m.tool_call_id === 'foreign-call'), true, 'delete cannot consume another call result by contiguous count')


// A legacy mixed bubble must fail closed, not disappear while leaving a hidden tool turn.
const damaged = fixture('tool-boundary')
const errorText = '\n\n> **错误信息**：remote_buffered_message_unavailable'
damaged.fullHistory.value.push({role: 'assistant', storageId: 'legacy-error', content: [{type: 'text', text: errorText}]})
damaged.chat_show.value[1] = {...clone(toolUi), storageId: 'legacy-error', content: [{type: 'text', text: errorText}]}
assert.equal(damaged.remove(1), undefined)
await damaged.retry(2)
assert.equal(damaged.requests.length, 0)
assert.equal(damaged.chat_show.value.length, 2)
const recovered = recoverMissingToolProjection(damaged.fullHistory.value, damaged.chat_show.value)
assert.equal(recovered.recovered, 1)
assert.equal(recovered.separated, 1)
damaged.chat_show.value = recovered.messages
assertConsistent(damaged)
assert.equal(recoverMissingToolProjection(damaged.fullHistory.value, damaged.chat_show.value).recovered, 0)

// Recovery can add higher UI IDs while the live counter still reflects the old cache.
const reloadStart = source.indexOf('const reloadConversationWindowFromStore =')
const reloadEnd = source.indexOf('const hydratePagedConversationForCompaction =', reloadStart)
const reloadContext = {
  currentConversationStorage: ref({dirPath: 'synthetic-dir', conversationId: 'synthetic-id'}),
  chat_show: ref([]), messageIdCounter: ref(3), defaultConversationName: ref('old title'),
  window: {api: {openConversation: async () => ({descriptor: {title: 'updated title'}, sessionData: {chat_show: [{id: 90, role: 'assistant'}]}})}},
  replaceFullHistory() {}, syncHistoryFromFullHistory() {}
}
const reload = vm.runInNewContext(source.slice(reloadStart, reloadEnd) + '\nreloadConversationWindowFromStore', reloadContext)
await reload()
assert.equal(reloadContext.messageIdCounter.value, 91, 'new turn IDs cannot collide after repaired projection reload')
assert.equal(reloadContext.defaultConversationName.value, 'updated title', 'observer reload must update its visible title')


const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'anywhere-tool-error-'))
try {
  for (const operation of ['retry', 'delete']) {
    const c = fixture('tool-boundary')
    await c.fail(new Error('remote_buffered_message_unavailable'))
    const created = await store.createConversation({dirPath: tempRoot, title: 'synthetic-error', sessionData: {fullHistory: c.fullHistory.value, chat_show: c.chat_show.value}})
    const conversationId = created.descriptor.conversationId
    const opened = await store.openConversation({dirPath: tempRoot, reference: conversationId, pageSize: 0})
    c.fullHistory.value = opened.sessionData.fullHistory; c.chat_show.value = opened.sessionData.chat_show
    assertConsistent(c)
    if (operation === 'retry') await c.retry(c.chat_show.value.at(-1).id)
    else assert.equal(c.remove(c.chat_show.value.length - 1), true)
    const holderInstanceId = 'synthetic-tool-error-holder'
    const lease = await store.acquireWriteLease({dirPath: tempRoot, conversationId, holderInstanceId, holderApp: 'test'})
    await store.saveConversationSnapshot({dirPath: tempRoot, conversationId, expectedRevision: opened.descriptor.revision, holderInstanceId, leaseEpoch: lease.leaseEpoch, sessionData: {...opened.sessionData, fullHistory: c.fullHistory.value, chat_show: c.chat_show.value}})
    const reopened = await store.openConversation({dirPath: tempRoot, reference: conversationId, pageSize: 0})
    c.fullHistory.value = reopened.sessionData.fullHistory; c.chat_show.value = reopened.sessionData.chat_show
    assertConsistent(c)
    assert.equal(c.project().some(m => JSON.stringify(m.content).includes('remote_buffered_message')), false)
    await store.releaseWriteLease({dirPath: tempRoot, conversationId, holderInstanceId, leaseEpoch: lease.leaseEpoch})
  }
} finally {await fs.rm(tempRoot, {recursive: true, force: true})}
console.log(JSON.stringify({ok: true, suite: 'conversation-tool-error', matrixCases: cases, cancellation: 3, sqliteRoundtrips: 2}))
