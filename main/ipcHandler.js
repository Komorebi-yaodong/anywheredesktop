import path from 'node:path'
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
  dbApi,
  dataApi,
  fileApi,
  webdavApi,
  chatApi,
  mcpApi,
  skillApi,
  minimizeWindow,
  maximizeOrRestoreWindow,
  closeWindow,
  toggleAlwaysOnTop
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


  handleInvoke('window:minimize', async (event, input = {}) => {
    const fallbackRef = getWindowRefByWebContentsId(event.sender.id)
    const windowRef =
      typeof input === 'string'
        ? input
        : typeof input?.windowRef === 'string' && input.windowRef
          ? input.windowRef
          : fallbackRef

    return minimizeWindow(windowRef)
  })

  handleInvoke('window:maximizeOrRestore', async (event, input = {}) => {
    const fallbackRef = getWindowRefByWebContentsId(event.sender.id)
    const windowRef =
      typeof input === 'string'
        ? input
        : typeof input?.windowRef === 'string' && input.windowRef
          ? input.windowRef
          : fallbackRef

    return maximizeOrRestoreWindow(windowRef)
  })

  handleInvoke('window:close', async (event, input = {}) => {
    const fallbackRef = getWindowRefByWebContentsId(event.sender.id)
    const windowRef =
      typeof input === 'string'
        ? input
        : typeof input?.windowRef === 'string' && input.windowRef
          ? input.windowRef
          : fallbackRef

    return closeWindow(windowRef)
  })

  handleInvoke('window:toggleAlwaysOnTop', async (event, input = {}) => {
    const fallbackRef = getWindowRefByWebContentsId(event.sender.id)
    const windowRef =
      typeof input === 'string'
        ? input
        : typeof input?.windowRef === 'string' && input.windowRef
          ? input.windowRef
          : fallbackRef

    const nextState =
      typeof input === 'object' && input !== null && typeof input.alwaysOnTop === 'boolean'
        ? input.alwaysOnTop
        : undefined

    return toggleAlwaysOnTop(windowRef, nextState)
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


  handleInvoke('data:getConfig', async () => {
    return dataApi.getConfig()
  })

  handleInvoke('data:saveSetting', async (_event, keyPath, value) => {
    return dataApi.saveSetting(keyPath, value)
  })

  handleInvoke('data:updateConfig', async (_event, nextConfig = {}) => {
    return dataApi.updateConfig(nextConfig)
  })

  handleInvoke('data:updateConfigWithoutFeatures', async (_event, nextConfig = {}) => {
    return dataApi.updateConfigWithoutFeatures(nextConfig)
  })

  handleInvoke('data:exportMemoryData', async () => {
    return dataApi.exportMemoryData()
  })

  handleInvoke('data:importMemoryData', async (_event, memories = []) => {
    return dataApi.importMemoryData(memories)
  })


  handleInvoke('data:coderedirect', async (event, label = '', payload = null) => {
    const sourceId = getWindowRefByWebContentsId(event.sender.id)
    const openResult = openWindow('window')
    const target = typeof openResult?.id === 'string' && openResult.id ? openResult.id : 'type:window'

    const dispatchResult = dispatchWindowEvent(
      {
        sourceId,
        target,
        event: 'coderedirect',
        payload: {
          label,
          payload
        }
      },
      { getWindowByRef, listWindows }
    )

    return {
      success: Boolean(dispatchResult?.ok),
      target,
      event: 'coderedirect',
      result: dispatchResult
    }
  })

  handleInvoke('data:runTaskNow', async (event, taskId = '') => {
    const normalizedTaskId = typeof taskId === 'string' ? taskId.trim() : ''
    if (!normalizedTaskId) {
      return {
        success: false,
        reason: 'task_id_required'
      }
    }

    const configResult = await dataApi.getConfig()
    const fullConfig =
      configResult?.config && typeof configResult.config === 'object' ? configResult.config : {}
    const tasks = fullConfig?.tasks && typeof fullConfig.tasks === 'object' ? fullConfig.tasks : {}
    const task = tasks[normalizedTaskId]

    if (!task || typeof task !== 'object') {
      return {
        success: false,
        reason: 'task_not_found',
        taskId: normalizedTaskId
      }
    }

    const promptKey = typeof task.promptKey === 'string' && task.promptKey ? task.promptKey : '__DEFAULT__'
    const tempPromptConfig =
      promptKey === '__DEFAULT__'
        ? {
            type: 'general',
            prompt: '',
            showMode: 'window',
            model: fullConfig.defaultTaskModel || '',
            stream: true,
            isAlwaysOnTop: fullConfig.isAlwaysOnTop_global ?? true,
            autoCloseOnBlur: fullConfig.autoCloseOnBlur_global ?? true,
            window_width: 580,
            window_height: 740,
            icon: ''
          }
        : null

    const openResult = openWindow('window')
    const target = typeof openResult?.id === 'string' && openResult.id ? openResult.id : 'type:window'
    const sourceId = getWindowRefByWebContentsId(event.sender.id)

    const dispatchResult = dispatchWindowEvent(
      {
        sourceId,
        target,
        event: 'task:run-now',
        payload: {
          os: process.platform === 'darwin' ? 'macos' : process.platform === 'win32' ? 'win' : 'linux',
          code: promptKey,
          type: 'task',
          payload: typeof task.description === 'string' ? task.description : '',
          taskConfig: {
            id: normalizedTaskId,
            ...task
          },
          tempPromptConfig
        }
      },
      { getWindowByRef, listWindows }
    )

    return {
      success: Boolean(dispatchResult?.ok),
      taskId: normalizedTaskId,
      target,
      event: 'task:run-now',
      result: dispatchResult
    }
  })

  handleInvoke('chat:getRandomItem', async (_event, list = '') => {
    return chatApi.getRandomItem(list)
  })


  handleInvoke('chat:createCompletion', async (_event, params = {}) => {
    const normalizedParams = {
      ...params,
      // 先走非流式最小闭环，避免将 Stream 对象跨 IPC 传输
      stream: params?.stream === undefined ? false : Boolean(params.stream)
    }

    return chatApi.createChatCompletion(normalizedParams)
  })


  handleInvoke('mcp:getToolCache', async () => {
    const cache = await dataApi.getMcpToolCache()
    return {
      success: true,
      cache
    }
  })

  handleInvoke('mcp:saveToolCache', async (_event, serverId, tools = []) => {
    return dataApi.saveMcpToolCache(serverId, tools)
  })

  handleInvoke('mcp:initializeClient', async (_event, activeServerConfigs = {}) => {
    let cache = {}

    try {
      cache = await dataApi.getMcpToolCache()
    } catch (error) {
      console.error('[IPC] Failed to read MCP cache, fallback to empty cache:', error)
    }

    return mcpApi.initializeMcpClient(activeServerConfigs, cache, dataApi.saveMcpToolCache)
  })

  handleInvoke('mcp:testConnection', async (_event, serverConfig = {}) => {
    const normalizedConfig = {
      transport: serverConfig.type,
      command: serverConfig.command,
      args: serverConfig.args,
      url: serverConfig.baseUrl,
      env: serverConfig.env,
      headers: serverConfig.headers,
      type: serverConfig.type,
      isPersistent: Boolean(serverConfig.isPersistent)
    }

    const rawTools = await mcpApi.connectAndFetchTools(serverConfig.id, normalizedConfig)
    await dataApi.saveMcpToolCache(serverConfig.id, rawTools)

    return {
      success: true,
      tools: rawTools
    }
  })

  handleInvoke('mcp:testInvokeTool', async (_event, serverConfig = {}, toolName = '', args = {}) => {
    const normalizedConfig = {
      transport: serverConfig.type,
      command: serverConfig.command,
      args: serverConfig.args,
      url: serverConfig.baseUrl,
      env: serverConfig.env,
      headers: serverConfig.headers,
      type: serverConfig.type
    }

    const result = await mcpApi.connectAndInvokeTool(serverConfig.id, normalizedConfig, toolName, args)
    return {
      success: true,
      result
    }
  })

  handleInvoke('mcp:invokeTool', async (_event, toolName = '', toolArgs = {}, context = null) => {
    return mcpApi.invokeMcpTool(toolName, toolArgs, null, context)
  })

  handleInvoke('mcp:closeClient', async () => {
    return mcpApi.closeMcpClient()
  })


  handleInvoke('skill:list', async (_event, skillRootPath = '') => {
    return skillApi.listSkills(skillRootPath)
  })

  handleInvoke('skill:getDetails', async (_event, skillRootPath = '', skillId = '') => {
    return skillApi.getSkillDetails(skillRootPath, skillId)
  })

  handleInvoke('skill:save', async (_event, skillRootPath = '', skillId = '', content = '') => {
    const success = skillApi.saveSkill(skillRootPath, skillId, content)
    return { success }
  })

  handleInvoke('skill:delete', async (_event, skillRootPath = '', skillId = '') => {
    const success = skillApi.deleteSkill(skillRootPath, skillId)
    return { success }
  })

  handleInvoke('skill:exportPackage', async (_event, skillRootPath = '', skillId = '', outputDir = '') => {
    const outputPath = await skillApi.exportSkillToPackage(skillRootPath, skillId, outputDir)
    return {
      success: true,
      outputPath
    }
  })

  handleInvoke('skill:extractPackage', async (_event, filePath = '') => {
    const extractedPath = await skillApi.extractSkillPackage(filePath)
    return {
      success: true,
      extractedPath
    }
  })

  handleInvoke('skill:getToolDefinition', async (_event, skillRootPath = '', enabledSkillNames = []) => {
    const allSkills = skillApi.listSkills(skillRootPath)
    const activeSkills = allSkills.filter((skill) => enabledSkillNames.includes(skill.name))

    if (activeSkills.length === 0) {
      return null
    }

    return skillApi.generateSkillToolDefinition(activeSkills, skillRootPath)
  })

  handleInvoke(
    'skill:resolveInvocation',
    async (_event, skillRootPath = '', skillName = '', toolArgsObj = {}, globalContext = null) => {
      const result = skillApi.resolveSkillInvocation(skillRootPath, skillName, toolArgsObj)

      if (result && typeof result === 'object' && result.__isForkRequest && result.subAgentArgs) {
        if (!globalContext) {
          return JSON.stringify(
            [
              {
                type: 'text',
                text: 'Error: Sub-Agent skill requires execution context (API Key, etc).'
              }
            ],
            null,
            2
          )
        }

        const subAgentResult = await mcpApi.invokeMcpTool('sub_agent', result.subAgentArgs, null, globalContext)
        return subAgentResult
      }

      return JSON.stringify(
        [
          {
            type: 'text',
            text: result
          }
        ],
        null,
        2
      )
    }
  )

  handleInvoke('skill:pathJoin', async (_event, ...args) => {
    return path.join(...args)
  })

  handleInvoke('file:handleFilePath', async (_event, filePath = '') => {
    return fileApi.handleFilePath(filePath)
  })

  handleInvoke('file:sendfileDirect', async (_event, filePathList = []) => {
    return fileApi.sendfileDirect(filePathList)
  })

  handleInvoke('file:saveFile', async (_event, options = {}) => {
    return fileApi.saveFile(options)
  })

  handleInvoke('file:selectDirectory', async () => {
    return fileApi.selectDirectory()
  })

  handleInvoke('file:listJsonFiles', async (_event, dirPath = '') => {
    return fileApi.listJsonFiles(dirPath)
  })

  handleInvoke('file:readLocalFile', async (_event, filePath = '', options = {}) => {
    return fileApi.readLocalFile(filePath, options)
  })

  handleInvoke('file:renameLocalFile', async (_event, oldPath = '', newPath = '') => {
    return fileApi.renameLocalFile(oldPath, newPath)
  })

  handleInvoke('file:deleteLocalFile', async (_event, filePath = '') => {
    return fileApi.deleteLocalFile(filePath)
  })

  handleInvoke('file:writeLocalFile', async (_event, filePath = '', content = '', options = {}) => {
    return fileApi.writeLocalFile(filePath, content, options)
  })

  handleInvoke('file:setFileMtime', async (_event, filePath = '', mtime) => {
    return fileApi.setFileMtime(filePath, mtime)
  })

  handleInvoke('file:isFileTypeSupported', async (_event, fileName = '') => {
    return fileApi.isFileTypeSupported(fileName)
  })

  handleInvoke('file:parseFileObject', async (_event, fileObj = {}) => {
    return fileApi.parseFileObject(fileObj)
  })

  handleInvoke('file:copyLocalPath', async (_event, srcPath = '', destPath = '') => {
    return fileApi.copyLocalPath(srcPath, destPath)
  })


  handleInvoke('webdav:listBackups', async (_event, input = {}) => {
    return webdavApi.listBackups(input)
  })

  handleInvoke('webdav:writeBackup', async (_event, input = {}) => {
    return webdavApi.writeBackup(input)
  })

  handleInvoke('webdav:readBackup', async (_event, input = {}) => {
    return webdavApi.readBackup(input)
  })


  handleInvoke('webdav:moveFile', async (_event, input = {}) => {
    return webdavApi.moveFile(input)
  })

  handleInvoke('webdav:deleteBackup', async (_event, input = {}) => {
    return webdavApi.deleteBackup(input)
  })

  handleInvoke('webdav:deleteBackups', async (_event, input = {}) => {
    return webdavApi.deleteBackups(input)
  })
}
