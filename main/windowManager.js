import { BrowserWindow, shell, screen, nativeTheme } from 'electron'
import { is } from '@electron-toolkit/utils'
import { randomUUID } from 'node:crypto'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import icon from '../resources/icon.png?asset'
import { getConfig, defaultConfig, saveSetting } from './core/data.js'
import { startFastInputSession, getFastInputRecommendedBounds, cancelFastInputSession } from './core/fastInput.js'
import { WINDOW_EVENT_CHANNEL } from './eventBus.js'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)


const MAIN_WINDOW_DARK_BACKGROUND = '#17171c'
const MAIN_WINDOW_LIGHT_BACKGROUND = '#fffdf7'
function resolveEffectiveDarkMode(config = {}) {
  const themeMode = typeof config?.themeMode === 'string' ? config.themeMode : ''
  if (themeMode === 'dark') return true
  if (themeMode === 'light') return false
  if (typeof config?.isDarkMode === 'boolean') return config.isDarkMode
  return nativeTheme.shouldUseDarkColors
}



const WINDOWS = {
  main: {
    title: 'AI Anywhere Desktop - Main',
    preload: 'main_preload.js',
    html: 'main/index.html',
    devPath: '/main/index.html',
    width: 1200,
    height: 820,
    options: {
      backgroundColor: '#fffdf7'
    }
  },
  window: {
    title: 'AI Anywhere Desktop - Window',
    preload: 'window_preload.js',
    html: 'window/index.html',
    devPath: '/window/index.html',
    width: 1120,
    height: 760,
    options: {}
  },
  fast: {
    title: 'AI Anywhere Desktop - Fast Input',
    preload: 'fast_input_preload.js',
    html: 'fast_input/index.html',
    devPath: '/fast_input/index.html',
    width: 460,
    height: 60,
    options: {
      frame: false,
      transparent: true,
      alwaysOnTop: true,
      resizable: false,
      skipTaskbar: true,
      hasShadow: false
    }
  },
  quick: {
    title: 'AI Anywhere Desktop - Quick',
    preload: 'quick_preload.js',
    html: 'quick/index.html',
    devPath: '/quick/index.html',
    width: 980,
    height: 420,
    options: {
      frame: false,
      titleBarStyle: 'hidden',
      transparent: false,
      roundedCorners: true,
      alwaysOnTop: true,
      resizable: false,
      skipTaskbar: true,
      hasShadow: true,
      backgroundColor: '#1d1f25'
    }
  }
}

const SINGLETON_TYPES = new Set(['main', 'fast', 'quick'])
const singletonStore = new Map()
const multiStore = new Map()
const multiTypeIndex = new Map()
const windowMetadataStore = new Map()
const webContentsToWindowRef = new Map()
const WINDOW_INIT_CHANNEL = 'window:init'
const WINDOW_POSITION_OVERFLOW_ALLOWANCE = 10
const WINDOW_OVERLAP_OFFSET_STEP = 30
const WINDOW_OVERLAP_MAX_ATTEMPTS = 12
const singletonCloseBehavior = {
  main: 'close'
}
let appQuitting = false


const debugWindowManagerLog = () => {}
const debugWindowManagerError = () => {}

const FAST_INPUT_DEFAULT_VERTICAL_RATIO = 0.85
const FAST_INPUT_POSITION_SAVE_DEBOUNCE_MS = 120

function clamp(value, min, max) {
  if (!Number.isFinite(value)) return min
  if (value < min) return min
  if (value > max) return max
  return value
}

function normalizeFastInputPositionRecord(record = null) {
  if (!record || typeof record !== 'object' || Array.isArray(record)) return null

  const relativeX = resolveNumber(record.relativeX)
  const relativeY = resolveNumber(record.relativeY)
  const displayId = resolveNumber(record.displayId)
  const width = resolveNumber(record.width)
  const height = resolveNumber(record.height)

  if (relativeX !== null || relativeY !== null) {
    return {
      version: 2,
      displayId,
      relativeX: clamp(relativeX ?? 0.5, 0, 1),
      relativeY: clamp(relativeY ?? FAST_INPUT_DEFAULT_VERTICAL_RATIO, 0, 1),
      width: width !== null && width > 0 ? Math.round(width) : null,
      height: height !== null && height > 0 ? Math.round(height) : null
    }
  }

  const legacyX = resolveNumber(record.x)
  const legacyY = resolveNumber(record.y)
  if (legacyX === null || legacyY === null) return null

  return {
    version: 1,
    x: Math.round(legacyX),
    y: Math.round(legacyY)
  }
}

function getDisplayById(displayId = null) {
  if (displayId === null) return null
  return screen.getAllDisplays().find((display) => Number(display?.id) === Number(displayId)) || null
}

function clampWindowBoundsToArea(bounds = {}, area = null) {
  const fallbackArea = area || getDisplayBounds(screen.getPrimaryDisplay())
  const nextWidth = Math.max(1, Math.min(Math.round(bounds.width || 0), Math.round(fallbackArea.width || 1)))
  const nextHeight = Math.max(1, Math.min(Math.round(bounds.height || 0), Math.round(fallbackArea.height || 1)))
  const maxX = fallbackArea.x + fallbackArea.width - nextWidth
  const maxY = fallbackArea.y + fallbackArea.height - nextHeight

  return {
    x: Math.round(clamp(Math.round(bounds.x || fallbackArea.x), fallbackArea.x, maxX)),
    y: Math.round(clamp(Math.round(bounds.y || fallbackArea.y), fallbackArea.y, maxY)),
    width: nextWidth,
    height: nextHeight
  }
}

function getFastInputDefaultBounds(width, height, targetDisplay = null) {
  const display = targetDisplay || screen.getDisplayNearestPoint(screen.getCursorScreenPoint()) || screen.getPrimaryDisplay()
  const displayBounds = getDisplayBounds(display)
  const availableWidth = Math.max(1, displayBounds.width - width)
  const availableHeight = Math.max(1, displayBounds.height - height)

  return clampWindowBoundsToArea({
    x: Math.round(displayBounds.x + availableWidth / 2),
    y: Math.round(displayBounds.y + availableHeight * FAST_INPUT_DEFAULT_VERTICAL_RATIO),
    width,
    height
  }, displayBounds)
}

