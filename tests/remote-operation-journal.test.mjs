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
// Incremental adapters preserve the same prewrite/postwrite failure barriers.
let deltaWrites = 0, deltaCalls = 0, failDeltaAt = 1
const deltaDisk = new Map()
const incremental = createOperationJournal({load: async () => null, now: () => clock,
 saveChanges: async ({puts, removes}) => {
  deltaWrites++
  if (deltaWrites === failDeltaAt) throw new Error('synthetic delta write failure')
  for (const id of removes) deltaDisk.delete(id)
  for (const record of puts) deltaDisk.set(`${record.deviceId}:${record.commandId}`, clone(record))
 }})
const deltaInput = {...input, commandId: 'command-incremental-failure-fixture'}
await assert.rejects(incremental.execute(deltaInput, async () => {deltaCalls++; return {ok: true}}), {code: 'remote_operation_storage_failed'})
assert.equal(deltaCalls, 0)
failDeltaAt = 3
await assert.rejects(incremental.execute(deltaInput, async () => {deltaCalls++; return {ok: true}}), {code: 'remote_operation_storage_failed'})
assert.equal(deltaCalls, 1)
failDeltaAt = -1
await incremental.execute(deltaInput, async () => {deltaCalls++; return {ok: true}})
assert.equal(deltaCalls, 1, 'failed postwrite retries storage only, never dispatch')
assert.equal(deltaDisk.get(`${input.deviceId}:${deltaInput.commandId}`).terminal, true)


// Historical records are dedupe state, not a cumulative usage quota.
const seedRecord = clone(disk.records.find(record => record.commandId === input.commandId))
let capacityDisk = {version: 1, records: Array.from({length: 512}, (_, index) => ({...clone(seedRecord), commandId: `capacity-${index}`}))}
const capacityOptions = {load: async () => clone(capacityDisk), save: async value => {capacityDisk = clone(value)}, now: () => clock}
const full = createOperationJournal(capacityOptions)
let capacityCalls = 0
const capacityDispatch = async () => {capacityCalls++; return {ok: true}}
const nextInput = {...input, commandId: 'capacity-beyond-512'}
assert.equal((await full.execute(nextInput, capacityDispatch)).state, 'succeeded')
assert.equal(capacityDisk.records.length, 513)
await Promise.all(Array.from({length: 16}, (_, index) => full.execute({...input, commandId: `capacity-concurrent-${index}`}, capacityDispatch)))
assert.equal(capacityDisk.records.length, 529, 'concurrent new commands remain accepted after the old cap')
assert.equal(capacityCalls, 17)
assert.ok(capacityDisk.records.some(record => record.commandId === 'capacity-0'), 'old valid dedupe IDs are not evicted to accept new work')
await full.execute({...input, commandId: 'capacity-0'}, capacityDispatch)
const capacityRestored = createOperationJournal(capacityOptions)
await capacityRestored.execute(nextInput, capacityDispatch)
await capacityRestored.execute({...input, commandId: 'capacity-0'}, capacityDispatch)
assert.equal(capacityCalls, 17, 'both old and new IDs still dedupe after restart above the old cap')
await assert.rejects(capacityRestored.execute({...nextInput, params: {...input.params, title: 'changed'}}, capacityDispatch), {code: 'remote_command_id_conflict'})
await capacityRestored.execute({...input, commandId: 'capacity-after-restart'}, capacityDispatch)
assert.equal(capacityDisk.records.length, 530)
assert.equal(capacityCalls, 18)
// A substantially larger retained journal must not introduce a replacement quota.
capacityDisk.records.push(...Array.from({length: 4096}, (_, index) => ({...clone(seedRecord), commandId: `capacity-large-${index}`})))
const largeRestored = createOperationJournal(capacityOptions)
await largeRestored.execute({...input, commandId: 'capacity-large-new'}, capacityDispatch)
assert.equal(capacityDisk.records.length, 4627)
assert.equal(capacityCalls, 19)
await largeRestored.execute({...input, commandId: 'capacity-large-0'}, capacityDispatch)
assert.equal(capacityCalls, 19)
assert.equal(Object.hasOwn(largeRestored.limits, 'maxRecords'), false)
clock += 8 * 86400000
await largeRestored.execute({...input, issuedAt: clock, commandId: 'capacity-after-retention'}, capacityDispatch)
await assert.rejects(largeRestored.execute(nextInput, capacityDispatch), {code: 'remote_command_expired'})
assert.equal(capacityDisk.records.length, 1, 'retention still cleans old history without a count-based quota')
assert.equal(capacityCalls, 20)


clock += 8 * 86400000
await assert.rejects(journal.get(input.deviceId, input.commandId), {code: 'remote_operation_not_found'})
console.log(JSON.stringify({ok: true, suite: 'remote-operation-journal'}))
