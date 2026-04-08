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
  waitForWindowReady,
  minimizeWindow,
  maximizeOrRestoreWindow,
  closeWindow,
  toggleAlwaysOnTop,
  handleFastInputWindowEvent,
  appendPayloadToWindow,
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
  const rawText = typeof result.text === 'string' ? result.text : ''
  const trimmedText = rawText.trim()
  const normalizedType = typeof result.kind === 'string' && result.kind ? result.kind : ''
  const textType = /\r?\n/.test(rawText) ? 'multiline-text' : 'over'
  const imageDataUrl = typeof result.imageDataUrl === 'string' ? result.imageDataUrl : ''
  const hasRasterImage = Boolean(imageDataUrl && !imageDataUrl.startsWith('data:image/svg+xml'))

  if ((filePaths.length > 0 || normalizedType === 'files') && hasRasterImage) {
    return {
      type: 'files',
      payload: [
        { name: 'clipboard-image.png', dataUrl: imageDataUrl },
        ...filePaths.map((filePath) => ({ path: filePath }))
      ],
      userText: trimmedText,
      source: result.source || 'clipboard'
    }
  }

  if (filePaths.length > 0 || normalizedType === 'files') {
    return {
      type: 'files',
      payload: filePaths.map((filePath) => ({ path: filePath })),
      userText: trimmedText,
      source: result.source || 'clipboard'
    }
  }

  if (hasRasterImage) {
    return {
      type: 'img',
      payload: imageDataUrl,
      userText: trimmedText,
      source: result.source || 'clipboard'
    }
  }

  if (imageDataUrl) {
    return {
      type: trimmedText ? textType : 'empty',
      payload: trimmedText ? rawText : '',
      source: result.source || 'clipboard'
    }
  }

  if (trimmedText) {
    return {
      type: textType,
      payload: rawText,
      source: result.source || 'clipboard'
    }
  }

  return {
    type: 'empty',
    payload: '',
    source: result.source || 'empty'
  }
}

async function collectQuickPayload() {
  try {
    const result = await systemApi.captureSelectionPayload()
    return buildQuickPayloadFromClipboardResult(result)
  } catch {
    return {
      type: 'empty',
      payload: '',
      source: 'empty'
    }
  }
}



async function collectQuickPayloadFast() {
  try {
    const result = await systemApi.captureQuickPayload()
    const payload = buildQuickPayloadFromClipboardResult(result)
    return payload
  } catch {
    return {
      type: 'empty',
      payload: '',
      source: 'empty'
    }
  }
}


async function openQuickWindowPreservingMain(payload = null) {
  return openWindow('quick', payload)
}

function pushQuickPayloadToVisibleWindow(payload = null) {
  const quickWindow = getWindowByRef('quick')
  if (!quickWindow || quickWindow.isDestroyed() || !quickWindow.isVisible()) return false

  try {
    quickWindow.webContents.send('window:init', {
      senderId: 'quick',
      windowType: 'quick',
      type: typeof payload?.type === 'string' && payload.type ? payload.type : 'empty',
      payload: payload?.payload ?? '',
      userText: typeof payload?.userText === 'string' ? payload.userText : '',
      promptKey: typeof payload?.promptKey === 'string' ? payload.promptKey : '',
      triggerMode: typeof payload?.triggerMode === 'string' ? payload.triggerMode : ''
    })
    return true
  } catch {
    return false
  }
}

let quickSummonToken = 0

async function triggerQuickSummon() {
  const quickWindow = getWindowByRef('quick')
  if (quickWindow && !quickWindow.isDestroyed() && quickWindow.isVisible() && quickWindow.isFocused()) {
    quickSummonToken += 1
    quickWindow.hide()
    return { ok: true, action: 'hide', type: 'quick' }
  }

  const token = ++quickSummonToken
  const openResult = await openQuickWindowPreservingMain({
    type: 'empty',
    payload: '',
    source: 'empty'
  })

  collectQuickPayloadFast()
    .then((quickPayload) => {
      if (token !== quickSummonToken) return
      if (!quickPayload || quickPayload.type === 'empty') return
      pushQuickPayloadToVisibleWindow(quickPayload)
    })
    .catch((error) => {
      debugMainError('quick:fast-payload-collect-failed', error)
    })

  return openResult
}

