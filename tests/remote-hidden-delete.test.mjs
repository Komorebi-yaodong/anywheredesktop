import assert from 'node:assert/strict'
import {createRemoteSessionManager} from '../main/core/remote/sessionManager.js'
import {createBusinessProtocol} from '../main/core/remote/businessProtocol.js'
import {createOperationJournal} from '../main/core/remote/operationJournal.js'
import fs from 'node:fs/promises'
import vm from 'node:vm'
import {ref} from 'vue'
import {completeConversationClose} from '../render/window/utils/conversationMutationQueue.js'

// Execute the real close guard, not a stub that assumes deleted writers close.
const rendererSource = await fs.readFile(new URL('../render/window/App.vue', import.meta.url), 'utf8')
const closeSource = rendererSource.slice(rendererSource.indexOf('const closePage = async'), rendererSource.indexOf('const handlePickFileStart'))
for (const deleted of [false, true]) {
 const calls = []
 const close = vm.runInNewContext(closeSource + '\nclosePage', {
  isClosingWindow: ref(false), isFilePickerOpen: ref(false), remoteConversationDeleted: ref(deleted),
  loading: ref(false), compacting: ref(false), activeAssistantTurnMeta: null, remoteConfigExecutionPromise: null,
  waitForPendingWindowMutationsBeforeClose: async () => {}, killAllRunningSubAgentsForCurrentConversation: async () => {},
  currentConversationStorage: ref({conversationId: 'deleted-writer-fixture', dirPath: 'synthetic'}), currentConfig: ref({}),
  conversationPersistenceTracker: {getState: () => ({hasUnpersistedMutations: true, hasUnpersistedFullSnapshot: true})},
  ensureConversationWriteAccess: () => false, lastAutoSaveError: new Error('conversation_not_found'),
  defaultConversationName: ref('Synthetic'), persistLatestSessionBeforeClose: async () => {calls.push('save'); return false},
  releaseCurrentConversationLease: async () => {calls.push('release')}, completeConversationClose,
  window: {api: {windowControl: () => {calls.push('close')}}},
  showDismissibleMessage: {error: () => {calls.push('error')}}, getErrorMessage: error => error.message,
  console: {error() {}}
 })
 assert.equal(await close(false), deleted, 'confirmed deletion must close without saving a removed database; live dirty histories must remain protected')
 assert.deepEqual(calls, deleted ? ['release', 'close'] : ['error'])
}


const cid = 'conversation-hidden-delete-fixture'
const deviceId = 'device-hidden-delete-fixture'
for (const failure of [false, true]) {
 const items = [], commands = []
 let manager
 manager = createRemoteSessionManager({
  getConfig: async () => ({config: {webdav: {localChatPath: 'synthetic-only'}}}),
  openConversation: async () => ({descriptor: {conversationId: cid, title: 'Synthetic'}, sessionData: {CODE: 'AI'}}),
  listWindows: () => items,
  getWindowByRef: id => items.some(item => item.id === id) ? {isDestroyed: () => false} : null,
  openWindow: async () => {
   const item = {id: 'writer-delete-fixture', type: 'window', conversationId: cid, remoteHidden: true, rendererReady: false, leasePending: true}
   items.push(item)
   setTimeout(() => {item.rendererReady = true; item.leasePending = false}, 10)
   return {ok: true, id: item.id}
  },
  dispatchRemoteCommandToWindow: async (windowRef, command) => {
   commands.push(command.type)
   if (command.type === 'remote.shutdown') items.splice(0)
   if (command.type === 'conversation.delete') {
    manager.handleRendererEvent({windowRef, payload: {conversationId: cid, requestId: command.requestId, event: failure ? 'conversation.operation.failed' : 'conversation.operation.completed', payload: failure ? {code: 'remote_conversation_metadata_failed'} : {operation: command.type, deleted: true}}})
    if (!failure) {items.splice(0); manager.handleWindowClosed(windowRef)}
   }
   return {ok: true}
  },
  revealRemoteConversationWindow: () => ({ok: true}), broadcastToDevice() {}, readinessTimeoutMs: 500,
 })
 let disk = null
 const operations = createOperationJournal({load: async () => disk, save: async value => {disk = structuredClone(value)}})
 const service = createBusinessProtocol({readService: {}, getManager: () => manager, operations, dispatch: (context, requestId, method, params) => manager.deleteConversation({deviceId: context.device.deviceId, requestId, params})})
 const context = {device: {deviceId}, capabilities: ['conversation.delete']}
 service.negotiate(context, {versions: [{major: 1, minor: 1}]})
 const issuedAt = Date.now()
 const result = await service.command(context, {commandId: `command-${issuedAt}-hidden-delete-fixture`, issuedAt, method: 'conversation.delete', params: {conversationId: cid, confirmed: true}, preconditions: {controlEpoch: 'window-none'}})
 assert.ok(commands.includes('conversation.delete'), `delete must dispatch after writer readiness: ${result.code}`)
 await new Promise(resolve => setTimeout(resolve, 20))
 assert.equal(items.length, 0, 'new hidden writer must not remain after deletion or failed metadata command')
 if (failure) assert.ok(commands.includes('remote.shutdown'))
 await manager.closeAll()
}
// A deletion receipt must revoke ownership even if the renderer close is delayed.
{
 const items = [{id: 'orphan-writer-fixture', type: 'window', conversationId: cid, remoteHidden: true, rendererReady: true}]
 const commands = []; let manager
 manager = createRemoteSessionManager({
  getConfig: async () => ({config: {webdav: {localChatPath: 'synthetic'}}}),
  openConversation: async () => {throw new Error('conversation_not_found')},
  listWindows: () => items, getWindowByRef: () => ({isDestroyed: () => false}), openWindow: async () => ({ok: false}),
  dispatchRemoteCommandToWindow: async (windowRef, command) => {
   commands.push(command)
   if (command.type === 'conversation.delete') manager.handleRendererEvent({windowRef, payload: {conversationId: cid, requestId: command.requestId, event: 'conversation.operation.completed', payload: {deleted: true}}})
   if (command.type === 'remote.shutdown') {items.splice(0); manager.handleWindowClosed(windowRef)}
   return {ok: true}
  },
  revealRemoteConversationWindow: () => ({ok: true}), broadcastToDevice() {}
 })
 await manager.deleteConversation({deviceId, requestId: 'delete-orphan-control-fixture', params: {conversationId: cid, confirmed: true}})
 assert.equal(manager.controlledSessions().sessions.length, 0, 'deletion receipt must retire control before window closed')
 assert.equal(manager.openedSessions({deviceId}).sessions.length, 0)
 assert.equal(manager.runtimeSnapshot({deviceId, params: {conversationId: cid}}).control.canWrite, false)
 await assert.rejects(manager.openForMobile({deviceId, params: {conversationId: cid}}), {code: 'remote_conversation_not_found'})
 const recovered = await manager.takeoverOnDesktop({conversationId: cid, confirmed: true})
 assert.equal(recovered.deleted, true)
 assert.ok(commands.some(command => command.type === 'remote.shutdown' && command.conversationDeleted === true))
 assert.equal(items.length, 0)
 await manager.closeAll()
}

