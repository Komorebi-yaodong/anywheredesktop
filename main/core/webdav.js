import { createClient } from 'webdav'
import yaml from 'js-yaml'

import { fetchWithProxy } from './net.js'

const CHAT_METADATA_FILENAME = 'chat-metadata.yaml'
const CHAT_METADATA_VERSION = 1
const CHAT_UPLOAD_BATCH_SIZE = 10
const CHAT_UPLOAD_CONCURRENCY = 10
const WEBDAV_METADATA_TIMEOUT_MS = 5000
const WEBDAV_METADATA_CONCURRENCY = 4

function normalizeText(value, fallback = '') {
  if (typeof value === 'string') return value
  if (value == null) return fallback
  return String(value)
}

function stripJsonExtension(filename = '') {
  const normalized = normalizeText(filename).trim()
  return normalized.toLowerCase().endsWith('.json') ? normalized.slice(0, -5) : normalized
}

function normalizeRemoteDir(inputPath = '/anywhere') {
  let remoteDir = normalizeText(inputPath, '/anywhere').trim()

  if (!remoteDir) {
    remoteDir = '/anywhere'
  }

  if (!remoteDir.startsWith('/')) {
    remoteDir = `/${remoteDir}`
  }

  if (remoteDir.length > 1 && remoteDir.endsWith('/')) {
    remoteDir = remoteDir.slice(0, -1)
  }

  return remoteDir
}

function resolveTargetRemoteDir(webdavConfig = {}, overridePath = '') {
  const customPath = normalizeText(overridePath).trim()
  if (customPath) {
    return normalizeRemoteDir(customPath)
  }
  return normalizeRemoteDir(webdavConfig?.path)
}

function normalizeFileName(filename = '') {
  const normalized = normalizeText(filename).trim().replace(/[\\/]/g, '')
  if (!normalized) {
    throw new Error('webdav_filename_required')
  }
  return normalized
}

function isChatJsonFilename(filename = '') {
  return normalizeText(filename).trim().toLowerCase().endsWith('.json')
}

function toErrorMessage(error, fallback = 'webdav_operation_failed') {
  if (!error) return fallback
  if (typeof error === 'string') return error
  if (typeof error?.message === 'string' && error.message) return error.message
  return fallback
}

function createWebdavClient(webdavConfig = {}, overridePath = '') {
  const url = normalizeText(webdavConfig?.url).trim()
  if (!url) {
    throw new Error('webdav_url_required')
  }

  const username = normalizeText(webdavConfig?.username).trim()
  const password = normalizeText(webdavConfig?.password)
  const path = resolveTargetRemoteDir(webdavConfig, overridePath)

  const client = createClient(url, {
    username,
    password,
    fetch: (input, init) => fetchWithProxy(input, init)
  })

  return {
    client,
    config: {
      url,
      username,
      path
    }
  }
}

function normalizeDirectoryContents(contents) {
  if (Array.isArray(contents)) {
    return contents
  }

  if (contents && Array.isArray(contents.data)) {
    return contents.data
  }

  return []
}

function isWebdavNotFoundError(error) {
  const message = toErrorMessage(error, '').toLowerCase()
  return message.includes('404') || message.includes('not found') || message.includes('does not exist')
}

function isWebdavMethodNotAllowed(error) {
  const message = toErrorMessage(error, '').toLowerCase()
  return message.includes('405') || message.includes('method not allowed')
}

function normalizeWebdavLastmod(item = {}) {
  const candidates = [
    item.lastmod,
    item.lastModified,
    item.mtime,
    item.updatedAt,
    item.modified,
    item.getlastmodified,
    item.props?.getlastmodified,
    item.data?.lastmod,
    item.data?.lastModified,
    item.etag && item.etag.mtime
  ]

  for (const candidate of candidates) {
    if (candidate == null || candidate === '') continue

    if (typeof candidate === 'number' && Number.isFinite(candidate) && candidate > 0) {
      const numericDate = new Date(candidate < 1e12 ? candidate * 1000 : candidate)
      if (!Number.isNaN(numericDate.getTime()) && numericDate.getTime() > 0) {
        return numericDate.toISOString()
      }
    }

    const value = normalizeText(candidate).trim()
    if (!value) continue

    if (/^\d+$/.test(value)) {
      const numericValue = Number(value)
      if (Number.isFinite(numericValue) && numericValue > 0) {
        const numericDate = new Date(value.length <= 10 ? numericValue * 1000 : numericValue)
        if (!Number.isNaN(numericDate.getTime()) && numericDate.getTime() > 0) {
          return numericDate.toISOString()
        }
      }
    }

    const date = new Date(value)
    if (!Number.isNaN(date.getTime()) && date.getTime() > 0) {
      return date.toISOString()
    }
  }

  return ''
}