async function dispatchShortcutPayloadToWindow(targetWindowId, quickPayload, promptKey = '') {
  if (typeof targetWindowId !== 'string' || !targetWindowId) return false
  if (!quickPayload || quickPayload.type === 'empty') return false

  const isReady = await waitForWindowReady(targetWindowId, 2500)
  if (!isReady) return false

  const dispatchResult = dispatchWindowEvent(
    {
      sourceId: 'global-shortcut',
      target: targetWindowId,
      event: 'shortcut:append-payload',
      payload: {
        code: promptKey,
        triggerMode: 'shortcut',
        ...quickPayload
      }
    },
    { getWindowByRef, listWindows }
  )

  return Boolean(dispatchResult?.ok && dispatchResult?.delivered > 0)
}



async function triggerAppendFollowUpShortcut() {
  try {
    const quickWindow = getWindowByRef('quick')
    if (
      quickWindow &&
      !quickWindow.isDestroyed() &&
      quickWindow.isVisible() &&
      quickWindow.isFocused() &&
      String(quickWindow.__quickTriggerMode || '') === 'append-only'
    ) {
      quickWindow.hide()
      return { ok: true, action: 'hide', type: 'quick' }
    }

    const windows = (listWindows('window') || []).filter((item) => item && item.type === 'window' && item.id)
    if (windows.length === 0) {
      return { ok: false, reason: 'no_window_targets' }
    }

    if (windows.length === 1) {
      const quickPayload = await collectQuickPayloadFast()
      if (quickPayload && quickPayload.type !== 'empty') {
        return appendPayloadToWindow(windows[0].id, quickPayload, {
          sourceId: 'append-shortcut',
          event: 'quick:append-payload'
        })
      }
    }

    const token = ++quickSummonToken
    const openResult = await openQuickWindowPreservingMain({
      type: 'empty',
      payload: '',
      source: 'empty',
      triggerMode: 'append-only'
    })

    collectQuickPayloadFast()
      .then((quickPayload) => {
        if (token !== quickSummonToken) return
        if (!quickPayload || quickPayload.type === 'empty') return
        pushQuickPayloadToVisibleWindow({
          ...quickPayload,
          triggerMode: 'append-only'
        })
      })
      .catch((error) => {
        debugMainError('append-shortcut:fast-payload-collect-failed', error)
      })

    return openResult
  } catch (error) {
    debugMainError('shortcut:append-follow-up-failed', error)
    return { ok: false, reason: 'append_follow_up_failed', error: error?.message || String(error) }
  }
}


async function triggerPromptShortcut(promptKey = '') {
  try {
    if (typeof promptKey !== 'string' || !promptKey.trim()) return

    const normalizedPromptKey = promptKey.trim()
    const configResult = await dataApi.getConfig()
    const config = configResult?.config && typeof configResult.config === 'object' ? configResult.config : null
    const promptConfig = config?.prompts?.[normalizedPromptKey]
    if (!promptConfig || promptConfig.enable === false) return

    if (promptConfig.showMode === 'fastinput') {
      const quickPayload = await collectQuickPayloadFast()

      await openWindow('fast', {
        code: normalizedPromptKey,
        ...quickPayload,
        promptKey: normalizedPromptKey,
        triggerMode: 'shortcut'
      })
      return
    }

    const openResult = await openWindow('window', {
      code: normalizedPromptKey
    })

    collectQuickPayloadFast()
      .then(async (quickPayload) => {

        if (!quickPayload || quickPayload.type === 'empty') return
        const delivered = await dispatchShortcutPayloadToWindow(openResult?.id, quickPayload, normalizedPromptKey)
        if (!delivered) {
          debugMainError('shortcut:payload-dispatch-timeout', {
            promptKey: normalizedPromptKey,
            targetWindowId: openResult?.id || null
          })
        }
      })
      .catch((error) => {
        debugMainError('shortcut:payload-collect-failed', {
          promptKey: normalizedPromptKey,
          error: error?.message || error
        })
      })
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

  try {
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
      onAppendFollowUp: () => {
        triggerAppendFollowUpShortcut()
      },
      onPromptTrigger: (promptKey) => {
        triggerPromptShortcut(promptKey)
      }
    })

    return {
      config,
      desktop: syncResult.desktop
    }
  } catch (error) {
    debugMainError('desktop-shortcuts:sync-failed', {
      error: error?.message || String(error),
      desktop
    })
    clearDesktopShortcuts()
    return {
      config,
      desktop
    }
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
    toggleAlwaysOnTop,
    handleFastInputWindowEvent,
    appendPayloadToWindow
  })

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
