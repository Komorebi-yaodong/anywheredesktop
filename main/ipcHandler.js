import path from 'node:path'
import { BrowserWindow, ipcMain } from 'electron'
import { serializeError, serializeIpcPayload } from './dataConverter.js'

const liveSignalControllers = new Map()

const debugIpcLog = () => {}
const debugIpcError = () => {}


function getLiveSignalKey(senderId, token = '') {
  return `${senderId}:${token}`
}


function handleInvoke(channel, handler, options = {}) {
  ipcMain.handle(channel, async (event, ...args) => {
    const senderRef = (() => {
      try {
        return BrowserWindow.fromWebContents(event.sender)?.id || event.sender?.id || null
      } catch {
        return event.sender?.id || null
      }
    })()

    debugIpcLog('invoke:before', { channel, senderRef, args })

    try {
      const result = await handler(event, ...args)
      const serialized = await serializeIpcPayload(result, options)
      debugIpcLog('invoke:after', { channel, senderRef, result: serialized })
      return serialized
    } catch (error) {
      const serializedError = serializeError(error)
      debugIpcError('invoke:error', { channel, senderRef, args, error: serializedError })
      return {
        ok: false,
        error: serializedError
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
  toggleAlwaysOnTop,
  handleFastInputWindowEvent,
  appendPayloadToWindow
}) {
  ipcMain.on('ping', () => {})

  ipcMain.on('window:signal-abort', (event, token = '') => {
    const key = getLiveSignalKey(event.sender.id, typeof token === 'string' ? token : '')
    const controller = liveSignalControllers.get(key)
    if (controller) {
      controller.abort()
      liveSignalControllers.delete(key)
    }
  })



  handleInvoke('window:open', async (_event, type = 'main', payload = null) => {
    return openWindow(type, payload)
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

    if (input?.event === 'fast-input:cancel-request') {
      const fallbackTarget = typeof input?.target === 'string' && input.target ? input.target : sourceId
      return handleFastInputWindowEvent(fallbackTarget, input?.event, input?.payload)
    }

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

  handleInvoke('window:appendToWindow', async (event, input = {}) => {
    const sourceId = getWindowRefByWebContentsId(event.sender.id)
    const target = typeof input?.target === 'string' ? input.target.trim() : ''
    const payload = input?.payload && typeof input.payload === 'object' ? input.payload : null
    const eventName = typeof input?.event === 'string' && input.event ? input.event : 'quick:append-payload'

    return appendPayloadToWindow(target, payload, {
      sourceId: typeof input?.sourceId === 'string' && input.sourceId ? input.sourceId : sourceId,
      event: eventName
    })
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

  ipcMain.on('window:close', (event, input = {}) => {
    const fallbackRef = getWindowRefByWebContentsId(event.sender.id)
    const windowRef =
      typeof input === 'string'
        ? input
        : typeof input?.windowRef === 'string' && input.windowRef
          ? input.windowRef
          : fallbackRef

    debugIpcLog('send:before', { channel: 'window:close', senderRef: event.sender?.id || null, args: [input], windowRef })

    try {
      const result = closeWindow(windowRef)
      debugIpcLog('send:after', { channel: 'window:close', senderRef: event.sender?.id || null, result })
    } catch (error) {
      const serializedError = serializeError(error)
      debugIpcError('send:error', {
        channel: 'window:close',
        senderRef: event.sender?.id || null,
        args: [input],
        error: serializedError
      })
    }
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

  handleInvoke('system:input:pasteText', async (_event, text = '') => {
    return systemApi.pasteTextToActiveInput(text)
  })

  handleInvoke('system:clipboard:copyText', async (_event, text = '') => {
    return systemApi.copyText(text)
  })

  handleInvoke('system:clipboard:copyImage', async (_event, input = {}) => {
    return systemApi.copyImage(input)
  })

  handleInvoke('system:clipboard:readText', async () => {
    return systemApi.readClipboardText()
  })


  handleInvoke('system:clipboard:readPayload', async () => {
    return systemApi.readClipboardPayload()
  })


  handleInvoke('system:clipboard:captureSelection', async () => {
    return systemApi.captureSelectionPayload()
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


  
  handleInvoke('data:getUser', async () => {
    return dataApi.getUser()
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

  handleInvoke('data:restoreImportedConfig', async (_event, importedConfig = {}) => {
    return dataApi.restoreImportedConfig(importedConfig)
  })

  handleInvoke('data:exportMemoryData', async () => {
    return dataApi.exportMemoryData()
  })

  handleInvoke('data:importMemoryData', async (_event, memories = []) => {
    return dataApi.importMemoryData(memories)
  })


  
  handleInvoke('data:savePromptWindowSettings', async (_event, promptKey = '', settings = {}) => {
    return dataApi.savePromptWindowSettings(promptKey, settings)
  })

  handleInvoke('data:addTaskHistory', async (_event, taskId = '', logEntry = null) => {
    return dataApi.addTaskHistory(taskId, logEntry)
  })

  handleInvoke('data:getCachedBackgroundImage', async (_event, url = '') => {
    return dataApi.getCachedBackgroundImage(url)
  })

  handleInvoke('data:cacheBackgroundImage', async (_event, url = '') => {
    return dataApi.cacheBackgroundImage(url)
  })

handleInvoke('data:coderedirect', async (event, label = '', payload = null) => {
    const sourceId = getWindowRefByWebContentsId(event.sender.id)
    const openResult = await openWindow('window')
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

  handleInvoke('data:runTaskNow', async (_event, taskId = '') => {
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
            model: dataApi.resolveDefaultAssistantModel(fullConfig),
            stream: true,
            isAlwaysOnTop: fullConfig.isAlwaysOnTop_global ?? true,
            autoCloseOnBlur: fullConfig.autoCloseOnBlur_global ?? true,
            window_width: 580,
            window_height: 740,
            icon: ''
          }
        : null

    const openPayload = {
      code: promptKey,
      type: 'task',
      payload: typeof task.description === 'string' ? task.description : '',
      taskConfig: {
        id: normalizedTaskId,
        ...task
      },
      tempPromptConfig
    }

    const openResult = await openWindow('window', openPayload)

    return {
      success: Boolean(openResult?.ok),
      taskId: normalizedTaskId,
      target: openResult?.id || null,
      event: 'window:open',
      result: openResult
    }
  })

  handleInvoke('chat:getRandomItem', async (_event, list = '') => {
    return chatApi.getRandomItem(list)
  })


  handleInvoke('chat:listProviderModels', async (_event, input = {}) => {
    return chatApi.listProviderModels(input)
  })



  handleInvoke('chat:createCompletion', async (_event, params = {}) => {
    return chatApi.createChatCompletion(params)
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
    const sanitizedTools = (Array.isArray(rawTools) ? rawTools : []).map((tool) => ({
      name: tool?.name || '',
      description: tool?.description || '',
      inputSchema: tool?.inputSchema || tool?.schema || {},
      enabled: tool?.enabled !== false
    }))
    await dataApi.saveMcpToolCache(serverConfig.id, sanitizedTools)

    return {
      success: true,
      tools: sanitizedTools
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
      result: JSON.parse(JSON.stringify(result))
    }
  })

  handleInvoke('mcp:invokeTool', async (_event, toolName = '', toolArgs = {}, context = null) => {
    return mcpApi.invokeMcpTool(toolName, toolArgs, null, context)
  })

  
  handleInvoke('mcp:invokeToolLive', async (event, toolName = '', toolArgs = {}, meta = {}) => {
    const signalToken = typeof meta?.signalToken === 'string' ? meta.signalToken : ''
    const callbackToken = typeof meta?.callbackToken === 'string' ? meta.callbackToken : ''
    const context = meta?.context && typeof meta.context === 'object' ? meta.context : null
    const controller = new AbortController()
    const signalKey = signalToken ? getLiveSignalKey(event.sender.id, signalToken) : ''

    if (signalKey) {
      liveSignalControllers.set(signalKey, controller)
    }
    if (meta?.aborted) {
      controller.abort()
    }

    const nextContext = context ? { ...context } : null
    if (nextContext && callbackToken) {
      nextContext.onUpdate = (payload) => {
        try {
          event.sender.send('window:callback', {
            token: callbackToken,
            payload: typeof payload === 'string' ? payload : JSON.parse(JSON.stringify(payload))
          })
        } catch {
          // ignore callback notify failure
        }
      }
    }

    try {
      return await mcpApi.invokeMcpTool(toolName, toolArgs, controller.signal, nextContext)
    } catch (error) {
      if (error?.name === 'AbortError') {
        return {
          ok: false,
          error: serializeError(error)
        }
      }
      throw error
    } finally {
      if (signalKey) {
        liveSignalControllers.delete(signalKey)
      }
    }
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
    const result = skillApi.saveSkill(skillRootPath, skillId, content)
    dataApi.notifySkillsUpdated()
    return result
  })

  handleInvoke('skill:delete', async (_event, skillRootPath = '', skillId = '') => {
    const result = skillApi.deleteSkill(skillRootPath, skillId)
    dataApi.notifySkillsUpdated()
    return result
  })

  handleInvoke('skill:exportPackage', async (_event, skillRootPath = '', skillId = '', outputDir = '') => {
    return skillApi.exportSkillToPackage(skillRootPath, skillId, outputDir)
  })

  handleInvoke('skill:extractPackage', async (_event, filePath = '') => {
    return skillApi.extractSkillPackage(filePath)
  })

  handleInvoke('skill:getToolDefinition', async (_event, skillRootPath = '', enabledSkillNames = []) => {
    const allSkills = skillApi.listSkills(skillRootPath)
    const normalizedEnabledSkillNames = Array.isArray(enabledSkillNames)
      ? enabledSkillNames.map((item) => String(item || '').trim()).filter(Boolean)
      : []
    const activeSkills = allSkills.filter(
      (skill) =>
        normalizedEnabledSkillNames.includes(String(skill?.name || '').trim()) ||
        normalizedEnabledSkillNames.includes(String(skill?.id || '').trim())
    )

    if (activeSkills.length === 0) {
      return null
    }

    return skillApi.generateSkillToolDefinition(activeSkills, skillRootPath)
  })

  handleInvoke(
    'skill:resolveInvocation',
    async (_event, skillRootPath = '', skillName = '', toolArgsObj = {}, globalContext = null) => {
      const configResult = await dataApi.getConfig()
      const currentConfig = configResult?.config && typeof configResult.config === 'object' ? configResult.config : {}
      const currentMcpServers =
        currentConfig?.mcpServers && typeof currentConfig.mcpServers === 'object' ? currentConfig.mcpServers : {}

      const result = await skillApi.resolveSkillInvocation(skillRootPath, skillName, toolArgsObj, {
        mcpServers: currentMcpServers
      })

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

  
  handleInvoke('skill:resolveInvocationLive', async (event, skillRootPath = '', skillName = '', toolArgsObj = {}, meta = {}) => {
    const signalToken = typeof meta?.signalToken === 'string' ? meta.signalToken : ''
    const callbackToken = typeof meta?.callbackToken === 'string' ? meta.callbackToken : ''
    const context = meta?.context && typeof meta.context === 'object' ? meta.context : null
    const controller = new AbortController()
    const signalKey = signalToken ? getLiveSignalKey(event.sender.id, signalToken) : ''

    if (signalKey) {
      liveSignalControllers.set(signalKey, controller)
    }
    if (meta?.aborted) {
      controller.abort()
    }

    const configResult = await dataApi.getConfig()
    const currentConfig = configResult?.config && typeof configResult.config === 'object' ? configResult.config : {}
    const currentMcpServers = currentConfig?.mcpServers && typeof currentConfig.mcpServers === 'object' ? currentConfig.mcpServers : {}

    try {
      const result = await skillApi.resolveSkillInvocation(skillRootPath, skillName, toolArgsObj, {
        mcpServers: currentMcpServers
      })

      if (result && typeof result === 'object' && result.__isForkRequest && result.subAgentArgs) {
        if (!context) {
          return JSON.stringify([{ type: 'text', text: 'Error: Sub-Agent skill requires execution context (API Key, etc).' }], null, 2)
        }

        const nextContext = { ...context }
        if (callbackToken) {
          nextContext.onUpdate = (payload) => {
            try {
              event.sender.send('window:callback', {
                token: callbackToken,
                payload: typeof payload === 'string' ? payload : JSON.parse(JSON.stringify(payload))
              })
            } catch {
              // ignore callback notify failure
            }
          }
        }

        return await mcpApi.invokeMcpTool('sub_agent', result.subAgentArgs, controller.signal, nextContext)
      }

      return JSON.stringify([{ type: 'text', text: result }], null, 2)
    } finally {
      if (signalKey) {
        liveSignalControllers.delete(signalKey)
      }
    }
  })


handleInvoke('skill:pathJoin', async (_event, ...args) => {
    return path.join(...args)
  })

  
  handleInvoke('skill:toggleForkMode', async (_event, skillRootPath = '', skillId = '', enableFork = false) => {
    const result = skillApi.toggleSkillForkMode(skillRootPath, skillId, enableFork)
    dataApi.notifySkillsUpdated()
    return result
  })

  handleInvoke('file:handleFilePath', async (_event, filePath = '') => {
    return fileApi.handleFilePath(filePath)
  }, { fileMode: 'buffer' })

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

  
  handleInvoke('file:probePathSupport', async (_event, filePath = '') => {
    return fileApi.probeFilePathSupport(filePath)
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

  handleInvoke('file:readRemoteText', async (_event, url = '', options = {}) => {
    return fileApi.readRemoteText(url, options)
  })

  handleInvoke('file:readRemoteBinary', async (_event, url = '', options = {}) => {
    return fileApi.readRemoteBinary(url, options)
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