function normalizeWebdavCreatedAt(item = {}) {
  const candidates = [
    item.createdAt,
    item.creationdate,
    item.created,
    item.birthtime,
    item.ctime,
    item.getcreationdate,
    item.props?.creationdate,
    item.props?.getcreationdate,
    item.data?.createdAt,
    item.data?.creationdate,
    item.data?.created,
    item.data?.birthtime,
    item.data?.ctime
  ]

  for (const candidate of candidates) {
    if (candidate == null || candidate === '') continue

    if (typeof candidate === 'number' && Number.isFinite(candidate) && candidate > 0) {
      const numericDate = new Date(candidate < 1e12 ? candidate * 1000 : candidate)
      if (!Number.isNaN(numericDate.getTime()) && numericDate.getTime() > 0) {
        return numericDate.toISOString()
      }
    }

    const value = normalizeText(candidate).trim()
    if (!value) continue

    if (/^\d+$/.test(value)) {
      const numericValue = Number(value)
      if (Number.isFinite(numericValue) && numericValue > 0) {
        const numericDate = new Date(value.length <= 10 ? numericValue * 1000 : numericValue)
        if (!Number.isNaN(numericDate.getTime()) && numericDate.getTime() > 0) {
          return numericDate.toISOString()
        }
      }
    }

    const date = new Date(value)
    if (!Number.isNaN(date.getTime()) && date.getTime() > 0) {
      return date.toISOString()
    }
  }

  return ''
}

function toSerializableFileInfo(item = {}) {
  const basename = normalizeText(item.basename || item.filename || item.name).trim()
  const createdAt = normalizeWebdavCreatedAt(item)
  const updatedAt = normalizeWebdavLastmod(item) || createdAt
  return {
    basename,
    filename: basename,
    path: normalizeText(item.filename || item.path || ''),
    type: normalizeText(item.type || 'file'),
    size: Number(item.size || 0),
    lastmod: updatedAt,
    createdAt: createdAt || updatedAt,
    updatedAt,
    title: stripJsonExtension(basename)
  }
}

function createTimeoutError(label = 'operation_timeout') {
  const error = new Error(label)
  error.name = 'TimeoutError'
  return error
}

async function withTimeout(task, timeoutMs, timeoutMessage = 'operation_timeout') {
  const normalizedTimeout = Number(timeoutMs)
  if (!Number.isFinite(normalizedTimeout) || normalizedTimeout <= 0) {
    return await task()
  }

  return await Promise.race([
    task(),
    new Promise((_, reject) => {
      setTimeout(() => reject(createTimeoutError(timeoutMessage)), normalizedTimeout)
    })
  ])
}

async function mapWithConcurrency(items, mapper, concurrency = WEBDAV_METADATA_CONCURRENCY) {
  const normalizedConcurrency = Math.max(1, Number(concurrency) || 1)
  const results = new Array(items.length)
  let currentIndex = 0

  const worker = async () => {
    while (currentIndex < items.length) {
      const targetIndex = currentIndex
      currentIndex += 1
      results[targetIndex] = await mapper(items[targetIndex], targetIndex)
    }
  }

  await Promise.all(
    Array.from({ length: Math.min(normalizedConcurrency, items.length || 1) }, () => worker())
  )

  return results
}

function normalizeSessionTimestamp(value) {
  if (value == null || value === '') return ''

  if (typeof value === 'number' && Number.isFinite(value)) {
    const date = new Date(value < 1e12 ? value * 1000 : value)
    return !Number.isNaN(date.getTime()) && date.getTime() > 0 ? date.toISOString() : ''
  }

  const raw = normalizeText(value).trim()
  if (!raw) return ''

  if (/^\d+$/.test(raw)) {
    const numericValue = Number(raw)
    if (Number.isFinite(numericValue) && numericValue > 0) {
      const date = new Date(raw.length <= 10 ? numericValue * 1000 : numericValue)
      if (!Number.isNaN(date.getTime()) && date.getTime() > 0) {
        return date.toISOString()
      }
    }
  }

  const date = new Date(raw)
  return !Number.isNaN(date.getTime()) && date.getTime() > 0 ? date.toISOString() : ''
}

function collectSessionTimestamps(sessionData) {
  const timestamps = []
  const messageLists = [sessionData?.chat_show, sessionData?.history]

  messageLists.forEach((messages) => {
    if (!Array.isArray(messages)) return
    messages.forEach((message) => {
      ;[
        message?.timestamp,
        message?.completedTimestamp,
        message?.updatedAt,
        message?.createdAt
      ].forEach((candidate) => {
        const normalized = normalizeSessionTimestamp(candidate)
        if (normalized) timestamps.push(normalized)
      })
    })
  })

  return timestamps.sort((a, b) => new Date(a).getTime() - new Date(b).getTime())
}

function resolveSessionFallbackTitle(basename = '', sessionData = null) {
  const metadataTitle = normalizeText(sessionData?.sessionMetadata?.title).trim()
  if (metadataTitle) return metadataTitle

  return stripJsonExtension(basename)
}

