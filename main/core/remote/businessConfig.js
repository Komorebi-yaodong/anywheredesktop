import crypto from 'node:crypto'
import { decodeBase64Url, normalizeIdentifier, remoteError, stableStringify } from './protocol.js'

const SECTION_NAMES = ['general', 'providers', 'prompts', 'mcpServers', 'tasks']
const SECTION_SET = new Set(SECTION_NAMES)
const PARTITION_KEYS = new Set(['providers', 'prompts', 'mcpServers', 'tasks'])
const FORBIDDEN_KEYS = new Set(['__proto__', 'prototype', 'constructor'])
const MAX_SECTION_BYTES = 176 * 1024
const MAX_DEPTH = 16
const MAX_NODES = 30_000
const MAX_STRING_LENGTH = 256 * 1024
const REQUEST_TTL_MS = 30 * 60 * 1000
const MAX_REQUESTS = 256

const clone = (value) => structuredClone(value)
const object = (value) => value && typeof value === 'object' && !Array.isArray(value) ? value : null

function parameters(value, allowed) {
  if (!object(value)) throw remoteError('remote_parameter_invalid')
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) throw remoteError('remote_parameter_unknown')
  }
  return value
}

function sectionName(value) {
  const name = typeof value === 'string' ? value.trim() : ''
  if (!SECTION_SET.has(name)) throw remoteError('remote_business_config_section_invalid')
  return name
}

function validateJsonValue(value) {
  let nodes = 0
  const visit = (item, depth) => {
    nodes += 1
    if (nodes > MAX_NODES || depth > MAX_DEPTH) throw remoteError('remote_business_config_invalid')
    if (item === null || typeof item === 'boolean') return
    if (typeof item === 'number') {
      if (!Number.isFinite(item)) throw remoteError('remote_business_config_invalid')
      return
    }
    if (typeof item === 'string') {
      if (item.length > MAX_STRING_LENGTH) throw remoteError('remote_business_config_invalid')
      return
    }
    if (Array.isArray(item)) {
      for (const child of item) visit(child, depth + 1)
      return
    }
    if (!object(item)) throw remoteError('remote_business_config_invalid')
    for (const [key, child] of Object.entries(item)) {
      if (FORBIDDEN_KEYS.has(key) || key.length > 512) throw remoteError('remote_business_config_invalid')
      visit(child, depth + 1)
    }
  }
  visit(value, 0)
  const bytes = Buffer.byteLength(JSON.stringify(value), 'utf8')
  if (bytes > MAX_SECTION_BYTES) throw remoteError('remote_business_config_too_large')
  return { value: clone(value), bytes }
}

function revision(value) {
  return crypto.createHash('sha256').update(stableStringify(value)).digest('base64url')
}

function extractSection(config, section) {
  const source = object(config) || {}
  if (section !== 'general') return clone(object(source[section]) || {})
  const general = clone(source)
  for (const key of PARTITION_KEYS) delete general[key]
  delete general.remote
  delete general.skillPath
  if (object(general.webdav)) delete general.webdav.localChatPath
  return general
}

function applySection(currentConfig, section, value) {
  const current = clone(object(currentConfig) || {})
  if (section !== 'general') {
    current[section] = clone(value)
    return current
  }
  for (const key of [...PARTITION_KEYS, 'remote', 'skillPath']) {
    if (Object.hasOwn(value, key)) throw remoteError('remote_business_config_local_field_forbidden')
  }
  if (object(value.webdav) && Object.hasOwn(value.webdav, 'localChatPath')) {
    throw remoteError('remote_business_config_local_field_forbidden')
  }
  const next = clone(value)
  for (const key of PARTITION_KEYS) next[key] = clone(object(current[key]) || {})
  next.remote = clone(current.remote)
  next.skillPath = typeof current.skillPath === 'string' ? current.skillPath : ''
  next.webdav = object(next.webdav) || {}
  next.webdav.localChatPath = typeof current?.webdav?.localChatPath === 'string' ? current.webdav.localChatPath : ''
  return next
}

