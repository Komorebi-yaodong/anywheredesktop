import crypto from 'node:crypto'
import { normalizeIdentifier, remoteError } from './protocol.js'

const REQUEST_TTL_MS = 30 * 60 * 1000
const MAX_REQUESTS = 256
const MAX_RECOVERY_CHARS = 64 * 1024
const TERMINAL_EVENTS = new Set([
  'assistant.completed', 'assistant.cancelled', 'assistant.failed',
  'conversation.operation.completed', 'conversation.operation.failed', 'conversation.config.result'
])
const RENDERER_EVENTS = new Set([
  'conversation.command.acknowledged', 'assistant.started', 'assistant.delta', ...TERMINAL_EVENTS
])
const PATH_KEYS = new Set([
  'path', 'filepath', 'file_path', 'dirpath', 'dir_path', 'dbfile', 'db_file',
  'legacyjson', 'legacy_json', 'worktreedir', 'worktree_dir', 'localchatpath', 'local_chat_path'
])
const text = (value, limit = 160) => typeof value === 'string' ? value.slice(0, limit) : ''
const object = (value) => value && typeof value === 'object' && !Array.isArray(value) ? value : {}
const id = (value, field) => normalizeIdentifier(value, field, { minLength: field === 'requestId' ? 8 : 16, maxLength: 160 })

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
  if (event === 'conversation.config.result') return sanitizeConfigResult(source)
  if (TERMINAL_EVENTS.has(event)) return {
    completedAt: text(source.completedAt, 80), revision: Math.max(0, Math.floor(Number(source.revision) || 0)),
    operation: text(source.operation, 40), uiMessageId: text(source.uiMessageId, 160)
  }
  return { hidden: source.hidden === true, created: source.created === true }
}

