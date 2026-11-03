import assert from 'node:assert/strict'
import {createOperationJournal} from '../main/core/remote/operationJournal.js'
import contract from '../packages/remote-contract/index.cjs'
const {validateDurableOperation} = contract

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
const accepted = {...input, commandId: 'command-accepted-fixture'}
let releaseAccepted
const blockedDispatch = () => new Promise(resolve => {releaseAccepted = () => resolve({conversationId: input.params.conversationId, ok: true})})
const immediatelyAccepted = await journal.execute(accepted, blockedDispatch, true)
assert.equal(immediatelyAccepted.state, 'accepted', 'async operations return after durable admission, not Renderer completion')
assert.equal((await journal.get(input.deviceId, accepted.commandId)).state, 'accepted')
const acceptedDuplicate = await journal.execute(accepted, async () => {throw new Error('must not redispatch')}, true)
assert.equal(acceptedDuplicate.state, 'accepted')
releaseAccepted()
await new Promise(resolve => setImmediate(resolve))
assert.equal((await journal.get(input.deviceId, accepted.commandId)).state, 'running')

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
assert.equal(completed.state, 'accepted', 'async admission returns before Renderer terminal state')
await new Promise(resolve => setImmediate(resolve))
assert.equal((await journal.get(input.deviceId, early.commandId)).state, 'succeeded', 'early terminal must not regress to running')
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
// Early admission must not release the actual same-conversation execution lane.
{
 const ordered = createOperationJournal({load: async () => null, save: async () => {}, now: () => clock})
 const sequence = [], releases = []
 const base = {...input, issuedAt: clock}
 const first = await ordered.execute({...base, commandId: 'ordered-first'}, async () => {sequence.push('first');await new Promise(resolve => releases.push(resolve));return {ok: true}}, true)
 const second = await ordered.execute({...base, commandId: 'ordered-second'}, async () => {sequence.push('second');return {ok: true}}, true)
 assert.equal(first.state, 'accepted');assert.equal(second.state, 'accepted');assert.deepEqual(sequence, ['first'])
 await ordered.execute({...base, commandId: 'ordered-interrupt', method: 'conversation.cancel'}, async () => {sequence.push('cancel');return {ok: true}})
 assert.deepEqual(sequence, ['first', 'cancel'])
 const foreign = await ordered.execute({...base, commandId: 'ordered-other', params: {conversationId: 'other-conversation'}}, async () => {sequence.push('other');return {ok: true}}, false)
 assert.equal(foreign.terminal, true)
 releases[0]()
 while (!(await ordered.get(base.deviceId, 'ordered-second')).receipt) await new Promise(resolve => setImmediate(resolve))
 assert.deepEqual(sequence, ['first', 'cancel', 'other', 'second'])
 // Existing operation IDs are queried, not revalidated/replayed as new writes.
 const duplicate = await ordered.execute({...base, commandId: 'ordered-first'}, () => {throw new Error('replayed')}, true, {admit: () => {throw new Error('stale epoch must not hide old result')}})
 assert.equal(duplicate.operationId, 'ordered-first')
}


// A dispatch failure after an earlier pending query cannot expose stale
// nonterminal progress under a terminal operation (strict Mobile validation).
{
 const j = createOperationJournal({load: async () => null, save: async () => {}})
 const issuedAt = Date.now(), deviceId = 'device-failed-query-fixture', commandId = 'command-failed-query-fixture'
 let reject
 await j.execute({deviceId, commandId, issuedAt, method: 'conversation.create', params: {}}, () => new Promise((_, no) => {reject = no}), true)
 await j.update(deviceId, commandId, {requestId: commandId, conversationId: '', terminal: false, event: 'conversation.command.pending'})
 reject(Object.assign(new Error('failed'), {code: 'remote_conversation_busy'}))
 await new Promise(resolve => setImmediate(resolve))
 const failed = validateDurableOperation(await j.get(deviceId, commandId))
 assert.equal(failed.state, 'failed'); assert.equal(failed.progress, null)
}


// Creation has no conversation identity until Renderer has saved it. The
// actual Mobile contract must accept the very first pending status too.
{
 const j = createOperationJournal({load: async () => null, save: async () => {}})
 const issuedAt = Date.now(), deviceId = 'device-create-query-fixture', commandId = 'command-create-query-fixture'
 let release
 await j.execute({deviceId, commandId, issuedAt, method: 'conversation.create', params: {promptCode: 'Code'}}, () => new Promise(resolve => {release = resolve}), true)
 await j.update(deviceId, commandId, {requestId: commandId, conversationId: '', terminal: false, event: 'conversation.command.pending', eventSequence: 0})
 const pending = validateDurableOperation(await j.get(deviceId, commandId))
 assert.equal(pending.conversationId, null); assert.equal(pending.progress.conversationId, null)
 const conversationId = 'conversation-new-query-fixture'
 release({conversationId, title: 'New'})
 await new Promise(resolve => setImmediate(resolve))
 validateDurableOperation(await j.get(deviceId, commandId))
 await j.update(deviceId, commandId, {requestId: commandId, conversationId, terminal: true, event: 'conversation.operation.completed', result: {conversationId, title: 'New'}})
 const completed = validateDurableOperation(await j.get(deviceId, commandId))
 assert.equal(completed.progress.result.conversationId, conversationId)
}


clock += 8 * 86400000
await largeRestored.execute({...input, issuedAt: clock, commandId: 'capacity-after-retention'}, capacityDispatch)
await assert.rejects(largeRestored.execute(nextInput, capacityDispatch), {code: 'remote_command_expired'})
assert.equal(capacityDisk.records.length, 1, 'retention still cleans old history without a count-based quota')
assert.equal(capacityCalls, 20)


clock += 8 * 86400000
await assert.rejects(journal.get(input.deviceId, input.commandId), {code: 'remote_operation_not_found'})
console.log(JSON.stringify({ok: true, suite: 'remote-operation-journal'}))
