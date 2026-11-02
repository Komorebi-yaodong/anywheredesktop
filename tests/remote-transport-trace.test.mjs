// TEMPORARY diagnosis tests; delete when the field fault is verified fixed.
import assert from 'node:assert/strict'
import {createTransportTrace} from '../main/core/remote/transportTrace.js'
let clock = 1000
const trace = createTransportTrace({now: () => clock})
assert.equal(trace.nextGeneration(), 1)
assert.equal(trace.nextGeneration(), 2)
for (let i = 0; i < 600; i++) {clock++;trace.record('decrypted', {generation: i, bytes: 932588, method: 'secret-content', code: 'https://private.invalid', requestId: 'secret', endpoint: 'private', payload: 'photo', path: '/private', sequence: NaN, elapsedMs: -1})}
const snapshot = trace.snapshot()
assert.equal(snapshot.rows.length, 512)
assert.deepEqual(snapshot.rows[0], {atMs: 89, event: 'decrypted', generation: 88, bytes: 932588, method: 'other', code: 'other'})
assert.equal(JSON.stringify(snapshot).includes('private'), false)
assert.equal(JSON.stringify(snapshot).includes('secret'), false)
assert.equal(JSON.stringify(snapshot).includes('photo'), false)
snapshot.rows[0].bytes = 0
assert.equal(trace.snapshot().rows[0].bytes, 932588)
trace.record('unsafe-event', {bytes: 1})
assert.equal(trace.snapshot().rows.at(-1).generation, 599)
trace.start();trace.start();clock += 1500
await new Promise(resolve => setTimeout(resolve, 1100))
assert.ok(trace.snapshot().rows.some(row => row.event === 'loop_lag' && row.elapsedMs === 500))
trace.stop()
console.log(JSON.stringify({ok: true, suite: 'temporary-remote-transport-trace', bounded: 512, contentFree: true}))
