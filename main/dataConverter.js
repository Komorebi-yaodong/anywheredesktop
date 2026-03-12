import fs from 'node:fs/promises'
import path from 'node:path'

const DEFAULT_OPTIONS = {
  fileMode: 'auto',
  maxBufferSize: 10 * 1024 * 1024,
  maxDepth: 20
}

const FILE_PATH_KEYS = ['path', 'filePath', 'filepath']

export function safeClone(value, options = {}) {
  const { maxDepth = DEFAULT_OPTIONS.maxDepth } = options
  try {
    return structuredClone(value)
  } catch (error) {
    return sanitizeValue(value, new WeakMap(), maxDepth)
  }
}

export function serializeError(error) {
  if (!error) return null

  const payload = {
    __type: 'Error',
    name: error.name || 'Error',
    message: error.message || String(error),
    stack: error.stack || ''
  }

  if (Object.prototype.hasOwnProperty.call(error, 'code')) {
    payload.code = error.code
  }

  if (Object.prototype.hasOwnProperty.call(error, 'cause') && error.cause) {
    payload.cause = serializeError(error.cause)
  }

  if (Object.prototype.hasOwnProperty.call(error, 'details')) {
    payload.details = safeClone(error.details)
  }

  return payload
}

export function restoreError(payload) {
  if (!payload || payload.__type !== 'Error') return payload

  const error = new Error(payload.message || 'Error')
  error.name = payload.name || 'Error'

  if (payload.stack) error.stack = payload.stack
  if (payload.code !== undefined) error.code = payload.code
  if (payload.cause) error.cause = restoreError(payload.cause)
  if (payload.details) error.details = payload.details

  return error
}

export function isFileLike(value) {
  if (!value || typeof value !== 'object') return false
  if (value.__type === 'File') return true

  const filePath = getFilePath(value)
  if (filePath) return true

  if (typeof value.name === 'string' && typeof value.size === 'number') return true
  if (typeof value.url === 'string' && value.url.startsWith('data:')) return true

  return false
}

export async function serializeFileLike(file, options = {}) {
  if (!file || typeof file !== 'object') return null
  if (file.__type === 'File') return file

  const config = { ...DEFAULT_OPTIONS, ...options }
  const resolvedPath = getFilePath(file)
  const nameFromPath = resolvedPath ? path.basename(resolvedPath) : ''

  const payload = {
    __type: 'File',
    name: file.name || nameFromPath || 'unknown',
    path: resolvedPath || null,
    size: typeof file.size === 'number' ? file.size : null,
    type: typeof file.type === 'string' ? file.type : '',
    lastModified: typeof file.lastModified === 'number' ? file.lastModified : null
  }

  const shouldIncludeBuffer =
    config.fileMode === 'buffer' || (config.fileMode === 'auto' && !resolvedPath)

  if (shouldIncludeBuffer) {
    const bufferResult = await resolveFileBuffer(file, resolvedPath, config)

    if (bufferResult.buffer) {
      payload.buffer = bufferResult.buffer.toString('base64')
      payload.encoding = 'base64'
      if (payload.size == null) payload.size = bufferResult.buffer.byteLength
    }

    if (bufferResult.size != null && payload.size == null) {
      payload.size = bufferResult.size
    }

    if (bufferResult.skipped) {
      payload.bufferSkipped = bufferResult.skipped
    }

    if (bufferResult.error) {
      payload.bufferError = bufferResult.error
    }
  }

  return payload
}

export async function serializeIpcPayload(value, options = {}) {
  const config = { ...DEFAULT_OPTIONS, ...options }
  return serializeValue(value, config, new WeakMap(), 0)
}

function getFilePath(value) {
  for (const key of FILE_PATH_KEYS) {
    const candidate = value?.[key]
    if (typeof candidate === 'string' && candidate.trim()) {
      return path.normalize(candidate)
    }
  }
  return null
}

async function resolveFileBuffer(file, resolvedPath, options) {
  if (Buffer.isBuffer(file)) {
    return { buffer: file }
  }

  if (Buffer.isBuffer(file.buffer)) {
    return { buffer: file.buffer }
  }

  if (typeof file.arrayBuffer === 'function') {
    try {
      const arrayBuffer = await file.arrayBuffer()
      return { buffer: Buffer.from(arrayBuffer) }
    } catch (error) {
      return { error: serializeError(error) }
    }
  }

  if (typeof file.base64 === 'string' && file.base64.trim()) {
    return { buffer: Buffer.from(file.base64, 'base64') }
  }

  if (typeof file.dataUrl === 'string') {
    const base64 = extractBase64FromDataUrl(file.dataUrl)
    if (base64) return { buffer: Buffer.from(base64, 'base64') }
  }

  if (typeof file.url === 'string' && file.url.startsWith('data:')) {
    const base64 = extractBase64FromDataUrl(file.url)
    if (base64) return { buffer: Buffer.from(base64, 'base64') }
  }

  if (resolvedPath) {
    try {
      const stats = await fs.stat(resolvedPath)

      if (stats.size > options.maxBufferSize) {
        return {
          skipped: `size:${stats.size} > maxBufferSize:${options.maxBufferSize}`,
          size: stats.size
        }
      }

      const buffer = await fs.readFile(resolvedPath)
      return { buffer, size: stats.size }
    } catch (error) {
      return { error: serializeError(error) }
    }
  }

  return {}
}

