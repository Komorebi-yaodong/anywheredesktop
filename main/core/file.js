import fs from 'node:fs/promises'
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
  '.toml'
]

const DOC_EXTENSIONS = ['.docx']
const EXCEL_EXTENSIONS = ['.xlsx', '.xls']
const IMAGE_EXTENSIONS = ['.png', '.jpg', '.jpeg', '.webp', '.gif']
const AUDIO_EXTENSIONS = ['.mp3', '.wav']
const PDF_EXTENSIONS = ['.pdf']

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
  return getFileCategoryByName(fileName) !== 'unknown'
}

export async function parseFileObject(fileObj) {
  const normalized = await normalizeFileObject(fileObj)
  const category = getFileCategoryByName(normalized.name)

  if (category === 'unknown') {
    throw new Error(`不支持的文件类型: ${normalized.name}`)
  }

  if (category === 'text') {
    const content = await parseTextFileFromDataUrl(normalized.url)
    return {
      type: 'text',
      text: `file name:${normalized.name}\nfile content:\n${content}\nfile end`
    }
  }

  if (category === 'docx' || category === 'excel' || category === 'pdf') {
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

  const content =
    typeof fileContent === 'string' || Buffer.isBuffer(fileContent)
      ? fileContent
      : JSON.stringify(fileContent, null, 2)

  await fs.writeFile(result.filePath, content)

  return {
    success: true,
    path: result.filePath
  }
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
        return {
          basename: entry.name,
          path: fullPath,
          lastmod: stats.mtime.toISOString(),
          size: stats.size,
          type: 'file'
        }
      } catch (error) {
        console.error(`[file] 无法获取文件信息: ${fullPath}`, error)
        return null
      }
    })
  )

  return fileDetails
    .filter(Boolean)
    .sort((a, b) => new Date(b.lastmod).getTime() - new Date(a.lastmod).getTime())
}

export async function readLocalFile(filePath, options = {}) {
  const resolvedPath = path.resolve(String(filePath || ''))
  const encoding = typeof options?.encoding === 'string' ? options.encoding : 'utf-8'
  return fs.readFile(resolvedPath, { encoding })
}

export async function renameLocalFile(oldPath, newPath) {
  const sourcePath = path.resolve(String(oldPath || ''))
  const targetPath = path.resolve(String(newPath || ''))
  return fs.rename(sourcePath, targetPath)
}

export async function deleteLocalFile(filePath) {
  const resolvedPath = path.resolve(String(filePath || ''))
  return fs.unlink(resolvedPath)
}

export async function writeLocalFile(filePath, content, options = {}) {
  const resolvedPath = path.resolve(String(filePath || ''))
  const encoding = typeof options?.encoding === 'string' ? options.encoding : 'utf-8'
  return fs.writeFile(resolvedPath, content, { encoding })
}

export async function setFileMtime(filePath, mtime) {
  const resolvedPath = path.resolve(String(filePath || ''))
  const date = new Date(mtime)
  return fs.utimes(resolvedPath, date, date)
}

export async function copyLocalPath(srcPath, destPath) {
  const sourcePath = path.resolve(String(srcPath || ''))
  const targetPath = path.resolve(String(destPath || ''))
  return fs.cp(sourcePath, targetPath, { recursive: true })
}
