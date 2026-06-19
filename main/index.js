/**
 * Copyright (C) 2026 Komorebi
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU Affero General Public License as published by
 * the Free Software Foundation, either version 3 of the License, or
 * (at your option) any later version.
 *
 * This program is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE. See the
 * GNU Affero General Public License for more details.
 *
 * You should have received a copy of the GNU Affero General Public License
 * along with this program. If not, see <https://www.gnu.org/licenses/>.
 */


import { app, Menu, Tray, nativeTheme, nativeImage, powerMonitor } from 'electron'
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
import * as screenshotApi from './core/screenshot.js'


let appTray = null
let appQuitStarted = false


const hasSingleInstanceLock = app.requestSingleInstanceLock()

function focusPrimaryInstanceMainWindow() {
  if (!app.isReady()) return
  ensureMainWindowVisible()
  showMainWindow()
}

if (!hasSingleInstanceLock) {
  app.quit()
} else {
  app.on('second-instance', () => {
    if (app.isReady()) {
      focusPrimaryInstanceMainWindow()
      return
    }

    app.once('ready', () => {
      focusPrimaryInstanceMainWindow()
    })
  })
}


function resolveNativeThemeSource(config = {}) {
  const themeMode = typeof config?.themeMode === 'string' ? config.themeMode : 'system'
  if (themeMode === 'dark') return 'dark'
  if (themeMode === 'light') return 'light'
  return 'system'
}

function syncNativeThemeFromConfig(config = {}) {
  nativeTheme.themeSource = resolveNativeThemeSource(config)

}


process.on('uncaughtException', (error) => {
  console.error('[main] uncaughtException', error)
})

process.on('unhandledRejection', (reason) => {
  console.error('[main] unhandledRejection', reason)
})

app.on('child-process-gone', (_event, details) => {
  console.error('[main] child-process-gone', details)
})


function isRasterImageDataUrl(value = '') {
  return /^data:image\/(png|jpe?g|webp|gif|bmp);base64,/i.test(String(value || '').trim())
}

function normalizeImagePayloadToPngDataUrl(payload = null) {
  if (!payload || payload.type !== 'img' || !isRasterImageDataUrl(payload.payload)) {
    return null
  }

  const image = nativeImage.createFromDataURL(String(payload.payload || ''))
  if (!image || image.isEmpty()) {
    return null
  }

  const pngBuffer = image.toPNG()
  return {
    ...payload,
    type: 'img',
    payload: pngBuffer.length > 0 ? nativeImage.createFromBuffer(pngBuffer).toDataURL() : image.toDataURL()
  }
}


