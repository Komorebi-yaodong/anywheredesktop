import crypto from 'node:crypto'
import { normalizeIdentifier, remoteError } from './protocol.js'
import { getQuickAssistantWeight } from '../quickAssistantUsage.js'

const REQUEST_TTL_MS = 30 * 60 * 1000
const MAX_REQUESTS = 256
const MAX_RECOVERY_CHARS = 64 * 1024
const TERMINAL_EVENTS = new Set([
  'assistant.completed', 'assistant.cancelled', 'assistant.failed',
  'conversation.operation.completed', 'conversation.operation.failed', 'conversation.config.result',
  'conversation.compact.completed', 'conversation.compact.cancelled', 'conversation.compact.failed'
])
const RENDERER_EVENTS = new Set([
  'conversation.command.acknowledged', 'assistant.started', 'assistant.delta',
  'conversation.choice.required', 'conversation.tasks.updated', 'conversation.compact.progress', ...TERMINAL_EVENTS
])
const PATH_KEYS = new Set([
  'path', 'filepath', 'file_path', 'dirpath', 'dir_path', 'dbfile', 'db_file',
  'legacyjson', 'legacy_json', 'worktreedir', 'worktree_dir', 'localchatpath', 'local_chat_path'
])
const text = (value, limit = 160) => typeof value === 'string' ? value.slice(0, limit) : ''
const object = (value) => value && typeof value === 'object' && !Array.isArray(value) ? value : {}
const id = (value, field) => normalizeIdentifier(value, field, { minLength: field === 'requestId' ? 8 : 16, maxLength: 160 })


function normalizeUploadIds(value) {
  if (value === undefined) return []
  if (!Array.isArray(value) || value.length > 16) throw remoteError('remote_upload_ids_invalid')
  const uploadIds = value.map((item) => id(item, 'uploadId'))
  if (new Set(uploadIds).size !== uploadIds.length) throw remoteError('remote_upload_ids_invalid')
  return uploadIds
}

function parameters(input, allowedKeys) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw remoteError('remote_parameter_invalid')
  for (const key of Object.keys(input)) {
    if (PATH_KEYS.has(key.toLowerCase())) throw remoteError('remote_path_parameter_forbidden')
    if (!allowedKeys.includes(key)) throw remoteError('remote_parameter_unknown')
  }
  return input
}

const CONFIG_PATCH_KEYS = new Set(['model', 'reasoningEffort', 'voice', 'mcpServerIds', 'skillIds', 'systemPrompt', 'compact'])
const COMPACT_PATCH_KEYS = new Set(['autoCompactEnabled', 'triggerRatio', 'contextLength', 'keepRecentRounds', 'hideCompactedMessages', 'compactPrompt'])

function stringArray(value, field) {
  if (!Array.isArray(value) || value.length > 128) throw remoteError('remote_session_config_invalid')
  const list = value.map((item) => typeof item === 'string' ? item.trim() : '').filter(Boolean)
  if (list.some((item) => item.length > 160)) throw remoteError('remote_session_config_invalid')
  return [...new Set(list)]
}

function normalizeConfigPatch(value) {
  const source = object(value)
  for (const key of Object.keys(source)) {
    if (!CONFIG_PATCH_KEYS.has(key)) throw remoteError('remote_parameter_unknown')
  }
  const patch = {}
  if (Object.hasOwn(source, 'model')) patch.model = text(source.model, 320).trim()
  if (Object.hasOwn(source, 'reasoningEffort')) patch.reasoningEffort = text(source.reasoningEffort, 32).trim()
  if (Object.hasOwn(source, 'voice')) patch.voice = source.voice == null ? '' : text(source.voice, 160).trim()
  if (Object.hasOwn(source, 'mcpServerIds')) patch.mcpServerIds = stringArray(source.mcpServerIds, 'mcpServerIds')
  if (Object.hasOwn(source, 'skillIds')) patch.skillIds = stringArray(source.skillIds, 'skillIds')
  if (Object.hasOwn(source, 'systemPrompt')) {
    if (typeof source.systemPrompt !== 'string' || source.systemPrompt.length > 256 * 1024) throw remoteError('remote_session_config_invalid')
    patch.systemPrompt = source.systemPrompt
  }
  if (Object.hasOwn(source, 'compact')) {
    const compact = object(source.compact)
    for (const key of Object.keys(compact)) if (!COMPACT_PATCH_KEYS.has(key)) throw remoteError('remote_parameter_unknown')
    patch.compact = {}
    if (Object.hasOwn(compact, 'autoCompactEnabled')) patch.compact.autoCompactEnabled = compact.autoCompactEnabled === true
    if (Object.hasOwn(compact, 'hideCompactedMessages')) patch.compact.hideCompactedMessages = compact.hideCompactedMessages === true
    if (Object.hasOwn(compact, 'triggerRatio')) {
      const number = Number(compact.triggerRatio)
      if (!Number.isFinite(number) || number < 0.1 || number > 0.99) throw remoteError('remote_session_config_invalid')
      patch.compact.triggerRatio = number
    }
    if (Object.hasOwn(compact, 'contextLength')) {
      const number = Math.floor(Number(compact.contextLength))
      if (!Number.isFinite(number) || number < 4096 || number > 10_000_000) throw remoteError('remote_session_config_invalid')
      patch.compact.contextLength = number
    }
    if (Object.hasOwn(compact, 'keepRecentRounds')) {
      const number = Math.floor(Number(compact.keepRecentRounds))
      if (!Number.isFinite(number) || number < 0 || number > 100) throw remoteError('remote_session_config_invalid')
      patch.compact.keepRecentRounds = number
    }
    if (Object.hasOwn(compact, 'compactPrompt')) {
      if (typeof compact.compactPrompt !== 'string' || compact.compactPrompt.length > 128 * 1024) throw remoteError('remote_session_config_invalid')
      patch.compact.compactPrompt = compact.compactPrompt
    }
  }
  if (!Object.keys(patch).length) throw remoteError('remote_session_config_patch_empty')
  return patch
}

