import { MultiServerMCPClient } from '@langchain/mcp-adapters'
import { getBuiltinTools, invokeBuiltinTool } from './mcp_builtin.js'


const persistentClients = new Map()
const fullToolInfoMap = new Map()
const currentlyConnectedServerIds = new Set()

function normalizeTransportType(transport = '') {
  const streamableHttpRegex = /^streamable[\s_-]?http$/i
  if (streamableHttpRegex.test(transport)) {
    return 'http'
  }
  return transport
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
  const preprocessed = preprocessStdioConfig(config)
  const resolvedTransport = preprocessed.transport || preprocessed.type || ''
  return {
    id,
    ...preprocessed,
    transport: normalizeTransportType(resolvedTransport)
  }
}


function sanitizeToolsForCache(tools = [], oldToolsCache = []) {
  return tools.map((tool) => {
    const oldTool = oldToolsCache.find((item) => item.name === tool.name)
    return {
      name: tool.name,
      description: tool.description,
      inputSchema: tool.inputSchema || tool.schema || {},
      enabled: oldTool ? (oldTool.enabled ?? true) : true
    }
  })
}

function getToolEnabledState(cachedToolsMap, serverId, toolName) {
  if (cachedToolsMap && cachedToolsMap[serverId]) {
    const cachedTool = cachedToolsMap[serverId].find((item) => item.name === toolName)
    return cachedTool ? (cachedTool.enabled ?? true) : true
  }
  return true
}

function saveToolCache(saveCacheCallback, id, tools, cachedToolsMap = {}) {
  if (typeof saveCacheCallback !== 'function') return

  const oldToolsCache = cachedToolsMap[id] || []
  const sanitizedTools = sanitizeToolsForCache(tools, oldToolsCache)
  const cleanTools = JSON.parse(JSON.stringify(sanitizedTools))

  saveCacheCallback(id, cleanTools).catch((error) => {
    console.error(`[MCP] Auto-cache failed for ${id}:`, error)
  })
}

function registerToolsToMap({ id, config, tools, isPersistent, isBuiltin, cachedToolsMap = {}, includeInstance = false }) {
  for (const tool of tools) {
    fullToolInfoMap.set(tool.name, {
      instance: includeInstance ? tool : undefined,
      schema: tool.schema || tool.inputSchema,
      description: tool.description,
      isPersistent,
      serverConfig: { id, ...config },
      isBuiltin,
      enabled: getToolEnabledState(cachedToolsMap, id, tool.name)
    })
  }

  currentlyConnectedServerIds.add(id)
}

/**
 * 独立连接并获取工具列表
 * 用于测试连接，以及无缓存时的临时连接获取
 */
export async function connectAndFetchTools(id, config = {}) {
  if (config.transport === 'builtin' || config.type === 'builtin') {
    return await getBuiltinTools(id, { configPrompts: config?.prompts })
  }

  let tempClient = null
  const controller = new AbortController()
  const timeoutId = setTimeout(() => controller.abort(), 10_000)

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
}

/**
 * 增量式初始化/同步 MCP 客户端
 */