function resolveFastInputPlacement(fullConfig = {}, width = 520, height = 176) {
  const normalizedRecord = normalizeFastInputPositionRecord(fullConfig?.fastWindowPosition)
  const primaryDisplay = screen.getPrimaryDisplay()
  const cursorDisplay = screen.getDisplayNearestPoint(screen.getCursorScreenPoint()) || primaryDisplay

  if (!normalizedRecord) {
    return getFastInputDefaultBounds(width, height, cursorDisplay)
  }

  if (normalizedRecord.version === 1) {
    const point = { x: normalizedRecord.x, y: normalizedRecord.y }
    const targetDisplay = screen.getDisplayNearestPoint(point) || cursorDisplay || primaryDisplay
    return clampWindowBoundsToArea({ x: normalizedRecord.x, y: normalizedRecord.y, width, height }, getDisplayBounds(targetDisplay))
  }

  const preferredDisplay = getDisplayById(normalizedRecord.displayId) || cursorDisplay || primaryDisplay
  const displayBounds = getDisplayBounds(preferredDisplay)
  const availableWidth = Math.max(1, displayBounds.width - width)
  const availableHeight = Math.max(1, displayBounds.height - height)

  return clampWindowBoundsToArea({
    x: Math.round(displayBounds.x + availableWidth * clamp(normalizedRecord.relativeX ?? 0.5, 0, 1)),
    y: Math.round(displayBounds.y + availableHeight * clamp(normalizedRecord.relativeY ?? FAST_INPUT_DEFAULT_VERTICAL_RATIO, 0, 1)),
    width,
    height
  }, displayBounds)
}

function serializeFastInputPosition(bounds = null) {
  if (!bounds || typeof bounds !== 'object') return null
  const point = {
    x: Math.round(resolveNumber(bounds.x, 0) || 0),
    y: Math.round(resolveNumber(bounds.y, 0) || 0)
  }
  const display = screen.getDisplayNearestPoint(point) || screen.getPrimaryDisplay()
  const displayBounds = getDisplayBounds(display)
  const width = Math.max(1, Math.round(resolveNumber(bounds.width, 0) || 1))
  const height = Math.max(1, Math.round(resolveNumber(bounds.height, 0) || 1))
  const availableWidth = Math.max(1, displayBounds.width - width)
  const availableHeight = Math.max(1, displayBounds.height - height)

  return {
    displayId: Number(display?.id),
    relativeX: clamp((point.x - displayBounds.x) / availableWidth, 0, 1),
    relativeY: clamp((point.y - displayBounds.y) / availableHeight, 0, 1),
    width,
    height
  }
}

function scheduleFastInputPositionSave(win) {
  if (!win || win.isDestroyed()) return
  try {
    if (win.__fastInputPositionSaveTimer) {
      clearTimeout(win.__fastInputPositionSaveTimer)
    }
    win.__fastInputPositionSaveTimer = setTimeout(async () => {
      win.__fastInputPositionSaveTimer = null
      if (!win || win.isDestroyed()) return
      try {
        const record = serializeFastInputPosition(win.getBounds())
        if (!record) return
        await saveSetting('fastWindowPosition', record)
      } catch {
        // ignore fast_input position save failure
      }
    }, FAST_INPUT_POSITION_SAVE_DEBOUNCE_MS)
  } catch {
    // ignore fast_input position save scheduling failure
  }
}

function clearFastInputPositionSaveTimer(win) {
  if (!win) return
  try {
    if (win.__fastInputPositionSaveTimer) {
      clearTimeout(win.__fastInputPositionSaveTimer)
      win.__fastInputPositionSaveTimer = null
    }
  } catch {
    // ignore fast_input position timer cleanup failure
  }
}

async function persistFastInputPositionNow(win) {
  if (!win || win.isDestroyed()) return
  clearFastInputPositionSaveTimer(win)
  try {
    const record = serializeFastInputPosition(win.getBounds())
    if (!record) return
    await saveSetting('fastWindowPosition', record)
  } catch {
    // ignore fast_input position immediate save failure
  }
}



function bindWindowRef(win, ref) {
  if (!win || win.isDestroyed()) return
  if (!win.webContents || win.webContents.isDestroyed()) return
  webContentsToWindowRef.set(win.webContents.id, ref)
}

function unbindWindowRefByWebContentsId(webContentsId) {
  if (typeof webContentsId !== 'number') return
  webContentsToWindowRef.delete(webContentsId)
}

function getSingletonWindow(type) {
  const win = singletonStore.get(type)
  if (!win) return null

  if (win.isDestroyed()) {
    singletonStore.delete(type)
    return null
  }

  return win
}

export function isSingletonWindowVisible(type = 'main') {
  const win = getSingletonWindow(type)
  if (!win || win.isDestroyed()) return false
  return win.isVisible() && !win.isMinimized()
}


function activateWindow(win) {
  if (!win || win.isDestroyed()) return false
  if (win.isMinimized()) win.restore()
  if (!win.isVisible()) win.show()
  try {
    win.__suppressBlurUntil = Date.now() + 260
  } catch {
    // ignore suppress blur mark failure
  }
  try {
    win.moveTop?.()
  } catch {
    // ignore moveTop failure
  }
  try {
    win.focus()
    win.webContents?.focus?.()
  } catch {
    // ignore focus failure
  }
  return true
}

function resolvePreloadFile(fileName) {
  return path.join(__dirname, `../preload/${fileName}`)
}

function normalizeWindowOpenPayload(payload) {
  if (payload && typeof payload === 'object' && !Array.isArray(payload)) {
    return { ...payload }
  }
  return null
}

function resolveNumber(value, fallback = null) {
  const numeric = Number(value)
  return Number.isFinite(numeric) ? numeric : fallback
}

function resolvePromptCode(payload = null) {
  if (typeof payload?.originalCode === 'string' && payload.originalCode.trim()) {
    return payload.originalCode.trim()
  }
  if (typeof payload?.code === 'string' && payload.code.trim()) {
    return payload.code.trim()
  }
  return '__DEFAULT__'
}