function sanitizeConfigResult(source = {}) {
  const config = object(source.config)
  const options = object(source.options)
  return {
    revision: Math.max(0, Math.floor(Number(source.revision) || 0)),
    patched: stringArray(Array.isArray(source.patched) ? source.patched : [], 'patched'),
    config: {
      model: text(config.model, 320), reasoningEffort: text(config.reasoningEffort, 32), voice: text(config.voice, 160),
      mcpServerIds: stringArray(config.mcpServerIds || [], 'mcpServerIds'), skillIds: stringArray(config.skillIds || [], 'skillIds'),
      systemPrompt: text(config.systemPrompt, 256 * 1024), compact: {
        autoCompactEnabled: config.compact?.autoCompactEnabled !== false,
        triggerRatio: Number(config.compact?.triggerRatio) || 0.9,
        contextLength: Math.max(0, Math.floor(Number(config.compact?.contextLength) || 0)),
        keepRecentRounds: Math.max(0, Math.floor(Number(config.compact?.keepRecentRounds) || 0)),
        hideCompactedMessages: config.compact?.hideCompactedMessages !== false,
        compactPrompt: text(config.compact?.compactPrompt, 128 * 1024)
      }
    },
    options: {
      models: (Array.isArray(options.models) ? options.models : []).slice(0, 1000).map((item) => ({ value: text(item?.value, 320), label: text(item?.label, 240) })),
      reasoningEfforts: stringArray(options.reasoningEfforts || [], 'reasoningEfforts'),
      voices: stringArray(options.voices || [], 'voices'),
      mcpServers: (Array.isArray(options.mcpServers) ? options.mcpServers : []).slice(0, 256).map((item) => ({ id: text(item?.id, 160), name: text(item?.name, 240) })),
      skills: (Array.isArray(options.skills) ? options.skills : []).slice(0, 512).map((item) => ({ id: text(item?.id, 160), name: text(item?.name, 240) }))
    }
  }
}


function sanitizeTasks(value) {
  if (!Array.isArray(value) || value.length > 128) return []
  const status = (input) => ['pending', 'in_progress', 'completed'].includes(input) ? input : 'pending'
  return value.map((task) => ({
    content: text(task?.content, 1200).trim(),
    status: status(text(task?.status, 32)),
    steps: Array.isArray(task?.steps) ? task.steps.slice(0, 64).map((step) => ({
      content: text(step?.content, 1200).trim(),
      status: status(text(step?.status, 32))
    })).filter((step) => step.content) : []
  })).filter((task) => task.content)
}


function sanitizeChoiceQuestions(value) {
  if (!Array.isArray(value) || value.length === 0 || value.length > 12) return []
  return value.map((question) => {
    const source = object(question)
    const options = Array.isArray(source.options) ? source.options.slice(0, 12).map((option) => ({
      label: text(option?.label, 240).trim(),
      description: text(option?.description, 600).trim()
    })).filter((option) => option.label) : []
    return {
      question: text(source.question, 1200).trim(),
      header: text(source.header, 80).trim(),
      options
    }
  }).filter((question) => question.question && question.options.length > 0)
}

function normalizeChoiceResponses(value, questions) {
  if (!Array.isArray(value) || value.length !== questions.length || questions.length === 0) throw remoteError('remote_choice_invalid')
  return value.map((response, index) => {
    const source = object(response)
    const type = text(source.type, 16)
    const question = questions[index]
    if (Number(source.questionIndex) !== index || !['options', 'custom', 'discuss'].includes(type)) throw remoteError('remote_choice_invalid')
    if (type === 'options') {
      const selected = stringArray(source.selected, 'selected').slice(0, 1)
      if (selected.length !== 1 || !question.options.some((option) => option.label === selected[0])) throw remoteError('remote_choice_invalid')
      return { questionIndex: index, type, selected, question: question.question }
    }
    if (type === 'custom') {
      const customText = text(source.customText, 4096).trim()
      if (!customText) throw remoteError('remote_choice_invalid')
      return { questionIndex: index, type, customText, question: question.question }
    }
    return { questionIndex: index, type, question: question.question }
  })
}


function sanitizeEvent(event, payload) {
  const source = object(payload)
  if (event === 'assistant.delta') return {
    textDelta: text(source.textDelta, 16 * 1024),
    reasoningDelta: text(source.reasoningDelta, 16 * 1024),
    segmentId: text(source.segmentId, 80),
    status: text(source.status, 80)
  }
  if (event === 'assistant.failed' || event === 'conversation.operation.failed') return {
    code: /^remote_[a-z0-9_]+$/.test(source.code) ? source.code : 'remote_operation_failed'
  }
  if (event === 'assistant.started') return { startedAt: text(source.startedAt, 80) }
  if (event === 'conversation.choice.required') return {
    toolCallId: text(source.toolCallId, 160),
    questions: sanitizeChoiceQuestions(source.questions)
  }
  if (event === 'conversation.tasks.updated') return { tasks: sanitizeTasks(source.tasks) }
  if (event === 'conversation.config.result') return sanitizeConfigResult(source)

  if (event === 'conversation.compact.progress') return {
    percent: Math.min(100, Math.max(0, Number(source.percent) || 0)),
    stage: text(source.stage, 80), message: text(source.message, 240)
  }
  if (event === 'conversation.compact.failed') return {
    code: /^remote_[a-z0-9_]+$/.test(source.code) ? source.code : 'remote_compact_failed'
  }
  if (event === 'conversation.compact.completed' || event === 'conversation.compact.cancelled') return {
    completedAt: text(source.completedAt, 80), revision: Math.max(0, Math.floor(Number(source.revision) || 0)),
    changed: source.changed === true
  }
  if (TERMINAL_EVENTS.has(event)) return {
    completedAt: text(source.completedAt, 80), revision: Math.max(0, Math.floor(Number(source.revision) || 0)),
    operation: text(source.operation, 40), uiMessageId: text(source.uiMessageId, 160),
    title: text(source.title, 240), deleted: source.deleted === true
  }
  return { hidden: source.hidden === true, created: source.created === true }
}

