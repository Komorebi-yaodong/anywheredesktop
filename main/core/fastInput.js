import { randomUUID } from 'node:crypto'
import * as chatApi from './chat.js'
import * as fileApi from './file.js'
import * as systemApi from './system.js'
import { defaultConfig, getConfig, resolveDefaultAssistantModel } from './data.js'

const FAST_INPUT_EVENT_CHANNEL = 'fast-input:event'
const fastInputSessionStore = new WeakMap()

function getOsName() {
  if (process.platform === 'darwin') return 'macos'
  if (process.platform === 'win32') return 'win'
  return 'linux'
}

function normalizeText(value) {
  if (typeof value === 'string') return value
  if (value == null) return ''
  return String(value)
}

function resolvePromptCode(payload = {}) {
  if (typeof payload?.code === 'string' && payload.code.trim()) {
    return payload.code.trim()
  }
  if (typeof payload?.promptKey === 'string' && payload.promptKey.trim()) {
    return payload.promptKey.trim()
  }
  return 'AI'
}

function resolvePromptConfig(fullConfig = {}, payload = {}, code = 'AI') {
  if (payload?.tempPromptConfig && typeof payload.tempPromptConfig === 'object') {
    return { ...payload.tempPromptConfig }
  }

  const prompts = fullConfig?.prompts && typeof fullConfig.prompts === 'object' ? fullConfig.prompts : {}
  return (
    prompts[code] ||
    prompts.AI ||
    defaultConfig.config.prompts.AI ||
    {}
  )
}

function pickPromptModel(fullConfig = {}, promptConfig = {}) {
  if (typeof promptConfig?.model === 'string' && promptConfig.model.trim()) {
    return promptConfig.model.trim()
  }

  const resolvedDefaultModel = resolveDefaultAssistantModel(fullConfig)
  if (typeof resolvedDefaultModel === 'string' && resolvedDefaultModel.trim()) {
    return resolvedDefaultModel.trim()
  }

  return ''
}

function resolveProviderConfig(fullConfig = {}, promptConfig = {}) {
  const modelValue = pickPromptModel(fullConfig, promptConfig)
  const [providerId, ...modelParts] = modelValue.split('|')
  const modelName = modelParts.join('|').trim()
  const providers = fullConfig?.providers && typeof fullConfig.providers === 'object' ? fullConfig.providers : {}
  const provider = providerId ? providers[providerId] : null

  return {
    modelValue,
    modelName,
    providerId: providerId || '',
    provider: provider || null,
    apiType: provider?.apiType || 'chat_completions',
    baseUrl: provider?.url || '',
    apiKey: provider?.api_key || ''
  }
}

function buildTimestampText() {
  const now = new Date()
  const year = now.getFullYear()
  const month = String(now.getMonth() + 1).padStart(2, '0')
  const day = String(now.getDate()).padStart(2, '0')
  const hours = String(now.getHours()).padStart(2, '0')
  const minutes = String(now.getMinutes()).padStart(2, '0')
  return `current time: ${year}-${month}-${day} ${hours}:${minutes}`
}

function appendTextToMessageContent(content, text) {
  const normalizedText = normalizeText(text).trim()
  if (!normalizedText) return content

  if (typeof content === 'string') {
    return content.trim() ? `${content}\n${normalizedText}` : normalizedText
  }

  if (Array.isArray(content)) {
    return [...content, { type: 'text', text: normalizedText }]
  }

  return normalizedText
}

function applyIfTextNecessary(messages = [], enabled = false) {
  if (!enabled) return messages

  const timestamp = buildTimestampText()
  return messages.map((message) => {
    if (!message || message.role !== 'user') return message

    if (message.content == null) {
      return { ...message, content: timestamp }
    }

    if (typeof message.content === 'string') {
      return message.content.trim()
        ? message
        : { ...message, content: timestamp }
    }

    if (Array.isArray(message.content)) {
      const hasText = message.content.some((part) => part?.type === 'text' && normalizeText(part?.text).trim())
      if (hasText) return message
      return {
        ...message,
        content: [...message.content, { type: 'text', text: timestamp }]
      }
    }

    return message
  })
}

