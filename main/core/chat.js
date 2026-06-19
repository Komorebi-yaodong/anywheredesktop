import OpenAI from 'openai'
import { fetchWithProxy, BRIDGE_UA_HEADER } from './net.js'
import { createAnthropicCompletion } from './anthropic.js'

const CHAT_REQUEST_TIMEOUT_MS = 120_000

const DEFAULT_CHAT_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
  'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8'
}

// 不允许用户自定义、可能破坏请求的请求头（小写比较）
const FORBIDDEN_HEADER_NAMES = new Set(['host', 'content-length', 'transfer-encoding', 'connection'])

// Codex 客户端指纹：anyrouter 等服务商会校验请求是否来自官方 Codex CLI
const CODEX_USER_AGENT = 'codex_cli_rs/0.114.0 (Mac OS 14.2.0; x86_64) vscode/1.111.0'
const CODEX_ORIGINATOR = 'codex-tui'

// 归一化服务商自定义请求头：过滤空值、含换行符与危险请求头，返回普通对象
function normalizeProviderHeaders(headers) {
  const result = {}
  if (!headers || typeof headers !== 'object') return result

  for (const [rawKey, rawValue] of Object.entries(headers)) {
    const key = typeof rawKey === 'string' ? rawKey.trim() : ''
    const value = rawValue == null ? '' : String(rawValue).trim()

    if (!key || !value) continue
    if (/[\r\n]/.test(key) || /[\r\n]/.test(value)) continue
    if (FORBIDDEN_HEADER_NAMES.has(key.toLowerCase())) continue

    result[key] = value
  }

  return result
}

// 合并多组请求头，后者覆盖前者；按名称大小写不敏感去重（保留最后出现的键名与值）
function mergeHeaders(...headerGroups) {
  const merged = {}
  const lowerKeyToActualKey = new Map()

  for (const group of headerGroups) {
    if (!group || typeof group !== 'object') continue
    for (const [key, value] of Object.entries(group)) {
      if (!key) continue
      const lowerKey = key.toLowerCase()
      const existingKey = lowerKeyToActualKey.get(lowerKey)
      if (existingKey && existingKey !== key) {
        delete merged[existingKey]
      }
      merged[key] = value
      lowerKeyToActualKey.set(lowerKey, key)
    }
  }

  return merged
}

// User-Agent 会被 Electron net.fetch 丢弃（Chromium 受保护头），改写为中转头，由主进程 onBeforeSendHeaders 还原为真正的 User-Agent
function applyUserAgentBridge(headers) {
  const result = {}
  for (const [key, value] of Object.entries(headers || {})) {
    if (key.toLowerCase() === 'user-agent') {
      result[BRIDGE_UA_HEADER] = value
    } else {
      result[key] = value
    }
  }
  return result
}

/**
 * 随机获取列表中的一项（用于 API Key 负载均衡）
 * @param {string | string[] | unknown} list
 * @returns {string | unknown}
 */
export function getRandomItem(list) {
  if (!list) return ''

  if (Array.isArray(list)) {
    if (list.length === 0) return ''
    return list[Math.floor(Math.random() * list.length)]
  }

  if (typeof list === 'string') {
    // 支持中文或英文逗号分隔
    const separator = list.includes('，') ? '，' : ','
    const items = list
      .split(separator)
      .map((item) => item.trim())
      .filter((item) => item !== '')

    if (items.length === 0) return ''
    return items[Math.floor(Math.random() * items.length)]
  }

  return list
}


function buildModelsEndpoint(baseUrl = '') {
  const normalized = String(baseUrl || '').trim().replace(/\/+$/, '')
  if (!normalized) {
    throw new Error('[Chat] baseUrl is required')
  }
  return `${normalized}/models`
}

export async function listProviderModels(params = {}) {
  const baseUrl = typeof params?.baseUrl === 'string' ? params.baseUrl : ''
  const apiKey = getRandomItem(params?.apiKey)
  const endpoint = buildModelsEndpoint(baseUrl)

  const headers = applyUserAgentBridge(mergeHeaders(
    { 'Content-Type': 'application/json' },
    normalizeProviderHeaders(params?.headers)
  ))

  if (apiKey) {
    headers.Authorization = `Bearer ${apiKey}`
  }

  const response = await fetchWithProxy(endpoint, {
    method: 'GET',
    headers
  })

  const rawText = await response.text()
  let payload = {}

  if (rawText) {
    try {
      payload = JSON.parse(rawText)
    } catch {
      payload = { message: rawText }
    }
  }

  if (!response.ok) {
    throw new Error(payload?.message || response.statusText || 'fetch_models_failed')
  }

  const models = Array.isArray(payload?.data)
    ? payload.data
        .map((item) => ({
          id: typeof item?.id === 'string' ? item.id : '',
          owned_by: typeof item?.owned_by === 'string' ? item.owned_by : ''
        }))
        .filter((item) => item.id)
    : []

  return {
    success: true,
    models
  }
}


