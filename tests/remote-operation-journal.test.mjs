import assert from 'node:assert/strict'
import {createOperationJournal} from '../main/core/remote/operationJournal.js'
const clone = value => structuredClone(value)
let disk = null
let clock = 1800000000000
const options = {load: async () => clone(disk), save: async value => {disk = clone(value)}, now: () => clock}
const journal = createOperationJournal(options)
const input = {deviceId: 'device-journal-fixture', commandId: 'command-journal-fixture', issuedAt: clock, method: 'conversation.rename', params: {conversationId: 'conversation-journal-fixture', title: 'safe synthetic'}}
let calls = 0
const dispatch = async () => {calls++; assert.ok(disk.records.some(item => item.commandId === input.commandId), 'must persist before dispatch'); return {ok: true}}
const [one, two] = await Promise.all([journal.execute(input, dispatch), journal.execute(input, dispatch)])
assert.equal(calls, 1)
assert.equal(one.state, 'succeeded')
assert.equal(two.operationId, input.commandId)
await assert.rejects(journal.execute({...input, params: {...input.params, title: 'changed'}}, dispatch), {code: 'remote_command_id_conflict'})
assert.equal(JSON.stringify(disk).includes('safe synthetic'), false, 'raw parameters must not be persisted')
const restored = createOperationJournal(options)
assert.equal((await restored.get(input.deviceId, input.commandId)).state, 'succeeded')
await restored.execute(input, dispatch)
assert.equal(calls, 1, 'restart duplicate cannot redispatch')
await assert.rejects(restored.get('another-device-fixture', input.commandId), {code: 'remote_operation_not_found'})
const active = {...input, commandId: 'command-running-fixture'}
await journal.execute(active, dispatch, true)
assert.equal((await createOperationJournal(options).get(input.deviceId, active.commandId)).state, 'interrupted')
const failure = createOperationJournal({load: async () => null, save: async () => {throw new Error('synthetic disk failure')}, now: () => clock})
await assert.rejects(failure.execute({...input, commandId: 'command-failed-write'}, dispatch))
assert.equal(calls, 2, 'failed prewrite cannot dispatch')
await assert.rejects(journal.execute({...input, commandId: 'command-expired-fixture', issuedAt: clock - 25 * 3600000}, dispatch), {code: 'remote_command_expired'})
const early = {...input, commandId: 'command-early-terminal'}
const completed = await journal.execute(early, async () => {
  await journal.update(input.deviceId, early.commandId, {requestId: early.commandId, conversationId: input.params.conversationId, event: 'conversation.operation.completed', terminal: true, eventSequence: 1, text: '', reasoning: '', result: {ok: true}})
  return {ok: true}
}, true)
assert.equal(completed.state, 'succeeded', 'early terminal must not regress to running')
// A post-dispatch durability failure is uncertain, never safe to rerun.
let failNextSave = false, uncertainDisk = null, uncertainCalls = 0
const uncertain = createOperationJournal({load: async () => uncertainDisk, save: async value => {if (failNextSave) throw new Error('disk unavailable'); uncertainDisk = clone(value)}, now: () => clock})
const uncertainInput = {...input, commandId: 'command-postwrite-failure'}
await assert.rejects(uncertain.execute(uncertainInput, async () => {uncertainCalls++; failNextSave = true; return {ok: true}}), {code: 'remote_operation_storage_failed'})
failNextSave = false
await uncertain.execute(uncertainInput, async () => {uncertainCalls++; return {ok: true}})
assert.equal(uncertainCalls, 1)
const fullDisk = {version: 1, records: Array.from({length: 512}, (_, index) => ({deviceId: input.deviceId, commandId: `capacity-${index}`, acceptedAt: clock, fingerprint: 'fixture', state: 'succeeded', terminal: true}))}
const full = createOperationJournal({load: async () => clone(fullDisk), save: async () => {}, now: () => clock})
await assert.rejects(full.execute({...input, commandId: 'capacity-overflow-fixture'}, dispatch), {code: 'remote_operation_limit_reached'})
assert.equal(fullDisk.records.length, 512, 'valid dedupe records are not evicted')


clock += 8 * 86400000
await assert.rejects(journal.get(input.deviceId, input.commandId), {code: 'remote_operation_not_found'})
console.log(JSON.stringify({ok: true, suite: 'remote-operation-journal'}))
