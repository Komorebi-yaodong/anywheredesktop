import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const source = await fs.readFile(path.join(root, 'main', 'core', 'net.js'), 'utf8')

assert.match(source, /const UPDATER_SESSION_PARTITION = 'electron-updater'/)
assert.match(source, /async function applyProxyToSession\(targetSession, proxyConfig\)[\s\S]{0,220}await targetSession\.setProxy\(proxyConfig\)[\s\S]{0,120}await targetSession\.closeAllConnections\?\.\(\)/)
assert.match(source, /const proxyConfig = config\.enabled[\s\S]{0,220}\? \{ mode: 'fixed_servers', proxyRules: config\.server, proxyBypassRules: config\.bypassRules \}[\s\S]{0,80}: \{ mode: 'direct' \}/)
assert.match(source, /await applyProxyToSession\(session\?\.defaultSession, proxyConfig\)/)
assert.match(source, /session\.fromPartition\(UPDATER_SESSION_PARTITION, \{ cache: false \}\)/)
assert.match(source, /await applyProxyToSession\(updaterSession, proxyConfig\)/)

console.log('Desktop updater proxy session regression passed')
