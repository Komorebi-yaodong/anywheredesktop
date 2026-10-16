import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const input = await fs.readFile(path.join(root, 'render', 'window', 'components', 'ChatInput.vue'), 'utf8')
const app = await fs.readFile(path.join(root, 'render', 'window', 'App.vue'), 'utf8')
const store = await fs.readFile(path.join(root, 'main', 'core', 'conversationStore.js'), 'utf8')

const compact = await fs.readFile(path.join(root, 'main', 'core', 'compact.js'), 'utf8')

assert.match(input, /const configurationLocked = computed\(\(\) => Boolean\(props\.writeLocked\)\)/)
assert.match(input, /const draftInputLocked = computed\(\(\) => Boolean\(isRecording\.value \|\| props\.writeLocked\)\)/)
assert.match(input, /<div v-if="compacting" class="compact-section-card compact-progress-block">/)
assert.match(input, /\.compact-progress-block \{[\s\S]{0,80}padding: 14px;/)
assert.match(input, /<div class="compact-config-block">/)
assert.match(input, /<template #footer>/)
assert.match(app, /if \(compacting\.value\) \{[\s\S]{0,160}压缩进行中，暂不可发送/)
assert.match(app, /if \(loading\.value \|\| isPreparingSend\.value\) \{[\s\S]{0,120}enqueueInputToBuffer\(\)/)
assert.match(app, /const enqueueInputToBuffer = \(\) =>/)
assert.match(store, /const restoredSnapshotId = outermost\.summary_id/)
assert.doesNotMatch(store, /if \(outermost\.summary_id !== requestedSnapshotId\)/)
assert.match(store, /return \{ revision, updatedAt, title: row\.title, restoredSnapshotId \}/)
assert.match(store, /restoredSnapshotId: result\.restoredSnapshotId/)
assert.match(store, /uiMessages = null/)

assert.doesNotMatch(compact, /archivedMessages:\s*deepClone\(sourceMessages\)/)
// The remaining interaction assertions intentionally stop at the v1.3.1-compatible
// compaction contract. Later development-line session-config/reload helpers are not
// required for this stable-line backport and must not be pulled into 1.3.x.

console.log('Desktop compaction interaction and authoritative restore regression passed')
