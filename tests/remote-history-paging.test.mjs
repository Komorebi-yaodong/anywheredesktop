import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import {createHistoryPager} from '../main/core/remote/historyPager.js'
import {createRemoteCryptoSession} from '../main/core/remote/cryptoSession.js'
import {structuredPage} from '../main/core/remote/contentBlocks.js'
import {createRemoteConversationMediaService} from '../main/core/remote/conversationMedia.js'
import {createConversation, loadRemoteConversationPage} from '../main/core/conversationStore.js'
const deviceId = 'device-history-page-fixture'
const conversationId = 'conversation-history-page-fixture'
const pager = createHistoryPager()
const payload = content => ({content, reasoningContent: '', summary: '', summaryPrefix: '', toolCalls: [], timestamp: '', completedTimestamp: '', aiName: '', voiceName: '', status: ''})
const rows = Array.from({length: 75}, (_, index) => ({messageId: `canonical-${index}`, uiMessageId: `ui-${index}`, role: index % 2 ? 'assistant' : 'user', order: index + 1, payload: payload(('中文😀正文'+index).repeat(800))}))
rows[39].payload = payload('完整超长😀消息'.repeat(40000))
const ids = []
let before = Infinity
const session = createRemoteCryptoSession({sessionId: 'session-history-page-fixture', sendKey: crypto.randomBytes(32), receiveKey: crypto.randomBytes(32), sendDirection: 'desktop-to-client', receiveDirection: 'client-to-desktop'})
while (before !== null) {
 const candidates = rows.filter(row => row.order < before).slice(-50)
 const original = {ok: true, conversation: {conversationId, revision: 1}, messages: candidates, tasks: [], page: {pageSize: 50, hasMore: rows.some(row => row.order < candidates[0]?.order), nextBeforeUiOrder: candidates[0]?.order}}
 const page = pager.page(original, deviceId, conversationId)
 const frame = session.encrypt({kind: 'response', requestId: 'request-history-page-fixture', ok: true, result: {page: structuredPage(page), runtime: {conversationId}}})
 assert.ok(Buffer.byteLength(JSON.stringify(frame)) < 262144)
 for (const message of page.messages) {
   ids.push(message.uiMessageId)
   const ref = message.payload.fullPayload
   if (ref) {
     assert.throws(() => pager.chunk({deviceId: 'foreign-device-fixture', params: {conversationId, id: ref.id, offset: 0}}), {code: 'remote_history_part_expired'})
     let text = '', offset = 0
     while (offset < ref.totalChars) {
       const chunk = pager.chunk({deviceId, params: {conversationId, id: ref.id, offset}})
       session.encrypt({kind: 'response', requestId: 'chunk-history-fixture', ok: true, result: chunk})
       text += chunk.text; offset = chunk.nextOffset
     }
     assert.deepEqual(JSON.parse(text), rows.find(row => row.uiMessageId === message.uiMessageId).payload)
     assert.equal(crypto.createHash('sha256').update(text).digest('hex'), ref.sha256)
   } else assert.deepEqual(message, rows.find(row => row.uiMessageId === message.uiMessageId))
 }
 before = page.page.hasMore ? page.page.nextBeforeUiOrder : null
}
assert.equal(new Set(ids).size, rows.length)
assert.equal(ids.length, rows.length)
session.close()
const root = await fs.mkdtemp(path.join(os.tmpdir(), 'anywhere-history-media-'))
try {
 const image = 'data:image/png;base64,' + Buffer.from('synthetic image bytes').toString('base64')
 const audio = 'data:audio/wav;base64,' + Buffer.from('synthetic audio bytes').toString('base64')
 const video = 'data:video/mp4;base64,' + Buffer.from('synthetic video bytes').toString('base64')
 const messages = [
   {role: 'user', content: 'covered-before-summary', storageId: 'covered-message', uiStorageId: 'covered-ui'},
   {role: 'compaction', content: 'summary kept', summary: 'summary kept', snapshotId: 'summary-fixture', storageId: 'summary-message', uiStorageId: 'summary-ui'},
   {role: 'user', origin: 'view_image', content: [{type: 'text', text: 'tool image context kept'}, {type: 'image_url', image_url: {url: image, detail: 'high'}}], storageId: 'tool-image-message', uiStorageId: 'tool-image-ui'},
   {role: 'user', content: [image, audio, video, {type: 'file', name: 'fixture.pdf', file_data: 'data:application/pdf;base64,JVBERg=='}], storageId: 'direct-media', uiStorageId: 'direct-media-ui'},
   {role: 'assistant', content: 'assistant summary is still assistant', storageId: 'assistant-summary', uiStorageId: 'assistant-summary-ui'},
 ]
 const created = await createConversation({dirPath: root, title: 'Synthetic', sessionData: {fullHistory: messages, chat_show: messages}})
 const cid = created.descriptor.conversationId
 const media = createRemoteConversationMediaService()
 const page = await loadRemoteConversationPage({dirPath: root, conversationId: cid, registerMedia: source => media.register({deviceId, conversationId: cid, source})})
 assert.equal(page.messages.length, 4)
 assert.equal(page.page.hasMore, false)
 assert.equal(page.messages[1].role, 'user')
 assert.equal(page.messages[1].payload.content[0].text, 'tool image context kept')
 assert.match(page.messages[1].payload.content[1].url, /^anywhere-media:/)
 assert.deepEqual(page.messages[2].payload.content.map(part => part.type), ['image', 'audio', 'video', 'file'])
 assert.equal(page.messages[3].role, 'assistant')
 assert.equal(JSON.stringify(page).includes(';base64,'), false)
 for (const part of page.messages[2].payload.content.slice(0, 3)) {
   const id = part.url.split('://')[1].split('?')[0]
   const data = await media.get({deviceId, params: {conversationId: cid, mediaId: id, offset: 0, length: 96}})
   assert.ok(data.byteLength > 0)
   assert.match(data.mimeType, /^(image|audio|video)\//)
 }
 assert.equal((await loadRemoteConversationPage({dirPath: root, conversationId: cid, beforeUiOrder: page.messages[0].order})).messages.length, 0)
} finally {await fs.rm(root, {recursive: true, force: true})}
console.log(JSON.stringify({ok: true, suite: 'remote-history-paging', coverage: 'all rows, chunks, roles, compaction, image/audio/video/PDF'}))
