import crypto from 'node:crypto'

import {AsyncLocalStorage} from 'node:async_hooks'
import { normalizeIdentifier, remoteError } from './protocol.js'
import { getQuickAssistantWeight } from '../quickAssistantUsage.js'
import { sanitizeRemoteToolCalls } from '../conversationStore.js'

const REQUEST_TTL_MS = 30 * 60 * 1000
const MAX_REQUESTS = 256
const MAX_RECOVERY_CHARS = 64 * 1024

const REMOTE_HIDDEN_IDLE_RELEASE_MS = 15_000
const TERMINAL_EVENTS = new Set([
  'assistant.completed', 'assistant.cancelled', 'assistant.failed',
  'conversation.operation.completed', 'conversation.operation.failed', 'conversation.config.result',
  'conversation.compact.completed', 'conversation.compact.cancelled', 'conversation.compact.failed'
])
const RENDERER_EVENTS = new Set([
  'conversation.command.acknowledged', 'assistant.started', 'assistant.delta',
  'conversation.choice.required', 'conversation.choice.resolved', 'conversation.tasks.updated', 'conversation.compact.progress', ...TERMINAL_EVENTS
])
const PATH_KEYS = new Set([
  'path', 'filepath', 'file_path', 'dirpath', 'dir_path', 'dbfile', 'db_file',
  'legacyjson', 'legacy_json', 'worktreedir', 'worktree_dir', 'localchatpath', 'local_chat_path'
])
const text = (value, limit = 160) => typeof value === 'string' ? value.slice(0, limit) : ''
const object = (value) => value && typeof value === 'object' && !Array.isArray(value) ? value : {}
const id = (value, field) => normalizeIdentifier(value, field, { minLength: field === 'requestId' ? 8 : 16, maxLength: 160 })

function displayModelLabel(value, providers = {}) {
  const model = text(value, 320).trim()
  const separator = model.indexOf('|')
  if (separator <= 0 || separator >= model.length - 1) return model
  const providerId = model.slice(0, separator).trim()
  const modelName = model.slice(separator + 1).trim()
  const providerName = text(object(providers)[providerId]?.name, 160).trim()
  return providerName ? `${providerName} | ${modelName}`.slice(0, 320) : modelName
}


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

