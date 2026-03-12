const BUILTIN_SERVERS = {}

function clonePlain(value) {
  return JSON.parse(JSON.stringify(value ?? null))
}

/**
 * 获取内置 MCP 服务定义
 */
export function getBuiltinServers() {
  return clonePlain(BUILTIN_SERVERS) || {}
}

/**
 * 获取某个内置服务的工具定义
 */
export function getBuiltinTools(serverId = '') {
  const servers = getBuiltinServers()
  const server = servers?.[serverId]

  if (!server || !Array.isArray(server.tools)) {
    return []
  }

  return server.tools.map((tool) => ({ ...tool }))
}

/**
 * 调用内置工具
 */
export async function invokeBuiltinTool(toolName, _toolArgs = {}, _signal = null, _context = null) {
  throw new Error(`[mcp_builtin] builtin tool "${toolName}" is not registered in desktop runtime`)
}

/**
 * 兼容旧链路：后台 shell 请求
 */
export async function handleBgShellRequest(action, _payload) {
  throw new Error(`[mcp_builtin] background shell action "${action}" is not supported in desktop runtime yet`)
}

/**
 * 兼容旧链路：清理后台 shell
 */
export function killAllBackgroundShells() {
  return {
    ok: true,
    killed: 0
  }
}