function resolvePromptConfig(fullConfig = {}, payload = null, promptCode = '__DEFAULT__') {
  if (payload?.tempPromptConfig && typeof payload.tempPromptConfig === 'object') {
    return { ...payload.tempPromptConfig }
  }

  const prompts = fullConfig?.prompts && typeof fullConfig.prompts === 'object' ? fullConfig.prompts : {}
  return (
    prompts[promptCode] ||
    prompts.AI ||
    defaultConfig.config.prompts.AI ||
    {
      window_width: 580,
      window_height: 740,
      position_x: 0,
      position_y: 0,
      isAlwaysOnTop: true
    }
  )
}


function resolvePromptDisplayName(payload = null, promptCode = '__DEFAULT__') {
  const explicitDisplayName = typeof payload?.displayName === 'string' ? payload.displayName.trim() : ''
  if (explicitDisplayName) return explicitDisplayName

  const normalizedPromptCode = typeof promptCode === 'string' ? promptCode.trim() : ''
  if (normalizedPromptCode && normalizedPromptCode !== '__DEFAULT__') return normalizedPromptCode

  const originalCode = typeof payload?.originalCode === 'string' ? payload.originalCode.trim() : ''
  if (originalCode) return originalCode

  const taskTitle = typeof payload?.taskConfig?.title === 'string' ? payload.taskConfig.title.trim() : ''
  if (taskTitle) return taskTitle

  const filename = typeof payload?.filename === 'string' ? payload.filename.trim() : ''
  if (filename) return filename

  return 'AI'
}

function buildWindowMetadata(windowRef = '', payload = null, fullConfig = {}, promptCode = '__DEFAULT__', promptConfig = null) {
  const resolvedPromptConfig =
    promptConfig && typeof promptConfig === 'object'
      ? promptConfig
      : resolvePromptConfig(fullConfig, payload, promptCode)

  return {
    id: windowRef,
    type: 'window',
    promptCode,
    displayName: resolvePromptDisplayName(payload, promptCode),
    icon: typeof resolvedPromptConfig?.icon === 'string' ? resolvedPromptConfig.icon : '',
    openType: typeof payload?.type === 'string' && payload.type ? payload.type : 'over'
  }
}

function resolveWindowConfig(baseConfig, payload, fullConfig = defaultConfig.config) {
  const nextConfig = {
    ...baseConfig,
    options: {
      ...(baseConfig.options || {})
    }
  }

  if (baseConfig?.html === 'fast_input/index.html') {
    const configPayload = payload && typeof payload === 'object' ? payload : {}
    const resolvedFullConfig = fullConfig && typeof fullConfig === 'object' ? fullConfig : defaultConfig.config || {}
    const promptCode = resolvePromptCode(configPayload)
    const promptConfig = resolvePromptConfig(resolvedFullConfig, configPayload, promptCode)
    const fastBounds = getFastInputRecommendedBounds(promptConfig)
    nextConfig.width = fastBounds.width
    nextConfig.height = fastBounds.height

    const placement = resolveFastInputPlacement(resolvedFullConfig, nextConfig.width, nextConfig.height)
    nextConfig.options.x = placement.x
    nextConfig.options.y = placement.y
    nextConfig.options.alwaysOnTop = true
  }

  if (payload && typeof payload === 'object') {
    if (typeof payload.width === 'number' && Number.isFinite(payload.width) && payload.width > 0) {
      nextConfig.width = payload.width
    }
    if (typeof payload.height === 'number' && Number.isFinite(payload.height) && payload.height > 0) {
      nextConfig.height = payload.height
    }
    if (typeof payload.x === 'number' && Number.isFinite(payload.x)) {
      nextConfig.options.x = payload.x
    }
    if (typeof payload.y === 'number' && Number.isFinite(payload.y)) {
      nextConfig.options.y = payload.y
    }
    if (typeof payload.alwaysOnTop === 'boolean') {
      nextConfig.options.alwaysOnTop = payload.alwaysOnTop
    }
  }

  if (baseConfig?.html === 'quick/index.html') {
    const triggerMode = typeof payload?.triggerMode === 'string' ? payload.triggerMode : ''
    nextConfig.width = 980
    nextConfig.height = triggerMode === 'append-only' ? 164 : 452

    const cursorPoint = screen.getCursorScreenPoint()
    const targetDisplay = screen.getDisplayNearestPoint(cursorPoint) || screen.getPrimaryDisplay()
    const workArea = getWorkArea(targetDisplay)
    nextConfig.options.x = Math.round(workArea.x + (workArea.width - nextConfig.width) / 2)
    nextConfig.options.y = Math.round(workArea.y + (workArea.height - nextConfig.height) / 2)
  }

  return nextConfig
}

function applyQuickWindowBounds(win, config) {
  if (!win || win.isDestroyed() || !config) return

  const nextX = resolveNumber(config?.options?.x)
  const nextY = resolveNumber(config?.options?.y)
  const nextWidth = resolveNumber(config?.width)
  const nextHeight = resolveNumber(config?.height)

  if (nextX === null || nextY === null || nextWidth === null || nextHeight === null) {
    return
  }

  try {
    win.setBounds({
      x: Math.round(nextX),
      y: Math.round(nextY),
      width: Math.round(nextWidth),
      height: Math.round(nextHeight)
    }, false)
  } catch {
    // ignore quick bounds update failure
  }
}

function getDisplayBounds(display) {
  if (!display) {
    const primaryDisplay = screen.getPrimaryDisplay()
    return primaryDisplay?.bounds || { x: 0, y: 0, width: 1920, height: 1080 }
  }
  return display.bounds || display.workArea || { x: 0, y: 0, width: 1920, height: 1080 }
}

function getWorkArea(display) {
  if (!display) {
    const primaryDisplay = screen.getPrimaryDisplay()
    return primaryDisplay?.workArea || primaryDisplay?.bounds || { x: 0, y: 0, width: 1920, height: 1080 }
  }
  return display.workArea || display.bounds || { x: 0, y: 0, width: 1920, height: 1080 }
}