/** Only display tags may cross the Remote conversation-config boundary. */
function safeMcpTags(value = {}) {
  const source = object(value)
  const raw = Array.isArray(source.tags) ? source.tags : Array.isArray(source.labels) ? source.labels : []
  return [...new Set(raw.map((tag) => text(tag, 80).trim()).filter(Boolean))].slice(0, 32)
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
    busy: source.busy === true,
    deferred: source.deferred === true,

    contextUsage: source.contextUsage && typeof source.contextUsage === 'object' ? {
      status: ['ready', 'calculating', 'stale', 'unavailable'].includes(source.contextUsage.status) ? source.contextUsage.status : 'unavailable',
      estimated: true,
      systemTokens: Math.min(1000000000, Math.max(0, Math.floor(Number(source.contextUsage.systemTokens) || 0))),
      conversationTokens: Math.min(1000000000, Math.max(0, Math.floor(Number(source.contextUsage.conversationTokens) || 0))),
      toolTokens: Math.min(1000000000, Math.max(0, Math.floor(Number(source.contextUsage.toolTokens) || 0))),
      updatedAt: Math.max(0, Number(source.contextUsage.updatedAt) || 0)
    } : null,
    patched: stringArray(Array.isArray(source.patched) ? source.patched : [], 'patched'),
    config: {
      model: text(config.model, 320), reasoningEffort: text(config.reasoningEffort, 32), voice: text(config.voice, 160),
      mcpServerIds: stringArray(config.mcpServerIds || [], 'mcpServerIds'), skillIds: stringArray(config.skillIds || [], 'skillIds'),
      systemPrompt: text(config.systemPrompt, 256 * 1024), compact: {
        autoCompactEnabled: config.compact?.autoCompactEnabled !== false,
        triggerRatio: Number(config.compact?.triggerRatio) || 0.9,
        contextLength: Math.max(0, Math.floor(Number(config.compact?.contextLength) || 0)),
        contextLengthSource: ['api', 'manual', 'default'].includes(config.compact?.contextLengthSource) ? config.compact.contextLengthSource : 'default',
        contextLengthManual: config.compact?.contextLengthManual === true,
        keepRecentRounds: Math.max(0, Math.floor(Number(config.compact?.keepRecentRounds) || 0)),
        hideCompactedMessages: config.compact?.hideCompactedMessages !== false,
        compactPrompt: text(config.compact?.compactPrompt, 128 * 1024)
      }
    },
    options: {
      models: (Array.isArray(options.models) ? options.models : []).slice(0, 1000).map((item) => ({ value: text(item?.value, 320), label: text(item?.label, 240) })),
      reasoningEfforts: stringArray(options.reasoningEfforts || [], 'reasoningEfforts'),
      voices: stringArray(options.voices || [], 'voices'),
      mcpServers: (Array.isArray(options.mcpServers) ? options.mcpServers : []).slice(0, 256).map((item) => ({
        id: text(item?.id, 160),
        name: text(item?.name, 240),
        tags: safeMcpTags(item),
        ...(typeof item?.transport === 'string' ? {transport: ['builtin', 'stdio', 'sse', 'http', 'streamable-http'].includes(item.transport) ? item.transport : 'local'} : {}),
        preset: item?.preset === true
      })),
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


const LIVE_TOOL_STATUSES = new Set(['waiting', 'approved', 'executing', 'finished', 'rejected', 'choosing'])
const LIVE_TOOL_CALLS_LIMIT = 16

/** Renderer data is always re-sanitized before crossing the paired-device boundary. */
function sanitizeLiveToolCalls(value) {
  return sanitizeRemoteToolCalls(Array.isArray(value) ? value.slice(0, LIVE_TOOL_CALLS_LIMIT) : [])
    .map((call) => ({
      id: text(call.id, 160),
      name: text(call.name, 240),
      status: LIVE_TOOL_STATUSES.has(call.status) ? call.status : '',
      // Mobile must never receive local MCP command/argument/cwd/env details.
      // The name and lifecycle state are enough for real-time progress feedback.
      arguments: call.arguments == null || call.arguments === '' ? '' : '[参数已隐藏]'
    }))
    .filter((call) => call.id || call.name)
}


function sanitizeEvent(event, payload) {
  const source = object(payload)
  if (event === 'assistant.delta') return {
    textDelta: text(source.textDelta, 16 * 1024),
    reasoningDelta: text(source.reasoningDelta, 16 * 1024),
    // Renderer uses the canonical Assistant storage ID only. It lets Mobile
    // reconcile a persisted tool-call bubble with its current live segment.
    segmentId: text(source.segmentId, 160),
    status: text(source.status, 80),
    ...(Object.hasOwn(source, 'toolCalls') ? { toolCalls: sanitizeLiveToolCalls(source.toolCalls) } : {})
  }
  if (event === 'assistant.failed' || event === 'conversation.operation.failed') return {
    code: /^remote_[a-z0-9_]+$/.test(source.code) ? source.code : 'remote_operation_failed'
  }
  if (event === 'assistant.started') return { startedAt: text(source.startedAt, 80) }
  if (event === 'conversation.choice.required') return {
    toolCallId: text(source.toolCallId, 160),
    questions: sanitizeChoiceQuestions(source.questions)
  }
  if (event === 'conversation.choice.resolved') return {toolCallId: text(source.toolCallId, 160)}
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
    title: text(source.title, 240), deleted: source.deleted === true,
    ...(source.operation === 'conversation.message.fork' ? {forkedConversationId: text(source.forkedConversationId, 160)} : {})
  }
  return { hidden: source.hidden === true, created: source.created === true }
}

/** Main-process routing only. Renderer remains the sole conversation writer/lease holder. */
export function createRemoteSessionManager({
  getConfig, openConversation, listWindows, openWindow, getWindowByRef,
  readLocalProjects = async () => ({ projects: [] }), dispatchRemoteCommandToWindow, revealRemoteConversationWindow, broadcastToDevice,
  recordAssistantUsage = async () => {}, conversationExists = null, getConversationDirectory = null, uploadManager = null, readinessTimeoutMs = 12000, configReadTimeoutMs = 110000, onWindowClosed = null, onConversationRevision = null, onControlChanged = () => {}
} = {}) {
  for (const [name, value] of Object.entries({
    getConfig, openConversation, listWindows, openWindow, getWindowByRef, readLocalProjects,
    dispatchRemoteCommandToWindow, revealRemoteConversationWindow, broadcastToDevice, recordAssistantUsage
  })) {
    if (typeof value !== 'function') throw new Error(`remote_session_${name}_required`)
  }
  const sessions = new Map()

  const commandGuard = new AsyncLocalStorage()

  const controlProjections = new Map()
  const creations = new Map()
  const queues = new Map()
  const requests = new Map()
  const configReads = new Map()
  const revokedDevices = new Set()
  const deletedConversations = new Set()
  const closingConversations = new Set()
  const openingConversations = new Map()

  let enabled = true
  let generation = 0
  let closing = null

  const windows = () => listWindows('window') || []
  const windowItem = (windowRef) => windows().find((item) => item.id === windowRef)
  const requestKey = (deviceId, requestId) => `${deviceId}:${requestId}`

  function pruneRequests(readOnly = false) {
    const now = Date.now()
    for (const [key, request] of requests) {
      if (request.terminal && now - request.updatedAtMs > REQUEST_TTL_MS) requests.delete(key)
    }
    const finishedReads = [...requests].filter(([, request]) => request.readOnly && request.terminal)
    for (const [key] of finishedReads.slice(0, Math.max(0, finishedReads.length - MAX_REQUESTS))) requests.delete(key)
    if (readOnly) return
    // Read-only snapshots have their own deadline, never consume AI/write slots.
    while ([...requests.values()].filter(request => !request.readOnly).length >= MAX_REQUESTS) {
      const entry = [...requests].find(([, request]) => !request.readOnly && request.terminal)
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
    const guard = commandGuard.getStore()
    const next = previous.catch(() => {}).then(() => {guard?.(); return operation()})
    queues.set(conversationId, next)
    next.finally(() => { if (queues.get(conversationId) === next) queues.delete(conversationId) }).catch(() => {})
    return next
  }

  function retireDeletedConversation(conversationId) {
    const first = !deletedConversations.has(conversationId)
    deletedConversations.add(conversationId)
    const session = sessions.get(conversationId)
    if (session) {
      session.mobileControlled = false; session.mobileOpened = false; session.mobileDeviceId = ''
      session.controlEpoch = crypto.randomUUID()
      session.pendingChoices?.clear?.()
      if (session.queueTimer) clearTimeout(session.queueTimer)
      if (session.idleReleaseTimer) clearTimeout(session.idleReleaseTimer)
      session.queueTimer = null; session.idleReleaseTimer = null
      for (const queued of session.pendingSends.splice(0)) {
        const record = requests.get(requestKey(queued.deviceId, queued.requestId))
        if (record && !record.terminal) publish(record, 'assistant.cancelled', {code: 'remote_conversation_not_found'})
      }
    }
    if (first) onControlChanged()
  }

  async function confirmDeletedConversation(conversationId) {
    if (deletedConversations.has(conversationId)) return true
    if (typeof conversationExists !== 'function') return false
    const item = windows().find(entry => entry.type === 'window' && entry.conversationId === conversationId)
    const config = typeof getConversationDirectory === 'function' ? null : await getConfig()
    const directory = text(typeof getConversationDirectory === 'function' ? getConversationDirectory(item?.id, conversationId) : config?.config?.webdav?.localChatPath, 32768).trim()
    if (!directory) return false
    if (await conversationExists({dirPath: directory, conversationId}) !== false) return false
    if (item && !windows().some(entry => entry.id === item.id && entry.conversationId === conversationId)) return false
    retireDeletedConversation(conversationId)
    return true
  }

  async function closeDeletedConversation(conversationId, wait = true) {
    const targets = windows().filter(item => item.type === 'window' && item.conversationId === conversationId)
    for (const item of targets) {
      const result = await dispatchRemoteCommandToWindow(item.id, {type: 'remote.shutdown', conversationId, conversationDeleted: true, closeWindow: true})
      if (!result?.ok) throw remoteError('remote_renderer_dispatch_failed')
    }
    if (!wait) return
    const deadline = Date.now() + Math.max(15000, readinessTimeoutMs)
    while (targets.some(item => windowItem(item.id))) {
      if (Date.now() >= deadline) throw remoteError('remote_conversation_close_timeout')
      await new Promise(resolve => setTimeout(resolve, 40))
    }
    const session = sessions.get(conversationId)
    if (session) handleWindowClosed(session.windowRef)
  }

  let reconcilingDeleted = null
  function reconcileDeletedSessions() {
    if (reconcilingDeleted) return reconcilingDeleted
    reconcilingDeleted = (async () => {
      for (const conversationId of new Set([...sessions.keys(), ...windows().filter(item => item.type === 'window').map(item => item.conversationId).filter(Boolean)])) {
        try {
          if (await confirmDeletedConversation(conversationId)) await closeDeletedConversation(conversationId, false)
        } catch { /* Unknown filesystem/config failures must never retire a live writer. */ }
      }
    })().finally(() => {reconcilingDeleted = null})
    return reconcilingDeleted
  }


  function remember(conversationId, item) {
    const current = sessions.get(conversationId)
    const session = current || { conversationId, activeRequestId: '', activeDeviceId: '', pendingSends: [], pendingChoices: new Map(), mobileOpened: false, mobileControlled: false, mobileDeviceId: '', controlEpoch: crypto.randomUUID() }
    if (!(session.pendingChoices instanceof Map)) session.pendingChoices = new Map()
    session.windowRef = item.id
    session.hidden = item.remoteHidden === true
    if (!current && item.mobileControlled === true) session.mobileControlled = true
    sessions.set(conversationId, session)
    return session
  }

  function existingSession(conversationId) {

    if (deletedConversations.has(conversationId)) return null
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

  async function ensureSession(conversationId, check, temporaryMetadata = false) {
    check()
    if (closingConversations.has(conversationId)) throw remoteError('remote_conversation_closing')
    if (deletedConversations.has(conversationId)) throw remoteError('remote_conversation_not_found')

    if (await confirmDeletedConversation(conversationId)) {await closeDeletedConversation(conversationId, false); throw remoteError('remote_conversation_not_found')}
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
          const session = remember(conversationId, windowItem(created.id) || { id: created.id, remoteHidden: true })
          if (temporaryMetadata) session.temporaryMetadata = true

          commandGuard.getStore()?.createdWriter?.({conversationId, windowRef: created.id, controlEpoch: session.controlEpoch})
          return session
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
    if (record.terminal) return
    record.event = event
    record.updatedAtMs = Date.now()
    record.eventSequence += 1
    if (event === 'assistant.delta') {
      const segmentId = text(payload.segmentId, 160)
      if (segmentId && record.segmentId !== segmentId) {
        // A tool loop creates a new Assistant bubble. Recovery state must
        // describe that current bubble, never concatenate prior reasoning.
        record.segmentId = segmentId
        record.text = ''
        record.reasoning = ''
        record.toolCalls = []
        record.truncated = false
      }
      const append = (key, value) => {
        const combined = record[key] + value
        if (combined.length > MAX_RECOVERY_CHARS) record.truncated = true
        record[key] = combined.slice(-MAX_RECOVERY_CHARS)
      }
      append('text', payload.textDelta || '')
      append('reasoning', payload.reasoningDelta || '')
      if (Object.hasOwn(payload, 'toolCalls')) record.toolCalls = payload.toolCalls
    }
    if (TERMINAL_EVENTS.has(event)) {
      record.terminal = true
      record.terminalPayload = payload
      if (record.readOnly) {
        clearTimeout(record.readTimer)
        configReads.delete(`${record.windowRef}:${record.requestId}`)
        record.resolveRead?.()
      }
      uploadManager?.releaseReservation?.({deviceId:record.deviceId,requestId:record.requestId})?.catch?.(() => {})
      uploadManager?.cleanupRequest?.({
        deviceId: record.deviceId, requestId: record.requestId, windowRef: record.windowRef
      })?.catch?.(() => {})
    }
    // Payload delivery failure/disconnect must never roll back or re-execute a Desktop command.
    try {
      for (const recipient of new Set([record.deviceId, ...(record.observers || [])])) {
        if (recipient === 'desktop' || revokedDevices.has(recipient)) continue
        broadcastToDevice(recipient, event, {requestId: record.requestId, conversationId: record.conversationId, windowId: record.windowRef || '', eventSequence: record.eventSequence, ...payload})
      }
    } catch { /* Query request state after reconnect. */ }
  }

  function finishClosed(session) {
    for (const record of requests.values()) {
      if (record.windowRef === session.windowRef && record.metadataCompletion && !record.metadataFinalizing && !record.terminal) {
        publish(record, 'conversation.operation.failed', {code: 'remote_renderer_closed'})
        record.resolveMetadata?.()
      }
    }

    closingConversations.delete(session.conversationId)
    session.closing = false
    for (const [key, read] of configReads) {
      if (read.windowRef !== session.windowRef) continue
      if (!read.terminal) publish(read, 'conversation.operation.failed', { code: 'remote_renderer_closed' })
      configReads.delete(key)
    }

    session.pendingChoices?.clear?.()
    if (session.queueTimer) clearTimeout(session.queueTimer)
    if (session.idleReleaseTimer) clearTimeout(session.idleReleaseTimer)
    session.queueTimer = null
    session.idleReleaseTimer = null
    for (const item of session.pendingSends || []) {
      const pending = requests.get(requestKey(item.deviceId, item.requestId))
      if (pending && !pending.terminal) publish(pending, 'assistant.failed', { code: 'remote_renderer_closed' })
    }
    session.pendingSends = []
    const record = requests.get(requestKey(session.activeDeviceId, session.activeRequestId))
    if (record && !record.terminal) publish(record, 'assistant.failed', { code: 'remote_renderer_closed' })
  }

  function hiddenSessionState(session) {
    const item = session ? windowItem(session.windowRef) : null
    const hasPendingChoices = session?.pendingChoices instanceof Map && session.pendingChoices.size > 0
    const busy = Boolean(
      session?.releasing || session?.activeRequestId || hasPendingChoices ||
      session?.pendingSends?.length || item?.busy || item?.generating || item?.compacting
    )
    return { item, busy }
  }

  async function releaseHiddenSession(session) {
    const conversationId = session?.conversationId || ''
    const { item, busy } = hiddenSessionState(session)
    if (!session || !item || item.remoteHidden !== true || busy) {
      return { released: false, ...(busy ? { busy: true } : {}) }
    }
    session.releasing = true
    try {
      const dispatched = await dispatchRemoteCommandToWindow(session.windowRef, {
        type: 'remote.shutdown', conversationId, closeHidden: true
      })
      if (!dispatched?.ok) throw remoteError('remote_renderer_dispatch_failed')
      // The renderer owns transcript persistence and the SQLite lease. It removes
      // the hidden window only after releasing that lease; visible Desktop windows
      // are never closed by this code path.
      const deadline = Date.now() + Math.max(10_000, readinessTimeoutMs)
      while (windowItem(session.windowRef)) {
        if (Date.now() >= deadline) throw remoteError('remote_writer_release_timeout')
        await new Promise((resolve) => setTimeout(resolve, 40))
      }
      if (sessions.get(conversationId) === session) handleWindowClosed(session.windowRef)
      return { released: true }
    } finally {
      if (sessions.get(conversationId) === session) session.releasing = false
    }
  }

  function scheduleIdleRelease(session) {
    if (!session || deletedConversations.has(session.conversationId) || session.idleReleaseTimer || !session.hidden || session.mobileControlled && !session.temporaryMetadata) return
    session.idleReleaseTimer = setTimeout(() => {
      session.idleReleaseTimer = null
      if (!enabled || sessions.get(session.conversationId) !== session) return
      void releaseHiddenSession(session).catch(() => {})
    }, REMOTE_HIDDEN_IDLE_RELEASE_MS)
    session.idleReleaseTimer.unref?.()
  }

  async function release({ deviceId, params = {} } = {}) {
    parameters(params, ['conversationId'])
    const safeDeviceId = id(deviceId, 'deviceId')
    const conversationId = id(params.conversationId, 'conversationId')
    assertActive(generation, safeDeviceId)
    const session = existingSession(conversationId)
    if (!session) return { ok: true, conversationId, released: false }
    if (session.mobileControlled) {
      requireMobileController(session, safeDeviceId)
      const { busy } = hiddenSessionState(session)
      // Navigation is not an ownership transfer. Mobile may manage several
      // opened sessions; only conversation.handoff explicitly returns control.
      return { ok: true, conversationId, released: false, mobileControlled: true, ...(busy ? { busy: true } : {}) }
    }
    const result = await releaseHiddenSession(session)
    return { ok: true, conversationId, ...result }
  }


  function requireMobileController(session, deviceId) {
    if (session?.desktopTakingOver || session?.controlTransfer) throw remoteError('remote_desktop_takeover_in_progress')
    if (!session?.mobileControlled) throw remoteError('remote_conversation_takeover_required')
    if (session.mobileDeviceId && session.mobileDeviceId !== deviceId) throw remoteError('remote_conversation_controlled_by_other_device')
  }

  // Stable business projection: never expose Renderer refs, paths or device IDs.
  function runtimeSnapshot({deviceId, params = {}} = {}) {
    parameters(params, ['conversationId'])
    const safeDeviceId = id(deviceId, 'deviceId')
    const conversationId = id(params.conversationId, 'conversationId')
    assertActive(generation, safeDeviceId)
    const session = sessions.get(conversationId)
    const candidates = deletedConversations.has(conversationId) ? [] : windows().filter(item => item.conversationId === conversationId)
    const writer = candidates.find(item => !item.readOnly && !item.leasePending)
    const candidateRecord = session?.activeRequestId ? requests.get(requestKey(session.activeDeviceId, session.activeRequestId)) : null
    const record = candidateRecord && (candidateRecord.deviceId === safeDeviceId || candidateRecord.observers?.has(safeDeviceId)) ? candidateRecord : null
    const owner = writer && session?.mobileControlled && session.windowRef === writer.id
      ? !session.mobileDeviceId || session.mobileDeviceId === safeDeviceId ? 'this_device' : 'other_device'
      : writer ? 'desktop' : candidates.length ? 'unknown' : 'none'
    const pendingChoices = owner === 'this_device' && session?.pendingChoices instanceof Map
      ? [...session.pendingChoices].map(([toolCallId, questions]) => ({toolCallId, questions: sanitizeChoiceQuestions(questions)})) : []
    const signature = `${session?.controlEpoch || ''}:${writer?.id || ''}:${owner}:${session?.desktopTakingOver === true}`
    const projectionKey = `${safeDeviceId}:${conversationId}`
    let projection = controlProjections.get(projectionKey)
    if (!projection || projection.signature !== signature) {
      projection = {signature, epoch: !writer && !session ? 'window-none' : crypto.randomUUID()}
      if (controlProjections.size >= 2048) controlProjections.delete(controlProjections.keys().next().value)
      controlProjections.set(projectionKey, projection)
    }

    const active = Boolean(session?.activeRequestId)
    const state = !writer && active ? 'recovering' : session?.closing || session?.desktopTakingOver || session?.controlTransfer ? 'finalizing'
      : pendingChoices.length ? 'waiting_input'
        : writer?.compacting ? 'running'
          : writer?.generating ? 'running'
            : active && record?.event === 'conversation.command.pending' ? 'preparing'
              : active || writer?.busy ? 'running'
                : candidates.length && !writer ? 'recovering' : 'idle'
    return {
      conversationId,
      execution: {state, operationId: record && !record.terminal ? record.requestId : null,
        phase: writer?.compacting ? 'compacting' : null},
      control: {owner, epoch: projection.epoch, canWrite: owner === 'this_device' && Boolean(writer) && !session?.desktopTakingOver && !session?.controlTransfer && !session?.closing},
      queue: {pendingCount: (session?.pendingSends || []).filter(item => item.deviceId === safeDeviceId).length},
      pendingChoices
    }
  }


  function openedSessions({ deviceId, params = {} } = {}) {
    parameters(params, [])
    const safeDeviceId = id(deviceId, 'deviceId')
    assertActive(generation, safeDeviceId)
    const result = []
    const seen = new Set()
    // Every conversation already open on Desktop is listable so Mobile can take
    // it over without opening it first. A read-only observer or a pending lease
    // is never offered: the writable writer stays the only control target.
    for (const item of windows()) {
      if (item.type !== 'window' || !item.conversationId || deletedConversations.has(item.conversationId) || seen.has(item.conversationId)) continue
      const candidates = windows().filter((candidate) =>
        candidate.type === 'window' && candidate.conversationId === item.conversationId
      )
      const writer = candidates.find((candidate) => !candidate.readOnly && !candidate.leasePending) || candidates[0]
      if (!writer || writer.readOnly === true) continue
      seen.add(item.conversationId)
      const session = sessions.get(item.conversationId)
      if (session?.temporaryMetadata) continue
      if (!session && writer.remoteHidden && creations.has(item.conversationId)) continue


      const hasDesktopObserver = candidates.some((candidate) =>
        candidate.id !== writer.id && candidate.remoteHidden !== true
      )
      result.push({
        conversationId: item.conversationId,
        title: text(writer.conversationTitle || writer.title, 240),
        windowId: writer.id,
        visible: writer.visible === true,
        busy: writer.busy === true || writer.generating === true || writer.compacting === true,
        mobileControlled: session?.mobileControlled === true,
        controlledByThisDevice: session?.mobileControlled === true && (!session.mobileDeviceId || session.mobileDeviceId === safeDeviceId),
        hidden: writer.remoteHidden === true,
        hasDesktopObserver
      })
    }
    return { ok: true, sessions: result.sort((left, right) => left.title.localeCompare(right.title, 'zh-CN') || left.conversationId.localeCompare(right.conversationId)) }
  }

  async function openForMobile({ deviceId, params = {} } = {}) {
    parameters(params, ['conversationId'])
    const safeDeviceId = id(deviceId, 'deviceId')
    const conversationId = id(params.conversationId, 'conversationId')
    const epoch = generation
    // An explicit open promotes an idle/background metadata writer. It must
    // never be collected as a one-shot writer after this device chose to use it.
    const intentKey = `${safeDeviceId}:${conversationId}`
    openingConversations.set(intentKey, (openingConversations.get(intentKey) || 0) + 1)
    const opening = sessions.get(conversationId)
    if (opening?.temporaryMetadata && (!opening.mobileDeviceId || opening.mobileDeviceId === safeDeviceId) && !opening.releasing) opening.temporaryMetadata = false

    const guardedCommand = commandGuard.getStore()
    const check = () => {assertActive(epoch, safeDeviceId); guardedCommand?.()}
    return serialize(conversationId, async () => {
      if (await confirmDeletedConversation(conversationId)) {await closeDeletedConversation(conversationId, false); throw remoteError('remote_conversation_not_found')}
      let session = existingSession(conversationId)
      const existed = Boolean(session)
      if (!session) {
        session = await ensureSession(conversationId, check)
        ensureMobileControl(session, safeDeviceId)
      } else if (session.mobileControlled) {
        requireMobileController(session, safeDeviceId)
        ensureMobileControl(session, safeDeviceId)
      } else if (session.hidden) {
        await ready(session.windowRef, check)
        ensureMobileControl(session, safeDeviceId)
      }
      const item = windowItem(session.windowRef)
      session.mobileOpened = true
      session.temporaryMetadata = false
      return {
        ok: true,
        conversationId,
        windowId: session.windowRef,
        created: !existed,
        mobileControlled: session.mobileControlled === true && (!session.mobileDeviceId || session.mobileDeviceId === safeDeviceId),
        observingDesktop: item?.remoteHidden !== true && session.mobileControlled !== true
      }
    }).finally(() => {
      const count = (openingConversations.get(intentKey) || 1) - 1
      if (count) openingConversations.set(intentKey, count)
      else openingConversations.delete(intentKey)
    })
  }


  // A control transfer changes admission authority, never the running operation identity.
  async function transferControl(session, {deviceId = '', mobile, type, check = () => {}}) {
    const item = windowItem(session.windowRef)
    if (!item || item.readOnly || item.leasePending || session.closing || session.releasing || session.controlTransfer || (session.activeRequestId && !['conversation.send', 'conversation.message.reask', 'conversation.compact'].includes(session.activeOperation))) throw remoteError('remote_conversation_busy')
    const receipt = {requestId: crypto.randomUUID(), expiresAt: Date.now() + readinessTimeoutMs,
      previousEpoch: session.controlEpoch, event: type === 'conversation.mobile.takeover' ? 'conversation.mobile.control.result' : type === 'conversation.mobile.handoff' ? 'conversation.handoff.control.result' : 'conversation.desktop.control.result', deviceId, mobile, check, done: false, ok: false, code: ''}
    session.controlTransfer = receipt
    try {
      // Reveal before commitment: a reveal failure must not report a completed handoff.
      if (!mobile && item.remoteHidden === true) {
        if (!revealRemoteConversationWindow(session.windowRef)?.ok) throw remoteError('remote_window_reveal_failed')
        session.hidden = false
      }
      const dispatched = await dispatchRemoteCommandToWindow(session.windowRef, {
        type, conversationId: session.conversationId, requestId: receipt.requestId,
        controlEpoch: receipt.previousEpoch, expiresAt: receipt.expiresAt
      })
      if (!receipt.done && !dispatched?.ok) throw remoteError('remote_renderer_dispatch_failed')
      while (!receipt.done) {
        check()
        if (!windowItem(session.windowRef) || sessions.get(session.conversationId) !== session) throw remoteError('remote_conversation_window_not_found')
        if (Date.now() >= receipt.expiresAt) throw remoteError('remote_control_transfer_timeout')
        await new Promise(resolve => setTimeout(resolve, 20))
      }
      if (!receipt.ok) throw remoteError(receipt.code || 'remote_control_transfer_failed')
      return {ok: true, conversationId: session.conversationId, windowId: session.windowRef, hidden: session.hidden, mobileControlled: mobile}
    } finally {
      if (session.controlTransfer === receipt) session.controlTransfer = null
      onControlChanged()
      if (!session.activeRequestId) void dispatchNextSend(session)
    }
  }

  async function takeover({deviceId, params = {}} = {}) {
    parameters(params, ['conversationId'])
    const safeDeviceId = id(deviceId, 'deviceId'), conversationId = id(params.conversationId, 'conversationId')
    const epoch = generation, guardedCommand = commandGuard.getStore()
    const check = () => {assertActive(epoch, safeDeviceId); guardedCommand?.()}
    return serialize(conversationId, async () => {
      const session = await ensureSession(conversationId, check)
      check()
      if (session.mobileControlled && session.mobileDeviceId && session.mobileDeviceId !== safeDeviceId) throw remoteError('remote_conversation_controlled_by_other_device')
      return transferControl(session, {deviceId: safeDeviceId, mobile: true, type: 'conversation.mobile.takeover', check})
    })
  }

  async function handoff({deviceId, params = {}} = {}) {
    parameters(params, ['conversationId'])
    const safeDeviceId = id(deviceId, 'deviceId'), conversationId = id(params.conversationId, 'conversationId')
    const epoch = generation, guard = commandGuard.getStore()
    const check = () => {assertActive(epoch, safeDeviceId); guard?.()}
    return serialize(conversationId, async () => {
      check()
      const session = existingSession(conversationId)
      requireMobileController(session, safeDeviceId)
      return transferControl(session, {mobile: false, type: 'conversation.mobile.handoff', check})
    })
  }

  async function closeConversation({ deviceId, params = {} } = {}) {
    parameters(params, ['conversationId'])
    const safeDeviceId = id(deviceId, 'deviceId')
    const conversationId = id(params.conversationId, 'conversationId')
    assertActive(generation, safeDeviceId)
    return serialize(conversationId, async () => {
      const session = existingSession(conversationId)
      if (!session) throw remoteError('remote_conversation_window_not_found')
      requireMobileController(session, safeDeviceId)
      if (session.closing || closingConversations.has(conversationId)) {
        return { ok: true, conversationId, windowId: session.windowRef, closing: true }
      }
      const item = windowItem(session.windowRef)
      if (!item) throw remoteError('remote_conversation_window_not_found')

      session.closing = true
      closingConversations.add(conversationId)
      if (session.queueTimer) clearTimeout(session.queueTimer)
      session.queueTimer = null
      const pending = Array.isArray(session.pendingSends) ? session.pendingSends.splice(0) : []
      try {
        for (const queued of pending) {
          const record = requests.get(requestKey(queued.deviceId, queued.requestId))
          if (record && !record.terminal) publish(record, 'assistant.cancelled', { code: 'remote_conversation_closed' })
        }
        const dispatched = await dispatchRemoteCommandToWindow(session.windowRef, {
          type: 'remote.shutdown', conversationId, closeWindow: true
        })
        if (!dispatched?.ok) throw remoteError('remote_renderer_dispatch_failed')

        // Renderer owns cancellation, final persistence, lease release and the
        // actual close. Main only waits for that normal window lifecycle.
        const deadline = Date.now() + Math.max(15_000, readinessTimeoutMs)
        while (windowItem(session.windowRef)) {
          if (Date.now() >= deadline) throw remoteError('remote_conversation_close_timeout')
          await new Promise((resolve) => setTimeout(resolve, 40))
        }
        if (sessions.get(conversationId) === session) handleWindowClosed(session.windowRef)
        return { ok: true, conversationId, windowId: session.windowRef, closed: true }
      } catch (error) {
        if (sessions.get(conversationId) === session) session.closing = false
        closingConversations.delete(conversationId)
        throw error
      }
    })
  }



  // Local IPC only; never exposed as a paired-device RPC or a lease override.
  function controlledSessions({ deviceId = '' } = {}) {
    const selectedDevice = deviceId ? id(deviceId, 'deviceId') : ''
    const result = []
    for (const conversationId of new Set([...sessions.keys(), ...windows().map(item => item.conversationId).filter(Boolean)])) {
      const session = existingSession(conversationId)
      const item = session && windowItem(session.windowRef)
      if (!item || !session.mobileControlled || (selectedDevice && session.mobileDeviceId !== selectedDevice)) continue
      result.push({conversationId, deviceId: session.mobileDeviceId || '', windowId: session.windowRef,
        title: text(item.conversationTitle || item.title, 240) || '未命名会话', hidden: item.remoteHidden === true,
        busy: Boolean(session.activeRequestId || item.busy || item.generating || item.compacting)})
    }
    return {ok: true, sessions: result}
  }

  async function takeoverOnDesktop({conversationId, confirmed = false} = {}) {
    const target = id(conversationId, 'conversationId')
    if (!confirmed) throw remoteError('remote_takeover_confirmation_required')
    return serialize(target, async () => {
      if (await confirmDeletedConversation(target)) {
        await closeDeletedConversation(target)
        return {ok: true, conversationId: target, mobileControlled: false, deleted: true, closed: true}
      }
      const session = existingSession(target)
      if (!session) throw remoteError('remote_conversation_window_not_found')
      if (!session.mobileControlled) return showOnDesktop({params: {conversationId: target}})
      const epoch = generation
      return transferControl(session, {mobile: false, type: 'conversation.desktop.takeover', check: () => {if (!enabled || epoch !== generation) throw remoteError('remote_gateway_stopped')}})
    })
  }


  function observeOnDesktop({ conversationId } = {}) {
    const safeConversationId = id(conversationId, 'conversationId')
    const session = existingSession(safeConversationId)
    if (!session?.mobileControlled) return { ok: true, reused: false }
    const item = windowItem(session.windowRef)
    if (!item) return { ok: true, reused: false }
    showOnDesktop({params: {conversationId: safeConversationId}})
    return { ok: true, reused: true, conversationId: safeConversationId, windowId: session.windowRef, mobileControlled: true }
  }


  async function listAssistants({ deviceId, params = {} } = {}) {
    parameters(params, [])
    const epoch = generation
    assertActive(epoch, id(deviceId, 'deviceId'))
    const configResult = await getConfig()
    assertActive(epoch, deviceId)
    const config = object(configResult?.config)
    const prompts = object(config.prompts)
    const providers = object(config.providers)
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
          model: displayModelLabel(source.model, providers),
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
    const guardedCommand = commandGuard.getStore()
    const check = () => {assertActive(epoch, safeDeviceId); guardedCommand?.()}
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
        if (session.idleReleaseTimer) clearTimeout(session.idleReleaseTimer)
        session.idleReleaseTimer = null
        session.mobileOpened = true
        session.mobileControlled = true
        session.mobileDeviceId = safeDeviceId
      session.controlEpoch = crypto.randomUUID()
        record.conversationId = conversationId
        const result = { ok: true, conversationId, windowId: windowRef, hidden: session.hidden, created: true,
          promptCode, title: text(item.conversationTitle, 240) || `${promptCode} - 新会话` }
        // Mobile routes use the exact same Desktop-owned seven-day weight as
        // the Agent summon panel. Recording must never block a valid chat.
        await recordAssistantUsage(promptCode).catch(() => {})
        publish(record, 'conversation.operation.completed', { ...result, operation: 'conversation.create' })
        // A newly created hidden writer may remain idle if Mobile leaves before
        // sending its first message. Release its Renderer lease after the same
        // short idle window used for completed requests.
        scheduleIdleRelease(session)
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


  function ensureMobileControl(session, deviceId) {
    if (session?.desktopTakingOver || session?.controlTransfer) throw remoteError('remote_desktop_takeover_in_progress')
    if (session?.mobileControlled) {
      if (session.mobileDeviceId && session.mobileDeviceId !== deviceId) throw remoteError('remote_conversation_controlled_by_other_device')
      if (!session.mobileDeviceId) {
        const previousEpoch = session.controlEpoch
        session.mobileDeviceId = deviceId; session.controlEpoch = crypto.randomUUID()
        commandGuard.getStore()?.bindWriter?.(session, deviceId, previousEpoch)
      }
      return
    }
    // A hidden writer only exists for Mobile. The first paired device that
    // reaches a freshly created hidden session owns it; visible Desktop writers
    // must be explicitly taken over instead of being silently commandeered.
    if (session?.hidden) {
      const previousEpoch = session.controlEpoch
      session.mobileOpened = true
      session.mobileControlled = true
      session.mobileDeviceId = deviceId
      session.controlEpoch = crypto.randomUUID()
      commandGuard.getStore()?.bindWriter?.(session, deviceId, previousEpoch)
      onControlChanged()
      return
    }
    throw remoteError('remote_conversation_takeover_required')
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
    if (!enabled || deletedConversations.has(session?.conversationId) || session?.closing || session?.desktopTakingOver || session?.controlTransfer || sessions.get(session.conversationId) !== session || session.activeRequestId || session.dispatchingQueued || !Array.isArray(session.pendingSends) || session.pendingSends.length === 0) return
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
    const guardedCommand = commandGuard.getStore()
    const check = () => {assertActive(epoch, safeDeviceId); guardedCommand?.()}
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
      ensureMobileControl(session, safeDeviceId)
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
        session.pendingSends.push({ deviceId: safeDeviceId, requestId: safeRequestId, check: () => {assertActive(epoch, safeDeviceId); if (sessions.get(conversationId) !== session || !windowItem(session.windowRef) || session.closing) throw remoteError('remote_request_cancelled')} })
        const result = queueResult(session, record)
        if (!session.activeRequestId) void dispatchNextSend(session)
        return result
      }
      return dispatchSendRecord(session, record, check)
    }).catch((error) => {
      // Failures before Renderer dispatch (e.g. control/lease/window changed)
      // must not leave a recoverable request permanently command.pending.
      if (!record.terminal) publish(record, 'assistant.failed', {code: error?.code || 'remote_renderer_dispatch_failed'})
      throw error
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
    const guardedCommand = commandGuard.getStore()
    const check = () => {assertActive(epoch, safeDeviceId); guardedCommand?.()}
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
        ensureMobileControl(session, safeDeviceId)
        const item = windowItem(session.windowRef)
        if (session.activeRequestId || item?.busy || item?.generating || item?.compacting) throw remoteError('remote_conversation_busy')
        session.activeRequestId = safeRequestId
        session.activeDeviceId = safeDeviceId
        session.activeOperation = operation
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
          session.activeRequestId = ''; session.activeDeviceId = ''; session.activeOperation = ''
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
      : operation === 'conversation.project.set' ? ['conversationId', 'projectId'] : ['conversationId', 'confirmed']
    parameters(params, allowed)
    const conversationId = id(params.conversationId, 'conversationId')
    if (/\.(json|db)$/i.test(conversationId)) throw remoteError('remote_conversation_id_invalid')
    const safeDeviceId = id(deviceId, 'deviceId')
    const safeRequestId = id(requestId, 'requestId')
    const title = operation === 'conversation.rename' ? text(params.title, 241).trim() : ''
    if (operation === 'conversation.rename' && (!title || title.length > 240)) throw remoteError('remote_conversation_title_invalid')
    if (operation === 'conversation.delete' && params.confirmed !== true) throw remoteError('remote_confirmation_required')

    const projectId = operation === 'conversation.project.set' ? params.projectId : ''
    if (operation === 'conversation.project.set' && (typeof projectId !== 'string' || projectId.length > 160 || /[\\/]/.test(projectId) || [...projectId].some(character => character.charCodeAt(0) < 32))) throw remoteError('remote_project_id_invalid')
    const epoch = generation
    const guardedCommand = commandGuard.getStore()
    const check = () => {assertActive(epoch, safeDeviceId); guardedCommand?.()}
    check()
    const key = requestKey(safeDeviceId, safeRequestId)
    const fingerprint = crypto.createHash('sha256').update(JSON.stringify({ operation, conversationId, title, projectId, confirmed: params.confirmed === true })).digest('hex')
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
      const hadSession = Boolean(existingSession(conversationId))
      record.createdHiddenWriter = !hadSession
      try {
        const session = await ensureSession(conversationId, check, !hadSession)
        check()
        if (!hadSession) session.temporaryMetadata = !openingConversations.has(`${safeDeviceId}:${conversationId}`)
        ensureMobileControl(session, safeDeviceId)
        if (session.temporaryMetadata) session.mobileOpened = false
        check()
        const item = windowItem(session.windowRef)
        if (session.activeRequestId || item?.busy || item?.generating || item?.compacting) throw remoteError('remote_conversation_busy')
        session.activeRequestId = safeRequestId
        session.activeDeviceId = safeDeviceId
        if (session.temporaryMetadata && operation !== 'conversation.delete') {
          record.metadataCompletion = new Promise(resolve => {record.resolveMetadata = resolve})
        }

        session.activeOperation = operation
        record.windowRef = session.windowRef
        const dispatched = await dispatchRemoteCommandToWindow(session.windowRef, {
          type: operation,
          requestId: safeRequestId,
          deviceId: safeDeviceId,
          conversationId,
          ...(operation === 'conversation.rename' ? { title } : operation === 'conversation.project.set' ? {projectId} : { confirmed: true })
        })
        if (!dispatched?.ok) throw remoteError('remote_renderer_dispatch_failed')
        const result = { ok: true, operation, conversationId, windowId: session.windowRef, hidden: session.hidden, created: !hadSession }
        record.result = result
        if (record.eventSequence === 0) publish(record, 'conversation.command.accepted', result)
        if (record.metadataCompletion) await record.metadataCompletion
        return result
      } catch (error) {
        const session = sessions.get(conversationId)
        if (session?.activeRequestId === safeRequestId && session.activeDeviceId === safeDeviceId) {
          session.activeRequestId = ''
          session.activeDeviceId = ''
          session.activeOperation = ''
        }
        publish(record, 'conversation.operation.failed', { code: error?.code || 'remote_renderer_dispatch_failed' })
        if (record.createdHiddenWriter && session?.hidden && (!session.mobileDeviceId || session.mobileDeviceId === safeDeviceId)) await releaseHiddenSession(session).catch(() => {})
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
    const guardedCommand = commandGuard.getStore()
    const check = () => {assertActive(epoch, safeDeviceId); guardedCommand?.()}
    check()
    const key = requestKey(safeDeviceId, safeRequestId)
    const fingerprint = crypto.createHash('sha256').update(JSON.stringify({ operation, conversationId, patch })).digest('hex')
    const previous = requests.get(key)
    if (previous) {
      if (previous.fingerprint !== fingerprint) throw remoteError('remote_request_id_conflict')
      return { ...(await previous.dispatched), duplicate: true }
    }
    pruneRequests(operation === 'conversation.config.get')
    const record = {
      deviceId: safeDeviceId, requestId: safeRequestId, conversationId, fingerprint,
      event: 'conversation.command.pending', eventSequence: 0, terminal: false,
      text: '', reasoning: '', truncated: false, updatedAtMs: Date.now(), windowRef: ''
    }
    record.readOnly = operation === 'conversation.config.get'
    if (record.readOnly) {
      record.readCompletion = new Promise(resolve => {record.resolveRead = resolve})
      record.readTimer = setTimeout(() => publish(record, 'conversation.operation.failed', {code: 'remote_resource_read_timeout'}), configReadTimeoutMs)
      record.readTimer.unref?.()
    }
    requests.set(key, record)
    const execution = serialize(conversationId, async () => {
      try {
        if (record.terminal) throw remoteError('remote_resource_read_timeout')
        const hadSession = Boolean(existingSession(conversationId))
        const session = await ensureSession(conversationId, check)
        check()
        if (record.terminal) throw remoteError('remote_resource_read_timeout')
        const readOnly = operation === 'conversation.config.get'
        const independent = readOnly || operation === 'conversation.config.patch'
        if (!readOnly) ensureMobileControl(session, safeDeviceId)
        const item = windowItem(session.windowRef)
        if (!independent && (session.activeRequestId || item?.busy || item?.generating || item?.compacting)) throw remoteError('remote_conversation_busy')
        if (session.activeRequestId === safeRequestId || configReads.has(`${session.windowRef}:${safeRequestId}`)) throw remoteError('remote_request_id_conflict')
        record.windowRef = session.windowRef
        record.readOnly = readOnly
        if (independent) {
          const readKey = `${session.windowRef}:${safeRequestId}`
          if (configReads.has(readKey)) throw remoteError('remote_request_id_conflict')
          configReads.set(readKey, record)
        } else {
          session.activeRequestId = safeRequestId
          session.activeDeviceId = safeDeviceId
          session.activeOperation = operation
        }
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
        configReads.delete(`${record.windowRef}:${safeRequestId}`)
        const session = sessions.get(conversationId)
        if (session?.activeRequestId === safeRequestId && session.activeDeviceId === safeDeviceId) {
          session.activeRequestId = ''; session.activeDeviceId = ''; session.activeOperation = ''
        }
        publish(record, 'conversation.operation.failed', { code: error?.code || 'remote_renderer_dispatch_failed' })
        throw error
      }
    })
    record.dispatched = record.readOnly ? Promise.race([execution, record.readCompletion.then(() => {
      if (record.event.endsWith('.failed')) throw remoteError(record.terminalPayload?.code || 'remote_resource_read_failed')
      return record.result || {ok: true}
    })]) : execution
    return record.dispatched
  }

  async function waitConfigRead({deviceId, requestId}) {
    const record = requests.get(requestKey(deviceId, requestId))
    if (!record?.readOnly) throw remoteError('remote_request_not_found')
    await record.readCompletion
    if (record.event.endsWith('.failed')) throw remoteError(record.terminalPayload?.code || 'remote_resource_read_failed')
    return record.terminalPayload
  }


  async function compact({ deviceId, requestId, params = {} } = {}) {
    parameters(params, ['conversationId'])
    const conversationId = id(params.conversationId, 'conversationId')
    const safeDeviceId = id(deviceId, 'deviceId')
    const safeRequestId = id(requestId, 'requestId')
    const epoch = generation
    const guardedCommand = commandGuard.getStore()
    const check = () => {assertActive(epoch, safeDeviceId); guardedCommand?.()}
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
        ensureMobileControl(session, safeDeviceId)
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
    requireMobileController(session, deviceId)
    const result = await dispatchRemoteCommandToWindow(session.windowRef, {
      type: 'conversation.compact.cancel', requestId: id(requestId, 'requestId'),
      targetRequestId: session.activeRequestId, conversationId
    })
    if (!result?.ok) throw remoteError('remote_renderer_dispatch_failed')
    return { ok: true, conversationId, windowId: session.windowRef, targetRequestId: session.activeRequestId }
  }


  // Renderer pulls at the same tool-result boundary as its local append buffer.
  // Claims stay in pendingSends until durable acknowledgement; they are never replayed.
  async function drainSendQueue(session, data) {
    const parentRequestId = data.requestId
    if (!enabled && session.activeDeviceId === 'desktop' && session.activeRequestId === parentRequestId && !session.mobileControlled && !session.closing) return {ok: true, items: []}
    if (!enabled || !parentRequestId || session.activeRequestId !== parentRequestId ||
        !['conversation.send', 'conversation.message.reask'].includes(session.activeOperation) ||
        session.closing || session.desktopTakingOver) return {ok: false}
    const items = []
    for (const queued of [...session.pendingSends]) {
      const record = requests.get(requestKey(queued.deviceId, queued.requestId))
      if (!record || record.terminal || record.appendParentRequestId) continue
      record.appendParentRequestId = parentRequestId
      try {
        queued.check()
        if (record.uploadIds.length) await uploadManager.authorizeForRequest({deviceId: queued.deviceId, requestId: record.requestId, windowRef: session.windowRef, uploadIds: record.uploadIds})
        queued.check()
        if (session.activeRequestId !== parentRequestId || record.terminal || session.closing || session.desktopTakingOver) throw remoteError('remote_request_cancelled')
        items.push({requestId: record.requestId, text: record.body, uploadIds: record.uploadIds})
      } catch (error) {
        session.pendingSends = session.pendingSends.filter(item => item !== queued)
        if (!record.terminal) publish(record, 'assistant.failed', {code: error?.code || 'remote_attachment_unavailable'})
      }
    }
    return {ok: true, items}
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
      activeRequestId: session?.activeRequestId && (session.activeDeviceId === deviceId || requests.get(requestKey(session.activeDeviceId, session.activeRequestId))?.observers?.has(deviceId)) ? session.activeRequestId : '',
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
    requireMobileController(session, deviceId)
    const index = session.pendingSends.findIndex((item) => item.deviceId === deviceId && item.requestId === queuedRequestId)
    if (index < 0) throw remoteError('remote_send_queue_item_not_found')
    const record = requests.get(requestKey(deviceId, queuedRequestId))
    if (record?.appendParentRequestId) throw remoteError('remote_send_queue_item_not_found')
    session.pendingSends.splice(index, 1)
    uploadManager?.releaseReservation?.({deviceId, requestId: queuedRequestId})?.catch?.(() => {})
    if (record && !record.terminal) publish(record, 'assistant.cancelled', { code: 'remote_send_queue_removed' })
    return { ok: true, conversationId, requestId: queuedRequestId, removed: true }
  }


  async function submitChoice({ deviceId, params = {} } = {}) {
    parameters(params, ['conversationId', 'toolCallId', 'responses'])
    const conversationId = id(params.conversationId, 'conversationId')
    const toolCallId = id(params.toolCallId, 'toolCallId')
    assertActive(generation, deviceId)
    const session = existingSession(conversationId)
    requireMobileController(session, deviceId)
    if (!session?.activeRequestId || !['conversation.send', 'conversation.message.reask'].includes(session.activeOperation)) {
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
    requireMobileController(session, deviceId)
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
    const requestId = id(params.requestId, 'requestId')
    const record = requests.get(requestKey(deviceId, requestId)) || [...requests.values()].find(item => item.requestId === requestId && item.observers?.has(deviceId))
    if (!record) throw remoteError('remote_request_not_found')
    return {
      ok: true, requestId: record.requestId, conversationId: record.conversationId,
      windowId: record.windowRef, event: record.event, eventSequence: record.eventSequence,
      terminal: record.terminal, text: record.text, reasoning: record.reasoning,
      segmentId: record.segmentId || '', toolCalls: Array.isArray(record.toolCalls) ? record.toolCalls : [],
      truncated: record.truncated, updatedAt: new Date(record.updatedAtMs).toISOString(),
      ...(record.terminal ? { result: { ...record.terminalPayload } } : {})
    }
  }

  function handleRendererEvent({ windowRef, payload } = {}) {
    const data = object(payload)
    const session = data.event === 'conversation.execution.started' ? existingSession(data.conversationId) : sessions.get(data.conversationId)
    if (!session || session.windowRef !== windowRef) return { ok: false, error: 'remote_renderer_event_window_mismatch' }
    if (data.event === 'conversation.control.status') {
      const receipt = session.lastControlTransfer
      if (!receipt || receipt.requestId !== data.requestId || Date.now() >= receipt.expiresAt) return {ok: false}
      return {ok: true, mobileControlled: session.mobileControlled, controlEpoch: session.controlEpoch}
    }
    if (data.event === 'conversation.execution.started') {
      if (!enabled || windowItem(windowRef)?.readOnly || windowItem(windowRef)?.leasePending || session.activeRequestId || session.closing || !/^desktop-turn-[a-f0-9-]{36}$/.test(data.requestId || '') || session.mobileControlled && data.payload?.admittedBuffer !== true) return {ok: false, error: 'remote_conversation_busy'}
      pruneRequests()
      const record = {deviceId: 'desktop', requestId: data.requestId, conversationId: data.conversationId, windowRef,
        event: 'assistant.started', eventSequence: 0, terminal: false, text: '', reasoning: '', truncated: false, updatedAtMs: Date.now(), observers: new Set(session.mobileControlled && session.mobileDeviceId ? [session.mobileDeviceId] : [])}
      requests.set(requestKey('desktop', data.requestId), record)
      session.activeRequestId = data.requestId; session.activeDeviceId = 'desktop'; session.activeOperation = 'conversation.send'
      publish(record, 'assistant.started', {})
      return {ok: true}
    }
    if (data.event === 'conversation.shutdown.result') {
      const receipt = session.shutdownReceipt
      if (!receipt || receipt.requestId !== data.requestId || receipt.done || Date.now() >= receipt.expiresAt) {
        return {ok: false, error: 'remote_renderer_event_request_mismatch'}
      }
      receipt.done = true
      receipt.ok = data.payload?.ok === true
      receipt.code = receipt.ok ? '' : 'remote_conversation_save_failed'
      return {ok: true}
    }
    if (data.event === 'conversation.queue.drain') {
      // Never wait behind takeover/close: those commands await this AI turn's settlement.
      return drainSendQueue(session, data)
    }
    if (data.event === 'conversation.queue.appended' || data.event === 'conversation.queue.append.failed') {
      const matches = [...requests.values()].filter(item => item.requestId === data.requestId && item.windowRef === windowRef && item.appendParentRequestId === session.activeRequestId)
      const record = matches.length === 1 ? matches[0] : null
      if (!record || record.terminal || !record.appendParentRequestId || record.appendParentRequestId !== session.activeRequestId) return {ok: false, error: 'remote_renderer_event_request_mismatch'}
      session.pendingSends = session.pendingSends.filter(item => item.requestId !== record.requestId || item.deviceId !== record.deviceId)
      const revision = Math.max(0, Number(data.payload?.revision) || 0)
      // Completing this input receipt must not complete or replace its parent AI turn.
      publish(record, data.event === 'conversation.queue.appended' ? 'assistant.completed' : 'assistant.failed',
        data.event === 'conversation.queue.appended' ? {revision} : {code: 'remote_buffered_message_failed'})
      if (revision > 0) { try { onConversationRevision({windowRef, conversationId: session.conversationId, revision}) } catch { /* observer only */ } }
      return {ok: true}
    }
    if (['conversation.mobile.control.result', 'conversation.desktop.control.result', 'conversation.handoff.control.result'].includes(data.event)) {
      const receipt = session.controlTransfer
      if (!receipt || receipt.requestId !== data.requestId || receipt.event !== data.event || receipt.done || Date.now() >= receipt.expiresAt || receipt.previousEpoch !== session.controlEpoch ||
          (data.payload?.controlEpoch !== undefined && data.payload.controlEpoch !== receipt.previousEpoch)) return {ok: false, error: 'remote_renderer_event_request_mismatch'}
      try {receipt.check()} catch {return {ok: false, error: 'remote_control_epoch_conflict'}}
      receipt.done = true
      receipt.ok = data.payload?.ok === true
      receipt.code = ['remote_conversation_busy', 'remote_conversation_save_failed', 'remote_conversation_read_only'].includes(data.payload?.code) ? data.payload.code : 'remote_control_transfer_failed'
      if (receipt.ok) {
        session.mobileControlled = receipt.mobile
        session.mobileDeviceId = receipt.mobile ? receipt.deviceId : ''
        session.mobileOpened = receipt.mobile || session.mobileOpened
        session.controlEpoch = crypto.randomUUID()
        session.lastControlTransfer = {requestId: receipt.requestId, expiresAt: Date.now() + 60_000}
        if (receipt.mobile) {
          const active = requests.get(requestKey(session.activeDeviceId, session.activeRequestId))
          if (active && !active.terminal) (active.observers ||= new Set()).add(receipt.deviceId)
          if (session.idleReleaseTimer) clearTimeout(session.idleReleaseTimer)
          session.idleReleaseTimer = null
        }
        onControlChanged()
      }
      return {ok: receipt.ok}
    }

    if (!RENDERER_EVENTS.has(data.event)) return { ok: false, error: 'remote_renderer_event_invalid' }
    const readKey = `${windowRef}:${data.requestId}`
    const read = configReads.get(readKey)
    if (read && read.conversationId === data.conversationId && !read.terminal) {
      if (!['conversation.config.result', 'conversation.operation.failed'].includes(data.event)) {
        return { ok: false, error: 'remote_renderer_event_invalid' }
      }
      publish(read, data.event, sanitizeEvent(data.event, data.payload))
      configReads.delete(readKey)
      scheduleIdleRelease(session)
      return { ok: true }
    }

    if (!session.activeRequestId || session.activeRequestId !== data.requestId) return { ok: false, error: 'remote_renderer_event_request_mismatch' }
    const record = requests.get(requestKey(session.activeDeviceId, data.requestId))
    if (!record || record.terminal) return { ok: false, error: 'remote_renderer_event_request_mismatch' }
    const sanitizedPayload = sanitizeEvent(data.event, data.payload)
    if (data.event === 'conversation.choice.resolved') session.pendingChoices.delete(text(data.payload?.toolCallId, 160))
    if (data.event === 'conversation.choice.required') {
      if (!sanitizedPayload.toolCallId || !sanitizedPayload.questions.length) return { ok: false, error: 'remote_choice_event_invalid' }
      session.pendingChoices.set(sanitizedPayload.toolCallId, sanitizedPayload.questions)
    }
    if (record.metadataCompletion && TERMINAL_EVENTS.has(data.event)) {
      // Ack the Renderer event now (it may await this IPC). Publish terminal
      // only after normal hidden-writer close; never deadlock its finalizer.
      if (record.metadataFinalizing) return {ok: true}
      record.metadataFinalizing = true
      session.activeRequestId = ''; session.activeDeviceId = ''; session.activeOperation = ''
      Promise.resolve().then(async () => {
        let cleanupFailed = false
        if (session.temporaryMetadata && session.hidden && session.mobileDeviceId === record.deviceId) {
          try {await releaseHiddenSession(session)} catch {cleanupFailed = true; scheduleIdleRelease(session)}
        }
        const revision = Math.max(0, Number(sanitizedPayload?.revision) || 0)
        if (revision > 0) {try {onConversationRevision?.({windowRef, conversationId: record.conversationId, revision})} catch { /* observer only */ }}
        publish(record, cleanupFailed ? 'conversation.operation.failed' : data.event,
          cleanupFailed ? {code: 'remote_writer_release_timeout'} : sanitizedPayload)
        record.resolveMetadata?.()
      }).catch(() => {
        publish(record, 'conversation.operation.failed', {code: 'remote_writer_release_timeout'})
        record.resolveMetadata?.()
      })
      return {ok: true}
    }

    publish(record, data.event, sanitizedPayload)

    const revision = Math.max(0, Number(sanitizedPayload?.revision) || 0)
    if (revision > 0 && typeof onConversationRevision === 'function') {
      try { onConversationRevision({ windowRef, conversationId: session.conversationId, revision }) } catch { /* observers never affect the writer */ }
    }
    if (record.terminal) {
      if (session.activeOperation === 'conversation.delete' && data.event === 'conversation.operation.completed' && sanitizedPayload.deleted) {
        retireDeletedConversation(session.conversationId)
      }
      for (const queued of [...session.pendingSends]) {
        const appended = requests.get(requestKey(queued.deviceId, queued.requestId))
        if (appended?.appendParentRequestId !== record.requestId) continue
        session.pendingSends = session.pendingSends.filter(item => item !== queued)
        if (!appended.terminal) publish(appended, 'assistant.failed', {code: 'remote_buffered_message_unconfirmed'})
      }
      session.activeRequestId = ''
      session.activeDeviceId = ''
      session.activeOperation = ''
      session.pendingChoices?.clear?.()
      void dispatchNextSend(session)
      scheduleIdleRelease(session)

      if (record.createdHiddenWriter && data.event === 'conversation.operation.failed' && session.hidden && (!session.mobileDeviceId || session.mobileDeviceId === record.deviceId)) releaseHiddenSession(session).catch(() => {})
    }
    return { ok: true }
  }

  function handleWindowClosed(windowRef) {
    for (const read of requests.values()) if (read.readOnly && read.windowRef === windowRef && !read.terminal) publish(read, 'conversation.operation.failed', {code: 'remote_renderer_closed'})
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
    for (const [key, read] of configReads) {
      if (read.deviceId !== deviceId) continue
      publish(read, 'conversation.operation.failed', { code: 'remote_device_revoked' })
      configReads.delete(key)
    }
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
    for (const read of requests.values()) if (read.readOnly && !read.terminal) publish(read, 'conversation.operation.failed', {code: 'remote_gateway_stopped'})
    for (const read of configReads.values()) publish(read, 'conversation.operation.failed', { code: 'remote_gateway_stopped' })
    configReads.clear()
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

      await reconcileDeletedSessions()
      await Promise.allSettled([...creations.values()])
      const targets = []
      const dispatchResults = await Promise.allSettled([...sessions.values()].map(async (session) => {
        const item = windowItem(session.windowRef)
        if (!item) { handleWindowClosed(session.windowRef); return }
        session.hidden = item.remoteHidden === true
        if (!session.hidden && !session.mobileControlled && (!session.activeRequestId || session.activeDeviceId === 'desktop')) return
        // The receipt is scoped to this writer and this stop attempt; dispatch alone is not success.
        const receipt = {requestId: crypto.randomUUID(), done: false, ok: false, expiresAt: Date.now() + Math.max(15000, readinessTimeoutMs)}
        session.shutdownReceipt = receipt
        targets.push(session)
        if (session.hidden && !deletedConversations.has(session.conversationId)) await ready(session.windowRef).catch(() => {})
        const result = await dispatchRemoteCommandToWindow(session.windowRef, {
          type: 'remote.shutdown', requestId: receipt.requestId, conversationId: session.conversationId,
          closeHidden: session.hidden, conversationDeleted: deletedConversations.has(session.conversationId)
        })
        if (!result?.ok) throw remoteError('remote_renderer_dispatch_failed')
      }))
      try {
        const failedDispatch = dispatchResults.find(result => result.status === 'rejected')
        if (failedDispatch) throw failedDispatch.reason
        while (true) {
          let pending = false
          for (const session of targets) {
            const item = windowItem(session.windowRef)
            if (!item) continue
            const receipt = session.shutdownReceipt
            if (receipt?.done && !receipt.ok) throw remoteError(receipt.code)
            if (item.remoteHidden === true || session.activeRequestId || !receipt?.done) {
              if (Date.now() >= receipt.expiresAt) throw remoteError('remote_writer_shutdown_timeout')
              pending = true
            }
          }
          if (!pending) break
          await new Promise((resolve) => setTimeout(resolve, 40))
        }
        for (const session of targets) {
          if (windowItem(session.windowRef)) {
            session.mobileControlled = false
            session.mobileOpened = false
            session.mobileDeviceId = ''
            session.controlEpoch = crypto.randomUUID()
          }
        }
        onControlChanged()
      } finally {
        for (const session of targets) session.shutdownReceipt = null
      }
      // Keep live visible entries for reuse; never destroy a writer before saving.
    })().finally(() => { closing = null })
    return closing
  }

  return {
    send,
    runtimeSnapshot,

    withCommandGuard: (guard, action) => commandGuard.run(guard, action),

    supportsContextUsage: true,
    listSendQueue, removeQueuedSend, submitChoice,
    listAssistants, createConversation,

    forkMessage: (input) => mutate({ ...input, operation: 'conversation.message.fork' }),
    editMessage: (input) => mutate({ ...input, operation: 'conversation.message.edit' }),
    deleteMessage: (input) => mutate({ ...input, operation: 'conversation.message.delete' }),
    reaskMessage: (input) => mutate({ ...input, operation: 'conversation.message.reask' }),
    renameConversation: (input) => conversationMetadataCommand({ ...input, operation: 'conversation.rename' }),

    setConversationProject: (input) => conversationMetadataCommand({...input, operation: 'conversation.project.set'}),
    deleteConversation: (input) => conversationMetadataCommand({ ...input, operation: 'conversation.delete' }),
    waitConfigRead,
    getConfig: (input) => configCommand({ ...input, operation: 'conversation.config.get' }),
    patchConfig: (input) => configCommand({ ...input, operation: 'conversation.config.patch' }),
    refreshContext: (input) => configCommand({ ...input, operation: 'conversation.context.refresh' }),
    compact,
    cancelCompact,
    cancel, release, openForMobile, takeover, handoff, closeConversation, openedSessions, reconcileDeletedSessions, observeOnDesktop, controlledSessions, takeoverOnDesktop, showOnDesktop, getRequest, handleRendererEvent, handleWindowClosed,
    revokeDevice, closeAll,
    resume: () => { enabled = true },
    authorizeDevice: (deviceId) => { revokedDevices.delete(deviceId) },
    getSession: (conversationId) => { const session = existingSession(conversationId); return session ? { ...session, readOnly: windowItem(session.windowRef)?.readOnly === true } : null }
  }
}
