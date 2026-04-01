import { contextBridge, webUtils } from 'electron'
import { electronAPI } from '@electron-toolkit/preload'

const defaultWindowType = 'fast_input'
const FAST_INPUT_EVENT_CHANNEL = 'fast-input:event'
let windowType = defaultWindowType
let windowSenderId = 'fast'
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
  closeWindow: (windowRef = '') => {
    electronAPI.ipcRenderer.send('window:close', { windowRef })
    return Promise.resolve({ ok: true, action: 'close', windowRef: windowRef || null, dispatched: true })
  },
  getWindowContext: () => ({
    appWindowType: windowType,
    senderId: windowSenderId
  }),
  onWindowInit: (callback) => {
    if (typeof callback !== 'function') return
    if (latestInitMessage) callback(latestInitMessage)
    electronAPI.ipcRenderer.on('window:init', (_event, data) => callback(data))
  },
  onFastInputEvent: (callback) => {
    if (typeof callback !== 'function') return
    electronAPI.ipcRenderer.on(FAST_INPUT_EVENT_CHANNEL, (_event, data) => callback(data))
  },
  emitWindowEvent: (input) => invokeOrThrow('window:event:emit', input),
  copyText: (text) => invokeOrThrow('system:clipboard:copyText', text),
  pasteTextToActiveInput: (text) => invokeOrThrow('system:input:pasteText', text),
  readClipboardText: () => invokeOrThrow('system:clipboard:readText'),
  getConfig: () => invokeOrThrow('data:getConfig'),
  shellOpenExternal: (url) => invokeOrThrow('system:shell:openExternal', url),
  getDroppedFilePath: (file) => {
    try {
      return webUtils.getPathForFile(file) || ''
    } catch {
      return ''
    }
  }
}

if (process.contextIsolated) {
  try {
    contextBridge.exposeInMainWorld('electron', electronAPI)
    contextBridge.exposeInMainWorld('api', api)
  } catch (error) {
    console.error('[preload:fast_input]', error)
  }
} else {
  window.electron = electronAPI
  window.api = api
}
