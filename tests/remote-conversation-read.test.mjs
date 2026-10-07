import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import * as store from '../main/core/conversationStore.js'

const PIXEL_DATA_URL = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl2nH0AAAAASUVORK5CYII='

function buildSession() {
  const system = {
    role: 'system',
    content: 'remote fixture system',
    storageId: 'message-system',
    uiStorageId: 'ui-system'
  }
  const messages = [system]
  const chatShow = [system]

  for (let index = 1; index <= 5; index += 1) {
    const isLast = index === 5
    const message = {
      role: index % 2 === 1 ? 'user' : 'assistant',
      content: isLast
        ? [
            { type: 'text', text: 'latest body' },
            {
              type: 'file',
              file: {
                filename: 'pixel.png',
                file_data: PIXEL_DATA_URL,
                path: 'E:/private/pixel.png'
              }
            },
            { type: 'image_url', image_url: { url: PIXEL_DATA_URL } }
          ]
        : `message-${index}`,
      storageId: `message-${index}`,
      uiStorageId: `ui-${index}`,
      timestamp: `2026-01-01T00:00:0${index}.000Z`,
      path: `E:/secret/${index}.txt`,
      file_path: `E:/secret/${index}-file.txt`,
      dirPath: 'E:/secret',
      dir_path: 'E:/secret/under_score',
      db_file: 'E:/secret/conversation.db',
      api_key: 'SECRET_API_KEY',
      password: 'SECRET_PASSWORD',
      env: { SECRET_ENV: 'SECRET_ENV_VALUE' },
      headers: { Authorization: 'Bearer SECRET_TOKEN' },
      tool_calls: isLast
        ? [{
            id: 'tool-secret',
            function: { name: 'read_file', arguments: JSON.stringify({ file_path: 'E:/secret/private.txt' }) },
            approvalStatus: 'finished',
            result: 'SECRET_TOOL_RESULT'
          }]
        : []
    }
    messages.push(message)
    chatShow.push({ ...message })
  }

  return {
    anywhere_history: true,
    CODE: 'AI',
    sessionMetadata: { title: 'remote read fixture' },
    fullHistory: messages,
    history: [],
    chat_show: chatShow
  }
}

function readActiveLease(databasePath) {
  const db = new DatabaseSync(databasePath, { readOnly: true })
  try {
    return db.prepare("SELECT holder_instance_id, lease_epoch FROM write_lease WHERE resource = 'conversation'").get() || null
  } finally {
    db.close()
  }
}

async function main() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'anywhere-remote-read-'))
  try {
    const created = await store.createConversation({
      dirPath: root,
      title: 'remote read fixture',
      sessionData: buildSession(),
      projectId: 'project-fixture',
      projectName: 'Remote Fixture Project'
    })
    const conversationId = created.descriptor.conversationId
    assert.equal(readActiveLease(created.databasePath), null)

    const first = await store.loadRemoteConversationPage({
      dirPath: root,
      conversationId,
      pageSize: 2
    })
    assert.equal(first.ok, true)
    assert.equal(first.conversation.conversationId, conversationId)
    assert.deepEqual(first.conversation.project, {
      projectId: 'project-fixture',
      name: 'Remote Fixture Project'
    })
    assert.equal(first.page.hasMore, true)
    assert.equal(first.page.nextBeforeUiOrder, 5)
    assert.deepEqual(first.messages.map((message) => message.role), ['system', 'assistant', 'user'])
    assert.deepEqual(first.messages.map((message) => message.uiMessageId), ['ui-system', 'ui-4', 'ui-5'])

    const latest = first.messages.at(-1)
    assert.deepEqual(latest.payload.toolCalls, [{ id: 'tool-secret', name: 'read_file', status: 'finished' }])
    const serializedFirst = JSON.stringify(first)
    for (const forbidden of [
      PIXEL_DATA_URL,
      'E:/private/pixel.png',
      'E:/secret/private.txt',
      'E:/secret/5-file.txt',
      'E:/secret/under_score',
      'E:/secret/conversation.db',
      'SECRET_API_KEY',
      'SECRET_PASSWORD',
      'SECRET_ENV_VALUE',
      'SECRET_TOKEN',
      'SECRET_TOOL_RESULT',
      'dbFile',
      'dirPath',
      'legacyJson'
    ]) {
      assert.equal(serializedFirst.includes(forbidden), false, `remote DTO leaked: ${forbidden}`)
    }
    assert.ok(serializedFirst.includes('pixel.png'))
    assert.ok(serializedFirst.includes('attachmentId'))
    assert.ok(serializedFirst.includes('sha256'))

    const second = await store.loadRemoteConversationPage({
      dirPath: root,
      conversationId,
      beforeUiOrder: first.page.nextBeforeUiOrder,
      pageSize: 2
    })
    assert.deepEqual(second.messages.map((message) => message.uiMessageId), ['ui-2', 'ui-3'])
    assert.equal(second.page.hasMore, true)
    assert.equal(second.page.nextBeforeUiOrder, 3)

    const third = await store.loadRemoteConversationPage({
      dirPath: root,
      conversationId,
      beforeUiOrder: second.page.nextBeforeUiOrder,
      pageSize: 1000
    })
    assert.deepEqual(third.messages.map((message) => message.uiMessageId), ['ui-1'])
    assert.equal(third.page.pageSize, 100)
    assert.equal(third.page.hasMore, false)
    assert.equal(third.page.nextBeforeUiOrder, null)

    assert.equal(readActiveLease(created.databasePath), null)
    console.log(JSON.stringify({ ok: true, suite: 'remote-conversation-read', conversationId }))
  } finally {
    await fs.rm(root, { recursive: true, force: true })
  }
}

main().catch((error) => {
  console.error(error?.stack || error)
  process.exitCode = 1
})