function extractSessionMetadataFromRawText(rawText, basename) {
  try {
    const sessionData = JSON.parse(rawText)
    if (!sessionData || sessionData.anywhere_history !== true) {
      return null
    }

    const timestamps = collectSessionTimestamps(sessionData)
    const metadata = sessionData.sessionMetadata && typeof sessionData.sessionMetadata === 'object'
      ? sessionData.sessionMetadata
      : {}

    return normalizeChatMetadataEntry(basename, {
      title: resolveSessionFallbackTitle(basename, sessionData),
      createdAt: normalizeSessionTimestamp(metadata.createdAt) || timestamps[0] || '',
      updatedAt: normalizeSessionTimestamp(metadata.updatedAt) || timestamps[timestamps.length - 1] || ''
    })
  } catch {
    return null
  }
}

async function readRemoteSessionMetadata(client, remoteFilePath, basename) {
  try {
    const content = await withTimeout(
      () => client.getFileContents(remoteFilePath, { format: 'text' }),
      WEBDAV_METADATA_TIMEOUT_MS,
      'webdav_metadata_timeout'
    )
    const rawText = typeof content === 'string' ? content : normalizeText(content)
    return extractSessionMetadataFromRawText(rawText, basename)
  } catch {
    return null
  }
}

function createEmptyChatMetadataIndex() {
  return {
    version: CHAT_METADATA_VERSION,
    updatedAt: '',
    chats: {}
  }
}

function normalizeChatMetadataEntry(basename = '', entry = {}) {
  const normalizedBasename = normalizeFileName(basename)
  const title = normalizeText(entry?.title).trim() || stripJsonExtension(normalizedBasename)
  const createdAt = normalizeSessionTimestamp(entry?.createdAt)
  const updatedAt = normalizeSessionTimestamp(entry?.updatedAt)

  return {
    title,
    createdAt: createdAt || updatedAt,
    updatedAt: updatedAt || createdAt
  }
}

function normalizeChatMetadataIndex(input) {
  const raw = input && typeof input === 'object' ? input : {}
  const rawChats = raw.chats && typeof raw.chats === 'object' && !Array.isArray(raw.chats)
    ? raw.chats
    : {}
  const chats = {}

  for (const [rawBasename, rawEntry] of Object.entries(rawChats)) {
    const basenameText = normalizeText(rawBasename).trim()
    if (!basenameText || !isChatJsonFilename(basenameText)) continue

    try {
      const basename = normalizeFileName(basenameText)
      chats[basename] = normalizeChatMetadataEntry(basename, rawEntry)
    } catch {
      // ignore invalid keys
    }
  }

  const sortedChats = {}
  for (const basename of Object.keys(chats).sort((a, b) =>
    a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' })
  )) {
    sortedChats[basename] = chats[basename]
  }

  return {
    version: CHAT_METADATA_VERSION,
    updatedAt: normalizeSessionTimestamp(raw.updatedAt),
    chats: sortedChats
  }
}

function cloneChatMetadataIndex(data) {
  return normalizeChatMetadataIndex(data)
}

function parseChatMetadataYaml(text) {
  const raw = normalizeText(text).trim()
  if (!raw) return createEmptyChatMetadataIndex()

  try {
    const parsed = yaml.load(raw)
    return normalizeChatMetadataIndex(parsed)
  } catch {
    return createEmptyChatMetadataIndex()
  }
}

function serializeChatMetadataYaml(data) {
  const normalized = normalizeChatMetadataIndex(data)
  return yaml.dump(
    {
      version: CHAT_METADATA_VERSION,
      updatedAt: new Date().toISOString(),
      chats: normalized.chats
    },
    { lineWidth: -1, noRefs: true }
  )
}

function isSameChatMetadataEntry(left, right) {
  return normalizeText(left?.title).trim() === normalizeText(right?.title).trim() &&
    normalizeSessionTimestamp(left?.createdAt) === normalizeSessionTimestamp(right?.createdAt) &&
    normalizeSessionTimestamp(left?.updatedAt) === normalizeSessionTimestamp(right?.updatedAt)
}

function deriveChatMetadataFromFileInfo(fileInfo = {}) {
  return normalizeChatMetadataEntry(fileInfo.basename, {
    title: fileInfo.title,
    createdAt: fileInfo.createdAt || fileInfo.lastmod,
    updatedAt: fileInfo.updatedAt || fileInfo.lastmod || fileInfo.createdAt
  })
}

function mergeChatMetadataIntoFileInfo(fileInfo = {}, metadataEntry = null) {
  if (!metadataEntry) return { ...fileInfo }

  const normalizedEntry = normalizeChatMetadataEntry(fileInfo.basename, {
    title: metadataEntry.title || fileInfo.title,
    createdAt: metadataEntry.createdAt || fileInfo.createdAt || fileInfo.lastmod,
    updatedAt: metadataEntry.updatedAt || fileInfo.updatedAt || fileInfo.lastmod || fileInfo.createdAt
  })

  return {
    ...fileInfo,
    title: normalizedEntry.title || fileInfo.title,
    createdAt: normalizedEntry.createdAt || fileInfo.createdAt || fileInfo.lastmod,
    updatedAt: normalizedEntry.updatedAt || fileInfo.updatedAt || normalizedEntry.createdAt || fileInfo.lastmod,
    lastmod: normalizedEntry.updatedAt || fileInfo.lastmod || normalizedEntry.createdAt
  }
}