export function createRemoteBusinessConfigService({ getConfig, updateConfig } = {}) {
  if (typeof getConfig !== 'function' || typeof updateConfig !== 'function') {
    throw new Error('remote_business_config_dependencies_required')
  }
  const requests = new Map()
  let mutationTail = Promise.resolve()

  function pruneRequests() {
    const now = Date.now()
    for (const [key, record] of requests) {
      if (now - record.updatedAtMs > REQUEST_TTL_MS) requests.delete(key)
    }
    while (requests.size >= MAX_REQUESTS) requests.delete(requests.keys().next().value)
  }

  async function readCurrent() {
    const result = await getConfig()
    if (!object(result?.config)) throw remoteError('remote_business_config_unavailable')
    return result.config
  }

  async function get({ params = {} } = {}) {
    parameters(params, ['section'])
    const config = await readCurrent()
    if (params.section === undefined || params.section === '') {
      const sections = SECTION_NAMES.map((name) => {
        const checked = validateJsonValue(extractSection(config, name))
        return { name, revision: revision(checked.value), bytes: checked.bytes }
      })
      return { ok: true, sections }
    }
    const section = sectionName(params.section)
    const checked = validateJsonValue(extractSection(config, section))
    return { ok: true, section, revision: revision(checked.value), bytes: checked.bytes, value: checked.value }
  }

  async function replace({ deviceId, requestId, params = {} } = {}) {
    parameters(params, ['section', 'expectedRevision', 'value'])
    const safeDeviceId = normalizeIdentifier(deviceId, 'deviceId', { minLength: 16, maxLength: 160 })
    const safeRequestId = normalizeIdentifier(requestId, 'requestId', { minLength: 8, maxLength: 160 })
    const section = sectionName(params.section)
    const expectedRevision = typeof params.expectedRevision === 'string' ? params.expectedRevision : ''
    decodeBase64Url(expectedRevision, 'expectedRevision', { minBytes: 32, maxBytes: 32 })
    const checked = validateJsonValue(params.value)
    if (!object(checked.value)) throw remoteError('remote_business_config_invalid')
    // Validate forbidden local fields before entering the mutation queue.
    if (section === 'general') applySection({}, section, checked.value)

    const fingerprint = crypto.createHash('sha256').update(stableStringify({ section, expectedRevision, value: checked.value })).digest('hex')
    const key = `${safeDeviceId}:${safeRequestId}`
    const previous = requests.get(key)
    if (previous) {
      if (previous.fingerprint !== fingerprint) throw remoteError('remote_request_id_conflict')
      return { ...(await previous.promise), duplicate: true }
    }
    pruneRequests()
    const record = { fingerprint, updatedAtMs: Date.now(), promise: null }
    record.promise = mutationTail.catch(() => {}).then(async () => {
      const current = await readCurrent()
      const currentSection = validateJsonValue(extractSection(current, section)).value
      if (revision(currentSection) !== expectedRevision) throw remoteError('remote_business_config_revision_conflict')
      const next = applySection(current, section, checked.value)
      let result
      try {
        result = await updateConfig({ config: next })
      } catch {
        await updateConfig({ config: current }).catch(() => {})
        throw remoteError('remote_business_config_save_failed')
      }
      if (result?.success !== true) {
        await updateConfig({ config: current }).catch(() => {})
        throw remoteError('remote_business_config_save_failed')
      }
      const persisted = await readCurrent()
      const persistedSection = validateJsonValue(extractSection(persisted, section))
      return {
        ok: true,
        section,
        revision: revision(persistedSection.value),
        bytes: persistedSection.bytes,
        value: persistedSection.value
      }
    })
    mutationTail = record.promise.catch(() => {})
    requests.set(key, record)
    try {
      const result = await record.promise
      record.updatedAtMs = Date.now()
      return result
    } catch (error) {
      requests.delete(key)
      throw error
    }
  }

  return { get, replace, sections: [...SECTION_NAMES] }
}
