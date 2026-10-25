import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import {createOperationStorage} from '../main/core/remote/operationStorage.js'
import {createOperationJournal} from '../main/core/remote/operationJournal.js'
const root = await fs.mkdtemp(path.join(os.tmpdir(), 'anywhere-operation-storage-test-'))
const secret = crypto.randomBytes(32)
const encrypt = text => {
  const nonce = crypto.randomBytes(12), cipher = crypto.createCipheriv('aes-256-gcm', secret, nonce)
  const data = Buffer.concat([cipher.update(text, 'utf8'), cipher.final()])
  return Buffer.concat([nonce, cipher.getAuthTag(), data]).toString('base64')
}
const decrypt = text => {
  const bytes = Buffer.from(text, 'base64'), cipher = crypto.createDecipheriv('aes-256-gcm', secret, bytes.subarray(0, 12))
  cipher.setAuthTag(bytes.subarray(12, 28))
  return Buffer.concat([cipher.update(bytes.subarray(28)), cipher.final()]).toString('utf8')
}
let legacy = null, cutovers = 0
const options = {directory: root, encrypt, decrypt, loadLegacy: async () => structuredClone(legacy), markMigrated: async () => {legacy = {version: 2}; cutovers++}}
const now = Date.now()
const input = {deviceId: 'device-storage-fixture', commandId: 'command-storage-fixture', issuedAt: now, method: 'conversation.send', params: {conversationId: 'conversation-storage-fixture', text: 'NO_RAW_PARAMS'}}
try {
  const storage = createOperationStorage(options)
  const journal = createOperationJournal(storage)
  let calls = 0
  await journal.execute(input, async () => {
    calls++
    const onDisk = await createOperationStorage(options).load()
    assert.ok(onDisk.records.some(record => record.commandId === input.commandId), 'durable prewrite before dispatch')
    return {ok: true}
  }, true)
  assert.equal(cutovers, 1)
  await journal.update(input.deviceId, input.commandId, {event: 'assistant.delta', terminal: false, text: 'a', eventSequence: 1})
  const beforePolling = (await fs.stat(storage.file)).size
  for (let i = 0; i < 5; i++) await journal.update(input.deviceId, input.commandId, {event: 'assistant.delta', terminal: false, text: 'a'.repeat(i + 1), eventSequence: i + 2})
  assert.equal((await fs.stat(storage.file)).size, beforePolling, 'progress polling cannot rewrite history')
  await journal.update(input.deviceId, input.commandId, {event: 'assistant.completed', terminal: true, text: 'done', eventSequence: 7})
  const raw = await fs.readFile(storage.file, 'utf8')
  assert.equal(raw.includes(input.commandId), false)
  assert.equal(raw.includes('NO_RAW_PARAMS'), false)
  const restored = createOperationJournal(createOperationStorage(options))
  await restored.execute(input, async () => {calls++; return {ok: true}})
  assert.equal(calls, 1, 'restart must not replay a completed operation')
  // Crash after an accepted prewrite yields interrupted, never redispatched.
  const pending = {...input, commandId: 'command-storage-pending'}
  await journal.execute(pending, async () => ({ok: true}), true)
  const pendingRestart = createOperationJournal(createOperationStorage(options))
  assert.equal((await pendingRestart.get(input.deviceId, pending.commandId)).state, 'interrupted')
  await pendingRestart.execute(pending, async () => {calls++; return {ok: true}})
  assert.equal(calls, 1)
  // Incomplete tail is discarded only; committed ciphertext corruption fails closed.
  await fs.appendFile(storage.file, 'incomplete')
  await createOperationStorage(options).load()
  assert.equal((await fs.readFile(storage.file, 'utf8')).endsWith('\n'), true)
  const corrupted = path.join(root, 'corrupt')
  await fs.mkdir(corrupted)
  await fs.writeFile(path.join(corrupted, 'operations-v2.log'), 'broken-ciphertext\n')
  await assert.rejects(createOperationStorage({...options, directory: corrupted}).load())
  await assert.rejects(createOperationStorage({...options, directory: path.join(root, 'missing')}).load(), {code: 'remote_operation_storage_missing'})

  // Legacy migration is idempotent even when the cutover-marker write fails.
  let old = {version: 1, records: [{deviceId: input.deviceId, commandId: 'legacy-fixture', acceptedAt: now, terminal: true, state: 'succeeded', fingerprint: 'fixture'}]}
  let failMarker = true
  const migration = {...options, directory: path.join(root, 'migration'), loadLegacy: async () => old,
    markMigrated: async () => {if (failMarker) throw new Error('fixture marker failure'); old = {version: 2}}}
  await assert.rejects(createOperationStorage(migration).load(), /marker failure/)
  failMarker = false
  assert.equal((await createOperationStorage(migration).load()).records[0].commandId, 'legacy-fixture')
  assert.equal(old.version, 2)
  const compacted = createOperationStorage({...options, compactBytes: 1})
  await compacted.saveChanges({puts: [{deviceId: input.deviceId, commandId: 'checkpoint-fixture', acceptedAt: now, terminal: true}], removes: []})
  assert.equal((await fs.readFile(storage.file, 'utf8')).trim().split('\n').length, 1)
  assert.ok((await createOperationStorage(options).load()).records.some(record => record.commandId === 'checkpoint-fixture'))
  // Large existing histories append only a single small changed record.
  const bigDir = path.join(root, 'large')
  const seed = {deviceId: input.deviceId, commandId: '', acceptedAt: now, terminal: true, state: 'succeeded', fingerprint: 'x'.repeat(64)}
  const big = createOperationStorage({...options, directory: bigDir, loadLegacy: async () => ({version: 1, records: Array.from({length: 20000}, (_, i) => ({...seed, commandId: `seed-${i}`}))}), markMigrated: async () => {}})
  await big.load()
  const before = (await fs.stat(big.file)).size
  await big.saveChanges({puts: [{...seed, commandId: 'new-small-record'}], removes: []})
  const growth = (await fs.stat(big.file)).size - before
  assert.ok(growth < 2048, `one operation append grew ${growth} bytes`)
  console.log(JSON.stringify({ok: true, suite: 'remote-operation-storage', largeHistoryAppendBytes: growth}))
} finally {await fs.rm(root, {recursive: true, force: true})}