function buildChatMetadataFilePath(remoteDir) {
  return `${remoteDir}/${CHAT_METADATA_FILENAME}`
}

function shouldUseChatMetadata(input = {}, filename = '') {
  return input?.useChatMetadata === true && isChatJsonFilename(filename)
}

async function ensureRemoteDirectory(client, remoteDir) {
  try {
    await client.createDirectory(remoteDir, { recursive: true })
  } catch (error) {
    const message = toErrorMessage(error, '').toLowerCase()
    if (!isWebdavMethodNotAllowed(error) && !message.includes('already exists')) {
      throw new Error(toErrorMessage(error, 'webdav_create_directory_failed'))
    }
  }
}

function stringifyRemoteContent(content) {
  if (Buffer.isBuffer(content)) return content
  if (content instanceof Uint8Array) return Buffer.from(content)
  if (content instanceof ArrayBuffer) return Buffer.from(content)
  return typeof content === 'string' ? content : JSON.stringify(content ?? {}, null, 2)
}

async function writeRemoteFileContents(client, remoteFilePath, content, options = {}) {
  const normalizedContent = stringifyRemoteContent(content)

  await client.putFileContents(remoteFilePath, normalizedContent, {
    overwrite: options?.overwrite !== false
  })

  const lastModified = normalizeText(options?.lastModified).trim()
  if (lastModified) {
    try {
      await client.customRequest(remoteFilePath, {
        method: 'PROPPATCH',
        headers: { 'Content-Type': 'application/xml' },
        data: `<?xml version="1.0"?>
<d:propertyupdate xmlns:d="DAV:">
  <d:set>
    <d:prop>
      <lastmodified xmlns="DAV:">${lastModified}</lastmodified>
    </d:prop>
  </d:set>
</d:propertyupdate>`
      })
    } catch {
      // ignore servers that do not support setting mtime via PROPPATCH
    }
  }

  return normalizedContent
}


async function listRemoteEntries(client, remoteDir, options = {}) {
  let contents
  try {
    contents = await client.getDirectoryContents(remoteDir, { details: true })
  } catch (error) {
    if (isWebdavNotFoundError(error)) {
      return {
        exists: false,
        files: []
      }
    }
    throw new Error(toErrorMessage(error, 'webdav_list_failed'))
  }

  const includeDirectories = options?.includeDirectories === true
  const includeFiles = options?.includeFiles !== false
  const filter = typeof options?.filter === 'function' ? options.filter : null

  const files = normalizeDirectoryContents(contents)
    .map((item) => toSerializableFileInfo(item))
    .filter((item) => {
      if (item.type === 'directory') return includeDirectories
      if (item.type === 'file') return includeFiles
      return false
    })
    .filter((item) => (filter ? filter(item) : true))

  return {
    exists: true,
    files
  }
}

async function listRemoteJsonFiles(client, remoteDir) {
  return listRemoteEntries(client, remoteDir, {
    includeDirectories: false,
    includeFiles: true,
    filter: (item) => isChatJsonFilename(item.basename)
  })
}

async function readChatMetadataYaml(client, remoteDir) {
  const metadataPath = buildChatMetadataFilePath(remoteDir)
  try {
    const content = await client.getFileContents(metadataPath, { format: 'text' })
    const rawText = typeof content === 'string' ? content : normalizeText(content)
    return {
      exists: true,
      path: metadataPath,
      data: parseChatMetadataYaml(rawText)
    }
  } catch (error) {
    if (isWebdavNotFoundError(error)) {
      return {
        exists: false,
        path: metadataPath,
        data: createEmptyChatMetadataIndex()
      }
    }
    throw new Error(toErrorMessage(error, 'webdav_read_failed'))
  }
}

async function writeChatMetadataYaml(client, remoteDir, data) {
  const metadataPath = buildChatMetadataFilePath(remoteDir)
  await client.putFileContents(metadataPath, serializeChatMetadataYaml(data), { overwrite: true })
  return {
    ok: true,
    path: metadataPath,
    filename: CHAT_METADATA_FILENAME
  }
}