async function buildUserMessageFromPayload(payload = {}, promptConfig = {}) {
  const payloadType = typeof payload?.type === 'string' && payload.type ? payload.type : 'empty'
  const payloadValue = payload?.payload ?? ''
  const normalizedUserText = normalizeText(payload?.userText).trim()
  const directSendText = promptConfig?.isDirectSend_normal !== false
  const directSendImage = promptConfig?.isDirectSend_image !== false
  const directSendFile = Boolean(promptConfig?.isDirectSend_file)

  if (payloadType === 'multiline-text') {
    const textContent = normalizeText(payloadValue).trim()
    if (!textContent) {
      return { mode: 'noop', inputText: '' }
    }

    if (directSendText) {
      return {
        mode: 'request',
        message: { role: 'user', content: textContent },
        inputText: ''
      }
    }

    return {
      mode: 'input-only',
      inputText: normalizeText(payloadValue)
    }
  }

  if (payloadType === 'over') {
    const textContent = normalizeText(payloadValue).trim()
    if (!textContent) {
      return { mode: 'noop', inputText: '' }
    }

    if (directSendText) {
      return {
        mode: 'request',
        message: { role: 'user', content: textContent },
        inputText: ''
      }
    }

    return {
      mode: 'input-only',
      inputText: textContent
    }
  }

  if (payloadType === 'img') {
    const imageUrl = normalizeText(payloadValue)
    if (!imageUrl) {
      return {
        mode: normalizedUserText ? 'input-only' : 'noop',
        inputText: normalizedUserText
      }
    }

    if (directSendImage) {
      let content = [{ type: 'image_url', image_url: { url: imageUrl } }]
      if (normalizedUserText) {
        content = appendTextToMessageContent(content, normalizedUserText)
      }
      return {
        mode: 'request',
        message: { role: 'user', content },
        inputText: ''
      }
    }

    return {
      mode: 'input-only',
      inputText: normalizedUserText,
      deferredAttachments: [
        {
          uid: 1,
          name: '截图.png',
          size: 0,
          type: 'image/png',
          url: imageUrl
        }
      ]
    }
  }

  if (payloadType === 'files') {
    const payloadList = Array.isArray(payloadValue) ? payloadValue : []
    if (payloadList.length === 0) {
      return {
        mode: normalizedUserText ? 'input-only' : 'noop',
        inputText: normalizedUserText
      }
    }

    const contentList = []
    const deferredAttachments = []

    for (let index = 0; index < payloadList.length; index += 1) {
      const item = payloadList[index]
      if (!item || typeof item !== 'object') continue

      if (typeof item.path === 'string' && item.path.trim()) {
        const normalizedPath = item.path.trim()
        if (directSendFile) {
          const parsed = await fileApi.sendfileDirect([{ path: normalizedPath }])
          if (Array.isArray(parsed) && parsed.length > 0) {
            contentList.push(...parsed)
          }
        } else {
          const fileObject = await fileApi.handleFilePath(normalizedPath)
          if (fileObject) {
            deferredAttachments.push({
              uid: index + 1,
              name: fileObject.name,
              size: fileObject.size,
              type: fileObject.type,
              url: `data:${fileObject.type};base64,${fileObject.base64}`,
              path: fileObject.path || normalizedPath
            })
          }
        }
        continue
      }

      if (typeof item.dataUrl === 'string' && item.dataUrl.startsWith('data:')) {
        if (directSendFile) {
          const parsed = await fileApi.parseFileObject({
            name: item.name || `clipboard-image-${index + 1}.png`,
            type: item.type || 'image/png',
            url: item.dataUrl
          })
          if (parsed) {
            contentList.push(parsed)
          }
        } else {
          deferredAttachments.push({
            uid: index + 1,
            name: item.name || `clipboard-image-${index + 1}.png`,
            size: 0,
            type: item.type || 'image/png',
            url: item.dataUrl,
            path: ''
          })
        }
      }
    }

    if (contentList.length > 0) {
      let messageContent = contentList
      if (normalizedUserText) {
        messageContent = appendTextToMessageContent(messageContent, normalizedUserText)
      }
      return {
        mode: 'request',
        message: {
          role: 'user',
          content: messageContent.length === 1 && messageContent[0]?.type === 'text'
            ? messageContent[0].text
            : messageContent
        },
        inputText: '',
        deferredAttachments
      }
    }

    return {
      mode: deferredAttachments.length > 0 || normalizedUserText ? 'input-only' : 'noop',
      inputText: normalizedUserText,
      deferredAttachments
    }
  }

  return {
    mode: normalizedUserText ? 'input-only' : 'noop',
    inputText: normalizedUserText
  }
}

