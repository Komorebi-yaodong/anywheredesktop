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


function toSerializableFileInfo(item = {}) {
  const basename = normalizeText(item.basename || item.filename || item.name).trim()
  return {
    basename,
    filename: basename,
    path: normalizeText(item.filename || item.path || ''),
    type: normalizeText(item.type || 'file'),
    size: Number(item.size || 0),
    lastmod: normalizeWebdavLastmod(item)
  }
}

export async function listBackups(input = {}) {
  const { client, config } = createWebdavClient(input?.webdavConfig)
  const remoteDir = config.path

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
    .map(toSerializableFileInfo)
    .filter((item) => item.basename.toLowerCase().endsWith('.json'))
    .sort((a, b) => new Date(b.lastmod).getTime() - new Date(a.lastmod).getTime())

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

  return {
    ok: true,
    fromFilename,
    toFilename,
    fromPath,
    toPath
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