function calculateDialogWindowBounds(fullConfig = {}, payload = null, promptCode = '__DEFAULT__', promptConfig = {}) {
  const primaryDisplay = screen.getPrimaryDisplay()
  const baseBounds = getWorkArea(primaryDisplay)
  const openType = typeof payload?.type === 'string' ? payload.type : ''

  let width = resolveNumber(payload?.width, resolveNumber(promptConfig?.window_width, 580)) || 580
  let height = resolveNumber(payload?.height, resolveNumber(promptConfig?.window_height, 740)) || 740
  let windowX = 0
  let windowY = 0
  let currentDisplay = primaryDisplay

  if (openType === 'task') {
    const padding = 30
    windowX = baseBounds.x + baseBounds.width - width - padding
    windowY = baseBounds.y + padding
  } else if (openType === 'summon') {
    const padding = 30
    windowX = baseBounds.x + baseBounds.width - width - padding
    windowY = baseBounds.y + baseBounds.height - height - padding
  } else {
    const explicitX = resolveNumber(payload?.x)
    const explicitY = resolveNumber(payload?.y)
    const hasExplicitPosition = explicitX !== null && explicitY !== null
    const hasFixedPosition =
      Boolean(fullConfig?.fix_position) &&
      resolveNumber(promptConfig?.position_x) !== null &&
      resolveNumber(promptConfig?.position_y) !== null

    if (hasExplicitPosition) {
      const point = { x: explicitX, y: explicitY }
      currentDisplay = screen.getDisplayNearestPoint(point) || primaryDisplay
      windowX = Math.floor(point.x)
      windowY = Math.floor(point.y)
    } else if (hasFixedPosition) {
      const point = {
        x: resolveNumber(promptConfig.position_x, 0),
        y: resolveNumber(promptConfig.position_y, 0)
      }
      currentDisplay = screen.getDisplayNearestPoint(point) || primaryDisplay
      windowX = Math.floor(point.x)
      windowY = Math.floor(point.y)
    } else {
      const cursorPoint = screen.getCursorScreenPoint()
      currentDisplay = screen.getDisplayNearestPoint(cursorPoint) || primaryDisplay
      windowX = Math.floor(cursorPoint.x - width / 2)
      windowY = Math.floor(cursorPoint.y)
    }
  }

  const displayBounds = getDisplayBounds(currentDisplay)
  if (width > displayBounds.width) width = displayBounds.width
  if (height > displayBounds.height) height = displayBounds.height

  const minX = displayBounds.x - WINDOW_POSITION_OVERFLOW_ALLOWANCE
  const maxX = displayBounds.x + displayBounds.width - width + WINDOW_POSITION_OVERFLOW_ALLOWANCE
  const minY = displayBounds.y - WINDOW_POSITION_OVERFLOW_ALLOWANCE
  const maxY = displayBounds.y + displayBounds.height - height + WINDOW_POSITION_OVERFLOW_ALLOWANCE

  if (
    windowX + width < displayBounds.x ||
    windowX > displayBounds.x + displayBounds.width ||
    windowY + height < displayBounds.y ||
    windowY > displayBounds.y + displayBounds.height
  ) {
    windowX = displayBounds.x + (displayBounds.width - width) / 2
    windowY = displayBounds.y + (displayBounds.height - height) / 2
  } else {
    if (windowX < minX) windowX = minX
    if (windowX > maxX) windowX = maxX
    if (windowY < minY) windowY = minY
    if (windowY > maxY) windowY = maxY
  }

  return {
    x: Math.round(windowX),
    y: Math.round(windowY),
    width: Math.round(width),
    height: Math.round(height)
  }
}

function avoidDialogWindowOverlap(bounds) {
  const nextBounds = { ...bounds }
  const originalX = nextBounds.x
  const originalY = nextBounds.y
  const placementDisplay = screen.getDisplayNearestPoint({ x: nextBounds.x, y: nextBounds.y }) || screen.getPrimaryDisplay()
  const displayArea = getWorkArea(placementDisplay)
  const dialogIds = multiTypeIndex.get('window') || new Set()

  let attempts = 0
  while (attempts < WINDOW_OVERLAP_MAX_ATTEMPTS) {
    let isOverlap = false

    for (const id of dialogIds.values()) {
      const existingWin = multiStore.get(id)
      if (!existingWin || existingWin.isDestroyed() || !existingWin.isVisible()) continue

      try {
        const existingBounds = existingWin.getBounds()
        if (Math.abs(existingBounds.x - nextBounds.x) < 5 && Math.abs(existingBounds.y - nextBounds.y) < 5) {
          isOverlap = true
          break
        }
      } catch {
        // ignore destroyed window bounds read failure
      }
    }

    if (!isOverlap) break

    attempts += 1
    let candidateX = originalX + attempts * WINDOW_OVERLAP_OFFSET_STEP
    let candidateY = originalY + attempts * WINDOW_OVERLAP_OFFSET_STEP

    if (
      candidateX + nextBounds.width > displayArea.x + displayArea.width ||
      candidateY + nextBounds.height > displayArea.y + displayArea.height
    ) {
      candidateX = originalX - attempts * WINDOW_OVERLAP_OFFSET_STEP
      candidateY = originalY - attempts * WINDOW_OVERLAP_OFFSET_STEP

      if (candidateX < displayArea.x || candidateY < displayArea.y) {
        nextBounds.x = Math.max(displayArea.x, candidateX)
        nextBounds.y = Math.max(displayArea.y, candidateY)
        break
      }
    }

    nextBounds.x = candidateX
    nextBounds.y = candidateY
  }

  return nextBounds
}

function resolveDialogWindowConfig(baseConfig, fullConfig = {}, payload = null) {
  const promptCode = resolvePromptCode(payload)
  const promptConfig = resolvePromptConfig(fullConfig, payload, promptCode)
  const placement = avoidDialogWindowOverlap(calculateDialogWindowBounds(fullConfig, payload, promptCode, promptConfig))
  const isDarkMode = resolveEffectiveDarkMode(fullConfig)
  const backgroundColor = isDarkMode ? 'rgba(33, 33, 33, 1)' : 'rgba(255, 255, 253, 1)'
  const alwaysOnTop =
    typeof payload?.alwaysOnTop === 'boolean'
      ? payload.alwaysOnTop
      : promptConfig?.isAlwaysOnTop ?? fullConfig?.isAlwaysOnTop_global ?? true

  return {
    promptCode,
    promptConfig,
    fullConfig,
    config: {
      ...baseConfig,
      devPath: isDarkMode ? `${baseConfig.devPath}?dark=1` : baseConfig.devPath,
      initialThemeSearch: isDarkMode ? '?dark=1' : '',
      title: 'AI Anywhere Desktop - Window',
      width: placement.width,
      height: placement.height,
      options: {
        ...(baseConfig.options || {}),
        x: placement.x,
        y: placement.y,
        frame: false,
        transparent: false,
        hasShadow: true,
        backgroundColor,
        alwaysOnTop
      }
    }
  }
}

