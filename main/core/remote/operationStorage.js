import fs from 'node:fs/promises'
import path from 'node:path'
import {remoteError} from './protocol.js'

// Separate from both the chat database and the whole-config JSON store.
// One encrypted, newline-committed delta per write. Compaction atomically replaces
// this same file, so a checkpoint and its following deltas cannot be mismatched.
export function createOperationStorage({directory, encrypt, decrypt, loadLegacy, markMigrated, compactBytes = 8 * 1024 * 1024}) {
  const file = path.join(directory, 'operations-v2.log')
  const temp = path.join(directory, 'operations-v2.next')
  const records = new Map()
  let poisoned = false
  let initialized, tail = Promise.resolve(), appendedBytes = 0
  const key = record => `${record.deviceId}:${record.commandId}`
  const serial = job => {
    const next = tail.catch(() => {}).then(job)
    tail = next.catch(() => {})
    return next
  }
  const encode = value => `${encrypt(JSON.stringify(value))}\n`
  async function checkpoint() {
    const data = encode({version: 2, kind: 'checkpoint', records: [...records.values()]})
    const handle = await fs.open(temp, 'w', 0o600)
    try {await handle.writeFile(data, 'utf8'); await handle.sync()} finally {await handle.close()}
    await fs.rename(temp, file)
    appendedBytes = 0
  }
  function apply(value) {
    if (value?.version !== 2) throw remoteError('remote_operation_storage_invalid')
    if (value.kind === 'checkpoint' && Array.isArray(value.records)) {
      records.clear()
      for (const record of value.records) records.set(key(record), record)
    } else if (value.kind === 'delta' && Array.isArray(value.puts) && Array.isArray(value.removes)) {
      for (const id of value.removes) records.delete(id)
      for (const record of value.puts) records.set(key(record), record)
    } else throw remoteError('remote_operation_storage_invalid')
  }
  async function initialize() {
    if (!initialized) initialized = (async () => {
      await fs.mkdir(directory, {recursive: true, mode: 0o700})
      const legacy = await loadLegacy()
      let data
      try {data = await fs.readFile(file)} catch (error) {if (error.code !== 'ENOENT') throw error}
      if (data) {
        const end = data.lastIndexOf(10) + 1
        if (!end) throw remoteError('remote_operation_storage_invalid')
        const lines = data.subarray(0, end).toString('utf8').split('\n').filter(Boolean)
        for (let index = 0; index < lines.length; index++) {
          const value = JSON.parse(decrypt(lines[index]))
          if (index === 0 && value.kind !== 'checkpoint') throw remoteError('remote_operation_storage_invalid')
          apply(value)
        }
        // An incomplete tail cannot have crossed the durable-before-dispatch barrier.
        if (end < data.length) {
          const handle = await fs.open(file, 'r+')
          try {await handle.truncate(end); await handle.sync()} finally {await handle.close()}
        }
        appendedBytes = 0
      } else {
        if (legacy?.version === 2) throw remoteError('remote_operation_storage_missing')
        if (legacy !== null && (legacy?.version !== 1 || !Array.isArray(legacy.records))) throw remoteError('remote_operation_storage_invalid')
        for (const record of legacy?.records || []) records.set(key(record), record)
        await checkpoint()
      }
      // Never fall back to the old snapshot after this durable cutover.
      if (legacy?.version !== 2) await markMigrated()
    })()
    return initialized
  }
  return {
    load: async () => {await initialize(); return {version: 1, records: [...records.values()].map(record => structuredClone(record))}},
    saveChanges: changes => serial(async () => {
      await initialize()
      const value = {version: 2, kind: 'delta', ...changes}
      const line = encode(value)
      if (poisoned) throw remoteError('remote_operation_storage_failed')
      const handle = await fs.open(file, 'a+', 0o600)
      const size = (await handle.stat()).size
      try {await handle.writeFile(line, 'utf8'); await handle.sync()} catch (error) {
        // A rejected prewrite must not leave a committed record that could race a retry.
        try {await handle.truncate(size); await handle.sync()} catch {poisoned = true}
        throw error
      } finally {await handle.close()}
      apply(value)
      appendedBytes += Buffer.byteLength(line)
      // Maintenance failure never turns an already durable append into a rejected command.
      if (appendedBytes > compactBytes) await checkpoint().catch(() => {})
    }),
    file,
  }
}
