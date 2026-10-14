import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import * as store from '../main/core/conversationStore.js'
import { estimateMessagesTokens } from '../main/core/compact.js'

const marker = (storageId, snapshotId, content) => ({
  storageId,
  uiStorageId: `ui_${storageId}`,
  role: 'compaction',
  snapshotId,
  summary: content,
  content
})

function cascadeSession() {
  const system = { storageId: 'system', uiStorageId: 'ui_system', role: 'system', content: 'rules' }
  const firstUser = { storageId: 'user_1', uiStorageId: 'ui_user_1', role: 'user', content: 'first' }
  const firstAssistant = { storageId: 'assistant_1', uiStorageId: 'ui_assistant_1', role: 'assistant', content: 'first answer' }
  const firstMarker = marker('marker_1', 'snapshot_1', 'first summary')
  const preMarkerImage = `data:image/png;base64,${Buffer.alloc(1024, 1).toString('base64')}`
  const preMarkerPdf = `data:application/pdf;base64,${Buffer.from(`%PDF-1.7\n${'/Type /Page\n'.repeat(29)}`, 'latin1').toString('base64')}`
  const secondUser = {
    storageId: 'user_2',
    uiStorageId: 'ui_user_2',
    role: 'user',
    content: [
      { type: 'image_url', image_url: { url: preMarkerImage } },
      { type: 'file', file: { filename: 'pre-marker.pdf', file_data: preMarkerPdf, tokenEstimate: { pageCount: 29 } } }
    ]
  }
  const secondAssistant = { storageId: 'assistant_2', uiStorageId: 'ui_assistant_2', role: 'assistant', content: 'second answer' }
  const secondMarker = marker('marker_2', 'snapshot_2', 'second summary')
  const tailUser = { storageId: 'user_3', uiStorageId: 'ui_user_3', role: 'user', content: 'tail' }
  const tailAssistant = { storageId: 'assistant_3', uiStorageId: 'ui_assistant_3', role: 'assistant', content: 'tail answer' }
  const fullHistory = [system, firstUser, firstAssistant, firstMarker, secondUser, secondAssistant, secondMarker, tailUser, tailAssistant]
  return {
    anywhere_history: true,
    sessionMetadata: { title: 'cascade restore regression' },
    fullHistory,
    history: [],
    chat_show: fullHistory.map((message) => ({ ...message })),
    compactArchives: [
      { id: 'snapshot_1', summary: 'first summary' },
      { id: 'snapshot_2', summary: 'second summary' }
    ]
  }
}

async function main() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'anywhere-desktop-compact-restore-'))
  try {
    const created = await store.createConversation({
      dirPath: root,
      title: 'cascade restore regression',
      sessionData: cascadeSession()
    })
    const conversationId = created.descriptor.conversationId
    const holderInstanceId = 'desktop-restore-regression'
    const lease = await store.acquireWriteLease({
      dirPath: root,
      conversationId,
      holderInstanceId,
      holderApp: 'desktop'
    })
    assert.equal(lease.ok, true)

    const savedState = await store.saveConversationState({
      dirPath: root,
      conversationId,
      expectedRevision: 0,
      holderInstanceId,
      leaseEpoch: lease.leaseEpoch,
      state: {
        currentPromptConfig: { reasoning_effort: 'high', voice: 'alloy' },
        selectedVoice: 'alloy',
        activeMcpServerIds: ['mcp_a'],
        activeSkillIds: ['skill_a']
      }
    })
    assert.equal(savedState.revision, 1)

    const afterState = await store.openConversation({ dirPath: root, reference: conversationId, activeOnly: false, pageSize: 0 })
    assert.deepEqual(
      afterState.sessionData.fullHistory.filter((message) => message.role === 'compaction').map((message) => message.snapshotId),
      ['snapshot_1', 'snapshot_2'],
      'state-only save must not rewrite message markers'
    )
    assert.deepEqual(
      afterState.sessionData.chat_show.filter((message) => message.role === 'compaction').map((message) => message.snapshotId),
      ['snapshot_1', 'snapshot_2'],
      'state-only save must not rewrite UI markers'
    )
    assert.equal(afterState.sessionData.currentPromptConfig.reasoning_effort, 'high')


    const requestWindow = await store.getConversationRequestMessages({ dirPath: root, conversationId })
    assert.equal(requestWindow.ok, true)
    assert.deepEqual(
      requestWindow.messages.map((message) => message.storageId),
      ['system', 'marker_2', 'user_3', 'assistant_3'],
      'the current request must start at the latest active compaction marker while retaining system messages'
    )
    assert.equal(
      requestWindow.messages.some((message) => message.storageId === 'user_2'),
      false,
      'multimodal content before the latest marker must not re-enter the current request'
    )
    assert.ok(
      estimateMessagesTokens(afterState.sessionData.fullHistory) - estimateMessagesTokens(requestWindow.messages) >= 32250,
      'current request token estimation must exclude the pre-marker synthetic 29-page PDF'
    )

    const firstRestore = await store.restoreConversationCompaction({
      dirPath: root,
      conversationId,
      // The UI can be stale; the database must choose only the actual outermost marker.
      snapshotId: 'stale_ui_snapshot',
      expectedRevision: 1,
      holderInstanceId,
      leaseEpoch: lease.leaseEpoch,
      pageSize: 0
    })
    assert.equal(firstRestore.restoredSnapshotId, 'snapshot_2')
    assert.equal(firstRestore.descriptor.revision, 2)
    assert.deepEqual(
      firstRestore.sessionData.fullHistory.filter((message) => message.role === 'compaction').map((message) => message.snapshotId),
      ['snapshot_1'],
      'first restore must keep the inner compaction marker'
    )

    const secondRestore = await store.restoreConversationCompaction({
      dirPath: root,
      conversationId,
      snapshotId: 'snapshot_1',
      expectedRevision: 2,
      holderInstanceId,
      leaseEpoch: lease.leaseEpoch,
      pageSize: 0
    })
    assert.equal(secondRestore.restoredSnapshotId, 'snapshot_1')
    assert.equal(secondRestore.descriptor.revision, 3)
    assert.equal(
      secondRestore.sessionData.fullHistory.some((message) => message.role === 'compaction'),
      false,
      'second restore must remove only the remaining marker'
    )

    await store.releaseWriteLease({ dirPath: root, conversationId, holderInstanceId, leaseEpoch: lease.leaseEpoch })
    console.log('Desktop compaction restore/state regression passed')
  } finally {
    await fs.rm(root, { recursive: true, force: true })
  }
}

main().catch((error) => {
  console.error(error?.stack || error)
  process.exitCode = 1
})