async function loadReconciledChatMetadataState(client, remoteDir, remoteFiles = null) {
  const remoteList = Array.isArray(remoteFiles)
    ? {
      exists: true,
      files: remoteFiles.filter((file) => isChatJsonFilename(file?.basename))
    }
    : await listRemoteJsonFiles(client, remoteDir)

  if (!remoteList.exists) {
    return {
      exists: false,
      data: createEmptyChatMetadataIndex(),
      remoteFiles: [],
      remoteFileMap: new Map(),
      metadataChanged: false,
      metadataExists: false
    }
  }

  const metadataResult = await readChatMetadataYaml(client, remoteDir)
  const nextData = cloneChatMetadataIndex(metadataResult.data)
  const remoteFileMap = new Map(remoteList.files.map((file) => [file.basename, file]))
  let changed = false

  for (const file of remoteList.files) {
    const existingEntry = nextData.chats[file.basename]
    const candidateEntry = existingEntry
      ? normalizeChatMetadataEntry(file.basename, {
        title: existingEntry.title || file.title,
        createdAt: existingEntry.createdAt || file.createdAt,
        updatedAt: existingEntry.updatedAt || file.updatedAt || file.lastmod
      })
      : deriveChatMetadataFromFileInfo(file)

    if (!existingEntry || !isSameChatMetadataEntry(existingEntry, candidateEntry)) {
      nextData.chats[file.basename] = candidateEntry
      changed = true
    }
  }

  for (const basename of Object.keys(nextData.chats)) {
    if (!remoteFileMap.has(basename)) {
      delete nextData.chats[basename]
      changed = true
    }
  }

  if (changed) {
    await writeChatMetadataYaml(client, remoteDir, nextData)
  }

  return {
    exists: true,
    data: cloneChatMetadataIndex(nextData),
    remoteFiles: remoteList.files.map((file) => mergeChatMetadataIntoFileInfo(file, nextData.chats[file.basename])),
    remoteFileMap,
    metadataChanged: changed,
    metadataExists: metadataResult.exists || changed
  }
}

function resolveChatMetadataForUpload({ filename, content, chatMetadata, previousEntry, remoteFile }) {
  const normalizedFilename = normalizeFileName(filename)
  const normalizedContent = stringifyRemoteContent(content)
  const contentTitle = extractSessionMetadataFromRawText(normalizedContent, normalizedFilename)?.title || ''
  const fallbackEntry = previousEntry
    ? normalizeChatMetadataEntry(normalizedFilename, previousEntry)
    : remoteFile
      ? deriveChatMetadataFromFileInfo(remoteFile)
      : null

  return normalizeChatMetadataEntry(normalizedFilename, {
    title:
      normalizeText(chatMetadata?.title).trim() ||
      contentTitle ||
      fallbackEntry?.title ||
      stripJsonExtension(normalizedFilename),
    createdAt:
      normalizeSessionTimestamp(chatMetadata?.createdAt) ||
      fallbackEntry?.createdAt ||
      normalizeSessionTimestamp(chatMetadata?.updatedAt) ||
      fallbackEntry?.updatedAt,
    updatedAt:
      normalizeSessionTimestamp(chatMetadata?.updatedAt) ||
      fallbackEntry?.updatedAt ||
      normalizeSessionTimestamp(chatMetadata?.createdAt) ||
      fallbackEntry?.createdAt
  })
}

export async function listBackups(input = {}) {
  const { client, config } = createWebdavClient(input?.webdavConfig, input?.remotePath)
  const remoteDir = config.path
  const includeSessionMetadata = input?.includeSessionMetadata === true
  const useChatMetadata = input?.useChatMetadata === true

  if (useChatMetadata) {
    const state = await loadReconciledChatMetadataState(client, remoteDir)
    if (!state.exists) {
      return {
        ok: true,
        exists: false,
        files: []
      }
    }

    const files = [...state.remoteFiles].sort(
      (a, b) =>
        new Date(b.createdAt || b.updatedAt || b.lastmod).getTime() -
        new Date(a.createdAt || a.updatedAt || a.lastmod).getTime()
    )

    return {
      ok: true,
      exists: true,
      files,
      metadataSynced: state.metadataChanged
    }
  }

  const remoteList = await listRemoteJsonFiles(client, remoteDir)
  if (!remoteList.exists) {
    return {
      ok: true,
      exists: false,
      files: []
    }
  }

  let files = remoteList.files
  if (includeSessionMetadata && files.length > 0) {
    const enrichedFiles = await mapWithConcurrency(
      files,
      async (file) => {
        const metadata = await readRemoteSessionMetadata(client, `${remoteDir}/${file.basename}`, file.basename)
        return metadata ? mergeChatMetadataIntoFileInfo(file, metadata) : file
      }
    )
    files = enrichedFiles
  }

  files = [...files].sort(
    (a, b) =>
      new Date(b.createdAt || b.updatedAt || b.lastmod).getTime() -
      new Date(a.createdAt || a.updatedAt || a.lastmod).getTime()
  )

  return {
    ok: true,
    exists: true,
    files
  }
}