/**
 * 适配 Chat Completions 的 tools 格式到 Responses API 格式
 * Responses API 的 function 定义是扁平的，不需要外层的 type: 'function' 包裹
 */
function adaptToolsForResponses(tools) {
  if (!tools || !Array.isArray(tools)) return undefined

  return tools.map((tool) => {
    if (tool?.type === 'function' && tool.function) {
      return {
        type: 'function',
        name: tool.function.name,
        description: tool.function.description,
        parameters: tool.function.parameters,
        // Responses API 默认为 strict: true，但如果使用了 strict 则 schema 必须符合严格标准
        // 这里为了兼容性，如果原配置有 strict 则传递，否则不传（让 API 决定或非严格）
        strict: tool.function.strict
      }
    }

    return tool
  })
}

/**
 * 将 Chat Completions 格式的消息历史转换为 Responses API 的 Input Items
 */

function shouldIncludeAssistantReasoningContent(reasoningEffort) {
  return typeof reasoningEffort === 'string' && !['', 'default', 'none'].includes(reasoningEffort)
}

function normalizeMessagesForChatCompletions(messages = [], reasoningEffort) {
  if (!Array.isArray(messages)) return []

  const shouldBackfillReasoningContent = shouldIncludeAssistantReasoningContent(reasoningEffort)

  return messages.map((msg) => {
    if (!msg || typeof msg !== 'object') return msg

    const nextMsg = { ...msg }
    if (nextMsg.role === 'assistant') {
      const hasReasoningContent = typeof nextMsg.reasoning_content === 'string'
      if (hasReasoningContent) {
        nextMsg.reasoning_content = nextMsg.reasoning_content
      } else if (shouldBackfillReasoningContent) {
        nextMsg.reasoning_content = ''
      }
    }

    return nextMsg
  })
}

function convertMessagesToResponsesInput(messages = []) {
  const inputItems = []
  const normalizedMessages = normalizeMessagesForChatCompletions(messages)

  for (const msg of normalizedMessages) {
    // 1. Role 映射 (Responses API 使用 developer 代替 system)
    let role = msg?.role
    if (role === 'system') role = 'developer'

    // 2. 处理工具返回结果 (保持 type: function_call_output)
    if (role === 'tool') {
      inputItems.push({
        type: 'function_call_output',
        call_id: msg.tool_call_id,
        output: typeof msg.content === 'string' ? msg.content : JSON.stringify(msg.content)
      })
      continue
    }

    // 3. 处理常规消息 (User / Assistant / Developer)
    if (role === 'assistant' || role === 'user' || role === 'developer') {
      const contentList = []

      // [关键修复] 根据角色决定文本类型
      // Assistant 的输出历史必须标记为 output_text，用户的输入标记为 input_text
      const textType = role === 'assistant' ? 'output_text' : 'input_text'

      // 情况A: 字符串内容
      if (typeof msg.content === 'string') {
        if (msg.content) {
          contentList.push({ type: textType, text: msg.content })
        }
      }
      // 情况B: 数组内容 -> 逐项转换类型
      else if (Array.isArray(msg.content)) {
        for (const item of msg.content) {
          // 文本转换
          if (item?.type === 'text') {
            contentList.push({ type: textType, text: item.text })
          }
          // 图片/文件转换 (仅限非 Assistant 角色，Assistant 历史通常不包含输入型多模态数据)
          else if (role !== 'assistant') {
            if (item?.type === 'image_url') {
              const url = item.image_url?.url || item.image_url
              contentList.push({
                type: 'input_image',
                image_url: url
              })
            } else if (item?.type === 'file' || item?.type === 'input_file') {
              const fileInput = item.file || item
              contentList.push({
                type: 'input_file',
                filename: fileInput.filename || fileInput.name,
                file_data: fileInput.file_data || fileInput.url
              })
            } else {
              // 保留其他可能的类型 (如 input_audio)
              contentList.push(item)
            }
          }
        }
      }

      // 只有当 contentList 不为空时才添加 message item
      if (contentList.length > 0) {
        inputItems.push({
          type: 'message',
          role,
          content: contentList
        })
      }

      // 4. 特殊处理 Assistant 的工具调用 (保持 type: function_call)
      // 在 Responses API 中，function_call 是独立的 item，跟在 message item 后面
      if (role === 'assistant' && Array.isArray(msg.tool_calls)) {
        for (const toolCall of msg.tool_calls) {
          inputItems.push({
            type: 'function_call',
            call_id: toolCall.id,
            name: toolCall.function?.name,
            arguments: toolCall.function?.arguments
          })
        }
      }
    }
  }

  return inputItems
}