async function buildWindowInitMessage(payload = {}, senderId = '', fullConfig = null, promptCode = '') {
  const configSource = fullConfig && typeof fullConfig === 'object'
    ? { config: fullConfig }
    : await getConfig()
  const resolvedFullConfig =
    configSource?.config && typeof configSource.config === 'object'
      ? configSource.config
      : defaultConfig.config

  const code = promptCode || resolvePromptCode(payload)
  const promptConfig = resolvePromptConfig(resolvedFullConfig, payload, code)

  return {
    os: process.platform === 'darwin' ? 'macos' : process.platform === 'win32' ? 'win' : 'linux',
    code,
    type: typeof payload?.type === 'string' && payload.type ? payload.type : 'over',
    payload: payload?.payload ?? '',
    userText: typeof payload?.userText === 'string' ? payload.userText : '',
    contextId: typeof payload?.contextId === 'string' ? payload.contextId : '',
    summonData: payload?.summonData && typeof payload.summonData === 'object' ? payload.summonData : null,
    filename: typeof payload?.filename === 'string' ? payload.filename : '',
    taskConfig: payload?.taskConfig ?? null,
    tempPromptConfig:
      payload?.tempPromptConfig && typeof payload.tempPromptConfig === 'object'
        ? payload.tempPromptConfig
        : null,
    senderId,
    isAlwaysOnTop: payload?.isAlwaysOnTop ?? promptConfig?.isAlwaysOnTop ?? true
  }
}

async function buildQuickWindowInitMessage(payload = {}) {
  return {
    type: typeof payload?.type === 'string' && payload.type ? payload.type : 'empty',
    payload: payload?.payload ?? '',
    userText: typeof payload?.userText === 'string' ? payload.userText : '',
    contextId: typeof payload?.contextId === 'string' ? payload.contextId : '',
    promptKey: typeof payload?.promptKey === 'string' ? payload.promptKey : '',
    triggerMode: typeof payload?.triggerMode === 'string' ? payload.triggerMode : ''
  }
}

function createBrowserWindow(type, config, titleSuffix = '', windowRef = '', initMessage = null) {
  const title = titleSuffix ? `${config.title} (${titleSuffix})` : config.title

  const win = new BrowserWindow({
    title,
    width: config.width,
    height: config.height,
    show: false,
    autoHideMenuBar: true,
    icon,
    webPreferences: {
      preload: resolvePreloadFile(config.preload),
      sandbox: false,
      contextIsolation: false,
      nodeIntegration: false
    },
    ...config.options
  })

  const browserWindowId = win.id
  const webContentsId = win.webContents?.id ?? null
  win.__didFinishLoad = false
  win.__readyToShow = false

  debugWindowManagerLog('createBrowserWindow:created', {
    type,
    windowRef,
    browserWindowId,
    webContentsId,
    title: config.title,
    bounds: win.getBounds()
  })

  win.on('ready-to-show', () => {
    win.__readyToShow = true
    try {
      win.__suppressBlurUntil = Date.now() + 260
    } catch {
      // ignore suppress blur mark failure during ready-to-show
    }
    win.show()
    if (type === 'fast' || type === 'quick') {
      try {
        win.moveTop?.()
      } catch {
        // ignore moveTop failure during ready-to-show
      }
      try {
        win.focus()
        win.webContents?.focus?.()
      } catch {
        // ignore focus failure during ready-to-show
      }
    }
  })

  if (type === 'quick') {
    win.on('blur', () => {
      if (!win.isDestroyed()) {
        setTimeout(() => {
          try {
            if (Date.now() < Number(win.__suppressBlurUntil || 0)) {
              return
            }
            if (!win.isDestroyed() && !win.isFocused()) {
              win.hide()
            }
          } catch {
            // ignore blur-hide failure
          }
        }, 0)
      }
    })
  }

  if (type === 'fast') {
    win.on('moved', () => {
      scheduleFastInputPositionSave(win)
    })

    win.on('closed', () => {
      clearFastInputPositionSaveTimer(win)
    })
  }

  win.webContents.setWindowOpenHandler((details) => {
    shell.openExternal(details.url)
    return { action: 'deny' }
  })

  win.webContents.on('will-navigate', (event, url) => {
    const isLocal = url.startsWith('file://') || 
                   (process.env.ELECTRON_RENDERER_URL && url.startsWith(process.env.ELECTRON_RENDERER_URL)) ||
                   url.startsWith('http://localhost')
    
    if (!isLocal) {
      event.preventDefault()
      shell.openExternal(url)
    }
  })

  if (is.dev && process.env.ELECTRON_RENDERER_URL) {
    win.loadURL(`${process.env.ELECTRON_RENDERER_URL}${config.devPath}`)
  } else {
    const rendererFilePath = path.join(__dirname, `../renderer/${config.html}`)
    if (typeof config.initialThemeSearch === 'string' && config.initialThemeSearch) {
      win.loadFile(rendererFilePath, { search: config.initialThemeSearch })
    } else {
      win.loadFile(rendererFilePath)
    }
  }

    if (type === 'main') {
    win.on('close', (event) => {
      if (appQuitting) return
      if (singletonCloseBehavior.main !== 'tray') return
      event.preventDefault()
      try {
        win.hide()
      } catch {
        // ignore close-to-tray failure
      }
    })
  }


win.webContents.once('did-finish-load', () => {
    win.__didFinishLoad = true
    try {
      win.webContents.send(WINDOW_INIT_CHANNEL, {
        senderId: windowRef || null,
        windowType: type,
        ...(initMessage && typeof initMessage === 'object' ? initMessage : {})
      })
    } catch {
      // ignore init signal send errors during teardown
    }
  })

  return win
}

