import fs from 'node:fs/promises'
import path from 'node:path'
import yaml from 'js-yaml'

export const PROJECTS_FILENAME = 'projects.yaml'
export const PROJECTS_VERSION = 2

function normalizeText(value, fallback = '') {
  if (typeof value === 'string') return value
  if (value == null) return fallback
  return String(value)
}

function normalizeTimestamp(value) {
  if (value == null || value === '') return ''
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? '' : date.toISOString()
}

function slugifyProjectId(name = '') {
  const base = normalizeText(name).trim().toLowerCase()
  const slug = base
    .replace(/[^\p{L}\p{N}]+/gu, '-')
    .replace(/^-+|-+$/g, '')
  return slug || `project-${Date.now().toString(36)}`
}

function emptyProjectsData() {
  return { version: PROJECTS_VERSION, conversations: {}, projects: [] }
}

function normalizeConversationEntry(rawId, rawEntry = {}) {
  const conversationId = normalizeText(rawEntry.conversationId || rawEntry.id || rawId).trim()
  const dbFile = normalizeText(rawEntry.dbFile).trim().replace(/[\\/]/g, '')
  if (!conversationId || !dbFile) return null

  const legacyJson = normalizeText(rawEntry.legacyJson).trim().replace(/[\\/]/g, '')
  const title = normalizeText(rawEntry.title).trim()
  const createdAt = normalizeTimestamp(rawEntry.createdAt)
  const updatedAt = normalizeTimestamp(rawEntry.updatedAt)

  return {
    conversationId,
    dbFile,
    title: title || (legacyJson.toLowerCase().endsWith('.json') ? legacyJson.slice(0, -5) : conversationId),
    legacyJson,
    storageMode: normalizeText(rawEntry.storageMode, 'local').trim() || 'local',
    revision: Math.max(0, Math.floor(Number(rawEntry.revision) || 0)),
    createdAt: createdAt || updatedAt,
    updatedAt: updatedAt || createdAt,
    schemaVersion: Math.max(1, Math.floor(Number(rawEntry.schemaVersion) || 1))
  }
}

export function normalizeProjects(input) {
  const data = input && typeof input === 'object' ? input : {}
  const rawConversations = data.conversations && typeof data.conversations === 'object' && !Array.isArray(data.conversations)
    ? data.conversations
    : {}
  const conversations = {}

  for (const [rawId, rawEntry] of Object.entries(rawConversations)) {
    const normalized = normalizeConversationEntry(rawId, rawEntry)
    if (!normalized || conversations[normalized.conversationId]) continue
    conversations[normalized.conversationId] = normalized
  }

  const conversationByLegacy = new Map()
  for (const entry of Object.values(conversations)) {
    if (entry.legacyJson) conversationByLegacy.set(entry.legacyJson, entry.conversationId)
  }

  const rawProjects = Array.isArray(data.projects) ? data.projects : []
  const seenFiles = new Set()
  const seenConversationIds = new Set()
  const seenIds = new Set()
  const projects = []

  for (const rawProject of rawProjects) {
    if (!rawProject || typeof rawProject !== 'object') continue

    const name = normalizeText(rawProject.name).trim()
    let id = normalizeText(rawProject.id).trim()
    if (!id) id = slugifyProjectId(name)
    if (seenIds.has(id)) {
      let suffix = 2
      let candidate = `${id}-${suffix}`
      while (seenIds.has(candidate)) candidate = `${id}-${++suffix}`
      id = candidate
    }
    seenIds.add(id)

    const files = []
    for (const rawFile of Array.isArray(rawProject.files) ? rawProject.files : []) {
      const basename = normalizeText(rawFile).trim()
      if (!basename || seenFiles.has(basename)) continue
      seenFiles.add(basename)
      files.push(basename)
    }

    const conversationIds = []
    const rawConversationIds = Array.isArray(rawProject.conversationIds) ? rawProject.conversationIds : []
    for (const rawConversationId of rawConversationIds) {
      const conversationId = normalizeText(rawConversationId).trim()
      if (!conversationId || !conversations[conversationId] || seenConversationIds.has(conversationId)) continue
      seenConversationIds.add(conversationId)
      conversationIds.push(conversationId)
    }

    // v1 compatibility: infer stable project ownership from the legacy JSON basename.
    for (const basename of files) {
      const conversationId = conversationByLegacy.get(basename)
      if (!conversationId || seenConversationIds.has(conversationId)) continue
      seenConversationIds.add(conversationId)
      conversationIds.push(conversationId)
    }

    projects.push({ id, name: name || id, files, conversationIds })
  }

  return { version: PROJECTS_VERSION, conversations, projects }
}