function extractBase64FromDataUrl(dataUrl) {
  if (!dataUrl || typeof dataUrl !== 'string') return null
  const match = dataUrl.match(/^data:.*?;base64,(.+)$/)
  if (!match) return null
  return match[1]
}

async function serializeValue(value, options, seen, depth) {
  if (depth > options.maxDepth) return '[MaxDepth]'
  if (value === undefined) return null
  if (value === null) return null

  const valueType = typeof value
  if (valueType === 'string') return value

  if (valueType === 'number') {
    return Number.isFinite(value) ? value : null
  }

  if (valueType === 'boolean') return value
  if (valueType === 'bigint') return value.toString()
  if (valueType === 'symbol') return value.toString()

  if (valueType === 'function') {
    return `[Function${value.name ? ` ${value.name}` : ''}]`
  }

  if (isErrorLike(value)) return serializeError(value)
  if (Buffer.isBuffer(value)) return serializeBinary(value, 'Buffer')

  if (value instanceof ArrayBuffer) {
    return serializeBinary(Buffer.from(value), 'ArrayBuffer')
  }

  if (ArrayBuffer.isView(value)) {
    return serializeBinary(Buffer.from(value.buffer), value.constructor?.name || 'TypedArray')
  }

  if (isFileLike(value)) {
    return serializeFileLike(value, options)
  }

  if (value instanceof Date) return value.toISOString()
  if (value instanceof RegExp) return value.toString()

  if (value instanceof Map) {
    if (seen.has(value)) return '[Circular]'
    seen.set(value, true)
    const entries = []
    for (const [key, item] of value.entries()) {
      entries.push([await serializeValue(key, options, seen, depth + 1), await serializeValue(item, options, seen, depth + 1)])
    }
    return { __type: 'Map', value: entries }
  }

  if (value instanceof Set) {
    if (seen.has(value)) return '[Circular]'
    seen.set(value, true)
    const entries = []
    for (const item of value.values()) {
      entries.push(await serializeValue(item, options, seen, depth + 1))
    }
    return { __type: 'Set', value: entries }
  }

  if (Array.isArray(value)) {
    if (seen.has(value)) return '[Circular]'
    seen.set(value, true)
    const result = []
    for (const item of value) {
      result.push(await serializeValue(item, options, seen, depth + 1))
    }
    return result
  }

  if (valueType === 'object') {
    if (seen.has(value)) return '[Circular]'
    seen.set(value, true)

    const result = {}
    for (const [key, item] of Object.entries(value)) {
      result[key] = await serializeValue(item, options, seen, depth + 1)
    }
    return result
  }

  return value
}

function serializeBinary(buffer, type) {
  return {
    __type: type,
    data: buffer.toString('base64'),
    encoding: 'base64',
    size: buffer.byteLength
  }
}

function isErrorLike(value) {
  if (!value || typeof value !== 'object') return false
  return value instanceof Error || typeof value.message === 'string'
}

function sanitizeValue(value, seen, depth) {
  if (depth <= 0) return '[MaxDepth]'
  if (value === undefined) return null
  if (value === null) return null

  const valueType = typeof value
  if (valueType === 'string') return value

  if (valueType === 'number') {
    return Number.isFinite(value) ? value : null
  }

  if (valueType === 'boolean') return value
  if (valueType === 'bigint') return value.toString()
  if (valueType === 'symbol') return value.toString()

  if (valueType === 'function') {
    return `[Function${value.name ? ` ${value.name}` : ''}]`
  }

  if (isErrorLike(value)) return serializeError(value)
  if (Buffer.isBuffer(value)) return serializeBinary(value, 'Buffer')

  if (value instanceof ArrayBuffer) {
    return serializeBinary(Buffer.from(value), 'ArrayBuffer')
  }

  if (ArrayBuffer.isView(value)) {
    return serializeBinary(Buffer.from(value.buffer), value.constructor?.name || 'TypedArray')
  }

  if (value instanceof Date) return value.toISOString()
  if (value instanceof RegExp) return value.toString()

  if (value instanceof Map) {
    if (seen.has(value)) return '[Circular]'
    seen.set(value, true)
    const entries = []
    for (const [key, item] of value.entries()) {
      entries.push([sanitizeValue(key, seen, depth - 1), sanitizeValue(item, seen, depth - 1)])
    }
    return { __type: 'Map', value: entries }
  }

  if (value instanceof Set) {
    if (seen.has(value)) return '[Circular]'
    seen.set(value, true)
    const entries = []
    for (const item of value.values()) {
      entries.push(sanitizeValue(item, seen, depth - 1))
    }
    return { __type: 'Set', value: entries }
  }

  if (Array.isArray(value)) {
    if (seen.has(value)) return '[Circular]'
    seen.set(value, true)
    return value.map((item) => sanitizeValue(item, seen, depth - 1))
  }

  if (valueType === 'object') {
    if (seen.has(value)) return '[Circular]'
    seen.set(value, true)

    const result = {}
    for (const [key, item] of Object.entries(value)) {
      result[key] = sanitizeValue(item, seen, depth - 1)
    }
    return result
  }

  return value
}
