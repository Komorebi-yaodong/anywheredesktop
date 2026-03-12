import { app, BrowserWindow } from 'electron'
import { electronApp, optimizer } from '@electron-toolkit/utils'
import { registerIpcHandlers } from './ipcHandler.js'
import {
  openWindow,
  showMainWindow,
  hideMainWindow,
  listWindows,
  getWindowByRef,
  getWindowRefByWebContentsId
} from './windowManager.js'
import { dispatchWindowEvent } from './eventBus.js'

import * as systemApi from './core/system.js'

app.whenReady().then(() => {
  electronApp.setAppUserModelId('com.anywhere.desktop')

  app.on('browser-window-created', (_, window) => {
    optimizer.watchWindowShortcuts(window)
  })

  registerIpcHandlers({
    openWindow,
    showMainWindow,
    hideMainWindow,
    listWindows,
    getWindowByRef,
    getWindowRefByWebContentsId,
    dispatchWindowEvent,
    systemApi
  })
  openWindow('main')

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) openWindow('main')
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit()
  }
})
