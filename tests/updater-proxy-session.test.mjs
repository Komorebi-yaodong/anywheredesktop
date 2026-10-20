import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import vm from 'node:vm'
import { createIdempotentSerialApplier } from '../main/core/idempotentApply.js'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const source = await fs.readFile(path.join(root, 'main', 'core', 'net.js'), 'utf8')
const mainSource = await fs.readFile(path.join(root, 'main', 'index.js'), 'utf8')

assert.match(source, /const UPDATER_SESSION_PARTITION = 'electron-updater'/)
assert.match(source, /async function applyProxyToSession\(targetSession, proxyConfig\)[\s\S]{0,220}await targetSession\.setProxy\(proxyConfig\)[\s\S]{0,120}await targetSession\.closeAllConnections\?\.\(\)/)
assert.match(source, /async function applyNormalizedNetworkProxyConfig\(config\)[\s\S]{0,220}const proxyConfig = config\.enabled[\s\S]{0,220}\? \{ mode: 'fixed_servers', proxyRules: config\.server, proxyBypassRules: config\.bypassRules \}[\s\S]{0,80}: \{ mode: 'direct' \}/)
assert.match(source, /await applyProxyToSession\(session\?\.defaultSession, proxyConfig\)/)
assert.match(source, /session\.fromPartition\(UPDATER_SESSION_PARTITION, \{ cache: false \}\)/)
assert.match(source, /await applyProxyToSession\(updaterSession, proxyConfig\)/)
assert.match(source, /createIdempotentSerialApplier\(\{[\s\S]{0,240}normalize: normalizeNetworkProxyConfig,[\s\S]{0,160}apply: applyNormalizedNetworkProxyConfig/)
assert.match(mainSource, /if \(channel === 'window:configUpdated'\) \{[\s\S]{0,180}syncDesktopRuntimeFromConfig\(\)/)
assert.doesNotMatch(mainSource, /channel === 'window:configUpdated' \|\| channel === 'config-updated'/)

// Exercise the actual network module with synthetic Electron sessions, without real network I/O.
const calls = []
let activeStreamConnected = false
let failUpdater = false
const makeSession = (name) => ({
  async setProxy(config) {
    calls.push({ name, operation: 'setProxy', config: JSON.parse(JSON.stringify(config)) })
    if (name === 'updater' && failUpdater) throw new Error('synthetic_updater_failure')
  },
  async closeAllConnections() {
    calls.push({ name, operation: 'close' })
    if (name === 'default') activeStreamConnected = false
  }
})
const defaultSession = makeSession('default')
const updaterSession = makeSession('updater')
const context = vm.createContext({
  app: { async setProxy(config) { calls.push({ name: 'app', operation: 'setProxy', config: JSON.parse(JSON.stringify(config)) }) } },
  net: {},
  session: {
    defaultSession,
    fromPartition(partition, options) {
      assert.equal(partition, 'electron-updater')
      assert.equal(options.cache, false)
      return updaterSession
    }
  },
  createIdempotentSerialApplier,
  URL
})
const network = vm.runInContext(
  `${source.replace(/^import .+$/gm, '').replace(/^export /gm, '')}\n;({ applyNetworkProxyConfig })`,
  context
)
const direct = { enabled: false }
const proxy = { enabled: true, server: 'http://127.0.0.1:7890' }
const count = () => calls.length
await network.applyNetworkProxyConfig(direct)
assert.equal(count(), 5, 'startup must set app/default/updater proxies and close both session connection pools')
activeStreamConnected = true
const initialCount = count()
await Promise.all(Array.from({ length: 4 }, () => network.applyNetworkProxyConfig({ ...direct })))
assert.equal(count(), initialCount, 'ordinary config broadcasts must not touch proxy or connection pools')
assert.equal(activeStreamConnected, true, 'saving a model must preserve the active stream')
await Promise.all([network.applyNetworkProxyConfig(proxy), network.applyNetworkProxyConfig({ ...proxy })])
assert.equal(count(), initialCount + 5, 'a real proxy change applies once across all targets')
assert.equal(activeStreamConnected, false)
assert.deepEqual(calls.filter((call) => call.operation === 'setProxy').slice(-3).map((call) => call.config),
  Array.from({ length: 3 }, () => ({ mode: 'fixed_servers', proxyRules: proxy.server, proxyBypassRules: '<local>' })))
await network.applyNetworkProxyConfig({ ...proxy, bypassRules: 'localhost' })
assert.equal(count(), initialCount + 10, 'bypass changes must be applied')
await network.applyNetworkProxyConfig({ ...proxy, server: 'http://127.0.0.1:7891', bypassRules: 'localhost' })
assert.equal(count(), initialCount + 15, 'server changes must be applied')
await network.applyNetworkProxyConfig(direct)
assert.equal(count(), initialCount + 20, 'disabling proxy must restore direct on every target')
assert.deepEqual(calls.filter((call) => call.operation === 'setProxy').slice(-3).map((call) => call.config),
  [{ mode: 'direct' }, { mode: 'direct' }, { mode: 'direct' }])

failUpdater = true
await assert.rejects(network.applyNetworkProxyConfig(proxy), /synthetic_updater_failure/)
failUpdater = false
const countAfterFailure = count()
await network.applyNetworkProxyConfig(direct)
assert.equal(count(), countAfterFailure + 5, 'after a partially failed change, restoring the old config must apply again')
await assert.rejects(network.applyNetworkProxyConfig({ enabled: true, server: 'invalid' }), /network_proxy_server_invalid/)
activeStreamConnected = true
const stableCount = count()
await network.applyNetworkProxyConfig(direct)
assert.equal(count(), stableCount, 'invalid input must not poison a previously healthy state')
assert.equal(activeStreamConnected, true)

console.log('Desktop updater proxy session contract and behavior regressions passed')