export function parseProjectsYaml(text) {
  const raw = normalizeText(text).trim()
  if (!raw) return emptyProjectsData()
  try {
    return normalizeProjects(yaml.load(raw))
  } catch {
    return emptyProjectsData()
  }
}

export function serializeProjectsYaml(data) {
  return yaml.dump(normalizeProjects(data), { lineWidth: -1, noRefs: true })
}

function resolveLocalProjectsPath(dirPath) {
  const normalizedDir = normalizeText(dirPath).trim()
  if (!normalizedDir) throw new Error('projects_local_dir_required')
  return path.join(path.resolve(normalizedDir), PROJECTS_FILENAME)
}

export async function readLocalProjects(dirPath) {
  const normalizedDir = normalizeText(dirPath).trim()
  if (!normalizedDir) return emptyProjectsData()
  try {
    return parseProjectsYaml(await fs.readFile(resolveLocalProjectsPath(normalizedDir), 'utf-8'))
  } catch (error) {
    if (error?.code === 'ENOENT') return emptyProjectsData()
    throw error
  }
}

export async function writeLocalProjects(dirPath, data) {
  const filePath = resolveLocalProjectsPath(dirPath)
  const tempPath = `${filePath}.${process.pid}.${Date.now()}.tmp`
  await fs.mkdir(path.dirname(filePath), { recursive: true })
  await fs.writeFile(tempPath, serializeProjectsYaml(data), { encoding: 'utf-8' })
  try {
    await fs.rename(tempPath, filePath)
  } catch (error) {
    if (process.platform === 'win32' && ['EEXIST', 'EPERM'].includes(error?.code)) {
      await fs.rm(filePath, { force: true })
      await fs.rename(tempPath, filePath)
    } else {
      await fs.rm(tempPath, { force: true }).catch(() => {})
      throw error
    }
  }
  return { ok: true, path: filePath }
}

export async function readCloudProjects(webdavConfig) {
  const { readBackup } = await import('./webdav.js')
  const result = await readBackup({ webdavConfig, filename: PROJECTS_FILENAME })
  if (!result || result.ok === false) return emptyProjectsData()
  return parseProjectsYaml(result.content)
}

export async function writeCloudProjects(webdavConfig, data) {
  const { writeBackup } = await import('./webdav.js')
  return writeBackup({
    webdavConfig,
    filename: PROJECTS_FILENAME,
    content: serializeProjectsYaml(data),
    overwrite: true,
    ensureDirectory: true
  })
}

function removeBasenameFromProjects(projects, basename) {
  const target = normalizeText(basename).trim()
  if (!target) return projects
  return projects.map((project) => ({
    ...project,
    files: project.files.filter((file) => file !== target)
  }))
}

function removeConversationFromProjects(projects, conversationId) {
  const target = normalizeText(conversationId).trim()
  if (!target) return projects
  return projects.map((project) => ({
    ...project,
    conversationIds: project.conversationIds.filter((id) => id !== target)
  }))
}

export function mergeFileAssignment(input, { basename, projectId, projectName } = {}) {
  const data = normalizeProjects(input)
  const target = normalizeText(basename).trim()
  if (!target) return data
  const mappedConversationId = Object.values(data.conversations).find((entry) => entry.legacyJson === target)?.conversationId || ''

  let projects = removeBasenameFromProjects(data.projects, target)
  if (mappedConversationId) projects = removeConversationFromProjects(projects, mappedConversationId)
  const normalizedProjectId = normalizeText(projectId).trim()
  if (!normalizedProjectId) return normalizeProjects({ ...data, projects })

  let found = false
  projects = projects.map((project) => {
    if (project.id !== normalizedProjectId) return project
    found = true
    return {
      ...project,
      files: [...project.files, target],
      conversationIds: mappedConversationId ? [...project.conversationIds, mappedConversationId] : project.conversationIds
    }
  })
  if (!found) {
    projects.push({
      id: normalizedProjectId,
      name: normalizeText(projectName).trim() || normalizedProjectId,
      files: [target],
      conversationIds: mappedConversationId ? [mappedConversationId] : []
    })
  }
  return normalizeProjects({ ...data, projects })
}

