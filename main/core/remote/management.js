import crypto from 'node:crypto'
import { remoteError, stableStringify, normalizeIdentifier } from './protocol.js'

const obj = (value) => (value && typeof value === 'object' && !Array.isArray(value) ? value : {})
const rev = (value) =>
  crypto.createHash('sha256').update(stableStringify(value)).digest('base64url')
const field = (key, label, type = 'text', extra = {}) => ({ key, label, type, ...extra })
const common = [field('name', '名称')]
const schemas = {
  assistants: [
    ...common,
    field('enable', '启用', 'boolean'),
    field('prompt', '系统提示词', 'multiline'),
    field('model', '模型', 'model'),
    field('autoSaveProjectId', '默认项目', 'project'),
    field('defaultMcpServers', 'MCP', 'mcp'),
    field('skillIds', 'Skill', 'skills'),
    field('reasoning_effort', '思维深度', 'select', {
      options: ['default', 'none', 'low', 'medium', 'high']
    }),
    field('voice', '语音'),
    field('autoSave', '自动保存', 'boolean')
  ],
  providers: [
    ...common,
    field('enable', '启用', 'boolean'),
    field('url', '服务地址', 'url'),
    field('api_key', 'API Key（留空不修改）', 'secret'),
    field('apiType', 'API 类型', 'select', {
      options: ['chat_completions', 'responses', 'codex', 'claude']
    }),
    field('modelList', '模型列表', 'lines'),
    field('headers', '请求头', 'pairs'),
    field('retryCount', '重试次数', 'number', { min: 0, max: 10 })
  ],
  mcp: [
    ...common,
    field('isActive', '启用', 'boolean'),
    field('transport', '传输类型', 'select', { options: ['http', 'sse'] }),
    field('url', '服务地址', 'url'),
    field('headers', '请求头', 'pairs')
  ],
  skills: [
    ...common,
    field('description', '说明', 'multiline'),
    field('enabled', '允许模型调用', 'boolean'),
    field('content', '技能内容', 'multiline'),
    field('fork', '子代理模式', 'boolean')
  ],
  tasks: [
    ...common,
    field('enabled', '在当前 Desktop 启用', 'boolean'),
    field('description', '任务内容', 'multiline'),
    field('promptKey', '助手', 'assistant'),
    field('triggerType', '频率', 'select', {
      options: ['interval', 'daily', 'weekly', 'monthly', 'single']
    }),
    field('intervalMinutes', '间隔分钟', 'number', { min: 1, max: 525600 }),
    field('intervalStartTime', '间隔开始时间', 'time'),
    field('dailyTime', '每日时间', 'time'),
    field('weeklyTime', '每周时间', 'time'),
    field('weeklyDays', '星期（0 周日到 6 周六）', 'numbers', { min: 0, max: 6 }),
    field('monthlyTime', '每月时间', 'time'),
    field('monthlyDays', '日期（1–31）', 'numbers', { min: 1, max: 31 }),
    field('singleDate', '单次日期', 'date'),
    field('singleTime', '单次时间', 'time'),
    field('modelRoute', '默认助手路线', 'select', { options: ['general', 'superior', 'fast'] }),
    field('extraMcp', '额外 MCP', 'mcp'),
    field('extraSkills', '额外 Skill', 'skills'),
    field('autoSaveProjectId', '保存项目', 'project'),
    field('autoSave', '自动保存', 'boolean'),
    field('autoClose', '完成后关闭', 'boolean')
  ],
  general: [
    field('language', '语言', 'select', { options: ['zh', 'en'] }),
    field('themeMode', 'Desktop 主题', 'select', { options: ['system', 'light', 'dark'] }),
    field('nickname', '昵称（最多12字）'),
    field('avatar', '公开头像', 'url')
  ]
}
const sections = {
  assistants: 'prompts',
  providers: 'providers',
  mcp: 'mcpServers',
  tasks: 'tasks'
}
function checkParams(value, keys) {
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    Object.keys(value).some((key) => !keys.includes(key))
  )
    throw remoteError('remote_parameter_unknown')
  return value
}
function safeId(value) {
  if (
    typeof value !== 'string' ||
    !value ||
    value.length > 160 ||
    /[\\/:*?"<>|\x00-\x1f]/.test(value) ||
    /[. ]$/.test(value) || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(value) ||
    ['.', '..', '__proto__', 'constructor', 'prototype'].includes(value)
  )
    throw remoteError('remote_identifier_invalid')
  return value
}
function validate(schema, input) {
  const result = {}
  checkParams(
    input,
    schema.map((item) => item.key)
  )
  for (const [key, value] of Object.entries(input)) {
    const spec = schema.find((item) => item.key === key)
    if (spec.type === 'boolean') {
      if (typeof value !== 'boolean') throw remoteError('remote_management_invalid')
      result[key] = value
      continue
    }
    if (spec.type === 'number') {
      if (!Number.isInteger(value) || value < spec.min || value > spec.max)
        throw remoteError('remote_management_invalid')
      result[key] = value
      continue
    }
    if (['lines', 'numbers', 'mcp', 'skills'].includes(spec.type)) {
      if (
        !Array.isArray(value) ||
        value.length > 500 ||
        value.some((v) =>
          spec.type === 'numbers'
            ? !Number.isInteger(v) || v < spec.min || v > spec.max
            : typeof v !== 'string' || v.length > 320
        )
      )
        throw remoteError('remote_management_invalid')
      result[key] = [...new Set(value)]
      continue
    }
    if (spec.type === 'pairs') {
      if (
        !value ||
        typeof value !== 'object' ||
        Array.isArray(value) ||
        Object.keys(value).length > 64 ||
        Object.entries(value).some(
          ([k, v]) =>
            !/^[A-Za-z0-9_-]+$/.test(k) ||
            ['__proto__', 'constructor', 'prototype'].includes(k) ||
            typeof v !== 'string' ||
            v.length > 8192
        )
      )
        throw remoteError('remote_management_invalid')
      result[key] = structuredClone(value)
      continue
    }
    if (
      typeof value !== 'string' ||
      value.length > (spec.type === 'multiline' ? 64000 : spec.type === 'secret' ? 8192 : 2048)
    )
      throw remoteError('remote_management_invalid')
    if (spec.type === 'select' && !spec.options.includes(value))
      throw remoteError('remote_management_invalid')
    if (spec.type === 'time' && !/^([01]\d|2[0-3]):[0-5]\d$/.test(value))
      throw remoteError('remote_management_invalid')
    if (
      spec.type === 'date' &&
      (!/^\d{4}-\d{2}-\d{2}$/.test(value) || Number.isNaN(Date.parse(value)))
    )
      throw remoteError('remote_management_invalid')
    if (key === 'nickname' && (!value.trim() || value.length > 12))
      throw remoteError('remote_management_invalid')
    if (spec.type === 'url' && value) {
      let u
      try {
        u = new URL(value)
      } catch {
        throw remoteError('remote_management_invalid')
      }
      if (
        !['http:', 'https:'].includes(u.protocol) ||
        u.username ||
        u.password ||
        u.search ||
        u.hash ||
        (key === 'avatar' && u.protocol !== 'https:')
      )
        throw remoteError('remote_management_invalid')
    }
    result[key] = value
  }
  return result
}

export function createRemoteManagementService({
  getConfig,
  updateConfig,
  readProjects,
  skills,
  setTaskEnabled,
  getTaskDevice
}) {
  let tail = Promise.resolve()
  const requests = new Map()
  async function config() {
    return obj((await getConfig())?.config)
  }
  function general(c) {
    return {
      language: c.language || 'zh',
      themeMode: c.themeMode || 'system',
      nickname: c.desktop?.profile?.nickname || 'User',
      avatar: /^https:\/\//.test(c.desktop?.profile?.avatar || '') ? c.desktop.profile.avatar : ''
    }
  }
  async function source(c, section, id) {
    if (section === 'general') return general(c)
    if (section === 'skills') return skills.get(c.skillPath, safeId(id))
    return Object.hasOwn(obj(c[sections[section]]), id) ? c[sections[section]][id] : null
  }
  async function catalog({ params = {} } = {}) {
    checkParams(params, ['section', 'id'])
    const section = params.section
    if (!Object.hasOwn(schemas, section)) throw remoteError('remote_workspace_section_invalid')
    const c = await config()
    const schema = structuredClone(schemas[section])
    const rawSkills = await skills.list(c.skillPath)
    const projects = c.webdav?.localChatPath
      ? await readProjects(c.webdav.localChatPath)
      : { projects: [] }
    const options = {
      model: Object.entries(obj(c.providers)).flatMap(([id, p]) =>
        (p.enable !== false && Array.isArray(p.modelList) ? p.modelList : []).map((name) => ({
          value: `${id}|${name}`,
          label: `${p.name || id} · ${name}`
        }))
      ),
      project: [
        { value: '', label: '不分组' },
        ...(projects.projects || []).map((p) => ({ value: p.id, label: p.name }))
      ],
      assistant: [
        { value: '__DEFAULT__', label: '默认助手' },
        ...Object.entries(obj(c.prompts))
          .filter(([, p]) => p.enable !== false)
          .map(([id, p]) => ({ value: id, label: p.name || id }))
      ],
      mcp: Object.entries(obj(c.mcpServers)).map(([id, p]) => ({ value: id, label: p.name || id })),
      skills: rawSkills.map((s) => ({ value: s.id, label: s.name }))
    }
    if (!params.id && section !== 'general') {
      const entries =
        section === 'skills'
          ? rawSkills.map((s) => [s.id, s])
          : Object.entries(obj(c[sections[section]]))
      return {
        ok: true,
        section,
        schema,
        options,
        items: entries.map(([id, p]) => ({
          id,
          name: p.name || id,
          enabled:
            section === 'skills'
              ? p.enabled !== false
              : (p.enable ?? p.isActive ?? p.enabled) !== false
        }))
      }
    }
    const id = section === 'general' ? '' : safeId(params.id)
    const raw = await source(c, section, id)
    if (!raw) throw remoteError('remote_workspace_item_not_found')
    const localMcp =
      section === 'mcp' &&
      (!raw.transport || raw.transport === 'stdio' || raw.type === 'stdio' || raw.builtin)
    const effective = localMcp ? schema.filter((s) => ['name', 'isActive'].includes(s.key)) : schema
    const value = {}
    for (const spec of effective) {
      if (spec.type === 'secret' || spec.type === 'pairs') {
        if (spec.type === 'pairs') value[spec.key] = {}
        continue
      }
      if (Object.hasOwn(raw, spec.key)) value[spec.key] = structuredClone(raw[spec.key])
    }
    if (value.url) {
      try {
        const u = new URL(value.url)
        u.username = ''
        u.password = ''
        u.search = ''
        u.hash = ''
        value.url = u.toString()
      } catch {
        value.url = ''
      }
    }
    return {
      ok: true,
      section,
      id,
      revision: rev(raw),
      schema: effective,
      options,
      value,
      hasSecrets: Boolean(raw.api_key || Object.keys(raw.headers || {}).length),
      localOnly: localMcp
    }
  }
  async function mutate({ deviceId, requestId, params = {} }) {
    checkParams(params, ['section', 'id', 'operation', 'expectedRevision', 'patch', 'confirmed'])
    const { section, operation } = params
    if (
      !Object.hasOwn(schemas, section) ||
      !['create', 'patch', 'delete'].includes(operation) ||
      (section === 'general' && operation !== 'patch')
    )
      throw remoteError('remote_management_invalid')
    const device = normalizeIdentifier(deviceId, 'deviceId', { minLength: 16 }),
      request = normalizeIdentifier(requestId, 'requestId', { minLength: 8 })
    const target = section === 'general' ? '' : safeId(params.id)
    if (operation === 'delete' && params.confirmed !== true)
      throw remoteError('remote_confirmation_required')
    const patch = operation === 'delete' ? {} : validate(schemas[section], params.patch)
    if (Buffer.byteLength(stableStringify(params), 'utf8') > 96 * 1024)
      throw remoteError('remote_request_too_large')
    const fingerprint = rev(params),
      key = `${device}:${request}`
    const old = requests.get(key)
    if (old) {
      if (old.fingerprint !== fingerprint) throw remoteError('remote_request_id_conflict')
      return { ...(await old.promise), duplicate: true }
    }
    if (requests.size >= 256) {
      const done = [...requests].find(([, r]) => r.done)
      if (!done) throw remoteError('remote_request_limit_reached')
      requests.delete(done[0])
    }
    const record = { fingerprint, done: false, promise: null }
    record.promise = tail
      .catch(() => {})
      .then(async () => {
        const c = await config(),
          raw = await source(c, section, target)
        if (operation === 'create' && raw) throw remoteError('remote_management_item_exists')
        if (operation !== 'create' && (!raw || rev(raw) !== params.expectedRevision))
          throw remoteError('remote_workspace_revision_conflict')
        if (
          section === 'mcp' &&
          raw &&
          (!raw.transport || raw.transport === 'stdio' || raw.type === 'stdio' || raw.builtin) &&
          Object.keys(patch).some((k) => !['name', 'isActive'].includes(k))
        )
          throw remoteError('remote_management_local_only')
        if (section === 'mcp' && raw?.builtin && operation === 'delete')
          throw remoteError('remote_management_local_only')
        if (section === 'skills') {
          if (!c.skillPath) throw remoteError('remote_skill_root_not_configured')
          if (operation === 'delete') await skills.remove(c.skillPath, target)
          else
            await skills.save(c.skillPath, target, {
              name: target,
              description: '',
              enabled: true,
              content: '',
              fork: false,
              ...raw,
              ...patch
            })
        } else {
          const next = structuredClone(c)
          if (section === 'general') {
            const p = { ...general(c), ...patch }
            next.language = p.language
            next.themeMode = p.themeMode
            next.desktop = {
              ...obj(c.desktop),
              profile: {
                ...obj(c.desktop?.profile),
                nickname: p.nickname,
                avatar: Object.hasOwn(patch, 'avatar') ? p.avatar : c.desktop?.profile?.avatar || ''
              }
            }
          } else {
            const key = sections[section],
              defaults =
                section === 'assistants'
                  ? { name: target, enable: true, showMode: 'window', autoSave: true, prompt: '' }
                  : section === 'providers'
                    ? {
                        name: target,
                        enable: true,
                        url: '',
                        api_key: '',
                        modelList: [],
                        headers: {},
                        retryCount: 3,
                        apiType: 'chat_completions'
                      }
                    : section === 'mcp'
                      ? { name: target, isActive: false, transport: 'http', url: '', headers: {} }
                      : {
                          name: target,
                          description: '',
                          enabled: false,
                          triggerType: 'daily',
                          dailyTime: '12:00',
                          intervalMinutes: 60,
                          promptKey: '__DEFAULT__',
                          appliedDevices: [],
                          history: []
                        }
            next[key] = { ...obj(c[key]) }
            if (operation === 'delete') delete next[key][target]
            else {
              const merged = { ...defaults, ...raw, ...patch }
              if (section === 'providers' && patch.api_key === '')
                merged.api_key = raw?.api_key || ''
              if (section === 'tasks' && merged.enabled) {
                const timeKey = {
                  daily: 'dailyTime',
                  weekly: 'weeklyTime',
                  monthly: 'monthlyTime',
                  single: 'singleTime'
                }[merged.triggerType]
                if (timeKey && !/^([01]\d|2[0-3]):[0-5]\d$/.test(merged[timeKey] || ''))
                  throw remoteError('remote_management_invalid')
                if (
                  (merged.triggerType === 'weekly' && !merged.weeklyDays?.length) ||
                  (merged.triggerType === 'monthly' && !merged.monthlyDays?.length) ||
                  (merged.triggerType === 'single' && !merged.singleDate)
                )
                  throw remoteError('remote_management_invalid')
                if (
                  merged.promptKey !== '__DEFAULT__' &&
                  !Object.hasOwn(obj(c.prompts), merged.promptKey)
                )
                  throw remoteError('remote_assistant_invalid')
              }
              if (section === 'tasks' && Object.hasOwn(patch, 'enabled')) {
                setTaskEnabled(merged, patch.enabled, getTaskDevice())
                if (patch.enabled) merged.lastRunTime = Date.now()
              }
              next[key][target] = merged
            }
            if (section === 'providers')
              next.providerOrder =
                operation === 'delete'
                  ? (c.providerOrder || []).filter((id) => id !== target)
                  : [...new Set([...(c.providerOrder || []), target])]
          }
          try {
            if ((await updateConfig({ config: next }))?.success !== true)
              throw remoteError('remote_workspace_save_failed')
          } catch {
            await updateConfig({ config: c }).catch(() => {})
            throw remoteError('remote_workspace_save_failed')
          }
        }
        return { ok: true, section, id: target, operation }
      })
    tail = record.promise.catch(() => {})
    requests.set(key, record)
    try {
      return await record.promise
    } finally {
      record.done = true
    }
  }
  return { catalog, mutate }
}