export async function initializeMcpClient(activeServerConfigs = {}, cachedToolsMap = {}, saveCacheCallback = null) {
  const newIds = new Set(Object.keys(activeServerConfigs))
  const oldIds = new Set(currentlyConnectedServerIds)

  const idsToAdd = [...newIds].filter((id) => !oldIds.has(id))
  const idsToRemove = [...oldIds].filter((id) => !newIds.has(id))
  const failedServerIds = []

  // 1) 先移除
  for (const id of idsToRemove) {
    if (persistentClients.has(id)) {
      const client = persistentClients.get(id)
      try {
        await client.close()
      } catch {
        // ignore close errors
      }
      persistentClients.delete(id)
    }

    for (const [toolName, toolInfo] of fullToolInfoMap.entries()) {
      if (toolInfo.serverConfig.id === id) {
        fullToolInfoMap.delete(toolName)
      }
    }

    currentlyConnectedServerIds.delete(id)
  }

  const onDemandConfigsToAdd = idsToAdd
    .map((id) => ({ id, config: activeServerConfigs[id] }))
    .filter(({ config }) => config && !config.isPersistent)

  const persistentConfigsToAdd = idsToAdd
    .map((id) => ({ id, config: activeServerConfigs[id] }))
    .filter(({ config }) => config && config.isPersistent)

  // 2) 非持久：优先缓存
  const onDemandToConnect = []

  for (const { id, config } of onDemandConfigsToAdd) {
    const isBuiltin = config.transport === 'builtin' || config.type === 'builtin'

    if (
      !isBuiltin &&
      cachedToolsMap &&
      Array.isArray(cachedToolsMap[id]) &&
      cachedToolsMap[id].length > 0
    ) {
      const cachedTools = cachedToolsMap[id]
      registerToolsToMap({
        id,
        config,
        tools: cachedTools,
        isPersistent: false,
        isBuiltin: false,
        cachedToolsMap,
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

          saveToolCache(saveCacheCallback, id, tools, cachedToolsMap)

          const isBuiltin = config.transport === 'builtin' || config.type === 'builtin'
          registerToolsToMap({
            id,
            config,
            tools,
            isPersistent: false,
            isBuiltin,
            cachedToolsMap,
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

  // 3) 持久连接
  if (persistentConfigsToAdd.length > 0) {
    for (const { id, config } of persistentConfigsToAdd) {
      if (config.transport === 'builtin' || config.type === 'builtin') {
        try {
          const tools = await getBuiltinTools(id, { configPrompts: config?.prompts })
          saveToolCache(saveCacheCallback, id, tools, cachedToolsMap)

          registerToolsToMap({
            id,
            config,
            tools,
            isPersistent: true,
            isBuiltin: true,
            cachedToolsMap,
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

        saveToolCache(saveCacheCallback, id, tools, cachedToolsMap)

        registerToolsToMap({
          id,
          config,
          tools,
          isPersistent: true,
          isBuiltin: false,
          cachedToolsMap,
          includeInstance: true
        })

        persistentClients.set(id, client)
      } catch (error) {
        console.error(`[MCP Debug] Failed to connect to persistent server ${id}:`, error)
        failedServerIds.push(id)

        const client = persistentClients.get(id)
        if (client) {
          try {
            await client.close()
          } catch {
            // ignore close errors
          }
        }
        persistentClients.delete(id)
      }
    }
  }

  return {
    openaiFormattedTools: buildOpenaiFormattedTools(),
    successfulServerIds: [...currentlyConnectedServerIds],
    failedServerIds
  }
}

function buildOpenaiFormattedTools() {
  const formattedTools = []

  for (const [toolName, toolInfo] of fullToolInfoMap.entries()) {
    if (toolInfo.schema && toolInfo.enabled !== false) {
      formattedTools.push({
        type: 'function',
        function: {
          name: toolName,
          description: toolInfo.description,
          parameters: toolInfo.schema
        }
      })
    }
  }

  return formattedTools
}

/**
 * 统一工具调用入口
 */
export async function invokeMcpTool(toolName, toolArgs, signal, context = null) {
  const toolInfo = fullToolInfoMap.get(toolName)

  if (!toolInfo) {
    try {
      return await invokeBuiltinTool(toolName, toolArgs, signal, context)
    } catch {
      throw new Error(`Tool "${toolName}" not found.`)
    }
  }

  if (toolInfo.enabled === false) {
    throw new Error(`Tool "${toolName}" has been disabled.`)
  }

  if (toolInfo.isBuiltin) {
    return await invokeBuiltinTool(toolName, toolArgs, signal, context)
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
      const toolToCall = tools.find((tool) => tool.name === toolName)

      if (!toolToCall) {
        throw new Error(`Tool "${toolName}" not found.`)
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

  throw new Error(`Configuration error for tool "${toolName}".`)
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
    const targetTool = tools.find((tool) => tool.name === toolName || tool.name === `${id}_${toolName}`)

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

export async function closeMcpClient() {
  if (persistentClients.size > 0) {
    for (const client of persistentClients.values()) {
      await client.close()
    }
    persistentClients.clear()
  }

  fullToolInfoMap.clear()
  currentlyConnectedServerIds.clear()

  return { ok: true }
}
