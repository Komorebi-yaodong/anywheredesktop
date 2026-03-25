import { app, BrowserWindow, Menu, Tray } from 'electron'
import { electronApp, optimizer } from '@electron-toolkit/utils'
import { registerIpcHandlers } from './ipcHandler.js'
import {
  openWindow,
  showMainWindow,
  hideMainWindow,
  ensureMainWindowVisible,
  listWindows,
  getWindowByRef,
  getWindowRefByWebContentsId,
  minimizeWindow,
  maximizeOrRestoreWindow,
  closeWindow,
  toggleAlwaysOnTop,
  setMainWindowCloseBehavior,
  markAppQuitting,
  isSingletonWindowVisible
} from './windowManager.js'
import { dispatchWindowEvent } from './eventBus.js'
import { syncDesktopShortcuts, clearDesktopShortcuts } from './shortcutManager.js'
import icon from '../resources/icon.png?asset'

import * as systemApi from './core/system.js'
import * as dbApi from './core/db.js'
import * as dataApi from './core/data.js'
import * as fileApi from './core/file.js'
import * as webdavApi from './core/webdav.js'
import * as chatApi from './core/chat.js'
import * as mcpApi from './core/mcp.js'
import * as skillApi from './core/skill.js'

const debugMainLog = () => {}
const debugMainError = () => {}

let appTray = null

process.on('uncaughtException', (error) => {
  debugMainError('process:uncaughtException', error)
})

process.on('unhandledRejection', (reason) => {
  debugMainError('process:unhandledRejection', reason)
})

app.on('child-process-gone', (_event, details) => {
  debugMainError('app-event:child-process-gone', details)
})

function buildQuickPayloadFromClipboardResult(result = {}) {
  const filePaths = Array.isArray(result.filePaths) ? result.filePaths : []
  if (filePaths.length > 0) {
    return {
      type: 'files',
      payload: filePaths.map((filePath) => ({ path: filePath })),
      userText: typeof result.text === 'string' ? result.text.trim() : ''
    }
  }

  if (typeof result.imageDataUrl === 'string' && result.imageDataUrl) {
    if (result.imageDataUrl.startsWith('data:image/svg+xml')) {
      const fallbackText = typeof result.text === 'string' ? result.text.trim() : ''
      return {
        type: 'over',
        payload: fallbackText || result.imageDataUrl
      }
    }

    return {
      type: 'img',
      payload: result.imageDataUrl,
      userText: typeof result.text === 'string' ? result.text.trim() : ''
    }
  }

  if (typeof result.text === 'string' && result.text.trim()) {
    return {
      type: 'over',
      payload: result.text
    }
  }

  return {
    type: 'empty',
    payload: ''
  }
}

async function collectQuickPayload() {
  try {
    const result = await systemApi.captureSelectionPayload()
    return buildQuickPayloadFromClipboardResult(result)
  } catch {
    return {
      type: 'empty',
      payload: ''
    }
  }
}

async function openQuickWindowPreservingMain(payload = null) {
  const keepMainVisible = isSingletonWindowVisible('main')
  const result = await openWindow('quick', payload)

  if (keepMainVisible) {
    try {
      ensureMainWindowVisible()
    } catch {
      // ignore main visibility restore failure
    }
  }

  return result
}


async function triggerQuickSummon() {
  if (isSingletonWindowVisible('quick')) {
    const quickWindow = getWindowByRef('quick')
    if (quickWindow && !quickWindow.isDestroyed()) {
      quickWindow.hide()
      return { ok: true, action: 'hide', type: 'quick' }
    }
  }

  const quickPayload = await collectQuickPayload()
  return openQuickWindowPreservingMain(quickPayload)
}

