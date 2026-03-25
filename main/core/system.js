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

const CLIPBOARD_FRESHNESS_MS = 5000
const CLIPBOARD_POLL_INTERVAL_MS = 400

let clipboardWatcherTimer = null
const clipboardTimeline = {
  text: { signature: '', timestamp: 0, value: '' },
  image: { signature: '', timestamp: 0, value: '' },
  files: { signature: '', timestamp: 0, value: [] }
}

function decodeClipboardPathBuffer(buffer) {
  if (!buffer || buffer.length < 4) return []

  const raw = buffer.toString('ucs2').replace(/\u0000+$/g, '')
  return raw
    .split('\u0000')
    .map((item) => item.trim())
    .filter(Boolean)
    .map((item) => path.normalize(item))
}

function readClipboardFilePaths() {
  const formats = clipboard.availableFormats()
  const candidateFormats = ['FileNameW', 'text/uri-list', 'CF_HDROP']

  for (const formatName of candidateFormats) {
    const matchedFormat = formats.find((item) => item === formatName)
    if (!matchedFormat) continue

    try {
      const buffer = clipboard.readBuffer(matchedFormat)
      const paths = decodeClipboardPathBuffer(buffer)
      if (paths.length > 0) return paths
    } catch {
      // ignore and try next available format
    }
  }

  return []
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

function readClipboardPayloadRaw() {
  return {
    text: clipboard.readText(),
    imageDataUrl: readClipboardImageDataUrl(),
    filePaths: readClipboardFilePaths(),
    formats: clipboard.availableFormats()
  }
}

function buildFieldSignatures(raw = {}) {
  const text = typeof raw.text === 'string' ? raw.text : ''
  const imageDataUrl = typeof raw.imageDataUrl === 'string' ? raw.imageDataUrl : ''
  const filePaths = Array.isArray(raw.filePaths) ? raw.filePaths.map((item) => path.normalize(String(item))) : []

  return {
    text,
    imageDataUrl,
    filePaths,
    signatures: {
      text,
      image: imageDataUrl ? `${imageDataUrl.length}:${imageDataUrl.slice(0, 128)}` : '',
      files: JSON.stringify(filePaths)
    }
  }
}

function updateTimelineEntry(entry, nextSignature, nextValue) {
  const hasValue = Array.isArray(nextValue) ? nextValue.length > 0 : Boolean(nextValue)
  if (!hasValue) {
    entry.signature = ''
    entry.timestamp = 0
    entry.value = Array.isArray(nextValue) ? [] : ''
    return false
  }

  const changed = entry.signature !== nextSignature
  if (changed) {
    entry.signature = nextSignature
    entry.timestamp = Date.now()
  }
  entry.value = Array.isArray(nextValue) ? [...nextValue] : nextValue
  return changed
}

function updateClipboardTimeline(raw = {}) {
  const normalized = buildFieldSignatures(raw)
  const changedKinds = []

  if (updateTimelineEntry(clipboardTimeline.text, normalized.signatures.text, normalized.text)) {
    changedKinds.push('text')
  }
  if (updateTimelineEntry(clipboardTimeline.image, normalized.signatures.image, normalized.imageDataUrl)) {
    changedKinds.push('image')
  }
  if (updateTimelineEntry(clipboardTimeline.files, normalized.signatures.files, normalized.filePaths)) {
    changedKinds.push('files')
  }

  return {
    normalized,
    changedKinds
  }
}

function resolveLatestKind(preferredKinds = ['files', 'image', 'text']) {
  return preferredKinds
    .map((kind) => ({ kind, timestamp: clipboardTimeline[kind]?.timestamp || 0 }))
    .filter((item) => item.timestamp > 0)
    .sort((a, b) => b.timestamp - a.timestamp)[0]?.kind || 'empty'
}

function buildClipboardPayloadFromKind(kind = 'empty', source = 'clipboard', formats = []) {
  const finalKind = kind === 'files' ? 'files' : kind === 'image' ? 'img' : kind === 'text' ? 'over' : 'empty'
  const timestamp = kind === 'files'
    ? clipboardTimeline.files.timestamp
    : kind === 'image'
      ? clipboardTimeline.image.timestamp
      : kind === 'text'
        ? clipboardTimeline.text.timestamp
        : 0
  const ageMs = timestamp > 0 ? Math.max(0, Date.now() - timestamp) : Number.POSITIVE_INFINITY

  return {
    ok: true,
    kind: finalKind,
    text: kind === 'text' ? clipboardTimeline.text.value : '',
    imageDataUrl: kind === 'image' ? clipboardTimeline.image.value : '',
    filePaths: kind === 'files' ? [...clipboardTimeline.files.value] : [],
    hasText: kind === 'text' && Boolean(clipboardTimeline.text.value?.trim()),
    hasImage: kind === 'image' && Boolean(clipboardTimeline.image.value),
    hasFiles: kind === 'files' && clipboardTimeline.files.value.length > 0,
    formats,
    timestamp,
    ageMs,
    freshnessWindowMs: CLIPBOARD_FRESHNESS_MS,
    isFresh: finalKind !== 'empty' && ageMs <= CLIPBOARD_FRESHNESS_MS,
    source
  }
}

function getFreshClipboardPayload(source = 'clipboard', preferredKinds = ['files', 'image', 'text'], formats = []) {
  const latestKind = resolveLatestKind(preferredKinds)
  const payload = buildClipboardPayloadFromKind(latestKind, source, formats)
  return payload.isFresh ? payload : buildClipboardPayloadFromKind('empty', 'empty', formats)
}

function primeClipboardWatcherState() {
  const raw = readClipboardPayloadRaw()
  updateClipboardTimeline(raw)
  return getFreshClipboardPayload('clipboard', ['files', 'image', 'text'], raw.formats)
}

function pollClipboardSnapshot() {
  try {
    const raw = readClipboardPayloadRaw()
    updateClipboardTimeline(raw)
  } catch {
    // ignore clipboard polling failure
  }
}

export function startClipboardWatcher() {
  if (clipboardWatcherTimer) {
    return {
      ok: true,
      started: false,
      reason: 'already_started'
    }
  }

  primeClipboardWatcherState()
  clipboardWatcherTimer = setInterval(pollClipboardSnapshot, CLIPBOARD_POLL_INTERVAL_MS)
  clipboardWatcherTimer.unref?.()

  return {
    ok: true,
    started: true,
    intervalMs: CLIPBOARD_POLL_INTERVAL_MS
  }
}

export function stopClipboardWatcher() {
  if (!clipboardWatcherTimer) {
    return {
      ok: true,
      stopped: false,
      reason: 'not_started'
    }
  }

  clearInterval(clipboardWatcherTimer)
  clipboardWatcherTimer = null

  return {
    ok: true,
    stopped: true
  }
}

async function tryCaptureSelectionToClipboard() {
  if (process.platform !== 'win32') {
    return null
  }

  const beforeRaw = readClipboardPayloadRaw()
  const beforeSignature = JSON.stringify(buildFieldSignatures(beforeRaw).signatures)

  try {
    await execFileAsync('powershell.exe', [
      '-NoProfile',
      '-Command',
      '$wshell = New-Object -ComObject WScript.Shell; Start-Sleep -Milliseconds 120; $wshell.SendKeys("^c"); Start-Sleep -Milliseconds 420'
    ], { windowsHide: true })
  } catch {
    // ignore selection capture failure
  }

  let afterRaw = readClipboardPayloadRaw()
  let afterSignature = JSON.stringify(buildFieldSignatures(afterRaw).signatures)

  if (afterSignature === beforeSignature) {
    for (let i = 0; i < 3; i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 120))
      afterRaw = readClipboardPayloadRaw()
      afterSignature = JSON.stringify(buildFieldSignatures(afterRaw).signatures)
      if (afterSignature !== beforeSignature) break
    }
  }

  updateClipboardTimeline(afterRaw)

  if (afterSignature === beforeSignature) {
    return null
  }

  return getFreshClipboardPayload('selection', ['files', 'image', 'text'], afterRaw.formats)
}

export async function captureSelectionPayload() {
  const directRaw = readClipboardPayloadRaw()
  updateClipboardTimeline(directRaw)
  const clipboardPayload = getFreshClipboardPayload('clipboard', ['files', 'image', 'text'], directRaw.formats)

  const captured = await tryCaptureSelectionToClipboard()
  if (captured && captured.kind !== 'empty') {
    return captured
  }

  return clipboardPayload
}

export async function readClipboardPayload() {
  const raw = readClipboardPayloadRaw()
  updateClipboardTimeline(raw)
  return getFreshClipboardPayload('clipboard', ['files', 'image', 'text'], raw.formats)
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