export async function writeBackup(input = {}) {
  const { client, config } = createWebdavClient(input?.webdavConfig, input?.remotePath)
  const filename = normalizeFileName(input?.filename)
  const remoteDir = config.path
  const remoteFilePath = `${remoteDir}/${filename}`
  const ensureDirectory = input?.ensureDirectory !== false
  const useChatMetadata = shouldUseChatMetadata(input, filename)

  if (ensureDirectory) {
    await ensureRemoteDirectory(client, remoteDir)
  }

  const content = stringifyRemoteContent(input?.content)
  let state = null
  let previousEntry = null
  let nextEntry = null

  if (useChatMetadata) {
    state = await loadReconciledChatMetadataState(client, remoteDir)
    previousEntry = state.data.chats[filename] ? { ...state.data.chats[filename] } : null
    nextEntry = resolveChatMetadataForUpload({
      filename,
      content,
      chatMetadata: input?.chatMetadata,
      previousEntry,
      remoteFile: state.remoteFileMap.get(filename)
    })
    state.data.chats[filename] = nextEntry
    await writeChatMetadataYaml(client, remoteDir, state.data)
  }

  try {
    await writeRemoteFileContents(client, remoteFilePath, content, {
      overwrite: input?.overwrite !== false,
      lastModified: input?.lastModified
    })
  } catch (error) {
    if (useChatMetadata && state) {
      try {
        if (previousEntry) {
          state.data.chats[filename] = previousEntry
        } else {
          delete state.data.chats[filename]
        }
        await writeChatMetadataYaml(client, remoteDir, state.data)
      } catch {
        // ignore rollback failure
      }
    }
    throw new Error(toErrorMessage(error, 'webdav_write_failed'))
  }

  return {
    ok: true,
    path: remoteFilePath,
    filename,
    chatMetadata: nextEntry || null
  }
}

export async function writeBackupsBatch(input = {}) {
  const { client, config } = createWebdavClient(input?.webdavConfig, input?.remotePath)
  const remoteDir = config.path
  const ensureDirectory = input?.ensureDirectory !== false
  const useChatMetadata = input?.useChatMetadata === true
  const overwrite = input?.overwrite !== false
  const batchSize = Math.max(1, Number(input?.batchSize) || CHAT_UPLOAD_BATCH_SIZE)
  const concurrency = Math.max(1, Number(input?.concurrency) || CHAT_UPLOAD_CONCURRENCY)
  const rawFiles = Array.isArray(input?.files) ? input.files : []

  const files = rawFiles
    .map((item) => {
      const filename = normalizeText(item?.filename || item?.basename).trim()
      if (!filename) return null
      try {
        return {
          filename: normalizeFileName(filename),
          content: stringifyRemoteContent(item?.content),
          lastModified: normalizeText(item?.lastModified).trim(),
          chatMetadata: item?.chatMetadata && typeof item.chatMetadata === 'object'
            ? item.chatMetadata
            : null
        }
      } catch {
        return null
      }
    })
    .filter(Boolean)

  if (files.length === 0) {
    return {
      ok: true,
      completed: [],
      failed: []
    }
  }

  if (ensureDirectory) {
    await ensureRemoteDirectory(client, remoteDir)
  }

  const completed = []
  const failed = []

  if (!useChatMetadata) {
    for (let index = 0; index < files.length; index += batchSize) {
      const currentBatch = files.slice(index, index + batchSize)
      const results = await mapWithConcurrency(
        currentBatch,
        async (item) => {
          try {
            await writeRemoteFileContents(client, `${remoteDir}/${item.filename}`, item.content, {
              overwrite,
              lastModified: item.lastModified
            })
            return { ok: true, filename: item.filename }
          } catch (error) {
            return {
              ok: false,
              filename: item.filename,
              message: toErrorMessage(error, 'webdav_write_failed')
            }
          }
        },
        Math.min(concurrency, currentBatch.length || 1)
      )

      results.forEach((result) => {
        if (result?.ok) {
          completed.push(result.filename)
        } else if (result?.filename) {
          failed.push({ filename: result.filename, message: result.message })
        }
      })
    }

    return { ok: true, completed, failed }
  }

  const state = await loadReconciledChatMetadataState(client, remoteDir)

  for (let index = 0; index < files.length; index += batchSize) {
    const currentBatch = files.slice(index, index + batchSize)
    const previousEntries = new Map()

    for (const item of currentBatch) {
      previousEntries.set(item.filename, state.data.chats[item.filename] ? { ...state.data.chats[item.filename] } : null)
      state.data.chats[item.filename] = resolveChatMetadataForUpload({
        filename: item.filename,
        content: item.content,
        chatMetadata: item.chatMetadata,
        previousEntry: previousEntries.get(item.filename),
        remoteFile: state.remoteFileMap.get(item.filename)
      })
    }

    await writeChatMetadataYaml(client, remoteDir, state.data)

    const results = await mapWithConcurrency(
      currentBatch,
      async (item) => {
        try {
          await writeRemoteFileContents(client, `${remoteDir}/${item.filename}`, item.content, {
            overwrite,
            lastModified: item.lastModified
          })
          return { ok: true, filename: item.filename }
        } catch (error) {
          return {
            ok: false,
            filename: item.filename,
            message: toErrorMessage(error, 'webdav_write_failed')
          }
        }
      },
      Math.min(concurrency, currentBatch.length || 1)
    )

    let hasFailed = false

    for (const result of results) {
      if (result?.ok) {
        completed.push(result.filename)
        const mergedInfo = mergeChatMetadataIntoFileInfo(
          state.remoteFileMap.get(result.filename) || {
            basename: result.filename,
            filename: result.filename,
            path: `${remoteDir}/${result.filename}`,
            type: 'file',
            size: 0,
            lastmod: state.data.chats[result.filename]?.updatedAt || '',
            createdAt: state.data.chats[result.filename]?.createdAt || '',
            updatedAt: state.data.chats[result.filename]?.updatedAt || '',
            title: state.data.chats[result.filename]?.title || stripJsonExtension(result.filename)
          },
          state.data.chats[result.filename]
        )
        state.remoteFileMap.set(result.filename, mergedInfo)
      } else if (result?.filename) {
        hasFailed = true
        failed.push({ filename: result.filename, message: result.message })
        const previousEntry = previousEntries.get(result.filename)
        if (previousEntry) {
          state.data.chats[result.filename] = previousEntry
        } else {
          delete state.data.chats[result.filename]
        }
      }
    }

    if (hasFailed) {
      await writeChatMetadataYaml(client, remoteDir, state.data)
    }
  }

  return {
    ok: true,
    completed,
    failed
  }
}

