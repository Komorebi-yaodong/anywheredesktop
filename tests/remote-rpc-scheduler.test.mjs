import assert from 'node:assert/strict'
import {createRpcScheduler} from '../main/core/remote/rpcScheduler.js'
import {createAuditQueue} from '../main/core/remote/auditQueue.js'
const deferred = () => {let resolve; const promise = new Promise(yes => {resolve = yes}); return {promise, resolve}}
const tick = () => new Promise(resolve => setImmediate(resolve))
const scheduler = createRpcScheduler(), blocked = deferred(), started = []
const request = (method, conversationId = 'conversation-a') => ({method: 'command.submit', params: {method, params: {conversationId}}})
const first = scheduler.schedule(request('conversation.send'), async () => {started.push('first'); await blocked.promise})
const next = scheduler.schedule(request('conversation.message.delete'), async () => started.push('second'))
await scheduler.schedule({method: 'remote.ping'}, async () => started.push('ping'))
await scheduler.schedule({method: 'resource.get'}, async () => started.push('read'))
await scheduler.schedule({method: 'transfer.request'}, async () => started.push('upload'))
await scheduler.schedule(request('conversation.cancel'), async () => started.push('cancel'))
await scheduler.schedule(request('conversation.message.delete', 'conversation-b'), async () => started.push('other'))
assert.ok(!started.includes('second'))
assert.ok(['ping', 'read', 'upload', 'cancel', 'other'].every(item => started.includes(item)))
blocked.resolve(); await Promise.all([first, next]);assert.equal(started.at(-1), 'second')
const failed = scheduler.schedule(request('conversation.rename'), async () => {throw new Error('fixture')})
await assert.rejects(failed)
await scheduler.schedule(request('conversation.rename'), async () => started.push('after-failure'))
assert.equal(started.at(-1), 'after-failure')
// Admission negotiation is invoked immediately, not behind any asynchronous read.
let negotiated = false
scheduler.schedule({method: 'remote.contract.negotiate'}, async () => {negotiated = true})
assert.equal(negotiated, true)

let stored = [{id: -1}], writes = 0, gate = deferred(), savesEntered = deferred()
const audit = createAuditQueue({delayMs: 10000, maxEntries: 200, load: async () => stored,
 filter: entries => entries.slice(0, 200), save: async entries => {writes++; savesEntered.resolve();await gate.promise;stored = entries}})
for (let id = 0; id < 300; id++) audit.append({id})
assert.equal(writes, 0)
const flushing = audit.flush();await savesEntered.promise
for (let id = 300; id < 305; id++) audit.append({id})
await tick();assert.equal(writes, 1, 'audit never runs concurrent whole-store writes')
gate.resolve();await flushing;await audit.flush()
assert.equal(writes, 2);assert.equal(stored.length, 200)
assert.deepEqual(stored.slice(0, 5).map(item => item.id), [304,303,302,301,300])
let attempts=0
const broken = createAuditQueue({load: async () => [], filter: value => value, save: async () => {attempts++;throw Error('synthetic disk failure')}})
broken.append({id: 1});await broken.flush();broken.append({id: 2});await broken.flush();assert.equal(attempts, 2)
console.log(JSON.stringify({ok: true, suite: 'remote-rpc-scheduler-and-audit'}))