// Old orphaned state without a deletion receipt: local read-only evidence heals it.
for (const mode of ['takeover', 'listing', 'shutdown', 'live', 'unknown']) {
 const items = [{id: `legacy-orphan-${mode}`, type: 'window', conversationId: cid, remoteHidden: false, rendererReady: true, mobileControlled: true}]
 const commands = []; let manager
 manager = createRemoteSessionManager({
  getConfig: async () => ({config: {webdav: {localChatPath: 'changed-directory'}}}),
  getConversationDirectory: () => 'original-window-directory',
  conversationExists: async input => {assert.equal(input.dirPath, 'original-window-directory'); if (mode === 'unknown') throw new Error('EACCES'); return mode === 'live'},
  openConversation: async () => {throw new Error('must not reopen')}, listWindows: () => items,
  getWindowByRef: () => ({isDestroyed: () => false}), openWindow: async () => ({ok: false}),
  dispatchRemoteCommandToWindow: async (windowRef, command) => {
   commands.push(command)
   if (command.type === 'remote.shutdown') {
    if (command.conversationDeleted) { items.splice(0); manager.handleWindowClosed(windowRef) }
    else {
     assert.ok(mode === 'live' || mode === 'unknown')
     manager.handleRendererEvent({windowRef, payload: {conversationId: cid, requestId: command.requestId, event: 'conversation.shutdown.result', payload: {ok: mode === 'live'}}})
    }
   }
   return {ok: true}
  }, revealRemoteConversationWindow: () => ({ok: true}), broadcastToDevice() {}
 })
 assert.equal(manager.controlledSessions().sessions.length, 1)
 if (mode === 'shutdown') items[0].remoteHidden = true
 if (mode === 'takeover') {
  const result = await manager.takeoverOnDesktop({conversationId: cid, confirmed: true})
  assert.equal(result.deleted, true)
 } else if (mode === 'shutdown') await manager.closeAll()
 else await manager.reconcileDeletedSessions()
 if (mode === 'live' || mode === 'unknown') {
  assert.equal(items.length, 1, 'live or uncertain storage must never be closed')
  assert.equal(manager.controlledSessions().sessions.length, 1)
  assert.equal(commands.length, 0)
 } else {
  assert.equal(items.length, 0)
  assert.equal(manager.controlledSessions().sessions.length, 0)
  assert.ok(commands.every(command => command.type !== 'conversation.desktop.takeover'))
 }
 if (mode === 'unknown') await assert.rejects(manager.closeAll(), {code: 'remote_conversation_save_failed'})
 else await manager.closeAll()
 if (mode === 'live' || mode === 'unknown') assert.equal(items.length, 1, 'gateway stop cannot destroy a visible writer')
}

console.log(JSON.stringify({ok: true, suite: 'remote-hidden-delete'}))
