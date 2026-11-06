import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import vm from 'node:vm'
const source = await fs.readFile(process.argv[2] || new URL('../render/window/App.vue', import.meta.url), 'utf8')
const start = source.indexOf('const ensureConversationWriteAccess =')
const block = source.slice(start, source.indexOf('\n};', start) + 3)
const context = {
  currentConversationStorage: {value: {conversationId: 'fixture'}},
  conversationLease: {value: {leaseEpoch: 1, expiresAt: '2000-01-01T00:00:00Z'}},
  conversationLeasePending: {value: false}, conversationReadOnly: {value: false},
  showDismissibleMessage: {warning() {}}
}
const access = vm.runInNewContext(`${block}; ensureConversationWriteAccess`, context)
assert.equal(access(), true, 'expired compatibility lease cannot disable saving')
context.conversationLease.value = null
assert.equal(access(), true, 'saving does not require a DB lease')
context.conversationLeasePending.value = true
assert.equal(access(), false, 'initialization still prevents premature writes')
assert.doesNotMatch(source, /heartbeatConversationWriteLease\(/, 'no periodic lease heartbeat in renderer')
assert.doesNotMatch(source, /conversationReadOnly\.value = true/, 'DB failures cannot flip the view to readonly')
console.log('PASS renderer has no heartbeat/expiry/readonly conflict gate')