/**
 * 创建并执行聊天请求
 * @param {object} params - 请求参数
 * @param {string} params.baseUrl - API 基础地址
 * @param {string|string[]} params.apiKey - API 密钥 (支持多 Key)
 * @param {string} params.model - 模型名称
 * @param {Array} params.messages - 消息列表
 * @param {'chat_completions' | 'responses'} [params.apiType='chat_completions'] - API 类型
 * @param {boolean} [params.stream=true] - 是否流式
 * @param {number} [params.temperature] - 温度
 * @param {string} [params.reasoning_effort] - 推理强度 (o1/o3 模型)
 * @param {Array} [params.tools] - 工具列表
 * @param {string|object} [params.tool_choice] - 工具选择策略
 * @param {object} [params.audio] - 音频配置
 * @param {Array} [params.modalities] - 模态配置
 * @param {AbortSignal} [params.signal] - 中断信号
 * @returns {Promise<any>} 返回流 (Stream) 或完整响应对象
 */
export async function createChatCompletion(params = {}) {
  const { baseUrl, apiKey, signal, apiType = 'chat_completions', headers: providerHeaders, ...openAiParams } = params

  if (!baseUrl || typeof baseUrl !== 'string') {
    throw new Error('[Chat] baseUrl is required')
  }

  if (apiType === 'claude') {
    return await createAnthropicCompletion({
      baseUrl,
      apiKey,
      signal,
      stream: params.stream ?? true,
      headers: applyUserAgentBridge(mergeHeaders(DEFAULT_CHAT_HEADERS, normalizeProviderHeaders(providerHeaders))),
      ...openAiParams
    })
  }

  const client = new OpenAI({
    baseURL: baseUrl,
    apiKey: getRandomItem(apiKey),
    maxRetries: 3,
    dangerouslyAllowBrowser: true,
    fetch: (input, init = {}) =>
      fetchWithProxy(input, {
        ...init,
        timeoutMs: init?.timeoutMs ?? CHAT_REQUEST_TIMEOUT_MS
      }),
    defaultHeaders: applyUserAgentBridge(mergeHeaders(DEFAULT_CHAT_HEADERS, normalizeProviderHeaders(providerHeaders)))
  })

  try {
    if (apiType === 'responses' || apiType === 'codex') {
      const isCodex = apiType === 'codex'
      const convertedInput = convertMessagesToResponsesInput(openAiParams.messages)

      // Responses API 参数映射
      const responseParams = {
        model: openAiParams.model,
        input: convertedInput,
        stream: params.stream ?? true
      }

      if (openAiParams.tools) {
        responseParams.tools = adaptToolsForResponses(openAiParams.tools)
      }

      // Chat Completions: "auto" / "none" / { type: "function", function: { name: "..." } }
      // Responses: "auto" / "none" / "required" / { type: "function", name: "..." }
      if (openAiParams.tool_choice) {
        if (typeof openAiParams.tool_choice === 'object' && openAiParams.tool_choice.function) {
          responseParams.tool_choice = {
            type: 'function',
            name: openAiParams.tool_choice.function.name
          }
        } else {
          responseParams.tool_choice = openAiParams.tool_choice
        }
      }

      if (openAiParams.reasoning_effort) {
        responseParams.reasoning = {
          effort: openAiParams.reasoning_effort,
          summary: 'auto'
        }
      }

      if (isCodex) {
        // Codex Responses 必备字段；Codex 上游拒绝 temperature/top_p 等
        // 将 system/developer 提升为顶层 instructions，input 仅保留对话（符合 Codex 语义）
        const developerTexts = convertedInput
          .filter((item) => item.role === 'developer')
          .flatMap((item) => (Array.isArray(item.content) ? item.content : []))
          .map((c) => (typeof c?.text === 'string' ? c.text : ''))
          .filter(Boolean)
        const explicitInstructions = typeof openAiParams.instructions === 'string' ? openAiParams.instructions : ''
        responseParams.instructions = explicitInstructions || developerTexts.join('\n\n')
        responseParams.input = convertedInput.filter((item) => item.role !== 'developer')
        responseParams.store = false
        responseParams.include = ['reasoning.encrypted_content']
        responseParams.parallel_tool_calls = true
      } else if (openAiParams.temperature !== undefined) {
        responseParams.temperature = openAiParams.temperature
      }

      const responsesRequestOptions = { signal }
      if (isCodex) {
        // Codex 客户端指纹：codex UA（经中转头绕过 Chromium 限制）+ Originator；用户自定义 headers 优先
        responsesRequestOptions.headers = applyUserAgentBridge(mergeHeaders(
          { 'User-Agent': CODEX_USER_AGENT, 'Originator': CODEX_ORIGINATOR },
          normalizeProviderHeaders(providerHeaders)
        ))
      }

      return await client.responses.create(responseParams, responsesRequestOptions)
    }

    // 标准 Chat Completions API
    const normalizedMessages = normalizeMessagesForChatCompletions(openAiParams.messages, openAiParams.reasoning_effort)
    const chatCompletionParams = {
      ...openAiParams,
      messages: normalizedMessages,
      stream: params.stream ?? true
    }

    if (chatCompletionParams.stream) {
      chatCompletionParams.stream_options = {
        ...(openAiParams.stream_options || {}),
        include_usage: true
      }
    }

    return await client.chat.completions.create(
      chatCompletionParams,
      { signal }
    )
  } catch (error) {
    console.error('[Chat] Request failed:', error)
    throw error
  }
}
