import fs from 'node:fs/promises'
import path from 'node:path'
import crypto from 'node:crypto'
import { DatabaseSync, backup as sqliteBackup } from 'node:sqlite'

import {
  assignConversationProject,
  findConversation,
  findProjectByBasename,
  readLocalProjects,
  registerConversation,
  removeConversation as removeConversationFromProjects,
  updateConversation,
  writeLocalProjects,
  writeLocalProjectsBestEffort
} from './projects.js'

const SCHEMA_VERSION = 1
const DB_EXTENSION = '.db'
const MIGRATION_LOCK_TTL_MS = 2 * 60 * 1000
const WRITE_LEASE_TTL_MS = 20 * 1000
const DEFAULT_BUSY_TIMEOUT_MS = 4000
const ATTACHMENT_REF_KEY = '__anywhere_attachment_ref'
const LEGACY_JSON_PROBE_BYTES = 64 * 1024

async function isLegacyConversationJson(filePath, fileSize = 0) {
  const readLength = Math.min(Math.max(0, Number(fileSize) || LEGACY_JSON_PROBE_BYTES), LEGACY_JSON_PROBE_BYTES)
  if (readLength <= 0) return false

  let handle
  try {
    handle = await fs.open(filePath, 'r')
    const buffer = Buffer.allocUnsafe(readLength)
    const { bytesRead } = await handle.read(buffer, 0, readLength, 0)
    const head = buffer.toString('utf8', 0, bytesRead)
    return /["']anywhere_history["']\s*:\s*true\b/.test(head)
  } catch {
    return false
  } finally {
    await handle?.close().catch(() => {})
  }
}


const nowIso = () => new Date().toISOString()
const clone = (value) => JSON.parse(JSON.stringify(value ?? null))
const normalizeText = (value, fallback = '') => typeof value === 'string' ? value : (value == null ? fallback : String(value))
const normalizeBasename = (value = '') => path.basename(normalizeText(value).trim())


function normalizeTimestamp(value) {
  if (value == null || value === '') return ''
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? '' : date.toISOString()
}

function collectSessionTimestamps(sessionData = {}) {
  const timestamps = []
  for (const messages of [sessionData.fullHistory, sessionData.history, sessionData.chat_show]) {
    if (!Array.isArray(messages)) continue
    for (const message of messages) {
      for (const candidate of [message?.createdAt, message?.timestamp, message?.updatedAt, message?.completedTimestamp]) {
        const normalized = normalizeTimestamp(candidate)
        if (normalized) timestamps.push(normalized)
      }
    }
  }
  return timestamps.sort((a, b) => new Date(a).getTime() - new Date(b).getTime())
}

function resolveConversationTimestamps(sessionData = {}, fileStats = null) {
  const metadata = sessionData?.sessionMetadata && typeof sessionData.sessionMetadata === 'object'
    ? sessionData.sessionMetadata
    : {}
  const messageTimestamps = collectSessionTimestamps(sessionData)
  const fileCreatedAt = normalizeTimestamp(fileStats?.birthtime) || normalizeTimestamp(fileStats?.ctime) || normalizeTimestamp(fileStats?.mtime)
  const fileUpdatedAt = normalizeTimestamp(fileStats?.mtime) || fileCreatedAt
  const createdAt = normalizeTimestamp(metadata.createdAt) || messageTimestamps[0] || fileCreatedAt || nowIso()
  const updatedAt = normalizeTimestamp(metadata.updatedAt) || messageTimestamps.at(-1) || fileUpdatedAt || createdAt
  return { createdAt, updatedAt }
}

function createConversationId() {
  return crypto.randomUUID()
}

function createDatabaseFilename(conversationId) {
  return `c${String(conversationId).replace(/-/g, '')}${DB_EXTENSION}`
}

function resolveDatabasePath(dirPath, dbFile) {
  const dir = path.resolve(normalizeText(dirPath).trim())
  const basename = normalizeBasename(dbFile)
  if (!dir || !basename || !basename.toLowerCase().endsWith(DB_EXTENSION)) throw new Error('conversation_database_path_invalid')
  return path.join(dir, basename)
}

function openDatabase(databasePath, { readOnly = false } = {}) {
  const db = new DatabaseSync(databasePath, {
    readOnly,
    timeout: DEFAULT_BUSY_TIMEOUT_MS,
    enableForeignKeyConstraints: true
  })
  db.exec(`
    PRAGMA foreign_keys = ON;
    PRAGMA busy_timeout = ${DEFAULT_BUSY_TIMEOUT_MS};
  `)
  if (!readOnly) {
    db.exec(`
      PRAGMA journal_mode = DELETE;
      PRAGMA synchronous = FULL;
    `)
  }
  return db
}

function descriptorFromConversationRow(row, dbFile, existing = {}) {
  const conversationId = normalizeText(row?.conversation_id).trim()
  if (!conversationId) return null
  const createdAt = normalizeTimestamp(row?.created_at)
  const updatedAt = normalizeTimestamp(row?.updated_at) || createdAt
  return {
    conversationId,
    dbFile,
    title: normalizeText(row?.title).trim() || normalizeText(existing?.title).trim() || conversationId,
    legacyJson: normalizeBasename(existing?.legacyJson || row?.legacy_json),
    storageMode: normalizeText(existing?.storageMode, 'local').trim() || 'local',
    revision: Math.max(0, Math.floor(Number(row?.revision) || 0)),
    createdAt: createdAt || updatedAt,
    updatedAt,
    schemaVersion: Math.max(1, Math.floor(Number(row?.schema_version) || SCHEMA_VERSION))
  }
}

async function synchronizeLocalProjectsWithDatabases(dirPath) {
  const normalizedDir = path.resolve(normalizeText(dirPath).trim())
  let projects = await readLocalProjects(normalizedDir)
  const entries = await fs.readdir(normalizedDir, { withFileTypes: true }).catch((error) => {
    if (error?.code === 'ENOENT') return []
    throw error
  })
  const discoveredById = new Map()
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.toLowerCase().endsWith(DB_EXTENSION)) continue
    let db
    try {
      db = openDatabase(path.join(normalizedDir, entry.name), { readOnly: true })
      const row = getConversationRow(db)
      const existing = projects.conversations?.[normalizeText(row?.conversation_id).trim()] || {}
      const descriptor = descriptorFromConversationRow(row, entry.name, existing)
      if (!descriptor) continue
      if (!discoveredById.has(descriptor.conversationId)) discoveredById.set(descriptor.conversationId, [])
      discoveredById.get(descriptor.conversationId).push(descriptor)
    } catch {
      // Ignore unrelated/corrupt .db files; only valid Anywhere conversation databases are indexed.
    } finally {
      try { db?.close() } catch {}
    }
  }

  const rootDatabaseFiles = new Set(
    entries.filter((entry) => entry.isFile() && entry.name.toLowerCase().endsWith(DB_EXTENSION))
      .map((entry) => entry.name.toLowerCase())
  )
  const discoveredConversationIdByFile = new Map()
  const selectedDescriptors = new Map()
  for (const [conversationId, descriptors] of discoveredById.entries()) {
    for (const descriptor of descriptors) {
      discoveredConversationIdByFile.set(descriptor.dbFile.toLowerCase(), descriptor.conversationId)
    }
    const indexedDbFile = normalizeText(projects.conversations?.[conversationId]?.dbFile).trim().toLowerCase()
    const descriptor = descriptors.find((item) => item.dbFile.toLowerCase() === indexedDbFile)
      || (descriptors.length === 1 ? descriptors[0] : null)
    if (descriptor) selectedDescriptors.set(conversationId, descriptor)
  }

  let nextProjects = projects
  for (const [conversationId, descriptor] of Object.entries(projects.conversations || {})) {
    if (selectedDescriptors.has(conversationId)) continue
    const indexedDbFile = normalizeText(descriptor?.dbFile).trim().toLowerCase()
    const discoveredConversationId = discoveredConversationIdByFile.get(indexedDbFile)
    if (!rootDatabaseFiles.has(indexedDbFile) || (discoveredConversationId && discoveredConversationId !== conversationId)) {
      nextProjects = removeConversationFromProjects(nextProjects, conversationId)
    }
  }
  for (const [conversationId, descriptor] of selectedDescriptors.entries()) {
    nextProjects = registerConversation(nextProjects, descriptor)
  }
  if (JSON.stringify(nextProjects) !== JSON.stringify(projects)) {
    await writeLocalProjects(normalizedDir, nextProjects)
  }
  return nextProjects
}


