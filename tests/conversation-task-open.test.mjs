import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import vm from 'node:vm'

const source = await fs.readFile(new URL('../main/windowManager.js', import.meta.url), 'utf8')
const start = source.indexOf('export async function runTaskInConversation(')
let block = source.slice(start, source.indexOf('export async function openWindow(', start)).replace('export ', '')
block = block.replace("const api = await import('./core/conversationStore.js')", 'const api = fixtureApi')
let ready = false, deliveries = 0, opens = 0
const context = {fixtureApi: {openConversation: async input => {
  assert.equal(input.reference, 'target');
  return {descriptor: {conversationId: 'target'}, sessionData: {CODE: 'Code'}}
}}, openWindow: async (type, payload) => {opens++; assert.equal(type, 'window'); assert.equal(payload.type, 'conversation'); assert.equal(payload.preserveExistingVisibility, true); return {ok: true, id: 'writer', reused: true}},
  waitForWindowReady: async () => true, Date,
  windowMetadataStore: {get: () => ({rendererReady: ready})}, getWindowByRef: () => ({}),
  setTimeout: fn => {ready = true; fn()},
  conversationTaskDelivery: {deliver: async (id, input) => {deliveries++; assert.equal(ready, true); assert.equal(id, 'writer'); assert.equal(input.taskConfig.id, 'task'); return {ok: true}}}}
const run = vm.runInNewContext(`${block}; runTaskInConversation`, context)
assert.equal((await run({dirPath: 'fixture', conversationId: 'target', taskConfig: {id: 'task'}, payload: 'instruction'})).ok, true)
assert.equal(opens, 1); assert.equal(deliveries, 1)
context.fixtureApi.openConversation = async () => {throw Error('conversation_not_found')}
await assert.rejects(run({dirPath: 'fixture', conversationId: 'target'}), /conversation_not_found/)
assert.equal(opens, 1, 'missing target never silently creates a replacement')
console.log('PASS task opens/reuses target, waits Renderer readiness before delivering, rejects missing target')
