import fs from 'node:fs/promises'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { writeDurableFile, withFileTransaction } from './durableFiles.js'

export const CONFIG_DATABASE_NAME = 'anywhere-desktop.db.json'
const BACKUP_DIRECTORY = 'config-backups'
const KEEP_BACKUPS = 3
const BACKUP_NAME = /^anywhere-desktop\.db\.(\d{4}-\d{2}-\d{2})T(\d{13})-([a-f0-9-]+)\.json$/
let recoveryNotice = null

function object(value) { return value !== null && typeof value === 'object' && !Array.isArray(value) }

export function validateDatabaseBytes(bytes, complete = false) {
  let data
  try { data = JSON.parse(bytes.toString('utf8')) } catch { throw new Error('config_database_invalid') }
  if (!object(data) || !['docs', 'attachments', 'storage'].every(key => object(data[key]))) throw new Error('config_database_invalid')
  // The first initialization writes a valid empty container before config docs exist.
  // Accept that primary database, but never promote it to a recovery generation.
  if ((data.docs.config !== undefined && !object(data.docs.config?.data?.config))
      || ['providers', 'prompts', 'tasks', 'mcpServers'].some(key => data.docs[key] !== undefined && !object(data.docs[key]?.data))
      || (complete && (!object(data.docs.config?.data?.config)
        || !['providers', 'prompts', 'tasks', 'mcpServers'].every(key => object(data.docs[key]?.data))))) {
    throw new Error('config_database_invalid')
  }
  return data
}

const validateBackupBytes = bytes => validateDatabaseBytes(bytes, true)

function localDate(date) {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`
}

function dueDate(now) {
  const date = new Date(now)
  if (date.getHours() < 3) date.setDate(date.getDate() - 1)
  return localDate(date)
}

async function candidates(directory) {
  let entries
  try { entries = await fs.readdir(directory, { withFileTypes: true }) }
  catch (error) { if (error?.code === 'ENOENT') return []; throw error }
  return entries.filter(entry => entry.isFile() && BACKUP_NAME.test(entry.name))
    .map(entry => ({ name: entry.name, date: BACKUP_NAME.exec(entry.name)[1], timestamp: Number(BACKUP_NAME.exec(entry.name)[2]) }))
    .sort((a, b) => b.timestamp - a.timestamp || b.name.localeCompare(a.name))
}

async function validBackups(directory) {
  const valid = []
  for (const entry of await candidates(directory)) {
    try {
      const bytes = await fs.readFile(path.join(directory, entry.name))
      validateBackupBytes(bytes)
      valid.push({ ...entry, bytes })
    } catch (error) {
      if (error?.message !== 'config_database_invalid' && error?.code !== 'ENOENT') throw error
      // A corrupt backup is never a source and is not silently removed as part of rotation.
    }
  }
  return valid
}

export async function prepareConfigurationDatabase(userDataPath) {
  const filePath = path.join(userDataPath, CONFIG_DATABASE_NAME)
  return withFileTransaction(filePath, async () => {
    let original = null
    let missing = false
    try {
      original = await fs.readFile(filePath)
      validateDatabaseBytes(original)
      try { validateBackupBytes(original) }
      catch {
        // A partial primary container is legitimate during the first initialization only.
        // If prior recovery generations exist, do not silently replace missing config docs.
        if ((await candidates(path.join(userDataPath, BACKUP_DIRECTORY))).length) throw new Error('config_database_invalid')
      }
      return { restored: false }
    } catch (error) {
      missing = error?.code === 'ENOENT'
      if (!missing && error?.message !== 'config_database_invalid') throw error
    }
    const directory = path.join(userDataPath, BACKUP_DIRECTORY)
    const backups = await validBackups(directory)
    if (!backups.length) {
      if (missing && !(await candidates(directory)).length) return { restored: false, firstRun: true }
      throw new Error('config_database_damaged_no_valid_backup')
    }
    let preservedPath = ''
    if (original) {
      const recoveryDir = path.join(userDataPath, 'config-recovery')
      await fs.mkdir(recoveryDir, { recursive: true })
      preservedPath = path.join(recoveryDir, `${CONFIG_DATABASE_NAME}.${Date.now()}-${randomUUID()}.corrupt`)
      // Preserve bytes even if empty/all-zero, and flush before replacing the live file.
      await writeDurableFile(preservedPath, original)
    }
    const chosen = backups[0]
    await writeDurableFile(filePath, chosen.bytes, validateBackupBytes)
    validateDatabaseBytes(await fs.readFile(filePath))
    recoveryNotice = { backupDate: chosen.date, preservedPath }
    return { restored: true }
  })
}

export function takeDatabaseRecoveryNotice() {
  const notice = recoveryNotice
  recoveryNotice = null
  return notice
}

export function createDatabaseBackupScheduler({ userDataPath, now = () => new Date() }) {
  const databasePath = path.join(userDataPath, CONFIG_DATABASE_NAME)
  const directory = path.join(userDataPath, BACKUP_DIRECTORY)
  let pending = null
  let timer = null
  let stopped = false
  const check = () => {
    if (stopped) return Promise.resolve()
    if (pending) return pending
    pending = withFileTransaction(databasePath, async () => {
      const date = now()
      const backups = await validBackups(directory)
      if (backups.some(entry => entry.date >= dueDate(date))) return
      const bytes = await fs.readFile(databasePath)
      validateBackupBytes(bytes)
      const name = `anywhere-desktop.db.${dueDate(date)}T${String(date.getTime()).padStart(13, '0')}-${randomUUID()}.json`
      const destination = path.join(directory, name)
      await writeDurableFile(destination, bytes, validateBackupBytes)
      validateBackupBytes(await fs.readFile(destination))
      // Prune only our own regular-file backups, and only after a new validated generation.
      const fresh = await validBackups(directory)
      for (const entry of fresh.slice(KEEP_BACKUPS)) await fs.rm(path.join(directory, entry.name))
    }).finally(() => { pending = null })
    return pending
  }
  return {
    check,
    start() {
      if (timer || stopped) return
      timer = setInterval(() => { void check().catch(error => console.warn('[config-backup] failed:', error?.code || 'backup_failed')) }, 60000)
      timer.unref?.()
      void check().catch(error => console.warn('[config-backup] failed:', error?.code || 'backup_failed'))
    },
    stop() { stopped = true; clearInterval(timer); timer = null }
  }
}