function initializeSchema(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version INTEGER PRIMARY KEY,
      name TEXT NOT NULL,
      applied_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS conversation (
      conversation_id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      owner_user_id TEXT,
      legacy_json TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      revision INTEGER NOT NULL DEFAULT 0,
      schema_version INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS roles (
      role_code TEXT PRIMARY KEY
    );

    CREATE TABLE IF NOT EXISTS providers (
      provider_id TEXT PRIMARY KEY,
      provider_name TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS models (
      model_id TEXT PRIMARY KEY,
      provider_id TEXT REFERENCES providers(provider_id),
      model_name TEXT NOT NULL,
      display_name TEXT,
      protocol_type TEXT
    );

    CREATE TABLE IF NOT EXISTS users (
      user_id TEXT PRIMARY KEY,
      account_id TEXT,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS participant_profiles (
      profile_id TEXT PRIMARY KEY,
      user_id TEXT REFERENCES users(user_id),
      actor_type TEXT NOT NULL,
      display_name TEXT,
      avatar_attachment_id TEXT,
      model_id TEXT REFERENCES models(model_id),
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS attachments (
      attachment_id TEXT PRIMARY KEY,
      sha256 TEXT NOT NULL UNIQUE,
      mime_type TEXT,
      original_name TEXT,
      byte_size INTEGER NOT NULL DEFAULT 0,
      data_url TEXT NOT NULL,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS messages (
      seq INTEGER PRIMARY KEY AUTOINCREMENT,
      ordinal INTEGER NOT NULL UNIQUE,
      message_uuid TEXT NOT NULL UNIQUE,
      role_code TEXT NOT NULL REFERENCES roles(role_code),
      author_profile_id TEXT REFERENCES participant_profiles(profile_id),
      payload_json TEXT NOT NULL,
      created_at TEXT,
      updated_at TEXT,
      token_count INTEGER NOT NULL DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS message_attachments (
      message_uuid TEXT NOT NULL REFERENCES messages(message_uuid) ON DELETE CASCADE,
      json_path TEXT NOT NULL,
      attachment_id TEXT NOT NULL REFERENCES attachments(attachment_id),
      PRIMARY KEY (message_uuid, json_path)
    );

    CREATE TABLE IF NOT EXISTS ui_messages (
      ui_order INTEGER PRIMARY KEY,
      ui_uuid TEXT NOT NULL UNIQUE,
      message_uuid TEXT,
      role_code TEXT NOT NULL,
      payload_json TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS session_state (
      state_key TEXT PRIMARY KEY,
      value_json TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS compaction_summaries (
      summary_id TEXT PRIMARY KEY,
      message_uuid TEXT NOT NULL REFERENCES messages(message_uuid) ON DELETE CASCADE,
      covered_start_ordinal INTEGER,
      covered_end_ordinal INTEGER,
      insert_after_ordinal INTEGER,
      summary_text TEXT NOT NULL,
      summary_prefix TEXT,
      token_count INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      is_active INTEGER NOT NULL DEFAULT 1
    );

    CREATE TABLE IF NOT EXISTS write_lease (
      resource TEXT PRIMARY KEY,
      holder_instance_id TEXT NOT NULL,
      holder_app TEXT NOT NULL,
      lease_epoch INTEGER NOT NULL,
      heartbeat_at TEXT NOT NULL,
      expires_at TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_messages_role_ordinal ON messages(role_code, ordinal);
    CREATE INDEX IF NOT EXISTS idx_ui_messages_message_uuid ON ui_messages(message_uuid);
    CREATE INDEX IF NOT EXISTS idx_compaction_active ON compaction_summaries(is_active, insert_after_ordinal);
  `)

  const insertRole = db.prepare('INSERT OR IGNORE INTO roles(role_code) VALUES (?)')
  for (const role of ['system', 'user', 'assistant', 'tool', 'compaction']) insertRole.run(role)
  db.prepare('INSERT OR IGNORE INTO schema_migrations(version, name, applied_at) VALUES (?, ?, ?)')
    .run(SCHEMA_VERSION, 'initial_conversation_schema', nowIso())
}

function withTransaction(db, callback, mode = 'IMMEDIATE') {
  db.exec(`BEGIN ${mode}`)
  try {
    const result = callback()
    db.exec('COMMIT')
    return result
  } catch (error) {
    try { db.exec('ROLLBACK') } catch {}
    throw error
  }
}


function getActiveWriteLease(db) {
  const lease = db.prepare("SELECT holder_instance_id, holder_app, lease_epoch, expires_at FROM write_lease WHERE resource = 'conversation'").get()
  if (!lease || new Date(lease.expires_at).getTime() <= Date.now()) return null
  return lease
}

function assertConversationWriteLease(db, { holderInstanceId = '', leaseEpoch = null } = {}) {
  const lease = getActiveWriteLease(db)
  if (!lease) return null
  const holder = normalizeText(holderInstanceId).trim()
  const epoch = Number(leaseEpoch)
  if (!holder || !Number.isFinite(epoch) || lease.holder_instance_id !== holder || Number(lease.lease_epoch) !== epoch) {
    throw new Error('conversation_write_lease_lost')
  }
  return lease
}

function parseDataUrl(value) {
  if (typeof value !== 'string') return null
  const match = value.match(/^data:([^;,]+)(?:;[^,]*)?;base64,([A-Za-z0-9+/=\r\n]+)$/)
  if (!match) return null
  const bytes = Buffer.from(match[2].replace(/\s+/g, ''), 'base64')
  return {
    mimeType: match[1],
    byteSize: bytes.length,
    sha256: crypto.createHash('sha256').update(bytes).digest('hex')
  }
}

function externalizeAttachments(db, value, ownerId, currentPath = '$', links = []) {
  if (typeof value === 'string') {
    const parsed = parseDataUrl(value)
    if (!parsed) return value
    let row = db.prepare('SELECT attachment_id FROM attachments WHERE sha256 = ?').get(parsed.sha256)
    if (!row) {
      const attachmentId = crypto.randomUUID()
      db.prepare(`
        INSERT INTO attachments(attachment_id, sha256, mime_type, byte_size, data_url, created_at)
        VALUES (?, ?, ?, ?, ?, ?)
      `).run(attachmentId, parsed.sha256, parsed.mimeType, parsed.byteSize, value, nowIso())
      row = { attachment_id: attachmentId }
    }
    links.push({ ownerId, jsonPath: currentPath, attachmentId: row.attachment_id })
    return { [ATTACHMENT_REF_KEY]: row.attachment_id }
  }
  if (Array.isArray(value)) {
    return value.map((item, index) => externalizeAttachments(db, item, ownerId, `${currentPath}[${index}]`, links))
  }
  if (value && typeof value === 'object') {
    const next = {}
    for (const [key, item] of Object.entries(value)) {
      next[key] = externalizeAttachments(db, item, ownerId, `${currentPath}.${key}`, links)
    }
    return next
  }
  return value
}

function hydrateAttachments(db, value) {
  if (Array.isArray(value)) return value.map((item) => hydrateAttachments(db, item))
  if (value && typeof value === 'object') {
    const attachmentId = normalizeText(value[ATTACHMENT_REF_KEY]).trim()
    if (attachmentId && Object.keys(value).length === 1) {
      return db.prepare('SELECT data_url FROM attachments WHERE attachment_id = ?').get(attachmentId)?.data_url || ''
    }
    const next = {}
    for (const [key, item] of Object.entries(value)) next[key] = hydrateAttachments(db, item)
    return next
  }
  return value
}

const REMOTE_REDACTED_KEYS = new Set([
  'path',
  'filepath',
  'file_path',
  'dirpath',
  'dir_path',
  'dbfile',
  'db_file',
  'legacyjson',
  'legacy_json',
  'worktreedir',
  'worktree_dir',
  'localchatpath',
  'local_chat_path',
  'api_key',
  'apikey',
  'password',
  'authorization',
  'token',
  'headers',
  'env'
])

function createRemoteAttachmentResolver(db) {
  const statement = db.prepare(`
    SELECT attachment_id, sha256, mime_type, original_name, byte_size
    FROM attachments WHERE attachment_id = ?
  `)
  const cache = new Map()
  return (attachmentId, nameHint = '') => {
    if (!cache.has(attachmentId)) cache.set(attachmentId, statement.get(attachmentId) || null)
    const row = cache.get(attachmentId)
    if (!row) {
      return {
        type: 'attachment',
        attachmentId,
        unavailable: true
      }
    }
    return {
      type: 'attachment',
      attachmentId: row.attachment_id,
      mimeType: normalizeText(row.mime_type, 'application/octet-stream'),
      name: normalizeText(nameHint || row.original_name).trim(),
      byteSize: Math.max(0, Number(row.byte_size) || 0),
      sha256: normalizeText(row.sha256).trim()
    }
  }
}


function createRemoteImageReferenceResolver(db, registerMedia) {
  const statement = db.prepare('SELECT data_url FROM attachments WHERE attachment_id = ?')
  return (value) => {
    const attachmentId = normalizeText(value?.[ATTACHMENT_REF_KEY]).trim()
    if (!attachmentId || typeof registerMedia !== 'function') return ''
    const dataUrl = statement.get(attachmentId)?.data_url
    return remoteMediaReference(dataUrl, registerMedia)
  }
}

const REMOTE_MEDIA_EXTENSION_PATTERN = /\.(?:png|jpe?g|webp|gif|mp4|webm|mov|m4v|mp3|wav|m4a|aac|ogg)(?:[?#].*)?$/i

const REMOTE_BARE_LOCAL_MEDIA_PATTERN = /(^|[\s("'=：])((?:file:[^\s<>"']+|[A-Za-z]:[\\/](?![\\/])|\/(?!\/))[^\r\n<>|?*"']+?\.(?:png|jpe?g|webp|gif|mp4|webm|mov|m4v|mp3|wav|m4a|aac|ogg)(?:[?#][^\s<>"']*)?)/gim


function normalizeConversationLocalMediaPath(value = '') {
  const source = typeof value === 'string' ? value.trim().replace(/^['"]|['"]$/g, '') : ''
  if (!source || source.length > 4096 || /^https?:\/\//i.test(source)) return ''
  const decoded = (() => {
    try { return decodeURIComponent(source) } catch { return '' }
  })()
  if (!decoded) return ''
  const normalizeBarePath = (candidate = '') => {
    // Do not accept `s://` as a Windows S: drive; that sequence occurs inside
    // every HTTPS URL and caused the previous false local-media rewrite.
    if (/^[A-Za-z]:[\\/](?![\\/])/.test(candidate)) return candidate
    if (/^\/[A-Za-z]:[\\/](?![\\/])/.test(candidate)) return candidate.slice(1)
    return /^\/(?!\/)/.test(candidate) ? candidate : ''
  }
  if (/^file:/i.test(decoded)) {
    try {
      const url = new URL(decoded)
      if (url.protocol !== 'file:') return ''
      const pathname = decodeURIComponent(url.pathname || '')
      if (!url.host || url.host.toLowerCase() === 'localhost') return normalizeBarePath(pathname)
      if (/^[A-Za-z]$/.test(url.host)) return normalizeBarePath(`${url.host.toUpperCase()}:${pathname}`)
      return ''
    } catch {
      return normalizeBarePath(decoded.replace(/^file:(?:\/\/)?/i, ''))
    }
  }
  return normalizeBarePath(decoded)
}

function localMediaReference(value, registerMedia) {
  const localPath = normalizeConversationLocalMediaPath(value)
  return localPath ? remoteMediaReference(localPath, registerMedia) : ''
}

function remoteMediaReference(value, registerMedia) {
  const source = typeof value === 'string' ? value.trim().replace(/^['"]|['"]$/g, '') : ''
  const localPath = normalizeConversationLocalMediaPath(source)
  const isInlineImage = /^data:image\/(?:png|jpe?g|webp|gif);base64,[A-Za-z0-9+/=\r\n]+$/i.test(source)
  if (!source || (!REMOTE_MEDIA_EXTENSION_PATTERN.test(localPath || source) && !isInlineImage) || typeof registerMedia !== 'function') return ''
  if (!isInlineImage && !localPath) return ''
  try {
    const media = registerMedia(localPath || source)
    return typeof media?.uri === 'string' && /^anywhere-media:\/\/[A-Za-z0-9_-]{16,160}(?:\?type=(?:image|video|audio))?$/.test(media.uri) ? media.uri : ''
  } catch {
    return ''
  }
}

function sanitizeRemoteText(value, context = {}) {
  const source = typeof value === 'string' ? value : ''
  const registerMedia = context.registerMedia
  const replaceMedia = (rawPath) => localMediaReference(rawPath, registerMedia) || '[local-media-unavailable]'
  const trim = source.trim()
  // Only a one-line, standalone source can be converted as a whole. A chat
  // message may end in .mp3 while still containing Markdown, HTML and prose.
  const directLocalPath = !/[\r\n]/.test(trim) ? normalizeConversationLocalMediaPath(trim) : ''
  if (directLocalPath) {
    // A bare path is conversation text, not an explicit media directive. Keep
    // it readable for the paired device but do not append a second preview
    // block below the message; explicit Markdown/HTML/structured media still
    // use their existing scoped opaque preview path below.
    return source
  }
  let result = source
  const exposedLocalMediaPaths = []
  // Replace only the source in Markdown, preserving its display text. The
  // paired Mobile can also see the original local path as conversation text,
  // while bytes remain reachable only through the opaque media reference.
  result = result.replace(/(!\[[^\]\r\n]*\]\(\s*)(['"]?)([^\)\r\n'"]+)(\2\s*\))/gi, (match, prefix, quote, sourcePath, suffix) => {
    const localPath = normalizeConversationLocalMediaPath(sourcePath)
    if (!localPath) return match
    exposedLocalMediaPaths.push(localPath)
    return `${prefix}${quote}${replaceMedia(localPath)}${suffix}`
  })
  // HTML media is used by the chat renderer for video/audio. Renderer history
  // has emitted file:///, file://C:/, and file:C:/ variants. Convert only the
  // source to an opaque ID and expose the original path as regular text below.
  result = result.replace(/(<(?:img|source|video|audio)\b[^>]*?\bsrc\s*=\s*['"])([^'">\r\n]+)(['"])/gi, (match, prefix, sourcePath, suffix) => {
    const localPath = normalizeConversationLocalMediaPath(sourcePath)
    if (!localPath) return match
    exposedLocalMediaPaths.push(localPath)
    return `${prefix}${replaceMedia(localPath)}${suffix}`
  })
  // Bare local paths embedded in prose stay readable as text. Unlike explicit
  // Markdown/HTML media they do not append a synthetic bottom preview block.
  // This avoids rendering a second copy when the response already contains a
  // renderable image or audio/video element.
  // Markdown/HTML sources already contain their scoped opaque preview. Add their
  // original paths as readable text below without creating another media node.
  if (exposedLocalMediaPaths.length) result += `\n${[...new Set(exposedLocalMediaPaths)].map((localPath) => `本地媒体：${localPath}`).join('\n')}`
  // The paired developer device is allowed to read conversation text verbatim,
  // including absolute local paths. Media sources are still rewritten above so
  // Mobile renders real bytes instead of trying to open a Desktop-only path.
  return result
}

function safeRemoteAvatar(value) {
  const source = typeof value === 'string' ? value.trim() : ''
  return /^https:\/\/[^\s?#]+(?:\?[^\s#]*)?$/i.test(source) ? source.slice(0, 2048) : ''
}

function remoteModelLabel(modelValue, promptConfig = {}, providerNames = {}) {
  const model = normalizeText(modelValue).trim()
  if (!model) return ''
  const separator = model.indexOf('|')
  if (separator <= 0 || separator >= model.length - 1) return model.slice(0, 320)
  const providerId = model.slice(0, separator).trim()
  const modelName = model.slice(separator + 1).trim()
  // Renderer persists this display-only label with the session state. For
  // older sessions, a Main-process-only lookup supplies the display name.
  // Never return the Provider ID when no safe display label is available.
  const providerName = normalizeText(promptConfig?.modelProviderName).trim()
    || normalizeText(providerNames?.[providerId]).trim()
  return providerName ? `${providerName} | ${modelName}`.slice(0, 320) : modelName.slice(0, 320)
}


function safeRemoteAssistant(value = {}) {
  const source = value && typeof value === 'object' && !Array.isArray(value) ? value : {}
  return {
    code: normalizeText(source.code).slice(0, 160),
    name: normalizeText(source.name).slice(0, 160),
    avatarUrl: safeRemoteAvatar(source.avatarUrl || source.icon)
  }
}


function sanitizeRemoteTasks(value) {
  if (!Array.isArray(value) || value.length > 128) return []
  const status = (input) => ['pending', 'in_progress', 'completed'].includes(input) ? input : 'pending'
  return value.map((task) => ({
    content: normalizeText(task?.content).slice(0, 1200),
    status: status(normalizeText(task?.status)),
    steps: Array.isArray(task?.steps) ? task.steps.slice(0, 64).map((step) => ({
      content: normalizeText(step?.content).slice(0, 1200),
      status: status(normalizeText(step?.status))
    })).filter((step) => step.content) : []
  })).filter((task) => task.content)
}


function sanitizeRemotePayload(value, resolveAttachment, context = {}) {
  if (typeof value === 'string') {
    const parsed = parseDataUrl(value)
    if (parsed) {
      return {
        type: 'inline-attachment',
        mimeType: parsed.mimeType,
        byteSize: parsed.byteSize,
        sha256: parsed.sha256
      }
    }
    return sanitizeRemoteText(value, context)
  }
  if (Array.isArray(value)) {
    return value.map((item) => sanitizeRemotePayload(item, resolveAttachment, context))
  }
  if (value && typeof value === 'object') {
    const attachmentId = normalizeText(value[ATTACHMENT_REF_KEY]).trim()
    if (attachmentId && Object.keys(value).length === 1) {
      return resolveAttachment(attachmentId, context.nameHint)
    }
    if (value.type === 'image_url' || value.type === 'image') {
      const rawUrl = value.image_url ?? value.image ?? value.url
      const sourcePath = typeof rawUrl === 'string' ? rawUrl.trim() : ''
      if (sourcePath) {
        if (/^anywhere-media:\/\/[A-Za-z0-9_-]{16,160}(?:\?type=(?:image|video|audio))?$/.test(sourcePath)) {
          return { type: 'image', url: sourcePath }
        }
        const media = remoteMediaReference(sourcePath, context.registerMedia)
        // Mobile cannot open a Desktop path directly, so always prefer the
        // opaque media reference for rendering while keeping the path readable.
        if (media) return { type: 'image', url: media, sourcePath }
        return { type: 'image', sourcePath }
      }
      if (rawUrl && typeof rawUrl === 'object') {
        // Attachment-backed history images. Desktop resolves the stored bytes
        // into an opaque media reference so Mobile can render the picture
        // without receiving the base64 payload or any local path.
        const previewUrl = typeof context.resolveAttachmentImage === 'function'
          ? context.resolveAttachmentImage(rawUrl)
          : ''
        const resolved = sanitizeRemotePayload(rawUrl, resolveAttachment, context)
        if (resolved && typeof resolved === 'object' && resolved.attachmentId) {
          return previewUrl
            ? { type: 'image', url: previewUrl, attachmentId: resolved.attachmentId, mimeType: resolved.mimeType || '', name: resolved.name || '' }
            : { type: 'image', attachmentId: resolved.attachmentId, mimeType: resolved.mimeType || '', name: resolved.name || '' }
        }
      }
    }
    if (value.type === 'input_audio' && value.input_audio && typeof value.input_audio === 'object') {
      const encoded = normalizeText(value.input_audio.data).replace(/\s+/g, '')
      return {
        type: 'audio',
        format: normalizeText(value.input_audio.format, 'wav'),
        byteSize: encoded ? Math.max(0, Math.floor(encoded.length * 3 / 4)) : 0,
        available: Boolean(encoded)
      }
    }
    const nameHint = normalizeText(value.filename || value.file_name || value.name || context.nameHint).trim()
    const next = {}
    for (const [key, item] of Object.entries(value)) {
      if (REMOTE_REDACTED_KEYS.has(String(key).toLowerCase())) continue
      next[key] = sanitizeRemotePayload(item, resolveAttachment, { ...context, nameHint })
    }
    return next
  }
  return value
}

const REMOTE_SENSITIVE_TEXT_PATTERN = /(?:api[_ -]?key|secret|password|authorization|bearer\s+[A-Za-z0-9._-]+|token|credential|cookie|private[_ -]?key)/i


function sanitizeRemoteToolDetail(value, context = {}) {
  if (typeof value !== 'string') return sanitizeRemotePayload(value, () => ({ type: 'attachment', unavailable: true }), context)
  const source = value.trim()
  if (!source) return ''
  try {
    const parsed = JSON.parse(source)
    return sanitizeRemotePayload(parsed, () => ({ type: 'attachment', unavailable: true }), context)
  } catch {
    if (REMOTE_SENSITIVE_TEXT_PATTERN.test(source)) return '[已隐藏敏感内容]'
    const cleaned = sanitizeRemoteText(source, context)
    if (/\[local-file-hidden\]|\[local-media-unavailable\]/.test(cleaned)) return '[已隐藏本地路径]'
    return cleaned.slice(0, 16 * 1024)
  }
}


function sanitizeRemoteToolCalls(toolCalls = [], context = {}) {
  return (Array.isArray(toolCalls) ? toolCalls : [])
    .slice(0, 32)
    .map((call) => {
      const source = call && typeof call === 'object' ? call : {}
      const rawArgs = source.args ?? source.arguments ?? source.function?.arguments ?? {}
      const rawResult = Object.hasOwn(source, 'result') ? source.result : source.content
      const choiceQuestions = source.choiceData?.questions
      return {
        id: normalizeText(source.id || source.tool_call_id).trim(),
        name: normalizeText(source.name || source.function?.name).trim(),
        status: normalizeText(source.approvalStatus || source.status).trim(),
        arguments: sanitizeRemoteToolDetail(rawArgs, context),
        ...(Object.hasOwn(source, 'result') || Object.hasOwn(source, 'content')
          ? { result: sanitizeRemoteToolDetail(rawResult, context) }
          : {}),
        ...(Array.isArray(choiceQuestions)
          ? { choice: { questions: choiceQuestions.map((question) => ({
            question: normalizeText(question?.question).slice(0, 1200),
            header: normalizeText(question?.header).slice(0, 80),
            options: Array.isArray(question?.options) ? question.options.slice(0, 12).map((option) => ({
              label: normalizeText(option?.label).slice(0, 240),
              description: normalizeText(option?.description).slice(0, 600)
            })).filter((option) => option.label) : []
          })).filter((question) => question.question && question.options.length) } }
          : {})
      }
    })
    .filter((call) => call.id || call.name)
}

function toRemoteUiMessage(db, row, resolveAttachment, context = {}) {
  let payload = {}
  try {
    payload = JSON.parse(row.payload_json)
  } catch {
    payload = { role: row.role_code, content: '[invalid-message-payload]' }
  }
  const role = normalizeText(row.role_code || payload?.role, 'user')
  // UI-only assistant/tool cards may omit timestamps even though their linked
  // canonical message row has them. Preserve the Desktop timeline without
  // synthesizing a new clock value or exposing any additional message fields.
  const timestamp = normalizeText(payload.timestamp || payload.createdAt || row.created_at)
  const completedTimestamp = normalizeText(payload.completedTimestamp || payload.updatedAt || row.updated_at || timestamp)
  const remotePayload = {
    content: sanitizeRemotePayload(payload.content, resolveAttachment, context),
    reasoningContent: sanitizeRemoteText(normalizeText(payload.reasoning_content), context),
    summary: sanitizeRemoteText(normalizeText(payload.summary), context),
    summaryPrefix: normalizeText(payload.summaryPrefix),
    timestamp,
    completedTimestamp,
    aiName: normalizeText(payload.aiName),
    voiceName: normalizeText(payload.voiceName),
    status: normalizeText(payload.status),
    toolCalls: sanitizeRemoteToolCalls(payload.tool_calls, context)
  }
  if (role === 'compaction') {
    remotePayload.compaction = {
      snapshotId: normalizeText(payload.snapshotId || payload.id),
      coveredCount: Math.max(0, Number(payload.coveredCount) || 0),
      tokenCount: Math.max(0, Number(payload.tokenCount) || 0),
      canRestore: payload.canRestore === true
    }
  }
  return {
    messageId: row.message_uuid || row.ui_uuid,
    uiMessageId: row.ui_uuid,
    role,
    order: Number(row.ui_order) || 0,
    payload: remotePayload
  }
}

function messageSignature(message = {}) {
  const content = message?.content
  return JSON.stringify({
    role: normalizeText(message?.role),
    content,
    reasoning: normalizeText(message?.reasoning_content),
    summary: normalizeText(message?.summary)
  })
}

function normalizeRenderableContent(content) {
  if (!Array.isArray(content)) {
    const value = content ?? ''
    return typeof value === 'string' && value.length === 0 ? null : value
  }
  const parts = content.filter((part) => part && !part.isTranscript)
  if (parts.length === 0) return null
  if (parts.every((part) => part?.type === 'text')) {
    const text = parts.map((part) => part.text ?? '').join('')
    return text.length === 0 ? null : text
  }
  return parts.map((part) => (
    part?.type === 'text' ? { type: 'text', text: part.text ?? '' } : part
  ))
}

function messageLinkSignature(message = {}) {
  const role = normalizeText(message?.role)
  if (role === 'user' || role === 'assistant') {
    return JSON.stringify({ role, content: normalizeRenderableContent(message?.content) })
  }
  if (role === 'compaction') {
    return JSON.stringify({ role, snapshotId: normalizeText(message?.snapshotId || message?.id) })
  }
  return messageSignature(message)
}


function prepareMigrationMessages(fullHistory = [], chatShow = []) {
  const usedMessageIds = new Set()
  const messages = (Array.isArray(fullHistory) ? fullHistory : []).map((message) => {
    const next = clone(message)
    const requestedStorageId = normalizeText(message?.storageId).trim()
    next.storageId = requestedStorageId && !usedMessageIds.has(requestedStorageId)
      ? requestedStorageId
      : crypto.randomUUID()
    usedMessageIds.add(next.storageId)
    return next
  })
  const canonicalByStorageId = new Map(messages.map((message) => [message.storageId, message]))
  const signatureQueues = new Map()
  messages.forEach((message) => {
    if (message.role === 'tool') return
    const signature = messageLinkSignature(message)
    if (!signatureQueues.has(signature)) signatureQueues.set(signature, [])
    signatureQueues.get(signature).push(message.storageId)
  })
  const claimedStorageIds = new Set()
  const usedUiStorageIds = new Set()
  const uiMessages = (Array.isArray(chatShow) ? chatShow : []).map((message) => {
    const next = clone(message)
    const signature = messageLinkSignature(next)
    const requestedStorageId = normalizeText(next.storageId).trim()
    const requestedCanonical = canonicalByStorageId.get(requestedStorageId)
    const requestedIsValid = Boolean(
      requestedCanonical
      && !claimedStorageIds.has(requestedStorageId)
      && messageLinkSignature(requestedCanonical) === signature
    )
    const reboundCandidates = (signatureQueues.get(signature) || []).filter((storageId) => !claimedStorageIds.has(storageId))
    const reboundStorageId = reboundCandidates.length === 1 ? reboundCandidates[0] : ''
    next.storageId = requestedIsValid ? requestedStorageId : reboundStorageId
    if (next.storageId) claimedStorageIds.add(next.storageId)
    const requestedUiStorageId = normalizeText(next.uiStorageId).trim()
    next.uiStorageId = requestedUiStorageId && !usedUiStorageIds.has(requestedUiStorageId)
      ? requestedUiStorageId
      : crypto.randomUUID()
    usedUiStorageIds.add(next.uiStorageId)
    return next
  })
  return { messages, uiMessages }
}

function splitSessionSnapshot(sessionData = {}) {
  const source = sessionData && typeof sessionData === 'object' ? clone(sessionData) : {}
  const rawFullHistory = Array.isArray(source.fullHistory) ? source.fullHistory : []
  const rawHistory = Array.isArray(source.history) ? source.history : []
  const rawChatShow = Array.isArray(source.chat_show) ? source.chat_show : []
  const hasCompaction = rawChatShow.some((message) => message?.role === 'compaction')
  const fullHistory = rawFullHistory.length > 0
    ? rawFullHistory
    : (rawHistory.length > 0 && !hasCompaction ? rawHistory : rawChatShow.filter((message) => message?.role !== 'tool'))
  delete source.fullHistory
  delete source.history
  delete source.chat_show
  return { state: source, fullHistory, chatShow: rawChatShow }
}

function insertMessage(db, message, ordinal) {
  const storageId = normalizeText(message?.storageId).trim() || crypto.randomUUID()
  const payload = clone(message)
  delete payload.storageId
  delete payload.storageOrdinal
  delete payload.uiStorageId
  delete payload.uiStorageOrder
  const links = []
  const storedPayload = externalizeAttachments(db, payload, storageId, '$', links)
  const role = ['system', 'user', 'assistant', 'tool', 'compaction'].includes(payload.role) ? payload.role : 'user'
  const createdAt = normalizeText(payload.createdAt || payload.timestamp).trim()
  const updatedAt = normalizeText(payload.completedTimestamp || payload.updatedAt || payload.createdAt || payload.timestamp).trim()
  const tokenCount = Math.max(0, Number(payload?.tokenUsage?.total_tokens) || 0)
  db.prepare(`
    INSERT INTO messages(ordinal, message_uuid, role_code, payload_json, created_at, updated_at, token_count)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(ordinal, storageId, role, JSON.stringify(storedPayload), createdAt || null, updatedAt || null, tokenCount)
  const linkStmt = db.prepare('INSERT OR IGNORE INTO message_attachments(message_uuid, json_path, attachment_id) VALUES (?, ?, ?)')
  for (const link of links) linkStmt.run(storageId, link.jsonPath, link.attachmentId)

  if (role === 'compaction') {
    const summaryId = normalizeText(payload.snapshotId || payload.id).trim() || crypto.randomUUID()
    db.prepare(`
      INSERT OR REPLACE INTO compaction_summaries(
        summary_id, message_uuid, covered_start_ordinal, covered_end_ordinal,
        insert_after_ordinal, summary_text, summary_prefix, token_count, created_at, is_active
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1)
    `).run(
      summaryId,
      storageId,
      Number.isFinite(Number(payload.coveredStartOrdinal)) ? Number(payload.coveredStartOrdinal) : null,
      Number.isFinite(Number(payload.coveredEndOrdinal)) ? Number(payload.coveredEndOrdinal) : null,
      db.prepare('SELECT MAX(ordinal) AS value FROM messages WHERE ordinal < ?').get(ordinal)?.value ?? null,
      normalizeText(payload.summary || payload.content),
      normalizeText(payload.summaryPrefix),
      Math.max(0, Number(payload.tokenCount) || 0),
      normalizeText(payload.createdAt) || nowIso()
    )
  }
  return storageId
}

function insertUiMessage(db, message, uiOrder) {
  const uiStorageId = normalizeText(message?.uiStorageId).trim() || crypto.randomUUID()
  const payload = clone(message)
  delete payload.storageId
  delete payload.uiStorageId
  delete payload.uiStorageOrder
  delete payload.storageOrdinal
  const storedPayload = externalizeAttachments(db, payload, uiStorageId)
  db.prepare(`
    INSERT INTO ui_messages(ui_order, ui_uuid, message_uuid, role_code, payload_json)
    VALUES (?, ?, ?, ?, ?)
  `).run(uiOrder, uiStorageId, normalizeText(message?.storageId).trim() || null, normalizeText(message?.role, 'user'), JSON.stringify(storedPayload))
}

function stripMessageStorageMetadata(message = {}, { ui = false } = {}) {
  const payload = clone(message)
  delete payload.storageId
  delete payload.storageOrdinal
  delete payload.uiStorageId
  delete payload.uiStorageOrder
  return payload
}

function canIncrementallySyncOrder(existingIds, currentMessages, idKey) {
  const currentIds = currentMessages.map((message) => normalizeText(message?.[idKey]).trim()).filter(Boolean)
  if (currentIds.length !== currentMessages.length) return false
  const currentExistingIds = currentIds.filter((id) => existingIds.has(id))
  const retainedExistingIds = [...existingIds].filter((id) => currentIds.includes(id))
  if (currentExistingIds.join('\u0000') !== retainedExistingIds.join('\u0000')) return false
  let sawNew = false
  for (const id of currentIds) {
    if (!existingIds.has(id)) sawNew = true
    else if (sawNew) return false
  }
  return true
}

// Insert checkpoints without rebuilding canonical history or moving existing ordinals.
function syncInsertedCompactions(db, messages, lowerBound, { ui = false } = {}) {
  const table = ui ? 'ui_messages' : 'messages'
  const orderKey = ui ? 'ui_order' : 'ordinal'
  const rowIdKey = ui ? 'ui_uuid' : 'message_uuid'
  const messageIdKey = ui ? 'uiStorageId' : 'storageId'
  const checkpoints = messages.filter((message) => message.role === 'compaction')
  if (!checkpoints.length) return false
  const existingCheckpointIds = new Set(db.prepare(`SELECT ${rowIdKey} FROM ${table} WHERE role_code = 'compaction'`).all().map((row) => row[rowIdKey]))
  if (checkpoints.every((message) => existingCheckpointIds.has(message[messageIdKey]))) return false
  const rows = db.prepare(`SELECT * FROM ${table} ORDER BY ${orderKey}`).all()
  const byId = new Map(rows.map((row) => [row[rowIdKey], row]))
  const added = messages.filter((message) => !byId.has(message[messageIdKey]))
  if (!added.some((message) => message.role === 'compaction')) return false
  for (let index = 0; index < messages.length; index += 1) {
    const message = messages[index]
    if (!byId.has(message[messageIdKey]) && message.role !== 'compaction'
      && messages.slice(index + 1).some((item) => byId.has(item[messageIdKey]))) return false
  }
  const ids = messages.map((message) => message[messageIdKey])
  if (new Set(ids).size !== ids.length || ids.some((id) => !id)) return false
  const retained = ids.filter((id) => byId.has(id))
  const retainedSet = new Set(retained)
  if (rows.some((row) => (row.role_code === 'system' || row[orderKey] >= lowerBound) && !retainedSet.has(row[rowIdKey]))) return false
  if (rows.filter((row) => retainedSet.has(row[rowIdKey])).map((row) => row[rowIdKey]).join('\0') !== retained.join('\0')) return false

  if (ui) {
    for (const message of messages) {
      const row = byId.get(message[messageIdKey])
      if (!row || row.role_code === 'system' || row[orderKey] >= lowerBound) continue
      const stored = hydrateAttachments(db, JSON.parse(row.payload_json))
      if (JSON.stringify(stored) !== JSON.stringify(stripMessageStorageMetadata(message, { ui: true }))
        || (row.message_uuid || null) !== (normalizeText(message.storageId).trim() || null)) {
        throw new Error('conversation_compaction_protected_prefix_changed')
      }
    }
    const active = messages.filter((message) => {
      const row = byId.get(message[messageIdKey])
      return message.role === 'system' || !row || row[orderKey] >= lowerBound
    })
    replaceUiProjection(db, active, lowerBound)
    return true
  }

  const orders = new Map()
  const occupied = new Set(rows.map((row) => Number(row[orderKey])))
  let left = null
  for (let index = 0; index < messages.length; index += 1) {
    const message = messages[index]
    const existing = byId.get(message[messageIdKey])
    if (existing) { left = Number(existing[orderKey]); continue }
    const next = messages.slice(index + 1).find((item) => byId.has(item[messageIdKey]))
    const right = next ? Number(byId.get(next[messageIdKey])[orderKey]) : null
    // Include unloaded historical rows when finding the gap before the next retained row.
    const previous = right == null
      ? Number(rows[rows.length - 1]?.[orderKey] || 0)
      : rows.reduce((max, row) => Number(row[orderKey]) < right ? Math.max(max, Number(row[orderKey])) : max, right - 1)
    const lower = Math.max(left ?? previous, previous)
    const order = right == null ? lower + 1 : lower + (right - lower) / 2
    if (!Number.isFinite(order) || order <= lower || (right != null && order >= right) || occupied.has(order)) {
      throw new Error('conversation_compaction_order_space_exhausted')
    }
    orders.set(message[messageIdKey], order)
    occupied.add(order)
    left = order
  }

  for (const message of messages) {
    const id = message[messageIdKey]
    const existing = byId.get(id)
    if (!existing) {
      if (ui) insertUiMessage(db, message, orders.get(id))
      else insertMessage(db, message, orders.get(id))
      continue
    }
    const stored = hydrateAttachments(db, JSON.parse(existing.payload_json))
    const payload = stripMessageStorageMetadata(message, { ui })
    const role = normalizeText(message.role, 'user')
    const sameLink = !ui || (existing.message_uuid || null) === (normalizeText(message.storageId).trim() || null)
    if (existing.role_code === role && sameLink && JSON.stringify(stored) === JSON.stringify(payload)) continue
    if (existing.role_code !== 'system' && existing[orderKey] < lowerBound) {
      throw new Error('conversation_compaction_protected_prefix_changed')
    }
    db.prepare(`DELETE FROM ${table} WHERE ${rowIdKey} = ?`).run(id)
    if (ui) insertUiMessage(db, message, existing[orderKey])
    else insertMessage(db, message, existing[orderKey])
  }
  return true
}

function syncMessagesIncrementally(db, messages, lowerBound = 1) {
  if (syncInsertedCompactions(db, messages, lowerBound)) return true
  const existingRows = db.prepare(`
    SELECT ordinal, message_uuid, role_code, payload_json
    FROM messages WHERE role_code = 'system' OR ordinal >= ? ORDER BY ordinal
  `).all(lowerBound)
  const existingIds = new Set(existingRows.map((row) => row.message_uuid))
  if (!canIncrementallySyncOrder(existingIds, messages, 'storageId')) return false

  const currentIds = new Set(messages.map((message) => message.storageId))
  const deleteStmt = db.prepare('DELETE FROM messages WHERE message_uuid = ?')
  for (const row of existingRows) {
    if (!currentIds.has(row.message_uuid)) deleteStmt.run(row.message_uuid)
  }

  const existingById = new Map(existingRows.map((row) => [row.message_uuid, row]))
  let nextOrdinal = Number(db.prepare('SELECT COALESCE(MAX(ordinal), 0) AS value FROM messages').get()?.value) || 0
  let nextSystemOrdinal = Number(db.prepare("SELECT COALESCE(MIN(ordinal), 0) AS value FROM messages WHERE role_code = 'system'").get()?.value) || 0
  for (const message of messages) {
    const existing = existingById.get(message.storageId)
    if (existing) {
      const storedPayload = hydrateAttachments(db, JSON.parse(existing.payload_json))
      const nextPayload = stripMessageStorageMetadata(message)
      const nextRole = ['system', 'user', 'assistant', 'tool', 'compaction'].includes(nextPayload.role) ? nextPayload.role : 'user'
      if (existing.role_code === nextRole && JSON.stringify(storedPayload) === JSON.stringify(nextPayload)) continue
      deleteStmt.run(existing.message_uuid)
      insertMessage(db, message, existing.ordinal)
      continue
    }
    const ordinal = message.role === 'system' ? --nextSystemOrdinal : ++nextOrdinal
    insertMessage(db, message, ordinal)
  }
  return true
}

function syncUiMessagesIncrementally(db, messages, lowerBound = 1) {
  if (syncInsertedCompactions(db, messages, lowerBound, { ui: true })) return true
  const existingRows = db.prepare(`
    SELECT ui_order, ui_uuid, message_uuid, role_code, payload_json
    FROM ui_messages WHERE role_code = 'system' OR ui_order >= ? ORDER BY ui_order
  `).all(lowerBound)
  const existingIds = new Set(existingRows.map((row) => row.ui_uuid))
  if (!canIncrementallySyncOrder(existingIds, messages, 'uiStorageId')) return false

  const currentIds = new Set(messages.map((message) => message.uiStorageId))
  const deleteStmt = db.prepare('DELETE FROM ui_messages WHERE ui_uuid = ?')
  for (const row of existingRows) {
    if (!currentIds.has(row.ui_uuid)) deleteStmt.run(row.ui_uuid)
  }

  const existingById = new Map(existingRows.map((row) => [row.ui_uuid, row]))
  let nextOrder = Number(db.prepare('SELECT COALESCE(MAX(ui_order), 0) AS value FROM ui_messages').get()?.value) || 0
  let nextSystemOrder = Number(db.prepare("SELECT COALESCE(MIN(ui_order), 0) AS value FROM ui_messages WHERE role_code = 'system'").get()?.value) || 0
  for (const message of messages) {
    const existing = existingById.get(message.uiStorageId)
    if (existing) {
      const storedPayload = hydrateAttachments(db, JSON.parse(existing.payload_json))
      const nextPayload = stripMessageStorageMetadata(message, { ui: true })
      const nextMessageUuid = normalizeText(message?.storageId).trim() || null
      if (
        existing.role_code === normalizeText(message?.role, 'user')
        && (existing.message_uuid || null) === nextMessageUuid
        && JSON.stringify(storedPayload) === JSON.stringify(nextPayload)
      ) continue
      deleteStmt.run(existing.ui_uuid)
      insertUiMessage(db, message, existing.ui_order)
      continue
    }
    const uiOrder = message.role === 'system' ? --nextSystemOrder : ++nextOrder
    insertUiMessage(db, message, uiOrder)
  }
  return true
}


function repairUiMessageLinks(db, { apply = true } = {}) {
  const canonicalRows = db.prepare("SELECT message_uuid, role_code, payload_json FROM messages WHERE role_code IN ('user', 'assistant', 'compaction')").all()
  const canonicalById = new Map()
  const candidatesBySignature = new Map()
  for (const row of canonicalRows) {
    const message = JSON.parse(row.payload_json)
    const entry = { id: row.message_uuid, role: row.role_code, signature: messageLinkSignature(message) }
    canonicalById.set(entry.id, entry)
    if (!candidatesBySignature.has(entry.signature)) candidatesBySignature.set(entry.signature, [])
    candidatesBySignature.get(entry.signature).push(entry)
  }

  const uiRows = db.prepare("SELECT ui_uuid, message_uuid, role_code, payload_json FROM ui_messages WHERE message_uuid IS NOT NULL AND role_code IN ('user', 'assistant', 'compaction') ORDER BY ui_order").all()
  const claimedCanonicalIds = new Set()
  const invalidRows = []
  for (const row of uiRows) {
    const uiMessage = JSON.parse(row.payload_json)
    const signature = messageLinkSignature(uiMessage)
    const linked = canonicalById.get(row.message_uuid)
    if (linked && linked.role === row.role_code && linked.signature === signature && !claimedCanonicalIds.has(linked.id)) {
      claimedCanonicalIds.add(linked.id)
    } else {
      invalidRows.push({ ...row, signature })
    }
  }

  const repairs = []
  let rebound = 0
  let unlinked = 0
  for (const row of invalidRows) {
    const candidates = (candidatesBySignature.get(row.signature) || []).filter((candidate) => !claimedCanonicalIds.has(candidate.id))
    const nextMessageId = candidates.length === 1 ? candidates[0].id : null
    repairs.push({ uiStorageId: row.ui_uuid, messageStorageId: nextMessageId })
    if (nextMessageId) {
      claimedCanonicalIds.add(nextMessageId)
      rebound += 1
    } else {
      unlinked += 1
    }
  }
  if (apply && repairs.length > 0) {
    const updateLink = db.prepare('UPDATE ui_messages SET message_uuid = ? WHERE ui_uuid = ?')
    for (const repair of repairs) updateLink.run(repair.messageStorageId, repair.uiStorageId)
  }
  return { changed: repairs.length, rebound, unlinked, repairs }
}


function replaceUiProjection(db, uiMessages, lowerBound) {
  db.prepare("DELETE FROM ui_messages WHERE role_code = 'system' OR ui_order >= ?").run(lowerBound)
  const systemUi = uiMessages.filter((message) => message?.role === 'system')
  const activeUi = uiMessages.filter((message) => message?.role !== 'system')
  // UI is a derived projection. Never reuse stale or cross-client uiStorageOrder values while rebuilding.
  systemUi.forEach((message, index) => insertUiMessage(db, message, index - systemUi.length))
  activeUi.forEach((message, index) => insertUiMessage(db, message, lowerBound + index))
}



function writeState(db, state) {
  const stateStmt = db.prepare(`
    INSERT INTO session_state(state_key, value_json, updated_at) VALUES (?, ?, ?)
    ON CONFLICT(state_key) DO UPDATE SET value_json = excluded.value_json, updated_at = excluded.updated_at
  `)
  for (const [key, value] of Object.entries(state || {})) {
    const storedValue = externalizeAttachments(db, value, `state:${key}`)
    stateStmt.run(key, JSON.stringify(storedValue), nowIso())
  }
}

function replaceSnapshotInDatabase(db, descriptor, sessionData) {
  const { state, fullHistory, chatShow } = splitSessionSnapshot(sessionData)
  const prepared = prepareMigrationMessages(fullHistory, chatShow)
  const createdAt = normalizeTimestamp(sessionData?.sessionMetadata?.createdAt) || normalizeTimestamp(descriptor.createdAt) || nowIso()
  const updatedAt = normalizeTimestamp(sessionData?.sessionMetadata?.updatedAt) || normalizeTimestamp(descriptor.updatedAt) || createdAt

  withTransaction(db, () => {
    db.exec(`
      DELETE FROM message_attachments;
      DELETE FROM compaction_summaries;
      DELETE FROM ui_messages;
      DELETE FROM messages;
      DELETE FROM session_state;
      DELETE FROM conversation;
    `)
    db.prepare(`
      INSERT INTO conversation(conversation_id, title, owner_user_id, legacy_json, created_at, updated_at, revision, schema_version)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      descriptor.conversationId,
      descriptor.title,
      normalizeText(sessionData?.conversationOwnerId).trim() || null,
      descriptor.legacyJson || null,
      createdAt,
      updatedAt,
      Math.max(0, Number(descriptor.revision) || 0),
      SCHEMA_VERSION
    )
    prepared.messages.forEach((message, index) => insertMessage(db, message, index + 1))
    prepared.uiMessages.forEach((message, index) => insertUiMessage(db, message, index + 1))
    writeState(db, state)
  })
}

function getConversationRow(db) {
  const row = db.prepare('SELECT * FROM conversation LIMIT 1').get()
  if (!row) throw new Error('conversation_metadata_missing')
  return row
}

function loadState(db) {
  const state = {}
  for (const row of db.prepare('SELECT state_key, value_json FROM session_state').all()) {
    state[row.state_key] = hydrateAttachments(db, JSON.parse(row.value_json))
  }
  return state
}

function getActiveMessageStart(db) {
  const row = db.prepare(`
    SELECT m.ordinal
    FROM compaction_summaries c
    JOIN messages m ON m.message_uuid = c.message_uuid
    WHERE c.is_active = 1
    ORDER BY m.ordinal DESC
    LIMIT 1
  `).get()
  return Number(row?.ordinal) || 0
}

function loadMessages(db, { activeOnly = true, limit = 0, beforeOrdinal = null } = {}) {
  const activeStart = activeOnly ? getActiveMessageStart(db) : 0
  const safeLimit = Math.max(0, Math.floor(Number(limit) || 0))
  const safeBefore = beforeOrdinal !== null && beforeOrdinal !== undefined && beforeOrdinal !== '' && Number.isFinite(Number(beforeOrdinal))
    ? Number(beforeOrdinal)
    : null
  let rows
  if (safeLimit > 0) {
    const lowerBound = activeStart > 0 ? activeStart : -Number.MAX_SAFE_INTEGER
    const beforeClause = safeBefore != null ? 'AND ordinal < ?' : ''
    const params = safeBefore != null ? [lowerBound, safeBefore, safeLimit] : [lowerBound, safeLimit]
    rows = db.prepare(`
      SELECT ordinal, message_uuid, role_code, payload_json FROM (
        SELECT ordinal, message_uuid, role_code, payload_json
        FROM messages
        WHERE role_code != 'system' AND ordinal >= ? ${beforeClause}
        ORDER BY ordinal DESC LIMIT ?
      ) ORDER BY ordinal
    `).all(...params)
    if (safeBefore == null) {
      const systems = db.prepare("SELECT ordinal, message_uuid, role_code, payload_json FROM messages WHERE role_code = 'system' ORDER BY ordinal").all()
      rows = [...systems, ...rows]
    }
  } else if (activeStart > 0) {
    rows = db.prepare('SELECT ordinal, message_uuid, role_code, payload_json FROM messages WHERE role_code = ? OR ordinal >= ? ORDER BY ordinal').all('system', activeStart)
  } else {
    rows = db.prepare('SELECT ordinal, message_uuid, role_code, payload_json FROM messages ORDER BY ordinal').all()
  }
  return rows.map((row) => ({
    ...hydrateAttachments(db, JSON.parse(row.payload_json)),
    storageId: row.message_uuid,
    storageOrdinal: row.ordinal
  }))
}

function resolveValidatedUiMessageStorageId(db, row, canonicalCache = new Map()) {
  const requestedStorageId = normalizeText(row?.message_uuid).trim()
  if (!requestedStorageId) return ''
  let canonical = canonicalCache.get(requestedStorageId)
  if (canonical === undefined) {
    canonical = db.prepare('SELECT role_code, payload_json FROM messages WHERE message_uuid = ?').get(requestedStorageId) || null
    canonicalCache.set(requestedStorageId, canonical)
  }
  if (!canonical || canonical.role_code !== row?.role_code) return ''
  try {
    return messageLinkSignature(JSON.parse(row.payload_json)) === messageLinkSignature(JSON.parse(canonical.payload_json))
      ? requestedStorageId
      : ''
  } catch {
    return ''
  }
}


function materializeUiMessages(db, rows = []) {
  const canonicalCache = new Map()
  return rows.map((row) => {
    const storageId = resolveValidatedUiMessageStorageId(db, row, canonicalCache)
    const payload = hydrateAttachments(db, JSON.parse(row.payload_json))
    delete payload.storageId
    delete payload.storageOrdinal
    delete payload.uiStorageId
    delete payload.uiStorageOrder
    return {
      ...payload,
      ...(storageId ? { storageId } : {}),
      uiStorageId: row.ui_uuid,
      uiStorageOrder: row.ui_order
    }
  })
}


function loadUiMessages(db, { activeOnly = true, limit = 0 } = {}) {
  let rows
  if (activeOnly) {
    const lastCompact = db.prepare(`
      SELECT ui_order FROM ui_messages WHERE role_code = 'compaction' ORDER BY ui_order DESC LIMIT 1
    `).get()
    if (lastCompact?.ui_order) {
      rows = db.prepare(`
        SELECT ui_order, ui_uuid, message_uuid, role_code, payload_json
        FROM ui_messages
        WHERE role_code = 'system' OR ui_order >= ?
        ORDER BY ui_order
      `).all(lastCompact.ui_order)
    }
  }
  if (!rows) {
    if (Number(limit) > 0) {
      const tailRows = db.prepare(`
        SELECT ui_order, ui_uuid, message_uuid, role_code, payload_json FROM (
          SELECT ui_order, ui_uuid, message_uuid, role_code, payload_json
          FROM ui_messages WHERE role_code != 'system' ORDER BY ui_order DESC LIMIT ?
        ) ORDER BY ui_order
      `).all(Math.floor(Number(limit)))
      const systemRows = db.prepare("SELECT ui_order, ui_uuid, message_uuid, role_code, payload_json FROM ui_messages WHERE role_code = 'system' ORDER BY ui_order").all()
      rows = [...systemRows, ...tailRows]
    } else {
      rows = db.prepare('SELECT ui_order, ui_uuid, message_uuid, role_code, payload_json FROM ui_messages ORDER BY ui_order').all()
    }
  }
  return materializeUiMessages(db, rows)
}

export async function migrateJsonConversation({ dirPath, jsonBasename, instanceId = '', appType = 'desktop' } = {}) {
  const normalizedDir = path.resolve(normalizeText(dirPath).trim())
  const legacyJson = normalizeBasename(jsonBasename)
  if (!normalizedDir || !legacyJson.toLowerCase().endsWith('.json')) throw new Error('legacy_conversation_json_required')
  await fs.mkdir(normalizedDir, { recursive: true })

  let projects = await readLocalProjects(normalizedDir)
  const existing = findConversation(projects, legacyJson)
  if (existing) {
    const existingPath = resolveDatabasePath(normalizedDir, existing.dbFile)
    try {
      await fs.access(existingPath)
      return { ok: true, migrated: false, descriptor: existing, databasePath: existingPath }
    } catch {}
  }

  const sourcePath = path.join(normalizedDir, legacyJson)
  const lockPath = `${sourcePath}.migrate.lock`
  let lockHandle
  try {
    lockHandle = await fs.open(lockPath, 'wx')
    await lockHandle.writeFile(JSON.stringify({ instanceId, appType, createdAt: nowIso(), expiresAt: new Date(Date.now() + MIGRATION_LOCK_TTL_MS).toISOString() }))
  } catch (error) {
    if (error?.code !== 'EEXIST') throw error
    const lockStat = await fs.stat(lockPath).catch(() => null)
    if (lockStat && Date.now() - lockStat.mtimeMs > MIGRATION_LOCK_TTL_MS) {
      await fs.rm(lockPath, { force: true })
      return migrateJsonConversation({ dirPath: normalizedDir, jsonBasename: legacyJson, instanceId, appType })
    }
    projects = await readLocalProjects(normalizedDir)
    const mapped = findConversation(projects, legacyJson)
    if (mapped) return { ok: true, migrated: false, descriptor: mapped, databasePath: resolveDatabasePath(normalizedDir, mapped.dbFile) }
    throw new Error('conversation_migration_in_progress')
  }

  let tempPath = ''
  try {
    const [raw, sourceStats] = await Promise.all([
      fs.readFile(sourcePath, 'utf-8'),
      fs.stat(sourcePath).catch(() => null)
    ])
    const sessionData = JSON.parse(raw)
    if (!sessionData || sessionData.anywhere_history !== true) throw new Error('legacy_conversation_invalid')
    const { createdAt, updatedAt } = resolveConversationTimestamps(sessionData, sourceStats)
    const conversationId = createConversationId()
    const dbFile = createDatabaseFilename(conversationId)
    const title = normalizeText(sessionData?.sessionMetadata?.title).trim() || legacyJson.slice(0, -5)
    const descriptor = {
      conversationId,
      dbFile,
      title,
      legacyJson,
      storageMode: 'local',
      revision: 0,
      schemaVersion: SCHEMA_VERSION,
      createdAt,
      updatedAt
    }
    const finalPath = resolveDatabasePath(normalizedDir, dbFile)
    tempPath = `${finalPath}.migrating`
    await fs.rm(tempPath, { force: true })
    const db = openDatabase(tempPath)
    try {
      initializeSchema(db)
      replaceSnapshotInDatabase(db, descriptor, sessionData)
      const check = db.prepare('PRAGMA quick_check').get()
      if (!check || !Object.values(check).includes('ok')) throw new Error('conversation_database_integrity_failed')
    } finally {
      db.close()
    }
    await fs.rename(tempPath, finalPath)

    const project = findProjectByBasename(projects, legacyJson)
    projects = registerConversation(projects, descriptor, { projectId: project?.id || '', projectName: project?.name || '' })
    await writeLocalProjects(normalizedDir, projects)
    return { ok: true, migrated: true, descriptor, databasePath: finalPath }
  } finally {
    if (lockHandle) await lockHandle.close().catch(() => {})
    await fs.rm(lockPath, { force: true }).catch(() => {})
    if (tempPath) await fs.rm(tempPath, { force: true }).catch(() => {})
  }
}

export async function createConversation({ dirPath, title, sessionData = {}, projectId = '', projectName = '', storageMode = 'local' } = {}) {
  const normalizedDir = path.resolve(normalizeText(dirPath).trim())
  if (!normalizedDir) throw new Error('conversation_local_dir_required')
  await fs.mkdir(normalizedDir, { recursive: true })
  const conversationId = createConversationId()
  const dbFile = createDatabaseFilename(conversationId)
  const descriptor = {
    conversationId,
    dbFile,
    title: normalizeText(title).trim() || '新对话',
    legacyJson: '',
    storageMode: normalizeText(storageMode, 'local').trim() || 'local',
    revision: 0,
    schemaVersion: SCHEMA_VERSION,
    ...resolveConversationTimestamps(sessionData)
  }
  const databasePath = resolveDatabasePath(normalizedDir, dbFile)
  const tempPath = `${databasePath}.creating`
  const db = openDatabase(tempPath)
  try {
    initializeSchema(db)
    replaceSnapshotInDatabase(db, descriptor, { ...sessionData, sessionMetadata: { ...(sessionData.sessionMetadata || {}), title: descriptor.title } })
  } finally {
    db.close()
  }
  await fs.rename(tempPath, databasePath)
  const projects = registerConversation(await readLocalProjects(normalizedDir), descriptor, { projectId, projectName })
  await writeLocalProjects(normalizedDir, projects)
  return { ok: true, descriptor, databasePath }
}

export async function openConversation({ dirPath, reference, activeOnly = true, pageSize = 200 } = {}) {
  const normalizedDir = path.resolve(normalizeText(dirPath).trim())
  let projects = await synchronizeLocalProjectsWithDatabases(normalizedDir)
  let descriptor = findConversation(projects, reference)
  if (!descriptor && normalizeBasename(reference).toLowerCase().endsWith('.json')) {
    const migration = await migrateJsonConversation({ dirPath: normalizedDir, jsonBasename: reference })
    descriptor = migration.descriptor
    projects = await readLocalProjects(normalizedDir)
  }
  if (!descriptor) throw new Error('conversation_not_found')
  const databasePath = resolveDatabasePath(normalizedDir, descriptor.dbFile)
  const db = openDatabase(databasePath, { readOnly: true })
  try {
    const row = getConversationRow(db)
    const state = loadState(db)
    const activeStart = activeOnly ? getActiveMessageStart(db) : 0
    const shouldPage = activeStart === 0 && Number(pageSize) > 0
    const fullHistory = loadMessages(db, { activeOnly, limit: shouldPage ? pageSize : 0 })
    let chatShow = loadUiMessages(db, { activeOnly, limit: shouldPage ? pageSize : 0 })
    if (chatShow.length === 0) {
      chatShow = fullHistory.filter((message) => message.role !== 'tool').map((message, index) => ({ ...clone(message), id: index + 1 }))
    }
    return {
      ok: true,
      descriptor: { ...descriptor, title: row.title, revision: row.revision, createdAt: row.created_at, updatedAt: row.updated_at },
      sessionData: {
        anywhere_history: true,
        ...state,
        sessionMetadata: { ...(state.sessionMetadata || {}), title: row.title, createdAt: row.created_at, updatedAt: row.updated_at },
        fullHistory,
        history: [],
        chat_show: chatShow,
        conversationStorage: {
          format: 'sqlite',
          conversationId: row.conversation_id,
          dbFile: descriptor.dbFile,
          title: row.title,
          revision: row.revision,
          activeOnly,
          isPaged: shouldPage,
          loadedFromOrdinal: fullHistory.find((message) => message.role !== 'system')?.storageOrdinal || 0,
          loadedFromUiOrder: chatShow.find((message) => message.role !== 'system')?.uiStorageOrder || 0,
          pageSize: shouldPage ? Number(pageSize) : 0
        }
      }
    }
  } finally {
    db.close()
  }
}

export async function listLocalConversations(dirPath) {
  const normalizedDir = path.resolve(normalizeText(dirPath).trim())
  const projects = await synchronizeLocalProjectsWithDatabases(normalizedDir)
  const files = await fs.readdir(normalizedDir, { withFileTypes: true }).catch((error) => {
    if (error?.code === 'ENOENT') return []
    throw error
  })
  const fileStats = new Map()
  await Promise.all(
    files
      .filter((entry) => entry.isFile())
      .map(async (entry) => {
        const stats = await fs.stat(path.join(normalizedDir, entry.name)).catch(() => null)
        if (stats) fileStats.set(entry.name, stats)
      })
  )

  const conversations = []
  const mappedLegacy = new Set()
  for (const descriptor of Object.values(projects.conversations)) {
    const stats = fileStats.get(descriptor.dbFile)
    if (!stats) continue
    if (descriptor.legacyJson) mappedLegacy.add(descriptor.legacyJson)
    const updatedAt = descriptor.updatedAt || stats.mtime?.toISOString?.() || ''
    conversations.push({
      type: 'file',
      format: 'sqlite',
      basename: descriptor.dbFile,
      filename: descriptor.dbFile,
      path: resolveDatabasePath(normalizedDir, descriptor.dbFile),
      conversationId: descriptor.conversationId,
      title: descriptor.title,
      legacyJson: descriptor.legacyJson,
      revision: descriptor.revision,
      size: stats.size,
      createdAt: descriptor.createdAt || stats.birthtime?.toISOString?.() || '',
      updatedAt,
      lastmod: updatedAt
    })
  }

  const legacyConversations = await Promise.all(
    files
      .filter((entry) => entry.isFile() && entry.name.toLowerCase().endsWith('.json') && !mappedLegacy.has(entry.name))
      .map(async (entry) => {
        const stats = fileStats.get(entry.name)
        if (!await isLegacyConversationJson(path.join(normalizedDir, entry.name), stats?.size)) return null
        return {
          type: 'file',
          format: 'json',
          basename: entry.name,
          filename: entry.name,
          path: path.join(normalizedDir, entry.name),
          title: entry.name.slice(0, -5),
          size: stats?.size || 0,
          createdAt: stats?.birthtime?.toISOString?.() || '',
          updatedAt: stats?.mtime?.toISOString?.() || '',
          lastmod: stats?.mtime?.toISOString?.() || ''
        }
      })
  )
  conversations.push(...legacyConversations.filter(Boolean))

  return conversations.sort((a, b) => new Date(b.updatedAt || b.lastmod || 0).getTime() - new Date(a.updatedAt || a.lastmod || 0).getTime())
}

export async function loadConversationPage({ dirPath, conversationId, beforeOrdinal = null, beforeUiOrder = null, pageSize = 200 } = {}) {
  const descriptor = findConversation(await readLocalProjects(dirPath), conversationId)
  if (!descriptor) throw new Error('conversation_not_found')
  const db = openDatabase(resolveDatabasePath(dirPath, descriptor.dbFile), { readOnly: true })
  try {
    const messages = loadMessages(db, { activeOnly: false, limit: pageSize, beforeOrdinal })
    const safeUiBefore = beforeUiOrder !== null && beforeUiOrder !== undefined && beforeUiOrder !== '' && Number.isFinite(Number(beforeUiOrder))
      ? Number(beforeUiOrder)
      : null
    const uiRows = safeUiBefore != null
      ? db.prepare(`
          SELECT ui_order, ui_uuid, message_uuid, role_code, payload_json FROM (
            SELECT ui_order, ui_uuid, message_uuid, role_code, payload_json
            FROM ui_messages WHERE ui_order < ? ORDER BY ui_order DESC LIMIT ?
          ) ORDER BY ui_order
        `).all(safeUiBefore, Math.max(1, Number(pageSize) || 200))
      : []
    const uiMessages = materializeUiMessages(db, uiRows)
    const loadedFromOrdinal = messages.find((message) => message.role !== 'system')?.storageOrdinal || 0
    const loadedFromUiOrder = uiMessages.find((message) => message.role !== 'system')?.uiStorageOrder || 0
    return {
      ok: true,
      messages,
      uiMessages,
      loadedFromOrdinal,
      loadedFromUiOrder,
      hasMore: (loadedFromOrdinal > 1) || (loadedFromUiOrder > 1)
    }
  } finally { db.close() }
}

export async function getConversationRequestMessages({ dirPath, conversationId } = {}) {
  const descriptor = findConversation(await readLocalProjects(dirPath), conversationId)
  if (!descriptor) throw new Error('conversation_not_found')
  const db = openDatabase(resolveDatabasePath(dirPath, descriptor.dbFile), { readOnly: true })
  try {
    return { ok: true, messages: loadMessages(db, { activeOnly: true }) }
  } finally { db.close() }
}

/**
 * Remote-safe, read-only history page. It never acquires a write lease, never
 * migrates legacy JSON, and never hydrates attachment data URLs into memory.
 */
export async function loadRemoteConversationPage({
  dirPath,
  conversationId,
  beforeUiOrder = null,
  pageSize = 50,
  registerMedia = null,
  providerNames = {},
  agentIdentities = {}
} = {}) {
  const rawDir = normalizeText(dirPath).trim()
  if (!rawDir) throw new Error('conversation_local_dir_required')
  const normalizedDir = path.resolve(rawDir)
  const normalizedConversationId = normalizeText(conversationId).trim()
  if (!normalizedDir) throw new Error('conversation_local_dir_required')
  if (!normalizedConversationId) throw new Error('conversation_id_required')

  const projects = await readLocalProjects(normalizedDir)
  const descriptor = findConversation(projects, normalizedConversationId)
  if (!descriptor) throw new Error('conversation_not_found')
  const db = openDatabase(resolveDatabasePath(normalizedDir, descriptor.dbFile), { readOnly: true })
  try {
    const row = getConversationRow(db)
    const limit = Math.min(100, Math.max(1, Math.floor(Number(pageSize) || 50)))
    const safeBefore = beforeUiOrder !== null && beforeUiOrder !== undefined && beforeUiOrder !== ''
      && Number.isFinite(Number(beforeUiOrder))
      ? Number(beforeUiOrder)
      : null
    const pageRows = safeBefore == null
      ? db.prepare(`
          SELECT ui_order, ui_uuid, message_uuid, role_code, payload_json, created_at, updated_at FROM (
            SELECT ui.ui_order, ui.ui_uuid, ui.message_uuid, ui.role_code, ui.payload_json,
              message.created_at, message.updated_at
            FROM ui_messages AS ui
            LEFT JOIN messages AS message ON message.message_uuid = ui.message_uuid
            WHERE ui.role_code NOT IN ('system', 'tool')
            ORDER BY ui.ui_order DESC LIMIT ?
          ) ORDER BY ui_order
        `).all(limit)
      : db.prepare(`
          SELECT ui_order, ui_uuid, message_uuid, role_code, payload_json, created_at, updated_at FROM (
            SELECT ui.ui_order, ui.ui_uuid, ui.message_uuid, ui.role_code, ui.payload_json,
              message.created_at, message.updated_at
            FROM ui_messages AS ui
            LEFT JOIN messages AS message ON message.message_uuid = ui.message_uuid
            WHERE ui.role_code NOT IN ('system', 'tool') AND ui.ui_order < ?
            ORDER BY ui.ui_order DESC LIMIT ?
          ) ORDER BY ui_order
        `).all(safeBefore, limit)
    // System prompt is session configuration, not a chat bubble. It remains
    // available only through conversation.config.get/patch for Mobile.
    const rows = pageRows
    const resolveAttachment = createRemoteAttachmentResolver(db)
    const resolveAttachmentImage = createRemoteImageReferenceResolver(db, registerMedia)
    const context = {
      registerMedia: typeof registerMedia === 'function' ? registerMedia : null,
      resolveAttachmentImage
    }
    const messages = rows
      .filter((item) => item.role_code !== 'tool')
      .map((item) => toRemoteUiMessage(db, item, resolveAttachment, context))
    const taskState = db.prepare("SELECT value_json FROM session_state WHERE state_key = 'taskList' LIMIT 1").get()
    const modelState = db.prepare("SELECT value_json FROM session_state WHERE state_key = 'model' LIMIT 1").get()
    const promptState = db.prepare("SELECT value_json FROM session_state WHERE state_key = 'currentPromptConfig' LIMIT 1").get()
    const agentCodeState = db.prepare("SELECT value_json FROM session_state WHERE state_key = 'CODE' LIMIT 1").get()
    let tasks = []
    let model = ''
    let assistant = { code: '', name: '', avatarUrl: '' }
    let agentCode = ''
    try { tasks = sanitizeRemoteTasks(taskState ? hydrateAttachments(db, JSON.parse(taskState.value_json)) : []) } catch { tasks = [] }
    let promptConfig = {}
    try { promptConfig = promptState ? hydrateAttachments(db, JSON.parse(promptState.value_json)) : {} } catch { promptConfig = {} }
    try { agentCode = normalizeText(agentCodeState ? JSON.parse(agentCodeState.value_json) : '').slice(0, 160) } catch { agentCode = '' }
    try { model = remoteModelLabel(modelState ? JSON.parse(modelState.value_json) : '', promptConfig, providerNames) } catch { model = '' }
    try {
      const currentAgent = agentCode && agentIdentities && typeof agentIdentities === 'object'
        ? agentIdentities[agentCode]
        : null
      assistant = safeRemoteAssistant(currentAgent || promptConfig)
    } catch { assistant = { code: '', name: '', avatarUrl: '' } }
    const oldestOrder = pageRows.length > 0
      ? Math.min(...pageRows.map((item) => Number(item.ui_order) || 0))
      : 0
    const hasMore = oldestOrder > 0 && Boolean(
      db.prepare(`
        SELECT 1 AS value FROM ui_messages
        WHERE role_code NOT IN ('system', 'tool') AND ui_order < ? LIMIT 1
      `).get(oldestOrder)?.value
    )
    const project = projects.projects.find((item) => item.conversationIds.includes(normalizedConversationId)) || null

    return {
      ok: true,
      conversation: {
        conversationId: row.conversation_id,
        title: row.title,
        revision: Number(row.revision) || 0,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
        model,
        assistant,
        project: project ? { projectId: project.id, name: project.name } : null
      },
      messages,
      tasks,
      page: {
        pageSize: limit,
        nextBeforeUiOrder: hasMore ? oldestOrder : null,
        hasMore
      }
    }
  } finally {
    db.close()
  }
}


export async function saveConversationSnapshot({ dirPath, conversationId, expectedRevision, holderInstanceId = '', leaseEpoch = null, sessionData = {}, title = '' } = {}) {
  const projects = await readLocalProjects(dirPath)
  const descriptor = findConversation(projects, conversationId)
  if (!descriptor) throw new Error('conversation_not_found')
  const db = openDatabase(resolveDatabasePath(dirPath, descriptor.dbFile))
  try {
    initializeSchema(db)
    const { state, fullHistory, chatShow } = splitSessionSnapshot(sessionData)
    const prepared = prepareMigrationMessages(fullHistory, chatShow)
    const result = withTransaction(db, () => {
      const row = getConversationRow(db)
      assertConversationWriteLease(db, { holderInstanceId, leaseEpoch })
      if (Number.isFinite(Number(expectedRevision)) && Number(expectedRevision) !== Number(row.revision)) {
        const error = new Error('conversation_revision_conflict')
        error.currentRevision = row.revision
        throw error
      }

      const activeStart = getActiveMessageStart(db)
      const pagingState = state?.conversationStorage && typeof state.conversationStorage === 'object'
        ? state.conversationStorage
        : {}
      const isPaged = pagingState.isPaged === true && activeStart === 0
      const loadedFromOrdinal = Math.max(1, Number(pagingState.loadedFromOrdinal) || 1)

      const messageLowerBound = isPaged ? loadedFromOrdinal : (activeStart > 0 ? activeStart : 1)
      const messageIncremental = syncMessagesIncrementally(db, prepared.messages, messageLowerBound)
      if (!messageIncremental) {
        if (isPaged || activeStart > 0) {
          const lowerBound = isPaged ? loadedFromOrdinal : activeStart
          db.prepare("DELETE FROM messages WHERE role_code = 'system' OR ordinal >= ?").run(lowerBound)
          const systemMessages = prepared.messages.filter((message) => message?.role === 'system')
          const activeMessages = prepared.messages.filter((message) => message?.role !== 'system')
          systemMessages.forEach((message, index) => insertMessage(db, message, index - systemMessages.length))
          let nextOrdinal = Number(db.prepare('SELECT COALESCE(MAX(ordinal), ?) AS value FROM messages').get(lowerBound - 1)?.value) || (lowerBound - 1)
          activeMessages.forEach((message) => {
            const preservedOrdinal = Number(message?.storageOrdinal)
            const ordinal = Number.isFinite(preservedOrdinal) && preservedOrdinal >= lowerBound ? preservedOrdinal : ++nextOrdinal
            nextOrdinal = Math.max(nextOrdinal, ordinal)
            insertMessage(db, message, ordinal)
          })
        } else {
          db.exec('DELETE FROM messages')
          prepared.messages.forEach((message, index) => insertMessage(db, message, index + 1))
        }
      }

      const activeUiStart = Number(db.prepare("SELECT ui_order FROM ui_messages WHERE role_code = 'compaction' ORDER BY ui_order DESC LIMIT 1").get()?.ui_order) || 0
      const loadedUiStart = isPaged
        ? Math.max(1, Number(prepared.uiMessages.find((message) => message?.role !== 'system')?.uiStorageOrder) || 1)
        : (activeUiStart > 0 ? activeUiStart : 1)
      const uiIncremental = syncUiMessagesIncrementally(db, prepared.uiMessages, loadedUiStart)
      if (!uiIncremental) {
        replaceUiProjection(db, prepared.uiMessages, isPaged || activeUiStart > 0 ? loadedUiStart : 1)
      }

      db.exec('DELETE FROM session_state')
      writeState(db, state)
      // Attachment GC is deliberately deferred: draft/state references may be nested JSON paths.
      // Keeping an orphan is safer than deleting content that an older session shape still references.

      const nextRevision = Number(row.revision) + 1
      const nextTitle = normalizeText(title || sessionData?.sessionMetadata?.title).trim() || row.title
      const updatedAt = nowIso()
      db.prepare('UPDATE conversation SET title = ?, updated_at = ?, revision = ? WHERE conversation_id = ?')
        .run(nextTitle, updatedAt, nextRevision, conversationId)
      return { revision: nextRevision, title: nextTitle, updatedAt }
    })

    const warning = await writeLocalProjectsBestEffort(dirPath, updateConversation(projects, conversationId, {
      title: result.title,
      revision: result.revision,
      updatedAt: result.updatedAt
    }))
    return {
      ok: true,
      ...result,
      ...(warning ? { warning } : {}),
      descriptor: { ...descriptor, title: result.title, revision: result.revision, updatedAt: result.updatedAt }
    }
  } finally {
    db.close()
  }
}


export async function saveConversationState({ dirPath, conversationId, expectedRevision, holderInstanceId = '', leaseEpoch = null, state = {}, uiMessages = null, title = '' } = {}) {
  const projects = await readLocalProjects(dirPath)
  const descriptor = findConversation(projects, conversationId)
  if (!descriptor) throw new Error('conversation_not_found')
  const db = openDatabase(resolveDatabasePath(dirPath, descriptor.dbFile))
  try {
    initializeSchema(db)
    const result = withTransaction(db, () => {
      const row = getConversationRow(db)
      assertConversationWriteLease(db, { holderInstanceId, leaseEpoch })
      if (Number.isFinite(Number(expectedRevision)) && Number(expectedRevision) !== Number(row.revision)) {
        const error = new Error('conversation_revision_conflict')
        error.currentRevision = row.revision
        throw error
      }
      writeState(db, state)
      if (Array.isArray(uiMessages)) {
        const compactOrder = db.prepare("SELECT ui_order FROM ui_messages WHERE role_code = 'compaction' ORDER BY ui_order DESC LIMIT 1").get()?.ui_order || 0
        if (compactOrder > 0) db.prepare('DELETE FROM ui_messages WHERE ui_order >= ?').run(compactOrder)
        else db.exec('DELETE FROM ui_messages')
        const startOrder = compactOrder > 0 ? compactOrder : 1
        uiMessages.forEach((message, index) => insertUiMessage(db, message, startOrder + index))
      }
      const nextRevision = Number(row.revision) + 1
      const nextTitle = normalizeText(title).trim() || row.title
      db.prepare('UPDATE conversation SET title = ?, updated_at = ?, revision = ? WHERE conversation_id = ?')
        .run(nextTitle, nowIso(), nextRevision, conversationId)
      return { revision: nextRevision, title: nextTitle }
    })
    const nextProjects = updateConversation(projects, conversationId, { title: result.title, revision: result.revision, updatedAt: nowIso() })
    const warning = await writeLocalProjectsBestEffort(dirPath, nextProjects)
    return { ok: true, ...result, ...(warning ? { warning } : {}) }
  } finally { db.close() }
}

export async function repairConversationUiLinks({ dirPath, conversationId, expectedRevision, holderInstanceId = '', leaseEpoch = null } = {}) {
  const projects = await readLocalProjects(dirPath)
  const descriptor = findConversation(projects, conversationId)
  if (!descriptor) throw new Error('conversation_not_found')
  const databasePath = resolveDatabasePath(dirPath, descriptor.dbFile)
  const inspectDb = openDatabase(databasePath)
  let preview
  let initialRow
  try {
    initializeSchema(inspectDb)
    initialRow = getConversationRow(inspectDb)
    assertConversationWriteLease(inspectDb, { holderInstanceId, leaseEpoch })
    if (Number.isFinite(Number(expectedRevision)) && Number(expectedRevision) !== Number(initialRow.revision)) {
      const error = new Error('conversation_revision_conflict')
      error.currentRevision = initialRow.revision
      throw error
    }
    preview = repairUiMessageLinks(inspectDb, { apply: false })
  } finally { inspectDb.close() }

  if (preview.changed === 0) {
    return {
      ok: true,
      changed: 0,
      rebound: 0,
      unlinked: 0,
      revision: initialRow.revision,
      title: initialRow.title,
      updatedAt: initialRow.updated_at,
      backupCreated: false
    }
  }

  const snapshotDir = path.join(path.dirname(databasePath), '.snapshots')
  const snapshotPath = path.join(snapshotDir, `${conversationId}-pre-ui-link-repair-${Date.now()}.db`)
  await fs.mkdir(snapshotDir, { recursive: true })
  await fs.rm(snapshotPath, { force: true })
  const backupDb = openDatabase(databasePath)
  try {
    assertConversationWriteLease(backupDb, { holderInstanceId, leaseEpoch })
    await sqliteBackup(backupDb, snapshotPath)
  } finally { backupDb.close() }

  const db = openDatabase(databasePath)
  let result
  try {
    initializeSchema(db)
    result = withTransaction(db, () => {
      const row = getConversationRow(db)
      assertConversationWriteLease(db, { holderInstanceId, leaseEpoch })
      if (Number(row.revision) !== Number(initialRow.revision)) {
        const error = new Error('conversation_revision_conflict')
        error.currentRevision = row.revision
        throw error
      }
      const repaired = repairUiMessageLinks(db)
      const updatedAt = nowIso()
      const revision = Number(row.revision) + 1
      db.prepare('UPDATE conversation SET updated_at = ?, revision = ? WHERE conversation_id = ?')
        .run(updatedAt, revision, conversationId)
      return {
        changed: repaired.changed,
        rebound: repaired.rebound,
        unlinked: repaired.unlinked,
        revision,
        title: row.title,
        updatedAt,
        backupCreated: true
      }
    })
  } finally { db.close() }

  const warning = await writeLocalProjectsBestEffort(dirPath, updateConversation(projects, conversationId, {
    title: result.title,
    revision: result.revision,
    updatedAt: result.updatedAt
  }))
  return { ok: true, ...result, ...(warning ? { warning } : {}) }
}



export async function appendMessages({ dirPath, conversationId, holderInstanceId = '', leaseEpoch = null, messages = [] } = {}) {
  if (!Array.isArray(messages) || messages.length === 0) return { ok: true, messageIds: [] }
  const descriptor = findConversation(await readLocalProjects(dirPath), conversationId)
  if (!descriptor) throw new Error('conversation_not_found')
  const db = openDatabase(resolveDatabasePath(dirPath, descriptor.dbFile))
  try {
    initializeSchema(db)
    return withTransaction(db, () => {
      assertConversationWriteLease(db, { holderInstanceId, leaseEpoch })
      let ordinal = Number(db.prepare('SELECT COALESCE(MAX(ordinal), 0) AS value FROM messages').get()?.value) || 0
      const messageIds = messages.map((message) => insertMessage(db, message, ++ordinal))
      db.prepare('UPDATE conversation SET updated_at = ? WHERE conversation_id = ?').run(nowIso(), conversationId)
      return { ok: true, messageIds }
    })
  } finally { db.close() }
}

export async function updateMessage({ dirPath, conversationId, holderInstanceId = '', leaseEpoch = null, storageId, message } = {}) {
  const descriptor = findConversation(await readLocalProjects(dirPath), conversationId)
  if (!descriptor) throw new Error('conversation_not_found')
  const db = openDatabase(resolveDatabasePath(dirPath, descriptor.dbFile))
  try {
    initializeSchema(db)
    return withTransaction(db, () => {
      assertConversationWriteLease(db, { holderInstanceId, leaseEpoch })
      const existing = db.prepare('SELECT ordinal FROM messages WHERE message_uuid = ?').get(storageId)
      if (!existing) throw new Error('conversation_message_not_found')
      db.prepare('DELETE FROM messages WHERE message_uuid = ?').run(storageId)
      insertMessage(db, { ...message, storageId }, existing.ordinal)
      return { ok: true, storageId }
    })
  } finally { db.close() }
}

export async function truncateMessages({ dirPath, conversationId, holderInstanceId = '', leaseEpoch = null, fromStorageId, inclusive = true } = {}) {
  const descriptor = findConversation(await readLocalProjects(dirPath), conversationId)
  if (!descriptor) throw new Error('conversation_not_found')
  const db = openDatabase(resolveDatabasePath(dirPath, descriptor.dbFile))
  try {
    initializeSchema(db)
    return withTransaction(db, () => {
      assertConversationWriteLease(db, { holderInstanceId, leaseEpoch })
      const row = db.prepare('SELECT ordinal FROM messages WHERE message_uuid = ?').get(fromStorageId)
      if (!row) throw new Error('conversation_message_not_found')
      const result = db.prepare(`DELETE FROM messages WHERE ordinal ${inclusive ? '>=' : '>'} ?`).run(row.ordinal)
      return { ok: true, removed: Number(result.changes) || 0 }
    })
  } finally { db.close() }
}

export async function deleteMessages({ dirPath, conversationId, holderInstanceId = '', leaseEpoch = null, storageIds = [] } = {}) {
  const ids = Array.isArray(storageIds) ? storageIds.map((id) => normalizeText(id).trim()).filter(Boolean) : []
  if (!ids.length) return { ok: true, removed: 0 }
  const descriptor = findConversation(await readLocalProjects(dirPath), conversationId)
  if (!descriptor) throw new Error('conversation_not_found')
  const db = openDatabase(resolveDatabasePath(dirPath, descriptor.dbFile))
  try {
    initializeSchema(db)
    return withTransaction(db, () => {
      assertConversationWriteLease(db, { holderInstanceId, leaseEpoch })
      const stmt = db.prepare('DELETE FROM messages WHERE message_uuid = ?')
      let removed = 0
      for (const id of ids) removed += Number(stmt.run(id).changes) || 0
      return { ok: true, removed }
    })
  } finally { db.close() }
}

export async function replaceActiveMessages({ dirPath, conversationId, holderInstanceId = '', leaseEpoch = null, messages = [] } = {}) {
  const descriptor = findConversation(await readLocalProjects(dirPath), conversationId)
  if (!descriptor) throw new Error('conversation_not_found')
  const db = openDatabase(resolveDatabasePath(dirPath, descriptor.dbFile))
  try {
    initializeSchema(db)
    return withTransaction(db, () => {
      assertConversationWriteLease(db, { holderInstanceId, leaseEpoch })
      const activeStart = getActiveMessageStart(db)
      if (activeStart > 0) db.prepare('DELETE FROM messages WHERE ordinal >= ?').run(activeStart)
      else db.exec('DELETE FROM messages')
      let ordinal = activeStart > 0 ? activeStart - 1 : 0
      const messageIds = messages.map((message) => insertMessage(db, message, ++ordinal))
      return { ok: true, messageIds }
    })
  } finally { db.close() }
}

export async function restoreConversationCompaction({
  dirPath,
  conversationId,
  snapshotId,
  expectedRevision,
  holderInstanceId = '',
  leaseEpoch = null,
  pageSize = 200
} = {}) {
  const projects = await readLocalProjects(dirPath)
  const descriptor = findConversation(projects, conversationId)
  if (!descriptor) throw new Error('conversation_not_found')
  const requestedSnapshotId = normalizeText(snapshotId).trim()
  if (!requestedSnapshotId) throw new Error('conversation_compaction_snapshot_required')

  const db = openDatabase(resolveDatabasePath(dirPath, descriptor.dbFile))
  try {
    initializeSchema(db)
    const result = withTransaction(db, () => {
      const row = getConversationRow(db)
      assertConversationWriteLease(db, { holderInstanceId, leaseEpoch })
      if (Number.isFinite(Number(expectedRevision)) && Number(expectedRevision) !== Number(row.revision)) {
        const error = new Error('conversation_revision_conflict')
        error.currentRevision = row.revision
        throw error
      }

      const outermost = db.prepare(`
        SELECT c.summary_id, c.message_uuid, m.ordinal
        FROM compaction_summaries c
        JOIN messages m ON m.message_uuid = c.message_uuid
        WHERE c.is_active = 1
        ORDER BY m.ordinal DESC
        LIMIT 1
      `).get()
      if (!outermost) throw new Error('conversation_compaction_not_found')
      // UI snapshots can lag a completed cascade/autosave. SQLite ordinal is authoritative:
      // restore the current outermost marker rather than rejecting an otherwise valid user action.
      const restoredSnapshotId = outermost.summary_id

      const uiRows = db.prepare(`
        SELECT ui_uuid, message_uuid, payload_json
        FROM ui_messages
        WHERE role_code = 'compaction'
      `).all()
      const deleteUi = db.prepare('DELETE FROM ui_messages WHERE ui_uuid = ?')
      for (const uiRow of uiRows) {
        let matchesSnapshot = uiRow.message_uuid === outermost.message_uuid
        if (!matchesSnapshot) {
          try {
            const payload = JSON.parse(uiRow.payload_json)
            matchesSnapshot = normalizeText(payload?.snapshotId || payload?.id).trim() === restoredSnapshotId
          } catch {
            matchesSnapshot = false
          }
        }
        if (matchesSnapshot) deleteUi.run(uiRow.ui_uuid)
      }

      db.prepare('DELETE FROM messages WHERE message_uuid = ?').run(outermost.message_uuid)

      const archivesRow = db.prepare("SELECT value_json FROM session_state WHERE state_key = 'compactArchives'").get()
      if (archivesRow?.value_json) {
        try {
          const archives = hydrateAttachments(db, JSON.parse(archivesRow.value_json))
          if (Array.isArray(archives)) {
            const nextArchives = archives.filter((item) => normalizeText(item?.id).trim() !== restoredSnapshotId)
            const storedArchives = externalizeAttachments(db, nextArchives, 'state:compactArchives')
            db.prepare("UPDATE session_state SET value_json = ?, updated_at = ? WHERE state_key = 'compactArchives'")
              .run(JSON.stringify(storedArchives), nowIso())
          }
        } catch {
          // A malformed optional archive index must not block restoring the authoritative marker.
        }
      }

      const revision = Number(row.revision) + 1
      const updatedAt = nowIso()
      db.prepare('UPDATE conversation SET updated_at = ?, revision = ? WHERE conversation_id = ?')
        .run(updatedAt, revision, conversationId)
      return { revision, updatedAt, title: row.title, restoredSnapshotId }
    })

    const row = getConversationRow(db)
    const state = loadState(db)
    const activeStart = getActiveMessageStart(db)
    const shouldPage = activeStart === 0 && Number(pageSize) > 0
    const fullHistory = loadMessages(db, { activeOnly: true, limit: shouldPage ? pageSize : 0 })
    let chatShow = loadUiMessages(db, { activeOnly: true, limit: shouldPage ? pageSize : 0 })
    if (chatShow.length === 0) {
      chatShow = fullHistory
        .filter((message) => message.role !== 'tool')
        .map((message, index) => ({ ...clone(message), id: index + 1 }))
    }
    const nextDescriptor = {
      ...descriptor,
      title: row.title,
      revision: row.revision,
      updatedAt: row.updated_at
    }
    try {
      await writeLocalProjects(dirPath, updateConversation(projects, conversationId, {
        title: result.title,
        revision: result.revision,
        updatedAt: result.updatedAt
      }))
    } catch (error) {
      // The authoritative SQLite transaction already committed. Do not report a false
      // restore failure merely because the derived projects index could not refresh.
      console.warn('[conversation] restored compaction but failed to refresh projects index:', error?.message || error)
    }
    return {
      ok: true,
      restoredSnapshotId: result.restoredSnapshotId,
      descriptor: nextDescriptor,
      sessionData: {
        anywhere_history: true,
        ...state,
        sessionMetadata: { ...(state.sessionMetadata || {}), title: row.title, createdAt: row.created_at, updatedAt: row.updated_at },
        fullHistory,
        history: [],
        chat_show: chatShow,
        conversationStorage: {
          format: 'sqlite',
          conversationId: row.conversation_id,
          dbFile: descriptor.dbFile,
          title: row.title,
          revision: row.revision,
          activeOnly: true,
          isPaged: shouldPage,
          loadedFromOrdinal: fullHistory.find((message) => message.role !== 'system')?.storageOrdinal || 0,
          loadedFromUiOrder: chatShow.find((message) => message.role !== 'system')?.uiStorageOrder || 0,
          pageSize: shouldPage ? Number(pageSize) : 0
        }
      }
    }
  } finally {
    db.close()
  }
}


export async function renameConversation({
  dirPath,
  conversationId,
  title,
  projectId,
  expectedRevision,
  holderInstanceId = '',
  leaseEpoch = null
} = {}) {
  const nextTitle = normalizeText(title).trim()
  if (!nextTitle) throw new Error('conversation_title_required')
  const projects = await readLocalProjects(dirPath)
  const descriptor = findConversation(projects, conversationId)
  if (!descriptor) throw new Error('conversation_not_found')
  const db = openDatabase(resolveDatabasePath(dirPath, descriptor.dbFile))
  let revision = 0
  const updatedAt = nowIso()
  try {
    withTransaction(db, () => {
      const row = getConversationRow(db)
      assertConversationWriteLease(db, { holderInstanceId, leaseEpoch })
      if (Number.isFinite(Number(expectedRevision)) && Number(expectedRevision) !== Number(row.revision)) {
        const error = new Error('conversation_revision_conflict')
        error.currentRevision = row.revision
        throw error
      }
      revision = Number(row.revision) + 1
      db.prepare('UPDATE conversation SET title = ?, updated_at = ?, revision = ? WHERE conversation_id = ?')
        .run(nextTitle, updatedAt, revision, conversationId)
    })
  } finally { db.close() }
  const assignedProjects = assignConversationProject(projects, conversationId, projectId)
  const nextProjects = updateConversation(assignedProjects, conversationId, { title: nextTitle, revision, updatedAt })
  await writeLocalProjects(dirPath, nextProjects)
  return { ok: true, conversationId, title: nextTitle, dbFile: descriptor.dbFile, revision, updatedAt }
}

export async function deleteConversation({ dirPath, conversationId, holderInstanceId = '', leaseEpoch = null, deleteLegacyJson = false } = {}) {
  const projects = await readLocalProjects(dirPath)
  const descriptor = findConversation(projects, conversationId)
  if (!descriptor) return { ok: true, removed: false }
  const databasePath = resolveDatabasePath(dirPath, descriptor.dbFile)
  const db = openDatabase(databasePath)
  try {
    initializeSchema(db)
    assertConversationWriteLease(db, { holderInstanceId, leaseEpoch })
  } finally {
    db.close()
  }
  await fs.rm(databasePath, { force: true })
  if (deleteLegacyJson && descriptor.legacyJson) await fs.rm(path.join(path.resolve(dirPath), descriptor.legacyJson), { force: true })
  await writeLocalProjects(dirPath, removeConversationFromProjects(projects, conversationId))
  return { ok: true, removed: true }
}

export async function acquireWriteLease({ dirPath, conversationId, holderInstanceId, holderApp = 'desktop', force = false } = {}) {
  const descriptor = findConversation(await synchronizeLocalProjectsWithDatabases(dirPath), conversationId)
  if (!descriptor) throw new Error('conversation_not_found')
  const db = openDatabase(resolveDatabasePath(dirPath, descriptor.dbFile))
  try {
    initializeSchema(db)
    return withTransaction(db, () => {
      const resource = 'conversation'
      const conversation = getConversationRow(db)
      const holder = normalizeText(holderInstanceId).trim()
      if (!holder) throw new Error('conversation_write_lease_holder_required')
      const current = db.prepare('SELECT * FROM write_lease WHERE resource = ?').get(resource)
      const expired = !current || new Date(current.expires_at).getTime() <= Date.now()
      if (!force && current && !expired && current.holder_instance_id !== holder) {
        return { ok: false, readonly: true, holderApp: current.holder_app, expiresAt: current.expires_at, leaseEpoch: current.lease_epoch, revision: conversation.revision }
      }
      const heartbeatAt = nowIso()
      const expiresAt = new Date(Date.now() + WRITE_LEASE_TTL_MS).toISOString()
      if (!force && current && !expired && current.holder_instance_id === holder) {
        db.prepare("UPDATE write_lease SET holder_app = ?, heartbeat_at = ?, expires_at = ? WHERE resource = 'conversation' AND holder_instance_id = ? AND lease_epoch = ?")
          .run(holderApp, heartbeatAt, expiresAt, holder, current.lease_epoch)
        return { ok: true, readonly: false, leaseEpoch: current.lease_epoch, expiresAt, revision: conversation.revision }
      }
      const epoch = Number(current?.lease_epoch || 0) + 1
      db.prepare(`
        INSERT INTO write_lease(resource, holder_instance_id, holder_app, lease_epoch, heartbeat_at, expires_at)
        VALUES (?, ?, ?, ?, ?, ?)
        ON CONFLICT(resource) DO UPDATE SET
          holder_instance_id = excluded.holder_instance_id,
          holder_app = excluded.holder_app,
          lease_epoch = excluded.lease_epoch,
          heartbeat_at = excluded.heartbeat_at,
          expires_at = excluded.expires_at
      `).run(resource, holder, holderApp, epoch, heartbeatAt, expiresAt)
      return { ok: true, readonly: false, leaseEpoch: epoch, expiresAt, revision: conversation.revision }
    })
  } finally { db.close() }
}

export async function heartbeatWriteLease({ dirPath, conversationId, holderInstanceId, leaseEpoch } = {}) {
  const descriptor = findConversation(await readLocalProjects(dirPath), conversationId)
  if (!descriptor) throw new Error('conversation_not_found')
  const db = openDatabase(resolveDatabasePath(dirPath, descriptor.dbFile))
  try {
    const expiresAt = new Date(Date.now() + WRITE_LEASE_TTL_MS).toISOString()
    const result = db.prepare(`
      UPDATE write_lease SET heartbeat_at = ?, expires_at = ?
      WHERE resource = 'conversation' AND holder_instance_id = ? AND lease_epoch = ?
    `).run(nowIso(), expiresAt, holderInstanceId, leaseEpoch)
    return { ok: Number(result.changes) === 1, expiresAt }
  } finally { db.close() }
}

export async function releaseWriteLease({ dirPath, conversationId, holderInstanceId, leaseEpoch } = {}) {
  const descriptor = findConversation(await readLocalProjects(dirPath), conversationId)
  if (!descriptor) return { ok: true }
  const db = openDatabase(resolveDatabasePath(dirPath, descriptor.dbFile))
  try {
    db.prepare("DELETE FROM write_lease WHERE resource = 'conversation' AND holder_instance_id = ? AND lease_epoch = ?")
      .run(holderInstanceId, leaseEpoch)
    return { ok: true }
  } finally { db.close() }
}

export async function createConversationSnapshot({ dirPath, conversationId, targetPath = '' } = {}) {
  const descriptor = findConversation(await readLocalProjects(dirPath), conversationId)
  if (!descriptor) throw new Error('conversation_not_found')
  const databasePath = resolveDatabasePath(dirPath, descriptor.dbFile)
  const destination = targetPath
    ? path.resolve(targetPath)
    : path.join(path.dirname(databasePath), `.snapshots`, `${descriptor.conversationId}-${Date.now()}.db`)
  await fs.mkdir(path.dirname(destination), { recursive: true })
  await fs.rm(destination, { force: true })
  const db = openDatabase(databasePath)
  try {
    await sqliteBackup(db, destination)
  } finally { db.close() }
  return { ok: true, path: destination, filename: descriptor.dbFile, title: descriptor.title, conversationId }
}

export async function readConversationSnapshot({ dirPath, conversationId } = {}) {
  const snapshot = await createConversationSnapshot({ dirPath, conversationId })
  try {
    const content = await fs.readFile(snapshot.path)
    return {
      ok: true,
      content,
      filename: snapshot.filename,
      title: snapshot.title,
      conversationId: snapshot.conversationId
    }
  } finally {
    await fs.rm(snapshot.path, { force: true }).catch(() => {})
  }
}

export async function importConversationSnapshot({ dirPath, descriptor: rawDescriptor = {}, holderInstanceId = '', leaseEpoch = null, content } = {}) {
  const normalizedDir = path.resolve(normalizeText(dirPath).trim())
  if (!normalizedDir) throw new Error('conversation_local_dir_required')
  const conversationId = normalizeText(rawDescriptor.conversationId).trim()
  const dbFile = normalizeBasename(rawDescriptor.dbFile || createDatabaseFilename(conversationId))
  if (!conversationId || !dbFile.toLowerCase().endsWith(DB_EXTENSION)) throw new Error('conversation_descriptor_invalid')
  const bytes = Buffer.isBuffer(content)
    ? content
    : content instanceof ArrayBuffer
      ? Buffer.from(content)
      : content instanceof Uint8Array
        ? Buffer.from(content)
        : content?.encoding === 'base64' && typeof content?.data === 'string'
        ? Buffer.from(content.data, 'base64')
        : null
  if (!bytes?.length) throw new Error('conversation_snapshot_empty')

  await fs.mkdir(normalizedDir, { recursive: true })
  const finalPath = resolveDatabasePath(normalizedDir, dbFile)
  const downloadPath = `${finalPath}.download`
  if (await fs.access(finalPath).then(() => true, () => false)) {
    const activeDb = openDatabase(finalPath)
    try {
      initializeSchema(activeDb)
      assertConversationWriteLease(activeDb, { holderInstanceId, leaseEpoch })
    } finally {
      activeDb.close()
    }
  }
  await fs.writeFile(downloadPath, bytes)
  try {
    const db = openDatabase(downloadPath, { readOnly: true })
    try {
      const check = db.prepare('PRAGMA quick_check').get()
      if (!check || !Object.values(check).includes('ok')) throw new Error('conversation_database_integrity_failed')
      const row = getConversationRow(db)
      if (row.conversation_id !== conversationId) throw new Error('conversation_snapshot_identity_mismatch')
    } finally { db.close() }
    await fs.rm(finalPath, { force: true })
    await fs.rename(downloadPath, finalPath)

    const importedDb = openDatabase(finalPath)
    let importedMetadata
    try {
      const importedRow = getConversationRow(importedDb)
      const importedTitle = normalizeText(rawDescriptor.title).trim() || importedRow.title
      const importedUpdatedAt = normalizeTimestamp(rawDescriptor.updatedAt) || normalizeTimestamp(importedRow.updated_at) || nowIso()
      const importedCreatedAt = normalizeTimestamp(rawDescriptor.createdAt) || normalizeTimestamp(importedRow.created_at) || importedUpdatedAt
      const importedRevision = Math.max(Number(importedRow.revision) || 0, Number(rawDescriptor.revision) || 0)
      importedDb.prepare('UPDATE conversation SET title = ?, created_at = ?, updated_at = ?, revision = ? WHERE conversation_id = ?')
        .run(importedTitle, importedCreatedAt, importedUpdatedAt, importedRevision, conversationId)
      importedMetadata = {
        ...importedRow,
        title: importedTitle,
        created_at: importedCreatedAt,
        updated_at: importedUpdatedAt,
        revision: importedRevision
      }
    } finally {
      importedDb.close()
    }
    const descriptor = {
      conversationId,
      dbFile,
      title: normalizeText(rawDescriptor.title).trim() || importedMetadata.title,
      legacyJson: normalizeBasename(rawDescriptor.legacyJson),
      storageMode: normalizeText(rawDescriptor.storageMode, 'local').trim() || 'local',
      revision: Math.max(0, Number(importedMetadata.revision) || 0),
      schemaVersion: Math.max(1, Number(rawDescriptor.schemaVersion) || SCHEMA_VERSION),
      createdAt: normalizeTimestamp(importedMetadata.created_at) || nowIso(),
      updatedAt: normalizeTimestamp(importedMetadata.updated_at) || normalizeTimestamp(importedMetadata.created_at) || nowIso()
    }
    const projects = registerConversation(await readLocalProjects(normalizedDir), descriptor)
    await writeLocalProjects(normalizedDir, projects)
    return { ok: true, descriptor, databasePath: finalPath }
  } catch (error) {
    await fs.rm(downloadPath, { force: true }).catch(() => {})
    throw error
  }
}


export async function getConversationDescriptor({ dirPath, reference } = {}) {
  const descriptor = findConversation(await synchronizeLocalProjectsWithDatabases(dirPath), reference)
  return descriptor ? { ok: true, descriptor } : { ok: false, descriptor: null }
}

export const CONVERSATION_SCHEMA_VERSION = SCHEMA_VERSION
