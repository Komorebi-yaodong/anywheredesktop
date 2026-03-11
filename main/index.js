import { app, shell, BrowserWindow, ipcMain } from 'electron'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { electronApp, optimizer, is } from '@electron-toolkit/utils'
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

/** @type {Map<string, BrowserWindow>} */
const windowStore = new Map()

function resolvePreloadFile(fileName) {
  return path.join(__dirname, `../preload/${fileName}`)
}

function createAppWindow(type) {
  const config = WINDOWS[type]
  if (!config) {
    throw new Error(`[window] unknown window type: ${type}`)
  }

  const existing = windowStore.get(type)
  if (existing && !existing.isDestroyed()) {
    existing.show()
    existing.focus()
    return existing
  }

  const win = new BrowserWindow({
    title: config.title,
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

  win.on('closed', () => {
    windowStore.delete(type)
  })

  win.webContents.setWindowOpenHandler((details) => {
    shell.openExternal(details.url)
    return { action: 'deny' }
  })

  if (is.dev && process.env.ELECTRON_RENDERER_URL) {
    win.loadURL(`${process.env.ELECTRON_RENDERER_URL}${config.devPath}`)
  } else {
    win.loadFile(path.join(__dirname, `../renderer/${config.html}`))
  }

  windowStore.set(type, win)
  return win
}

function registerIpcHandlers() {
  ipcMain.on('ping', () => console.log('pong'))

  ipcMain.handle('window:open', (_event, type = 'main') => {
    const targetType = typeof type === 'string' ? type : 'main'
    createAppWindow(targetType)
    return { ok: true, type: targetType }
  })
}

app.whenReady().then(() => {
  electronApp.setAppUserModelId('com.anywhere.desktop')

  app.on('browser-window-created', (_, window) => {
    optimizer.watchWindowShortcuts(window)
  })

  registerIpcHandlers()
  createAppWindow('main')

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createAppWindow('main')
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit()
  }
})
