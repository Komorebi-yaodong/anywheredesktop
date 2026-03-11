import { contextBridge } from 'electron'
import { electronAPI } from '@electron-toolkit/preload'

const api = {
  appWindowType: 'fast_window',
  openWindow: (type) => electronAPI.ipcRenderer.invoke('window:open', type)
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
