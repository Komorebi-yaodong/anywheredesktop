import { clipboard, desktopCapturer, dialog, nativeImage, shell } from 'electron'
import path from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)


function normalizeText(input) {
  if (typeof input === 'string') return input
  if (input == null) return ''
  return String(input)
}

function parseImageInput(input = {}) {
  if (!input || typeof input !== 'object') return nativeImage.createEmpty()

  if (typeof input.dataUrl === 'string' && input.dataUrl.startsWith('data:image/')) {
    return nativeImage.createFromDataURL(input.dataUrl)
  }

  if (typeof input.base64 === 'string' && input.base64.trim()) {
    try {
      return nativeImage.createFromBuffer(Buffer.from(input.base64, 'base64'))
    } catch {
      return nativeImage.createEmpty()
    }
  }

  if (typeof input.path === 'string' && input.path.trim()) {
    return nativeImage.createFromPath(input.path)
  }

  return nativeImage.createEmpty()
}

function toSerializableSource(source) {
  const thumbnailDataUrl = source.thumbnail && !source.thumbnail.isEmpty() ? source.thumbnail.toDataURL() : ''
  const appIconDataUrl = source.appIcon && !source.appIcon.isEmpty() ? source.appIcon.toDataURL() : ''

  return {
    id: source.id,
    name: source.name,
    displayId: source.display_id || '',
    thumbnailDataUrl,
    appIconDataUrl
  }
}

function normalizeDesktopOptions(options = {}) {
  const types = Array.isArray(options.types) && options.types.length > 0 ? options.types : ['screen', 'window']
  const fetchWindowIcons = options.fetchWindowIcons !== false

  const width = Number(options.thumbnailSize?.width)
  const height = Number(options.thumbnailSize?.height)

  return {
    types,
    fetchWindowIcons,
    thumbnailSize: {
      width: Number.isFinite(width) && width > 0 ? width : 320,
      height: Number.isFinite(height) && height > 0 ? height : 180
    }
  }
}

export async function copyText(text) {
  clipboard.writeText(normalizeText(text))
  return { ok: true }
}

export async function copyImage(input = {}) {
  const image = parseImageInput(input)
  if (!image || image.isEmpty()) {
    return {
      ok: false,
      reason: 'invalid_image_input'
    }
  }

  clipboard.writeImage(image)
  const size = image.getSize()

  return {
    ok: true,
    width: size.width,
    height: size.height
  }
}

function readClipboardFilePaths() {
  const formats = clipboard.availableFormats()
  const fileNameWFormat = formats.find((item) => item === 'FileNameW')
  if (!fileNameWFormat) return []

  try {
    const buffer = clipboard.readBuffer(fileNameWFormat)
    if (!buffer || buffer.length < 4) return []

    const raw = buffer.toString('ucs2').replace(/\u0000+$/g, '')
    return raw
      .split('\u0000')
      .map((item) => item.trim())
      .filter(Boolean)
      .map((item) => path.normalize(item))
  } catch {
    return []
  }
}

function readClipboardImageDataUrl() {
  try {
    const image = clipboard.readImage()
    if (!image || image.isEmpty()) return ''
    return image.toDataURL()
  } catch {
    return ''
  }
}

async function tryCaptureSelectionToClipboard() {
  if (process.platform !== 'win32') {
    return null
  }

  try {
    await execFileAsync('powershell.exe', [
      '-NoProfile',
      '-Command',
      '$wshell = New-Object -ComObject WScript.Shell; Start-Sleep -Milliseconds 50; $wshell.SendKeys("^c"); Start-Sleep -Milliseconds 120'
    ], { windowsHide: true })
  } catch {
    // ignore selection capture failure
  }

  return readClipboardPayload()
}

export async function captureSelectionPayload() {
  const direct = await readClipboardPayload()
  if (direct.kind !== 'empty') return direct
  const captured = await tryCaptureSelectionToClipboard()
  return captured || direct
}


export async function readClipboardPayload() {
  const text = clipboard.readText()
  const imageDataUrl = readClipboardImageDataUrl()
  const filePaths = readClipboardFilePaths()

  let kind = 'empty'
  if (filePaths.length > 0) {
    kind = 'files'
  } else if (imageDataUrl) {
    kind = 'img'
  } else if (text && text.trim()) {
    kind = 'over'
  }

  return {
    ok: true,
    kind,
    text,
    imageDataUrl,
    filePaths,
    hasText: Boolean(text && text.trim()),
    hasImage: Boolean(imageDataUrl),
    hasFiles: filePaths.length > 0,
    formats: clipboard.availableFormats()
  }
}


export async function readClipboardText() {
  return {
    ok: true,
    text: clipboard.readText()
  }
}

export async function showOpenDialog(options = {}, browserWindow = undefined) {
  const result = await dialog.showOpenDialog(browserWindow, options)
  return {
    ok: true,
    ...result
  }
}

export async function showSaveDialog(options = {}, browserWindow = undefined) {
  const result = await dialog.showSaveDialog(browserWindow, options)
  return {
    ok: true,
    ...result
  }
}

export async function shellOpenPath(targetPath = '') {
  const normalizedPath = normalizeText(targetPath).trim()
  if (!normalizedPath) {
    return {
      ok: false,
      reason: 'path_required'
    }
  }

  const message = await shell.openPath(normalizedPath)
  return {
    ok: message === '',
    message: message || null
  }
}

export async function shellShowItemInFolder(targetPath = '') {
  const normalizedPath = normalizeText(targetPath).trim()
  if (!normalizedPath) {
    return {
      ok: false,
      reason: 'path_required'
    }
  }

  shell.showItemInFolder(normalizedPath)
  return {
    ok: true
  }
}

export async function shellOpenExternal(url = '') {
  const normalizedUrl = normalizeText(url).trim()
  if (!normalizedUrl) {
    return {
      ok: false,
      reason: 'url_required'
    }
  }

  await shell.openExternal(normalizedUrl)
  return {
    ok: true
  }
}

export async function getDesktopSources(options = {}) {
  const normalizedOptions = normalizeDesktopOptions(options)
  const sources = await desktopCapturer.getSources(normalizedOptions)

  return {
    ok: true,
    sources: sources.map(toSerializableSource)
  }
}
