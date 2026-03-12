import { BrowserWindow, shell } from 'electron'
import { is } from '@electron-toolkit/utils'
import { randomUUID } from 'node:crypto'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import icon from '../resources/icon.png?asset'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)

const WINDOWS = {
  main: {
    title: 'AI Anywhere Desktop - Main',
    preload: 'main_preload.js',
    html: 'main/index.html',
    devPath: '/main/index.html',
    width: 1200,
    height: 820,
    options: {}
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
    title: 'AI Anywhere Desktop - Fast Window',
    preload: 'fast_preload.js',
    html: 'fast_window/index.html',
    devPath: '/fast_window/index.html',
    width: 560,
    height: 420,
    options: {
      frame: false,
      transparent: true,
      alwaysOnTop: true,
      resizable: false,
      skipTaskbar: true
    }
  }
}

const SINGLETON_TYPES = new Set(['main', 'fast'])

/** @type {Map<string, BrowserWindow>} */
const singletonStore = new Map()

/** @type {Map<string, BrowserWindow>} */
const multiStore = new Map()

/** @type {Map<string, Set<string>>} */
const multiTypeIndex = new Map()


/** @type {Map<number, string>} */
const webContentsToWindowRef = new Map()

const WINDOW_INIT_CHANNEL = 'window:init'

function bindWindowRef(win, ref) {
  if (!win || win.isDestroyed()) return
  if (!win.webContents || win.webContents.isDestroyed()) return

  webContentsToWindowRef.set(win.webContents.id, ref)
}

function unbindWindowRefByWebContentsId(webContentsId) {
  if (typeof webContentsId !== 'number') return
  webContentsToWindowRef.delete(webContentsId)
}

function unbindWindowRef(win) {
  if (!win) return

  let webContentsId = null
  try {
    webContentsId = win.webContents?.id
  } catch {
    webContentsId = null
  }

  unbindWindowRefByWebContentsId(webContentsId)
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

function activateWindow(win) {
  if (!win || win.isDestroyed()) return false
  if (win.isMinimized()) win.restore()
  if (!win.isVisible()) win.show()
  win.focus()
  return true
}

function resolvePreloadFile(fileName) {
  return path.join(__dirname, `../preload/${fileName}`)
}

function createBrowserWindow(type, config, titleSuffix = '', windowRef = '') {
  const title = titleSuffix ? `${config.title} (${titleSuffix})` : config.title

  const win = new BrowserWindow({
    title,
    width: config.width,
    height: config.height,
    show: false,
    autoHideMenuBar: true,
    ...(process.platform === 'linux' ? { icon } : {}),
    webPreferences: {
      preload: resolvePreloadFile(config.preload),
      sandbox: false,
      contextIsolation: true,
      nodeIntegration: false
    },
    ...config.options
  })

  win.on('ready-to-show', () => {
    win.show()
  })

  if (type === 'fast') {
    win.on('blur', () => {
      if (!win.isDestroyed()) win.hide()
    })
  }

  win.webContents.setWindowOpenHandler((details) => {
    shell.openExternal(details.url)
    return { action: 'deny' }
  })

  if (is.dev && process.env.ELECTRON_RENDERER_URL) {
    win.loadURL(`${process.env.ELECTRON_RENDERER_URL}${config.devPath}`)
  } else {
    win.loadFile(path.join(__dirname, `../renderer/${config.html}`))
  }


  win.webContents.once('did-finish-load', () => {
    try {
      win.webContents.send(WINDOW_INIT_CHANNEL, {
        senderId: windowRef || null,
        windowType: type
      })
    } catch {
      // ignore init signal send errors during teardown
    }
  })

  return win
}

export function openWindow(type = 'main') {
  const targetType = typeof type === 'string' ? type : 'main'
  const config = WINDOWS[targetType]

  if (!config) {
    throw new Error(`[window] unknown window type: ${targetType}`)
  }

  if (SINGLETON_TYPES.has(targetType)) {
    const existing = getSingletonWindow(targetType)
    if (existing) {
      activateWindow(existing)
      return { ok: true, type: targetType, id: targetType, reused: true }
    }

    const win = createBrowserWindow(targetType, config, '', targetType)
    singletonStore.set(targetType, win)
    bindWindowRef(win, targetType)
    const webContentsId = win.webContents?.id

    win.on('closed', () => {
      unbindWindowRefByWebContentsId(webContentsId)
      singletonStore.delete(targetType)
    })

    return { ok: true, type: targetType, id: targetType, reused: false }
  }

  const id = `${targetType}-${randomUUID()}`
  const win = createBrowserWindow(targetType, config, id, id)

  multiStore.set(id, win)
  bindWindowRef(win, id)
  const webContentsId = win.webContents?.id
  const set = multiTypeIndex.get(targetType) || new Set()
  set.add(id)
  multiTypeIndex.set(targetType, set)

  win.on('closed', () => {
    unbindWindowRefByWebContentsId(webContentsId)
    multiStore.delete(id)
    const indexSet = multiTypeIndex.get(targetType)
    if (indexSet) {
      indexSet.delete(id)
      if (indexSet.size === 0) multiTypeIndex.delete(targetType)
    }
  })

  return { ok: true, type: targetType, id }
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


export function getWindowByRef(ref) {
  if (!ref || typeof ref !== 'string') return null

  if (SINGLETON_TYPES.has(ref)) {
    return getSingletonWindow(ref)
  }

  return getWindowById(ref)
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

      items.push({
        id,
        type: multiType,
        singleton: false,
        visible: win.isVisible(),
        destroyed: false
      })
    }
  }

  return items
}


export function getWindowRefByWebContentsId(webContentsId) {
  if (typeof webContentsId !== 'number') return null
  return webContentsToWindowRef.get(webContentsId) || null
}


export { WINDOW_INIT_CHANNEL }





export function showMainWindow() {
  const mainWindow = getSingletonWindow('main')
  if (mainWindow) {
    activateWindow(mainWindow)
    return { ok: true, action: 'show', existed: true }
  }

  openWindow('main')
  return { ok: true, action: 'show', existed: false }
}

export function hideMainWindow() {
  const mainWindow = getSingletonWindow('main')
  if (!mainWindow) {
    return { ok: true, action: 'minimize', existed: false }
  }

  if (!mainWindow.isMinimized()) {
    mainWindow.minimize()
  }

  return { ok: true, action: 'minimize', existed: true }
}

