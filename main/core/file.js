import fs from 'node:fs/promises'

import { fetchWithProxy } from './net.js'

import path from 'node:path'
import { dialog } from 'electron'

const TEXT_EXTENSIONS = [
  '.txt',
  '.md',
  '.markdown',
  '.json',
  '.xml',
  '.html',
  '.htm',
  '.css',
  '.csv',
  '.py',
  '.js',
  '.ts',
  '.java',
  '.c',
  '.cpp',
  '.h',
  '.hpp',
  '.cs',
  '.go',
  '.php',
  '.rb',
  '.rs',
  '.sh',
  '.sql',
  '.vue',
  '.tex',
  '.latex',
  '.bib',
  '.sty',
  '.yaml',
  '.yml',
  '.ini',
  '.bat',
  '.log',
  '.toml',
  '.svg'
]

const DOC_EXTENSIONS = ['.docx']
const EXCEL_EXTENSIONS = ['.xlsx', '.xls']
const IMAGE_EXTENSIONS = ['.png', '.jpg', '.jpeg', '.webp', '.gif']
const AUDIO_EXTENSIONS = ['.mp3', '.wav']
const PDF_EXTENSIONS = ['.pdf']


const UNSUPPORTED_BINARY_EXTENSIONS = [
  '.doc',
  '.pptx',
  '.ppt',
  '.odt',
  '.ods',
  '.epub',
  '.mobi',
  '.bmp',
  '.ico',
  '.mp4',
  '.mov',
  '.avi',
  '.mkv',
  '.zip',
  '.rar',
  '.7z',
  '.tar',
  '.gz',
  '.exe',
  '.dll',
  '.bin',
  '.so',
  '.dmg',
  '.class',
  '.jar',
  '.pyc'
]


const extensionToMimeType = {
  '.txt': 'text/plain',
  '.md': 'text/markdown',
  '.markdown': 'text/markdown',
  '.json': 'application/json',
  '.xml': 'application/xml',
  '.html': 'text/html',
  '.htm': 'text/html',
  '.css': 'text/css',
  '.csv': 'text/csv',
  '.py': 'text/plain',
  '.js': 'application/javascript',
  '.ts': 'application/typescript',
  '.java': 'text/x-java-source',
  '.c': 'text/plain',
  '.cpp': 'text/plain',
  '.h': 'text/plain',
  '.hpp': 'text/plain',
  '.cs': 'text/plain',
  '.go': 'text/plain',
  '.php': 'application/x-httpd-php',
  '.rb': 'application/x-ruby',
  '.rs': 'text/rust',
  '.sh': 'application/x-sh',
  '.sql': 'application/sql',
  '.vue': 'text/plain',
  '.tex': 'text/x-tex',
  '.latex': 'text/x-tex',
  '.bib': 'text/plain',
  '.sty': 'text/plain',
  '.yaml': 'text/yaml',
  '.yml': 'text/yaml',
  '.ini': 'text/plain',
  '.toml': 'text/plain',
  '.bat': 'text/plain',
  '.log': 'text/plain',
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.pdf': 'application/pdf',
  '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  '.xls': 'application/vnd.ms-excel',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.svg': 'image/svg+xml',
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav'
}

function getExtension(fileName = '') {
  if (typeof fileName !== 'string') return ''
  return path.extname(fileName).toLowerCase()
}

function getMimeTypeByFileName(fileName = '') {
  const ext = getExtension(fileName)
  return extensionToMimeType[ext] || 'application/octet-stream'
}

function extractBase64FromDataUrl(dataUrl = '') {
  if (typeof dataUrl !== 'string') return null
  const match = dataUrl.match(/^data:.*?;base64,(.+)$/)
  return match?.[1] || null
}

function buildDataUrl(base64, mimeType = 'application/octet-stream') {
  return `data:${mimeType};base64,${base64}`
}