function buildQuickPayloadFromClipboardResult(result = {}) {
  const filePaths = Array.isArray(result.filePaths) ? result.filePaths : []
  const rawText = typeof result.text === 'string' ? result.text : ''
  const trimmedText = rawText.trim()
  const normalizedType = typeof result.kind === 'string' && result.kind ? result.kind : ''
  const textType = /\r?\n/.test(rawText) ? 'multiline-text' : 'over'
  const imageDataUrl = typeof result.imageDataUrl === 'string' ? result.imageDataUrl : ''
  const hasRasterImage = Boolean(imageDataUrl && !imageDataUrl.startsWith('data:image/svg+xml'))
  const contextId = typeof result.contextId === 'string' ? result.contextId : ''

  if ((filePaths.length > 0 || normalizedType === 'files') && hasRasterImage) {
    return {
      type: 'files',
      payload: [
        { name: 'clipboard-image.png', dataUrl: imageDataUrl },
        ...filePaths.map((filePath) => ({ path: filePath }))
      ],
      userText: trimmedText,
      source: result.source || 'clipboard',
      contextId
    }
  }

  if (filePaths.length > 0 || normalizedType === 'files') {
    return {
      type: 'files',
      payload: filePaths.map((filePath) => ({ path: filePath })),
      userText: trimmedText,
      source: result.source || 'clipboard',
      contextId
    }
  }

  if (hasRasterImage) {
    return {
      type: 'img',
      payload: imageDataUrl,
      userText: trimmedText,
      source: result.source || 'clipboard',
      contextId
    }
  }

  if (imageDataUrl) {
    return {
      type: trimmedText ? textType : 'empty',
      payload: trimmedText ? rawText : '',
      source: result.source || 'clipboard',
      contextId
    }
  }

  if (trimmedText) {
    return {
      type: textType,
      payload: rawText,
      source: result.source || 'clipboard',
      contextId
    }
  }

  return {
    type: 'empty',
    payload: '',
    source: result.source || 'empty',
    contextId
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

async function collectQuickFilePayloadFallback() {
  try {
    const result = await systemApi.captureQuickFilePayloadFallback()
    return buildQuickPayloadFromClipboardResult(result)
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

async function startScreenshotPromptWorkflow(input = {}) {
  return screenshotApi.startScreenshotPrompt(input, {
    openWindow,
    closeWindow,
    getWindowByRef,
    systemApi
  })
}

async function confirmScreenshotPromptWorkflow(input = {}) {
  return screenshotApi.confirmScreenshotPrompt(input, {
    openWindow,
    closeWindow
  })
}

async function cancelScreenshotPromptWorkflow(input = {}) {
  return screenshotApi.cancelScreenshotPrompt(input, {
    closeWindow
  })
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

  const quickPayload = await collectQuickPayloadFast()
  const token = ++quickSummonToken
  const openResult = await openQuickWindowPreservingMain(quickPayload)

  if (quickPayload.type === 'empty') {
    collectQuickFilePayloadFallback()
      .then((fallbackPayload) => {
        if (token !== quickSummonToken) return
        if (!fallbackPayload || fallbackPayload.type === 'empty') return
        pushQuickPayloadToVisibleWindow(fallbackPayload)
      })
      .catch((error) => {
        console.error('quick:file-fallback-collect-failed', error)
      })
  }

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
      let quickPayload = await collectQuickPayloadFast()
      if (!quickPayload || quickPayload.type === 'empty') {
        quickPayload = await collectQuickFilePayloadFallback()
      }
      if (quickPayload && quickPayload.type !== 'empty') {
        const appendResult = await appendPayloadToWindow(windows[0].id, quickPayload, {
          sourceId: 'append-shortcut',
          event: 'quick:append-payload'
        })
        if (quickPayload.contextId) {
          await systemApi.markShortcutPayloadConsumed(quickPayload.contextId)
        }
        return appendResult
      }
    }

    const quickPayload = await collectQuickPayloadFast()
    const token = ++quickSummonToken
    const openResult = await openQuickWindowPreservingMain({
      ...quickPayload,
      triggerMode: 'append-only'
    })

    if (quickPayload.type === 'empty') {
      collectQuickFilePayloadFallback()
        .then((fallbackPayload) => {
          if (token !== quickSummonToken) return
          if (!fallbackPayload || fallbackPayload.type === 'empty') return
          pushQuickPayloadToVisibleWindow({
            ...fallbackPayload,
            triggerMode: 'append-only'
          })
        })
        .catch((error) => {
          console.error('append-shortcut:file-fallback-collect-failed', error)
        })
    }

    return openResult
  } catch (error) {
    console.error('shortcut:append-follow-up-failed', error)
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
      let quickPayload = await collectQuickPayloadFast()
      if (!quickPayload || quickPayload.type === 'empty') {
        quickPayload = await collectQuickFilePayloadFallback()
      }

      if (promptConfig.type === 'img') {
        const imagePayload = normalizeImagePayloadToPngDataUrl(quickPayload)
        if (!imagePayload) {
          await startScreenshotPromptWorkflow({
            code: normalizedPromptKey,
            promptKey: normalizedPromptKey,
            showMode: 'fast',
            triggerMode: 'shortcut',
            source: 'prompt-shortcut-img-helper'
          })
          return
        }
        quickPayload = imagePayload
      }

      await openWindow('fast', {
        code: normalizedPromptKey,
        ...quickPayload,
        promptKey: normalizedPromptKey,
        triggerMode: 'shortcut'
      })
      return
    }

    const quickPayload = await collectQuickPayloadFast()

    if (promptConfig.type === 'img') {
      const imagePayload = normalizeImagePayloadToPngDataUrl(quickPayload)
      if (imagePayload) {
        await openWindow('window', {
          code: normalizedPromptKey,
          ...imagePayload,
          promptKey: normalizedPromptKey,
          triggerMode: 'shortcut'
        })
        return
      }

      await startScreenshotPromptWorkflow({
        code: normalizedPromptKey,
        promptKey: normalizedPromptKey,
        showMode: 'window',
        triggerMode: 'shortcut',
        source: 'prompt-shortcut-img-helper'
      })
      return
    }

    const openResult = await openWindow('window', {
      code: normalizedPromptKey,
      ...quickPayload,
      promptKey: normalizedPromptKey,
      triggerMode: 'shortcut'
    })

    if (!quickPayload || quickPayload.type === 'empty') {
      collectQuickFilePayloadFallback()
        .then(async (fallbackPayload) => {
          if (!fallbackPayload || fallbackPayload.type === 'empty') return
          const delivered = await dispatchShortcutPayloadToWindow(openResult?.id, fallbackPayload, normalizedPromptKey)
          if (!delivered) {
            console.error('shortcut:file-fallback-dispatch-timeout', {
              promptKey: normalizedPromptKey,
              targetWindowId: openResult?.id || null
            })
          }
        })
        .catch((error) => {
          console.error('shortcut:file-fallback-collect-failed', {
            promptKey: normalizedPromptKey,
            error: error?.message || error
          })
        })
    }
  } catch (error) {
    console.error('shortcut:prompt-trigger-failed', { promptKey, error: error?.message || error })
  }
}


function beginAppQuit() {
  if (appQuitStarted) return
  appQuitStarted = true
  markAppQuitting(true)
  clearDesktopShortcuts()
  systemApi.stopClipboardWatcher()
  dataApi.setWindowChannelNotifier(null)
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
        beginAppQuit()
        app.quit()
      }
    }
  ])
}