function emitFastInputEvent(win, type, payload = null) {
  if (!win || win.isDestroyed()) return false
  try {
    win.webContents.send(FAST_INPUT_EVENT_CHANNEL, { type, payload })
    return true
  } catch {
    return false
  }
}


function setFastInputSessionState(win, nextState = {}) {
  if (!win || win.isDestroyed()) return null
  const previous = fastInputSessionStore.get(win) || {}
  const merged = { ...previous, ...nextState }
  fastInputSessionStore.set(win, merged)
  return merged
}

function getFastInputSessionState(win) {
  if (!win || win.isDestroyed()) return null
  return fastInputSessionStore.get(win) || null
}

export function cancelFastInputSession(win, reason = 'cancelled') {
  const state = getFastInputSessionState(win)
  if (!state || !state.controller) {
    return { ok: false, reason: 'no_active_session' }
  }

  try {
    state.controller.abort(new Error(reason))
  } catch {
    // ignore abort race
  }

  setFastInputSessionState(win, {
    status: 'cancelled',
    cancelledAt: Date.now(),
    cancelReason: reason,
    active: false,
    controller: null
  })

  return { ok: true, reason }
}


async function buildFastInputInitPayload(payload = {}) {
  const configResult = await getConfig()
  const fullConfig =
    configResult?.config && typeof configResult.config === 'object'
      ? configResult.config
      : defaultConfig.config

  const code = resolvePromptCode(payload)
  const promptConfig = resolvePromptConfig(fullConfig, payload, code)
  const providerInfo = resolveProviderConfig(fullConfig, promptConfig)

  return {
    os: getOsName(),
    code,
    type: typeof payload?.type === 'string' && payload.type ? payload.type : 'empty',
    payload: payload?.payload ?? '',
    userText: normalizeText(payload?.userText),
    promptKey: typeof payload?.promptKey === 'string' ? payload.promptKey : code,
    triggerMode: typeof payload?.triggerMode === 'string' ? payload.triggerMode : '',
    config: {
      isDarkMode: Boolean(fullConfig?.isDarkMode)
    },
    promptConfig,
    providerInfo
  }
}

function resolveFastWindowBounds(promptConfig = {}) {
  const width = Number(promptConfig?.window_width)
  return {
    width: Number.isFinite(width) && width > 0 ? Math.max(340, Math.min(680, width)) : 460,
    height: 60
  }
}

function buildCreateRequestParams(initPayload = {}, messages = [], signal = undefined) {
  const promptConfig = initPayload?.promptConfig || {}
  const providerInfo = initPayload?.providerInfo || {}

  if (!providerInfo?.baseUrl || !providerInfo?.apiKey || !providerInfo?.modelName) {
    throw new Error('当前快捷助手未配置可用模型或服务商')
  }

  const requestParams = {
    baseUrl: providerInfo.baseUrl,
    apiKey: providerInfo.apiKey,
    model: providerInfo.modelName,
    apiType: providerInfo.apiType || 'chat_completions',
    messages: applyIfTextNecessary(messages, Boolean(promptConfig?.ifTextNecessary)),
    stream: promptConfig?.stream !== false,
    signal
  }

  if (promptConfig?.isTemperature) {
    requestParams.temperature = promptConfig.temperature
  }

  if (promptConfig?.reasoning_effort && promptConfig.reasoning_effort !== 'default') {
    requestParams.reasoning_effort = promptConfig.reasoning_effort
  }

  return requestParams
}

