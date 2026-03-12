import { createClient } from 'webdav'

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
    password
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

function toSerializableFileInfo(item = {}) {
  const basename = normalizeText(item.basename || item.filename || item.name).trim()
  return {
    basename,
    filename: basename,
    path: normalizeText(item.filename || item.path || ''),
    type: normalizeText(item.type || 'file'),
    size: Number(item.size || 0),
    lastmod: normalizeText(item.lastmod || item.lastModified || '')
  }
}

export async function listBackups(input = {}) {
  const { client, config } = createWebdavClient(input?.webdavConfig)
  const remoteDir = config.path

  const exists = await client.exists(remoteDir)
  if (!exists) {
    return {
      ok: true,
      exists: false,
      files: []
    }
  }

  const contents = await client.getDirectoryContents(remoteDir, { details: true })
  const files = normalizeDirectoryContents(contents)
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
  if (ensureDirectory && !(await client.exists(remoteDir))) {
    await client.createDirectory(remoteDir, { recursive: true })
  }

  let content = input?.content
  if (typeof content !== 'string') {
    content = JSON.stringify(content ?? {}, null, 2)
  }

  await client.putFileContents(remoteFilePath, content, {
    overwrite: input?.overwrite !== false
  })

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

  const exists = await client.exists(remoteFilePath)
  if (!exists) {
    return {
      ok: false,
      reason: 'webdav_file_not_found',
      filename
    }
  }

  const content = await client.getFileContents(remoteFilePath, { format: 'text' })

  return {
    ok: true,
    filename,
    path: remoteFilePath,
    content: typeof content === 'string' ? content : normalizeText(content)
  }
}

export async function deleteBackup(input = {}) {
  const { client, config } = createWebdavClient(input?.webdavConfig)
  const filename = normalizeFileName(input?.filename)
  const remoteFilePath = `${config.path}/${filename}`

  const exists = await client.exists(remoteFilePath)
  if (!exists) {
    return {
      ok: true,
      deleted: false,
      filename
    }
  }

  await client.deleteFile(remoteFilePath)

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
