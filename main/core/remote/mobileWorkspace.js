import crypto from 'node:crypto'
import { normalizeDisplayName, normalizeIdentifier, remoteError, stableStringify } from './protocol.js'

const MAX_NAME = 160
const MAX_ICON = 256
const MAX_REQUESTS = 256
const REQUEST_TTL_MS = 30 * 60 * 1000
const MAX_AGENT_TAGS = 32
const MAX_TAG_NAME = 80
const MAX_PROVIDER_MODELS = 500
const MAX_PROVIDER_HEADERS = 64
const MAX_PROVIDER_KEYS = 50
const MAX_PROVIDER_KEY_BYTES = 32 * 1024
const FORBIDDEN_FIELDS = new Set(['path', 'dirPath', 'localChatPath', 'command', 'args', 'cwd', 'env', 'remote', 'tls', 'rootSecret'])

const object = (value) => value && typeof value === 'object' && !Array.isArray(value) ? value : {}
const text = (value, limit = MAX_NAME) => typeof value === 'string' ? value.trim().replace(/\s+/g, ' ').slice(0, limit) : ''
const clone = (value) => structuredClone(value)
const revision = (value) => crypto.createHash('sha256').update(stableStringify(value)).digest('base64url')

function parameters(input, allowed) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw remoteError('remote_parameter_invalid')
  for (const key of Object.keys(input)) {
    if (!allowed.includes(key) || FORBIDDEN_FIELDS.has(key)) throw remoteError('remote_parameter_unknown')
  }
  return input
}

function safeProviderUrl(value) {
  try { const url = new URL(value); if (!['http:', 'https:'].includes(url.protocol)) return ''; url.username = ''; url.password = ''; url.search = ''; url.hash = ''; return url.toString() } catch { return '' }
}


const MAX_AVATAR_BYTES = 160 * 1024
const MAX_AGENT_ICON_BYTES = 16 * 1024
const MAX_SOURCE_AVATAR_BYTES = 2 * 1024 * 1024

function publicAvatar(value) {
  const avatar = typeof value === 'string' ? value.trim() : ''
  return /^https:\/\//i.test(avatar) ? avatar.slice(0, 2048) : ''
}

/**
 * The Desktop profile editor stores its crop as a Data URL. The Mobile DTO
 * accepts only small raster image payloads; no file/resource URL or SVG markup
 * can cross this boundary. Large source images are reduced by the injected
 * normalizer before they are returned over the E2EE workspace response.
 */
function avatarSourceDataUrl(value) {
  const avatar = typeof value === 'string' ? value.trim() : ''
  const match = /^data:image\/(png|jpeg|webp);base64,([A-Za-z0-9+/]+={0,2})$/i.exec(avatar)
  if (!match) return ''
  const bytes = Math.floor((match[2].length * 3) / 4) - (match[2].endsWith('==') ? 2 : match[2].endsWith('=') ? 1 : 0)
  return bytes > 0 && bytes <= MAX_SOURCE_AVATAR_BYTES ? avatar : ''
}

function publicAvatarDataUrl(value) {
  const avatar = typeof value === 'string' ? value.trim() : ''
  const match = /^data:image\/(png|jpeg|webp);base64,([A-Za-z0-9+/]+={0,2})$/i.exec(avatar)
  if (!match) return ''
  const bytes = Math.floor((match[2].length * 3) / 4) - (match[2].endsWith('==') ? 2 : match[2].endsWith('=') ? 1 : 0)
  return bytes > 0 && bytes <= MAX_AVATAR_BYTES ? avatar : ''
}

function projectDto(project = {}) {
  return {
    projectId: text(project.id, MAX_NAME),
    name: text(project.name, MAX_NAME),
    conversationCount: Array.isArray(project.conversationIds) ? project.conversationIds.length : 0
  }
}

