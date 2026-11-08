import assert from 'node:assert/strict'
import {createConversationTaskDelivery} from '../main/core/conversationTaskDelivery.js'
import {runTaskById} from '../main/core/task_runner.js'
import {getCurrentTaskDevice} from '../main/core/task_devices.js'

let sent
const delivery = createConversationTaskDelivery({timeoutMs: 30, send: async (windowId, input) => {sent = {windowId, input}; return {ok: true}}})
const pending = delivery.deliver('window-a', {conversationId: 'conversation-a'})
assert.equal(delivery.complete('other-window', {...sent.input, ok: true}).ok, false)
assert.equal(delivery.complete('window-a', {...sent.input, conversationId: 'other', ok: true}).ok, false)
assert.equal(delivery.complete('window-a', {...sent.input, ok: true}).ok, true)
assert.equal((await pending).ok, true)
assert.equal(delivery.complete('window-a', {...sent.input, ok: true}).ok, false)
assert.equal((await delivery.deliver('window-a', {conversationId: 'conversation-a'})).reason, 'task_receipt_timeout')

const task = {promptKey: '', conversationId: 'conversation-a', description: 'synthetic instruction', appliedDevices: [getCurrentTaskDevice()]}
const config = {tasks: {fixture: task}, webdav: {localChatPath: 'synthetic-dir'}}
let runs = 0
const args = {taskId: 'fixture', dataApi: {getConfig: async () => ({config})}, openWindow: async () => {throw new Error('must not create assistant window')}, runConversation: async input => {runs++; assert.equal(input.conversationId, 'conversation-a'); return {ok: true, id: 'window-a'}}}
assert.equal((await runTaskById(args)).success, true)
assert.equal(runs, 1)
task.promptKey = '__DEFAULT__'
assert.equal((await runTaskById(args)).reason, 'task_target_conflict')
task.promptKey = ''; config.webdav.localChatPath = ''
assert.equal((await runTaskById(args)).reason, 'task_local_storage_required')
assert.equal(runs, 1)

console.log('PASS conversation task receipts/window binding/expiry/exclusive target/storage gate')
