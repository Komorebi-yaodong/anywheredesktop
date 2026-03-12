import { contextBridge } from 'electron'
import { electronAPI } from '@electron-toolkit/preload'

const defaultWindowType = 'window'
let windowType = defaultWindowType
let windowSenderId = null

electronAPI.ipcRenderer.on('window:init', (_event, data = {}) => {
  if (typeof data.windowType === 'string' && data.windowType) {
    windowType = data.windowType
  }

  if (typeof data.senderId === 'string' && data.senderId) {
    windowSenderId = data.senderId
  }
})

const api = {
  appWindowType: defaultWindowType,
  openWindow: (type) => electronAPI.ipcRenderer.invoke('window:open', type),
  showMainWindow: () => electronAPI.ipcRenderer.invoke('window:showMain'),
  hideMainWindow: () => electronAPI.ipcRenderer.invoke('window:hideMain'),
  listWindows: (type = '') => electronAPI.ipcRenderer.invoke('window:list', type),
  emitWindowEvent: (input) => electronAPI.ipcRenderer.invoke('window:event:emit', input),
  onWindowEvent: (callback) => {
    if (typeof callback !== 'function') return
    electronAPI.ipcRenderer.on('window:event-bus', (_event, data) => callback(data))
  },
  onWindowInit: (callback) => {
    if (typeof callback !== 'function') return
    electronAPI.ipcRenderer.on('window:init', (_event, data) => callback(data))
  },
  getWindowContext: () => ({
    appWindowType: windowType,
    senderId: windowSenderId
  }),
  copyText: (text) => electronAPI.ipcRenderer.invoke('system:clipboard:copyText', text),
  copyImage: (input) => electronAPI.ipcRenderer.invoke('system:clipboard:copyImage', input),
  readClipboardText: () => electronAPI.ipcRenderer.invoke('system:clipboard:readText'),
  showOpenDialog: (options) => electronAPI.ipcRenderer.invoke('system:dialog:open', options),
  showSaveDialog: (options) => electronAPI.ipcRenderer.invoke('system:dialog:save', options),
  shellOpenPath: (targetPath) => electronAPI.ipcRenderer.invoke('system:shell:openPath', targetPath),
  shellShowItemInFolder: (targetPath) =>
    electronAPI.ipcRenderer.invoke('system:shell:showItemInFolder', targetPath),
  shellOpenExternal: (url) => electronAPI.ipcRenderer.invoke('system:shell:openExternal', url),
  getDesktopSources: (options) => electronAPI.ipcRenderer.invoke('system:desktop:getSources', options)
}

if (process.contextIsolated) {
  try {
    contextBridge.exposeInMainWorld('electron', electronAPI)
    contextBridge.exposeInMainWorld('api', api)
  } catch (error) {
    console.error('[preload:window]', error)
  }
} else {
  window.electron = electronAPI
  window.api = api
}