async function triggerPromptShortcut(promptKey = '') {
  try {
    if (typeof promptKey !== 'string' || !promptKey.trim()) return

    const configResult = await dataApi.getConfig()
    const config = configResult?.config && typeof configResult.config === 'object' ? configResult.config : null
    const promptConfig = config?.prompts?.[promptKey]
    if (!promptConfig || promptConfig.enable === false) return

    const quickPayload = await collectQuickPayload()
    const hasPayload = quickPayload.type !== 'empty'

    if (promptConfig.showMode === 'fastinput') {
      await openQuickWindowPreservingMain({
        ...quickPayload,
        promptKey,
        triggerMode: 'shortcut'
      })
      return
    }

    const openPayload = {
      code: promptKey
    }

    if (hasPayload) {
      openPayload.type = quickPayload.type
      openPayload.payload = quickPayload.payload
    }

    await openWindow('window', openPayload)
  } catch (error) {
    debugMainError('shortcut:prompt-trigger-failed', { promptKey, error: error?.message || error })
  }
}

function buildTrayMenu() {
  return Menu.buildFromTemplate([
    {
      label: '显示主界面',
      click: () => {
        showMainWindow()
      }
    },
    {
      label: '打开召唤界面',
      click: () => {
        triggerQuickSummon()
      }
    },
    { type: 'separator' },
    {
      label: '退出 Anywhere Desktop',
      click: () => {
        markAppQuitting(true)
        app.quit()
      }
    }
  ])
}

function ensureTray() {
  if (appTray) return appTray
  appTray = new Tray(icon)
  appTray.setToolTip('AI Anywhere Desktop')
  appTray.setContextMenu(buildTrayMenu())
  appTray.on('click', () => {
    showMainWindow()
  })
  return appTray
}

async function syncDesktopRuntimeFromConfig() {
  const result = await dataApi.getConfig()
  const config = result?.config && typeof result.config === 'object' ? result.config : {}
  const desktop = config.desktop && typeof config.desktop === 'object' ? config.desktop : {}

  setMainWindowCloseBehavior(desktop.closeToTray === false ? 'close' : 'tray')

  const syncResult = syncDesktopShortcuts(desktop, {
    onMainToggle: () => {
      if (isSingletonWindowVisible('main')) {
        hideMainWindow()
        return
      }
      showMainWindow()
    },
    onQuickSummon: () => {
      triggerQuickSummon()
    },
    onPromptTrigger: (promptKey) => {
      triggerPromptShortcut(promptKey)
    }
  })

  return {
    config,
    desktop: syncResult.desktop
  }
}

app.whenReady().then(async () => {
  electronApp.setAppUserModelId('com.anywhere.desktop')

  app.on('browser-window-created', (_, window) => {
    optimizer.watchWindowShortcuts(window)

    debugMainLog('app-event:browser-window-created', {
      browserWindowId: window.id
    })
  })

  dataApi.setWindowChannelNotifier((channel, payload) => {
    const targets = [...listWindows('window'), ...listWindows('main'), ...listWindows('quick')]
    for (const item of targets) {
      const win = getWindowByRef(item.id)
      if (!win || win.isDestroyed()) continue
      try {
        win.webContents.send(channel, payload)
      } catch {
        // ignore channel notify failure during teardown
      }
    }

    if (channel === 'window:configUpdated' || channel === 'config-updated') {
      syncDesktopRuntimeFromConfig().catch((error) => {
        debugMainError('desktop-shortcuts:resync-failed', error)
      })
    }
  })

  registerIpcHandlers({
    openWindow,
    showMainWindow,
    hideMainWindow,
    listWindows,
    getWindowByRef,
    getWindowRefByWebContentsId,
    dispatchWindowEvent,
    systemApi,
    dbApi,
    dataApi,
    fileApi,
    webdavApi,
    chatApi,
    mcpApi,
    skillApi,
    minimizeWindow,
    maximizeOrRestoreWindow,
    closeWindow,
    toggleAlwaysOnTop
  })

  systemApi.startClipboardWatcher()
  await syncDesktopRuntimeFromConfig()
  ensureTray()
  await openWindow('main')

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) openWindow('main')
  })
})

app.on('before-quit', () => {
  markAppQuitting(true)
  clearDesktopShortcuts()
  systemApi.stopClipboardWatcher()
  dataApi.setWindowChannelNotifier(null)
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit()
  }
})