/** Main-process routing only. Renderer remains the sole conversation writer/lease holder. */
export function createRemoteSessionManager({
  getConfig, openConversation, listWindows, openWindow, getWindowByRef,
  readLocalProjects = async () => ({ projects: [] }), dispatchRemoteCommandToWindow, revealRemoteConversationWindow, broadcastToDevice,
  recordAssistantUsage = async () => {}, uploadManager = null, readinessTimeoutMs = 12000, onWindowClosed = null
} = {}) {
  for (const [name, value] of Object.entries({
    getConfig, openConversation, listWindows, openWindow, getWindowByRef, readLocalProjects,
    dispatchRemoteCommandToWindow, revealRemoteConversationWindow, broadcastToDevice, recordAssistantUsage
  })) {
    if (typeof value !== 'function') throw new Error(`remote_session_${name}_required`)
  }
  const sessions = new Map()
  const creations = new Map()
  const queues = new Map()
  const requests = new Map()
  const revokedDevices = new Set()
  const deletedConversations = new Set()
  let enabled = true
  let generation = 0
  let closing = null

  const windows = () => listWindows('window') || []
  const windowItem = (windowRef) => windows().find((item) => item.id === windowRef)
  const requestKey = (deviceId, requestId) => `${deviceId}:${requestId}`

  function pruneRequests() {
    const now = Date.now()
    for (const [key, request] of requests) {
      if (request.terminal && now - request.updatedAtMs > REQUEST_TTL_MS) requests.delete(key)
    }
    while (requests.size >= MAX_REQUESTS) {
      const entry = [...requests].find(([, request]) => request.terminal)
      if (!entry) throw remoteError('remote_request_limit_reached')
      requests.delete(entry[0])
    }
  }

  function assertActive(epoch, deviceId) {
    if (!enabled || epoch !== generation) throw remoteError('remote_gateway_stopped')
    if (revokedDevices.has(deviceId)) throw remoteError('remote_device_revoked')
  }

  function serialize(conversationId, operation) {
    const previous = queues.get(conversationId) || Promise.resolve()
    const next = previous.catch(() => {}).then(operation)
    queues.set(conversationId, next)
    next.finally(() => { if (queues.get(conversationId) === next) queues.delete(conversationId) }).catch(() => {})
    return next
  }

  function remember(conversationId, item) {
    const current = sessions.get(conversationId)
    const session = current || { conversationId, activeRequestId: '', activeDeviceId: '', pendingSends: [], pendingChoices: new Map() }
    if (!(session.pendingChoices instanceof Map)) session.pendingChoices = new Map()
    session.windowRef = item.id
    session.hidden = item.remoteHidden === true
    sessions.set(conversationId, session)
    return session
  }

  function existingSession(conversationId) {
    const current = sessions.get(conversationId)
    if (current) {
      const item = windowItem(current.windowRef)
      const win = getWindowByRef(current.windowRef)
      if (item?.conversationId === conversationId && win && !win.isDestroyed()) {
        current.hidden = item.remoteHidden === true
        return current
      }
      if (current.activeRequestId) finishClosed(current)
      sessions.delete(conversationId)
    }
    const candidates = windows().filter((item) => item.type === 'window' && item.conversationId === conversationId)
    const found = candidates.find((item) => !item.readOnly && !item.leasePending) || candidates[0]
    return found ? remember(conversationId, found) : null
  }

  async function ready(windowRef, check = () => {}, timeoutMs = readinessTimeoutMs, requireConversationId = false) {
    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline) {
      check()
      const item = windowItem(windowRef)
      if (!item) throw remoteError('remote_renderer_closed')
      if (item.readOnly) throw remoteError('remote_conversation_read_only')
      if (item.rendererReady === true && item.leasePending !== true &&
        (!requireConversationId || typeof item.conversationId === 'string' && item.conversationId)) return item
      await new Promise((resolve) => setTimeout(resolve, 40))
    }
    throw remoteError(requireConversationId ? 'remote_conversation_create_timeout' : 'remote_renderer_not_ready')
  }

  async function ensureSession(conversationId, check) {
    check()
    if (deletedConversations.has(conversationId)) throw remoteError('remote_conversation_not_found')
    let session = existingSession(conversationId)
    if (!session) {
      let creation = creations.get(conversationId)
      if (!creation) {
        creation = (async () => {
          const config = await getConfig()
          check()
          const directory = text(config?.config?.webdav?.localChatPath, 32768).trim()
          if (!directory) throw remoteError('remote_conversation_directory_not_configured')
          const opened = await openConversation({ dirPath: directory, reference: conversationId, activeOnly: true, pageSize: 200 })
          check()
          if (opened?.descriptor?.conversationId !== conversationId || !opened.sessionData) throw remoteError('remote_conversation_open_failed')
          const created = await openWindow('window', {
            code: opened.sessionData.CODE || 'AI', type: 'conversation',
            conversation: { descriptor: opened.descriptor, sessionData: opened.sessionData },
            conversationTitle: opened.descriptor.title || '', remoteHidden: true, alwaysOnTop: false
          })
          if (!created?.ok || !created.id) throw remoteError('remote_hidden_window_create_failed')
          // Register even if stop/revoke raced window creation, so closeAll can collect it.
          return remember(conversationId, windowItem(created.id) || { id: created.id, remoteHidden: true })
        })()
        creations.set(conversationId, creation)
        creation.finally(() => { if (creations.get(conversationId) === creation) creations.delete(conversationId) }).catch(() => {})
      }
      session = await creation
    }
    check()
    await ready(session.windowRef, check)
    return session
  }

  function publish(record, event, payload = {}) {
    record.event = event
    record.updatedAtMs = Date.now()
    record.eventSequence += 1
    if (event === 'assistant.delta') {
      const append = (key, value) => {
        const combined = record[key] + value
        if (combined.length > MAX_RECOVERY_CHARS) record.truncated = true
        record[key] = combined.slice(-MAX_RECOVERY_CHARS)
      }
      append('text', payload.textDelta || '')
      append('reasoning', payload.reasoningDelta || '')
    }
    if (TERMINAL_EVENTS.has(event)) {
      record.terminal = true
      record.terminalPayload = payload
      uploadManager?.releaseReservation?.({deviceId:record.deviceId,requestId:record.requestId})?.catch?.(() => {})
      uploadManager?.cleanupRequest?.({
        deviceId: record.deviceId, requestId: record.requestId, windowRef: record.windowRef
      })?.catch?.(() => {})
    }
    // Payload delivery failure/disconnect must never roll back or re-execute a Desktop command.
    try {
      broadcastToDevice(record.deviceId, event, {
        requestId: record.requestId, conversationId: record.conversationId,
        windowId: record.windowRef || '', eventSequence: record.eventSequence, ...payload
      })
    } catch { /* Query request state after reconnect. */ }
  }

  function finishClosed(session) {
    session.pendingChoices?.clear?.()
    if (session.queueTimer) clearTimeout(session.queueTimer)
    session.queueTimer = null
    for (const item of session.pendingSends || []) {
      const pending = requests.get(requestKey(item.deviceId, item.requestId))
      if (pending && !pending.terminal) publish(pending, 'assistant.failed', { code: 'remote_renderer_closed' })
    }
    session.pendingSends = []
    const record = requests.get(requestKey(session.activeDeviceId, session.activeRequestId))
    if (record && !record.terminal) publish(record, 'assistant.failed', { code: 'remote_renderer_closed' })
  }

  async function listAssistants({ deviceId, params = {} } = {}) {
    parameters(params, [])
    const epoch = generation
    assertActive(epoch, id(deviceId, 'deviceId'))
    const configResult = await getConfig()
    assertActive(epoch, deviceId)
    const config = object(configResult?.config)
    const prompts = object(config.prompts)
    const projectData = await readLocalProjects(text(config?.webdav?.localChatPath, 32768)).catch(() => ({ projects: [] }))
    const projectNames = new Map((Array.isArray(projectData?.projects) ? projectData.projects : []).map((project) => [text(project?.id, 160), text(project?.name, 160)]))
    const usage = config.desktop?.quickAssistantUsage
    const assistants = Object.entries(prompts)
      .filter(([code, prompt]) => code.length > 0 && code.length <= 160 && prompt && typeof prompt === 'object' && prompt.enable !== false && (text(prompt.showMode, 32) || 'window') === 'window')
      .map(([code, prompt]) => {
        const source = object(prompt)
        const projectId = text(source.autoSaveProjectId, 160)
        return {
          code,
          name: text(source.name, 160) || code,
          icon: /^https:\/\//i.test(text(source.icon, 2048)) ? text(source.icon, 2048) : '',
          model: text(source.model, 320),
          defaultProjectName: projectNames.get(projectId) || '',
          mcpCount: Array.isArray(source.defaultMcpServers) ? source.defaultMcpServers.length : 0,
          skillCount: Array.isArray(source.skillIds || source.defaultSkills) ? (source.skillIds || source.defaultSkills).length : 0,
          usageWeight: getQuickAssistantWeight(usage, code)
        }
      })
      .sort((left, right) => right.usageWeight - left.usageWeight || left.name.localeCompare(right.name, 'zh-CN') || left.code.localeCompare(right.code))
    return { ok: true, assistants }
  }

  async function createConversation({ deviceId, requestId, params = {} } = {}) {
    parameters(params, ['promptCode'])
    const safeDeviceId = id(deviceId, 'deviceId')
    const safeRequestId = id(requestId, 'requestId')
    const promptCode = typeof params.promptCode === 'string' ? params.promptCode : ''
    if (!promptCode || promptCode.length > 160) throw remoteError('remote_assistant_invalid')
    const epoch = generation
    const check = () => assertActive(epoch, safeDeviceId)
    check()
    const key = requestKey(safeDeviceId, safeRequestId)
    const fingerprint = crypto.createHash('sha256').update(JSON.stringify({ operation: 'conversation.create', promptCode })).digest('hex')
    const previous = requests.get(key)
    if (previous) {
      if (previous.fingerprint !== fingerprint) throw remoteError('remote_request_id_conflict')
      return { ...await previous.dispatched, duplicate: true }
    }
    pruneRequests()
    if (creations.size >= 8 || windows().length >= 64) throw remoteError('remote_window_limit_reached')
    const record = { deviceId: safeDeviceId, requestId: safeRequestId, conversationId: '',
      fingerprint, event: 'conversation.command.pending', eventSequence: 0, terminal: false,
      text: '', reasoning: '', truncated: false, updatedAtMs: Date.now(), windowRef: '' }
    requests.set(key, record)
    const creationKey = `new:${key}`
    record.dispatched = (async () => {
      let windowRef = ''
      try {
        const config = await getConfig()
        check()
        const prompts = object(config?.config?.prompts)
        if (!Object.hasOwn(prompts, promptCode) || !prompts[promptCode] || prompts[promptCode].enable === false) {
          throw remoteError('remote_assistant_invalid')
        }
        if (!text(config?.config?.webdav?.localChatPath, 32768).trim()) throw remoteError('remote_conversation_directory_not_configured')
        const created = await openWindow('window', { code: promptCode, type: 'empty', remoteCreate: true,
          conversationTitle: `${promptCode} - 新会话`, remoteHidden: true, alwaysOnTop: false, isAlwaysOnTop: false })
        if (!created?.ok || !created.id) throw remoteError('remote_hidden_window_create_failed')
        windowRef = created.id
        record.windowRef = windowRef
        const item = await ready(windowRef, check, Math.max(readinessTimeoutMs, 45_000), true)
        check()
        const conversationId = id(item.conversationId, 'conversationId')
        const session = remember(conversationId, item)
        record.conversationId = conversationId
        const result = { ok: true, conversationId, windowId: windowRef, hidden: session.hidden, created: true,
          promptCode, title: text(item.conversationTitle, 240) || `${promptCode} - 新会话` }
        // Mobile routes use the exact same Desktop-owned seven-day weight as
        // the quick assistant panel. Recording must never block a valid chat.
        await recordAssistantUsage(promptCode).catch(() => {})
        publish(record, 'conversation.operation.completed', { operation: 'conversation.create' })
        return result
      } catch (error) {
        if (windowRef) {
          // Normal window-close lifecycle only; never destroy a writer mid-save.
          try { getWindowByRef(windowRef)?.close?.() } catch { /* lifecycle owns final cleanup */ }
        }
        publish(record, 'conversation.operation.failed', { code: /^remote_/.test(error?.code || '') ? error.code : 'remote_conversation_create_failed' })
        throw error
      }
    })()
    creations.set(creationKey, record.dispatched)
    record.dispatched.finally(() => { if (creations.get(creationKey) === record.dispatched) creations.delete(creationKey) }).catch(() => {})
    return record.dispatched
  }


  async function dispatchSendRecord(session, record, check) {
    const { deviceId, requestId, conversationId, body, uploadIds } = record
    let authorizationWindowRef = ''
    try {
      check()
      const item = windowItem(session.windowRef)
      if (session.activeRequestId || item?.busy || item?.generating || item?.compacting) throw remoteError('remote_conversation_busy')
      if (uploadIds.length) {
        await uploadManager.authorizeForRequest({ deviceId, requestId, windowRef: session.windowRef, uploadIds })
        authorizationWindowRef = session.windowRef
      }
      check()
      session.activeRequestId = requestId
      session.activeDeviceId = deviceId
      session.activeOperation = 'conversation.send'
      record.windowRef = session.windowRef
      const dispatched = await dispatchRemoteCommandToWindow(session.windowRef, {
        type: 'conversation.send', requestId, deviceId, conversationId, text: body, uploadIds, autoApproveTools: true
      })
      if (!dispatched?.ok) throw remoteError('remote_renderer_dispatch_failed')
      const result = { ok: true, conversationId, windowId: session.windowRef, hidden: session.hidden, created: record.created === true, queued: false }
      record.result = result
      if (record.eventSequence === 0) publish(record, 'conversation.command.accepted', result)
      return result
    } catch (error) {
      if (authorizationWindowRef) {
        await uploadManager.releaseRequest({ deviceId, requestId, windowRef: authorizationWindowRef }).catch(() => {})
      }
      if (session.activeRequestId === requestId && session.activeDeviceId === deviceId) {
        session.activeRequestId = ''
        session.activeDeviceId = ''
        session.activeOperation = ''
      }
      publish(record, 'assistant.failed', { code: error?.code || 'remote_renderer_dispatch_failed' })
      throw error
    }
  }

  async function dispatchNextSend(session) {
    if (!enabled || sessions.get(session.conversationId) !== session || session.activeRequestId || session.dispatchingQueued || !Array.isArray(session.pendingSends) || session.pendingSends.length === 0) return
    const item = windowItem(session.windowRef)
    if (!item) { finishClosed(session); return }
    if (item.busy || item.generating || item.compacting) {
      if (!session.queueTimer) {
        session.queueTimer = setTimeout(() => { session.queueTimer = null; void dispatchNextSend(session) }, 100)
        session.queueTimer.unref?.()
      }
      return
    }
    const next = session.pendingSends.shift()
    const record = requests.get(requestKey(next.deviceId, next.requestId))
    if (!record || record.terminal) return dispatchNextSend(session)
    session.dispatchingQueued = true
    try {
      await dispatchSendRecord(session, record, next.check)
    } catch {
      // The record already received a terminal failure; the following item may proceed.
    } finally {
      session.dispatchingQueued = false
      if (!session.activeRequestId) void dispatchNextSend(session)
    }
  }

  function queueResult(session, record) {
    const position = session.pendingSends.length
    const result = { ok: true, conversationId: record.conversationId, windowId: session.windowRef, hidden: session.hidden, created: record.created === true, queued: true, position }
    record.result = result
    publish(record, 'conversation.queue.pending', { position })
    return result
  }


  async function send({ deviceId, requestId, params = {} } = {}) {
    parameters(params, ['conversationId', 'text', 'uploadIds'])
    const conversationId = id(params.conversationId, 'conversationId')
    if (/\.(json|db)$/i.test(conversationId)) throw remoteError('remote_conversation_id_invalid')

    const safeDeviceId = id(deviceId, 'deviceId')
    const safeRequestId = id(requestId, 'requestId')
    const body = typeof params.text === 'string' ? params.text : ''
    const uploadIds = normalizeUploadIds(params.uploadIds)
    if ((!body.trim() && uploadIds.length === 0) || body.length > 128 * 1024) throw remoteError('remote_message_invalid')
    if (uploadIds.length && !uploadManager?.authorizeForRequest) throw remoteError('remote_upload_unavailable')
    const epoch = generation
    const check = () => assertActive(epoch, safeDeviceId)
    check()
    const key = requestKey(safeDeviceId, safeRequestId)
    const fingerprint = crypto.createHash('sha256').update(JSON.stringify({ conversationId, text: body, uploadIds })).digest('hex')
    const previous = requests.get(key)
    if (previous) {
      if (previous.fingerprint !== fingerprint) throw remoteError('remote_request_id_conflict')
      const result = await previous.dispatched
      return { ...result, duplicate: true }
    }
    pruneRequests()
    const record = {
      deviceId: safeDeviceId, requestId: safeRequestId, conversationId, fingerprint, body, uploadIds,
      event: 'conversation.command.pending', eventSequence: 0, terminal: false,
      text: '', reasoning: '', truncated: false, updatedAtMs: Date.now(), windowRef: ''
    }
    requests.set(key, record)
    record.dispatched = serialize(conversationId, async () => {
      const hadSession = Boolean(existingSession(conversationId))
      const session = await ensureSession(conversationId, check)
      check()
      record.created = !hadSession
      record.windowRef = session.windowRef
      const item = windowItem(session.windowRef)
      if (session.activeRequestId || item?.busy || item?.generating || item?.compacting) {
        if (!Array.isArray(session.pendingSends)) session.pendingSends = []
        if (session.pendingSends.length >= 20) {
          publish(record, 'assistant.failed', { code: 'remote_send_queue_limit_reached' })
          throw remoteError('remote_send_queue_limit_reached')
        }
        if (uploadIds.length) await uploadManager.reserveForRequest?.({deviceId: safeDeviceId, requestId: safeRequestId, uploadIds})
        session.pendingSends.push({ deviceId: safeDeviceId, requestId: safeRequestId, check })
        const result = queueResult(session, record)
        if (!session.activeRequestId) void dispatchNextSend(session)
        return result
      }
      return dispatchSendRecord(session, record, check)
    })
    return record.dispatched
  }

  async function mutate({ deviceId, requestId, params = {}, operation } = {}) {
    const allowed = operation === 'conversation.message.edit'
      ? ['conversationId', 'uiMessageId', 'content']
      : ['conversationId', 'uiMessageId']
    parameters(params, allowed)
    const conversationId = id(params.conversationId, 'conversationId')
    if (/\.(json|db)$/i.test(conversationId)) throw remoteError('remote_conversation_id_invalid')
    const safeDeviceId = id(deviceId, 'deviceId')
    const safeRequestId = id(requestId, 'requestId')
    const uiMessageId = id(params.uiMessageId, 'uiMessageId')
    const content = operation === 'conversation.message.edit' && typeof params.content === 'string' ? params.content : ''
    if (operation === 'conversation.message.edit' && (!content.trim() || content.length > 128 * 1024)) {
      throw remoteError('remote_message_invalid')
    }
    const epoch = generation
    const check = () => assertActive(epoch, safeDeviceId)
    check()
    const key = requestKey(safeDeviceId, safeRequestId)
    const fingerprint = crypto.createHash('sha256').update(JSON.stringify({ operation, conversationId, uiMessageId, content })).digest('hex')
    const previous = requests.get(key)
    if (previous) {
      if (previous.fingerprint !== fingerprint) throw remoteError('remote_request_id_conflict')
      return { ...(await previous.dispatched), duplicate: true }
    }
    pruneRequests()
    const record = {
      deviceId: safeDeviceId, requestId: safeRequestId, conversationId, fingerprint,
      event: 'conversation.command.pending', eventSequence: 0, terminal: false,
      text: '', reasoning: '', truncated: false, updatedAtMs: Date.now(), windowRef: ''
    }
    requests.set(key, record)
    record.dispatched = serialize(conversationId, async () => {
      try {
        const hadSession = Boolean(existingSession(conversationId))
        const session = await ensureSession(conversationId, check)
        check()
        const item = windowItem(session.windowRef)
        if (session.activeRequestId || item?.busy || item?.generating || item?.compacting) throw remoteError('remote_conversation_busy')
        session.activeRequestId = safeRequestId
        session.activeDeviceId = safeDeviceId
        record.windowRef = session.windowRef
        const dispatched = await dispatchRemoteCommandToWindow(session.windowRef, {
          type: operation, requestId: safeRequestId, deviceId: safeDeviceId,
          conversationId, uiMessageId, ...(operation === 'conversation.message.edit' ? { content } : {})
        })
        if (!dispatched?.ok) throw remoteError('remote_renderer_dispatch_failed')
        const result = { ok: true, operation, conversationId, uiMessageId, windowId: session.windowRef, hidden: session.hidden, created: !hadSession }
        record.result = result
        if (record.eventSequence === 0) publish(record, 'conversation.command.accepted', result)
        return result
      } catch (error) {
        const session = sessions.get(conversationId)
        if (session?.activeRequestId === safeRequestId && session.activeDeviceId === safeDeviceId) {
          session.activeRequestId = ''; session.activeDeviceId = ''
        }
        publish(record, 'conversation.operation.failed', { code: error?.code || 'remote_renderer_dispatch_failed' })
        throw error
      }
    })
    return record.dispatched
  }


  async function conversationMetadataCommand({ deviceId, requestId, params = {}, operation } = {}) {
    const allowed = operation === 'conversation.rename'
      ? ['conversationId', 'title']
      : ['conversationId', 'confirmed']
    parameters(params, allowed)
    const conversationId = id(params.conversationId, 'conversationId')
    if (/\.(json|db)$/i.test(conversationId)) throw remoteError('remote_conversation_id_invalid')
    const safeDeviceId = id(deviceId, 'deviceId')
    const safeRequestId = id(requestId, 'requestId')
    const title = operation === 'conversation.rename' ? text(params.title, 241).trim() : ''
    if (operation === 'conversation.rename' && (!title || title.length > 240)) throw remoteError('remote_conversation_title_invalid')
    if (operation === 'conversation.delete' && params.confirmed !== true) throw remoteError('remote_confirmation_required')
    const epoch = generation
    const check = () => assertActive(epoch, safeDeviceId)
    check()
    const key = requestKey(safeDeviceId, safeRequestId)
    const fingerprint = crypto.createHash('sha256').update(JSON.stringify({ operation, conversationId, title, confirmed: params.confirmed === true })).digest('hex')
    const previous = requests.get(key)
    if (previous) {
      if (previous.fingerprint !== fingerprint) throw remoteError('remote_request_id_conflict')
      return { ...(await previous.dispatched), duplicate: true }
    }
    pruneRequests()
    const record = {
      deviceId: safeDeviceId, requestId: safeRequestId, conversationId, fingerprint,
      event: 'conversation.command.pending', eventSequence: 0, terminal: false,
      text: '', reasoning: '', truncated: false, updatedAtMs: Date.now(), windowRef: ''
    }
    requests.set(key, record)
    record.dispatched = serialize(conversationId, async () => {
      try {
        const hadSession = Boolean(existingSession(conversationId))
        const session = await ensureSession(conversationId, check)
        check()
        const item = windowItem(session.windowRef)
        if (session.activeRequestId || item?.busy || item?.generating || item?.compacting) throw remoteError('remote_conversation_busy')
        session.activeRequestId = safeRequestId
        session.activeDeviceId = safeDeviceId
        session.activeOperation = operation
        record.windowRef = session.windowRef
        const dispatched = await dispatchRemoteCommandToWindow(session.windowRef, {
          type: operation,
          requestId: safeRequestId,
          deviceId: safeDeviceId,
          conversationId,
          ...(operation === 'conversation.rename' ? { title } : { confirmed: true })
        })
        if (!dispatched?.ok) throw remoteError('remote_renderer_dispatch_failed')
        const result = { ok: true, operation, conversationId, windowId: session.windowRef, hidden: session.hidden, created: !hadSession }
        record.result = result
        if (record.eventSequence === 0) publish(record, 'conversation.command.accepted', result)
        return result
      } catch (error) {
        const session = sessions.get(conversationId)
        if (session?.activeRequestId === safeRequestId && session.activeDeviceId === safeDeviceId) {
          session.activeRequestId = ''
          session.activeDeviceId = ''
          session.activeOperation = ''
        }
        publish(record, 'conversation.operation.failed', { code: error?.code || 'remote_renderer_dispatch_failed' })
        throw error
      }
    })
    return record.dispatched
  }



  async function configCommand({ deviceId, requestId, params = {}, operation } = {}) {
    const allowed = operation === 'conversation.config.patch' ? ['conversationId', 'patch'] : ['conversationId']
    parameters(params, allowed)
    const conversationId = id(params.conversationId, 'conversationId')
    if (/\.(json|db)$/i.test(conversationId)) throw remoteError('remote_conversation_id_invalid')
    const safeDeviceId = id(deviceId, 'deviceId')
    const safeRequestId = id(requestId, 'requestId')
    const patch = operation === 'conversation.config.patch' ? normalizeConfigPatch(params.patch) : null
    const epoch = generation
    const check = () => assertActive(epoch, safeDeviceId)
    check()
    const key = requestKey(safeDeviceId, safeRequestId)
    const fingerprint = crypto.createHash('sha256').update(JSON.stringify({ operation, conversationId, patch })).digest('hex')
    const previous = requests.get(key)
    if (previous) {
      if (previous.fingerprint !== fingerprint) throw remoteError('remote_request_id_conflict')
      return { ...(await previous.dispatched), duplicate: true }
    }
    pruneRequests()
    const record = {
      deviceId: safeDeviceId, requestId: safeRequestId, conversationId, fingerprint,
      event: 'conversation.command.pending', eventSequence: 0, terminal: false,
      text: '', reasoning: '', truncated: false, updatedAtMs: Date.now(), windowRef: ''
    }
    requests.set(key, record)
    record.dispatched = serialize(conversationId, async () => {
      try {
        const hadSession = Boolean(existingSession(conversationId))
        const session = await ensureSession(conversationId, check)
        check()
        const item = windowItem(session.windowRef)
        if (session.activeRequestId || item?.busy || item?.generating || item?.compacting) throw remoteError('remote_conversation_busy')
        session.activeRequestId = safeRequestId
        session.activeDeviceId = safeDeviceId
        record.windowRef = session.windowRef
        const dispatched = await dispatchRemoteCommandToWindow(session.windowRef, {
          type: operation, requestId: safeRequestId, deviceId: safeDeviceId,
          conversationId, ...(patch ? { patch } : {})
        })
        if (!dispatched?.ok) throw remoteError('remote_renderer_dispatch_failed')
        const result = { ok: true, operation, conversationId, windowId: session.windowRef, hidden: session.hidden, created: !hadSession }
        record.result = result
        if (record.eventSequence === 0) publish(record, 'conversation.command.accepted', result)
        return result
      } catch (error) {
        const session = sessions.get(conversationId)
        if (session?.activeRequestId === safeRequestId && session.activeDeviceId === safeDeviceId) {
          session.activeRequestId = ''; session.activeDeviceId = ''
        }
        publish(record, 'conversation.operation.failed', { code: error?.code || 'remote_renderer_dispatch_failed' })
        throw error
      }
    })
    return record.dispatched
  }


  async function compact({ deviceId, requestId, params = {} } = {}) {
    parameters(params, ['conversationId'])
    const conversationId = id(params.conversationId, 'conversationId')
    const safeDeviceId = id(deviceId, 'deviceId')
    const safeRequestId = id(requestId, 'requestId')
    const epoch = generation
    const check = () => assertActive(epoch, safeDeviceId)
    check()
    const key = requestKey(safeDeviceId, safeRequestId)
    const fingerprint = crypto.createHash('sha256').update(JSON.stringify({ operation: 'conversation.compact', conversationId })).digest('hex')
    const previous = requests.get(key)
    if (previous) {
      if (previous.fingerprint !== fingerprint) throw remoteError('remote_request_id_conflict')
      return { ...(await previous.dispatched), duplicate: true }
    }
    pruneRequests()
    const record = {
      deviceId: safeDeviceId, requestId: safeRequestId, conversationId, fingerprint,
      event: 'conversation.command.pending', eventSequence: 0, terminal: false,
      text: '', reasoning: '', truncated: false, updatedAtMs: Date.now(), windowRef: ''
    }
    requests.set(key, record)
    record.dispatched = serialize(conversationId, async () => {
      try {
        const hadSession = Boolean(existingSession(conversationId))
        const session = await ensureSession(conversationId, check)
        check()
        const item = windowItem(session.windowRef)
        if (session.activeRequestId || item?.busy || item?.generating || item?.compacting) throw remoteError('remote_conversation_busy')
        session.activeRequestId = safeRequestId
        session.activeDeviceId = safeDeviceId
        session.activeOperation = 'conversation.compact'
        record.windowRef = session.windowRef
        const dispatched = await dispatchRemoteCommandToWindow(session.windowRef, {
          type: 'conversation.compact', requestId: safeRequestId, deviceId: safeDeviceId, conversationId
        })
        if (!dispatched?.ok) throw remoteError('remote_renderer_dispatch_failed')
        const result = { ok: true, operation: 'conversation.compact', conversationId, windowId: session.windowRef, hidden: session.hidden, created: !hadSession }
        record.result = result
        if (record.eventSequence === 0) publish(record, 'conversation.command.accepted', result)
        return result
      } catch (error) {
        const session = sessions.get(conversationId)
        if (session?.activeRequestId === safeRequestId && session.activeDeviceId === safeDeviceId) {
          session.activeRequestId = ''; session.activeDeviceId = ''; session.activeOperation = ''
        }
        publish(record, 'conversation.compact.failed', { code: error?.code || 'remote_renderer_dispatch_failed' })
        throw error
      }
    })
    return record.dispatched
  }

  async function cancelCompact({ deviceId, requestId, params = {} } = {}) {
    parameters(params, ['conversationId'])
    const conversationId = id(params.conversationId, 'conversationId')
    assertActive(generation, deviceId)
    const session = existingSession(conversationId)
    if (!session?.activeRequestId || session.activeOperation !== 'conversation.compact') throw remoteError('remote_compact_not_running')
    if (session.activeDeviceId !== deviceId) throw remoteError('remote_request_owner_mismatch')
    const result = await dispatchRemoteCommandToWindow(session.windowRef, {
      type: 'conversation.compact.cancel', requestId: id(requestId, 'requestId'),
      targetRequestId: session.activeRequestId, conversationId
    })
    if (!result?.ok) throw remoteError('remote_renderer_dispatch_failed')
    return { ok: true, conversationId, windowId: session.windowRef, targetRequestId: session.activeRequestId }
  }


  function listSendQueue({ deviceId, params = {} } = {}) {
    parameters(params, ['conversationId'])
    const conversationId = id(params.conversationId, 'conversationId')
    assertActive(generation, deviceId)
    const session = existingSession(conversationId)
    const pending = Array.isArray(session?.pendingSends) ? session.pendingSends : []
    return {
      ok: true,
      conversationId,
      activeRequestId: session?.activeDeviceId === deviceId ? session.activeRequestId || '' : '',
      items: pending.filter((item) => item.deviceId === deviceId).map((item, index) => ({ requestId: item.requestId, position: index + 1, text: text(requests.get(requestKey(deviceId,item.requestId))?.body,240) }))
    }
  }

  function removeQueuedSend({ deviceId, params = {} } = {}) {
    parameters(params, ['conversationId', 'requestId'])
    const conversationId = id(params.conversationId, 'conversationId')
    const queuedRequestId = id(params.requestId, 'requestId')
    assertActive(generation, deviceId)
    const session = existingSession(conversationId)
    if (!session || !Array.isArray(session.pendingSends)) throw remoteError('remote_send_queue_item_not_found')
    const index = session.pendingSends.findIndex((item) => item.deviceId === deviceId && item.requestId === queuedRequestId)
    if (index < 0) throw remoteError('remote_send_queue_item_not_found')
    session.pendingSends.splice(index, 1)
    uploadManager?.releaseReservation?.({deviceId, requestId: queuedRequestId})?.catch?.(() => {})
    const record = requests.get(requestKey(deviceId, queuedRequestId))
    if (record && !record.terminal) publish(record, 'assistant.cancelled', { code: 'remote_send_queue_removed' })
    return { ok: true, conversationId, requestId: queuedRequestId, removed: true }
  }


  async function submitChoice({ deviceId, params = {} } = {}) {
    parameters(params, ['conversationId', 'toolCallId', 'responses'])
    const conversationId = id(params.conversationId, 'conversationId')
    const toolCallId = id(params.toolCallId, 'toolCallId')
    assertActive(generation, deviceId)
    const session = existingSession(conversationId)
    if (!session?.activeRequestId || session.activeDeviceId !== deviceId || session.activeOperation !== 'conversation.send') {
      throw remoteError('remote_choice_not_pending')
    }
    const questions = session.pendingChoices?.get(toolCallId)
    if (!questions) throw remoteError('remote_choice_not_pending')
    const responses = normalizeChoiceResponses(params.responses, questions)
    const dispatched = await dispatchRemoteCommandToWindow(session.windowRef, {
      type: 'conversation.choice.submit', conversationId, toolCallId, responses
    })
    if (!dispatched?.ok) throw remoteError('remote_renderer_dispatch_failed')
    session.pendingChoices.delete(toolCallId)
    return { ok: true, conversationId, toolCallId, submitted: true }
  }


  async function cancel({ deviceId, requestId, params = {} } = {}) {
    parameters(params, ['conversationId'])
    const conversationId = id(params.conversationId, 'conversationId')
    assertActive(generation, deviceId)
    const session = existingSession(conversationId)
    if (!session?.activeRequestId) throw remoteError('remote_conversation_not_generating')
    if (session.activeDeviceId !== deviceId) throw remoteError('remote_request_owner_mismatch')
    const targetRequestId = session.activeRequestId
    const result = await dispatchRemoteCommandToWindow(session.windowRef, {
      type: 'conversation.cancel', requestId: id(requestId, 'requestId'), targetRequestId, conversationId
    })
    if (!result?.ok) throw remoteError('remote_renderer_dispatch_failed')
    return { ok: true, conversationId, windowId: session.windowRef, targetRequestId }
  }

  function showOnDesktop({ params = {} } = {}) {
    parameters(params, ['conversationId'])
    const conversationId = id(params.conversationId, 'conversationId')
    if (!enabled) throw remoteError('remote_gateway_stopped')
    if (deletedConversations.has(conversationId)) throw remoteError('remote_conversation_not_found')
    const session = existingSession(conversationId)
    if (!session) throw remoteError('remote_conversation_window_not_found')
    if (!revealRemoteConversationWindow(session.windowRef)?.ok) throw remoteError('remote_window_reveal_failed')
    session.hidden = false
    return { ok: true, conversationId, windowId: session.windowRef, hidden: false }
  }

  function getRequest({ deviceId, params = {} } = {}) {
    parameters(params, ['requestId'])
    assertActive(generation, deviceId)
    const record = requests.get(requestKey(deviceId, id(params.requestId, 'requestId')))
    if (!record) throw remoteError('remote_request_not_found')
    return {
      ok: true, requestId: record.requestId, conversationId: record.conversationId,
      windowId: record.windowRef, event: record.event, eventSequence: record.eventSequence,
      terminal: record.terminal, text: record.text, reasoning: record.reasoning,
      truncated: record.truncated, updatedAt: new Date(record.updatedAtMs).toISOString(),
      ...(record.terminal ? { result: { ...record.terminalPayload } } : {})
    }
  }

  function handleRendererEvent({ windowRef, payload } = {}) {
    const data = object(payload)
    if (!RENDERER_EVENTS.has(data.event)) return { ok: false, error: 'remote_renderer_event_invalid' }
    const session = sessions.get(data.conversationId)
    if (!session || session.windowRef !== windowRef) return { ok: false, error: 'remote_renderer_event_window_mismatch' }
    if (!session.activeRequestId || session.activeRequestId !== data.requestId) return { ok: false, error: 'remote_renderer_event_request_mismatch' }
    const record = requests.get(requestKey(session.activeDeviceId, data.requestId))
    if (!record || record.terminal) return { ok: false, error: 'remote_renderer_event_request_mismatch' }
    const sanitizedPayload = sanitizeEvent(data.event, data.payload)
    if (data.event === 'conversation.choice.required') {
      if (!sanitizedPayload.toolCallId || !sanitizedPayload.questions.length) return { ok: false, error: 'remote_choice_event_invalid' }
      session.pendingChoices.set(sanitizedPayload.toolCallId, sanitizedPayload.questions)
    }
    publish(record, data.event, sanitizedPayload)
    if (record.terminal) {
      if (session.activeOperation === 'conversation.delete' && data.event === 'conversation.operation.completed' && sanitizedPayload.deleted) {
        deletedConversations.add(session.conversationId)
      }
      session.activeRequestId = ''
      session.activeDeviceId = ''
      session.activeOperation = ''
      session.pendingChoices?.clear?.()
      void dispatchNextSend(session)
    }
    return { ok: true }
  }

  function handleWindowClosed(windowRef) {
    for (const [conversationId, session] of sessions) {
      if (session.windowRef !== windowRef) continue
      finishClosed(session)
      sessions.delete(conversationId)
    }
    uploadManager?.cleanupWindow?.(windowRef)?.catch?.(() => {})
    onWindowClosed?.(windowRef)
    return { ok: true }
  }

  async function revokeDevice(deviceId) {
    revokedDevices.add(deviceId)
    for (const session of sessions.values()) {
      if (Array.isArray(session.pendingSends)) {
        const removed = session.pendingSends.filter((item) => item.deviceId === deviceId)
        session.pendingSends = session.pendingSends.filter((item) => item.deviceId !== deviceId)
        for (const item of removed) {
          const record = requests.get(requestKey(deviceId, item.requestId))
          if (record && !record.terminal) publish(record, 'assistant.cancelled', { code: 'remote_device_revoked' })
        }
      }
      if (session.activeDeviceId !== deviceId || !session.activeRequestId) continue
      await dispatchRemoteCommandToWindow(session.windowRef, {
        type: session.activeOperation === 'conversation.compact' ? 'conversation.compact.cancel' : 'conversation.cancel',
        requestId: session.activeRequestId,
        targetRequestId: session.activeRequestId,
        conversationId: session.conversationId
      }).catch(() => {})
    }
    await uploadManager?.cleanupDevice?.(deviceId)
  }

  function closeAll() {
    enabled = false
    generation += 1
    if (closing) return closing
    for (const session of sessions.values()) {
      if (session.queueTimer) clearTimeout(session.queueTimer)
      session.queueTimer = null
      for (const item of session.pendingSends || []) {
        const pending = requests.get(requestKey(item.deviceId, item.requestId))
        if (pending && !pending.terminal) publish(pending, 'assistant.cancelled', { code: 'remote_gateway_stopped' })
      }
      session.pendingSends = []
    }
    closing = (async () => {
      await Promise.allSettled([...creations.values()])
      await Promise.allSettled([...sessions.values()].map(async (session) => {
        const item = windowItem(session.windowRef)
        if (!item) { handleWindowClosed(session.windowRef); return }
        session.hidden = item.remoteHidden === true
        if (session.hidden) {
          // Bootstrap may still be acquiring a lease; cleanup must reach its registered adapter.
          await ready(session.windowRef).catch(() => {})
          await dispatchRemoteCommandToWindow(session.windowRef, {
            type: 'remote.shutdown', conversationId: session.conversationId, closeHidden: true
          })
        } else if (session.activeRequestId) {
          await dispatchRemoteCommandToWindow(session.windowRef, {
            type: session.activeOperation === 'conversation.compact' ? 'conversation.compact.cancel' : 'conversation.cancel',
            requestId: session.activeRequestId,
            targetRequestId: session.activeRequestId,
            conversationId: session.conversationId
          })
        }
      }))
      // IPC dispatch is not a save/close acknowledgement. Wait for actual writer shutdown.
      const deadline = Date.now() + Math.max(15000, readinessTimeoutMs)
      while ([...sessions.values()].some((session) => {
        const item = windowItem(session.windowRef)
        return item && (item.remoteHidden === true || Boolean(session.activeRequestId))
      })) {
        if (Date.now() >= deadline) throw remoteError('remote_writer_shutdown_timeout')
        await new Promise((resolve) => setTimeout(resolve, 40))
      }
      // Keep live visible entries for reuse; never destroy a writer before saving.
    })().finally(() => { closing = null })
    return closing
  }

  return {
    send,
    listSendQueue, removeQueuedSend, submitChoice,
    listAssistants, createConversation,

    editMessage: (input) => mutate({ ...input, operation: 'conversation.message.edit' }),
    deleteMessage: (input) => mutate({ ...input, operation: 'conversation.message.delete' }),
    reaskMessage: (input) => mutate({ ...input, operation: 'conversation.message.reask' }),
    renameConversation: (input) => conversationMetadataCommand({ ...input, operation: 'conversation.rename' }),
    deleteConversation: (input) => conversationMetadataCommand({ ...input, operation: 'conversation.delete' }),
    getConfig: (input) => configCommand({ ...input, operation: 'conversation.config.get' }),
    patchConfig: (input) => configCommand({ ...input, operation: 'conversation.config.patch' }),
    compact,
    cancelCompact,
    cancel, showOnDesktop, getRequest, handleRendererEvent, handleWindowClosed,
    revokeDevice, closeAll,
    resume: () => { enabled = true },
    authorizeDevice: (deviceId) => { revokedDevices.delete(deviceId) },
    getSession: (conversationId) => { const session = existingSession(conversationId); return session ? { ...session } : null }
  }
}