export async function openWindow(type = 'main', payload = null) {
  const targetType = typeof type === 'string' ? type : 'main'
  const openPayload = normalizeWindowOpenPayload(payload)
  const baseConfig = WINDOWS[targetType]
  const configResult = (targetType === 'window' || targetType === 'fast' || targetType === 'main') ? await getConfig() : null
  const fullConfig =
    configResult?.config && typeof configResult.config === 'object'
      ? configResult.config
      : defaultConfig.config

  const isDarkMode = resolveEffectiveDarkMode(fullConfig)

  const dynamicBaseConfig =
    targetType === 'main'
      ? {
          ...baseConfig,
          devPath: isDarkMode ? `${baseConfig.devPath}?dark=1` : baseConfig.devPath,
          initialThemeSearch: isDarkMode ? '?dark=1' : '',
          options: {
            ...(baseConfig?.options || {}),
            backgroundColor: isDarkMode
              ? MAIN_WINDOW_DARK_BACKGROUND
              : MAIN_WINDOW_LIGHT_BACKGROUND
          }
        }
      : baseConfig

  if (!baseConfig) {
    throw new Error(`[window] unknown window type: ${targetType}`)
  }

  if (SINGLETON_TYPES.has(targetType)) {
    const existing = getSingletonWindow(targetType)
    if (existing) {
      const config = resolveWindowConfig(dynamicBaseConfig, openPayload, fullConfig)
      if (targetType === 'quick') {
        applyQuickWindowBounds(existing, config)
      }
      if (targetType === 'fast') {
        applyQuickWindowBounds(existing, config)
      }
      activateWindow(existing)
      if (targetType === 'quick' && openPayload) {
        const quickInitMessage = await buildQuickWindowInitMessage(openPayload)
        try {
          existing.__quickTriggerMode = quickInitMessage.triggerMode || ''
        } catch {
          // ignore quick triggerMode cache write failure
        }
        try {
          existing.webContents.send(WINDOW_INIT_CHANNEL, {
            senderId: targetType,
            windowType: targetType,
            ...quickInitMessage
          })
        } catch {
          // ignore quick re-init delivery failure
        }
      }
      if (targetType === 'fast' && openPayload) {
        waitForWindowReady(targetType, 2500)
          .then(async (isReady) => {
            if (!isReady || existing.isDestroyed()) return
            const sessionResult = await startFastInputSession({
              win: existing,
              payload: openPayload,
              onCompleted: (sessionResult) => {
                try {
                  existing.__fastInputResult = sessionResult
                } catch {
                  // ignore session cache write failure
                }
              }
            })
            try {
              existing.__fastInputResult = sessionResult
            } catch {
              // ignore session cache write failure
            }
          })
          .catch(() => {
            // ignore fast_input restart failure; renderer state is driven by session events
          })
      }
      return { ok: true, type: targetType, id: targetType, reused: true, payload: openPayload }
    }

    const config = resolveWindowConfig(dynamicBaseConfig, openPayload, fullConfig)
    const initMessage = targetType === 'window'
      ? await buildWindowInitMessage(openPayload, targetType)
      : targetType === 'quick'
        ? await buildQuickWindowInitMessage(openPayload)
        : targetType === 'fast'
          ? {
              code: resolvePromptCode(openPayload || {}),
              type: typeof openPayload?.type === 'string' && openPayload.type ? openPayload.type : 'empty',
              payload: openPayload?.payload ?? '',
              userText: typeof openPayload?.userText === 'string' ? openPayload.userText : '',
              promptKey: typeof openPayload?.promptKey === 'string' ? openPayload.promptKey : '',
              triggerMode: typeof openPayload?.triggerMode === 'string' ? openPayload.triggerMode : ''
            }
          : null
    const win = createBrowserWindow(targetType, config, '', targetType, initMessage)
    if (targetType === 'quick') {
      try {
        win.__quickTriggerMode = typeof initMessage?.triggerMode === 'string' ? initMessage.triggerMode : ''
      } catch {
        // ignore quick triggerMode cache write failure
      }
    }
    singletonStore.set(targetType, win)
    bindWindowRef(win, targetType)
    const webContentsId = win.webContents?.id

    win.on('closed', () => {
      unbindWindowRefByWebContentsId(webContentsId)
      debugWindowManagerLog('singleton-window:closed-cleanup', {
        type: targetType,
        windowRef: targetType,
        webContentsId
      })
      singletonStore.delete(targetType)
    })

    if (targetType === 'fast' && openPayload) {
      waitForWindowReady(targetType, 2500)
        .then(async (isReady) => {
          if (!isReady || win.isDestroyed()) return
          const sessionResult = await startFastInputSession({
            win,
            payload: openPayload,
            onCompleted: (completed) => {
              try {
                win.__fastInputResult = completed
              } catch {
                // ignore session cache write failure
              }
            }
          })
          try {
            win.__fastInputResult = sessionResult
          } catch {
            // ignore session cache write failure
          }
        })
        .catch(() => {
          // ignore fast_input bootstrap failure here; renderer will receive no-op/error state from session start
        })
    }

    return { ok: true, type: targetType, id: targetType, reused: false, payload: openPayload }
  }

  const dialogWindowConfig =
    targetType === 'window'
      ? resolveDialogWindowConfig(baseConfig, fullConfig, openPayload)
      : null

  const config = dialogWindowConfig?.config || resolveWindowConfig(baseConfig, openPayload)
  const id = `${targetType}-${randomUUID()}`
  const initMessage =
    targetType === 'window'
      ? await buildWindowInitMessage(openPayload, id, fullConfig, dialogWindowConfig?.promptCode)
      : null
  const titleSuffix = targetType === 'window' ? dialogWindowConfig?.promptCode || id : id
  const win = createBrowserWindow(targetType, config, titleSuffix, id, initMessage)

  multiStore.set(id, win)
  if (targetType === 'window') {
    windowMetadataStore.set(
      id,
      buildWindowMetadata(id, openPayload, fullConfig, dialogWindowConfig?.promptCode || resolvePromptCode(openPayload), dialogWindowConfig?.promptConfig)
    )
  }
  bindWindowRef(win, id)
  const webContentsId = win.webContents?.id
  const set = multiTypeIndex.get(targetType) || new Set()
  set.add(id)
  multiTypeIndex.set(targetType, set)

  win.on('closed', () => {
    unbindWindowRefByWebContentsId(webContentsId)
    multiStore.delete(id)
    windowMetadataStore.delete(id)

    debugWindowManagerLog('multi-window:closed-cleanup', {
      type: targetType,
      windowRef: id,
      webContentsId
    })
    const indexSet = multiTypeIndex.get(targetType)
    if (indexSet) {
      indexSet.delete(id)
      if (indexSet.size === 0) multiTypeIndex.delete(targetType)
    }
  })

  return {
    ok: true,
    type: targetType,
    id,
    payload: openPayload,
    bounds: targetType === 'window'
      ? {
          width: config.width,
          height: config.height,
          x: config.options?.x,
          y: config.options?.y
        }
      : undefined
  }
}

