import { screen } from 'electron'

const SCREENSHOT_CAPTURE_TIMEOUT_MS = 5 * 60 * 1000

let activeCapture = null

function nowCaptureId() {
  return `shot_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`
}

function normalizeText(value = '') {
  return typeof value === 'string' ? value.trim() : ''
}

function isPngDataUrl(value = '') {
  return /^data:image\/png;base64,/i.test(String(value || '').trim())
}

function normalizePromptInput(input = {}) {
  const code = normalizeText(input.code || input.promptKey)
  if (!code) {
    throw new Error('prompt_code_required')
  }

  const showMode = input.showMode === 'fast' || input.showMode === 'fastinput' ? 'fast' : 'window'
  return {
    code,
    promptKey: normalizeText(input.promptKey) || code,
    showMode,
    userText: typeof input.userText === 'string' ? input.userText.trim() : '',
    triggerMode: normalizeText(input.triggerMode) || 'shortcut',
    source: normalizeText(input.source) || 'quick-screenshot'
  }
}

function serializeDisplay(display = null) {
  if (!display) return null
  return {
    id: display.id,
    scaleFactor: display.scaleFactor,
    rotation: display.rotation,
    bounds: { ...display.bounds },
    workArea: { ...display.workArea },
    size: { ...display.size },
    workAreaSize: { ...display.workAreaSize }
  }
}

function resolveCaptureDisplay(input = {}) {
  const point = input?.cursorPoint && typeof input.cursorPoint === 'object'
    ? {
        x: Number(input.cursorPoint.x) || 0,
        y: Number(input.cursorPoint.y) || 0
      }
    : screen.getCursorScreenPoint()
  return screen.getDisplayNearestPoint(point) || screen.getPrimaryDisplay()
}

function chooseScreenSource(sources = [], display = null) {
  if (!Array.isArray(sources) || sources.length === 0) return null
  const displayId = display?.id != null ? String(display.id) : ''
  if (displayId) {
    const matched = sources.find((source) => String(source?.displayId || '') === displayId)
    if (matched) return matched
  }
  return sources.find((source) => String(source?.id || '').startsWith('screen:')) || sources[0]
}

function normalizeSourcesOptions(display = null) {
  const bounds = display?.bounds || display?.size || {}
  const width = Math.max(800, Math.round(Number(bounds.width) || 1920))
  const height = Math.max(600, Math.round(Number(bounds.height) || 1080))
  return {
    types: ['screen'],
    fetchWindowIcons: false,
    thumbnailSize: { width, height }
  }
}

function delay(ms = 0) {
  return new Promise((resolve) => setTimeout(resolve, Math.max(0, Number(ms) || 0)))
}

async function hideQuickWindowBeforeCapture(deps = {}) {
  if (typeof deps.getWindowByRef !== 'function') return
  const quickWindow = deps.getWindowByRef('quick')
  if (!quickWindow || quickWindow.isDestroyed?.() || !quickWindow.isVisible?.()) return

  try {
    quickWindow.hide()
  } catch {
    // ignore quick hide failure; capture will still proceed
  }

  await delay(180)
}


function ensureActiveCapture(captureId = '') {
  if (!activeCapture || !activeCapture.captureId) {
    throw new Error('screenshot_capture_not_active')
  }
  if (captureId && activeCapture.captureId !== captureId) {
    throw new Error('screenshot_capture_mismatch')
  }
  if (Date.now() - activeCapture.createdAt > SCREENSHOT_CAPTURE_TIMEOUT_MS) {
    activeCapture = null
    throw new Error('screenshot_capture_expired')
  }
  return activeCapture
}

export function isImagePngDataUrl(value = '') {
  return isPngDataUrl(value)
}

export async function startScreenshotPrompt(input = {}, deps = {}) {
  const prompt = normalizePromptInput(input)
  if (!deps?.systemApi?.getDesktopSources || typeof deps.openWindow !== 'function') {
    throw new Error('screenshot_dependencies_missing')
  }

  const display = resolveCaptureDisplay(input)

  await hideQuickWindowBeforeCapture(deps)

  const sourcesResult = await deps.systemApi.getDesktopSources(normalizeSourcesOptions(display))
  const sources = Array.isArray(sourcesResult?.sources) ? sourcesResult.sources : []
  const source = chooseScreenSource(sources, display)

  if (!source?.thumbnailDataUrl) {
    throw new Error('screenshot_source_unavailable')
  }

  const displayInfo = serializeDisplay(display)
  const bounds = displayInfo?.bounds || { x: 0, y: 0, width: 1200, height: 800 }
  const captureId = nowCaptureId()

  activeCapture = {
    captureId,
    prompt,
    display: displayInfo,
    sourceId: source.id || '',
    sourceName: source.name || '',
    createdAt: Date.now()
  }

  return deps.openWindow('screenshot', {
    captureId,
    sourceId: source.id || '',
    sourceName: source.name || '',
    thumbnailDataUrl: source.thumbnailDataUrl,
    display: displayInfo,
    prompt,
    x: Math.round(Number(bounds.x) || 0),
    y: Math.round(Number(bounds.y) || 0),
    width: Math.max(320, Math.round(Number(bounds.width) || 1200)),
    height: Math.max(240, Math.round(Number(bounds.height) || 800)),
    alwaysOnTop: true
  })
}

export async function confirmScreenshotPrompt(input = {}, deps = {}) {
  const capture = ensureActiveCapture(typeof input?.captureId === 'string' ? input.captureId : '')
  const dataUrl = typeof input?.dataUrl === 'string' ? input.dataUrl.trim() : ''
  if (!isPngDataUrl(dataUrl)) {
    throw new Error('screenshot_png_data_url_required')
  }
  if (typeof deps.openWindow !== 'function') {
    throw new Error('screenshot_open_window_missing')
  }

  const prompt = capture.prompt
  activeCapture = null

  try {
    if (typeof deps.closeWindow === 'function') {
      deps.closeWindow('screenshot')
    }
  } catch {
    // ignore screenshot window close failure; opening target window is more important
  }

  return deps.openWindow(prompt.showMode === 'fast' ? 'fast' : 'window', {
    code: prompt.code,
    promptKey: prompt.promptKey || prompt.code,
    type: 'img',
    payload: dataUrl,
    userText: prompt.userText || '',
    triggerMode: 'shortcut'
  })
}

export async function cancelScreenshotPrompt(input = {}, deps = {}) {
  const captureId = typeof input?.captureId === 'string' ? input.captureId : ''
  if (activeCapture && (!captureId || activeCapture.captureId === captureId)) {
    activeCapture = null
  }
  try {
    if (typeof deps.closeWindow === 'function') {
      deps.closeWindow('screenshot')
    }
  } catch {
    // ignore close failure during cancel
  }
  return { ok: true, action: 'cancel-screenshot' }
}

export function getActiveScreenshotPrompt() {
  if (!activeCapture) return { ok: true, active: false }
  if (Date.now() - activeCapture.createdAt > SCREENSHOT_CAPTURE_TIMEOUT_MS) {
    activeCapture = null
    return { ok: true, active: false, expired: true }
  }
  return {
    ok: true,
    active: true,
    captureId: activeCapture.captureId,
    prompt: activeCapture.prompt,
    display: activeCapture.display,
    sourceId: activeCapture.sourceId,
    sourceName: activeCapture.sourceName
  }
}