async function normalizeFileObject(fileObj = {}) {
  if (!fileObj || typeof fileObj !== 'object') {
    throw new Error('[file] file object is required')
  }

  const filePath =
    typeof fileObj.path === 'string' && fileObj.path.trim()
      ? path.resolve(fileObj.path)
      : typeof fileObj.filePath === 'string' && fileObj.filePath.trim()
        ? path.resolve(fileObj.filePath)
        : ''

  let fileName =
    typeof fileObj.name === 'string' && fileObj.name.trim()
      ? fileObj.name.trim()
      : filePath
        ? path.basename(filePath)
        : 'unknown'

  let mimeType =
    typeof fileObj.type === 'string' && fileObj.type.trim()
      ? fileObj.type.trim()
      : getMimeTypeByFileName(fileName)

  let base64 = null

  if (typeof fileObj.url === 'string' && fileObj.url.startsWith('data:')) {
    base64 = extractBase64FromDataUrl(fileObj.url)
  }

  if (!base64 && typeof fileObj.base64 === 'string' && fileObj.base64.trim()) {
    base64 = fileObj.base64.trim()
  }

  if (!base64 && typeof fileObj.buffer === 'string' && fileObj.buffer.trim()) {
    base64 = fileObj.buffer.trim()
  }

  if (!base64 && fileObj.buffer && typeof fileObj.buffer === 'object' && Array.isArray(fileObj.buffer.data)) {
    base64 = Buffer.from(fileObj.buffer.data).toString('base64')
  }

  if (!base64 && filePath) {
    const fileBuffer = await fs.readFile(filePath)
    base64 = fileBuffer.toString('base64')
    if (!mimeType || mimeType === 'application/octet-stream') {
      mimeType = getMimeTypeByFileName(fileName)
    }
  }

  if (!base64) {
    throw new Error(`[file] failed to resolve file data for '${fileName}'`)
  }

  const url =
    typeof fileObj.url === 'string' && fileObj.url.startsWith('data:')
      ? fileObj.url
      : buildDataUrl(base64, mimeType)

  const size =
    typeof fileObj.size === 'number' && Number.isFinite(fileObj.size)
      ? fileObj.size
      : Buffer.from(base64, 'base64').byteLength

  return {
    name: fileName,
    path: filePath || null,
    type: mimeType,
    size,
    url,
    base64
  }
}

async function parseTextFileFromDataUrl(dataUrl = '') {
  const base64 = extractBase64FromDataUrl(dataUrl)
  if (!base64) {
    throw new Error('Invalid base64 data for text file')
  }

  return Buffer.from(base64, 'base64').toString('utf-8')
}

