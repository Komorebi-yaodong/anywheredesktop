import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import * as store from '../main/core/conversationStore.js'
import { readLocalProjects } from '../main/core/projects.js'

const CREATED_AT = '2021-02-03T04:05:06.000Z'
const UPDATED_AT = '2021-02-04T05:06:07.000Z'

function legacySession() {
  return {
    anywhere_history: true,
    sessionMetadata: { title: 'legacy time fixture' },
    fullHistory: [
      { role: 'system', content: 'system' },
      { role: 'user', content: 'first', timestamp: CREATED_AT },
      { role: 'assistant', content: 'last', completedTimestamp: UPDATED_AT }
    ],
    history: [],
    chat_show: [
      { role: 'user', content: 'first', timestamp: CREATED_AT },
      { role: 'assistant', content: 'last', completedTimestamp: UPDATED_AT }
    ]
  }
}

async function main() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'anywhere-desktop-time-'))
  const importedRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'anywhere-desktop-time-import-'))
  try {
    const legacyJson = 'legacy-time.json'
    await fs.writeFile(path.join(root, legacyJson), JSON.stringify(legacySession()), 'utf8')

    const migrated = await store.migrateJsonConversation({ dirPath: root, jsonBasename: legacyJson })
    assert.equal(migrated.descriptor.createdAt, CREATED_AT)
    assert.equal(migrated.descriptor.updatedAt, UPDATED_AT)

    const firstOpen = await store.openConversation({ dirPath: root, reference: migrated.descriptor.conversationId })
    assert.equal(firstOpen.descriptor.createdAt, CREATED_AT)
    assert.equal(firstOpen.sessionData.sessionMetadata.createdAt, CREATED_AT)
    assert.equal(firstOpen.sessionData.sessionMetadata.updatedAt, UPDATED_AT)

    const secondOpen = await store.openConversation({ dirPath: root, reference: migrated.descriptor.conversationId })
    assert.equal(secondOpen.descriptor.createdAt, CREATED_AT)
    assert.equal(secondOpen.sessionData.sessionMetadata.createdAt, CREATED_AT)

    const projects = await readLocalProjects(root)
    assert.equal(projects.conversations[migrated.descriptor.conversationId].createdAt, CREATED_AT)

    const snapshot = await store.readConversationSnapshot({ dirPath: root, conversationId: migrated.descriptor.conversationId })
    const descriptorWithoutTimes = { ...migrated.descriptor }
    delete descriptorWithoutTimes.createdAt
    delete descriptorWithoutTimes.updatedAt
    const imported = await store.importConversationSnapshot({
      dirPath: importedRoot,
      descriptor: descriptorWithoutTimes,
      content: snapshot.content
    })
    assert.equal(imported.descriptor.createdAt, CREATED_AT)
    assert.equal(imported.descriptor.updatedAt, UPDATED_AT)

    const importedOpen = await store.openConversation({ dirPath: importedRoot, reference: migrated.descriptor.conversationId })
    assert.equal(importedOpen.sessionData.sessionMetadata.createdAt, CREATED_AT)
    assert.equal(importedOpen.sessionData.sessionMetadata.updatedAt, UPDATED_AT)


    const lease = await store.acquireWriteLease({
      dirPath: root,
      conversationId: migrated.descriptor.conversationId,
      holderInstanceId: 'time-regression-writer',
      holderApp: 'desktop'
    })
    await store.saveConversationSnapshot({
      dirPath: root,
      conversationId: migrated.descriptor.conversationId,
      expectedRevision: 0,
      holderInstanceId: 'time-regression-writer',
      leaseEpoch: lease.leaseEpoch,
      title: migrated.descriptor.title,
      sessionData: firstOpen.sessionData
    })
    const afterSave = await store.openConversation({ dirPath: root, reference: migrated.descriptor.conversationId })
    assert.equal(afterSave.descriptor.createdAt, CREATED_AT)
    assert.equal(afterSave.sessionData.sessionMetadata.createdAt, CREATED_AT)

    console.log('Desktop conversation time regression passed')
  } finally {
    await fs.rm(root, { recursive: true, force: true })
    await fs.rm(importedRoot, { recursive: true, force: true })
  }
}

main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