export function getWindowIds(type) {
  const targetType = typeof type === 'string' ? type : ''
  const set = multiTypeIndex.get(targetType)
  if (!set) return []
  return [...set]
}

export function getWindowById(id) {
  if (!id || typeof id !== 'string') return null
  return multiStore.get(id) || null
}


export function handleFastInputWindowEvent(windowRef = '', eventName = '', payload = null) {
  const win = getWindowByRef(windowRef)
  if (!win || win.isDestroyed()) {
    return { ok: false, reason: 'window_not_found', windowRef }
  }

  if (eventName === 'fast-input:cancel-request') {
    return cancelFastInputSession(win, payload?.reason || 'cancelled')
  }

  return { ok: false, reason: 'unsupported_event', event: eventName, windowRef }
}

export function getWindowByRef(ref) {
  if (!ref || typeof ref !== 'string') return null
  if (SINGLETON_TYPES.has(ref)) return getSingletonWindow(ref)
  return getWindowById(ref)
}


export function waitForWindowReady(windowRef = '', timeoutMs = 2500) {
  const resolvedTimeout = Number.isFinite(Number(timeoutMs)) ? Math.max(0, Number(timeoutMs)) : 2500
  const win = getWindowByRef(windowRef)
  if (!win || win.isDestroyed()) {
    return Promise.resolve(false)
  }

  if (win.__didFinishLoad === true) {
    return Promise.resolve(true)
  }

  return new Promise((resolve) => {
    let settled = false
    let timer = null

    const cleanup = () => {
      if (timer) {
        clearTimeout(timer)
        timer = null
      }
      try {
        win.webContents?.removeListener?.('did-finish-load', handleReady)
      } catch {
        // ignore listener cleanup failure
      }
      try {
        win.removeListener?.('closed', handleClosed)
      } catch {
        // ignore listener cleanup failure
      }
    }

    const settle = (value) => {
      if (settled) return
      settled = true
      cleanup()
      resolve(value)
    }

    const handleReady = () => settle(true)
    const handleClosed = () => settle(false)

    try {
      win.webContents?.once?.('did-finish-load', handleReady)
      win.once?.('closed', handleClosed)
    } catch {
      settle(false)
      return
    }

    timer = setTimeout(() => {
      settle(Boolean(win.__didFinishLoad === true && !win.isDestroyed()))
    }, resolvedTimeout)
  })
}

function resolveActionWindow(windowRef = '') {
  const targetRef = typeof windowRef === 'string' ? windowRef.trim() : ''
  if (!targetRef) {
    return { ok: false, windowRef: null, win: null, error: 'window_ref_required' }
  }

  const win = getWindowByRef(targetRef)
  if (!win || win.isDestroyed()) {
    return { ok: false, windowRef: targetRef, win: null, error: 'window_not_found' }
  }

  return { ok: true, windowRef: targetRef, win }
}


export async function appendPayloadToWindow(windowRef = '', payload = null, options = {}) {
  const resolved = resolveActionWindow(windowRef)
  if (!resolved.ok) {
    return { ok: false, error: resolved.error, windowRef: resolved.windowRef }
  }

  if (!payload || typeof payload !== 'object') {
    return { ok: false, error: 'payload_required', windowRef: resolved.windowRef }
  }

  activateWindow(resolved.win)

  const isReady = await waitForWindowReady(resolved.windowRef, 2500)
  if (!isReady || resolved.win.isDestroyed()) {
    return { ok: false, error: 'window_not_ready', windowRef: resolved.windowRef }
  }

  const envelope = {
    sourceId: typeof options?.sourceId === 'string' && options.sourceId ? options.sourceId : 'quick',
    target: resolved.windowRef,
    event: typeof options?.event === 'string' && options.event ? options.event : 'quick:append-payload',
    payload,
    timestamp: Date.now()
  }

  try {
    resolved.win.webContents.send(WINDOW_EVENT_CHANNEL, envelope)
    return {
      ok: true,
      action: 'append',
      windowRef: resolved.windowRef,
      delivered: 1,
      event: envelope.event
    }
  } catch {
    return {
      ok: false,
      error: 'target_send_failed',
      windowRef: resolved.windowRef,
      delivered: 0,
      event: envelope.event
    }
  }
}

export function minimizeWindow(windowRef = '') {
  const resolved = resolveActionWindow(windowRef)
  if (!resolved.ok) {
    return { ok: false, error: resolved.error, windowRef: resolved.windowRef }
  }

  const { win } = resolved
  if (!win.isMinimized()) {
    win.minimize()
  }

  return {
    ok: true,
    action: 'minimize',
    windowRef: resolved.windowRef,
    minimized: win.isMinimized()
  }
}

export function maximizeOrRestoreWindow(windowRef = '') {
  const resolved = resolveActionWindow(windowRef)
  if (!resolved.ok) {
    return { ok: false, error: resolved.error, windowRef: resolved.windowRef }
  }

  const { win } = resolved
  const wasMaximized = win.isMaximized()

  if (wasMaximized) {
    win.unmaximize()
  } else {
    win.maximize()
  }

  return {
    ok: true,
    action: wasMaximized ? 'restore' : 'maximize',
    windowRef: resolved.windowRef,
    maximized: win.isMaximized()
  }
}