export async function readBackup(input = {}) {
  const { client, config } = createWebdavClient(input?.webdavConfig, input?.remotePath)
  const filename = normalizeFileName(input?.filename)
  const remoteFilePath = `${config.path}/${filename}`
  const useChatMetadata = shouldUseChatMetadata(input, filename)
  let chatMetadata = null

  if (useChatMetadata) {
    try {
      const state = await loadReconciledChatMetadataState(client, config.path)
      chatMetadata = state.data.chats[filename] || null
    } catch {
      chatMetadata = null
    }
  }

  try {
    const content = await client.getFileContents(remoteFilePath, { format: 'text' })

    return {
      ok: true,
      filename,
      path: remoteFilePath,
      content: typeof content === 'string' ? content : normalizeText(content),
      chatMetadata
    }
  } catch (error) {
    if (isWebdavNotFoundError(error)) {
      return {
        ok: false,
        reason: 'webdav_file_not_found',
        filename
      }
    }
    throw new Error(toErrorMessage(error, 'webdav_read_failed'))
  }
}


export async function readBackupBinary(input = {}) {
  const { client, config } = createWebdavClient(input?.webdavConfig, input?.remotePath)
  const filename = normalizeFileName(input?.filename)
  const remoteFilePath = `${config.path}/${filename}`

  try {
    const content = await client.getFileContents(remoteFilePath, { format: 'binary' })
    return {
      ok: true,
      filename,
      content: Buffer.isBuffer(content) ? content : Buffer.from(content || [])
    }
  } catch (error) {
    if (isWebdavNotFoundError(error)) {
      return {
        ok: false,
        reason: 'webdav_file_not_found',
        filename
      }
    }
    throw new Error(toErrorMessage(error, 'webdav_read_failed'))
  }
}

export async function listDirectory(input = {}) {
  const { client, config } = createWebdavClient(input?.webdavConfig, input?.remotePath)
  const includeDirectories = input?.includeDirectories !== false
  const includeFiles = input?.includeFiles !== false
  const result = await listRemoteEntries(client, config.path, { includeDirectories, includeFiles })
  return {
    ok: true,
    exists: result.exists,
    files: result.files
  }
}

export async function deleteDirectoryContents(input = {}) {
  const { client, config } = createWebdavClient(input?.webdavConfig, input?.remotePath)
  const result = await listRemoteEntries(client, config.path, { includeDirectories: false, includeFiles: true })
  const deleted = []
  const failed = []
  const requestedNames = Array.isArray(input?.filenames)
    ? new Set(input.filenames.map((item) => normalizeText(item).trim()).filter(Boolean))
    : null

  if (!result.exists) {
    return { ok: true, deleted, failed }
  }

  for (const file of result.files) {
    if (requestedNames && !requestedNames.has(file.basename)) continue
    try {
      await client.deleteFile(`${config.path}/${file.basename}`)
      deleted.push(file.basename)
    } catch (error) {
      failed.push({ filename: file.basename, message: toErrorMessage(error, 'webdav_delete_failed') })
    }
  }

  return {
    ok: true,
    deleted,
    failed
  }
}

function resolveRenamedSessionTitleFromFilename(filename = '') {
  return stripJsonExtension(normalizeFileName(filename))
}

async function syncRemoteSessionMetadataTitleAfterMove(client, remoteFilePath, title) {
  const normalizedTitle = normalizeText(title).trim()
  if (!normalizedTitle) return false

  try {
    const content = await client.getFileContents(remoteFilePath, { format: 'text' })
    const rawText = typeof content === 'string' ? content : normalizeText(content)
    const sessionData = JSON.parse(rawText)
    if (!sessionData || sessionData.anywhere_history !== true || typeof sessionData !== 'object') {
      return false
    }

    const sessionMetadata =
      sessionData.sessionMetadata && typeof sessionData.sessionMetadata === 'object'
        ? sessionData.sessionMetadata
        : {}

    if (normalizeText(sessionMetadata.title).trim() === normalizedTitle) {
      return false
    }

    sessionData.sessionMetadata = {
      ...sessionMetadata,
      title: normalizedTitle
    }

    await client.putFileContents(remoteFilePath, JSON.stringify(sessionData, null, 2), {
      overwrite: true
    })
    return true
  } catch {
    return false
  }
}

