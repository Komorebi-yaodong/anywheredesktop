import assert from 'node:assert/strict'
import {createRemoteSessionManager} from '../main/core/remote/sessionManager.js'
import {createBusinessProtocol} from '../main/core/remote/businessProtocol.js'
import {createOperationJournal} from '../main/core/remote/operationJournal.js'
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
console.log(JSON.stringify({ok: true, suite: 'remote-hidden-delete'}))
