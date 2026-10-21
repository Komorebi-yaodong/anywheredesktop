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
    const isToolOnlyAssistant = index === 4
    const message = {
      role: index % 2 === 1 ? 'user' : 'assistant',
      content: isToolOnlyAssistant
        ? ''
        : isLast
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
        : index === 1
          ? 'opened E:\\TMP\\Images\\station_zero_poster.png for review'
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
      tool_calls: isToolOnlyAssistant
        ? [{
            id: 'tool-secret',
            function: { name: 'read_file', arguments: JSON.stringify({ file_path: 'E:/secret/private.txt' }) },
            approvalStatus: 'finished',
            result: 'SECRET_TOOL_RESULT'
          }]
        : []
    }
    messages.push(message)
    const uiMessage = { ...message }
    if (isToolOnlyAssistant) delete uiMessage.timestamp
    if (isToolOnlyAssistant) {
      // Actual Desktop tool-loop bubbles carry startTime, while both canonical
      // and UI timestamp fields can be absent. Never synthesize a read-time clock.
      delete message.timestamp
      uiMessage.startTime = Date.parse('2026-01-01T00:00:04.000Z')
      uiMessage.endTime = Date.parse('2026-01-01T00:00:06.000Z')
    }

    chatShow.push(uiMessage)
  }

  return {
    anywhere_history: true,
    CODE: 'Zero',
    model: 'fixture-provider|fixture-model',
    currentPromptConfig: {
      // This stale snapshot deliberately reproduces the Mobile-only display bug.
      name: 'Fixture Provider | fixture-model',
      icon: 'https://snapshot.example/incorrect-agent.png',
      modelProviderName: 'Fixture Provider'
    },
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
      pageSize: 2,
      providerNames: {'fixture-provider': 'Fixture Provider'},
      agentIdentities: {
        Zero: {code: 'Zero', name: 'Zero', avatarUrl: 'https://agents.example/zero.png'}
      }
    })
    assert.equal(first.ok, true)
    assert.equal(first.conversation.conversationId, conversationId)
    assert.deepEqual(first.conversation.project, {
      projectId: 'project-fixture',
      name: 'Remote Fixture Project'
    })

    assert.deepEqual(first.conversation.assistant, {
      code: 'Zero',
      name: 'Zero',
      avatarUrl: 'https://agents.example/zero.png'
    })
    assert.equal(first.conversation.model, 'Fixture Provider | fixture-model')


    const fallback = await store.loadRemoteConversationPage({
      dirPath: root,
      conversationId,
      pageSize: 2,
      providerNames: {'fixture-provider': 'Fixture Provider'},
      agentIdentities: {}
    })
    assert.deepEqual(fallback.conversation.assistant, {
      code: '',
      name: 'Fixture Provider | fixture-model',
      avatarUrl: 'https://snapshot.example/incorrect-agent.png'
    })
    assert.equal(first.page.hasMore, true)
    assert.equal(first.page.nextBeforeUiOrder, 5)
    assert.deepEqual(first.messages.map((message) => message.role), ['assistant', 'user'])
    assert.deepEqual(first.messages.map((message) => message.uiMessageId), ['ui-4', 'ui-5'])

    const toolOnlyAssistant = first.messages.find((message) => message.uiMessageId === 'ui-4')
    assert.equal(toolOnlyAssistant?.payload.timestamp, '2026-01-01T00:00:04.000Z')
    assert.equal(toolOnlyAssistant?.payload.completedTimestamp, '2026-01-01T00:00:06.000Z')
    assert.deepEqual(toolOnlyAssistant?.payload.toolCalls, [{ id: 'tool-secret', name: 'read_file', status: 'finished', arguments: {}, result: '[已隐藏敏感内容]' }])
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
    // The paired developer device reads conversation text verbatim; absolute
    // paths are no longer replaced by a placeholder.
    assert.match(third.messages[0].payload.content, /E:\\TMP\\Images\\station_zero_poster\.png/)
    assert.equal(third.messages[0].payload.content.includes('[local-file-hidden]'), false)
    assert.equal(third.page.pageSize, 100)
    assert.equal(third.page.hasMore, false)
    assert.equal(third.page.nextBeforeUiOrder, null)


    const mediaLease = await store.acquireWriteLease({
      dirPath: root,
      conversationId,
      holderInstanceId: 'remote-read-media-fixture',
      holderApp: 'desktop'
    })
    const mediaForms = await store.saveConversationSnapshot({
      dirPath: root,
      conversationId,
      expectedRevision: 0,
      holderInstanceId: 'remote-read-media-fixture',
      leaseEpoch: mediaLease.leaseEpoch,
      sessionData: {
        ...buildSession(),
        chat_show: [{
          role: 'assistant',
          content: [
            '![one](file:///C:/synthetic/image.png)',
            '<video><source src="file://C:/synthetic/clip.mp4"></video>',
            '<audio src="file:C:/synthetic/sound.mp3"></audio>',

            '![remote](https://media.example/fixture.png)',
            '<audio controls><source src="https://media.example/fixture.mp3" type="audio/mpeg"></audio>',
            '已存储：C:/synthetic/prose.mp3'
          ].join('\n'),
          storageId: 'media-forms',
          uiStorageId: 'ui-media-forms'
        }],
        fullHistory: [{
          role: 'assistant',
          content: [
            '![one](file:///C:/synthetic/image.png)',
            '<video><source src="file://C:/synthetic/clip.mp4"></video>',
            '<audio src="file:C:/synthetic/sound.mp3"></audio>',
            '已存储：C:/synthetic/prose.mp3'
          ].join('\n'),
          storageId: 'media-forms'
        }]
      }
    })
    assert.equal(mediaForms.ok, true)
    let mediaIndex = 0
    const registeredSources = []
    const mediaPage = await store.loadRemoteConversationPage({
      dirPath: root,
      conversationId,
      pageSize: 10,
      registerMedia: (source) => {
        registeredSources.push(String(source))
        const kind = /\.mp3$/i.test(String(source)) ? 'audio' : /\.(?:mp4|webm|mov|m4v)$/i.test(String(source)) ? 'video' : 'image'
        return { uri: `anywhere-media://${String(++mediaIndex).padStart(16, 'a')}?type=${kind}` }
      }
    })
    const mediaText = JSON.stringify(mediaPage)

    assert.match(mediaText, /https:\/\/media\.example\/fixture\.png/)
    assert.match(mediaText, /https:\/\/media\.example\/fixture\.mp3/)
    assert.equal(registeredSources.some((source) => /^https?:\/\//i.test(source)), false)
    assert.match(mediaText, /C:\/synthetic\/image\.png/)
    assert.match(mediaText, /C:\/synthetic\/clip\.mp4/)
    assert.match(mediaText, /C:\/synthetic\/sound\.mp3/)
    assert.match(mediaText, /C:\/synthetic\/prose\.mp3/)
    assert.equal(registeredSources.includes('C:/synthetic/prose.mp3'), false, 'bare prose paths must not append a duplicate scoped media preview')
    assert.equal(mediaText.includes('local-file-hidden'), false)
    assert.match(mediaText, /anywhere-media:\/\/[A-Za-z0-9_-]{16,160}\?type=image/)
    assert.match(mediaText, /anywhere-media:\/\/[A-Za-z0-9_-]{16,160}\?type=video/)
    assert.match(mediaText, /anywhere-media:\/\/[A-Za-z0-9_-]{16,160}\?type=audio/)
    // Use synthetic extracted Office parts, not real document files. Their
    // original text stays durable on Desktop but must not inflate Mobile DTOs.
    const officeBody = 'SYNTHETIC_OFFICE_BODY'.repeat(40000)
    const officePathText = '`E:\\Synthetic\\论文.docx`\n`E:\\Synthetic\\数据.xlsx`\n我正在写论文'
    const officeContent = [
      {type: 'text', text: officePathText},
      {type: 'text', text: `file name:fixture.docx\nfile content:\n${officeBody}\nfile end`},
      {type: 'text', text: `file name:fixture.xlsx\nfile content:\n${officeBody}\nfile end`},
      {type: 'document', name: 'structured.xlsx', content: officeBody, data: officeBody},
      {type: 'image', url: 'E:/Synthetic/not-an-image.docx'}
    ]
    await store.saveConversationSnapshot({dirPath: root, conversationId, expectedRevision: mediaForms.revision,
      holderInstanceId: 'remote-read-media-fixture', leaseEpoch: mediaLease.leaseEpoch,
      sessionData: {...buildSession(), fullHistory: [{role: 'user', storageId: 'office-fixture', content: officeContent}],
        chat_show: [{role: 'user', storageId: 'office-fixture', uiStorageId: 'ui-office-fixture', content: officeContent}]}})
    const unexpectedMedia = []
    const officePage = await store.loadRemoteConversationPage({dirPath: root, conversationId, registerMedia: source => {unexpectedMedia.push(source); throw new Error('documents must not register media')}})
    const officeDto = JSON.stringify(officePage)
    assert.equal(officeDto.includes('SYNTHETIC_OFFICE_BODY'), false)
    assert.ok(officeDto.includes('fixture.docx') && officeDto.includes('fixture.xlsx') && officeDto.includes('structured.xlsx'))
    assert.equal(officePage.messages[0].payload.content[0].text, officePathText)
    assert.equal(unexpectedMedia.length, 0)
    assert.ok(Buffer.byteLength(officeDto) < 8192)
    const {createRemoteCryptoSession} = await import('../main/core/remote/cryptoSession.js')
    const keyA = Buffer.alloc(32, 1), keyB = Buffer.alloc(32, 2)
    const sender = createRemoteCryptoSession({sessionId: 'office-synthetic-session', sendKey: Buffer.from(keyA), receiveKey: Buffer.from(keyB), sendDirection: 'desktop-to-client', receiveDirection: 'client-to-desktop'})
    const receiver = createRemoteCryptoSession({sessionId: 'office-synthetic-session', sendKey: Buffer.from(keyB), receiveKey: Buffer.from(keyA), sendDirection: 'client-to-desktop', receiveDirection: 'desktop-to-client'})
    const wire = sender.encrypt({kind: 'response', requestId: 'office-synthetic-request', ok: true, result: officePage})
    assert.deepEqual(receiver.decrypt(wire).result, officePage)
    assert.equal(receiver.decrypt(sender.encrypt({kind: 'response', ok: true, result: {ping: true}})).result.ping, true)
    sender.close(); receiver.close()
    const desktopOriginal = await store.openConversation({dirPath: root, reference: conversationId})
    assert.ok(JSON.stringify(desktopOriginal.sessionData).includes(officeBody))


    const {replaceConversationEditableText} = await import('../render/window/utils/conversationEditableText.js')
    let edited = replaceConversationEditableText(desktopOriginal.sessionData.fullHistory[0].content, 'Edited user input')
    edited = replaceConversationEditableText(edited, 'Newest user input')
    const editedSaved = await store.saveConversationSnapshot({dirPath: root, conversationId, expectedRevision: desktopOriginal.descriptor.revision,
      holderInstanceId: 'remote-read-media-fixture', leaseEpoch: mediaLease.leaseEpoch,
      sessionData: {...desktopOriginal.sessionData, fullHistory: [{...desktopOriginal.sessionData.fullHistory[0], content: edited}],
        chat_show: [{...desktopOriginal.sessionData.chat_show[0], content: edited}]}})
    assert.equal(editedSaved.ok, true)
    const reopened = await store.openConversation({dirPath: root, reference: conversationId})
    assert.equal(reopened.sessionData.fullHistory[0].content[0].text, 'Newest user input')
    assert.equal(reopened.sessionData.fullHistory[0].content[1].text, officeContent[1].text)
    assert.equal(reopened.sessionData.fullHistory[0].content[2].text, officeContent[2].text)
    const nextRequest = await store.getConversationRequestMessages({dirPath: root, conversationId})
    const requestContent = nextRequest.messages.find(message => message.storageId === 'office-fixture').content
    assert.equal(requestContent[0].text, 'Newest user input')
    assert.equal(requestContent[1].text, officeContent[1].text)
    assert.equal(requestContent[2].text, officeContent[2].text)


    await store.releaseWriteLease({ dirPath: root, conversationId, holderInstanceId: 'remote-read-media-fixture', leaseEpoch: mediaLease.leaseEpoch })

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
