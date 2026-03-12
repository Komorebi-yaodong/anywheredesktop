import { contextBridge } from 'electron'
import { electronAPI } from '@electron-toolkit/preload'

const defaultWindowType = 'main'
let windowType = defaultWindowType
let windowSenderId = 'main'

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
  })
}

if (process.contextIsolated) {
  try {
    contextBridge.exposeInMainWorld('electron', electronAPI)
    contextBridge.exposeInMainWorld('api', api)
  } catch (error) {
    console.error('[preload:main]', error)
  }
} else {
  window.electron = electronAPI
  window.api = api
}
