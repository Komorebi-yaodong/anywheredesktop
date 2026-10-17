import crypto from 'node:crypto'
import { normalizeDisplayName, normalizeIdentifier, remoteError, stableStringify } from './protocol.js'

const MAX_NAME = 160
const MAX_ICON = 256
const MAX_REQUESTS = 256
const REQUEST_TTL_MS = 30 * 60 * 1000
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


function publicAvatar(value) {
  const avatar = typeof value === 'string' ? value.trim() : ''
  return /^https:\/\//i.test(avatar) ? avatar.slice(0, 2048) : ''
}

function projectDto(project = {}) {
  return {
    projectId: text(project.id, MAX_NAME),
    name: text(project.name, MAX_NAME),
    conversationCount: Array.isArray(project.conversationIds) ? project.conversationIds.length : 0
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
export function createMobileWorkspaceService({ getConfig, updateConfig, getUser, readLocalProjects, writeLocalProjects, listSkills = () => [] } = {}) {
  if ([getConfig, updateConfig, getUser, readLocalProjects, writeLocalProjects].some((item) => typeof item !== 'function')) {
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
    return {
      displayName: text(user?.nickname, 80) || 'User',
      avatarUrl: publicAvatar(user?.avatar)
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

  return { bootstrap, profile, assistantList, assistantGet, mutate, projectCreate, managementCatalog, managementDetails, managementPatch }
}