export function mergeProjectAssignment(input, project = {}) {
  const data = normalizeProjects(input)
  const projectId = normalizeText(project.id).trim()
  if (!projectId) return data
  const projectName = normalizeText(project.name).trim() || projectId
  const incomingFiles = Array.isArray(project.files) ? project.files.map((file) => normalizeText(file).trim()).filter(Boolean) : []
  const incomingConversationIds = Array.isArray(project.conversationIds)
    ? project.conversationIds.map((id) => normalizeText(id).trim()).filter((id) => data.conversations[id])
    : []
  const incomingFileSet = new Set(incomingFiles)
  const incomingConversationSet = new Set(incomingConversationIds)

  let projects = data.projects.map((existing) => ({
    ...existing,
    files: existing.files.filter((file) => !incomingFileSet.has(file)),
    conversationIds: existing.conversationIds.filter((id) => !incomingConversationSet.has(id))
  }))
  let found = false
  projects = projects.map((existing) => {
    if (existing.id !== projectId) return existing
    found = true
    return { ...existing, name: projectName, files: incomingFiles, conversationIds: incomingConversationIds }
  })
  if (!found) projects.push({ id: projectId, name: projectName, files: incomingFiles, conversationIds: incomingConversationIds })
  return normalizeProjects({ ...data, projects })
}

export function registerConversation(input, descriptor = {}, { projectId = '', projectName = '' } = {}) {
  const data = normalizeProjects(input)
  const normalized = normalizeConversationEntry(descriptor.conversationId || descriptor.id, descriptor)
  if (!normalized) throw new Error('conversation_descriptor_invalid')
  const conversations = { ...data.conversations, [normalized.conversationId]: normalized }
  let projects = data.projects
  if (projectId) {
    projects = removeConversationFromProjects(projects, normalized.conversationId)
    let found = false
    projects = projects.map((project) => {
      if (project.id !== projectId) return project
      found = true
      return { ...project, conversationIds: [...project.conversationIds, normalized.conversationId] }
    })
    if (!found) projects.push({ id: projectId, name: projectName || projectId, files: [], conversationIds: [normalized.conversationId] })
  }
  return normalizeProjects({ version: PROJECTS_VERSION, conversations, projects })
}

export function updateConversation(input, conversationId, patch = {}) {
  const data = normalizeProjects(input)
  const current = data.conversations[normalizeText(conversationId).trim()]
  if (!current) return data
  const next = normalizeConversationEntry(current.conversationId, { ...current, ...patch, conversationId: current.conversationId })
  return normalizeProjects({ ...data, conversations: { ...data.conversations, [current.conversationId]: next } })
}

export function removeConversation(input, conversationId) {
  const data = normalizeProjects(input)
  const target = normalizeText(conversationId).trim()
  if (!target || !data.conversations[target]) return data
  const conversations = { ...data.conversations }
  delete conversations[target]
  return normalizeProjects({ ...data, conversations, projects: removeConversationFromProjects(data.projects, target) })
}

export function findConversation(input, reference = '') {
  const data = normalizeProjects(input)
  const target = normalizeText(reference).trim()
  if (!target) return null
  if (data.conversations[target]) return { ...data.conversations[target] }
  const found = Object.values(data.conversations).find((entry) => entry.dbFile === target || entry.legacyJson === target)
  return found ? { ...found } : null
}

export function findProjectByBasename(input, basename) {
  const data = normalizeProjects(input)
  const target = normalizeText(basename).trim()
  if (!target) return null
  const conversationId = findConversation(data, target)?.conversationId || ''
  for (const project of data.projects) {
    if (project.files.includes(target) || (conversationId && project.conversationIds.includes(conversationId))) {
      return { id: project.id, name: project.name }
    }
  }
  return null
}
