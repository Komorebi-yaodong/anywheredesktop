import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import vm from 'node:vm'
import path from 'node:path'

const source = await fs.readFile(new URL('../main/windowManager.js', import.meta.url), 'utf8')
const start = source.indexOf('  // Check after the last await')
const block = source.slice(start, source.indexOf('  const titleSuffix', start))
const directory = 'synthetic-dir'
const locations = new Map([['active', {conversationId: 'fixture', dirPath: directory}]])
let reveals = 0
const context = {path, normalizeConversationMetadataId: value => value || '', targetType: 'window',
  openPayload: {conversation: {descriptor: {conversationId: 'fixture'}, dirPath: directory}},
  fullConfig: {}, conversationDirectoryStore: locations,
  multiStore: new Map([['active', {isDestroyed: () => false}]]),
  revealRemoteConversationWindow: () => {reveals++}}
const open = () => vm.runInNewContext(`(() => {${block}; return null})()`, context)
assert.equal(open().id, 'active')
assert.equal(reveals, 1)
context.openPayload.preserveExistingVisibility = true
assert.equal(open().reused, true)
assert.equal(reveals, 1, 'scheduled task keeps the existing visibility and focus')
context.openPayload.preserveExistingVisibility = false
context.openPayload.remoteHidden = true
assert.equal(open().reused, true)
assert.equal(reveals, 1, 'Mobile open does not reveal an existing writer')
context.openPayload.conversation.dirPath = 'another-dir'
assert.equal(open(), null, 'identical IDs in separate stores are distinct')
context.openPayload.conversation.dirPath = directory
context.multiStore.get('active').isDestroyed = () => true
assert.equal(open(), null)
console.log('PASS same-client conversation window reuse / hidden / directory / destroyed guards')