export async function moveFile(input = {}) {
  const { client, config } = createWebdavClient(input?.webdavConfig, input?.remotePath)
  const fromFilename = normalizeFileName(input?.fromFilename || input?.filename)
  const toFilename = normalizeFileName(input?.toFilename)
  const fromPath = `${config.path}/${fromFilename}`
  const toPath = `${config.path}/${toFilename}`
  const useChatMetadata = input?.useChatMetadata === true && (isChatJsonFilename(fromFilename) || isChatJsonFilename(toFilename))

  let metadataState = null
  let metadataSeed = null
  let chatMetadataSynced = false
  let chatMetadataError = ''

  if (useChatMetadata) {
    try {
      metadataState = await loadReconciledChatMetadataState(client, config.path)
      metadataSeed = metadataState.data.chats[fromFilename]
        ? { ...metadataState.data.chats[fromFilename] }
        : metadataState.remoteFileMap.get(fromFilename)
          ? deriveChatMetadataFromFileInfo(metadataState.remoteFileMap.get(fromFilename))
          : null
    } catch (error) {
      chatMetadataError = toErrorMessage(error)
    }
  }

  try {
    await client.moveFile(fromPath, toPath)
  } catch (error) {
    if (isWebdavNotFoundError(error)) {
      return {
        ok: false,
        reason: 'webdav_file_not_found',
        filename: fromFilename
      }
    }
    throw new Error(toErrorMessage(error, 'webdav_move_failed'))
  }

  const metadataSynced = await syncRemoteSessionMetadataTitleAfterMove(
    client,
    toPath,
    resolveRenamedSessionTitleFromFilename(toFilename)
  )

  if (useChatMetadata && metadataState) {
    try {
      delete metadataState.data.chats[fromFilename]
      if (isChatJsonFilename(toFilename)) {
        metadataState.data.chats[toFilename] = normalizeChatMetadataEntry(toFilename, {
          ...metadataSeed,
          title: resolveRenamedSessionTitleFromFilename(toFilename)
        })
      }
      await writeChatMetadataYaml(client, config.path, metadataState.data)
      chatMetadataSynced = true
    } catch (error) {
      chatMetadataError = toErrorMessage(error)
    }
  }

  return {
    ok: true,
    fromFilename,
    toFilename,
    fromPath,
    toPath,
    metadataSynced,
    chatMetadataSynced,
    chatMetadataError
  }
}

export async function deleteBackup(input = {}) {
  const { client, config } = createWebdavClient(input?.webdavConfig, input?.remotePath)
  const filename = normalizeFileName(input?.filename)
  const remoteFilePath = `${config.path}/${filename}`
  const useChatMetadata = shouldUseChatMetadata(input, filename)
  let deleted = false
  let chatMetadataSynced = false
  let chatMetadataError = ''

  try {
    await client.deleteFile(remoteFilePath)
    deleted = true
  } catch (error) {
    if (!isWebdavNotFoundError(error)) {
      throw new Error(toErrorMessage(error, 'webdav_delete_failed'))
    }
  }

  if (useChatMetadata) {
    try {
      const state = await loadReconciledChatMetadataState(client, config.path)
      if (state.exists && state.data.chats[filename]) {
        delete state.data.chats[filename]
        await writeChatMetadataYaml(client, config.path, state.data)
      }
      chatMetadataSynced = true
    } catch (error) {
      chatMetadataError = toErrorMessage(error)
    }
  }

  return {
    ok: true,
    deleted,
    filename,
    chatMetadataSynced,
    chatMetadataError
  }
}

export async function deleteBackups(input = {}) {
  const filenames = Array.isArray(input?.filenames) ? input.filenames : []
  const useChatMetadata = input?.useChatMetadata === true
  const deleted = []
  const failed = []
  const handledForMetadata = []

  for (const name of filenames) {
    try {
      const result = await deleteBackup({
        webdavConfig: input?.webdavConfig,
        filename: name,
        useChatMetadata: false
      })

      handledForMetadata.push(normalizeText(name).trim())
      if (result?.deleted) {
        deleted.push(result.filename)
      }
    } catch (error) {
      failed.push({
        filename: normalizeText(name),
        message: toErrorMessage(error)
      })
    }
  }

  let chatMetadataSynced = false
  let chatMetadataError = ''

  if (useChatMetadata && handledForMetadata.length > 0) {
    try {
      const { client, config } = createWebdavClient(input?.webdavConfig, input?.remotePath)
      const state = await loadReconciledChatMetadataState(client, config.path)
      let changed = false
      handledForMetadata.forEach((name) => {
        const normalizedName = normalizeText(name).trim()
        if (normalizedName && state.data.chats[normalizedName]) {
          delete state.data.chats[normalizedName]
          changed = true
        }
      })
      if (changed) {
        await writeChatMetadataYaml(client, config.path, state.data)
      }
      chatMetadataSynced = true
    } catch (error) {
      chatMetadataError = toErrorMessage(error)
    }
  }

  return {
    ok: true,
    deleted,
    failed,
    chatMetadataSynced,
    chatMetadataError
  }
}