async function parseWordFileFromDataUrl(dataUrl = '') {
  const base64 = extractBase64FromDataUrl(dataUrl)
  if (!base64) {
    throw new Error('Invalid base64 data for Word file')
  }

  const buffer = Buffer.from(base64, 'base64')
  const mammoth = await import('mammoth')
  const result = await mammoth.convertToHtml({ buffer })
  return String(result?.value || '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

async function parseExcelFileFromDataUrl(dataUrl = '') {
  const base64 = extractBase64FromDataUrl(dataUrl)
  if (!base64) {
    throw new Error('Invalid base64 data for Excel file')
  }

  const buffer = Buffer.from(base64, 'base64')
  const xlsx = await import('xlsx')
  const workbook = xlsx.read(buffer, { type: 'buffer' })

  let fullTextContent = ''
  workbook.SheetNames.forEach((sheetName) => {
    const worksheet = workbook.Sheets[sheetName]
    const csvData = xlsx.utils.sheet_to_csv(worksheet)
    fullTextContent += `--- Sheet: ${sheetName} ---\n${csvData}\n\n`
  })

  return fullTextContent.trim()
}


function looksLikeBinaryByBase64(base64 = '') {
  if (typeof base64 !== 'string' || !base64) {
    return false
  }

  try {
    // 截取前 8192 个 base64 字符进行探针，解码后约 6KB
    const probeBuffer = Buffer.from(base64.slice(0, 8192), 'base64')
    for (let i = 0; i < probeBuffer.length; i += 1) {
      if (probeBuffer[i] === 0) {
        return true
      }
    }
    return false
  } catch (error) {
    console.warn('[file] 内容探针检查失败:', error)
    return false
  }
}


function getFileCategoryByName(fileName = '') {
  const extension = getExtension(fileName)

  if (TEXT_EXTENSIONS.includes(extension)) return 'text'
  if (DOC_EXTENSIONS.includes(extension)) return 'docx'
  if (EXCEL_EXTENSIONS.includes(extension)) return 'excel'
  if (IMAGE_EXTENSIONS.includes(extension)) return 'image'
  if (AUDIO_EXTENSIONS.includes(extension)) return 'audio'
  if (PDF_EXTENSIONS.includes(extension)) return 'pdf'

  return 'unknown'
}

export function isFileTypeSupported(fileName) {
  const extension = getExtension(fileName)

  // 1) 白名单内直接支持
  if (getFileCategoryByName(fileName) !== 'unknown') {
    return true
  }

  // 2) 明确二进制黑名单直接拒绝
  if (!extension || UNSUPPORTED_BINARY_EXTENSIONS.includes(extension)) {
    return false
  }

  // 3) 其余未知后缀先交给内容探针进一步判断
  return true
}

export async function parseFileObject(fileObj) {
  const normalized = await normalizeFileObject(fileObj)
  let category = getFileCategoryByName(normalized.name)

  if (category === 'unknown') {
    const extension = getExtension(normalized.name)

    if (UNSUPPORTED_BINARY_EXTENSIONS.includes(extension)) {
      throw new Error(`不支持的文件类型且疑似为二进制文件: ${normalized.name}`)
    }

    const isBinary = looksLikeBinaryByBase64(normalized.base64)
    if (!isBinary) {
      category = 'text'
    } else {
      throw new Error(`不支持的文件类型且疑似为二进制文件: ${normalized.name}`)
    }
  }

  if (category === 'text') {
    const content = await parseTextFileFromDataUrl(normalized.url)
    return {
      type: 'text',
      text: `file name:${normalized.name}\nfile content:\n${content}\nfile end`
    }
  }

  if (category === 'docx') {
    const content = await parseWordFileFromDataUrl(normalized.url)
    return {
      type: 'text',
      text: `file name:${normalized.name}\nfile content:\n${content}\nfile end`
    }
  }

  if (category === 'excel') {
    const content = await parseExcelFileFromDataUrl(normalized.url)
    return {
      type: 'text',
      text: `file name:${normalized.name}\nfile content:\n${content}\nfile end`
    }
  }

  if (category === 'pdf') {
    return {
      type: 'file',
      file: {
        filename: normalized.name,
        file_data: normalized.url
      }
    }
  }

  if (category === 'image') {
    return {
      type: 'image_url',
      image_url: {
        url: normalized.url
      }
    }
  }

  if (category === 'audio') {
    const format = getExtension(normalized.name).replace('.', '').toLowerCase() || 'wav'
    const base64 = extractBase64FromDataUrl(normalized.url)

    if (!base64) {
      throw new Error(`音频文件 ${normalized.name} 格式不正确`)
    }

    return {
      type: 'input_audio',
      input_audio: {
        data: base64,
        format
      }
    }
  }

  throw new Error(`无法解析文件类型: ${normalized.name}`)
}


export async function probeFilePathSupport(filePath = '') {
  if (typeof filePath !== 'string' || !filePath.trim()) {
    return {
      supported: false,
      reason: 'invalid_file_path'
    }
  }

  const resolvedPath = path.resolve(filePath.trim())
  const fileName = path.basename(resolvedPath)

  try {
    const stat = await fs.stat(resolvedPath)
    if (!stat.isFile()) {
      return {
        supported: false,
        reason: 'is_directory',
        fileName,
        extension: '',
        isDirectory: true
      }
    }
  } catch (error) {
    return {
      supported: false,
      reason: 'probe_failed',
      fileName,
      extension: getExtension(fileName),
      error: error?.message || String(error)
    }
  }

  const extension = getExtension(fileName)

  if (!extension || UNSUPPORTED_BINARY_EXTENSIONS.includes(extension)) {
    return {
      supported: false,
      reason: 'unsupported_extension',
      fileName,
      extension
    }
  }

  if (getFileCategoryByName(fileName) !== 'unknown') {
    return {
      supported: true,
      reason: 'whitelisted_extension',
      fileName,
      extension
    }
  }

  try {
    const probeBuffer = await fs.readFile(resolvedPath)
    const isBinary = looksLikeBinaryByBase64(probeBuffer.toString('base64'))
    return {
      supported: !isBinary,
      reason: isBinary ? 'binary_probe_rejected' : 'text_probe_passed',
      fileName,
      extension
    }
  } catch (error) {
    return {
      supported: false,
      reason: 'probe_failed',
      fileName,
      extension,
      error: error?.message || String(error)
    }
  }
}

export async function handleFilePath(filePath) {
  if (typeof filePath !== 'string' || !filePath.trim()) {
    return null
  }

  const resolvedPath = path.resolve(filePath.trim())

  try {
    const stat = await fs.stat(resolvedPath)
    if (!stat.isFile()) return null

    const fileBuffer = await fs.readFile(resolvedPath)
    const fileName = path.basename(resolvedPath)
    const mimeType = getMimeTypeByFileName(fileName)

    return {
      name: fileName,
      path: resolvedPath,
      size: stat.size,
      type: mimeType,
      lastModified: stat.mtimeMs,
      base64: fileBuffer.toString('base64'),
      encoding: 'base64'
    }
  } catch (error) {
    console.error(`[file] 处理文件路径失败: ${resolvedPath}`, error)
    return null
  }
}

export async function sendfileDirect(filePathList) {
  if (!Array.isArray(filePathList) || filePathList.length === 0) {
    return []
  }

  const contentPromises = filePathList.map(async (item) => {
    try {
      const filePath =
        typeof item === 'string'
          ? item
          : typeof item?.path === 'string'
            ? item.path
            : typeof item?.filePath === 'string'
              ? item.filePath
              : ''

      if (!filePath) return null

      const fileObject = await handleFilePath(filePath)
      if (!fileObject) return null

      return parseFileObject({
        name: fileObject.name,
        type: fileObject.type,
        size: fileObject.size,
        base64: fileObject.base64
      })
    } catch (error) {
      if (!String(error?.message || '').includes('不支持的文件类型')) {
        console.error(`[file] 处理文件出错: ${item?.path || item}`, error)
      }
      return null
    }
  })

  return (await Promise.all(contentPromises)).filter(Boolean)
}

export async function saveFile(options = {}) {
  const { fileContent = '', ...dialogOptions } = options

  const result = await dialog.showSaveDialog(dialogOptions)
  if (result.canceled || !result.filePath) {
    throw new Error('用户取消了保存操作')
  }

  let content = fileContent

  if (
    fileContent &&
    typeof fileContent === 'object' &&
    typeof fileContent.__type === 'string' &&
    typeof fileContent.data === 'string' &&
    fileContent.encoding === 'base64'
  ) {
    content = Buffer.from(fileContent.data, 'base64')
  } else if (ArrayBuffer.isView(fileContent)) {
    content = Buffer.from(fileContent.buffer, fileContent.byteOffset, fileContent.byteLength)
  } else if (fileContent instanceof ArrayBuffer) {
    content = Buffer.from(fileContent)
  } else if (!(typeof fileContent === 'string' || Buffer.isBuffer(fileContent))) {
    content = JSON.stringify(fileContent, null, 2)
  }

  await fs.writeFile(result.filePath, content)

  return {
    success: true,
    path: result.filePath
  }
}


export async function exportLocalChatFile(filePath, options = {}) {
  const resolvedPath = path.resolve(String(filePath || '').trim())
  if (!resolvedPath) {
    throw new Error('invalid_local_chat_file_path')
  }

  const fileContent = await fs.readFile(resolvedPath)
  return saveFile({
    ...options,
    fileContent
  })
}

export async function selectDirectory() {
  const result = await dialog.showOpenDialog({
    properties: ['openDirectory']
  })

  if (result.canceled || !Array.isArray(result.filePaths) || result.filePaths.length === 0) {
    return null
  }

  return result.filePaths[0]
}


export async function readRemoteBinary(url = '', options = {}) {
  const targetUrl = typeof url === 'string' ? url.trim() : ''
  if (!targetUrl || !/^https?:\/\//i.test(targetUrl)) {
    return {
      ok: false,
      message: 'invalid_remote_url'
    }
  }

  const response = await fetchWithProxy(targetUrl, {
    signal: options?.signal,
    headers: options?.headers && typeof options.headers === 'object' ? options.headers : undefined
  })

  if (!response.ok) {
    return {
      ok: false,
      message: `remote_request_failed: ${response.status} ${response.statusText}`
    }
  }

  const arrayBuffer = await response.arrayBuffer()
  return {
    ok: true,
    url: targetUrl,
    contentType: response.headers.get('content-type') || 'application/octet-stream',
    data: Buffer.from(arrayBuffer)
  }
}

export async function readRemoteText(url = '', options = {}) {
  const result = await readRemoteBinary(url, options)
  if (!result?.ok) return result

  return {
    ok: true,
    url: result.url,
    contentType: result.contentType,
    text: result.data.toString(typeof options?.encoding === 'string' && options.encoding ? options.encoding : 'utf8')
  }
}


const localSessionMetadataCache = new Map()

const buildLocalSessionCacheKey = (filePath) => {
  const normalizedPath = String(filePath || '').trim()
  return normalizedPath ? path.resolve(normalizedPath) : ''
}

const cloneSessionMetadataCacheEntry = (entry) => (entry ? { ...entry } : null)

const invalidateLocalSessionMetadataCache = (...filePaths) => {
  filePaths.forEach((filePath) => {
    const cacheKey = buildLocalSessionCacheKey(filePath)
    if (cacheKey) {
      localSessionMetadataCache.delete(cacheKey)
    }
  })
}

const createSessionFileSummary = ({ filePath, basename, stats }) => {
  const normalizedBasename = basename || path.basename(filePath)
  const createdAt =
    normalizeSessionTimestamp(stats.birthtime) ||
    normalizeSessionTimestamp(stats.ctime) ||
    normalizeSessionTimestamp(stats.mtime)
  const updatedAt = normalizeSessionTimestamp(stats.mtime) || createdAt

  return {
    basename: normalizedBasename,
    path: filePath,
    lastmod: stats.mtime.toISOString(),
    createdAt,
    updatedAt,
    title: resolveFallbackTitle(normalizedBasename),
    size: stats.size,
    type: 'file'
  }
}

const pruneLocalSessionMetadataCache = (validFilePaths) => {
  const validPathSet = new Set(
    validFilePaths.map((filePath) => buildLocalSessionCacheKey(filePath)).filter(Boolean)
  )
  for (const cacheKey of localSessionMetadataCache.keys()) {
    if (!validPathSet.has(cacheKey)) {
      localSessionMetadataCache.delete(cacheKey)
    }
  }
}

const normalizeSessionTimestamp = (value) => {
  if (value == null || value === '') return ''

  if (typeof value === 'number' && Number.isFinite(value)) {
    const date = new Date(value)
    return Number.isNaN(date.getTime()) || date.getTime() <= 0 ? '' : date.toISOString()
  }

  const raw = String(value).trim()
  if (!raw) return ''

  if (/^\d+$/.test(raw)) {
    const numericValue = Number(raw)
    if (Number.isFinite(numericValue) && numericValue > 0) {
      const normalizedNumber = raw.length <= 10 ? numericValue * 1000 : numericValue
      const numericDate = new Date(normalizedNumber)
      if (!Number.isNaN(numericDate.getTime()) && numericDate.getTime() > 0) {
        return numericDate.toISOString()
      }
    }
  }

  const date = new Date(raw)
  return Number.isNaN(date.getTime()) || date.getTime() <= 0 ? '' : date.toISOString()
}

const collectSessionTimestamps = (sessionData) => {
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

const resolveFallbackTitle = (basename, sessionData) => {
  const sessionMetadataTitle =
    typeof sessionData?.sessionMetadata?.title === 'string' ? sessionData.sessionMetadata.title.trim() : ''
  if (sessionMetadataTitle) return sessionMetadataTitle

  const normalizedBasename = typeof basename === 'string' ? basename.trim() : ''
  if (normalizedBasename.toLowerCase().endsWith('.json')) {
    return normalizedBasename.slice(0, -5)
  }
  return normalizedBasename
}

const readSessionMetadata = async (filePath, basename, cacheContext = null) => {
  const cacheKey = buildLocalSessionCacheKey(filePath)

  if (cacheContext?.stats && cacheKey) {
    const cachedEntry = localSessionMetadataCache.get(cacheKey)
    const { mtimeMs, size } = cacheContext.stats
    if (cachedEntry && cachedEntry.mtimeMs === mtimeMs && cachedEntry.size === size) {
      return cloneSessionMetadataCacheEntry(cachedEntry.sessionMetadata)
    }
  }

  try {
    const rawContent = await fs.readFile(filePath, 'utf-8')
    const sessionData = JSON.parse(rawContent)
    if (!sessionData || sessionData.anywhere_history !== true) {
      if (cacheKey) {
        localSessionMetadataCache.delete(cacheKey)
      }
      return null
    }

    const timestamps = collectSessionTimestamps(sessionData)
    const metadata = sessionData.sessionMetadata && typeof sessionData.sessionMetadata === 'object'
      ? sessionData.sessionMetadata
      : {}

    const normalizedMetadata = {
      title: resolveFallbackTitle(basename, sessionData),
      createdAt: normalizeSessionTimestamp(metadata.createdAt) || timestamps[0] || '',
      updatedAt:
        normalizeSessionTimestamp(metadata.updatedAt) || timestamps[timestamps.length - 1] || ''
    }

    if (cacheContext?.stats && cacheKey) {
      localSessionMetadataCache.set(cacheKey, {
        mtimeMs: cacheContext.stats.mtimeMs,
        size: cacheContext.stats.size,
        sessionMetadata: normalizedMetadata
      })
    }

    return cloneSessionMetadataCacheEntry(normalizedMetadata)
  } catch {
    if (cacheKey) {
      localSessionMetadataCache.delete(cacheKey)
    }
    return null
  }
}

export async function listJsonFiles(dirPath) {
  if (typeof dirPath !== 'string' || !dirPath.trim()) {
    return []
  }

  const resolvedDirPath = path.resolve(dirPath.trim())
  const entries = await fs.readdir(resolvedDirPath, { withFileTypes: true })

  const jsonFiles = entries.filter(
    (entry) => entry.isFile() && path.extname(entry.name).toLowerCase() === '.json'
  )

  const fileDetails = await Promise.all(
    jsonFiles.map(async (entry) => {
      const fullPath = path.join(resolvedDirPath, entry.name)
      try {
        const stats = await fs.stat(fullPath)
        return createSessionFileSummary({
          filePath: fullPath,
          basename: entry.name,
          stats
        })
      } catch (error) {
        console.error(`[file] 无法获取文件信息: ${fullPath}`, error)
        return null
      }
    })
  )

  const normalizedDetails = fileDetails
    .filter(Boolean)
    .sort(
      (a, b) =>
        new Date(b.createdAt || b.lastmod).getTime() - new Date(a.createdAt || a.lastmod).getTime()
    )

  return normalizedDetails
}

export async function readLocalFile(filePath, options = {}) {
  const resolvedPath = path.resolve(String(filePath || ''))
  const encoding = typeof options?.encoding === 'string' ? options.encoding : 'utf-8'
  return fs.readFile(resolvedPath, { encoding })
}


function resolveRenamedSessionTitleFromPath(filePath = '') {
  const normalizedBasename = path.basename(String(filePath || '').trim())
  if (!normalizedBasename) return ''
  return normalizedBasename.toLowerCase().endsWith('.json')
    ? normalizedBasename.slice(0, -5)
    : normalizedBasename
}

async function syncLocalSessionMetadataTitleAfterRename(filePath, title) {
  const normalizedTitle = typeof title === 'string' ? title.trim() : ''
  if (!normalizedTitle) return false

  try {
    const rawContent = await fs.readFile(filePath, 'utf-8')
    const sessionData = JSON.parse(rawContent)
    if (!sessionData || sessionData.anywhere_history !== true || typeof sessionData !== 'object') {
      return false
    }

    const sessionMetadata =
      sessionData.sessionMetadata && typeof sessionData.sessionMetadata === 'object'
        ? sessionData.sessionMetadata
        : {}

    if (typeof sessionMetadata.title === 'string' && sessionMetadata.title.trim() === normalizedTitle) {
      return false
    }

    sessionData.sessionMetadata = {
      ...sessionMetadata,
      title: normalizedTitle
    }

    await fs.writeFile(filePath, JSON.stringify(sessionData, null, 2), { encoding: 'utf-8' })
    return true
  } catch {
    return false
  }
}

export async function renameLocalFile(oldPath, newPath) {
  const sourcePath = path.resolve(String(oldPath || ''))
  const targetPath = path.resolve(String(newPath || ''))

  await fs.rename(sourcePath, targetPath)
  invalidateLocalSessionMetadataCache(sourcePath, targetPath)

  const metadataSynced = await syncLocalSessionMetadataTitleAfterRename(
    targetPath,
    resolveRenamedSessionTitleFromPath(targetPath)
  )
  invalidateLocalSessionMetadataCache(targetPath)

  return {
    ok: true,
    oldPath: sourcePath,
    newPath: targetPath,
    metadataSynced
  }
}

export async function deleteLocalFile(filePath) {
  const resolvedPath = path.resolve(String(filePath || ''))
  await fs.unlink(resolvedPath)
  invalidateLocalSessionMetadataCache(resolvedPath)
}

export async function writeLocalFile(filePath, content, options = {}) {
  const resolvedPath = path.resolve(String(filePath || ''))
  const encoding = typeof options?.encoding === 'string' ? options.encoding : 'utf-8'
  await fs.writeFile(resolvedPath, content, { encoding })
  invalidateLocalSessionMetadataCache(resolvedPath)
}

export async function setFileMtime(filePath, mtime) {
  const resolvedPath = path.resolve(String(filePath || ''))
  const date = new Date(mtime)
  if (Number.isNaN(date.getTime()) || date.getTime() <= 0) {
    throw new Error('invalid_file_mtime')
  }
  return fs.utimes(resolvedPath, date, date)
}

export async function copyLocalPath(srcPath, destPath) {
  const sourcePath = path.resolve(String(srcPath || ''))
  const targetPath = path.resolve(String(destPath || ''))
  return fs.cp(sourcePath, targetPath, { recursive: true })
}
