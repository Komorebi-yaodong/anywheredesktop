import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import contract from '../packages/remote-contract/index.cjs'
import {createBusinessProtocol} from '../main/core/remote/businessProtocol.js'

const frozen = JSON.parse(await fs.readFile(new URL('../packages/remote-contract/fixtures/v1.0-view.json', import.meta.url), 'utf8'))
const CID = frozen.runtime.conversationId
const A = {device: {deviceId: 'device-contract-fixture-a'}}
const B = {device: {deviceId: 'device-contract-fixture-b'}}
let duringRead = () => {}
const service = createBusinessProtocol({
  readService: {async listMessages() {duringRead(); return structuredClone(frozen.page)}},
  getManager: () => ({runtimeSnapshot: () => structuredClone(frozen.runtime), getRequest: ({params}) => ({
    requestId: params.requestId, conversationId: CID, event: 'assistant.completed', terminal: true,
    eventSequence: 4, text: '', reasoning: '', toolCalls: [], truncated: false
  })})
})
await assert.rejects(service.view(A, {conversationId: CID}), {code: 'remote_contract_negotiation_required'})
assert.throws(() => service.negotiate(A, {versions: [{major: 99, minor: 0}]}), {code: 'remote_contract_version_unsupported'})
assert.equal(service.negotiate(A, {versions: [{major: 1, minor: 9}]}).selected.minor, 1)
service.negotiate(B, {versions: [{major: 1, minor: 0}]})
const first = await service.view(A, {conversationId: CID})
assert.equal(first.runtime.control.canWrite, false)
assert.equal(service.changes(A, {conversationId: CID, cursor: first.cursor}).events.length, 0)
duringRead = () => service.notify('assistant.completed', {conversationId: CID, text: 'PRIVATE_NOT_IN_JOURNAL'}, A.device.deviceId)
const race = await service.view(A, {conversationId: CID})
const catchup = service.changes(A, {conversationId: CID, cursor: race.cursor})
assert.equal(catchup.events.length, 1, 'change during snapshot must not be lost')
assert.equal(JSON.stringify(catchup).includes('PRIVATE'), false)
assert.equal(service.changes(B, {conversationId: CID, cursor: race.cursor}).events.length, 0, 'private operation invalidation must be device scoped')
assert.equal(service.changes(A, {conversationId: CID, cursor: 'other-epoch:0'}).resyncRequired, true)
for (let i = 0; i < 520; i++) service.notify('conversation.windows.changed', {})
assert.equal(service.changes(A, {conversationId: CID, cursor: first.cursor}).resyncRequired, true)
assert.throws(() => service.changes(A, {conversationId: CID, cursor: catchup.cursor, path: 'FORBIDDEN'}), {code: 'remote_parameter_unknown'})
assert.equal(service.operation(A, {operationId: 'operation-fixture-0001'}).state, 'succeeded')
contract.validateView({...frozen, futureOptional: {feature: 'ignored'}})
assert.throws(() => contract.validateView({...frozen, runtime: {...frozen.runtime, execution: {state: 'future_unsafe'}}}), {code: 'remote_contract_invalid'})
assert.throws(() => contract.validateRuntime({...frozen.runtime, control: {owner: 'desktop', canWrite: true}}), {code: 'remote_contract_invalid'})
// A standalone checkout must pass without the other application installed.
const manifest = JSON.parse(await fs.readFile(new URL('../packages/remote-contract/integrity.json', import.meta.url), 'utf8'))
const {createHash} = await import('node:crypto')
for (const [file, expected] of Object.entries(manifest.files)) {
  const own = await fs.readFile(new URL(`../packages/remote-contract/${file}`, import.meta.url))
  assert.equal(createHash('sha256').update(own).digest('hex'), expected, `contract release drift: ${file}`)
}
const legacy = await fs.readFile(new URL('./compat/legacy-v2-consumer.mjs', import.meta.url))
const legacyHash = (await fs.readFile(new URL('./compat/legacy-v2-consumer.sha256', import.meta.url), 'utf8')).trim()
assert.equal(createHash('sha256').update(legacy).digest('hex'), legacyHash, 'frozen legacy consumer must not drift')

console.log(JSON.stringify({ok: true, suite: 'remote-business-protocol', contractVersion: '1.1'}))