function safeProviderId(value) {
  const id = text(value, MAX_NAME)
  if (
    !id ||
    /[\\/:*?"<>|\x00-\x1f]/.test(id) ||
    /[. ]$/.test(id) ||
    /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(id) ||
    ['__proto__', 'prototype', 'constructor'].includes(id)
  ) throw remoteError('remote_provider_invalid')
  return id
}

function safeFolderId(value) {
  return safeProviderId(value)
}

function safeProviderName(value) {
  const name = text(value, MAX_NAME)
  if (!name) throw remoteError('remote_provider_invalid')
  return name
}

function safeProviderApiType(value) {
  const apiType = text(value, 32)
  if (!['chat_completions', 'responses', 'codex', 'claude'].includes(apiType)) throw remoteError('remote_provider_invalid')
  return apiType
}

function safeProviderModels(value) {
  if (!Array.isArray(value) || value.length > MAX_PROVIDER_MODELS) throw remoteError('remote_provider_invalid')
  return [...new Set(value.map((model) => text(model, 320)).filter(Boolean))]
}

function safeProviderHeaders(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).length > MAX_PROVIDER_HEADERS) throw remoteError('remote_provider_invalid')
  const result = {}
  for (const [rawName, rawValue] of Object.entries(value)) {
    const name = typeof rawName === 'string' ? rawName.trim() : ''
    if (!/^[A-Za-z0-9!#$%&'*+.^_`|~-]+$/.test(name) || ['__proto__', 'constructor', 'prototype'].includes(name.toLowerCase())) throw remoteError('remote_provider_invalid')
    if (typeof rawValue !== 'string' || rawValue.length > 8192 || /[\r\n]/.test(rawValue)) throw remoteError('remote_provider_invalid')
    result[name] = rawValue.trim()
  }
  return result
}

function apiKeyCount(value) {
  if (Array.isArray(value)) return value.filter((item) => typeof item === 'string' && item.trim()).length
  return typeof value === 'string' ? value.split(/[，,]/).map((item) => item.trim()).filter(Boolean).length : 0
}

function providerFolderSource(value = {}) {
  const source = object(value)
  const result = Object.create(null)
  for (const [rawId, rawFolder] of Object.entries(source)) {
    let id = ''
    try { id = safeFolderId(rawId) } catch { continue }
    const folder = object(rawFolder)
    const name = text(folder.name, MAX_NAME)
    if (!name || Object.hasOwn(result, id)) continue
    result[id] = { name, collapsed: folder.collapsed === true }
  }
  return result
}

function providerUrl(value) {
  const sanitized = safeProviderUrl(value)
  if (typeof value === 'string' && value.trim() && !sanitized) throw remoteError('remote_provider_invalid')
  return sanitized
}

function providerDto(id, value = {}, folders = {}) {
  const source = object(value)
  const folderId = text(source.folderId, MAX_NAME)
  return {
    id: text(id, MAX_NAME),
    name: text(source.name, MAX_NAME) || text(id, MAX_NAME),
    enabled: source.enable !== false,
    url: safeProviderUrl(source.url),
    apiType: text(source.apiType, 32) || 'chat_completions',
    models: Array.isArray(source.modelList) ? [...new Set(source.modelList.map((model) => text(model, 320)).filter(Boolean))] : [],
    retryCount: Math.max(0, Math.min(10, Number.isInteger(source.retryCount) ? source.retryCount : 3)),
    folderId: Object.hasOwn(folders, folderId) ? folderId : '',
    apiKeyCount: apiKeyCount(source.api_key),
    headerNames: Object.keys(object(source.headers)).map((name) => text(name, 160)).filter(Boolean).sort((left, right) => left.localeCompare(right, 'en')),
    revision: revision(source)
  }
}

function providerDefault(name) {
  return {
    name,
    enable: true,
    url: '',
    api_key: '',
    apiType: 'chat_completions',
    headers: {},
    retryCount: 3,
    modelList: [],
    folderId: ''
  }
}

function safeProviderHeaderOps(value) {
  const source = parameters(value, ['set', 'remove'])
  const set = Object.hasOwn(source, 'set') ? safeProviderHeaders(source.set) : {}
  const remove = Object.hasOwn(source, 'remove') ? source.remove : []
  if (!Array.isArray(remove) || remove.length > MAX_PROVIDER_HEADERS) throw remoteError('remote_provider_invalid')
  const removals = [...new Set(remove.map((name) => typeof name === 'string' ? name.trim() : '').filter(Boolean))]
  if (removals.some((name) => !/^[A-Za-z0-9!#$%&'*+.^_`|~-]+$/.test(name))) throw remoteError('remote_provider_invalid')
  return { set, remove: removals }
}

function safeProviderPatch(input = {}, { creating = false } = {}) {
  const source = parameters(input, ['name', 'enabled', 'url', 'apiType', 'models', 'retryCount', 'folderId', 'apiKeys', 'headerOps'])
  const patch = {}
  if (Object.hasOwn(source, 'name')) patch.name = safeProviderName(source.name)
  if (Object.hasOwn(source, 'enabled')) patch.enable = source.enabled === true
  if (Object.hasOwn(source, 'url')) patch.url = providerUrl(source.url)
  if (Object.hasOwn(source, 'apiType')) patch.apiType = safeProviderApiType(source.apiType)
  if (Object.hasOwn(source, 'models')) patch.modelList = safeProviderModels(source.models)
  if (Object.hasOwn(source, 'retryCount')) {
    if (!Number.isInteger(source.retryCount) || source.retryCount < 0 || source.retryCount > 10) throw remoteError('remote_provider_invalid')
    patch.retryCount = source.retryCount
  }
  if (Object.hasOwn(source, 'folderId')) patch.folderId = source.folderId ? safeFolderId(source.folderId) : ''
  if (Object.hasOwn(source, 'apiKeys')) {
    if (typeof source.apiKeys !== 'string' || Buffer.byteLength(source.apiKeys, 'utf8') > MAX_PROVIDER_KEY_BYTES || apiKeyCount(source.apiKeys) > MAX_PROVIDER_KEYS) throw remoteError('remote_provider_invalid')
    patch.api_key = source.apiKeys.trim()
  }
  if (Object.hasOwn(source, 'headerOps')) patch.headerOps = safeProviderHeaderOps(source.headerOps)
  if (!creating && !Object.keys(patch).length) throw remoteError('remote_workspace_patch_empty')
  if (creating && !patch.name) throw remoteError('remote_provider_invalid')
  return patch
}


function safeTagName(value) {
  const name = text(value, MAX_TAG_NAME)
  if (!name || ['__proto__', 'prototype', 'constructor'].includes(name)) throw remoteError('remote_agent_tag_invalid')
  return name
}

function normalizeTags(value = {}) {
  const source = object(value)
  const result = Object.create(null)
  for (const [rawName, rawCodes] of Object.entries(source)) {
    let name = ''
    try { name = safeTagName(rawName) } catch { continue }
    if (Object.hasOwn(result, name) || !Array.isArray(rawCodes)) continue
    result[name] = [...new Set(rawCodes.map((code) => text(code, MAX_NAME)).filter(Boolean))]
  }
  return result
}

function tagsSource(config = {}) {
  return normalizeTags(object(config).tags)
}

function tagNamesForAgent(tags, code) {
  return Object.entries(tags)
    .filter(([, codes]) => codes.includes(code))
    .map(([name]) => name)
    .sort((left, right) => left.localeCompare(right, 'zh-CN'))
}

function agentDefault(code) {
  return {
    type: 'general',
    prompt: '',
    showMode: 'window',
    model: '',
    name: code,
    enable: true,
    icon: '',
    stream: true,
    temperature: 0.7,
    isTemperature: false,
    isDirectSend_file: false,
    isDirectSend_normal: true,
    isDirectSend_image: true,
    ifTextNecessary: false,
    voice: '',
    reasoning_effort: 'default',
    defaultMcpServers: [],
    defaultSkills: [],
    window_width: 540,
    window_height: 700,
    position_x: 0,
    position_y: 0,
    autoCloseOnBlur: true,
    isAlwaysOnTop: true,
    autoSaveChat: false,
    autoSaveProjectId: ''
  }
}

function safeAgentPatch(input = {}) {
  const source = parameters(input, ['name', 'enabled', 'model', 'type', 'showMode', 'systemPrompt', 'stream', 'reasoningEffort', 'autoSaveChat', 'defaultProjectId', 'voice', 'mcpServerIds', 'skillIds', 'tags'])
  const patch = {}
  if (Object.hasOwn(source, 'name')) patch.name = text(source.name, MAX_NAME)
  if (Object.hasOwn(source, 'enabled')) patch.enable = source.enabled === true
  if (Object.hasOwn(source, 'model')) patch.model = text(source.model, 320)
  if (Object.hasOwn(source, 'type')) {
    const type = text(source.type, 32)
    if (!['general', 'over', 'img', 'files'].includes(type)) throw remoteError('remote_workspace_invalid')
    patch.type = type
  }
  if (Object.hasOwn(source, 'showMode')) {
    const showMode = text(source.showMode, 32)
    if (!['window', 'fastinput'].includes(showMode)) throw remoteError('remote_workspace_invalid')
    patch.showMode = showMode
  }
  if (Object.hasOwn(source, 'systemPrompt')) {
    if (typeof source.systemPrompt !== 'string' || source.systemPrompt.length > 64 * 1024) throw remoteError('remote_workspace_invalid')
    patch.prompt = source.systemPrompt
  }
  if (Object.hasOwn(source, 'stream')) patch.stream = source.stream === true
  if (Object.hasOwn(source, 'reasoningEffort')) patch.reasoning_effort = text(source.reasoningEffort, 32)
  if (Object.hasOwn(source, 'autoSaveChat')) patch.autoSaveChat = source.autoSaveChat === true
  if (Object.hasOwn(source, 'defaultProjectId')) patch.autoSaveProjectId = text(source.defaultProjectId, MAX_NAME)
  if (Object.hasOwn(source, 'voice')) patch.voice = text(source.voice, 160)
  if (Object.hasOwn(source, 'mcpServerIds')) {
    if (!Array.isArray(source.mcpServerIds) || source.mcpServerIds.length > 128) throw remoteError('remote_workspace_invalid')
    patch.defaultMcpServers = [...new Set(source.mcpServerIds.map((id) => text(id, MAX_NAME)).filter(Boolean))]
  }
  if (Object.hasOwn(source, 'skillIds')) {
    if (!Array.isArray(source.skillIds) || source.skillIds.length > 256) throw remoteError('remote_workspace_invalid')
    patch.defaultSkills = [...new Set(source.skillIds.map((id) => text(id, MAX_NAME)).filter(Boolean))]
  }
  if (Object.hasOwn(source, 'tags')) {
    if (!Array.isArray(source.tags) || source.tags.length > MAX_AGENT_TAGS) throw remoteError('remote_workspace_invalid')
    patch.tags = [...new Set(source.tags.map((name) => safeTagName(name)))]
  }
  if (!Object.keys(patch).length) throw remoteError('remote_workspace_patch_empty')
  return patch
}

function agentDto(code, prompt = {}, projects = [], tags = {}) {
  const source = object(prompt)
  const defaultProjectId = text(source.autoSaveProjectId, MAX_NAME)
  const defaultProject = projects.find((project) => project.projectId === defaultProjectId)
  return {
    code: text(code, MAX_NAME),
    name: text(source.name, MAX_NAME) || text(code, MAX_NAME),
    enabled: source.enable !== false,
    icon: publicAvatar(source.icon),
    model: text(source.model, 320),
    type: text(source.type, 32) || 'general',
    showMode: text(source.showMode, 32) || 'window',
    tags: tagNamesForAgent(tags, code),
    stream: source.stream !== false,
    reasoningEffort: text(source.reasoning_effort, 32) || 'default',
    autoSaveChat: source.autoSaveChat === true,
    defaultProjectId,
    defaultProjectName: defaultProject?.name || '',
    voice: text(source.voice, 160),
    mcpServerIds: Array.isArray(source.defaultMcpServers) ? source.defaultMcpServers.map((id) => text(id, MAX_NAME)).filter(Boolean) : [],
    skillIds: Array.isArray(source.defaultSkills) ? source.defaultSkills.map((id) => text(id, MAX_NAME)).filter(Boolean) : [],
    revision: revision(source)
  }
}


function assistantDto(code, prompt = {}, projects = []) {
  const source = object(prompt)
  const defaultProjectId = text(source.autoSaveProjectId, MAX_NAME)
  const defaultProject = projects.find((project) => project.projectId === defaultProjectId)
  const icon = publicAvatar(source.icon)
  return {
    code: text(code, MAX_NAME),
    name: text(source.name, MAX_NAME) || text(code, MAX_NAME),
    icon,
    enabled: source.enable !== false,
    model: text(source.model, 320),
    defaultProjectId: defaultProjectId || '',
    defaultProjectName: defaultProject?.name || '',
    mcpCount: Array.isArray(source.defaultMcpServers) ? source.defaultMcpServers.length : 0,
    skillCount: Array.isArray(source.skillIds) ? source.skillIds.length : 0,
    capabilities: ['chat', ...(source.enableTools === true ? ['tools'] : [])]
  }
}

function assistantDetail(code, prompt = {}, projects = []) {
  const source = object(prompt)
  return {
    ...assistantDto(code, source, projects),
    revision: revision(source),
    systemPrompt: typeof source.prompt === 'string' ? source.prompt.slice(0, 256 * 1024) : '',
    reasoningEffort: text(source.reasoning_effort, 32) || 'default',
    voice: text(source.voice, 160),
    mcpServerIds: Array.isArray(source.defaultMcpServers) ? source.defaultMcpServers.map((id) => text(id, MAX_NAME)).filter(Boolean) : [],
    skillIds: Array.isArray(source.skillIds) ? source.skillIds.map((id) => text(id, MAX_NAME)).filter(Boolean) : []
  }
}

function safeAssistantPatch(input = {}) {
  const source = parameters(input, ['name', 'icon', 'enabled', 'model', 'defaultProjectId', 'systemPrompt', 'reasoningEffort', 'voice', 'mcpServerIds', 'skillIds'])
  const patch = {}
  if (Object.hasOwn(source, 'name')) patch.name = text(source.name, MAX_NAME)
  if (Object.hasOwn(source, 'icon')) patch.icon = publicAvatar(source.icon)
  if (Object.hasOwn(source, 'enabled')) patch.enable = source.enabled === true
  if (Object.hasOwn(source, 'model')) patch.model = text(source.model, 320)
  if (Object.hasOwn(source, 'defaultProjectId')) patch.autoSaveProjectId = text(source.defaultProjectId, MAX_NAME)
  if (Object.hasOwn(source, 'systemPrompt')) {
    if (typeof source.systemPrompt !== 'string' || source.systemPrompt.length > 256 * 1024) throw remoteError('remote_workspace_invalid')
    patch.prompt = source.systemPrompt
  }
  if (Object.hasOwn(source, 'reasoningEffort')) patch.reasoning_effort = text(source.reasoningEffort, 32)
  if (Object.hasOwn(source, 'voice')) patch.voice = text(source.voice, 160)
  if (Object.hasOwn(source, 'mcpServerIds')) {
    if (!Array.isArray(source.mcpServerIds) || source.mcpServerIds.length > 128) throw remoteError('remote_workspace_invalid')
    patch.defaultMcpServers = [...new Set(source.mcpServerIds.map((id) => text(id, MAX_NAME)).filter(Boolean))]
  }
  if (Object.hasOwn(source, 'skillIds')) {
    if (!Array.isArray(source.skillIds) || source.skillIds.length > 256) throw remoteError('remote_workspace_invalid')
    patch.skillIds = [...new Set(source.skillIds.map((id) => text(id, MAX_NAME)).filter(Boolean))]
  }
  if (!Object.keys(patch).length) throw remoteError('remote_workspace_patch_empty')
  return patch
}

/**
 * Structured Mobile workspace facade. It intentionally exposes display DTOs only:
 * no local paths, process commands, TLS material, Remote identities or root secrets.
 */
export function createMobileWorkspaceService({ getConfig, updateConfig, getUser, readLocalProjects, writeLocalProjects, normalizeAvatarDataUrl = (value) => value, getDefaultAgent = (code) => agentDefault(code), listSkills = () => [], listProviderModels = async () => ({ models: [] }) } = {}) {
  if ([getConfig, updateConfig, getUser, readLocalProjects, writeLocalProjects, normalizeAvatarDataUrl, getDefaultAgent, listProviderModels].some((item) => typeof item !== 'function')) {
    throw new Error('remote_mobile_workspace_dependencies_required')
  }
  const requests = new Map()
  let mutationTail = Promise.resolve()

  async function current() {
    const result = await getConfig()
    const config = object(result?.config)
    if (!Object.keys(config).length) throw remoteError('remote_workspace_unavailable')
    const directoryConfigured = Boolean(text(config?.webdav?.localChatPath, 32768))
    const rawProjects = directoryConfigured ? await readLocalProjects(config.webdav.localChatPath) : { projects: [] }
    const projects = (Array.isArray(rawProjects?.projects) ? rawProjects.projects : []).map(projectDto).filter((project) => project.projectId)
    return { config, rawProjects, projects, directoryConfigured }
  }

  async function profile() {
    const user = await getUser()
    const sourceAvatar = avatarSourceDataUrl(user?.avatar)
    let avatarDataUrl = ''
    if (sourceAvatar) {
      try {
        avatarDataUrl = publicAvatarDataUrl(await normalizeAvatarDataUrl(sourceAvatar))
      } catch {
        avatarDataUrl = ''
      }
    }
    return {
      displayName: text(user?.nickname, 80) || 'User',
      avatarUrl: publicAvatar(user?.avatar),
      avatarDataUrl,
      avatarVersion: avatarDataUrl ? crypto.createHash('sha256').update(avatarDataUrl).digest('base64url') : ''
    }
  }

  async function bootstrap({ params = {} } = {}) {
    parameters(params, [])
    const [{ config, projects, directoryConfigured }, user] = await Promise.all([current(), profile()])
    const prompts = object(config.prompts)
    const assistants = Object.entries(prompts)
      .map(([code, prompt]) => assistantDto(code, prompt, projects))
      .filter((assistant) => assistant.code && assistant.enabled)
      .sort((left, right) => left.name.localeCompare(right.name, 'zh-CN'))
    return { ok: true, profile: user, projects, assistants, configured: directoryConfigured }
  }

  async function assistantList({ params = {} } = {}) {
    parameters(params, [])
    const { config, projects } = await current()
    return {
      ok: true,
      assistants: Object.entries(object(config.prompts))
        .map(([code, prompt]) => assistantDto(code, prompt, projects))
        .filter((assistant) => assistant.code)
        .sort((left, right) => left.name.localeCompare(right.name, 'zh-CN'))
    }
  }

  async function assistantGet({ params = {} } = {}) {
    parameters(params, ['code'])
    const code = text(params.code, MAX_NAME)
    const { config, projects } = await current()
    const prompt = object(config.prompts)[code]
    if (!code || !prompt || typeof prompt !== 'object') throw remoteError('remote_assistant_not_found')
    return { ok: true, assistant: assistantDetail(code, prompt, projects) }
  }

  function pruneRequests() {
    const now = Date.now()
    for (const [key, value] of requests) if (now - value.updatedAt > REQUEST_TTL_MS) requests.delete(key)
    while (requests.size >= MAX_REQUESTS) requests.delete(requests.keys().next().value)
  }

  async function mutate({ deviceId, requestId, params = {} } = {}) {
    parameters(params, ['code', 'expectedRevision', 'patch'])
    const safeDeviceId = normalizeIdentifier(deviceId, 'deviceId', { minLength: 16, maxLength: 160 })
    const safeRequestId = normalizeIdentifier(requestId, 'requestId', { minLength: 8, maxLength: 160 })
    const code = text(params.code, MAX_NAME)
    const expectedRevision = text(params.expectedRevision, 128)
    const patch = safeAssistantPatch(object(params.patch))
    const fingerprint = crypto.createHash('sha256').update(stableStringify({ code, expectedRevision, patch })).digest('hex')
    const key = `${safeDeviceId}:${safeRequestId}`
    const previous = requests.get(key)
    if (previous) {
      if (previous.fingerprint !== fingerprint) throw remoteError('remote_request_id_conflict')
      return { ...(await previous.promise), duplicate: true }
    }
    pruneRequests()
    const record = { fingerprint, updatedAt: Date.now(), promise: null }
    record.promise = mutationTail.catch(() => {}).then(async () => {
      const { config, projects } = await current()
      const prompts = object(config.prompts)
      const existing = object(prompts[code])
      if (!code || !Object.keys(existing).length) throw remoteError('remote_assistant_not_found')
      if (revision(existing) !== expectedRevision) throw remoteError('remote_workspace_revision_conflict')
      const next = clone(config)
      next.prompts = { ...prompts, [code]: { ...existing, ...patch } }
      const saved = await updateConfig({ config: next })
      if (saved?.success !== true) throw remoteError('remote_workspace_save_failed')
      const persisted = object((await getConfig())?.config)
      const result = object(persisted.prompts)[code]
      return { ok: true, assistant: assistantDetail(code, result, projects) }
    })
    mutationTail = record.promise.catch(() => {})
    requests.set(key, record)
    try { return await record.promise } catch (error) { requests.delete(key); throw error }
  }

  function providerOptions(config = {}) {
    return {
      apiTypes: [
        { value: 'chat_completions', label: 'Chat Completions' },
        { value: 'responses', label: 'Responses' },
        { value: 'codex', label: 'Codex' },
        { value: 'claude', label: 'Claude' }
      ],
      folders: Object.entries(providerFolderSource(config.providerFolders))
        .map(([id, folder]) => ({ id, name: folder.name }))
        .sort((left, right) => left.name.localeCompare(right.name, 'zh-CN'))
    }
  }

  function orderedProviderIds(config = {}, folders = {}) {
    const providers = object(config.providers)
    const known = new Set(Object.keys(providers))
    const order = Array.isArray(config.providerOrder) ? config.providerOrder.map((id) => text(id, MAX_NAME)).filter((id) => known.has(id)) : []
    const result = [...new Set(order)]
    for (const id of Object.keys(providers)) if (!result.includes(id)) result.push(id)
    return result
  }

  function providerCatalogDto(config = {}) {
    const folders = providerFolderSource(config.providerFolders)
    const providers = object(config.providers)
    const items = orderedProviderIds(config, folders)
      .map((id) => providerDto(id, providers[id], folders))
      .filter((item) => item.id)
    return {
      folders: Object.entries(folders)
        .map(([id, folder]) => ({ id, name: folder.name, collapsed: folder.collapsed === true }))
        .sort((left, right) => left.name.localeCompare(right.name, 'zh-CN')),
      providers: items,
      options: providerOptions(config)
    }
  }

  async function providerCatalog({ params = {} } = {}) {
    parameters(params, [])
    const { config } = await current()
    return { ok: true, ...providerCatalogDto(config) }
  }

  async function providerGet({ params = {} } = {}) {
    parameters(params, ['id'])
    const id = safeProviderId(params.id)
    const { config } = await current()
    const folders = providerFolderSource(config.providerFolders)
    const raw = object(config.providers)[id]
    if (!raw || typeof raw !== 'object') throw remoteError('remote_provider_not_found')
    return { ok: true, provider: providerDto(id, raw, folders), options: providerOptions(config) }
  }

  async function providerMutate({ deviceId, requestId, params = {} } = {}) {
    parameters(params, ['operation', 'id', 'expectedRevision', 'patch', 'confirmed'])
    const device = normalizeIdentifier(deviceId, 'deviceId', { minLength: 16, maxLength: 160 })
    const request = normalizeIdentifier(requestId, 'requestId', { minLength: 8, maxLength: 160 })
    const operation = text(params.operation, 32)
    if (!['create', 'patch', 'delete'].includes(operation)) throw remoteError('remote_provider_operation_invalid')
    if (operation === 'delete' && params.confirmed !== true) throw remoteError('remote_confirmation_required')
    const suppliedId = text(params.id, MAX_NAME)
    const patch = operation === 'delete' ? {} : safeProviderPatch(object(params.patch), { creating: operation === 'create' })
    const fingerprint = revision({ operation, suppliedId, expectedRevision: params.expectedRevision, patch, confirmed: params.confirmed === true })
    const key = `${device}:${request}`
    const previous = requests.get(key)
    if (previous) {
      if (previous.fingerprint !== fingerprint) throw remoteError('remote_request_id_conflict')
      return { ...(await previous.promise), duplicate: true }
    }
    pruneRequests()
    const record = { fingerprint, updatedAt: Date.now(), promise: null }
    record.promise = mutationTail.catch(() => {}).then(async () => {
      const { config } = await current()
      const providers = object(config.providers)
      const id = operation === 'create'
        ? (suppliedId ? safeProviderId(suppliedId) : uniqueProviderId(providers, patch.name))
        : safeProviderId(suppliedId)
      const source = object(providers[id])
      if (operation === 'create' && Object.keys(source).length) throw remoteError('remote_provider_exists')
      if (operation !== 'create' && (!Object.keys(source).length || revision(source) !== text(params.expectedRevision, 128))) throw remoteError('remote_workspace_revision_conflict')
      const folders = providerFolderSource(config.providerFolders)
      if (patch.folderId && !Object.hasOwn(folders, patch.folderId)) throw remoteError('remote_provider_folder_not_found')
      const next = clone(config)
      next.providers = { ...providers }
      next.providerOrder = orderedProviderIds(config, folders)
      if (operation === 'delete') {
        delete next.providers[id]
        next.providerOrder = next.providerOrder.filter((item) => item !== id)
      } else {
        const { headerOps, ...providerPatch } = patch
        // Existing Provider records merge only supplied fields, preserving Desktop-only
        // configuration and all secrets that Mobile has not explicitly replaced.
        const merged = operation === 'create'
          ? { ...providerDefault(providerPatch.name), ...providerPatch }
          : { ...source, ...providerPatch }
        if (headerOps) {
          const headers = { ...object(operation === 'create' ? {} : source.headers) }
          for (const name of headerOps.remove) delete headers[name]
          Object.assign(headers, headerOps.set)
          merged.headers = headers
        }
        next.providers[id] = merged
        if (!next.providerOrder.includes(id)) next.providerOrder.push(id)
      }
      const saved = await updateConfig({ config: next })
      if (saved?.success !== true) throw remoteError('remote_workspace_save_failed')
      if (operation === 'delete') return { ok: true, operation, id }
      const persisted = object((await getConfig())?.config)
      return { ok: true, operation, provider: providerDto(id, object(persisted.providers)[id], providerFolderSource(persisted.providerFolders)) }
    })
    mutationTail = record.promise.catch(() => {})
    requests.set(key, record)
    try { return await record.promise } catch (error) { requests.delete(key); throw error }
  }

  function uniqueProviderId(providers, name = '') {
    const base = text(name, MAX_NAME).toLowerCase().replace(/[^a-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '') || 'provider'
    let id = base
    let suffix = 2
    while (Object.hasOwn(providers, id)) id = `${base}-${suffix++}`
    return safeProviderId(id)
  }

  async function providerFoldersMutate({ deviceId, requestId, params = {} } = {}) {
    parameters(params, ['operation', 'id', 'name', 'collapsed', 'confirmed'])
    const device = normalizeIdentifier(deviceId, 'deviceId', { minLength: 16, maxLength: 160 })
    const request = normalizeIdentifier(requestId, 'requestId', { minLength: 8, maxLength: 160 })
    const operation = text(params.operation, 32)
    if (!['create', 'rename', 'toggle', 'delete'].includes(operation)) throw remoteError('remote_provider_folder_invalid')
    if (operation === 'delete' && params.confirmed !== true) throw remoteError('remote_confirmation_required')
    const suppliedId = text(params.id, MAX_NAME)
    const name = Object.hasOwn(params, 'name') ? safeProviderName(params.name) : ''
    if (['create', 'rename'].includes(operation) && !name) throw remoteError('remote_provider_folder_invalid')
    if (operation === 'toggle' && typeof params.collapsed !== 'boolean') throw remoteError('remote_provider_folder_invalid')
    const fingerprint = revision({ operation, suppliedId, name, collapsed: params.collapsed, confirmed: params.confirmed === true })
    const key = `${device}:${request}`
    const previous = requests.get(key)
    if (previous) {
      if (previous.fingerprint !== fingerprint) throw remoteError('remote_request_id_conflict')
      return { ...(await previous.promise), duplicate: true }
    }
    pruneRequests()
    const record = { fingerprint, updatedAt: Date.now(), promise: null }
    record.promise = mutationTail.catch(() => {}).then(async () => {
      const { config } = await current()
      const folders = providerFolderSource(config.providerFolders)
      const id = operation === 'create' ? (suppliedId ? safeFolderId(suppliedId) : uniqueProviderFolderId(folders, name)) : safeFolderId(suppliedId)
      if (operation === 'create' && Object.hasOwn(folders, id)) throw remoteError('remote_provider_folder_exists')
      if (operation !== 'create' && !Object.hasOwn(folders, id)) throw remoteError('remote_provider_folder_not_found')
      const next = clone(config)
      next.providerFolders = { ...folders }
      if (operation === 'create') next.providerFolders[id] = { name, collapsed: false }
      if (operation === 'rename') next.providerFolders[id] = { ...next.providerFolders[id], name }
      if (operation === 'toggle') next.providerFolders[id] = { ...next.providerFolders[id], collapsed: params.collapsed === true }
      if (operation === 'delete') {
        delete next.providerFolders[id]
        next.providers = Object.fromEntries(Object.entries(object(next.providers)).map(([providerId, provider]) => [providerId, object(provider).folderId === id ? { ...object(provider), folderId: '' } : provider]))
      }
      const saved = await updateConfig({ config: next })
      if (saved?.success !== true) throw remoteError('remote_workspace_save_failed')
      return { ok: true, operation, id }
    })
    mutationTail = record.promise.catch(() => {})
    requests.set(key, record)
    try { return await record.promise } catch (error) { requests.delete(key); throw error }
  }

  function uniqueProviderFolderId(folders, name = '') {
    const base = text(name, MAX_NAME).toLowerCase().replace(/[^a-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '') || 'folder'
    let id = `folder-${base}`
    let suffix = 2
    while (Object.hasOwn(folders, id)) id = `folder-${base}-${suffix++}`
    return safeFolderId(id)
  }

  async function providerModelsFetch({ params = {} } = {}) {
    parameters(params, ['id'])
    const id = safeProviderId(params.id)
    const { config } = await current()
    const source = object(config.providers)[id]
    if (!source || typeof source !== 'object') throw remoteError('remote_provider_not_found')
    if (!safeProviderUrl(source.url)) throw remoteError('remote_provider_url_required')
    try {
      const result = await listProviderModels({
        baseUrl: source.url,
        apiKey: source.api_key,
        apiType: source.apiType,
        headers: source.headers
      })
      const models = (Array.isArray(result?.models) ? result.models : [])
        .map((model) => text(typeof model === 'string' ? model : model?.id, 320))
        .filter(Boolean)
      return { ok: true, models: [...new Set(models)].sort((left, right) => left.localeCompare(right, 'zh-CN')) }
    } catch {
      throw remoteError('remote_provider_models_fetch_failed')
    }
  }


  async function agentOptions(config, projects) {
    const skills = await listSkills(text(config.skillPath, 32768))
    return {
      models: Object.entries(object(config.providers))
        .flatMap(([providerId, provider]) => {
          const item = object(provider)
          if (item.enable === false || !Array.isArray(item.modelList)) return []
          return item.modelList.map((model) => ({
            value: `${text(providerId, MAX_NAME)}|${text(model, 320)}`,
            label: `${text(item.name, MAX_NAME) || text(providerId, MAX_NAME)} | ${text(model, 320)}`
          }))
        })
        .filter((item) => item.value !== '|')
        .sort((left, right) => left.label.localeCompare(right.label, 'zh-CN')),
      projects,
      mcpServers: Object.entries(object(config.mcpServers))
        .map(([id, value]) => ({ id: text(id, MAX_NAME), name: text(object(value).name, MAX_NAME) || text(id, MAX_NAME) }))
        .filter((item) => item.id)
        .sort((left, right) => left.name.localeCompare(right.name, 'zh-CN')),
      skills: (Array.isArray(skills) ? skills : [])
        .map((skill) => ({ id: text(skill?.id, MAX_NAME), name: text(skill?.name, MAX_NAME) || text(skill?.id, MAX_NAME) }))
        .filter((item) => item.id)
        .sort((left, right) => left.name.localeCompare(right.name, 'zh-CN')),
      voices: Array.isArray(config.voiceList) ? config.voiceList.map((voice) => text(voice, 160)).filter(Boolean) : []
    }
  }

  async function agentView(code, prompt, projects, tags) {
    const view = agentDto(code, prompt, projects, tags)
    const sourceIcon = avatarSourceDataUrl(prompt?.icon)
    if (!sourceIcon) return { ...view, iconDataUrl: '' }
    try {
      const normalized = publicAvatarDataUrl(await normalizeAvatarDataUrl(sourceIcon))
      const bytes = normalized ? Math.floor((normalized.split(',')[1].length * 3) / 4) : 0
      return { ...view, iconDataUrl: bytes > 0 && bytes <= MAX_AGENT_ICON_BYTES ? normalized : '' }
    } catch {
      return { ...view, iconDataUrl: '' }
    }
  }

  function normalizedAgentCode(value, fallback = '') {
    const code = text(value, MAX_NAME) || fallback
    if (
      !code ||
      /[\\/:*?"<>|\x00-\x1f]/.test(code) ||
      /[. ]$/.test(code) ||
      /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(code) ||
      ['__proto__', 'prototype', 'constructor'].includes(code)
    ) throw remoteError('remote_agent_code_invalid')
    return code
  }

  function uniqueAgentCode(prompts, desired = '') {
    const base = text(desired, MAX_NAME)
      .toLowerCase()
      .replace(/[^a-z0-9_-]+/g, '-')
      .replace(/^-+|-+$/g, '') || 'agent'
    let code = base
    let suffix = 2
    while (Object.hasOwn(prompts, code)) code = `${base}-${suffix++}`
    return normalizedAgentCode(code)
  }

  function nextAgentTags(tags, code, selectedTags) {
    const next = normalizeTags(tags)
    for (const name of Object.keys(next)) next[name] = next[name].filter((item) => item !== code)
    for (const name of selectedTags) {
      if (!Object.hasOwn(next, name)) throw remoteError('remote_agent_tag_not_found')
      next[name] = [...new Set([...next[name], code])]
    }
    return next
  }

  async function agentDetail(code, prompt, projects, tags) {
    const view = await agentView(code, prompt, projects, tags)
    return {
      ...view,
      systemPrompt: typeof prompt?.prompt === 'string' ? prompt.prompt.slice(0, 64 * 1024) : ''
    }
  }


  function agentRoutes(config = {}) {
    return {
      general: text(config.defaultTaskModel, 320),
      superior: text(config.defaultSuperiorModel, 320),
      fast: text(config.defaultFastModel, 320)
    }
  }

  function agentRoutesRevision(config = {}) {
    return revision(agentRoutes(config))
  }


  async function agentCatalog({ params = {} } = {}) {
    parameters(params, [])
    const { config, projects } = await current()
    const tags = normalizeTags(config.tags)
    const agents = await Promise.all(
      Object.entries(object(config.prompts)).map(([code, prompt]) => agentView(code, prompt, projects, tags))
    )
    return {
      ok: true,
      tags: Object.keys(tags).sort((left, right) => left.localeCompare(right, 'zh-CN')),
      agents: agents
        .filter((agent) => agent.code)
        .sort((left, right) => Number(right.enabled) - Number(left.enabled) || left.name.localeCompare(right.name, 'zh-CN')),
      options: await agentOptions(config, projects),
      routes: agentRoutes(config),
      routesRevision: agentRoutesRevision(config)
    }
  }

  async function agentGet({ params = {} } = {}) {
    parameters(params, ['code'])
    const code = normalizedAgentCode(params.code)
    const { config, projects } = await current()
    const prompt = object(config.prompts)[code]
    if (!prompt || typeof prompt !== 'object') throw remoteError('remote_agent_not_found')
    const tags = normalizeTags(config.tags)
    return { ok: true, agent: await agentDetail(code, prompt, projects, tags), options: await agentOptions(config, projects) }
  }

  async function agentMutate({ deviceId, requestId, params = {} } = {}) {
    parameters(params, ['operation', 'code', 'expectedRevision', 'patch', 'confirmed'])
    const device = normalizeIdentifier(deviceId, 'deviceId', { minLength: 16, maxLength: 160 })
    const request = normalizeIdentifier(requestId, 'requestId', { minLength: 8, maxLength: 160 })
    const operation = text(params.operation, 32)
    if (!['create', 'patch', 'delete'].includes(operation)) throw remoteError('remote_agent_operation_invalid')
    if (operation === 'delete' && params.confirmed !== true) throw remoteError('remote_confirmation_required')
    const patch = operation === 'delete' ? {} : safeAgentPatch(object(params.patch))
    const suppliedCode = text(params.code, MAX_NAME)
    const fingerprint = revision({ operation, suppliedCode, expectedRevision: params.expectedRevision, patch, confirmed: params.confirmed === true })
    const key = `${device}:${request}`
    const previous = requests.get(key)
    if (previous) {
      if (previous.fingerprint !== fingerprint) throw remoteError('remote_request_id_conflict')
      return { ...(await previous.promise), duplicate: true }
    }
    pruneRequests()
    const record = { fingerprint, updatedAt: Date.now(), promise: null }
    record.promise = mutationTail.catch(() => {}).then(async () => {
      const { config, projects } = await current()
      const prompts = object(config.prompts)
      const code = operation === 'create'
        ? (suppliedCode ? normalizedAgentCode(suppliedCode) : uniqueAgentCode(prompts, patch.name))
        : normalizedAgentCode(suppliedCode)
      const existing = object(prompts[code])
      if (operation === 'create' && Object.keys(existing).length) throw remoteError('remote_agent_exists')
      if (operation !== 'create' && (!Object.keys(existing).length || revision(existing) !== text(params.expectedRevision, 128))) {
        throw remoteError('remote_workspace_revision_conflict')
      }
      const next = clone(config)
      const tags = normalizeTags(config.tags)
      next.prompts = { ...prompts }
      if (operation === 'delete') {
        delete next.prompts[code]
        next.tags = nextAgentTags(tags, code, [])
      } else {
        const { tags: selectedTags = tagNamesForAgent(tags, code), ...agentPatch } = patch
        // Existing Agents are merged field-by-field so Desktop-only settings
        // (temperature/direct-send/window geometry/etc.) remain untouched.
        next.prompts[code] = operation === 'create'
          ? { ...object(getDefaultAgent(code)), ...agentPatch, name: agentPatch.name || code }
          : { ...existing, ...agentPatch }
        next.tags = nextAgentTags(tags, code, selectedTags)
      }
      const saved = await updateConfig({ config: next })
      if (saved?.success !== true) throw remoteError('remote_workspace_save_failed')
      if (operation === 'delete') return { ok: true, operation, code }
      const persisted = object((await getConfig())?.config)
      const persistedTags = normalizeTags(persisted.tags)
      return {
        ok: true,
        operation,
        agent: await agentView(code, object(persisted.prompts)[code], projects, persistedTags)
      }
    })
    mutationTail = record.promise.catch(() => {})
    requests.set(key, record)
    try { return await record.promise } catch (error) { requests.delete(key); throw error }
  }

  async function agentRoutesMutate({ deviceId, requestId, params = {} } = {}) {
    parameters(params, ['expectedRevision', 'routes'])
    const device = normalizeIdentifier(deviceId, 'deviceId', { minLength: 16, maxLength: 160 })
    const request = normalizeIdentifier(requestId, 'requestId', { minLength: 8, maxLength: 160 })
    const routes = object(params.routes)
    if (Object.keys(routes).some((key) => !['general', 'superior', 'fast'].includes(key))) throw remoteError('remote_workspace_invalid')
    const nextRoutes = {
      general: Object.hasOwn(routes, 'general') ? text(routes.general, 320) : '',
      superior: Object.hasOwn(routes, 'superior') ? text(routes.superior, 320) : '',
      fast: Object.hasOwn(routes, 'fast') ? text(routes.fast, 320) : ''
    }
    const fingerprint = revision({ expectedRevision: params.expectedRevision, routes: nextRoutes })
    const key = `${device}:${request}`
    const previous = requests.get(key)
    if (previous) {
      if (previous.fingerprint !== fingerprint) throw remoteError('remote_request_id_conflict')
      return { ...(await previous.promise), duplicate: true }
    }
    pruneRequests()
    const record = { fingerprint, updatedAt: Date.now(), promise: null }
    record.promise = mutationTail.catch(() => {}).then(async () => {
      const { config } = await current()
      if (agentRoutesRevision(config) !== text(params.expectedRevision, 128)) throw remoteError('remote_workspace_revision_conflict')
      const validModels = new Set((await agentOptions(config, [])).models.map((item) => item.value))
      if (Object.values(nextRoutes).some((model) => model && !validModels.has(model))) throw remoteError('remote_workspace_invalid')
      const next = clone(config)
      next.defaultTaskModel = nextRoutes.general
      next.defaultSuperiorModel = nextRoutes.superior
      next.defaultFastModel = nextRoutes.fast
      const saved = await updateConfig({ config: next })
      if (saved?.success !== true) throw remoteError('remote_workspace_save_failed')
      const persisted = object((await getConfig())?.config)
      return { ok: true, routes: agentRoutes(persisted), routesRevision: agentRoutesRevision(persisted) }
    })
    mutationTail = record.promise.catch(() => {})
    requests.set(key, record)
    try { return await record.promise } catch (error) { requests.delete(key); throw error }
  }


  async function agentTagsMutate({ deviceId, requestId, params = {} } = {}) {
    parameters(params, ['operation', 'name', 'confirmed'])
    const device = normalizeIdentifier(deviceId, 'deviceId', { minLength: 16, maxLength: 160 })
    const request = normalizeIdentifier(requestId, 'requestId', { minLength: 8, maxLength: 160 })
    const operation = text(params.operation, 32)
    let name = ''
    try { name = safeTagName(params.name) } catch { throw remoteError('remote_agent_tag_invalid') }
    if (!['create', 'delete'].includes(operation)) throw remoteError('remote_agent_tag_invalid')
    if (operation === 'delete' && params.confirmed !== true) throw remoteError('remote_confirmation_required')
    const fingerprint = revision({ operation, name, confirmed: params.confirmed === true })
    const key = `${device}:${request}`
    const previous = requests.get(key)
    if (previous) {
      if (previous.fingerprint !== fingerprint) throw remoteError('remote_request_id_conflict')
      return { ...(await previous.promise), duplicate: true }
    }
    pruneRequests()
    const record = { fingerprint, updatedAt: Date.now(), promise: null }
    record.promise = mutationTail.catch(() => {}).then(async () => {
      const { config } = await current()
      const tags = normalizeTags(config.tags)
      if (operation === 'create' && Object.hasOwn(tags, name)) throw remoteError('remote_agent_tag_exists')
      if (operation === 'delete' && !Object.hasOwn(tags, name)) throw remoteError('remote_agent_tag_not_found')
      const next = clone(config)
      next.tags = { ...tags }
      if (operation === 'create') next.tags[name] = []
      else delete next.tags[name]
      const saved = await updateConfig({ config: next })
      if (saved?.success !== true) throw remoteError('remote_workspace_save_failed')
      return { ok: true, operation, name }
    })
    mutationTail = record.promise.catch(() => {})
    requests.set(key, record)
    try { return await record.promise } catch (error) { requests.delete(key); throw error }
  }


  async function projectCreate({ deviceId, requestId, params = {} } = {}) {
    parameters(params, ['name'])
    const safeDeviceId = normalizeIdentifier(deviceId, 'deviceId', { minLength: 16, maxLength: 160 })
    const safeRequestId = normalizeIdentifier(requestId, 'requestId', { minLength: 8, maxLength: 160 })
    const name = text(params.name, MAX_NAME)
    if (!name) throw remoteError('remote_project_name_required')
    const fingerprint = crypto.createHash('sha256').update(stableStringify({ operation: 'project.create', name })).digest('hex')
    const key = `${safeDeviceId}:${safeRequestId}`
    const previous = requests.get(key)
    if (previous) {
      if (previous.fingerprint !== fingerprint) throw remoteError('remote_request_id_conflict')
      return { ...(await previous.promise), duplicate: true }
    }
    pruneRequests()
    const record = { fingerprint, updatedAt: Date.now(), promise: null }
    record.promise = mutationTail.catch(() => {}).then(async () => {
      const { config, rawProjects } = await current()
      if (!text(config?.webdav?.localChatPath, 32768)) throw remoteError('remote_conversation_directory_not_configured')
      const base = name.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '-').replace(/^-+|-+$/g, '') || 'project'
      const existing = new Set((Array.isArray(rawProjects.projects) ? rawProjects.projects : []).map((project) => text(project.id, MAX_NAME)))
      let projectId = base
      let suffix = 2
      while (existing.has(projectId)) projectId = `${base}-${suffix++}`
      const project = { id: projectId, name, files: [], conversationIds: [] }
      const next = { ...rawProjects, projects: [...(Array.isArray(rawProjects.projects) ? rawProjects.projects : []), project] }
      await writeLocalProjects(config.webdav.localChatPath, next)
      return { ok: true, project: projectDto(project) }
    })
    mutationTail = record.promise.catch(() => {})
    requests.set(key, record)
    try { return await record.promise } catch (error) { requests.delete(key); throw error }
  }

  async function projectUpdate({ deviceId, requestId, params = {} } = {}) {
    parameters(params, ['projectId', 'name'])
    const safeDeviceId = normalizeIdentifier(deviceId, 'deviceId', { minLength: 16, maxLength: 160 })
    const safeRequestId = normalizeIdentifier(requestId, 'requestId', { minLength: 8, maxLength: 160 })
    const projectId = text(params.projectId, MAX_NAME)
    const name = text(params.name, MAX_NAME)
    if (!projectId || !name) throw remoteError('remote_project_name_required')
    const fingerprint = revision({ operation: 'project.update', projectId, name })
    const key = `${safeDeviceId}:${safeRequestId}`
    const previous = requests.get(key)
    if (previous) {
      if (previous.fingerprint !== fingerprint) throw remoteError('remote_request_id_conflict')
      return { ...(await previous.promise), duplicate: true }
    }
    pruneRequests()
    const record = { fingerprint, updatedAt: Date.now(), promise: null }
    record.promise = mutationTail.catch(() => {}).then(async () => {
      const { config, rawProjects } = await current()
      if (!text(config?.webdav?.localChatPath, 32768)) throw remoteError('remote_conversation_directory_not_configured')
      const projects = Array.isArray(rawProjects.projects) ? rawProjects.projects : []
      const target = projects.find((project) => text(project?.id, MAX_NAME) === projectId)
      if (!target) throw remoteError('remote_project_not_found')
      const project = { ...target, name }
      const next = {
        ...rawProjects,
        projects: projects.map((item) => text(item?.id, MAX_NAME) === projectId ? project : item)
      }
      await writeLocalProjects(config.webdav.localChatPath, next)
      return { ok: true, project: projectDto(project) }
    })
    mutationTail = record.promise.catch(() => {})
    requests.set(key, record)
    try { return await record.promise } catch (error) { requests.delete(key); throw error }
  }

  async function projectRemove({ deviceId, requestId, params = {} } = {}) {
    parameters(params, ['projectId', 'confirmed'])
    const safeDeviceId = normalizeIdentifier(deviceId, 'deviceId', { minLength: 16, maxLength: 160 })
    const safeRequestId = normalizeIdentifier(requestId, 'requestId', { minLength: 8, maxLength: 160 })
    const projectId = text(params.projectId, MAX_NAME)
    if (!projectId) throw remoteError('remote_project_not_found')
    if (params.confirmed !== true) throw remoteError('remote_project_delete_confirmation_required')
    const fingerprint = revision({ operation: 'project.remove', projectId, confirmed: true })
    const key = `${safeDeviceId}:${safeRequestId}`
    const previous = requests.get(key)
    if (previous) {
      if (previous.fingerprint !== fingerprint) throw remoteError('remote_request_id_conflict')
      return { ...(await previous.promise), duplicate: true }
    }
    pruneRequests()
    const record = { fingerprint, updatedAt: Date.now(), promise: null }
    record.promise = mutationTail.catch(() => {}).then(async () => {
      const { config, rawProjects } = await current()
      if (!text(config?.webdav?.localChatPath, 32768)) throw remoteError('remote_conversation_directory_not_configured')
      const projects = Array.isArray(rawProjects.projects) ? rawProjects.projects : []
      const target = projects.find((project) => text(project?.id, MAX_NAME) === projectId)
      if (!target) throw remoteError('remote_project_not_found')
      // Removing only this metadata group intentionally leaves every conversation
      // record intact. Its former members become ungrouped on the next catalog read.
      const next = {
        ...rawProjects,
        projects: projects.filter((project) => text(project?.id, MAX_NAME) !== projectId)
      }
      await writeLocalProjects(config.webdav.localChatPath, next)
      return {
        ok: true,
        projectId,
        ungroupedConversationCount: Array.isArray(target.conversationIds) ? target.conversationIds.length : 0
      }
    })
    mutationTail = record.promise.catch(() => {})
    requests.set(key, record)
    try { return await record.promise } catch (error) { requests.delete(key); throw error }
  }


  async function managementPatch({ deviceId, requestId, params = {} } = {}) {
    parameters(params, ['section', 'id', 'expectedRevision', 'patch'])
    const section = params.section
    const sections = { providers: 'providers', mcp: 'mcpServers', tasks: 'tasks', general: '' }
    if (!Object.hasOwn(sections, section)) throw remoteError('remote_workspace_section_invalid')
    const device = normalizeIdentifier(deviceId, 'deviceId', { minLength: 16 })
    const request = normalizeIdentifier(requestId, 'requestId', { minLength: 8 })
    const target = typeof params.id === 'string' ? params.id : ''
    if (['__proto__', 'prototype', 'constructor'].includes(target)) throw remoteError('remote_workspace_invalid')
    const allowed = { providers: ['name', 'url', 'models', 'enabled', 'apiKey'], mcp: ['name', 'enabled'], tasks: ['name', 'description'], general: ['language', 'themeMode', 'displayName'] }[section]
    const patch = parameters(params.patch, allowed)
    if (!Object.keys(patch).length) throw remoteError('remote_workspace_patch_empty')
    for (const [field, value] of Object.entries(patch)) {
      if (field === 'enabled') { if (typeof value !== 'boolean') throw remoteError('remote_workspace_invalid'); continue }
      if (field === 'models') {
        if (!Array.isArray(value) || value.length > 500 || value.some(model => typeof model !== 'string' || !model.trim() || model.length > 320)) throw remoteError('remote_workspace_invalid')
        continue
      }
      const limit = field === 'description' ? 64 * 1024 : field === 'apiKey' ? 8192 : field === 'url' ? 2048 : 160
      if (typeof value !== 'string' || value.length > limit) throw remoteError('remote_workspace_invalid')
      if (field === 'url' && value) {
        let url
        try { url = new URL(value) } catch { throw remoteError('remote_workspace_invalid') }
        if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw remoteError('remote_workspace_invalid')
      }
      if (field === 'themeMode' && !['system', 'light', 'dark'].includes(value)) throw remoteError('remote_workspace_invalid')
      if (field === 'language' && !['zh', 'en'].includes(value)) throw remoteError('remote_workspace_invalid')
      if (field === 'displayName' && (!value.trim() || value.length > 12)) throw remoteError('remote_workspace_invalid')
    }
    const fingerprint = revision({ operation: 'management.patch', section, target, expectedRevision: params.expectedRevision, patch })
    const key = `${device}:${request}`
    const previous = requests.get(key)
    if (previous) {
      if (previous.fingerprint !== fingerprint) throw remoteError('remote_request_id_conflict')
      return { ...(await previous.promise), duplicate: true }
    }
    pruneRequests()
    const record = { fingerprint, updatedAt: Date.now(), promise: null }
    record.promise = mutationTail.catch(() => {}).then(async () => {
      const { config } = await current()
      const source = section === 'general' ? generalSource(config) : object(config[sections[section]])[target]
      if (!source || typeof source !== 'object') throw remoteError('remote_workspace_item_not_found')
      if (revision(source) !== params.expectedRevision) throw remoteError('remote_workspace_revision_conflict')
      const next = clone(config)
      if (section === 'general') {
        if (Object.hasOwn(patch, 'language')) next.language = patch.language
        if (Object.hasOwn(patch, 'themeMode')) next.themeMode = patch.themeMode
        if (Object.hasOwn(patch, 'displayName')) next.desktop = { ...object(next.desktop), profile: { ...object(next.desktop?.profile), nickname: patch.displayName.trim() } }
      } else {
        const item = { ...source }
        const mapping = section === 'providers' ? { models: 'modelList', apiKey: 'api_key', enabled: 'enable' } : section === 'mcp' ? { enabled: 'isActive' } : {}
        for (const [field, value] of Object.entries(patch)) item[mapping[field] || field] = value
        next[sections[section]] = { ...object(next[sections[section]]), [target]: item }
      }
      const saved = await updateConfig({ config: next })
      if (saved?.success !== true) throw remoteError('remote_workspace_save_failed')
      return { ok: true, section, id: target }
    })
    requests.set(key, record)
    mutationTail = record.promise.catch(() => {})
    try { return await record.promise } catch (error) { requests.delete(key); throw error }
  }

  function generalSource(config) {
    return { language: config.language || 'zh', themeMode: config.themeMode || 'system', displayName: config.desktop?.profile?.nickname || 'User' }
  }


  async function managementDetails({ params = {} } = {}) {
    parameters(params, ['section'])
    const section = text(params.section, 32)
    const { config } = await current()
    if (section === 'providers') return { ok: true, section, items: Object.entries(object(config.providers)).map(([id, value]) => {
      const item = object(value)
      return { id: text(id), revision: revision(item), name: text(item.name) || text(id), url: safeProviderUrl(item.url), enabled: item.enable !== false, models: Array.isArray(item.modelList) ? item.modelList.map((model) => text(model, 320)).filter(Boolean) : [], hasApiKey: Boolean(text(item.api_key, 1)) }
    }) }
    if (section === 'mcp') return { ok: true, section, items: Object.entries(object(config.mcpServers)).map(([id, value]) => {
      const item = object(value)
      return { id: text(id), revision: revision(item), name: text(item.name) || text(id), enabled: item.isActive !== false, transport: text(item.transport || item.type, 32) || 'local' }
    }) }
    if (section === 'skills') {
      const skills = await listSkills(text(config.skillPath, 32768))
      return { ok: true, section, items: (Array.isArray(skills) ? skills : []).map(item => ({ id: text(item.id), name: text(item.name), description: text(item.description, 240), enabled: item.disabled !== true })) }
    }
    if (section === 'tasks') return { ok: true, section, items: Object.entries(object(config.tasks)).map(([id, value]) => {
      const item = object(value)
      return { id: text(id), revision: revision(item), name: text(item.name || item.title) || text(id), description: typeof item.description === 'string' ? item.description.slice(0, 64 * 1024) : '', enabled: item.enabled === true, schedule: text(item.triggerType, 32) || 'manual', assistant: text(item.promptKey, 160) }
    }) }
    if (section === 'general') return { ok: true, section, revision: revision(generalSource(config)), value: { language: text(config.language, 16) || 'zh', themeMode: text(config.themeMode, 32) || 'system', displayName: text(config?.desktop?.profile?.nickname, 80) || 'User', avatarUrl: publicAvatar(config?.desktop?.profile?.avatar) } }
    throw remoteError('remote_workspace_section_invalid')
  }


  async function managementCatalog({ params = {} } = {}) {
    parameters(params, [])
    const { config, projects } = await current()
    const prompts = object(config.prompts)
    const providers = object(config.providers)
    const mcpServers = object(config.mcpServers)
    const tasks = object(config.tasks)
    return {
      ok: true,
      sections: [
        { id: 'assistants', title: '快捷助手', count: Object.keys(prompts).length },
        { id: 'providers', title: '服务商', count: Object.keys(providers).length },
        { id: 'mcp', title: 'MCP', count: Object.keys(mcpServers).length },
        { id: 'skills', title: 'Skill', count: 0 },
        { id: 'tasks', title: '定时任务', count: Object.keys(tasks).length },
        { id: 'general', title: '通用配置', count: 0 },
        { id: 'about', title: '关于', count: 0 }
      ],
      projects,
      general: { language: text(config.language, 16) || 'zh', themeMode: text(config.themeMode, 32) || 'system' }
    }
  }

  return { bootstrap, profile, assistantList, assistantGet, mutate, agentCatalog, agentGet, agentMutate, agentRoutesMutate, agentTagsMutate, providerCatalog, providerGet, providerMutate, providerFoldersMutate, providerModelsFetch, projectCreate, projectUpdate, projectRemove, managementCatalog, managementDetails, managementPatch }
}
