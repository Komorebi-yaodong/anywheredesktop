import { clipboard, desktopCapturer, dialog, nativeImage, shell } from 'electron'
import fs from 'node:fs'
import path from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { fileURLToPath } from 'node:url'

const execFileAsync = promisify(execFile)

const BLOCKED_EXTERNAL_PROTOCOLS = new Set(['javascript:', 'data:', 'blob:', 'about:'])

function isBlockedExternalProtocol(protocol = '') {
  return BLOCKED_EXTERNAL_PROTOCOLS.has(String(protocol || '').toLowerCase())
}



function normalizeText(input) {
  if (typeof input === 'string') return input
  if (input == null) return ''
  return String(input)
}

function resolveBinaryInputBuffer(input) {
  if (!input) return null
  if (Buffer.isBuffer(input)) return input
  if (input instanceof ArrayBuffer) return Buffer.from(input)
  if (ArrayBuffer.isView(input)) {
    return Buffer.from(input.buffer, input.byteOffset, input.byteLength)
  }

  if (typeof input !== 'object') return null

  if (Buffer.isBuffer(input.buffer)) return input.buffer
  if (input.buffer instanceof ArrayBuffer) return Buffer.from(input.buffer)
  if (ArrayBuffer.isView(input.buffer)) {
    return Buffer.from(input.buffer.buffer, input.buffer.byteOffset, input.buffer.byteLength)
  }
  if (Array.isArray(input.buffer?.data)) {
    return Buffer.from(input.buffer.data)
  }
  if (
    input.buffer &&
    typeof input.buffer === 'object' &&
    typeof input.buffer.__type === 'string' &&
    typeof input.buffer.data === 'string' &&
    input.buffer.encoding === 'base64'
  ) {
    return Buffer.from(input.buffer.data, 'base64')
  }

  return null
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

  const binaryBuffer = resolveBinaryInputBuffer(input)
  if (binaryBuffer && binaryBuffer.length > 0) {
    try {
      return nativeImage.createFromBuffer(binaryBuffer)
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


export async function pasteTextToActiveInput(text) {
  const normalizedText = normalizeText(text)
  clipboard.writeText(normalizedText)

  if (process.platform !== 'win32') {
    return {
      ok: false,
      reason: 'unsupported_platform',
      platform: process.platform
    }
  }

  const script = '$wshell = New-Object -ComObject WScript.Shell; Start-Sleep -Milliseconds 80; $wshell.SendKeys("^v"); Start-Sleep -Milliseconds 120'

  try {
    await execFileAsync('powershell.exe', ['-NoProfile', '-Command', script], {
      windowsHide: true,
      maxBuffer: 1024 * 1024
    })

    return {
      ok: true,
      action: 'paste',
      platform: process.platform,
      textLength: normalizedText.length
    }
  } catch (error) {
    return {
      ok: false,
      reason: 'paste_failed',
      platform: process.platform,
      message: error?.message || 'unknown_error'
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

const CLIPBOARD_FRESHNESS_MS = 3000
const CLIPBOARD_POLL_INTERVAL_MS = 400

const AUXILIARY_SHORTCUT_POLL_INTERVAL_MS = 900
let auxiliaryShortcutWatcherTimer = null
let auxiliaryShortcutWatchPrimed = false
let auxiliaryShortcutPollInFlight = false



let latestShortcutPayloadContext = {
  contextId: '',
  timestamp: 0,
  status: 'expired',
  kind: 'empty',
  source: 'empty',
  text: '',
  imageDataUrl: '',
  filePaths: [],
  formats: []
}

function resetShortcutPayloadContext(status = 'expired') {
  latestShortcutPayloadContext = {
    contextId: '',
    timestamp: 0,
    status,
    kind: 'empty',
    source: 'empty',
    text: '',
    imageDataUrl: '',
    filePaths: [],
    formats: []
  }
}

function storeShortcutPayloadContext(payload = null) {
  if (!payload || payload.kind === 'empty' || payload.isFresh === false) {
    resetShortcutPayloadContext('expired')
    return buildClipboardPayloadFromKind('empty', 'empty', payload?.formats || [])
  }

  latestShortcutPayloadContext = {
    contextId: `ctx_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
    timestamp: Number(payload.timestamp) || Date.now(),
    status: 'fresh',
    kind: payload.kind,
    source: payload.source || 'clipboard',
    text: typeof payload.text === 'string' ? payload.text : '',
    imageDataUrl: typeof payload.imageDataUrl === 'string' ? payload.imageDataUrl : '',
    filePaths: Array.isArray(payload.filePaths) ? [...payload.filePaths] : [],
    formats: Array.isArray(payload.formats) ? [...payload.formats] : []
  }

  return {
    ...payload,
    contextId: latestShortcutPayloadContext.contextId,
    status: latestShortcutPayloadContext.status
  }
}

function buildPayloadFromShortcutContext() {
  if (latestShortcutPayloadContext.status !== 'fresh' || !latestShortcutPayloadContext.contextId) {
    return buildClipboardPayloadFromKind('empty', 'empty', [])
  }

  const ageMs = Math.max(0, Date.now() - (latestShortcutPayloadContext.timestamp || 0))
  if (ageMs > CLIPBOARD_FRESHNESS_MS) {
    resetShortcutPayloadContext('expired')
    return buildClipboardPayloadFromKind('empty', 'empty', latestShortcutPayloadContext.formats || [])
  }

  return {
    ok: true,
    kind: latestShortcutPayloadContext.kind,
    text: latestShortcutPayloadContext.kind === 'over' ? latestShortcutPayloadContext.text : latestShortcutPayloadContext.text,
    imageDataUrl: latestShortcutPayloadContext.imageDataUrl,
    filePaths: [...latestShortcutPayloadContext.filePaths],
    hasText: Boolean(latestShortcutPayloadContext.text?.trim()),
    hasImage: Boolean(latestShortcutPayloadContext.imageDataUrl),
    hasFiles: latestShortcutPayloadContext.filePaths.length > 0,
    formats: [...latestShortcutPayloadContext.formats],
    timestamp: latestShortcutPayloadContext.timestamp,
    ageMs,
    freshnessWindowMs: CLIPBOARD_FRESHNESS_MS,
    isFresh: true,
    source: latestShortcutPayloadContext.source,
    contextId: latestShortcutPayloadContext.contextId,
    status: latestShortcutPayloadContext.status
  }
}

let clipboardWatcherTimer = null
const clipboardTimeline = {
  text: { signature: '', timestamp: 0, value: '' },
  image: { signature: '', timestamp: 0, value: '' },
  files: { signature: '', timestamp: 0, value: [] }
}
const explorerSelectionState = {
  signature: '',
  timestamp: 0,
  filePaths: []
}
const clipboardFileDropState = {
  signature: '',
  timestamp: 0,
  filePaths: []
}
const clipboardSequenceState = {
  value: 0,
  checkedAt: 0
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


function decodeWindowsDropFiles(buffer) {
  if (!buffer || buffer.length < 20) return []

  try {
    const offset = buffer.readUInt32LE(0)
    const isUnicode = (buffer.readUInt32LE(16) & 1) === 1
    if (!offset || offset >= buffer.length) return []

    const raw = buffer.slice(offset).toString(isUnicode ? 'ucs2' : 'utf8').replace(/\u0000+$/g, '')
    return raw
      .split('\u0000')
      .map((item) => item.trim())
      .filter(Boolean)
      .map((item) => path.normalize(item))
      .filter((item) => item && fs.existsSync(item))
  } catch {
    return []
  }
}

function parseUriListText(input = '') {
  return String(input || '')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith('#'))
    .map((line) => {
      if (/^file:\/\//i.test(line)) {
        try {
          const url = new URL(line)
          let pathname = decodeURIComponent(url.pathname || '')
          if (process.platform === 'win32' && /^\/[A-Za-z]:/.test(pathname)) {
            pathname = pathname.slice(1)
          }
          return path.normalize(pathname)
        } catch {
          return ''
        }
      }
      return path.normalize(line)
    })
    .filter((item) => item && fs.existsSync(item))
}

function parseExistingFilePathsFromText(input = '') {
  return String(input || '')
    .split(/\r?\n/)
    .map((line) => line.trim().replace(/^"|"$/g, ''))
    .filter(Boolean)
    .map((line) => (/^file:\/\//i.test(line) ? parseUriListText(line)[0] || '' : path.normalize(line)))
    .filter((item) => item && fs.existsSync(item))
}

function readClipboardFilePaths() {
  const formats = clipboard.availableFormats()
  const lowerLookup = new Map(formats.map((item) => [String(item).toLowerCase(), item]))
  const candidateFormats = ['CF_HDROP', 'FileNameW', 'fileNameW', 'text/uri-list']

  for (const formatName of candidateFormats) {
    const matchedFormat = lowerLookup.get(formatName.toLowerCase())
    if (!matchedFormat) continue

    try {
      const buffer = clipboard.readBuffer(matchedFormat)
      const lowered = matchedFormat.toLowerCase()
      if (lowered === 'text/uri-list') {
        const paths = parseUriListText(buffer.toString('utf8'))
        if (paths.length > 0) return paths
        continue
      }

      if (lowered === 'cf_hdrop') {
        const dropFiles = decodeWindowsDropFiles(buffer)
        if (dropFiles.length > 0) return dropFiles
      }

      const paths = decodeClipboardPathBuffer(buffer)
      if (paths.length > 0) return paths.filter((item) => item && fs.existsSync(item))
    } catch {
      // ignore and try next available format
    }
  }

  const textFallback = clipboard.readText()
  const fallbackPaths = parseExistingFilePathsFromText(textFallback)
  if (fallbackPaths.length > 0) return fallbackPaths

  return []
}

function readClipboardImageSnapshot(options = {}) {
  try {
    const image = clipboard.readImage()
    if (!image || image.isEmpty()) {
      return {
        imageDataUrl: '',
        imageSignature: '',
        imageSize: { width: 0, height: 0 }
      }
    }

    const size = image.getSize()
    const width = Number(size?.width) || 0
    const height = Number(size?.height) || 0
    const imageSignature = width > 0 && height > 0 ? `${width}x${height}` : 'present'

    return {
      imageDataUrl: options.includeDataUrl ? image.toDataURL() : '',
      imageSignature,
      imageSize: { width, height }
    }
  } catch {
    return {
      imageDataUrl: '',
      imageSignature: '',
      imageSize: { width: 0, height: 0 }
    }
  }
}

function readClipboardPayloadRaw(options = {}) {
  const imageSnapshot = readClipboardImageSnapshot(options)
  return {
    text: clipboard.readText(),
    imageDataUrl: imageSnapshot.imageDataUrl,
    imageSignature: imageSnapshot.imageSignature,
    imageSize: imageSnapshot.imageSize,
    filePaths: readClipboardFilePaths(),
    formats: clipboard.availableFormats()
  }
}

function buildFieldSignatures(raw = {}) {
  const text = typeof raw.text === 'string' ? raw.text : ''
  const imageDataUrl = typeof raw.imageDataUrl === 'string' ? raw.imageDataUrl : ''
  const imageSignature = typeof raw.imageSignature === 'string' ? raw.imageSignature : ''
  const imageSize =
    raw.imageSize && typeof raw.imageSize === 'object'
      ? {
          width: Number(raw.imageSize.width) || 0,
          height: Number(raw.imageSize.height) || 0
        }
      : { width: 0, height: 0 }
  const filePaths = Array.isArray(raw.filePaths) ? raw.filePaths.map((item) => path.normalize(String(item))) : []

  return {
    text,
    imageDataUrl,
    imageSignature,
    imageSize,
    filePaths,
    signatures: {
      text,
      image: imageSignature,
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

function primeTimelineEntry(entry, nextSignature, nextValue) {
  const hasValue = Array.isArray(nextValue) ? nextValue.length > 0 : Boolean(nextValue)
  if (!hasValue) {
    entry.signature = ''
    entry.timestamp = 0
    entry.value = Array.isArray(nextValue) ? [] : ''
    return false
  }

  entry.signature = nextSignature
  entry.timestamp = 0
  entry.value = Array.isArray(nextValue) ? [...nextValue] : nextValue
  return true
}

function touchTimelineEntry(entry, nextSignature, nextValue, timestamp = Date.now()) {
  const hasValue = Array.isArray(nextValue) ? nextValue.length > 0 : Boolean(nextValue)
  if (!hasValue || entry.signature !== nextSignature) {
    return false
  }

  entry.timestamp = timestamp
  entry.value = Array.isArray(nextValue) ? [...nextValue] : nextValue
  return true
}

function updateClipboardTimeline(raw = {}) {
  const normalized = buildFieldSignatures(raw)
  const changedKinds = []

  if (updateTimelineEntry(clipboardTimeline.text, normalized.signatures.text, normalized.text)) {
    changedKinds.push('text')
  }
  if (updateTimelineEntry(clipboardTimeline.image, normalized.signatures.image, normalized.imageSignature)) {
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


function primeClipboardTimeline(raw = {}) {
  const normalized = buildFieldSignatures(raw)

  primeTimelineEntry(clipboardTimeline.text, normalized.signatures.text, normalized.text)
  primeTimelineEntry(clipboardTimeline.image, normalized.signatures.image, normalized.imageSignature)
  primeTimelineEntry(clipboardTimeline.files, normalized.signatures.files, normalized.filePaths)

  return normalized
}

function resolveLatestKind(preferredKinds = ['files', 'image', 'text']) {
  return preferredKinds
    .map((kind) => ({ kind, timestamp: clipboardTimeline[kind]?.timestamp || 0 }))
    .filter((item) => item.timestamp > 0)
    .sort((a, b) => b.timestamp - a.timestamp)[0]?.kind || 'empty'
}

function filterRegularFilePaths(paths = []) {
  return (Array.isArray(paths) ? paths : [])
    .map((item) => path.normalize(String(item || '')).trim())
    .filter(Boolean)
    .filter((item) => {
      try {
        return fs.statSync(item).isFile()
      } catch {
        return false
      }
    })
}

function splitSelectionPathsByType(paths = []) {
  const filePaths = []
  const folderPaths = []
  const normalized = (Array.isArray(paths) ? paths : [])
    .map((item) => path.normalize(String(item || '')).trim())
    .filter(Boolean)
  for (const item of normalized) {
    try {
      const stat = fs.statSync(item)
      if (stat.isFile()) {
        filePaths.push(item)
      } else if (stat.isDirectory()) {
        folderPaths.push(item)
      }
    } catch {
      // 无法 stat 的路径丢弃，与 filterRegularFilePaths 保持一致
    }
  }
  return { filePaths, folderPaths }
}

function buildSelectionFolderText(folderPaths = []) {
  const normalized = (Array.isArray(folderPaths) ? folderPaths : [])
    .map((item) => String(item || '').trim())
    .filter(Boolean)
  if (normalized.length === 0) {
    return ''
  }
  return normalized.map((item) => '`' + item + '`').join('\n')
}


function buildClipboardPayloadFromKind(kind = 'empty', source = 'clipboard', formats = []) {
  const { filePaths: filteredFilePaths, folderPaths } = kind === 'files'
    ? splitSelectionPathsByType(clipboardTimeline.files.value)
    : { filePaths: [], folderPaths: [] }
  const folderText = buildSelectionFolderText(folderPaths)
  // files 来源但只剩文件夹（无可用文件）时，作为文本字符串输出
  const folderOnly = kind === 'files' && filteredFilePaths.length === 0 && Boolean(folderText)

  const effectiveKind = kind === 'files' && filteredFilePaths.length === 0 ? 'empty' : kind
  const finalKind = folderOnly
    ? 'over'
    : effectiveKind === 'files'
      ? 'files'
      : effectiveKind === 'image'
        ? 'img'
        : effectiveKind === 'text'
          ? 'over'
          : 'empty'
  const timestamp = (effectiveKind === 'files' || folderOnly)
    ? clipboardTimeline.files.timestamp
    : effectiveKind === 'image'
      ? clipboardTimeline.image.timestamp
      : effectiveKind === 'text'
        ? clipboardTimeline.text.timestamp
        : 0
  const ageMs = timestamp > 0 ? Math.max(0, Date.now() - timestamp) : Number.POSITIVE_INFINITY

  // text 来源：纯文本走剪贴板文本；files 来源把文件夹路径并入 text（与文件附件共存）
  const resolvedText = folderOnly
    ? folderText
    : effectiveKind === 'text'
      ? clipboardTimeline.text.value
      : effectiveKind === 'files'
        ? folderText
        : ''

  return {
    ok: true,
    kind: finalKind,
    text: resolvedText,
    imageDataUrl: effectiveKind === 'image' ? clipboardTimeline.image.value : '',
    filePaths: effectiveKind === 'files' ? filteredFilePaths : [],
    hasText: Boolean(resolvedText?.trim()),
    hasImage: effectiveKind === 'image' && Boolean(clipboardTimeline.image.value),
    hasFiles: effectiveKind === 'files' && filteredFilePaths.length > 0,
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

function buildFreshFilePayloadFromState(filePaths = [], timestamp = 0, source = 'selection', formats = []) {
  const { filePaths: normalizedFilePaths, folderPaths } = splitSelectionPathsByType(filePaths)
  const folderText = buildSelectionFolderText(folderPaths)
  const ageMs = timestamp > 0 ? Math.max(0, Date.now() - timestamp) : Number.POSITIVE_INFINITY
  if ((normalizedFilePaths.length === 0 && folderPaths.length === 0) || ageMs > CLIPBOARD_FRESHNESS_MS) {
    return null
  }

  const hasFiles = normalizedFilePaths.length > 0
  return {
    ok: true,
    kind: hasFiles ? 'files' : 'over',
    text: folderText,
    imageDataUrl: '',
    filePaths: normalizedFilePaths,
    hasText: Boolean(folderText),
    hasImage: false,
    hasFiles,
    formats,
    timestamp,
    ageMs,
    freshnessWindowMs: CLIPBOARD_FRESHNESS_MS,
    isFresh: true,
    source
  }
}

function getFreshAuxiliaryFilePayload() {
  const candidates = [
    buildFreshFilePayloadFromState(explorerSelectionState.filePaths, explorerSelectionState.timestamp, 'selection', [
      'foreground-explorer-selection-cache'
    ]),
    buildFreshFilePayloadFromState(clipboardFileDropState.filePaths, clipboardFileDropState.timestamp, 'clipboard', [
      'clipboard-file-drop-cache'
    ])
  ].filter(Boolean)

  return candidates.sort((a, b) => b.timestamp - a.timestamp)[0] || null
}


function resolveClipboardImageDataUrlForPayload(payload = null) {
  if (!payload || payload.kind !== 'img' || !payload.hasImage) {
    return payload
  }

  const imageSnapshot = readClipboardImageSnapshot({ includeDataUrl: true })
  if (!imageSnapshot.imageSignature) {
    return {
      ...payload,
      kind: 'empty',
      imageDataUrl: '',
      hasImage: false,
      timestamp: 0,
      ageMs: Number.POSITIVE_INFINITY,
      isFresh: false,
      source: 'empty'
    }
  }

  if (clipboardTimeline.image.signature && imageSnapshot.imageSignature !== clipboardTimeline.image.signature) {
    return buildClipboardPayloadFromKind('empty', 'empty', payload.formats || [])
  }

  return {
    ...payload,
    imageDataUrl: imageSnapshot.imageDataUrl,
    imageSize: imageSnapshot.imageSize,
    hasImage: Boolean(imageSnapshot.imageDataUrl)
  }
}


async function readClipboardSequenceNumber() {
  if (process.platform !== 'win32') {
    return 0
  }

  const script = `$sig = @"
using System;
using System.Runtime.InteropServices;
public static class Win32 {
  [DllImport("user32.dll")]
  public static extern uint GetClipboardSequenceNumber();
}
"@;
Add-Type -TypeDefinition $sig -ErrorAction SilentlyContinue | Out-Null;
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8;
$OutputEncoding = [Console]::OutputEncoding;
[uint32][Win32]::GetClipboardSequenceNumber()`

  try {
    const { stdout } = await execFileAsync('powershell.exe', ['-NoProfile', '-Command', script], {
      windowsHide: true,
      maxBuffer: 1024 * 256
    })
    const parsed = Number.parseInt(String(stdout || '').trim(), 10)
    return Number.isFinite(parsed) && parsed > 0 ? parsed : 0
  } catch {
    return 0
  }
}

async function primeClipboardSequenceState() {
  const sequence = await readClipboardSequenceNumber()
  if (sequence > 0) {
    clipboardSequenceState.value = sequence
    clipboardSequenceState.checkedAt = Date.now()
  }
  return clipboardSequenceState.value
}

async function refreshClipboardTimelineFromSequence(raw = {}) {
  const sequence = await readClipboardSequenceNumber()
  if (!(sequence > 0)) {
    return false
  }

  if (!(clipboardSequenceState.value > 0)) {
    clipboardSequenceState.value = sequence
    clipboardSequenceState.checkedAt = Date.now()
    return false
  }

  if (sequence === clipboardSequenceState.value) {
    clipboardSequenceState.checkedAt = Date.now()
    return false
  }

  clipboardSequenceState.value = sequence
  clipboardSequenceState.checkedAt = Date.now()

  const normalized = buildFieldSignatures(raw)
  const now = Date.now()

  return [
    touchTimelineEntry(clipboardTimeline.text, normalized.signatures.text, normalized.text, now),
    touchTimelineEntry(clipboardTimeline.image, normalized.signatures.image, normalized.imageSignature, now),
    touchTimelineEntry(clipboardTimeline.files, normalized.signatures.files, normalized.filePaths, now)
  ].some(Boolean)
}

function primeClipboardWatcherState() {
  const raw = readClipboardPayloadRaw()
  primeClipboardTimeline(raw)
  void primeClipboardSequenceState()
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

async function pollAuxiliaryShortcutStates(options = {}) {
  if (auxiliaryShortcutPollInFlight) {
    return
  }

  auxiliaryShortcutPollInFlight = true
  try {
    const shouldPrimeOnly = options?.primeOnly === true && !auxiliaryShortcutWatchPrimed
    const [clipboardPowerShellFiles, explorerSelection] = await Promise.all([
      tryReadClipboardFileDropListViaPowerShell(),
      tryReadForegroundExplorerSelection()
    ])

    updateClipboardFileDropState(clipboardPowerShellFiles, { primeOnly: shouldPrimeOnly })
    updateExplorerSelectionState(explorerSelection, { primeOnly: shouldPrimeOnly })
    auxiliaryShortcutWatchPrimed = true
  } finally {
    auxiliaryShortcutPollInFlight = false
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
  void pollAuxiliaryShortcutStates({ primeOnly: true })
  clipboardWatcherTimer = setInterval(pollClipboardSnapshot, CLIPBOARD_POLL_INTERVAL_MS)
  clipboardWatcherTimer.unref?.()
  auxiliaryShortcutWatcherTimer = setInterval(() => {
    void pollAuxiliaryShortcutStates()
  }, AUXILIARY_SHORTCUT_POLL_INTERVAL_MS)
  auxiliaryShortcutWatcherTimer.unref?.()

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
  if (auxiliaryShortcutWatcherTimer) {
    clearInterval(auxiliaryShortcutWatcherTimer)
    auxiliaryShortcutWatcherTimer = null
  }

  return {
    ok: true,
    stopped: true
  }
}



async function tryReadClipboardFileDropListViaPowerShell() {
  if (process.platform !== 'win32') {
    return []
  }

  const script = `Add-Type -AssemblyName System.Windows.Forms;
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8;
$OutputEncoding = [Console]::OutputEncoding;
try {
  $list = [System.Windows.Forms.Clipboard]::GetFileDropList();
  $paths = @();
  foreach ($item in $list) {
    if ($item) { $paths += [string]$item }
  }
  @{ filePaths = @($paths | Where-Object { $_ } | Select-Object -Unique) } | ConvertTo-Json -Compress
} catch {
  '{"filePaths":[]}'
}`

  try {
    const { stdout } = await execFileAsync('powershell.exe', ['-NoProfile', '-Command', script], {
      windowsHide: true,
      maxBuffer: 1024 * 1024
    })
    const raw = String(stdout || '').trim()
    const parsed = JSON.parse(raw || '{"filePaths":[]}')
    return Array.isArray(parsed?.filePaths)
      ? parsed.filePaths.map((item) => path.normalize(String(item))).filter((item) => item && fs.existsSync(item))
      : []
  } catch {
    return []
  }
}


async function tryReadForegroundExplorerSelection() {
  if (process.platform !== 'win32') {
    return []
  }

  const script = `$sig = @"
using System;
using System.Runtime.InteropServices;
public static class Win32 {
  [DllImport("user32.dll")]
  public static extern IntPtr GetForegroundWindow();
}
"@;
Add-Type -TypeDefinition $sig -ErrorAction SilentlyContinue | Out-Null;
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8;
$OutputEncoding = [Console]::OutputEncoding;
$foregroundHwnd = [int64][Win32]::GetForegroundWindow();
$shell = New-Object -ComObject Shell.Application;
$windows = @();
foreach ($win in $shell.Windows()) {
  try {
    $selected = @();
    try {
      foreach ($item in @($win.Document.SelectedItems())) {
        try {
          if ($item -and $item.Path) { $selected += [string]$item.Path }
        } catch {}
      }
    } catch {}
    $windows += [pscustomobject]@{
      hwnd = [int64]$win.HWND
      selectedCount = @($selected).Count
      filePaths = @($selected | Where-Object { $_ } | Select-Object -Unique)
      location = try { [string]$win.LocationURL } catch { '' }
    }
  } catch {}
}
$target = $windows | Where-Object { $_.hwnd -eq $foregroundHwnd } | Select-Object -First 1;
@{
  foregroundHwnd = $foregroundHwnd
  windows = @($windows)
  filePaths = @($(if ($null -ne $target) { $target.filePaths } else { @() }))
} | ConvertTo-Json -Compress -Depth 6`

  try {
    const { stdout } = await execFileAsync('powershell.exe', ['-NoProfile', '-Command', script], {
      windowsHide: true,
      maxBuffer: 1024 * 1024
    })
    const raw = String(stdout || '').trim()
    const parsed = JSON.parse(raw || '{"filePaths":[]}')
    return Array.isArray(parsed?.filePaths)
      ? parsed.filePaths.map((item) => path.normalize(String(item))).filter((item) => item)
      : []
  } catch {
    return []
  }
}



function updateClipboardFileDropState(filePaths = [], options = {}) {
  const normalized = Array.isArray(filePaths)
    ? filePaths.map((item) => path.normalize(String(item))).filter(Boolean)
    : []
  const signature = JSON.stringify(normalized)
  const shouldPrimeOnly = options?.primeOnly === true

  if (normalized.length === 0) {
    clipboardFileDropState.signature = ''
    clipboardFileDropState.timestamp = 0
    clipboardFileDropState.filePaths = []
    return {
      filePaths: [],
      ageMs: Number.POSITIVE_INFINITY,
      isFresh: false
    }
  }

  if (signature !== clipboardFileDropState.signature) {
    clipboardFileDropState.signature = signature
    clipboardFileDropState.timestamp = shouldPrimeOnly ? 0 : Date.now()
    clipboardFileDropState.filePaths = [...normalized]
  }

  const ageMs = Math.max(0, Date.now() - (clipboardFileDropState.timestamp || 0))
  const isFresh = clipboardFileDropState.timestamp > 0 && ageMs <= CLIPBOARD_FRESHNESS_MS
  return {
    filePaths: [...clipboardFileDropState.filePaths],
    ageMs,
    isFresh
  }
}


function updateExplorerSelectionState(filePaths = [], options = {}) {
  const normalized = Array.isArray(filePaths)
    ? filePaths.map((item) => path.normalize(String(item))).filter(Boolean)
    : []
  const signature = JSON.stringify(normalized)
  const shouldPrimeOnly = options?.primeOnly === true

  if (normalized.length === 0) {
    explorerSelectionState.signature = ''
    explorerSelectionState.timestamp = 0
    explorerSelectionState.filePaths = []
    return {
      filePaths: [],
      ageMs: Number.POSITIVE_INFINITY,
      isFresh: false
    }
  }

  if (signature !== explorerSelectionState.signature) {
    explorerSelectionState.signature = signature
    explorerSelectionState.timestamp = shouldPrimeOnly ? 0 : Date.now()
    explorerSelectionState.filePaths = [...normalized]
  }

  const ageMs = Math.max(0, Date.now() - (explorerSelectionState.timestamp || 0))
  const isFresh = explorerSelectionState.timestamp > 0 && ageMs <= CLIPBOARD_FRESHNESS_MS
  return {
    filePaths: [...explorerSelectionState.filePaths],
    ageMs,
    isFresh
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

  return resolveClipboardImageDataUrlForPayload(getFreshClipboardPayload('selection', ['files', 'image', 'text'], afterRaw.formats))
}


export async function captureQuickPayload() {
  const existingContextPayload = buildPayloadFromShortcutContext()
  if (existingContextPayload.kind !== 'empty') {
    return resolveClipboardImageDataUrlForPayload(existingContextPayload)
  }

  const raw = readClipboardPayloadRaw()
  updateClipboardTimeline(raw)

  const clipboardPayload = getFreshClipboardPayload('clipboard', ['files', 'image', 'text'], raw.formats)
  if (clipboardPayload.kind !== 'empty') {
    return resolveClipboardImageDataUrlForPayload(storeShortcutPayloadContext({
      ...clipboardPayload,
      source: 'recent-clipboard'
    }))
  }

  const auxiliaryFilePayload = getFreshAuxiliaryFilePayload()
  if (auxiliaryFilePayload) {
    return storeShortcutPayloadContext(auxiliaryFilePayload)
  }

  return resolveClipboardImageDataUrlForPayload(buildClipboardPayloadFromKind('empty', 'empty', raw.formats))
}

export async function captureSelectionPayload() {
  const existingContextPayload = buildPayloadFromShortcutContext()
  if (existingContextPayload.kind !== 'empty') {
    return resolveClipboardImageDataUrlForPayload(existingContextPayload)
  }

  const directRaw = readClipboardPayloadRaw()
  updateClipboardTimeline(directRaw)
  const clipboardPayload = getFreshClipboardPayload('clipboard', ['files', 'image', 'text'], directRaw.formats)

  const captured = await tryCaptureSelectionToClipboard()
  if (captured && captured.kind !== 'empty') {
    return storeShortcutPayloadContext(captured)
  }

  if (clipboardPayload.kind !== 'empty' && clipboardPayload.isFresh) {
    return resolveClipboardImageDataUrlForPayload(storeShortcutPayloadContext({
      ...clipboardPayload,
      source: 'recent-clipboard'
    }))
  }

  const auxiliaryFilePayload = getFreshAuxiliaryFilePayload()
  if (auxiliaryFilePayload) {
    return storeShortcutPayloadContext(auxiliaryFilePayload)
  }

  return resolveClipboardImageDataUrlForPayload(buildClipboardPayloadFromKind('empty', 'empty', directRaw.formats))
}

export async function captureQuickFilePayloadFallback() {
  const existingContextPayload = buildPayloadFromShortcutContext()
  if (existingContextPayload.kind === 'files') {
    return existingContextPayload
  }

  const cachedPayload = getFreshAuxiliaryFilePayload()
  if (cachedPayload) {
    return storeShortcutPayloadContext(cachedPayload)
  }

  const [clipboardPowerShellFiles, explorerSelection] = await Promise.all([
    tryReadClipboardFileDropListViaPowerShell(),
    tryReadForegroundExplorerSelection()
  ])

  updateClipboardFileDropState(clipboardPowerShellFiles, { primeOnly: false })
  updateExplorerSelectionState(explorerSelection, { primeOnly: false })

  const fallbackPayload = getFreshAuxiliaryFilePayload()
  return fallbackPayload ? storeShortcutPayloadContext(fallbackPayload) : buildClipboardPayloadFromKind('empty', 'empty', [])
}



export async function markShortcutPayloadConsumed(contextId = '') {
  if (!contextId || latestShortcutPayloadContext.contextId !== contextId) {
    return { ok: false, status: latestShortcutPayloadContext.status || 'expired', matched: false }
  }
  latestShortcutPayloadContext.status = 'consumed'
  return { ok: true, status: 'consumed', matched: true }
}

export async function markShortcutPayloadDiscarded(contextId = '') {
  if (!contextId || latestShortcutPayloadContext.contextId !== contextId) {
    return { ok: false, status: latestShortcutPayloadContext.status || 'expired', matched: false }
  }
  latestShortcutPayloadContext.status = 'discarded'
  return { ok: true, status: 'discarded', matched: true }
}

export async function readClipboardPayload() {
  const raw = readClipboardPayloadRaw()
  updateClipboardTimeline(raw)

  let payload = getFreshClipboardPayload('clipboard', ['files', 'image', 'text'], raw.formats)
  if (payload.kind !== 'empty') {
    return resolveClipboardImageDataUrlForPayload(payload)
  }

  await refreshClipboardTimelineFromSequence(raw)
  payload = getFreshClipboardPayload('clipboard', ['files', 'image', 'text'], raw.formats)
  return resolveClipboardImageDataUrlForPayload(payload)
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

  try {
    const parsedUrl = new URL(normalizedUrl)
    if (isBlockedExternalProtocol(parsedUrl.protocol)) {
      return {
        ok: false,
        reason: 'blocked_protocol'
      }
    }
    if (parsedUrl.protocol === 'file:') {
      const localPath = fileURLToPath(parsedUrl)
      const message = await shell.openPath(localPath)
      return {
        ok: message === '',
        message: message || null
      }
    }
  } catch {
    // Non-standard urls are passed to openExternal below.
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
