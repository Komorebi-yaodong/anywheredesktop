import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import {DatabaseSync} from 'node:sqlite'
import {recoverMissingToolProjection} from '../packages/conversation-core/toolProjection.js'
import * as store from '../main/core/conversationStore.js'

const user = {role: 'user', storageId: 'user', content: 'synthetic user'}
const call = {role: 'assistant', storageId: 'call-row', content: null, reasoning_content: 'synthetic thought', tool_calls: [{id: 'call-1', type: 'function', function: {name: 'synthetic_tool', arguments: '{"text":"$&"}'}}]}
const result = {role: 'tool', storageId: 'result-row', tool_call_id: 'call-1', name: 'synthetic_tool', content: 'synthetic result'}
const answer = {role: 'assistant', storageId: 'answer', content: 'synthetic final'}
const ui = [user, answer].map((m, i) => ({...m, id: i + 1, uiStorageId: `ui-${m.storageId}`}))
const history = [user, call, result, answer]
const canonicalBefore = JSON.stringify(history)
const recovered = recoverMissingToolProjection(history, ui)
assert.equal(recovered.recovered, 1)
assert.equal(recovered.messages[1].storageId, call.storageId)
assert.equal(recovered.messages[1].tool_calls[0].result, result.content)
assert.equal(recovered.messages[1].tool_calls[0].args, '{"text":"$&"}')
assert.equal(JSON.stringify(history), canonicalBefore)
assert.equal(recoverMissingToolProjection(history, recovered.messages).recovered, 0)
assert.equal(new Set(recovered.messages.map(m => m.id)).size, recovered.messages.length)
assert.equal(recoverMissingToolProjection([{...call, storageId: undefined}], ui).recovered, 0)
assert.equal(recoverMissingToolProjection([user, call, {...call}, answer], ui).recovered, 0, 'ambiguous canonical identity is not inferred')
assert.equal(recoverMissingToolProjection(history, [{...ui[0], tool_calls: [{id: 'call-1'}]}, ui[1]]).recovered, 0, 'already displayed call IDs do not duplicate')
assert.equal(recoverMissingToolProjection(history, []).recovered, 0, 'no positional guessing without a canonical UI anchor')
assert.equal(recoverMissingToolProjection([user, {...call, tool_calls: [{id: 'call-1'}, {id: 'call-1'}]}, answer], ui).recovered, 0)

const error = {role: 'assistant', storageId: 'error', content: [{type: 'text', text: '> **错误信息**：synthetic failure'}]}
const mixedUi = [ui[0], {...error, id: 3, uiStorageId: 'ui-error', tool_calls: [{id: 'call-1', name: 'synthetic_tool', result: result.content}]}]
const separated = recoverMissingToolProjection([user, call, result, error], mixedUi)
assert.equal(separated.recovered, 1)
assert.equal(separated.separated, 1)
assert.equal(separated.messages.at(-1).tool_calls.length, 0)
assert.equal(recoverMissingToolProjection([user, call, result, error], [ui[0], {...mixedUi[1], tool_calls: [{id: 'wrong-call'}]}]).separated, 0)

const root = await fs.mkdtemp(path.join(os.tmpdir(), 'anywhere-tool-projection-'))
try {
  for (const mixed of [false, true]) {
    const fullHistory = mixed ? [user, call, result, error] : history
    const chatShow = mixed ? mixedUi : ui
    const created = await store.createConversation({dirPath: root, title: 'synthetic projection recovery', sessionData: {fullHistory, chat_show: chatShow}})
    const conversationId = created.descriptor.conversationId
    const beforeDb = new DatabaseSync(created.databasePath, {readOnly: true})
    const rowsBefore = beforeDb.prepare('SELECT * FROM messages ORDER BY ordinal').all()
    beforeDb.close()
    const holderInstanceId = `synthetic-recovery-${mixed}`
    const lease = await store.acquireWriteLease({dirPath: root, conversationId, holderInstanceId, holderApp: 'test'})
    await assert.rejects(store.repairConversationUiLinks({dirPath: root, conversationId, holderInstanceId: 'other', leaseEpoch: lease.leaseEpoch, expectedRevision: 0}), /conversation_write_lease_lost/)
    const repaired = await store.repairConversationUiLinks({dirPath: root, conversationId, holderInstanceId, leaseEpoch: lease.leaseEpoch, expectedRevision: 0})
    assert.equal(repaired.backupCreated, true)
    assert.equal(repaired.changed, mixed ? 2 : 1)
    const afterDb = new DatabaseSync(created.databasePath, {readOnly: true})
    assert.deepEqual(afterDb.prepare('SELECT * FROM messages ORDER BY ordinal').all(), rowsBefore, 'repair cannot change canonical messages/results')
    afterDb.close()
    const opened = await store.openConversation({dirPath: root, reference: conversationId, pageSize: 200})
    assert.deepEqual(opened.sessionData.chat_show.map(m => m.storageId), ['user', 'call-row', mixed ? 'error' : 'answer'])
    assert.equal(opened.sessionData.chat_show[1].tool_calls[0].result, result.content)
    const remote = await store.loadRemoteConversationPage({dirPath: root, conversationId})
    assert.equal(remote.messages[1].payload.toolCalls[0].id, 'call-1')
    assert.equal(remote.messages[1].payload.toolCalls[0].result, result.content)
    assert.equal(remote.messages[1].uiMessageId, opened.sessionData.chat_show[1].uiStorageId)
    const tail = await store.loadRemoteConversationPage({dirPath: root, conversationId, pageSize: 1})
    const older = await store.loadRemoteConversationPage({dirPath: root, conversationId, pageSize: 1, beforeUiOrder: tail.page.nextBeforeUiOrder})
    assert.equal(older.messages[0].payload.toolCalls[0].id, 'call-1', 'recovered card participates in real remote pagination')
    assert.equal((await store.openConversation({dirPath: root, reference: conversationId, pageSize: 1})).sessionData.conversationStorage.isPaged, true)


    const noOp = await store.repairConversationUiLinks({dirPath: root, conversationId, holderInstanceId, leaseEpoch: lease.leaseEpoch, expectedRevision: repaired.revision})
    assert.equal(noOp.changed, 0)
    assert.equal(noOp.backupCreated, false)
    await store.saveConversationSnapshot({dirPath: root, conversationId, holderInstanceId, leaseEpoch: lease.leaseEpoch, expectedRevision: repaired.revision, sessionData: opened.sessionData})
    const reopened = await store.openConversation({dirPath: root, reference: conversationId, pageSize: 0})
    assert.equal(reopened.sessionData.chat_show.filter(m => m.tool_calls?.length).length, 1)
    await store.releaseWriteLease({dirPath: root, conversationId, holderInstanceId, leaseEpoch: lease.leaseEpoch})
  }
} finally {await fs.rm(root, {recursive: true, force: true})}
console.log(JSON.stringify({ok: true, suite: 'conversation-tool-projection', repairedShapes: 2, canonicalUnchanged: true, backupLeaseRemotePaging: true}))
