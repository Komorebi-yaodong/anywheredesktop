import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import {Worker} from 'node:worker_threads'
import {once} from 'node:events'
import {EventEmitter} from 'node:events'
import {createCatalogReader} from '../main/core/remote/catalogReader.js'
import {createConversation} from '../main/core/conversationStore.js'
const root = await fs.mkdtemp(path.join(os.tmpdir(), 'anywhere-catalog-worker-fixture-'))
let locker
try {
  const created = []
  for (let i = 0; i < 8; i++) {
    const item = {role: 'user', content: 'synthetic fixture', storageId: `message-${i}`, uiStorageId: `ui-${i}`}
    created.push(await createConversation({dirPath: root, title: `fixture-${i}`, sessionData: {fullHistory: [item], chat_show: [item]}}))
  }
  await fs.writeFile(path.join(root, 'unrelated.db'), 'unrelated synthetic file')
  const before = await fs.readFile(path.join(root, 'projects.yaml'))
  locker = new Worker(`const {parentPort,workerData}=require('node:worker_threads');const {DatabaseSync}=require('node:sqlite');const dbs=workerData.map(file=>{const db=new DatabaseSync(file);db.exec('BEGIN EXCLUSIVE');return db});parentPort.postMessage(true);parentPort.on('message',()=>{for(const db of dbs){db.exec('ROLLBACK');db.close()}parentPort.close()})`, {eval: true, workerData: created.map(item => item.databasePath)})
  await once(locker, 'message')
  let starts = 0, ticks = 0
  const factory = () => {starts++;return new Worker(process.env.REMOTE_CATALOG_WORKER || new URL('../main/core/remote/catalogWorker.js', import.meta.url))}
  const reader = createCatalogReader(factory)
  const timer = setInterval(() => ticks++, 5)
  const start = performance.now()
  const [first, second] = await Promise.all([reader(root), reader(root)])
  clearInterval(timer)
  assert.equal(starts, 1, 'concurrent scans share one worker')
  assert.equal(first.length, 8, 'locked indexed conversations remain visible')
  assert.ok(ticks > 0, 'main event loop remains free')
  assert.ok(performance.now() - start < 4000, 'does not accumulate SQLite lock waits')
  first[0].title = 'caller mutation';assert.notEqual(second[0].title, first[0].title)
  assert.deepEqual(await fs.readFile(path.join(root, 'projects.yaml')), before, 'remote reader never changes projects index')
  locker.postMessage('release');await once(locker, 'exit');locker = null
  assert.equal((await reader(root)).length, 8);assert.equal(starts, 2, 'no stale permanent scan cache')
  const fake = () => {const worker = new EventEmitter();worker.terminate = () => {};worker.postMessage = () => {};return worker}
  const timeout = createCatalogReader(fake, {timeoutMs: 10})
  await assert.rejects(timeout(root), {code: 'remote_catalog_read_timeout'})
  await assert.rejects(timeout(root), {code: 'remote_catalog_read_timeout'})
  const exit = () => {const worker = fake();worker.postMessage = () => queueMicrotask(() => worker.emit('exit', 1));return worker}
  await assert.rejects(createCatalogReader(exit)(root), {code: 'remote_catalog_read_failed'})
  console.log(JSON.stringify({ok: true, suite: 'remote-catalog-worker', ticks, lockedDatabases: 8}))
} finally {
  if (locker) {locker.postMessage('release');await once(locker, 'exit')}
  await fs.rm(root, {recursive: true, force: true})
}