function extractChatCompletionChunk(part = {}, apiType = 'chat_completions') {
  if (apiType === 'responses') {
    if (part?.type === 'response.output_text.delta') {
      return normalizeText(part.delta)
    }
    return ''
  }

  const delta = part?.choices?.[0]?.delta
  if (!delta) return ''

  if (typeof delta.content === 'string') {
    return delta.content
  }

  if (Array.isArray(delta.content)) {
    return delta.content
      .map((item) => {
        if (typeof item === 'string') return item
        if (item?.type === 'text') return normalizeText(item.text)
        return ''
      })
      .join('')
  }

  return ''
}

function extractNonStreamText(response = {}, apiType = 'chat_completions') {
  if (apiType === 'responses') {
    if (typeof response?.output_text === 'string' && response.output_text) {
      return response.output_text
    }

    if (Array.isArray(response?.output)) {
      return response.output
        .flatMap((item) => Array.isArray(item?.content) ? item.content : [])
        .map((content) => {
          if (content?.type === 'output_text') return normalizeText(content.text)
          return ''
        })
        .join('')
    }

    return ''
  }

  return normalizeText(response?.choices?.[0]?.message?.content)
}

export async function startFastInputSession({ win, payload = {}, onCompleted } = {}) {
  if (!win || win.isDestroyed()) {
    throw new Error('fast_input window is not available')
  }

  const previousSession = getFastInputSessionState(win)
  if (previousSession?.active && previousSession.controller) {
    cancelFastInputSession(win, 'superseded')
  }

  const initPayload = await buildFastInputInitPayload(payload)
  if (typeof payload?.contextId === 'string' && payload.contextId) {
    try {
      await systemApi.markShortcutPayloadConsumed(payload.contextId)
    } catch {
      // ignore shortcut payload consume reporting failure
    }
  }
  const userMessageResult = await buildUserMessageFromPayload(payload, initPayload.promptConfig)
  const deferredAttachments = Array.isArray(userMessageResult?.deferredAttachments)
    ? userMessageResult.deferredAttachments
    : []

  emitFastInputEvent(win, 'session:init', {
    ...initPayload,
    inputText: userMessageResult?.inputText || '',
    deferredAttachments,
    canSubmit: userMessageResult?.mode === 'request',
    canPaste: true,
    canCopy: false
  })

  if (userMessageResult?.mode !== 'request' || !userMessageResult?.message) {
    const status = userMessageResult?.mode === 'input-only' ? 'input-only' : 'empty'
    const idleText =
      userMessageResult?.inputText ||
      (status === 'empty' ? '请先复制或选择文本、文件、图片后再召唤' : '')

    emitFastInputEvent(win, 'session:idle', {
      status,
      inputText: idleText,
      deferredAttachments,
      canSubmit: false,
      canPaste: Boolean(userMessageResult?.inputText),
      canCopy: false
    })

    setFastInputSessionState(win, {
      active: false,
      status,
      completedAt: Date.now(),
      text: idleText,
      autoCopied: false,
      controller: null,
      requestId: null
    })

    return {
      ok: true,
      status: userMessageResult?.mode || 'noop',
      inputText: idleText,
      deferredAttachments,
      initPayload
    }
  }

  const messages = []
  if (typeof initPayload?.promptConfig?.prompt === 'string' && initPayload.promptConfig.prompt.trim()) {
    messages.push({ role: 'system', content: initPayload.promptConfig.prompt.trim() })
  }
  messages.push(userMessageResult.message)

  emitFastInputEvent(win, 'session:start', {
    canSubmit: false,
    canPaste: false,
    canCopy: false
  })

  const controller = new AbortController()
  const requestParams = buildCreateRequestParams(initPayload, messages, controller.signal)
  const requestId = randomUUID()
  let finalText = ''

  setFastInputSessionState(win, {
    requestId,
    active: true,
    status: 'streaming',
    controller,
    startedAt: Date.now(),
    text: '',
    autoCopied: false,
    completedAt: 0,
    cancelReason: ''
  })

  try {
    if (requestParams.stream) {
      const stream = await chatApi.createChatCompletion(requestParams)
      for await (const part of stream) {
        const chunkText = extractChatCompletionChunk(part, requestParams.apiType)
        if (!chunkText) continue
        finalText += chunkText
        setFastInputSessionState(win, { text: finalText })
        emitFastInputEvent(win, 'session:chunk', {
          requestId,
          chunk: chunkText,
          text: finalText
        })
      }
    } else {
      const response = await chatApi.createChatCompletion(requestParams)
      finalText = extractNonStreamText(response, requestParams.apiType)
      setFastInputSessionState(win, { text: finalText })
      if (finalText) {
        emitFastInputEvent(win, 'session:chunk', {
          requestId,
          chunk: finalText,
          text: finalText
        })
      }
    }

    try {
      if (finalText.trim()) {
        await systemApi.copyText(finalText)
        setFastInputSessionState(win, { autoCopied: true })
      }
    } catch {
      // ignore auto copy failure
    }

    emitFastInputEvent(win, 'session:done', {
      requestId,
      text: finalText,
      autoCopied: Boolean(finalText.trim()),
      canSubmit: false,
      canPaste: true,
      canCopy: Boolean(finalText)
    })

    setFastInputSessionState(win, {
      active: false,
      status: 'done',
      controller: null,
      completedAt: Date.now(),
      text: finalText,
      requestId
    })

    if (typeof onCompleted === 'function') {
      onCompleted({
        requestId,
        text: finalText,
        promptCode: initPayload.code,
        deferredAttachments,
        inputText: userMessageResult?.inputText || ''
      })
    }

    return {
      ok: true,
      requestId,
      text: finalText,
      initPayload,
      deferredAttachments,
      inputText: userMessageResult?.inputText || ''
    }
  } catch (error) {
    const isAbortError = controller.signal.aborted || String(error?.name || '').toLowerCase().includes('abort')
    const errorText = finalText || (isAbortError ? '已取消快捷输入请求' : error?.message || '快捷输入执行失败')

    try {
      if (!isAbortError && errorText.trim()) {
        await systemApi.copyText(errorText)
        setFastInputSessionState(win, { autoCopied: true })
      }
    } catch {
      // ignore auto copy failure
    }

    emitFastInputEvent(win, 'session:error', {
      requestId,
      message: isAbortError ? '已取消快捷输入请求' : error?.message || '快捷输入执行失败',
      text: errorText,
      autoCopied: !isAbortError && Boolean(errorText.trim()),
      canSubmit: false,
      canPaste: true,
      canCopy: Boolean(errorText)
    })

    setFastInputSessionState(win, {
      active: false,
      status: isAbortError ? 'cancelled' : 'error',
      controller: null,
      completedAt: Date.now(),
      text: errorText,
      cancelReason: isAbortError ? 'cancelled' : '',
      requestId
    })

    if (isAbortError) {
      return {
        ok: false,
        aborted: true,
        requestId,
        text: errorText,
        initPayload,
        deferredAttachments,
        inputText: userMessageResult?.inputText || ''
      }
    }

    throw error
  } finally {
    try {
      controller.abort()
    } catch {
      // ignore final abort cleanup race
    }
  }
}

export function getFastInputEventChannel() {
  return FAST_INPUT_EVENT_CHANNEL
}

export function getFastInputRecommendedBounds(promptConfig = {}) {
  return resolveFastWindowBounds(promptConfig)
}
