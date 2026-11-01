import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import {Worker} from 'node:worker_threads'
import {EventEmitter, once} from 'node:events'
import {createConversationReader} from '../main/core/remote/conversationReader.js'
import {createConversation, loadRemoteConversationPage} from '../main/core/conversationStore.js'
import {createRemoteConversationMediaService} from '../main/core/remote/conversationMedia.js'

const root = await fs.mkdtemp(path.join(os.tmpdir(), 'anywhere-conversation-worker-'))
let locker
try {
  const deviceId = 'device-conversation-worker-fixture'
  const image = 'data:image/png;base64,' + Buffer.from('synthetic fixture bytes').toString('base64')
  const row = {role: 'user', content: [image, '完整中文😀'], storageId: 'canonical-worker', uiStorageId: 'ui-worker'}
  const first = await createConversation({dirPath: root, title: 'target', sessionData: {fullHistory: [row], chat_show: [row]}})
  const unrelated = await createConversation({dirPath: root, title: 'unrelated', sessionData: {fullHistory: [row], chat_show: [row]}})
  const before = await fs.readFile(path.join(root, 'projects.yaml'))
  locker = new Worker(`const {parentPort,workerData}=require('node:worker_threads');const {DatabaseSync}=require('node:sqlite');const db=new DatabaseSync(workerData);db.exec('BEGIN EXCLUSIVE');parentPort.postMessage(true);parentPort.once('message',()=>{db.exec('ROLLBACK');db.close();parentPort.close()})`, {eval: true, workerData: unrelated.databasePath})
  await once(locker, 'message')
  const factory = () => new Worker(process.env.REMOTE_CONVERSATION_WORKER || new URL('../main/core/remote/conversationWorker.js', import.meta.url))
  const reader = createConversationReader(factory)
  let ticks = 0
  const timer = setInterval(() => ticks++, 5)
  const start = performance.now()
  let opened
  try {opened = await reader.open({dirPath: root, reference: first.descriptor.conversationId})} finally {clearInterval(timer)}
  assert.ok(ticks > 0)
  assert.ok(performance.now() - start < 3500, 'target read never waits on unrelated locked DB')
  assert.equal(opened.descriptor.conversationId, first.descriptor.conversationId)
  assert.deepEqual(opened.sessionData.chat_show[0].content, row.content)
  const media = createRemoteConversationMediaService(), sources = []
  const page = await reader.page({dirPath: root, conversationId: first.descriptor.conversationId, registerMedia: source => {
    sources.push(source)
    return media.register({deviceId, conversationId: first.descriptor.conversationId, source})
  }})
  assert.ok(sources.includes(image))
  assert.ok(!JSON.stringify(page).includes('data:image'))
  const direct = await loadRemoteConversationPage({dirPath: root, conversationId: first.descriptor.conversationId, registerMedia: source => media.register({deviceId, conversationId: first.descriptor.conversationId, source})})
  assert.deepEqual(page, direct, 'worker projection matches production read including original IDs/media')
  assert.deepEqual(await fs.readFile(path.join(root, 'projects.yaml')), before)
  await assert.rejects(reader.open({dirPath: root, reference: 'nonexistent-conversation-fixture'}), {code: 'remote_conversation_not_found'})
  await assert.rejects(reader.open({dirPath: root, reference: 'missing.json'}), {code: 'remote_conversation_not_found'})
  const fake = () => {const worker = new EventEmitter();worker.terminate = () => {};worker.postMessage = () => {};return worker}
  const bounded = createConversationReader(fake, {timeoutMs: 15, concurrency: 1, maxQueued: 1})
  const a = bounded.open({}), b = bounded.open({})
  await assert.rejects(bounded.open({}), {code: 'remote_conversation_read_busy'})
  await Promise.all([assert.rejects(a, {code: 'remote_conversation_read_timeout'}), assert.rejects(b, {code: 'remote_conversation_read_timeout'})])
  console.log(JSON.stringify({ok: true, suite: 'remote-conversation-worker', ticks, coverage: 'read-only target/locked unrelated DB/unchanged index/media/IDs/bounds/no migration'}))
} finally {
  if (locker) {locker.postMessage('release');await once(locker, 'exit')}
  await fs.rm(root, {recursive: true, force: true})
}
