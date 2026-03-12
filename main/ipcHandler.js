import { ipcMain } from 'electron'
import { serializeError, serializeIpcPayload } from './dataConverter.js'

function handleInvoke(channel, handler, options = {}) {
  ipcMain.handle(channel, async (event, ...args) => {
    try {
      const result = await handler(event, ...args)
      return await serializeIpcPayload(result, options)
    } catch (error) {
      return {
        ok: false,
        error: serializeError(error)
      }
    }
  })
}

export function registerIpcHandlers({ openWindow, showMainWindow, hideMainWindow }) {
  ipcMain.on('ping', () => console.log('pong'))

  handleInvoke('window:open', async (_event, type = 'main') => {
    return openWindow(type)
  })


  handleInvoke('window:showMain', async () => {
    return showMainWindow()
  })

  handleInvoke('window:hideMain', async () => {
    return hideMainWindow()
  })
}
