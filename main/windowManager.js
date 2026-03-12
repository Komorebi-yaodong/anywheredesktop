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

function createBrowserWindow(type, config, titleSuffix = '') {
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

  return win
}

export function openWindow(type = 'main') {
  const targetType = typeof type === 'string' ? type : 'main'
  const config = WINDOWS[targetType]

  if (!config) {
    throw new Error(`[window] unknown window type: ${targetType}`)
  }

  if (SINGLETON_TYPES.has(targetType)) {
    const existing = singletonStore.get(targetType)
    if (existing && !existing.isDestroyed()) {
      existing.show()
      existing.focus()
      return { ok: true, type: targetType, reused: true }
    }

    const win = createBrowserWindow(targetType, config)
    singletonStore.set(targetType, win)

    win.on('closed', () => {
      singletonStore.delete(targetType)
    })

    return { ok: true, type: targetType, reused: false }
  }

  const id = `${targetType}-${randomUUID()}`
  const win = createBrowserWindow(targetType, config, id)

  multiStore.set(id, win)
  const set = multiTypeIndex.get(targetType) || new Set()
  set.add(id)
  multiTypeIndex.set(targetType, set)

  win.on('closed', () => {
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
    return { ok: true, action: 'hide', existed: false }
  }

  if (mainWindow.isVisible()) {
    mainWindow.hide()
  }

  return { ok: true, action: 'hide', existed: true }
}

