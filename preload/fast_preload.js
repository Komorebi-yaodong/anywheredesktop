import { contextBridge } from 'electron'
import { electronAPI } from '@electron-toolkit/preload'

const defaultWindowType = 'fast_window'
let windowType = defaultWindowType
let windowSenderId = 'fast'

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
  getDesktopSources: (options) => electronAPI.ipcRenderer.invoke('system:desktop:getSources', options),
  dbIsReady: () => electronAPI.ipcRenderer.invoke('db:isReady'),
  dbStats: () => electronAPI.ipcRenderer.invoke('db:stats'),
  dbGet: (id) => electronAPI.ipcRenderer.invoke('db:get', id),
  dbPut: (doc) => electronAPI.ipcRenderer.invoke('db:put', doc),
  dbRemove: (id, rev = '') => electronAPI.ipcRenderer.invoke('db:remove', id, rev),
  dbAllDocs: (options) => electronAPI.ipcRenderer.invoke('db:allDocs', options),
  dbBulkDocs: (docs) => electronAPI.ipcRenderer.invoke('db:bulkDocs', docs),
  dbPostAttachment: (input) => electronAPI.ipcRenderer.invoke('db:postAttachment', input),
  dbGetAttachment: (input) => electronAPI.ipcRenderer.invoke('db:getAttachment', input),
  dbStorageSetItem: (key, value) => electronAPI.ipcRenderer.invoke('dbStorage:setItem', key, value),
  dbStorageGetItem: (key, fallback = null) =>
    electronAPI.ipcRenderer.invoke('dbStorage:getItem', key, fallback),
  dbStorageRemoveItem: (key) => electronAPI.ipcRenderer.invoke('dbStorage:removeItem', key),
  dbStorageListKeys: () => electronAPI.ipcRenderer.invoke('dbStorage:listKeys')
}

if (process.contextIsolated) {
  try {
    contextBridge.exposeInMainWorld('electron', electronAPI)
    contextBridge.exposeInMainWorld('api', api)
  } catch (error) {
    console.error('[preload:fast_window]', error)
  }
} else {
  window.electron = electronAPI
  window.api = api
}
