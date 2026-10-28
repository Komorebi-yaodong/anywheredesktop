import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import vm from 'node:vm'
import {ref} from 'vue'
import {estimateMessagesTokens} from '../main/core/compact.js'

const source = (await fs.readFile(new URL('../render/window/App.vue', import.meta.url), 'utf8')).replace(/\r\n/g, '\n')
const slice = (start, end) => {
  const from = source.indexOf(start), to = source.indexOf(end, from)
  assert.ok(from >= 0 && to > from, `${start} must exist`)
  return source.slice(from, to)
}
function fixture() {
  const calls = []
  const context = {
    ref, Date, console,
    DEFAULT_SUMMARY_PREFIX: 'summary',
    deepCloneSafe: value => JSON.parse(JSON.stringify(value)),
    toHistoryMessageFromUi: value => ({role: value.role, content: value.content, reasoning_content: value.reasoning_content}),
    currentConversationStorage: ref({conversationId: 'synthetic-context', dirPath: 'synthetic-only', isPaged: true, loadedFromOrdinal: 3}),
    model: ref('fixture|model'),
    loading: ref(false), activeAssistantTurnMeta: null, chat_show: ref([]),
    fullHistory: ref([{role: 'system', content: 'SYS'}, {role: 'user', content: 'dirty tail', storageId: 'tail', storageOrdinal: 3}]),
    promptTokenBreakdown: ref({systemTokens: 0, conversationTokens: 0, toolTokens: 0, updatedAt: 0}),
    estimateCurrentDynamicToolPrompt: async () => ({totalTokens: 17}),
    window: {api: {
      getConversationRequestMessages: async () => ({messages: [
        {role: 'system', content: 'OLD SYS'},
        {role: 'user', content: 'prefix', storageOrdinal: 1},
        {role: 'assistant', content: 'reply', storageOrdinal: 2},
        {role: 'user', content: 'old saved tail', storageOrdinal: 3},
      ]}),
      estimateCompactTokens: async messages => {
        calls.push(JSON.parse(JSON.stringify(messages)))
        return {tokens: messages.reduce((sum, message) => sum + (typeof message.content === 'string' ? message.content.length : 0), 0)}
      },
    }},
  }
  vm.createContext(context)
  vm.runInContext([
    slice('const toRequestMessageFromFullHistory =', 'const reloadConversationWindowFromStore ='),
    slice('const buildRequestHistoryForCurrentConversation =', 'const syncHistoryFromFullHistory ='),
    slice('let promptTokenBreakdownJob =', 'const getCompactTokenSnapshot ='),
    'globalThis.refresh = refreshPromptTokenBreakdown;',
  ].join('\n'), context)
  return {context, calls}
}

// Never opening the Desktop panel must still yield the complete request context.
const idle = fixture()
const before = JSON.stringify(idle.context.fullHistory.value)
const first = idle.context.refresh()
assert.equal(first, idle.context.refresh(), 'concurrent reads share one recount')
await first
assert.equal(idle.calls.length, 2)
assert.equal(idle.context.promptTokenBreakdown.value.systemTokens, 3)
assert.equal(idle.context.promptTokenBreakdown.value.conversationTokens, 'prefixreplydirty tail'.length)
assert.equal(idle.context.promptTokenBreakdown.value.toolTokens, 17)
assert.ok(idle.context.promptTokenBreakdown.value.updatedAt > 0)
assert.equal(JSON.stringify(idle.context.fullHistory.value), before, 'no transcript write/reload')
assert.ok(!JSON.stringify(idle.calls).includes('old saved tail'))

// Count the current streaming bubble exactly once without accepting unrelated UI records.
const live = fixture()
live.context.loading.value = true
live.context.activeAssistantTurnMeta = {assistantMessageId: 42}
live.context.chat_show.value = [
  {id: 41, storageId: 'unrelated', role: 'assistant', content: 'must not count'},
  {id: 42, storageId: 'stream', role: 'assistant', content: 'live text'},
]
await live.context.refresh()
assert.equal(live.context.promptTokenBreakdown.value.conversationTokens, 'prefixreplydirty taillive text'.length)
live.context.fullHistory.value.push({storageId: 'stream', role: 'assistant', content: 'live text'})
await live.context.refresh()
assert.equal(live.context.promptTokenBreakdown.value.conversationTokens, 'prefixreplydirty taillive text'.length)
live.context.fullHistory.value.pop()
live.context.chat_show.value[1].isPreparing = true
await live.context.refresh()
assert.equal(live.context.promptTokenBreakdown.value.conversationTokens, 'prefixreplydirty tail'.length)

// The production tokenizer also sees streamed reasoning and multimodal/tool payloads.
const actual = fixture()
actual.context.currentConversationStorage.value.isPaged = false
actual.context.loading.value = true
actual.context.activeAssistantTurnMeta = {assistantMessageId: 7}
actual.context.chat_show.value = [{id: 7, role: 'assistant', storageId: 'tokenizer-live', content: '正在生成的正文', reasoning_content: '思考过程'}]
actual.context.window.api.estimateCompactTokens = async (messages, options) => ({ok: true, tokens: estimateMessagesTokens(messages, options)})
await actual.context.refresh()
assert.equal(actual.context.promptTokenBreakdown.value.systemTokens, estimateMessagesTokens([{role: 'system', content: 'SYS'}]))
assert.equal(actual.context.promptTokenBreakdown.value.conversationTokens, estimateMessagesTokens([
  {role: 'user', content: 'dirty tail'},
  {role: 'assistant', content: '正在生成的正文', reasoning_content: '思考过程'},
]))


// Failure preserves useful counts; a later read can recover.
const last = {...idle.context.promptTokenBreakdown.value}
const estimator = idle.context.window.api.estimateCompactTokens
idle.context.window.api.estimateCompactTokens = async () => {throw new Error('fixture IPC failed')}
await idle.context.refresh()
assert.equal(idle.context.promptTokenBreakdown.value.conversationTokens, last.conversationTokens)
assert.equal(idle.context.promptTokenBreakdown.value.updatedAt, last.updatedAt)
assert.equal(idle.context.promptTokenBreakdown.value.loading, false)
idle.context.window.api.estimateCompactTokens = estimator
await idle.context.refresh()
assert.equal(idle.context.promptTokenBreakdown.value.error, '')

// Late async estimates must never overwrite a different conversation/model.
for (const change of ['conversation', 'model']) {
  const f = fixture()
  let release
  f.context.estimateCurrentDynamicToolPrompt = () => new Promise(resolve => {release = resolve})
  const pending = f.context.refresh()
  await new Promise(resolve => setImmediate(resolve))
  if (change === 'conversation') f.context.currentConversationStorage.value.conversationId = 'other-synthetic'
  else f.context.model.value = 'fixture|other'
  release({totalTokens: 999})
  await pending
  assert.equal(f.context.promptTokenBreakdown.value.updatedAt, 0)
  assert.equal(f.context.promptTokenBreakdown.value.loading, false)
  f.context.estimateCurrentDynamicToolPrompt = async () => ({totalTokens: 17})
  await f.context.refresh()
  assert.ok(f.context.promptTokenBreakdown.value.updatedAt > 0)
}
console.log('context-usage-refresh: PASS (idle, paging/dirty tail, streaming, dedup, single-flight, recovery, stale scope)')
