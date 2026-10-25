import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import contract from '../packages/remote-contract/index.cjs'
import oldContract from '../packages/remote-contract-v1/index.cjs'
import {createBusinessProtocol} from '../main/core/remote/businessProtocol.js'
import {createOperationJournal} from '../main/core/remote/operationJournal.js'
import {messageBlocks} from '../main/core/remote/contentBlocks.js'
const frozen = JSON.parse(await fs.readFile(new URL('../packages/remote-contract/fixtures/v1.0-view.json', import.meta.url)))
const routes = contract.routes
let saved = null
const operations = createOperationJournal({load: async () => structuredClone(saved), save: async data => {saved = structuredClone(data)}})
let epoch = 'control-fixture-1'
let calls = 0
const manager = {runtimeSnapshot: () => ({...structuredClone(frozen.runtime), control: {owner: 'this_device', canWrite: true, epoch}}), withCommandGuard: (guard, action) => {guard(); return action()}, getRequest: () => {throw Object.assign(new Error('missing'), {code: 'remote_request_not_found'})}}
const service = createBusinessProtocol({readService: {listMessages: async () => structuredClone(frozen.page)}, getManager: () => manager, operations,
  dispatch: async (_context, _id, method) => {calls++; return method === 'conversation.messages.list' ? structuredClone(frozen.page) : {ok: true}}})
const A = {device: {deviceId: 'device-resource-fixture'}, capabilities: [...routes.queries, ...routes.commands, ...routes.transfers]}
const OLD = {device: {deviceId: A.device.deviceId}, capabilities: A.capabilities}
service.negotiate(OLD, {versions: [{major: 1, minor: 0}]})
oldContract.validateView(await service.view(OLD, {conversationId: frozen.runtime.conversationId}))
assert.equal(service.negotiate(A, {versions: [{major: 1, minor: 1}]}).selected.minor, 1)
const view = await service.view(A, {conversationId: frozen.runtime.conversationId})
assert.equal(Object.hasOwn(view.page.messages[0].payload, 'content'), false)
assert.equal(view.page.messages[0].payload.blocks[0].kind, 'markdown')
const resource = await service.resource(A, 'request-resource', {resource: 'conversation.messages.list', params: {conversationId: frozen.runtime.conversationId}})
contract.validateResource(resource, 'conversation.messages.list')
assert.ok(resource.value.messages[0].payload.blocks)
await assert.rejects(service.resource(A, 'request-resource', {resource: 'business.config.get'}), {code: 'remote_resource_unsupported'})
await assert.rejects(service.resource(OLD, 'request-resource', {resource: 'conversation.list'}), {code: 'remote_resource_unsupported'})
const issuedAt = Date.now()
const command = {commandId: `command-${issuedAt}-durable-command-fixture`, issuedAt, method: 'workspace.project.create', params: {name: 'Synthetic'}}
const before = calls
contract.validateDurableOperation(await service.command(A, command))
await service.command(A, command)
assert.equal(calls, before + 1)
await assert.rejects(service.command(A, {...command, params: {name: 'different'}}), {code: 'remote_command_id_conflict'})
const stale = await service.command(A, {...command, commandId: `command-${issuedAt}-stale-command-fixture`, method: 'conversation.rename', params: {conversationId: frozen.runtime.conversationId, title: 'Synthetic'}, preconditions: {controlEpoch: 'stale'}})
assert.equal(stale.code, 'remote_control_epoch_conflict')
assert.equal(calls, before + 1)
await service.transfer(A, 'request-transfer', {method: 'attachment.abort', params: {uploadId: 'synthetic-upload'}})
assert.equal(calls, before + 2)
// Batch status is an additive capability, not a frozen-contract change.
const batch = await service.operationStatuses(A, {operationIds: [command.commandId, 'command-missing-fixture']})
assert.equal(batch.items[0].terminal, true)
assert.equal(batch.items[0].state, 'succeeded')
assert.equal(Object.hasOwn(batch.items[0], 'progress'), false)
assert.equal(Object.hasOwn(batch.items[0], 'receipt'), false)
assert.equal(batch.items[1].error, 'remote_operation_not_found')
await assert.rejects(service.operationStatuses(A, {operationIds: Array.from({length: 65}, (_, i) => `command-batch-${i}`)}), {code: 'remote_parameter_invalid'})
await assert.rejects(service.operationStatuses(A, {operationIds: [command.commandId, command.commandId]}), {code: 'remote_parameter_invalid'})
const foreign = {device: {deviceId: 'device-resource-foreign'}, capabilities: A.capabilities}
service.negotiate(foreign, {versions: [{major: 1, minor: 1}]})
assert.equal((await service.operationStatuses(foreign, {operationIds: [command.commandId]})).items[0].error, 'remote_operation_not_found')

const blocks = messageBlocks([{type: 'text', text: 'visible'}, {type: 'image', url: 'https://safe.example/image.png'}, {type: 'file', name: 'file.txt', content: 'SECRET'}, {type: 'image', url: 'file:///PRIVATE'}, {type: 'future', secret: 'SECRET'}])
assert.deepEqual(blocks.map(item => item.kind), ['markdown', 'image', 'file', 'file', 'notice'])
assert.equal(JSON.stringify(blocks).includes('PRIVATE'), false)
assert.equal(JSON.stringify(blocks).includes('SECRET'), false)
for (const base of ['remote-contract', 'remote-contract-v1']) {
 const root = new URL(`../packages/${base}/`, import.meta.url)
 const manifest = JSON.parse(await fs.readFile(new URL('integrity.json', root)))
 const {createHash} = await import('node:crypto')
 for (const [file, expected] of Object.entries(manifest.files)) assert.equal(createHash('sha256').update(await fs.readFile(new URL(file, root))).digest('hex'), expected)
}
console.log(JSON.stringify({ok: true, suite: 'remote-resource-contract', historical: '1.0->1.1'}))
