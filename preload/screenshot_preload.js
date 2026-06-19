import { contextBridge } from 'electron'
import { electronAPI } from '@electron-toolkit/preload'

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
})

const api = {
  appWindowType: 'screenshot',
  onWindowInit: (callback) => {
    if (typeof callback !== 'function') return
    if (latestInitMessage) callback(latestInitMessage)
    electronAPI.ipcRenderer.on('window:init', (_event, data) => callback(data))
  },
  confirmScreenshot: (input = {}) => invokeOrThrow('screenshot:confirm', input),
  cancelScreenshot: (input = {}) => invokeOrThrow('screenshot:cancel', input)
}

if (process.contextIsolated) {
  try {
    contextBridge.exposeInMainWorld('electron', electronAPI)
    contextBridge.exposeInMainWorld('api', api)
  } catch (error) {
    console.error('[preload:screenshot]', error)
  }
} else {
  window.electron = electronAPI
  window.api = api
}
