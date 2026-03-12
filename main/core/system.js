import { clipboard, desktopCapturer, dialog, nativeImage, shell } from 'electron'

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
