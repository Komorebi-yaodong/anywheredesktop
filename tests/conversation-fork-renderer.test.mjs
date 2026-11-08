import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import vm from 'node:vm'

for (const filename of process.argv.slice(2).length ? process.argv.slice(2) : [new URL('../render/window/App.vue', import.meta.url)]) {
  const source = await fs.readFile(filename, 'utf8')
  const start = source.indexOf('const forkInProgress =')
  const block = source.slice(start, source.indexOf('const getSessionDataAsObject =', start))
  const events = []
  const ref = value => ({value})
  let saved = true
  const context = {ref, isClosingWindow: ref(false), loading: ref(false), compacting: ref(false), isPreparingSend: ref(false), isMcpLoading: ref(false),
    chat_show: ref([{role: 'user', uiStorageId: 'ui-target'}]),
    ensureLocalConversationWriteAccess: () => true, ensureConversationWriteAccess: () => true,
    clearScheduledAutoSave: () => events.push('clear'), sessionMutationVersion: 0,
    executeAutoSaveRequest: async () => {events.push('save'); return saved}, autoSaveMutationQueue: {whenIdle: async () => {events.push('idle')}},
    currentConversationStorage: ref({conversationId: 'source', dirPath: 'synthetic-dir'}), currentConfig: ref({}), CODE: ref('Code'),
    showDismissibleMessage: {error() {}},
    window: {api: {forkConversation: async input => {events.push('fork'); assert.equal(input.uiMessageId, 'ui-target'); return {descriptor: {conversationId: 'forked', title: 'fork-Test'}, sessionData: {}}},
      openWindow: async () => {events.push('open')}, openConversationWindow: async () => {events.push('open')}}}}
  const fork = vm.runInNewContext(`${block}; handleForkMessage`, context)
  assert.equal((await fork(0)).forkedConversationId, 'forked')
  assert.deepEqual(events, ['clear','save','idle','fork','open'])
  if (source.includes('ensureLocalConversationWriteAccess')) {
    events.length = 0;
    context.chat_show.value = [];
    assert.equal((await fork(-1, {uiMessageId: 'ui-target'})).forkedConversationId, 'forked');
    assert.deepEqual(events, ['clear','save','idle','fork'], 'Remote fork may target an earlier page without reloading the live writer');
    context.chat_show.value = [{role: 'user', uiStorageId: 'ui-target'}];
  }
  saved = false; events.length = 0
  await assert.rejects(fork(0), /remote_conversation_save_failed/)
  assert.deepEqual(events, ['clear','save','idle'])
  context.loading.value = true
  await assert.rejects(fork(0), /remote_conversation_busy/)
}
const message = await fs.readFile(new URL('../render/window/components/ChatMessage.vue', import.meta.url), 'utf8')
const forkIcon = await fs.readFile(new URL('../render/window/components/ForkIcon.vue', import.meta.url), 'utf8')
assert.equal((message.match(/:icon="ForkIcon"/g) || []).length, 2, 'both user and assistant actions use fork, never a share glyph')
assert.doesNotMatch(message, /:icon="Share"/)
assert.equal((forkIcon.match(/<circle /g) || []).length, 3)

console.log('PASS actual fork renderer saves-before-copy / opens-target / failed-save / busy guards')
