import assert from 'node:assert/strict'
import { createRemoteConversationReadService } from '../main/core/remote/conversationRead.js'

function expectCode(operation, code) {
  return assert.rejects(operation, (error) => error?.code === code)
}

async function main() {
  const messageCalls = []
  const localFiles = [
    {
      format: 'sqlite',
      conversationId: 'conversation-fixture-000000000001',
      title: 'Newest',
      revision: 7,
      size: 200,
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-03T00:00:00.000Z'
    },
    {
      format: 'json',
      basename: 'legacy.json',
      filename: 'legacy.json',
      title: 'Legacy',
      size: 100,
      createdAt: '2025-01-01T00:00:00.000Z',
      updatedAt: '2026-01-02T00:00:00.000Z'
    },
    {
      format: 'sqlite',
      conversationId: 'conversation-fixture-000000000002',
      title: 'Oldest',
      revision: 2,
      size: 150,
      createdAt: '2024-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z'
    }
  ]
  const service = createRemoteConversationReadService({
    getConfig: async () => ({ config: { webdav: { localChatPath: 'E:/DesktopOnly/Chats' } } }),
    listLocalConversations: async (dirPath) => {
      assert.equal(dirPath, 'E:/DesktopOnly/Chats')
      return localFiles
    },
    readLocalProjects: async (dirPath) => {
      assert.equal(dirPath, 'E:/DesktopOnly/Chats')
      return {
        projects: [
          {
            id: 'project-one',
            name: 'Project One',
            conversationIds: ['conversation-fixture-000000000001'],
            files: ['legacy.json']
          }
        ]
      }
    },
    loadRemoteConversationPage: async (input) => {
      messageCalls.push(input)
      return { ok: true, conversation: { conversationId: input.conversationId }, messages: [], page: { hasMore: false } }
    },
    listWindows: () => [
      {
        id: 'window-fixture-1',
        type: 'window',
        conversationId: 'conversation-fixture-000000000001',
        conversationTitle: 'Newest Live',
        conversationRevision: 8,
        visible: true,
        busy: true,
        generating: true,
        compacting: false,
        readOnly: false,
        leasePending: false,
        promptCode: 'AI',
        icon: 'data:image/png;base64,SHOULD_NOT_LEAK',
        dirPath: 'E:/DesktopOnly/Chats'
      },
      { id: 'window-no-conversation', type: 'window', displayName: 'Unsaved' }
    ]
  })

  const first = await service.listConversations({ limit: 2 })
  assert.equal(first.configured, true)
  assert.equal(first.conversations.length, 2)
  assert.equal(first.conversations[0].conversationId, 'conversation-fixture-000000000001')
  assert.equal(first.conversations[0].window.busy, true)
  assert.equal(first.conversations[0].window.title, 'Newest Live')
  assert.equal(first.conversations[1].format, 'legacy-json')
  assert.equal(first.conversations[1].readable, false)
  assert.equal(first.conversations[1].migrationRequired, true)
  assert.match(first.conversations[1].conversationId, /^legacy_[a-f0-9]{32}$/)
  assert.deepEqual(first.projects, [{
    projectId: 'project-one',
    name: 'Project One',
    conversationIds: [
      'conversation-fixture-000000000001',
      first.conversations[1].conversationId
    ]
  }])
  assert.equal(first.page.hasMore, true)
  assert.equal(typeof first.page.nextCursor, 'string')
  const serialized = JSON.stringify(first)
  for (const forbidden of ['E:/DesktopOnly/Chats', 'data:image/png', 'dirPath', 'dbFile', 'legacyJson']) {
    assert.equal(serialized.includes(forbidden), false, `conversation list leaked: ${forbidden}`)
  }

  const second = await service.listConversations({ limit: 2, cursor: first.page.nextCursor })
  assert.deepEqual(second.conversations.map((item) => item.conversationId), ['conversation-fixture-000000000002'])
  assert.equal(second.page.hasMore, false)

  await expectCode(() => service.listConversations({ dirPath: 'C:/attacker' }), 'remote_path_parameter_forbidden')
  await expectCode(() => service.listConversations({ unexpected: true }), 'remote_parameter_unknown')
  await expectCode(async () => service.getWindows({ includeSecrets: true }), 'remote_parameter_unknown')
  await expectCode(() => service.listMessages({
    conversationId: 'conversation-fixture-000000000001',
    path: 'C:/attacker'
  }), 'remote_path_parameter_forbidden')
  await expectCode(() => service.listMessages({
    conversationId: first.conversations[1].conversationId
  }), 'remote_conversation_migration_required')

  const messages = await service.listMessages({
    conversationId: 'conversation-fixture-000000000001',
    beforeUiOrder: 10,
    pageSize: 25
  })
  assert.equal(messages.ok, true)
  assert.deepEqual(messageCalls, [{
    dirPath: 'E:/DesktopOnly/Chats',
    conversationId: 'conversation-fixture-000000000001',
    beforeUiOrder: 10,
    pageSize: 25
  }])

  const unconfigured = createRemoteConversationReadService({
    getConfig: async () => ({ config: { webdav: { localChatPath: '' } } }),
    listLocalConversations: async () => { throw new Error('should_not_list') },
    readLocalProjects: async () => ({ projects: [] }),
    loadRemoteConversationPage: async () => { throw new Error('should_not_load') },
    listWindows: () => []
  })
  const empty = await unconfigured.listConversations({})
  assert.equal(empty.configured, false)
  assert.deepEqual(empty.conversations, [])
  await expectCode(() => unconfigured.listMessages({
    conversationId: 'conversation-fixture-000000000001'
  }), 'remote_conversation_directory_not_configured')

  console.log(JSON.stringify({ ok: true, suite: 'remote-conversation-service' }))
}

main().catch((error) => {
  console.error(error?.stack || error)
  process.exitCode = 1
})
