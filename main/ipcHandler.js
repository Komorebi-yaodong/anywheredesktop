import path from 'node:path'
import crypto from 'node:crypto'
import { app, BrowserWindow, ipcMain } from 'electron'
import { serializeError, serializeIpcPayload } from './dataConverter.js'
import { runTaskById } from './core/task_runner.js'

const GITHUB_PACKAGE_JSON_URL = 'https://raw.githubusercontent.com/Komorebi-yaodong/anywheredesktop/main/package.json'
const GITEE_PACKAGE_JSON_URL = 'https://gitee.com/Komorebi-yaodong/anywheredesktop/raw/main/package.json'

function parseVersionParts(version = '') {
  return String(version || '')
    .trim()
    .replace(/^v/i, '')
    .split(/[.-]/)
    .map((part) => (/^\d+$/.test(part) ? Number(part) : part))
}

function compareVersions(a = '', b = '') {
  const aParts = parseVersionParts(a)
  const bParts = parseVersionParts(b)
  const maxLength = Math.max(aParts.length, bParts.length)

  for (let index = 0; index < maxLength; index += 1) {
    const left = aParts[index]
    const right = bParts[index]

    if (left === undefined && right === undefined) return 0
    if (left === undefined) return typeof right === 'number' ? -1 : 1
    if (right === undefined) return typeof left === 'number' ? 1 : -1

    if (typeof left === 'number' && typeof right === 'number') {
      if (left > right) return 1
      if (left < right) return -1
      continue
    }

    if (typeof left === 'number') return 1
    if (typeof right === 'number') return -1

    const compared = String(left).localeCompare(String(right))
    if (compared !== 0) return compared > 0 ? 1 : -1
  }

  return 0
}

async function readLatestVersionFromPackage(fileApi, source, url) {
  const result = await fileApi.readRemoteText(url)
  if (!result?.ok || typeof result?.text !== 'string') {
    throw new Error(result?.message || `${source}_package_fetch_failed`)
  }

  let parsed
  try {
    parsed = JSON.parse(result.text)
  } catch {
    throw new Error(`${source}_package_json_invalid`)
  }

  const version = typeof parsed?.version === 'string' ? parsed.version.trim() : ''
  if (!version) {
    throw new Error(`${source}_package_version_missing`)
  }

  return {
    source,
    url,
    version
  }
}


