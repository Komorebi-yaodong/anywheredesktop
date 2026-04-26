import { MultiServerMCPClient } from '@langchain/mcp-adapters'
import { getBuiltinTools, invokeBuiltinTool } from './mcp_builtin.js'

const sessionRuntimes = new Map()
const inFlightToolFetchMap = new Map()

const TOOL_NAME_PATTERN = /^[a-zA-Z0-9_-]+$/

function sanitizeToolName(rawName, fallbackPrefix = 'tool') {
  const source = typeof rawName === 'string' ? rawName.trim() : ''
  const baseName = source || fallbackPrefix
  const sanitized = baseName
    .replace(/[^a-zA-Z0-9_-]+/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_+|_+$/g, '')

  return sanitized || fallbackPrefix
}

function ensureUniqueToolAlias(alias, usedAliases, fallbackPrefix = 'tool') {
  const safeBase = sanitizeToolName(alias, fallbackPrefix)
  let candidate = safeBase
  let index = 2

  while (usedAliases.has(candidate)) {
    candidate = `${safeBase}_${index}`
    index += 1
  }

  usedAliases.add(candidate)
  return candidate
}

function findCachedToolEntry(cachedTools = [], rawName = '', aliasName = '') {
  if (!Array.isArray(cachedTools) || cachedTools.length === 0) return null

  return cachedTools.find((tool) => {
    if (!tool || typeof tool !== 'object') return false
    return tool.name === rawName
      || tool.alias === aliasName
      || tool.rawName === rawName
      || tool.originalName === rawName
      || (aliasName && tool.name === aliasName)
  }) || null
}

function buildCachedToolRecord(tool, oldTool = null, aliasName = '') {
  const rawName = typeof tool?.name === 'string'
    ? tool.name
    : (typeof oldTool?.rawName === 'string' ? oldTool.rawName : '')

  return {
    name: rawName || aliasName,
    alias: aliasName || (typeof oldTool?.alias === 'string' ? oldTool.alias : ''),
    rawName: rawName || (typeof oldTool?.rawName === 'string' ? oldTool.rawName : ''),
    originalName: rawName || (typeof oldTool?.originalName === 'string' ? oldTool.originalName : ''),
    displayName: rawName || (typeof oldTool?.displayName === 'string' ? oldTool.displayName : aliasName),
    description: tool?.description,
    inputSchema: tool?.inputSchema || tool?.schema || {},
    enabled: oldTool ? (oldTool.enabled ?? true) : true
  }
}

function normalizeTransportType(transport = '') {
  const streamableHttpRegex = /^streamable[\s_-]?http$/i
  if (streamableHttpRegex.test(transport)) {
    return 'http'
  }
  return transport
}

function getSessionKey(sessionKey = 'global') {
  if (typeof sessionKey === 'string' && sessionKey.trim()) {
    return sessionKey.trim()
  }
  return 'global'
}

function createSessionRuntime() {
  return {
    persistentClients: new Map(),
    fullToolInfoMap: new Map(),
    currentlyConnectedServerIds: new Set()
  }
}

function getSessionRuntime(sessionKey = 'global', createIfMissing = true) {
  const normalizedKey = getSessionKey(sessionKey)
  if (!sessionRuntimes.has(normalizedKey) && createIfMissing) {
    sessionRuntimes.set(normalizedKey, createSessionRuntime())
  }
  return sessionRuntimes.get(normalizedKey)
}

async function teardownSessionRuntime(sessionKey = 'global') {
  const normalizedKey = getSessionKey(sessionKey)
  const runtime = getSessionRuntime(normalizedKey, false)
  if (!runtime) return

  if (runtime.persistentClients.size > 0) {
    for (const client of runtime.persistentClients.values()) {
      try {
        await client.close()
      } catch {
        // ignore close errors
      }
    }
  }

  runtime.persistentClients.clear()
  runtime.fullToolInfoMap.clear()
  runtime.currentlyConnectedServerIds.clear()
  sessionRuntimes.delete(normalizedKey)
}

/**
 * 预处理 stdio 配置：
 * 1) 兼容 command 写成一整行（含参数）
 * 2) 保留并扩展 env，避免 Electron 环境 PATH 不完整
 */
