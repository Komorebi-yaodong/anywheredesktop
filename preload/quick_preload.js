import { contextBridge, webUtils } from 'electron'
import path from 'node:path'
import { electronAPI } from '@electron-toolkit/preload'

const defaultWindowType = 'quick'
let windowType = defaultWindowType
let windowSenderId = 'quick'
let latestInitMessage = null

function invokeOrThrow(channel, ...args) {
  return electronAPI.ipcRenderer.invoke(channel, ...args).then((result) => {
    if (result && typeof result === 'object' && result.ok === false) {
      const message =
        (result.error && typeof result.error === 'object' && result.error.message) ||
        (typeof result.error === 'string' ? result.error : '') ||
        `IPC invoke failed: ${channel}`
      throw new Error(message)
    }
    return result
  })
}

electronAPI.ipcRenderer.on('window:init', (_event, data = {}) => {
  latestInitMessage = data

  if (typeof data.windowType === 'string' && data.windowType) {
    windowType = data.windowType
  }

  if (typeof data.senderId === 'string' && data.senderId) {
    windowSenderId = data.senderId
  }
})

const api = {
  appWindowType: defaultWindowType,
  openWindow: (type, payload = null) => electronAPI.ipcRenderer.invoke('window:open', type, payload),
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
    if (latestInitMessage) callback(latestInitMessage)
    electronAPI.ipcRenderer.on('window:init', (_event, data) => callback(data))
  },
  onConfigUpdated: (callback) => {
    if (typeof callback !== 'function') return
    electronAPI.ipcRenderer.on('window:configUpdated', (_event, newConfig) => callback(newConfig))
    electronAPI.ipcRenderer.on('config-updated', (_event, newConfig) => callback(newConfig))
  },
  getWindowContext: () => ({
    appWindowType: windowType,
    senderId: windowSenderId
  }),
  getDroppedFilePath: (file) => {
    try {
      const resolvedPath = webUtils.getPathForFile(file)
      return resolvedPath || ''
    } catch {
      return ''
    }
  },
  readClipboardText: () => electronAPI.ipcRenderer.invoke('system:clipboard:readText'),
  readClipboardPayload: () => electronAPI.ipcRenderer.invoke('system:clipboard:readPayload'),
  captureSelectionPayload: () => electronAPI.ipcRenderer.invoke('system:clipboard:captureSelection'),
  getConfig: () => electronAPI.ipcRenderer.invoke('data:getConfig'),
  isFileTypeSupported: (fileName) => invokeOrThrow('file:isFileTypeSupported', fileName),
  probeFilePathSupport: (filePath) => invokeOrThrow('file:probePathSupport', filePath),
  readLocalFile: (filePath, options = {}) => invokeOrThrow('file:readLocalFile', filePath, options),
  closeWindow: (windowRef = '') => {
    electronAPI.ipcRenderer.send('window:close', { windowRef })
    return Promise.resolve({ ok: true, action: 'close', windowRef: windowRef || null, dispatched: true })
  },
  pathJoin: (...args) => path.join(...args)
}

if (process.contextIsolated) {
  try {
    contextBridge.exposeInMainWorld('electron', electronAPI)
    contextBridge.exposeInMainWorld('api', api)
  } catch (error) {
    console.error('[preload:quick]', error)
  }
} else {
  window.electron = electronAPI
  window.api = api
}