const liveSignalControllers = new Map()



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

    try {
      const result = await handler(event, ...args)
      const serialized = await serializeIpcPayload(result, options)
      return serialized
    } catch (error) {
      const serializedError = serializeError(error)
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
  projectsApi,
  conversationApi,
  chatApi,
  mcpApi,
  skillApi,
  compactApi,

  updaterApi,

  minimizeWindow,
  maximizeOrRestoreWindow,
  closeWindow,
  toggleAlwaysOnTop,
  handleFastInputWindowEvent,
  appendPayloadToWindow,
  startScreenshotPromptWorkflow,
  confirmScreenshotPromptWorkflow,
  cancelScreenshotPromptWorkflow
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

    try {
      closeWindow(windowRef)
    } catch (error) {
      const serializedError = serializeError(error)
      console.error('[IPC] window:close failed', {
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

  handleInvoke('system:clipboard:markConsumed', async (_event, contextId = '') => {
    return systemApi.markShortcutPayloadConsumed(contextId)
  })

  handleInvoke('system:clipboard:markDiscarded', async (_event, contextId = '') => {
    return systemApi.markShortcutPayloadDiscarded(contextId)
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

  handleInvoke('quick:screenshot:startPrompt', async (_event, input = {}) => {
    if (typeof startScreenshotPromptWorkflow !== 'function') {
      return { ok: false, error: { message: 'screenshot_workflow_unavailable' } }
    }
    return startScreenshotPromptWorkflow(input)
  })

  handleInvoke('screenshot:confirm', async (_event, input = {}) => {
    if (typeof confirmScreenshotPromptWorkflow !== 'function') {
      return { ok: false, error: { message: 'screenshot_confirm_unavailable' } }
    }
    return confirmScreenshotPromptWorkflow(input)
  })

  handleInvoke('screenshot:cancel', async (_event, input = {}) => {
    if (typeof cancelScreenshotPromptWorkflow !== 'function') {
      return { ok: false, error: { message: 'screenshot_cancel_unavailable' } }
    }
    return cancelScreenshotPromptWorkflow(input)
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


  
  
  handleInvoke('app:getVersion', async () => {
    return {
      ok: true,
      version: app.getVersion()
    }
  })

  handleInvoke('app:checkLatestVersion', async () => {
    const currentVersion = app.getVersion()
    const sources = [
      { source: 'github', url: GITHUB_PACKAGE_JSON_URL },
      { source: 'gitee', url: GITEE_PACKAGE_JSON_URL }
    ]
    const errors = []

    for (const entry of sources) {
      try {
        const latest = await readLatestVersionFromPackage(fileApi, entry.source, entry.url)
        return {
          ok: true,
          currentVersion,
          latestVersion: latest.version,
          hasUpdate: compareVersions(latest.version, currentVersion) > 0,
          source: latest.source,
          checkedUrl: latest.url,
          errors
        }
      } catch (error) {
        errors.push({
          source: entry.source,
          url: entry.url,
          message: error?.message || String(error)
        })
      }
    }

    return {
      ok: false,
      currentVersion,
      latestVersion: '',
      hasUpdate: false,
      source: '',
      checkedUrl: '',
      errors,
      error: {
        message: 'latest_version_check_failed'
      }
    }
  })

  handleInvoke('app:update:getStatus', async () => {
    if (!updaterApi || typeof updaterApi.getUpdateStatus !== 'function') {
      return { ok: false, message: 'updater_unavailable' }
    }
    return updaterApi.getUpdateStatus()
  })

  handleInvoke('app:update:check', async () => {
    if (!updaterApi || typeof updaterApi.checkForAppUpdate !== 'function') {
      return { ok: false, message: 'updater_unavailable' }
    }
    return updaterApi.checkForAppUpdate()
  })

  handleInvoke('app:update:download', async () => {
    if (!updaterApi || typeof updaterApi.downloadAppUpdate !== 'function') {
      return { ok: false, message: 'updater_unavailable' }
    }
    return updaterApi.downloadAppUpdate()
  })

  handleInvoke('app:update:install', async () => {
    if (!updaterApi || typeof updaterApi.installDownloadedUpdate !== 'function') {
      return { ok: false, message: 'updater_unavailable' }
    }
    return updaterApi.installDownloadedUpdate()
  })

  handleInvoke('app:update:clearCache', async () => {
    if (!updaterApi || typeof updaterApi.clearDownloadedUpdateCache !== 'function') {
      return { ok: false, message: 'updater_unavailable' }
    }
    return updaterApi.clearDownloadedUpdateCache()
  })



handleInvoke('data:getUser', async () => {
    return dataApi.getUser()
  })

  
  handleInvoke('compact:getCache', async () => {
    return compactApi.getCompactCacheSnapshot()
  })

  handleInvoke('compact:importCache', async (_event, models = {}) => {
    return compactApi.importCompactCacheModels(models)
  })

  handleInvoke('compact:getModelConfig', async (_event, modelInput = '') => {
    return compactApi.getModelCompactConfig(modelInput)
  })

  handleInvoke('compact:updateModelConfig', async (_event, modelInput = '', patch = {}) => {
    return compactApi.updateModelCompactConfig(modelInput, patch)
  })

  handleInvoke('compact:applyAdvancedToAll', async (_event, patch = {}) => {
    return compactApi.applyAdvancedCompactConfigToAll(patch)
  })

  handleInvoke('compact:resolveContext', async (_event, modelInput = '', options = {}) => {
    return compactApi.resolveModelContextLength(modelInput, options)
  })

  handleInvoke('compact:pruneCache', async (_event, enabledModels = []) => {
    return compactApi.pruneCompactCacheByEnabledModels(enabledModels)
  })

  handleInvoke('compact:estimateTokens', async (_event, messages = []) => {
    const tokens = compactApi.estimateMessagesTokens(messages)
    return { ok: true, tokens }
  })

  handleInvoke('compact:shouldAuto', async (_event, input = {}) => {
    return {
      ok: true,
      should: compactApi.shouldAutoCompact(input || {})
    }
  })

  handleInvoke('compact:run', async (event, input = {}, meta = {}) => {
    const signalToken = typeof meta?.signalToken === 'string' ? meta.signalToken : ''
    const callbackToken = typeof meta?.callbackToken === 'string' ? meta.callbackToken : ''
    const controller = new AbortController()
    const signalKey = signalToken ? getLiveSignalKey(event.sender.id, signalToken) : ''

    if (signalKey) {
      liveSignalControllers.set(signalKey, controller)
    }
    if (meta?.aborted) {
      controller.abort()
    }

    try {
      return await compactApi.runConversationCompaction({
        ...(input && typeof input === 'object' ? input : {}),
        signal: controller.signal,
        onProgress: callbackToken
          ? (payload) => {
              try {
                event.sender.send('window:callback', {
                  token: callbackToken,
                  payload: typeof payload === 'string' ? payload : JSON.parse(JSON.stringify(payload))
                })
              } catch {
                // ignore progress callback failure
              }
            }
          : null
      })
    } finally {
      if (signalKey) {
        liveSignalControllers.delete(signalKey)
      }
    }
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


  handleInvoke('data:getTaskDeviceIdentity', async () => dataApi.getTaskDeviceIdentity())
  handleInvoke('data:setTaskDeviceEnabled', async (_event, taskId = '', enabled = false) => {
    return dataApi.setTaskDeviceEnabled(taskId, enabled)
  })
  handleInvoke('data:removeTaskAppliedDevice', async (_event, taskId = '', device = {}) => {
    return dataApi.removeTaskAppliedDevice(taskId, device)
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
    return runTaskById({ taskId, dataApi, openWindow })
  })

  handleInvoke('chat:getRandomItem', async (_event, list = '') => {
    return chatApi.getRandomItem(list)
  })


  handleInvoke('chat:listProviderModels', async (_event, input = {}) => {
    return chatApi.listProviderModels(input)
  })

  handleInvoke('chat:batchTestProviderKeys', async (_event, input = {}) => {
    return chatApi.batchTestProviderKeys(input)
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

  handleInvoke('mcp:initializeClient', async (event, activeServerConfigs = {}, meta = {}) => {
    let cache = {}

    try {
      cache = await dataApi.getMcpToolCache()
    } catch (error) {
      console.error('[IPC] Failed to read MCP cache, fallback to empty cache:', error)
    }

    const senderId = BrowserWindow.fromWebContents(event.sender)?.id || event.sender?.id || null
    const sessionKey = typeof meta?.sessionKey === 'string' && meta.sessionKey.trim()
      ? meta.sessionKey.trim()
      : (senderId ? String(senderId) : 'global')

    return mcpApi.initializeMcpClient(activeServerConfigs, cache, dataApi.saveMcpToolCache, { sessionKey })
  })

  handleInvoke('mcp:testConnection', async (_event, serverConfig = {}) => {
    const normalizedConfig = {
      transport: serverConfig.type,
      command: serverConfig.command,
      args: serverConfig.args,
      url: serverConfig.baseUrl,
      env: serverConfig.env,
      headers: serverConfig.headers,
      auth: serverConfig.auth,
      type: serverConfig.type,
      isPersistent: Boolean(serverConfig.isPersistent),
      timeoutSeconds: serverConfig.timeoutSeconds
    }

    const rawTools = await mcpApi.connectAndFetchTools(serverConfig.id, normalizedConfig)
    const sanitizeToolAlias = (name, fallback = 'tool') => {
      const source = typeof name === 'string' ? name.trim() : ''
      const baseName = source || fallback
      const sanitized = baseName
        .replace(/[^a-zA-Z0-9_-]+/g, '_')
        .replace(/_+/g, '_')
        .replace(/^_+|_+$/g, '')
      return sanitized || fallback
    }

    let oldTools = []
    try {
      const oldCacheMap = await dataApi.getMcpToolCache()
      oldTools = oldCacheMap ? (oldCacheMap[serverConfig.id] || []) : []
    } catch (error) {
      console.error('[IPC] Failed to read MCP cache before testConnection:', error)
    }

    const sanitizedTools = (Array.isArray(rawTools) ? rawTools : []).map((tool) => {
      const name = tool?.name || ''
      const alias = sanitizeToolAlias(name, serverConfig.id || 'tool')
      const oldTool = oldTools.find((item) => item?.name === name || item?.alias === alias || item?.rawName === name || item?.originalName === name)

      return {
        name,
        alias,
        rawName: name,
        originalName: name,
        displayName: name,
        description: tool?.description || '',
        inputSchema: tool?.inputSchema || tool?.schema || {},
        enabled: oldTool ? (oldTool.enabled ?? true) : tool?.enabled !== false
      }
    })

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
      auth: serverConfig.auth,
      type: serverConfig.type,
      timeoutSeconds: serverConfig.timeoutSeconds
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


  handleInvoke('mcp:oauth:getStatus', async (_event, input = {}) => {
    const serverId = input?.serverId || input?.serverConfig?.id || ''
    const serverConfig = input?.serverConfig || {}
    const status = await mcpApi.getMcpAuthStatus(serverId, serverConfig)
    return { success: true, status }
  })

  handleInvoke('mcp:oauth:startAuthFlow', async (_event, input = {}) => {
    const serverConfig = input?.serverConfig || {}
    const serverId = serverConfig.id || input?.serverId || ''
    const authenticated = await mcpApi.ensureMcpAuthenticated(serverId, serverConfig)
    const status = await mcpApi.getMcpAuthStatus(serverId, serverConfig)
    return { success: true, authenticated, status }
  })

  handleInvoke('mcp:oauth:refresh', async (_event, input = {}) => {
    const serverId = input?.serverId || input?.serverConfig?.id || ''
    const serverConfig = input?.serverConfig || {}
    const status = await mcpApi.refreshMcpOAuth(serverId, serverConfig)
    return { success: true, refreshed: true, status }
  })

  handleInvoke('mcp:oauth:logout', async (_event, input = {}) => {
    const serverId = input?.serverId || ''
    await mcpApi.logoutMcpOAuth(serverId)
    return { success: true }
  })

  handleInvoke('mcp:oauth:saveManualClient', async (_event, input = {}) => {
    const serverId = input?.serverId || ''
    const clientId = input?.clientId || ''
    const clientSecret = input?.clientSecret || ''
    await mcpApi.saveMcpOAuthManualClient(serverId, clientId, clientSecret)
    return { success: true }
  })


handleInvoke('mcp:closeClient', async (event, meta = {}) => {
    const senderId = BrowserWindow.fromWebContents(event.sender)?.id || event.sender?.id || null
    const sessionKey = typeof meta?.sessionKey === 'string' && meta.sessionKey.trim()
      ? meta.sessionKey.trim()
      : (senderId ? String(senderId) : 'global')
    return mcpApi.closeMcpClient({ sessionKey })
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

  handleInvoke('skill:exportPackage', async (_event, skillRootPath = '', skillId = '', outputDir = '', options = {}) => {
    return skillApi.exportSkillToPackage(skillRootPath, skillId, outputDir, options)
  })

  handleInvoke('skill:extractPackage', async (_event, filePath = '') => {
    return skillApi.extractSkillPackage(filePath)
  })

  handleInvoke('skill:uploadToWebdav', async (event, input = {}) => {
    const meta = input?.meta && typeof input.meta === 'object' ? input.meta : {}
    const signalToken = typeof meta?.signalToken === 'string' ? meta.signalToken : ''
    const callbackToken = typeof meta?.callbackToken === 'string' ? meta.callbackToken : ''
    const controller = new AbortController()
    const signalKey = signalToken ? getLiveSignalKey(event.sender.id, signalToken) : ''

    if (signalKey) {
      liveSignalControllers.set(signalKey, controller)
    }
    if (meta?.aborted) {
      controller.abort()
    }

    try {
      return await skillApi.uploadSkillsToWebdav({
        skillRootPath: input?.skillRootPath,
        skillIds: input?.skillIds,
        remotePath: input?.remotePath,
        webdavConfig: input?.webdavConfig,
        maxPackageSizeBytes: input?.maxPackageSizeBytes,
        signal: controller.signal,
        onProgress: callbackToken ? (payload) => {
          try {
            event.sender.send('window:callback', {
              token: callbackToken,
              payload: typeof payload === 'string' ? payload : JSON.parse(JSON.stringify(payload))
            })
          } catch {
            // ignore callback notify failure
          }
        } : null,
        writeWebdavBackup: webdavApi.writeBackup
      })
    } finally {
      if (signalKey) {
        liveSignalControllers.delete(signalKey)
      }
    }
  })

  handleInvoke('skill:listWebdav', async (_event, input = {}) => {
    return skillApi.listSkillsFromWebdav({
      remotePath: input?.remotePath,
      webdavConfig: input?.webdavConfig,
      includeMetadata: input?.includeMetadata === true,
      listWebdavDirectory: webdavApi.listDirectory,
      readWebdavBackup: webdavApi.readBackupBinary
    })
  })

  handleInvoke('skill:deleteWebdav', async (_event, input = {}) => {
    return skillApi.deleteSkillsFromWebdav({
      skillIds: input?.skillIds,
      remotePath: input?.remotePath,
      webdavConfig: input?.webdavConfig,
      listWebdavDirectory: webdavApi.listDirectory,
      deleteWebdavDirectoryContents: webdavApi.deleteDirectoryContents
    })
  })

  handleInvoke('skill:pullFromWebdav', async (_event, input = {}) => {
    return skillApi.pullSkillFromWebdav({
      skillId: input?.skillId,
      skillRootPath: input?.skillRootPath,
      remotePath: input?.remotePath,
      webdavConfig: input?.webdavConfig,
      listWebdavDirectory: webdavApi.listDirectory,
      readWebdavBackup: webdavApi.readBackup,
      readWebdavBackupBinary: webdavApi.readBackupBinary
    })
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

  handleInvoke('file:exportLocalChatFile', async (_event, filePath = '', options = {}) => {
    return fileApi.exportLocalChatFile(filePath, options)
  })

  handleInvoke('file:selectDirectory', async () => {
    return fileApi.selectDirectory()
  })

  handleInvoke('file:listJsonFiles', async (_event, dirPath = '', options = {}) => {
    return fileApi.listJsonFiles(dirPath, options)
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


  handleInvoke('webdav:writeBackupsBatch', async (_event, input = {}) => {
    return webdavApi.writeBackupsBatch(input)
  })

  handleInvoke('webdav:readBackup', async (_event, input = {}) => {
    return webdavApi.readBackup(input)
  })

  handleInvoke('webdav:readBackupBinary', async (_event, input = {}) => {
    return webdavApi.readBackupBinary(input)
  })

  handleInvoke('webdav:listDirectory', async (_event, input = {}) => {
    return webdavApi.listDirectory(input)
  })

  handleInvoke('webdav:deleteDirectoryContents', async (_event, input = {}) => {
    return webdavApi.deleteDirectoryContents(input)
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

  handleInvoke('conversation:listLocal', async (_event, dirPath = '') => {
    return conversationApi.listLocalConversations(dirPath)
  })

  handleInvoke('conversation:migrateJson', async (_event, input = {}) => {
    return conversationApi.migrateJsonConversation(input)
  })

  handleInvoke('conversation:create', async (_event, input = {}) => {
    return conversationApi.createConversation(input)
  })

  handleInvoke('conversation:open', async (_event, input = {}) => {
    return conversationApi.openConversation(input)
  })

  handleInvoke('conversation:loadPage', async (_event, input = {}) => {
    return conversationApi.loadConversationPage(input)
  })

  handleInvoke('conversation:getRequestMessages', async (_event, input = {}) => {
    return conversationApi.getConversationRequestMessages(input)
  })


  handleInvoke('conversation:saveSnapshot', async (_event, input = {}) => {
    return conversationApi.saveConversationSnapshot(input)
  })

  handleInvoke('conversation:saveState', async (_event, input = {}) => {
    return conversationApi.saveConversationState(input)
  })

  handleInvoke('conversation:appendMessages', async (_event, input = {}) => {
    return conversationApi.appendMessages(input)
  })

  handleInvoke('conversation:updateMessage', async (_event, input = {}) => {
    return conversationApi.updateMessage(input)
  })

  handleInvoke('conversation:truncateMessages', async (_event, input = {}) => {
    return conversationApi.truncateMessages(input)
  })

  handleInvoke('conversation:deleteMessages', async (_event, input = {}) => {
    return conversationApi.deleteMessages(input)
  })

  handleInvoke('conversation:replaceActiveMessages', async (_event, input = {}) => {
    return conversationApi.replaceActiveMessages(input)
  })


  handleInvoke('conversation:restoreCompaction', async (_event, input = {}) => {
    return conversationApi.restoreConversationCompaction(input)
  })


  handleInvoke('conversation:rename', async (_event, input = {}) => {
    return conversationApi.renameConversation(input)
  })

  handleInvoke('conversation:delete', async (_event, input = {}) => {
    return conversationApi.deleteConversation(input)
  })

  handleInvoke('conversation:acquireLease', async (_event, input = {}) => {
    return conversationApi.acquireWriteLease(input)
  })

  handleInvoke('conversation:heartbeatLease', async (_event, input = {}) => {
    return conversationApi.heartbeatWriteLease(input)
  })

  handleInvoke('conversation:releaseLease', async (_event, input = {}) => {
    return conversationApi.releaseWriteLease(input)
  })

  handleInvoke('conversation:createSnapshot', async (_event, input = {}) => {
    return conversationApi.createConversationSnapshot(input)
  })

  handleInvoke('conversation:createCloudWorktree', async (_event, input = {}) => {
    const conversationId = String(input?.conversationId || crypto.randomUUID()).trim()
    const worktreeDir = path.join(app.getPath('userData'), 'cloud-worktrees', conversationId)
    const created = await conversationApi.createConversation({
      dirPath: worktreeDir,
      title: input?.title,
      sessionData: input?.sessionData,
      storageMode: 'cloud'
    })
    return { ...created, worktreeDir, storageMode: 'cloud' }
  })


  handleInvoke('conversation:uploadCloudRemote', async (_event, input = {}) => {
    const descriptorResult = await conversationApi.getConversationDescriptor({
      dirPath: input?.dirPath,
      reference: input?.conversationId
    })
    const descriptor = descriptorResult?.descriptor
    if (!descriptor) throw new Error('conversation_descriptor_missing')

    const snapshot = await conversationApi.readConversationSnapshot({
      dirPath: input?.dirPath,
      conversationId: descriptor.conversationId
    })
    const result = await webdavApi.writeBackup({
      ...(input?.remote || {}),
      filename: descriptor.dbFile,
      content: snapshot.content,
      overwrite: true,
      ensureDirectory: true,
      useChatMetadata: false
    })
    if (!result || result.ok === false) throw new Error(result?.reason || 'webdav_write_failed')
    return { ok: true, descriptor }
  })

  handleInvoke('conversation:importCloudRemote', async (_event, input = {}) => {
    const descriptor = input?.descriptor
    const result = await webdavApi.readBackupBinary({
      ...(input?.remote || {}),
      filename: descriptor?.dbFile
    })
    if (!result || result.ok === false) throw new Error(result?.reason || 'webdav_read_failed')
    return conversationApi.importConversationSnapshot({
      dirPath: input?.dirPath,
      descriptor,
      content: result.content
    })
  })

  handleInvoke('conversation:openCloudRemote', async (_event, input = {}) => {
    const descriptor = input?.descriptor
    const conversationId = String(descriptor?.conversationId || '').trim()
    if (!conversationId) throw new Error('conversation_descriptor_invalid')

    const result = await webdavApi.readBackupBinary({
      ...(input?.remote || {}),
      filename: descriptor.dbFile
    })
    if (!result || result.ok === false) throw new Error(result?.reason || 'webdav_read_failed')

    const worktreeDir = path.join(app.getPath('userData'), 'cloud-worktrees', conversationId)
    await conversationApi.importConversationSnapshot({
      dirPath: worktreeDir,
      descriptor: { ...descriptor, storageMode: 'cloud' },
      content: result.content
    })
    const opened = await conversationApi.openConversation({
      dirPath: worktreeDir,
      reference: conversationId,
      activeOnly: true
    })
    return { ...opened, worktreeDir, storageMode: 'cloud' }
  })



  handleInvoke('conversation:openCloudSnapshot', async (_event, input = {}) => {
    const conversationId = String(input?.descriptor?.conversationId || '').trim()
    if (!conversationId) throw new Error('conversation_descriptor_invalid')
    const worktreeDir = path.join(app.getPath('userData'), 'cloud-worktrees', conversationId)
    await conversationApi.importConversationSnapshot({
      dirPath: worktreeDir,
      descriptor: { ...input.descriptor, storageMode: 'cloud' },
      content: input.content
    })
    const opened = await conversationApi.openConversation({ dirPath: worktreeDir, reference: conversationId, activeOnly: true })
    return { ...opened, worktreeDir, storageMode: 'cloud' }
  })


  handleInvoke('conversation:readSnapshot', async (_event, input = {}) => {
    return conversationApi.readConversationSnapshot(input)
  })

  handleInvoke('conversation:importSnapshot', async (_event, input = {}) => {
    return conversationApi.importConversationSnapshot(input)
  })


  handleInvoke('conversation:getDescriptor', async (_event, input = {}) => {
    return conversationApi.getConversationDescriptor(input)
  })


  handleInvoke('projects:readLocal', async (_event, dirPath = '') => {
    return projectsApi.readLocalProjects(dirPath)
  })

  handleInvoke('projects:writeLocal', async (_event, dirPath = '', data = {}) => {
    return projectsApi.writeLocalProjects(dirPath, data)
  })

  handleInvoke('projects:readCloud', async (_event, input = {}) => {
    return projectsApi.readCloudProjects(input?.webdavConfig)
  })

  handleInvoke('projects:writeCloud', async (_event, input = {}, data = {}) => {
    return projectsApi.writeCloudProjects(input?.webdavConfig, data)
  })

  handleInvoke('projects:mergeFileCloud', async (_event, input = {}, assignment = {}) => {
    const current = await projectsApi.readCloudProjects(input?.webdavConfig)
    const merged = projectsApi.mergeFileAssignment(current, assignment)
    await projectsApi.writeCloudProjects(input?.webdavConfig, merged)
    return { ok: true, data: merged }
  })

  handleInvoke('projects:mergeProjectCloud', async (_event, input = {}, project = {}) => {
    const current = await projectsApi.readCloudProjects(input?.webdavConfig)
    const merged = projectsApi.mergeProjectAssignment(current, project)
    await projectsApi.writeCloudProjects(input?.webdavConfig, merged)
    return { ok: true, data: merged }
  })
}