export function closeWindow(windowRef = '') {
  debugWindowManagerLog('closeWindow:enter', { windowRef })
  const resolved = resolveActionWindow(windowRef)
  if (!resolved.ok) {
    const result = { ok: false, error: resolved.error, windowRef: resolved.windowRef }
    debugWindowManagerError('closeWindow:resolve-failed', result)
    return result
  }

  const isDialogWindow = multiStore.has(resolved.windowRef)
  const isQuickSingleton = resolved.windowRef === 'quick'
  const isFastSingleton = resolved.windowRef === 'fast'

  debugWindowManagerLog('closeWindow:resolved', {
    windowRef: resolved.windowRef,
    browserWindowId: resolved.win?.id,
    isDestroyed: resolved.win?.isDestroyed?.() ?? null,
    isVisible: resolved.win?.isVisible?.() ?? null,
    strategy: isDialogWindow ? 'destroy' : isQuickSingleton ? 'hide' : isFastSingleton ? 'destroy' : 'close'
  })

  if (isQuickSingleton) {
    try {
      if (!resolved.win.isDestroyed()) {
        resolved.win.hide()
      }
    } catch {
      // ignore quick hide failure during teardown
    }
    const result = { ok: true, action: 'hide', windowRef: resolved.windowRef }
    debugWindowManagerLog('closeWindow:after-hide-call', result)
    return result
  }

  if (isFastSingleton) {
    try {
      void persistFastInputPositionNow(resolved.win)
    } catch {
      // ignore fast position persistence failure during teardown
    }
    try {
      cancelFastInputSession(resolved.win, 'window_closed')
    } catch {
      // ignore fast session cancellation failure during teardown
    }
    resolved.win.destroy()
    const result = { ok: true, action: 'destroy', windowRef: resolved.windowRef }
    debugWindowManagerLog('closeWindow:after-destroy-call', result)
    return result
  }

  if (isDialogWindow) {
    resolved.win.destroy()
    const result = { ok: true, action: 'destroy', windowRef: resolved.windowRef }
    debugWindowManagerLog('closeWindow:after-destroy-call', result)
    return result
  }

  resolved.win.close()
  const result = { ok: true, action: 'close', windowRef: resolved.windowRef }
  debugWindowManagerLog('closeWindow:after-close-call', result)
  return result
}

export function toggleAlwaysOnTop(windowRef = '', nextState) {
  const resolved = resolveActionWindow(windowRef)
  if (!resolved.ok) {
    return { ok: false, error: resolved.error, windowRef: resolved.windowRef }
  }

  const { win } = resolved
  const willSetAlwaysOnTop =
    typeof nextState === 'boolean' ? nextState : !Boolean(win.isAlwaysOnTop())

  win.setAlwaysOnTop(willSetAlwaysOnTop)

  try {
    const payload = { windowRef: resolved.windowRef, alwaysOnTop: willSetAlwaysOnTop }
    win.webContents.send('window:alwaysOnTopChanged', payload)
    win.webContents.send('always-on-top-changed', willSetAlwaysOnTop)
  } catch {
    // ignore notify error during teardown
  }

  return {
    ok: true,
    action: 'toggle-always-on-top',
    windowRef: resolved.windowRef,
    alwaysOnTop: willSetAlwaysOnTop
  }
}

function enrichWindowListWithPromptOrdinals(items = []) {
  const promptBuckets = new Map()

  for (const item of items) {
    if (!item || item.type !== 'window') continue
    const promptCode = typeof item.promptCode === 'string' && item.promptCode ? item.promptCode : ''
    if (!promptCode) continue
    const bucket = promptBuckets.get(promptCode) || []
    bucket.push(item)
    promptBuckets.set(promptCode, bucket)
  }

  for (const bucket of promptBuckets.values()) {
    bucket.forEach((item, index) => {
      item.promptOrdinal = index + 1
      item.promptWindowCount = bucket.length
    })
  }

  return items
}

export function listWindows(type = '') {
  const targetType = typeof type === 'string' ? type : ''
  const items = []

  for (const singletonType of SINGLETON_TYPES.values()) {
    if (targetType && singletonType !== targetType) continue

    const win = getSingletonWindow(singletonType)
    if (!win) continue

    items.push({
      id: singletonType,
      type: singletonType,
      singleton: true,
      visible: win.isVisible(),
      destroyed: false
    })
  }

  for (const [multiType, idSet] of multiTypeIndex.entries()) {
    if (targetType && multiType !== targetType) continue

    for (const id of idSet.values()) {
      const win = multiStore.get(id)
      if (!win || win.isDestroyed()) continue

      const metadata = multiType === 'window' ? windowMetadataStore.get(id) || {} : {}

      items.push({
        id,
        type: multiType,
        singleton: false,
        visible: win.isVisible(),
        destroyed: false,
        ...(metadata && typeof metadata === 'object' ? metadata : {})
      })
    }
  }

  return enrichWindowListWithPromptOrdinals(items)
}

export function getWindowRefByWebContentsId(webContentsId) {
  if (typeof webContentsId !== 'number') return null
  return webContentsToWindowRef.get(webContentsId) || null
}

export function showMainWindow() {
  const mainWindow = getSingletonWindow('main')
  if (mainWindow) {
    activateWindow(mainWindow)
    return { ok: true, action: 'show', existed: true }
  }

  openWindow('main')
  return { ok: true, action: 'show', existed: false }
}

export function ensureMainWindowVisible() {
  const mainWindow = getSingletonWindow('main')
  if (!mainWindow) {
    return { ok: true, action: 'ensure-visible', existed: false }
  }

  try {
    if (mainWindow.isMinimized()) {
      mainWindow.restore()
    }

    if (!mainWindow.isVisible()) {
      if (typeof mainWindow.showInactive === 'function') {
        mainWindow.showInactive()
      } else {
        mainWindow.show()
      }
    }
  } catch {
    try {
      if (!mainWindow.isVisible()) {
        mainWindow.show()
      }
    } catch {
      // ignore ensure-visible failure during teardown
    }
  }

  return {
    ok: true,
    action: 'ensure-visible',
    existed: true,
    visible: mainWindow.isVisible(),
    minimized: mainWindow.isMinimized()
  }
}


export function hideMainWindow() {
  const mainWindow = getSingletonWindow('main')
  if (!mainWindow) {
    return { ok: true, action: 'hide', existed: false }
  }

  try {
    mainWindow.hide()
  } catch {
    if (!mainWindow.isMinimized()) {
      mainWindow.minimize()
    }
  }

  return { ok: true, action: 'hide', existed: true }
}

export function setMainWindowCloseBehavior(nextBehavior = 'close') {
  singletonCloseBehavior.main = nextBehavior === 'tray' ? 'tray' : 'close'
  return {
    ok: true,
    behavior: singletonCloseBehavior.main
  }
}

export function markAppQuitting(nextState = true) {
  appQuitting = Boolean(nextState)
}


export { WINDOW_INIT_CHANNEL }
