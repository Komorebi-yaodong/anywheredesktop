import { createClient } from 'webdav'
import { fetchWithProxy } from './net.js'

function normalizeText(value, fallback = '') {
  if (typeof value === 'string') return value
  if (value == null) return fallback
  return String(value)
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

function normalizeFileName(filename = '') {
  const normalized = normalizeText(filename).trim().replace(/[\\/]/g, '')
  if (!normalized) {
    throw new Error('webdav_filename_required')
  }
  return normalized
}

function toErrorMessage(error, fallback = 'webdav_operation_failed') {
  if (!error) return fallback
  if (typeof error === 'string') return error
  if (typeof error?.message === 'string' && error.message) return error.message
  return fallback
}

function createWebdavClient(webdavConfig = {}) {
  const url = normalizeText(webdavConfig?.url).trim()
  if (!url) {
    throw new Error('webdav_url_required')
  }

  const username = normalizeText(webdavConfig?.username).trim()
  const password = normalizeText(webdavConfig?.password)
  const path = normalizeRemoteDir(webdavConfig?.path)

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
    title: basename.toLowerCase().endsWith('.json') ? basename.slice(0, -5) : basename
  }
}


const WEBDAV_METADATA_TIMEOUT_MS = 5000
const WEBDAV_METADATA_CONCURRENCY = 4

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

  const normalizedBasename = normalizeText(basename).trim()
  if (normalizedBasename.toLowerCase().endsWith('.json')) {
    return normalizedBasename.slice(0, -5)
  }
  return normalizedBasename
}

async function readRemoteSessionMetadata(client, remoteFilePath, basename) {
  try {
    const content = await withTimeout(
      () => client.getFileContents(remoteFilePath, { format: 'text' }),
      WEBDAV_METADATA_TIMEOUT_MS,
      'webdav_metadata_timeout'
    )
    const rawText = typeof content === 'string' ? content : normalizeText(content)
    const sessionData = JSON.parse(rawText)
    if (!sessionData || sessionData.anywhere_history !== true) {
      return null
    }

    const timestamps = collectSessionTimestamps(sessionData)
    const metadata = sessionData.sessionMetadata && typeof sessionData.sessionMetadata === 'object'
      ? sessionData.sessionMetadata
      : {}

    return {
      title: resolveSessionFallbackTitle(basename, sessionData),
      createdAt: normalizeSessionTimestamp(metadata.createdAt) || timestamps[0] || '',
      updatedAt: normalizeSessionTimestamp(metadata.updatedAt) || timestamps[timestamps.length - 1] || ''
    }
  } catch {
    return null
  }
}

export async function listBackups(input = {}) {
  const { client, config } = createWebdavClient(input?.webdavConfig)
  const remoteDir = config.path
  const includeSessionMetadata = input?.includeSessionMetadata === true

  let contents
  try {
    contents = await client.getDirectoryContents(remoteDir, { details: true })
  } catch (error) {
    if (isWebdavNotFoundError(error)) {
      return {
        ok: true,
        exists: false,
        files: []
      }
    }
    throw new Error(toErrorMessage(error, 'webdav_list_failed'))
  }

  const normalizedContents = normalizeDirectoryContents(contents)
  const files = normalizedContents
    .filter((item) => item?.type === 'file')
    .map((item) => toSerializableFileInfo(item))
    .filter((item) => item.basename.toLowerCase().endsWith('.json'))
    .sort(
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
  const { client, config } = createWebdavClient(input?.webdavConfig)
  const filename = normalizeFileName(input?.filename)
  const remoteDir = config.path
  const remoteFilePath = `${remoteDir}/${filename}`

  const ensureDirectory = input?.ensureDirectory !== false
  if (ensureDirectory) {
    try {
      await client.createDirectory(remoteDir, { recursive: true })
    } catch (error) {
      if (!isWebdavMethodNotAllowed(error) && !toErrorMessage(error, '').toLowerCase().includes('already exists')) {
        throw new Error(toErrorMessage(error, 'webdav_create_directory_failed'))
      }
    }
  }

  let content = input?.content
  if (typeof content !== 'string') {
    content = JSON.stringify(content ?? {}, null, 2)
  }

  await client.putFileContents(remoteFilePath, content, {
    overwrite: input?.overwrite !== false
  })

  const lastModified = normalizeText(input?.lastModified).trim()
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

  return {
    ok: true,
    path: remoteFilePath,
    filename
  }
}

export async function readBackup(input = {}) {
  const { client, config } = createWebdavClient(input?.webdavConfig)
  const filename = normalizeFileName(input?.filename)
  const remoteFilePath = `${config.path}/${filename}`

  try {
    const content = await client.getFileContents(remoteFilePath, { format: 'text' })

    return {
      ok: true,
      filename,
      path: remoteFilePath,
      content: typeof content === 'string' ? content : normalizeText(content)
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


function resolveRenamedSessionTitleFromFilename(filename = '') {
  const normalizedFilename = normalizeFileName(filename)
  return normalizedFilename.toLowerCase().endsWith('.json')
    ? normalizedFilename.slice(0, -5)
    : normalizedFilename
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
  const { client, config } = createWebdavClient(input?.webdavConfig)
  const fromFilename = normalizeFileName(input?.fromFilename || input?.filename)
  const toFilename = normalizeFileName(input?.toFilename)
  const fromPath = `${config.path}/${fromFilename}`
  const toPath = `${config.path}/${toFilename}`

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

  return {
    ok: true,
    fromFilename,
    toFilename,
    fromPath,
    toPath,
    metadataSynced
  }
}


export async function deleteBackup(input = {}) {
  const { client, config } = createWebdavClient(input?.webdavConfig)
  const filename = normalizeFileName(input?.filename)
  const remoteFilePath = `${config.path}/${filename}`

  try {
    await client.deleteFile(remoteFilePath)
  } catch (error) {
    if (isWebdavNotFoundError(error)) {
      return {
        ok: true,
        deleted: false,
        filename
      }
    }
    throw new Error(toErrorMessage(error, 'webdav_delete_failed'))
  }

  return {
    ok: true,
    deleted: true,
    filename
  }
}

export async function deleteBackups(input = {}) {
  const filenames = Array.isArray(input?.filenames) ? input.filenames : []

  const deleted = []
  const failed = []

  for (const name of filenames) {
    try {
      const result = await deleteBackup({
        webdavConfig: input?.webdavConfig,
        filename: name
      })

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

  return {
    ok: true,
    deleted,
    failed
  }
}