/** Main-process routing only. Renderer remains the sole conversation writer/lease holder. */
export function createRemoteSessionManager({
  getConfig, openConversation, listWindows, openWindow, getWindowByRef,
  dispatchRemoteCommandToWindow, revealRemoteConversationWindow, broadcastToDevice,
  readinessTimeoutMs = 12000, onWindowClosed = null
} = {}) {
  for (const [name, value] of Object.entries({
    getConfig, openConversation, listWindows, openWindow, getWindowByRef,
    dispatchRemoteCommandToWindow, revealRemoteConversationWindow, broadcastToDevice
  })) {
    if (typeof value !== 'function') throw new Error(`remote_session_${name}_required`)
  }
  const sessions = new Map()
  const creations = new Map()
  const queues = new Map()
  const requests = new Map()
  const revokedDevices = new Set()
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
    const session = current || { conversationId, activeRequestId: '', activeDeviceId: '' }
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

  async function ready(windowRef, check = () => {}) {
    const deadline = Date.now() + readinessTimeoutMs
    while (Date.now() < deadline) {
      check()
      const item = windowItem(windowRef)
      if (!item) throw remoteError('remote_renderer_closed')
      if (item.readOnly) throw remoteError('remote_conversation_read_only')
      if (item.rendererReady === true && item.leasePending !== true) return item
      await new Promise((resolve) => setTimeout(resolve, 40))
    }
    throw remoteError('remote_renderer_not_ready')
  }

  async function ensureSession(conversationId, check) {
    check()
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
    const record = requests.get(requestKey(session.activeDeviceId, session.activeRequestId))
    if (record && !record.terminal) publish(record, 'assistant.failed', { code: 'remote_renderer_closed' })
  }

  async function send({ deviceId, requestId, params = {} } = {}) {
    parameters(params, ['conversationId', 'text'])
    const conversationId = id(params.conversationId, 'conversationId')
    if (/\.(json|db)$/i.test(conversationId)) throw remoteError('remote_conversation_id_invalid')

    const safeDeviceId = id(deviceId, 'deviceId')
    const safeRequestId = id(requestId, 'requestId')
    const body = typeof params.text === 'string' ? params.text : ''
    if (!body.trim() || body.length > 128 * 1024) throw remoteError('remote_message_invalid')
    const epoch = generation
    const check = () => assertActive(epoch, safeDeviceId)
    check()
    const key = requestKey(safeDeviceId, safeRequestId)
    const fingerprint = crypto.createHash('sha256').update(JSON.stringify({ conversationId, text: body })).digest('hex')
    const previous = requests.get(key)
    if (previous) {
      if (previous.fingerprint !== fingerprint) throw remoteError('remote_request_id_conflict')
      const result = await previous.dispatched
      return { ...result, duplicate: true }
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
        check()
        const hadSession = Boolean(existingSession(conversationId))
        const session = await ensureSession(conversationId, check)
        check()
        const item = windowItem(session.windowRef)
        if (session.activeRequestId || item?.busy || item?.generating || item?.compacting) throw remoteError('remote_conversation_busy')
        session.activeRequestId = safeRequestId
        session.activeDeviceId = safeDeviceId
        record.windowRef = session.windowRef
        const dispatched = await dispatchRemoteCommandToWindow(session.windowRef, {
          type: 'conversation.send', requestId: safeRequestId, deviceId: safeDeviceId,
          conversationId, text: body, autoApproveTools: true
        })
        if (!dispatched?.ok) throw remoteError('remote_renderer_dispatch_failed')
        const result = { ok: true, conversationId, windowId: session.windowRef, hidden: session.hidden, created: !hadSession }
        record.result = result
        // Renderer acknowledgement may arrive before dispatch returns; don't overwrite a terminal state.
        if (record.eventSequence === 0) publish(record, 'conversation.command.accepted', result)
        return result
      } catch (error) {
        const session = sessions.get(conversationId)
        if (session?.activeRequestId === safeRequestId && session.activeDeviceId === safeDeviceId) {
          session.activeRequestId = ''
          session.activeDeviceId = ''
        }
        publish(record, 'assistant.failed', { code: error?.code || 'remote_renderer_dispatch_failed' })
        throw error
      }
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
    publish(record, data.event, sanitizeEvent(data.event, data.payload))
    if (record.terminal) { session.activeRequestId = ''; session.activeDeviceId = '' }
    return { ok: true }
  }

  function handleWindowClosed(windowRef) {
    for (const [conversationId, session] of sessions) {
      if (session.windowRef !== windowRef) continue
      finishClosed(session)
      sessions.delete(conversationId)
    }
    onWindowClosed?.(windowRef)
    return { ok: true }
  }

  async function revokeDevice(deviceId) {
    revokedDevices.add(deviceId)
    for (const session of sessions.values()) {
      if (session.activeDeviceId !== deviceId || !session.activeRequestId) continue
      await dispatchRemoteCommandToWindow(session.windowRef, {
        type: 'conversation.cancel', requestId: session.activeRequestId,
        targetRequestId: session.activeRequestId, conversationId: session.conversationId
      }).catch(() => {})
    }
  }

  function closeAll() {
    enabled = false
    generation += 1
    if (closing) return closing
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
            type: 'conversation.cancel', requestId: session.activeRequestId,
            targetRequestId: session.activeRequestId, conversationId: session.conversationId
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
    editMessage: (input) => mutate({ ...input, operation: 'conversation.message.edit' }),
    deleteMessage: (input) => mutate({ ...input, operation: 'conversation.message.delete' }),
    reaskMessage: (input) => mutate({ ...input, operation: 'conversation.message.reask' }),
    getConfig: (input) => configCommand({ ...input, operation: 'conversation.config.get' }),
    patchConfig: (input) => configCommand({ ...input, operation: 'conversation.config.patch' }),
    cancel, showOnDesktop, getRequest, handleRendererEvent, handleWindowClosed,
    revokeDevice, closeAll,
    resume: () => { enabled = true },
    authorizeDevice: (deviceId) => { revokedDevices.delete(deviceId) },
    getSession: (conversationId) => { const session = existingSession(conversationId); return session ? { ...session } : null }
  }
}
