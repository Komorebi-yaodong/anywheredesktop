import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  completeConversationClose,
  createConversationMutationQueue,
  mergeConversationMutationRequests
} from '../render/window/utils/conversationMutationQueue.js'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const appSource = await fs.readFile(path.join(root, 'render', 'window', 'App.vue'), 'utf8')

const merged = mergeConversationMutationRequests(
  { reason: 'config', version: 2, stateOnly: true, force: false, skipProjectAssignment: true },
  { reason: 'message', version: 3, stateOnly: false, force: true, skipProjectAssignment: false }
)
assert.deepEqual(merged, {
  reason: 'message',
  version: 3,
  stateOnly: false,
  force: true,
  skipProjectAssignment: false
})

let releaseFirst
let markFirstStarted
const firstStarted = new Promise((resolve) => { markFirstStarted = resolve })
const firstGate = new Promise((resolve) => { releaseFirst = resolve })
const calls = []
const queue = createConversationMutationQueue(async (request) => {
  calls.push({ ...request })
  if (request.version === 1) {
    markFirstStarted()
    await firstGate
  }
  return true
})

const firstDrain = queue.enqueue({ reason: 'old-snapshot', version: 1, stateOnly: false })
await firstStarted
const configDrain = queue.enqueue({ reason: 'config', version: 2, stateOnly: true })
const closeDrain = queue.enqueue({ reason: 'window-close-final', version: 3, stateOnly: false, force: true })
releaseFirst()
assert.equal(await firstDrain, true)
assert.equal(await configDrain, true)
assert.equal(await closeDrain, true)
assert.equal(calls.length, 2)
assert.equal(calls[1].version, 3)
assert.equal(calls[1].stateOnly, false)
assert.equal(calls[1].force, true)

let releaseFailedOld
let markFailedOldStarted
const failedOldStarted = new Promise((resolve) => { markFailedOldStarted = resolve })
const failedOldGate = new Promise((resolve) => { releaseFailedOld = resolve })
const recoveryCalls = []
const recoveryQueue = createConversationMutationQueue(async (request) => {
  recoveryCalls.push({ ...request })
  if (request.version === 4) {
    markFailedOldStarted()
    await failedOldGate
    return false
  }
  return true
})
const failedOldDrain = recoveryQueue.enqueue({ reason: 'old-failed', version: 4, stateOnly: true })
await failedOldStarted
const recoveredCloseDrain = recoveryQueue.enqueue({ reason: 'window-close-final', version: 5, stateOnly: false })
releaseFailedOld()
assert.equal(await failedOldDrain, false)
assert.equal(await recoveredCloseDrain, true, 'a later full snapshot may durably cover an earlier failed mutation')
assert.deepEqual(recoveryCalls.map((request) => request.version), [4, 5])

const failedCloseEvents = []
await assert.rejects(
  completeConversationClose({
    persist: async () => false,
    release: async () => { failedCloseEvents.push('release') },
    close: async () => { failedCloseEvents.push('close') }
  }),
  /conversation_close_save_incomplete/
)
assert.deepEqual(failedCloseEvents, [], 'failed persistence must keep the lease and window open')

const successfulCloseEvents = []
assert.equal(await completeConversationClose({
  persist: async () => { successfulCloseEvents.push('persist'); return true },
  release: async () => { successfulCloseEvents.push('release') },
  close: async () => { successfulCloseEvents.push('close') }
}), true)
assert.deepEqual(successfulCloseEvents, ['persist', 'release', 'close'])

assert.doesNotMatch(appSource, /skipQueueWhenBusy|queuedAutoSaveRequest/)
assert.match(appSource, /const persistLatestSessionBeforeClose = async[\s\S]{0,2200}await autoSaveMutationQueue\.whenIdle\(\)[\s\S]{0,700}lastPersistedSessionVersion >= targetVersion/)
assert.match(appSource, /return await completeConversationClose\(\{[\s\S]{0,500}persistLatestSessionBeforeClose\(shouldForceSave\)[\s\S]{0,300}release: releaseCurrentConversationLease/)
assert.match(appSource, /watch\(\[model, selectedVoice, tempReasoningEffort, sessionMcpServerIds, sessionSkillIds, isAutoApproveTools, sessionMcpToolOverrides\]/)
assert.match(appSource, /state: getSessionRequestConfigStatePatch\(\)/)
assert.match(appSource, /typeof jsonData\.isAutoApproveTools === 'boolean'/)
assert.match(appSource, /sessionMcpToolOverrides\.value = jsonData\.sessionMcpToolOverrides/)
assert.match(appSource, /settlementPromise: turnSettlementPromise,[\s\S]{0,120}resolveSettlement: resolveTurnSettlement/)
assert.match(appSource, /turnMeta\.resolveSettlement\?\.\(\)/)
assert.match(appSource, /const assistantSettlementPromise = activeAssistantTurnMeta\?\.settlementPromise[\s\S]{0,240}waitForAssistantTurnToSettleBeforeClose\(assistantSettlementPromise\)/)

assert.match(appSource, /isRestoringSessionSnapshot \|\| conversationReadOnly\.value \|\| conversationLeasePending\.value/)
assert.match(appSource, /const hasUnpersistedMutations = sessionMutationVersion > lastPersistedSessionVersion[\s\S]{0,450}conversation_unpersisted_changes_without_write_access/)

assert.match(appSource, /const waitForPendingWindowMutationsBeforeClose = async[\s\S]{0,900}activeApplyMcpPromise/)
assert.match(appSource, /if \(isClosingWindow\.value \|\| !ensureConversationWriteAccess\(true\)\) return/)
assert.match(appSource, /await waitForAssistantTurnToSettleBeforeClose\(assistantSettlementPromise\);[\s\S]{0,120}await waitForPendingWindowMutationsBeforeClose\(\)/)

assert.match(appSource, /if \(!added\) return;[\s\S]{0,80}if \(isClosingWindow\.value\) return;[\s\S]{0,160}loading\.value = true/)

assert.match(appSource, /:write-locked="conversationReadOnly \|\| conversationLeasePending \|\| isClosingWindow"/)

console.log('Desktop conversation persistence lifecycle regression passed')