function createTrayIcon() {
  const trayIcon = nativeImage.createFromPath(icon)

  if (process.platform !== 'darwin') {
    return trayIcon
  }

  const macTrayIcon = trayIcon.resize({
    width: 18,
    height: 18
  })
  macTrayIcon.setTemplateImage(true)
  return macTrayIcon
}

function ensureTray() {
  if (appTray) return appTray
  appTray = new Tray(createTrayIcon())
  appTray.setToolTip('AI Anywhere Desktop')
  appTray.setContextMenu(buildTrayMenu())
  if (process.platform !== 'darwin') {
    appTray.on('click', () => {
      showMainWindow()
    })
  }
  return appTray
}

async function syncDesktopRuntimeFromConfig() {
  const result = await dataApi.getConfig()
  const config = result?.config && typeof result.config === 'object' ? result.config : {}
  const desktop = config.desktop && typeof config.desktop === 'object' ? config.desktop : {}

  syncNativeThemeFromConfig(config)
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
    console.error('desktop-shortcuts:sync-failed', {
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
        console.error('desktop-shortcuts:resync-failed', error)
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
    appendPayloadToWindow,
    startScreenshotPromptWorkflow,
    confirmScreenshotPromptWorkflow,
    cancelScreenshotPromptWorkflow
  })

  systemApi.startClipboardWatcher()
  await syncDesktopRuntimeFromConfig()
  ensureTray()
  await openWindow('main')

  app.on('activate', () => {
    showMainWindow()
  })

  powerMonitor.on('shutdown', () => {
    beginAppQuit()
    app.quit()
  })
})

app.on('before-quit', () => {
  beginAppQuit()
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit()
  }
})
