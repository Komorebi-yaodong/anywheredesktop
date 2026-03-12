import fs from 'node:fs/promises'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { app } from 'electron'
import { Low } from 'lowdb'
import { JSONFile } from 'lowdb/node'
import { safeClone } from '../dataConverter.js'

const DB_FILE_NAME = 'anywhere-desktop.db.json'
const ATTACHMENTS_DIR_NAME = 'attachments'

const DEFAULT_DATA = {
  docs: {},
  attachments: {},
  storage: {}
}

let dbPromise = null

function ensureValidString(value, fieldName) {
  if (typeof value !== 'string' || !value.trim()) {
    throw new Error(`[db] ${fieldName} is required`)
  }

  return value.trim()
}

function toSafeSegment(value) {
  return value.replace(/[<>:"/\\|?*\x00-\x1F]/g, '_').slice(0, 120) || 'unknown'
}

function nextRev(prevRev = '') {
  const prevNum = Number.parseInt(String(prevRev).split('-')[0], 10)
  const currentNum = Number.isFinite(prevNum) ? prevNum : 0
  return `${currentNum + 1}-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`
}

async function ensureDb() {
  if (dbPromise) return dbPromise

  dbPromise = (async () => {
    const userDataPath = app.getPath('userData')
    await fs.mkdir(userDataPath, { recursive: true })

    const dbFilePath = path.join(userDataPath, DB_FILE_NAME)
    const adapter = new JSONFile(dbFilePath)
    const db = new Low(adapter, safeClone(DEFAULT_DATA))

    await db.read()

    if (!db.data || typeof db.data !== 'object') {
      db.data = safeClone(DEFAULT_DATA)
    }

    if (!db.data.docs || typeof db.data.docs !== 'object') db.data.docs = {}
    if (!db.data.attachments || typeof db.data.attachments !== 'object') db.data.attachments = {}
    if (!db.data.storage || typeof db.data.storage !== 'object') db.data.storage = {}

    await db.write()
    return db
  })()

  return dbPromise
}

function toDocSnapshot(doc) {
  return safeClone(doc)
}

function resolveAttachmentBase64FromDataUrl(dataUrl) {
  if (typeof dataUrl !== 'string') return null
  const match = dataUrl.match(/^data:.*?;base64,(.+)$/)
  if (!match) return null
  return match[1]
}

async function resolveAttachmentBuffer(input = {}) {
  if (Buffer.isBuffer(input)) return input

  if (Buffer.isBuffer(input.buffer)) return input.buffer

  if (typeof input.base64 === 'string' && input.base64.trim()) {
    return Buffer.from(input.base64, 'base64')
  }

  if (typeof input.buffer === 'string' && input.buffer.trim()) {
    return Buffer.from(input.buffer, 'base64')
  }

  if (Array.isArray(input.buffer?.data)) {
    return Buffer.from(input.buffer.data)
  }

  if (typeof input.dataUrl === 'string') {
    const base64 = resolveAttachmentBase64FromDataUrl(input.dataUrl)
    if (base64) return Buffer.from(base64, 'base64')
  }

  if (typeof input.path === 'string' && input.path.trim()) {
    return fs.readFile(input.path)
  }

  if (input.file && typeof input.file === 'object') {
    if (typeof input.file.buffer === 'string' && input.file.buffer.trim()) {
      return Buffer.from(input.file.buffer, 'base64')
    }

    if (typeof input.file.path === 'string' && input.file.path.trim()) {
      return fs.readFile(input.file.path)
    }
  }

  throw new Error('[db] attachment payload is required (base64/dataUrl/path/file)')
}

function resolveAttachmentKey(db, input = {}) {
  if (typeof input.key === 'string' && input.key.trim()) {
    const key = input.key.trim()
    const attachment = db.data.attachments[key]
    return { key, attachment: attachment || null }
  }

  const docId = typeof input.docId === 'string' ? input.docId.trim() : ''
  const attachmentId =
    typeof input.attachmentId === 'string'
      ? input.attachmentId.trim()
      : typeof input.name === 'string'
        ? input.name.trim()
        : ''

  if (!docId || !attachmentId) {
    return { key: null, attachment: null }
  }

  const directKey = `${docId}::${attachmentId}`
  if (db.data.attachments[directKey]) {
    return { key: directKey, attachment: db.data.attachments[directKey] }
  }

  const fallback = Object.entries(db.data.attachments).find(([, item]) => {
    if (!item || typeof item !== 'object') return false
    return item.docId === docId && (item.id === attachmentId || item.name === attachmentId)
  })

  if (!fallback) {
    return { key: directKey, attachment: null }
  }

  return { key: fallback[0], attachment: fallback[1] }
}

export async function put(doc = {}) {
  const id = ensureValidString(doc._id, '_id')
  const db = await ensureDb()
  const existing = db.data.docs[id]

  if (existing && doc._rev && doc._rev !== existing._rev) {
    return {
      ok: false,
      name: 'conflict',
      error: 'conflict',
      message: `[db] revision mismatch for doc '${id}'`
    }
  }

  const now = Date.now()
  const nextDoc = {
    ...(existing ? toDocSnapshot(existing) : {}),
    ...toDocSnapshot(doc),
    _id: id,
    _rev: nextRev(existing?._rev),
    createdAt: existing?.createdAt || now,
    updatedAt: now
  }

  db.data.docs[id] = nextDoc
  await db.write()

  return {
    ok: true,
    id,
    rev: nextDoc._rev,
    doc: toDocSnapshot(nextDoc)
  }
}

export async function get(id) {
  const targetId = ensureValidString(id, 'id')
  const db = await ensureDb()
  const doc = db.data.docs[targetId]

  if (!doc) {
    return {
      ok: false,
      error: 'not_found',
      id: targetId,
      doc: null
    }
  }

  return {
    ok: true,
    id: targetId,
    doc: toDocSnapshot(doc)
  }
}

export async function remove(id, rev = '') {
  const targetId = ensureValidString(id, 'id')
  const db = await ensureDb()
  const existing = db.data.docs[targetId]

  if (!existing) {
    return {
      ok: false,
      error: 'not_found',
      id: targetId
    }
  }

  if (typeof rev === 'string' && rev && rev !== existing._rev) {
    return {
      ok: false,
      name: 'conflict',
      error: 'conflict',
      message: `[db] revision mismatch for doc '${targetId}'`
    }
  }

  const removedAttachmentKeys = []

  for (const [key, attachment] of Object.entries(db.data.attachments)) {
    if (!attachment || attachment.docId !== targetId) continue

    removedAttachmentKeys.push(key)

    try {
      if (typeof attachment.path === 'string' && attachment.path) {
        await fs.unlink(attachment.path)
      }
    } catch {
      // ignore file remove errors to keep db state consistent
    }

    delete db.data.attachments[key]
  }

  delete db.data.docs[targetId]
  await db.write()

  return {
    ok: true,
    id: targetId,
    rev: nextRev(existing._rev),
    removedAttachmentKeys
  }
}

export async function allDocs(options = {}) {
  const db = await ensureDb()
  const includeDocs = options.includeDocs !== false
  const ids = Object.keys(db.data.docs).sort((a, b) => a.localeCompare(b))

  const rows = ids.map((id) => ({
    id,
    doc: includeDocs ? toDocSnapshot(db.data.docs[id]) : undefined
  }))

  return {
    ok: true,
    total_rows: rows.length,
    rows
  }
}

export async function bulkDocs(docs = []) {
  if (!Array.isArray(docs)) {
    throw new Error('[db] bulkDocs expects an array')
  }

  const results = []
  for (const item of docs) {
    try {
      const result = await put(item)
      results.push(result)
    } catch (error) {
      results.push({
        ok: false,
        error: String(error?.message || error)
      })
    }
  }

  return {
    ok: true,
    results
  }
}

export async function postAttachment(input = {}) {
  const docId = ensureValidString(input.docId, 'docId')
  const attachmentId = ensureValidString(
    typeof input.attachmentId === 'string' ? input.attachmentId : input.name,
    'attachmentId/name'
  )

  const db = await ensureDb()
  const doc = db.data.docs[docId]

  if (!doc) {
    return {
      ok: false,
      error: 'not_found',
      message: `[db] doc '${docId}' not found`
    }
  }

  const buffer = await resolveAttachmentBuffer(input)
  const now = Date.now()
  const key = `${docId}::${attachmentId}`
  const previous = db.data.attachments[key]

  const userDataPath = app.getPath('userData')
  const docDir = path.join(userDataPath, ATTACHMENTS_DIR_NAME, toSafeSegment(docId))
  await fs.mkdir(docDir, { recursive: true })

  const fileName = `${toSafeSegment(attachmentId)}.bin`
  const filePath = path.join(docDir, fileName)

  await fs.writeFile(filePath, buffer)

  const metadata = {
    key,
    docId,
    id: attachmentId,
    name: typeof input.name === 'string' && input.name.trim() ? input.name.trim() : attachmentId,
    contentType:
      typeof input.contentType === 'string' && input.contentType.trim()
        ? input.contentType.trim()
        : 'application/octet-stream',
    path: filePath,
    size: buffer.byteLength,
    createdAt: previous?.createdAt || now,
    updatedAt: now
  }

  db.data.attachments[key] = metadata

  const nextDoc = toDocSnapshot(doc)
  nextDoc._attachments = {
    ...(nextDoc._attachments || {}),
    [attachmentId]: {
      key,
      contentType: metadata.contentType,
      size: metadata.size,
      updatedAt: now
    }
  }
  nextDoc._rev = nextRev(nextDoc._rev)
  nextDoc.updatedAt = now
  db.data.docs[docId] = nextDoc

  await db.write()

  return {
    ok: true,
    key,
    id: attachmentId,
    docId,
    rev: nextDoc._rev,
    metadata: toDocSnapshot(metadata)
  }
}

export async function getAttachment(input = {}) {
  const db = await ensureDb()
  const { key, attachment } = resolveAttachmentKey(db, input)

  if (!key || !attachment) {
    return {
      ok: false,
      error: 'not_found',
      key: key || null
    }
  }

  const readMode =
    typeof input.as === 'string' && ['base64', 'buffer', 'path'].includes(input.as) ? input.as : 'base64'

  if (readMode === 'path') {
    return {
      ok: true,
      key,
      path: attachment.path,
      metadata: toDocSnapshot(attachment)
    }
  }

  const buffer = await fs.readFile(attachment.path)

  if (readMode === 'buffer') {
    return {
      ok: true,
      key,
      buffer,
      metadata: toDocSnapshot(attachment)
    }
  }

  return {
    ok: true,
    key,
    base64: buffer.toString('base64'),
    encoding: 'base64',
    metadata: toDocSnapshot(attachment)
  }
}

export async function dbStorageSetItem(key, value) {
  const targetKey = ensureValidString(key, 'key')
  const db = await ensureDb()

  db.data.storage[targetKey] = toDocSnapshot(value)
  await db.write()

  return {
    ok: true,
    key: targetKey
  }
}

export async function dbStorageGetItem(key, fallback = null) {
  const targetKey = ensureValidString(key, 'key')
  const db = await ensureDb()

  if (!Object.prototype.hasOwnProperty.call(db.data.storage, targetKey)) {
    return {
      ok: true,
      key: targetKey,
      value: toDocSnapshot(fallback)
    }
  }

  return {
    ok: true,
    key: targetKey,
    value: toDocSnapshot(db.data.storage[targetKey])
  }
}

export async function dbStorageRemoveItem(key) {
  const targetKey = ensureValidString(key, 'key')
  const db = await ensureDb()

  const existed = Object.prototype.hasOwnProperty.call(db.data.storage, targetKey)
  if (existed) {
    delete db.data.storage[targetKey]
    await db.write()
  }

  return {
    ok: true,
    key: targetKey,
    existed
  }
}

export async function dbStorageListKeys() {
  const db = await ensureDb()
  return {
    ok: true,
    keys: Object.keys(db.data.storage).sort((a, b) => a.localeCompare(b))
  }
}

export async function getDbStats() {
  const db = await ensureDb()
  return {
    ok: true,
    docsCount: Object.keys(db.data.docs).length,
    attachmentsCount: Object.keys(db.data.attachments).length,
    storageKeysCount: Object.keys(db.data.storage).length
  }
}

export async function createDocIfMissing(id, defaultData = {}) {
  const targetId = ensureValidString(id, 'id')
  const db = await ensureDb()

  const existing = db.data.docs[targetId]
  if (existing) {
    return {
      ok: true,
      created: false,
      doc: toDocSnapshot(existing)
    }
  }

  const now = Date.now()
  const doc = {
    _id: targetId,
    _rev: nextRev('0'),
    data: toDocSnapshot(defaultData),
    createdAt: now,
    updatedAt: now
  }

  db.data.docs[targetId] = doc
  await db.write()

  return {
    ok: true,
    created: true,
    doc: toDocSnapshot(doc)
  }
}

export async function isDbReady() {
  await ensureDb()
  return { ok: true }
}
