import assert from 'node:assert/strict'
import {createConversationMetadataRouter} from '../main/core/conversationMetadataRouter.js'

const input = {dirPath: 'synthetic-directory', conversationId: 'synthetic-conversation', title: 'New title'}
const main = {id: 'main', type: 'main'}
const writer = {id: 'writer', type: 'window', conversationId: input.conversationId, rendererReady: true, leasePending: false, readOnly: false}
const tick = () => new Promise(resolve => setImmediate(resolve))
function fixture({items = [main, {...writer}], timeoutMs = 300, dispatchResult = {ok: true}} = {}) {
  const sent = [], direct = [], updates = []
  const router = createConversationMetadataRouter({
    listWindows: () => items,
    getConversationDirectory: (ref) => items.find(item => item.id === ref)?.directory ?? input.dirPath,
    dispatch: async (ref, payload) => {sent.push({ref, payload}); return dispatchResult},
    rename: async params => {direct.push(params); return {ok: true, ...params, revision: 1}},
    onRenamed: result => updates.push(result), timeoutMs
  })
  return {router, sent, direct, updates, items}
}
const unopened = fixture({items: [main]})
await unopened.router.request('main', {...input, holderInstanceId: 'must-not-be-used', leaseEpoch: 7})
assert.equal(unopened.direct.length, 1)
assert.equal(Object.hasOwn(unopened.direct[0], 'holderInstanceId'), false, 'main cannot borrow another writer identity')
const scopedElsewhere = fixture({items: [main, {...writer, directory: 'other-directory'}]})
await scopedElsewhere.router.request('main', input)
assert.equal(scopedElsewhere.direct.length, 1, 'same conversation ID in another directory cannot receive this rename')
for (const remoteHidden of [false, true]) {
  const f = fixture({items: [main, {...writer, remoteHidden, mobileControlled: remoteHidden}]})
  const pending = f.router.request('main', {...input, projectId: ''})
  let settled = false
  pending.then(() => {settled = true})
  await tick()
  assert.equal(settled, false, 'dispatch success is not rename success')
  assert.equal(f.direct.length, 0)
  const command = f.sent[0].payload
  assert.equal(f.router.check('main', command).ok, false)
  assert.equal(f.router.complete('other-window', {...command, ok: true, result: {...input, revision: 1}}).ok, false)
  assert.equal(f.router.complete('writer', {...command, conversationId: 'wrong', ok: true}).ok, false)
  assert.equal(f.router.complete('writer', {...command, ok: true, result: {...input, title: 'wrong title', revision: 1}}).ok, false)
  assert.equal(f.router.check('writer', command).ok, true)
  assert.equal(f.router.complete('writer', {...command, ok: true, result: {...input, revision: 4}}).ok, true)
  assert.equal((await pending).revision, 4)
  assert.equal(f.updates.length, 1)
  assert.equal(f.router.complete('writer', {...command, ok: true}).ok, false, 'late duplicate reply is rejected')
  assert.equal(f.items[1].mobileControlled, remoteHidden, 'local metadata must not transfer control')
}
for (const state of [{leasePending: true}, {rendererReady: false}, {readOnly: true}, {directory: ''}]) {
  const f = fixture({items: [main, {...writer, ...state}]})
  await assert.rejects(f.router.request('main', input), /conversation_writer_not_ready/)
  assert.equal(f.direct.length, 0)
}
const duplicate = fixture({items: [main, writer, {...writer, id: 'second-writer'}]})
await assert.rejects(duplicate.router.request('main', input), /conversation_writer_not_ready/)
const direct = fixture()
await direct.router.request('writer', {...input, holderInstanceId: 'valid-holder', leaseEpoch: 1, expectedRevision: 3})
assert.equal(direct.direct[0].expectedRevision, 3)
await assert.rejects(direct.router.request('writer', input), /conversation_write_lease_lost/)
await assert.rejects(direct.router.request('writer', {...input, dirPath: 'wrong', holderInstanceId: 'valid', leaseEpoch: 1}), /conversation_metadata_window_mismatch/)
await assert.rejects(direct.router.request('unknown', input), /conversation_local_window_required/)
const dispatchFail = fixture({dispatchResult: {ok: false}})
await assert.rejects(dispatchFail.router.request('main', input), /conversation_metadata_dispatch_failed/)
const timeout = fixture({timeoutMs: 15})
await assert.rejects(timeout.router.request('main', input), /conversation_metadata_result_timeout/)
assert.equal(timeout.router.check('writer', timeout.sent[0].payload).ok, false, 'expired queued work cannot start')
assert.equal(timeout.direct.length, 0, 'unknown completion cannot fall back to direct mutation or replay')
const failure = fixture()
const result = failure.router.request('main', input)
const rejected = assert.rejects(result, /conversation_write_lease_lost/)
await tick()
failure.items[1].readOnly = true
assert.equal(failure.router.complete('writer', {...failure.sent[0].payload, ok: false, code: 'conversation_write_lease_lost'}).ok, true, 'failed writer can still report loss')
await rejected
const closedWhileWaiting = fixture({timeoutMs: 20})
const closingRequest = closedWhileWaiting.router.request('main', input)
const closingRejected = assert.rejects(closingRequest, /conversation_metadata_result_timeout/)
await tick()
closedWhileWaiting.items.splice(1)
assert.equal(closedWhileWaiting.router.check('writer', closedWhileWaiting.sent[0].payload).ok, false)
await closingRejected
assert.equal(closedWhileWaiting.direct.length, 0, 'closed target cannot cause an unsafe fallback write')


console.log(JSON.stringify({ok: true, suite: 'conversation-metadata-router', hiddenVisible: true, authenticatedReceipts: true, noReplay: true, directoryIsolation: true}))