function preprocessStdioConfig(config = {}) {
  const result = { ...config }
  const transport = normalizeTransportType(result.transport || result.type || '')

  if (transport !== 'stdio') {
    return result
  }

  // 兼容："npx -y mcp-remote" / "C:\Program Files\nodejs\node.exe" -e ...
  if (result.command && result.command.includes(' ') && (!result.args || result.args.length === 0)) {
    const parts = result.command.match(/(?:[^\s"']+|"[^"]*"|'[^']*')+/g)
    if (parts && parts.length > 0) {
      result.command = parts[0].replace(/^["']|["']$/g, '')
      result.args = parts.slice(1).map((arg) => arg.replace(/^["']|["']$/g, ''))
    }
  }

  if (result.env && typeof result.env === 'object') {
    if (Object.keys(result.env).length === 0) {
      delete result.env
    } else {
      result.env = { ...process.env, ...result.env }
    }
  }

  return result
}

function buildServerConfig(id, config = {}) {
  const { toolCacheOverride, ...rawConfig } = config || {}
  const preprocessed = preprocessStdioConfig(rawConfig)
  const resolvedTransport = preprocessed.transport || preprocessed.type || ''
  return {
    id,
    ...preprocessed,
    transport: normalizeTransportType(resolvedTransport)
  }
}

function sanitizeToolsForCache(tools = [], oldToolsCache = [], serverId = '') {
  return tools.map((tool) => {
    const aliasName = sanitizeToolName(tool?.name, serverId || 'tool')
    const oldTool = findCachedToolEntry(oldToolsCache, tool?.name, aliasName)
    return buildCachedToolRecord(tool, oldTool, aliasName)
  })
}

function getToolEnabledState(cachedToolsMap, serverId, toolName, aliasName = '') {
  if (cachedToolsMap && cachedToolsMap[serverId]) {
    const cachedTool = findCachedToolEntry(cachedToolsMap[serverId], toolName, aliasName)
    return cachedTool ? (cachedTool.enabled ?? true) : true
  }
  return true
}

function getEffectiveToolsMap(activeServerConfigs = {}, cachedToolsMap = {}) {
  const effectiveToolsMap = { ...(cachedToolsMap || {}) }

  for (const [id, config] of Object.entries(activeServerConfigs || {})) {
    if (Array.isArray(config?.toolCacheOverride)) {
      effectiveToolsMap[id] = JSON.parse(JSON.stringify(config.toolCacheOverride))
    }
  }

  return effectiveToolsMap
}

function saveToolCache(saveCacheCallback, id, tools, cachedToolsMap = {}, options = {}) {
  if (typeof saveCacheCallback !== 'function') return

  const oldToolsCache = cachedToolsMap[id] || []
  const sanitizedTools = sanitizeToolsForCache(tools, oldToolsCache, id)
  const cleanTools = JSON.parse(JSON.stringify(sanitizedTools))

  saveCacheCallback(id, cleanTools, {
    emitEvent: options.emitEvent !== false,
    reason: options.reason || 'manual'
  }).catch((error) => {
    console.error(`[MCP] Auto-cache failed for ${id}:`, error)
  })
}

function getToolFetchKey(id, config = {}) {
  const normalizedConfig = {
    id,
    transport: config.transport || config.type || '',
    command: config.command || '',
    args: Array.isArray(config.args) ? [...config.args] : [],
    url: config.url || config.baseUrl || '',
    env: config.env && typeof config.env === 'object' ? Object.entries(config.env).sort(([a], [b]) => a.localeCompare(b)) : [],
    headers: config.headers && typeof config.headers === 'object' ? Object.entries(config.headers).sort(([a], [b]) => a.localeCompare(b)) : [],
    isPersistent: Boolean(config.isPersistent),
    currentAgentName: config.currentAgentName || '',
    prompts: config.prompts && typeof config.prompts === 'object' ? config.prompts : null
  }

  return JSON.stringify(normalizedConfig)
}

function registerToolsToMap(runtime, { id, config, tools, isPersistent, isBuiltin, enabledToolsMap = {}, includeInstance = false }) {
  const usedAliases = new Set(
    [...runtime.fullToolInfoMap.values()]
      .map((toolInfo) => toolInfo?.aliasName)
      .filter(Boolean)
  )

  for (const [index, tool] of tools.entries()) {
    const rawName = typeof tool?.rawName === 'string'
      ? tool.rawName
      : (typeof tool?.originalName === 'string' ? tool.originalName : tool?.name)
    const preferredAlias = tool?.alias || tool?.aliasName || tool?.name || `${id}_tool_${index + 1}`
    const aliasName = ensureUniqueToolAlias(preferredAlias, usedAliases, id || 'tool')

    runtime.fullToolInfoMap.set(aliasName, {
      instance: includeInstance ? tool : undefined,
      schema: tool?.schema || tool?.inputSchema,
      description: tool?.description,
      isPersistent,
      serverConfig: { id, ...config },
      isBuiltin,
      enabled: getToolEnabledState(enabledToolsMap, id, rawName, aliasName),
      aliasName,
      rawName,
      originalName: rawName,
      displayName: tool?.displayName || rawName || aliasName
    })
  }

  runtime.currentlyConnectedServerIds.add(id)
}

/**
 * 独立连接并获取工具列表
 * 用于测试连接，以及无缓存时的临时连接获取
 */
export async function connectAndFetchTools(id, config = {}) {
  const fetchKey = getToolFetchKey(id, config)
  const inFlightRequest = inFlightToolFetchMap.get(fetchKey)
  if (inFlightRequest) {
    return await inFlightRequest
  }

  const requestPromise = (async () => {
    if (config.transport === 'builtin' || config.type === 'builtin') {
      return await getBuiltinTools(id, { configPrompts: config?.prompts, currentAgentName: config?.currentAgentName })
    }

    let tempClient = null
    const controller = new AbortController()
    const timeoutId = setTimeout(() => controller.abort(), 15_000)

    try {
      const serverConfig = buildServerConfig(id, config)
      tempClient = new MultiServerMCPClient({ [id]: serverConfig }, { signal: controller.signal })
      return await tempClient.getTools()
    } catch (error) {
      console.error(`[MCP] Error fetching tools from ${id}:`, error)
      throw error
    } finally {
      clearTimeout(timeoutId)
      controller.abort()

      if (tempClient) {
        try {
          await tempClient.close()
        } catch (closeError) {
          console.error(`[MCP] Error closing connection for ${id}:`, closeError)
        }
      }
    }
  })()

  inFlightToolFetchMap.set(fetchKey, requestPromise)

  try {
    return await requestPromise
  } finally {
    if (inFlightToolFetchMap.get(fetchKey) === requestPromise) {
      inFlightToolFetchMap.delete(fetchKey)
    }
  }
}

/**
 * 会话级初始化/同步 MCP 客户端
 * 每次按当前窗口配置全量重建，避免旧工具启用状态残留。
 */
export async function initializeMcpClient(activeServerConfigs = {}, cachedToolsMap = {}, saveCacheCallback = null, options = {}) {
  const sessionKey = getSessionKey(options?.sessionKey)
  await teardownSessionRuntime(sessionKey)
  const runtime = getSessionRuntime(sessionKey, true)
  const enabledToolsMap = getEffectiveToolsMap(activeServerConfigs, cachedToolsMap)
  const failedServerIds = []
  const serverEntries = Object.entries(activeServerConfigs || {})

  console.log('[MCP Runtime] initializeMcpClient:start', {
    sessionKey,
    activeServerIds: Object.keys(activeServerConfigs || {}),
    cachedServerIds: Object.keys(cachedToolsMap || {})
  })

  const onDemandConfigsToAdd = serverEntries
    .map(([id, config]) => ({ id, config }))
    .filter(({ config }) => config && !config.isPersistent)

  const persistentConfigsToAdd = serverEntries
    .map(([id, config]) => ({ id, config }))
    .filter(({ config }) => config && config.isPersistent)

  const onDemandToConnect = []

  for (const { id, config } of onDemandConfigsToAdd) {
    const isBuiltin = config.transport === 'builtin' || config.type === 'builtin'
    const effectiveCachedTools = Array.isArray(enabledToolsMap[id]) ? enabledToolsMap[id] : []

    if (!isBuiltin && effectiveCachedTools.length > 0) {
      registerToolsToMap(runtime, {
        id,
        config,
        tools: effectiveCachedTools,
        isPersistent: false,
        isBuiltin: false,
        enabledToolsMap,
        includeInstance: false
      })
    } else {
      onDemandToConnect.push({ id, config })
    }
  }

  if (onDemandToConnect.length > 0) {
    const allTasks = onDemandToConnect.map(({ id, config }) =>
      (async () => {
        try {
          const tools = await connectAndFetchTools(id, config)

          saveToolCache(saveCacheCallback, id, tools, cachedToolsMap, { emitEvent: false, reason: 'auto-bootstrap' })

          const isBuiltin = config.transport === 'builtin' || config.type === 'builtin'
          registerToolsToMap(runtime, {
            id,
            config,
            tools,
            isPersistent: false,
            isBuiltin,
            enabledToolsMap,
            includeInstance: false
          })
        } catch (error) {
          if (error?.name !== 'AbortError') {
            console.error(`[MCP Debug] Failed to process on-demand server ${id}. Error:`, error?.message || error)
          }
          failedServerIds.push(id)
        }
      })()
    )

    await Promise.all(allTasks)
  }

  if (persistentConfigsToAdd.length > 0) {
    for (const { id, config } of persistentConfigsToAdd) {
      if (config.transport === 'builtin' || config.type === 'builtin') {
        try {
          const tools = await getBuiltinTools(id, { configPrompts: config?.prompts, currentAgentName: config?.currentAgentName })
          saveToolCache(saveCacheCallback, id, tools, cachedToolsMap, { emitEvent: false, reason: 'auto-bootstrap' })

          registerToolsToMap(runtime, {
            id,
            config,
            tools,
            isPersistent: true,
            isBuiltin: true,
            enabledToolsMap,
            includeInstance: false
          })
        } catch (error) {
          console.error(`[MCP Debug] Failed to load builtin server ${id}:`, error)
          failedServerIds.push(id)
        }

        continue
      }

      try {
        const serverConfig = buildServerConfig(id, config)
        const client = new MultiServerMCPClient({ [id]: serverConfig })
        const tools = await client.getTools()

        saveToolCache(saveCacheCallback, id, tools, cachedToolsMap, { emitEvent: false, reason: 'auto-bootstrap' })

        registerToolsToMap(runtime, {
          id,
          config,
          tools,
          isPersistent: true,
          isBuiltin: false,
          enabledToolsMap,
          includeInstance: true
        })

        runtime.persistentClients.set(id, client)
      } catch (error) {
        console.error(`[MCP Debug] Failed to connect to persistent server ${id}:`, error)
        failedServerIds.push(id)

        const client = runtime.persistentClients.get(id)
        if (client) {
          try {
            await client.close()
          } catch {
            // ignore close errors
          }
        }
        runtime.persistentClients.delete(id)
      }
    }
  }

  
  console.log('[MCP Runtime] initializeMcpClient:done', {
    sessionKey,
    successfulServerIds: [...runtime.currentlyConnectedServerIds],
    failedServerIds,
    registeredToolKeys: [...runtime.fullToolInfoMap.keys()],
    exportedToolNames: buildOpenaiFormattedTools(sessionKey).map((item) => item?.function?.name).filter(Boolean)
  })

return {
    openaiFormattedTools: buildOpenaiFormattedTools(sessionKey),
    successfulServerIds: [...runtime.currentlyConnectedServerIds],
    failedServerIds
  }
}

function buildOpenaiFormattedTools(sessionKey = 'global') {
  const runtime = getSessionRuntime(sessionKey, false)
  if (!runtime) return []

  const formattedTools = []

  for (const [, toolInfo] of runtime.fullToolInfoMap.entries()) {
    if (!toolInfo.schema || toolInfo.enabled === false) {
      continue
    }

    const exportedName = toolInfo.aliasName || sanitizeToolName(toolInfo.rawName || toolInfo.displayName || 'tool')
    if (!TOOL_NAME_PATTERN.test(exportedName)) {
      continue
    }

    formattedTools.push({
      type: 'function',
      function: {
        name: exportedName,
        description: toolInfo.description,
        parameters: toolInfo.schema
      }
    })
  }

  return formattedTools
}

/**
 * 统一工具调用入口
 */
export async function invokeMcpTool(toolName, toolArgs, signal, context = null) {
  const sessionKey = getSessionKey(context?.senderId)
  const runtime = getSessionRuntime(sessionKey, false)
  const toolInfo = runtime?.fullToolInfoMap.get(toolName)
  const resolvedToolName = toolInfo?.rawName || toolInfo?.originalName || toolInfo?.displayName || toolName

  console.log('[MCP Runtime] invokeMcpTool:start', {
    sessionKey,
    requestedToolName: toolName,
    resolvedToolName,
    contextSenderId: context?.senderId || null,
    runtimeExists: Boolean(runtime),
    registeredToolKeys: runtime ? [...runtime.fullToolInfoMap.keys()] : []
  })

  if (!toolInfo) {

    console.warn('[MCP Runtime] invokeMcpTool:not-found', {
      sessionKey,
      requestedToolName: toolName,
      resolvedToolName,
      contextSenderId: context?.senderId || null,
      registeredToolKeys: runtime ? [...runtime.fullToolInfoMap.keys()] : []
    })
    try {
      return await invokeBuiltinTool(toolName, toolArgs, signal, context)
    } catch {
      throw new Error(`Tool "${toolName}" not found.`)
    }
  }

  if (toolInfo.enabled === false) {
    throw new Error(`Tool "${toolInfo.displayName || toolName}" has been disabled.`)
  }

  if (toolInfo.isBuiltin) {
    return await invokeBuiltinTool(resolvedToolName, toolArgs, signal, context)
  }

  if (toolInfo.isPersistent && toolInfo.instance) {
    return await toolInfo.instance.invoke(toolArgs, { signal })
  }

  const serverConfig = toolInfo.serverConfig

  if (!toolInfo.isPersistent && serverConfig) {
    let tempClient = null
    const controller = new AbortController()
    let abortHandler = null

    if (signal) {
      if (signal.aborted) controller.abort()
      abortHandler = () => {
        controller.abort()
        if (tempClient && typeof tempClient.close === 'function') {
          tempClient.close().catch(() => {})
        }
      }
      signal.addEventListener('abort', abortHandler, { once: true })
    }

    try {
      const cfg = buildServerConfig(serverConfig.id, serverConfig)
      tempClient = new MultiServerMCPClient({ [serverConfig.id]: cfg }, { signal: controller.signal })

      if (controller.signal.aborted) {
        const abortError = new Error('This operation was aborted')
        abortError.name = 'AbortError'
        throw abortError
      }

      const tools = await tempClient.getTools()
      const toolToCall = tools.find((tool) => tool.name === resolvedToolName || sanitizeToolName(tool.name, serverConfig.id || 'tool') === toolName)

      if (!toolToCall) {
        throw new Error(`Tool "${resolvedToolName}" not found.`)
      }

      return await toolToCall.invoke(toolArgs, { signal: controller.signal })
    } finally {
      if (signal && abortHandler) {
        signal.removeEventListener('abort', abortHandler)
      }
      if (!signal) {
        controller.abort()
      }

      if (tempClient) {
        await tempClient.close()
      }
    }
  }

  throw new Error(`Configuration error for tool "${toolInfo.displayName || toolName}".`)
}

/**
 * 独立连接并执行工具
 * 用于设置界面测试具体工具调用
 */
export async function connectAndInvokeTool(id, config, toolName, toolArgs, context = null) {
  if (config.transport === 'builtin' || config.type === 'builtin') {
    return invokeBuiltinTool(toolName, toolArgs, null, context)
  }

  let tempClient = null
  const controller = new AbortController()
  const timeoutId = setTimeout(() => controller.abort(), 60_000)

  try {
    const serverConfig = buildServerConfig(id, config)
    tempClient = new MultiServerMCPClient({ [id]: serverConfig }, { signal: controller.signal })

    const tools = await tempClient.getTools()
    const normalizedToolName = sanitizeToolName(toolName, id || 'tool')
    const targetTool = tools.find((tool) => {
      const alias = sanitizeToolName(tool.name, id || 'tool')
      return tool.name === toolName || alias === toolName || alias === normalizedToolName || tool.name === `${id}_${toolName}`
    })

    if (!targetTool) {
      throw new Error(
        `Tool '${toolName}' not found on server '${id}'. Available tools: ${tools.map((tool) => tool.name).join(', ')}`
      )
    }

    return await targetTool.invoke(toolArgs, { signal: controller.signal })
  } catch (error) {
    console.error(`[MCP] Error invoking tool ${toolName} on ${id}:`, error)
    throw error
  } finally {
    clearTimeout(timeoutId)
    controller.abort()

    if (tempClient) {
      try {
        if (typeof tempClient.close === 'function') {
          await tempClient.close()
        }
      } catch (closeError) {
        console.error(`[MCP] Error closing temp connection for ${id}:`, closeError)
      }
    }
  }
}

export async function closeMcpClient(options = {}) {
  const sessionKey = getSessionKey(typeof options === 'string' ? options : options?.sessionKey)
  await teardownSessionRuntime(sessionKey)
  return { ok: true, sessionKey }
}
