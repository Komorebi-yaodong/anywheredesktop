import assert from 'node:assert/strict'
import { createIdempotentSerialApplier } from '../main/core/idempotentApply.js'

const deferred = () => {
  let resolve
  let reject
  const promise = new Promise((nextResolve, nextReject) => {
    resolve = nextResolve
    reject = nextReject
  })
  return { promise, resolve, reject }
}

const normalize = (input = {}) => {
  const enabled = input?.enabled === true
  return {
    enabled,
    server: enabled && typeof input?.server === 'string' ? input.server.trim() : '',
    bypassRules: typeof input?.bypassRules === 'string' && input.bypassRules.trim()
      ? input.bypassRules.trim()
      : '<local>'
  }
}
const fingerprint = (value) => JSON.stringify(value)

const applied = []
const firstApplyGate = deferred()
const applyConfig = createIdempotentSerialApplier({
  normalize,
  getFingerprint: fingerprint,
  apply: async (value) => {
    applied.push(value)
    if (applied.length === 1) await firstApplyGate.promise
  }
})

const directConfig = { enabled: false, server: '', bypassRules: '<local>' }
const first = applyConfig(directConfig)
const duplicateWhilePending = applyConfig({ ...directConfig })
await Promise.resolve()
assert.equal(applied.length, 1, 'duplicate config must wait behind the in-flight apply')
firstApplyGate.resolve()
await Promise.all([first, duplicateWhilePending])
assert.equal(applied.length, 1, 'duplicate config must not be applied twice')

await applyConfig({ enabled: false, server: 'ignored-while-disabled', bypassRules: '<local>' })
assert.equal(applied.length, 1, 'semantically identical normalized config must remain a no-op')

const proxyConfig = { enabled: true, server: 'http://127.0.0.1:7890', bypassRules: '<local>' }
await Promise.all([
  applyConfig(proxyConfig),
  applyConfig({ ...proxyConfig }),
  applyConfig({ ...proxyConfig })
])
assert.equal(applied.length, 2, 'one real config change should produce one apply even under concurrent broadcasts')

const ordered = []
const orderedApply = createIdempotentSerialApplier({
  normalize,
  getFingerprint: fingerprint,
  apply: async (value) => { ordered.push(value) }
})
await Promise.all([
  orderedApply(directConfig),
  orderedApply(proxyConfig),
  orderedApply(directConfig)
])
assert.deepEqual(ordered, [directConfig, proxyConfig, directConfig], 'A-B-A updates must preserve application order')

let failingAttempts = 0
const recoverableApply = createIdempotentSerialApplier({
  normalize,
  getFingerprint: fingerprint,
  apply: async () => {
    failingAttempts += 1
    if (failingAttempts === 1) throw new Error('synthetic_apply_failure')
  }
})
await assert.rejects(recoverableApply(proxyConfig), /synthetic_apply_failure/)
await recoverableApply(proxyConfig)
assert.equal(failingAttempts, 2, 'a failed apply must not mark the config as applied or poison the queue')

console.log('Desktop idempotent serial apply regression passed')
