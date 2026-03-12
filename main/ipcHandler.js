import { BrowserWindow, ipcMain } from 'electron'
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

export function registerIpcHandlers({
  openWindow,
  showMainWindow,
  hideMainWindow,
  listWindows,
  getWindowByRef,
  getWindowRefByWebContentsId,
  dispatchWindowEvent,
  systemApi,
  dbApi
}) {
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


  handleInvoke('window:list', async (_event, type = '') => {
    return {
      ok: true,
      windows: listWindows(type)
    }
  })

  handleInvoke('window:event:emit', async (event, input = {}) => {
    const sourceId = getWindowRefByWebContentsId(event.sender.id)

    return dispatchWindowEvent(
      {
        sourceId,
        target: input?.target,
        event: input?.event,
        payload: input?.payload
      },
      { getWindowByRef, listWindows }
    )
  })


  const getSenderWindow = (event) => BrowserWindow.fromWebContents(event.sender) || undefined

  handleInvoke('system:clipboard:copyText', async (_event, text = '') => {
    return systemApi.copyText(text)
  })

  handleInvoke('system:clipboard:copyImage', async (_event, input = {}) => {
    return systemApi.copyImage(input)
  })

  handleInvoke('system:clipboard:readText', async () => {
    return systemApi.readClipboardText()
  })

  handleInvoke('system:dialog:open', async (event, options = {}) => {
    return systemApi.showOpenDialog(options, getSenderWindow(event))
  })

  handleInvoke('system:dialog:save', async (event, options = {}) => {
    return systemApi.showSaveDialog(options, getSenderWindow(event))
  })

  handleInvoke('system:shell:openPath', async (_event, targetPath = '') => {
    return systemApi.shellOpenPath(targetPath)
  })

  handleInvoke('system:shell:showItemInFolder', async (_event, targetPath = '') => {
    return systemApi.shellShowItemInFolder(targetPath)
  })

  handleInvoke('system:shell:openExternal', async (_event, url = '') => {
    return systemApi.shellOpenExternal(url)
  })

  handleInvoke('system:desktop:getSources', async (_event, options = {}) => {
    return systemApi.getDesktopSources(options)
  })


  handleInvoke('db:isReady', async () => {
    return dbApi.isDbReady()
  })

  handleInvoke('db:stats', async () => {
    return dbApi.getDbStats()
  })

  handleInvoke('db:get', async (_event, id) => {
    return dbApi.get(id)
  })

  handleInvoke('db:put', async (_event, doc = {}) => {
    return dbApi.put(doc)
  })

  handleInvoke('db:remove', async (_event, id, rev = '') => {
    return dbApi.remove(id, rev)
  })

  handleInvoke('db:allDocs', async (_event, options = {}) => {
    return dbApi.allDocs(options)
  })

  handleInvoke('db:bulkDocs', async (_event, docs = []) => {
    return dbApi.bulkDocs(docs)
  })

  handleInvoke('db:postAttachment', async (_event, input = {}) => {
    return dbApi.postAttachment(input)
  })

  handleInvoke('db:getAttachment', async (_event, input = {}) => {
    return dbApi.getAttachment(input)
  })

  handleInvoke('dbStorage:setItem', async (_event, key, value) => {
    return dbApi.dbStorageSetItem(key, value)
  })

  handleInvoke('dbStorage:getItem', async (_event, key, fallback = null) => {
    return dbApi.dbStorageGetItem(key, fallback)
  })

  handleInvoke('dbStorage:removeItem', async (_event, key) => {
    return dbApi.dbStorageRemoveItem(key)
  })

  handleInvoke('dbStorage:listKeys', async () => {
    return dbApi.dbStorageListKeys()
  })
}
