import fs from 'node:fs/promises'
import path from 'node:path'
import yaml from 'js-yaml'

import { readBackup, writeBackup } from './webdav.js'

export const PROJECTS_FILENAME = 'projects.yaml'

const PROJECTS_VERSION = 1

function normalizeText(value, fallback = '') {
  if (typeof value === 'string') return value
  if (value == null) return fallback
  return String(value)
}

function slugifyProjectId(name = '') {
  const base = normalizeText(name).trim().toLowerCase()
  const slug = base
    .replace(/[^\p{L}\p{N}]+/gu, '-')
    .replace(/^-+|-+$/g, '')
  return slug || `project-${Date.now().toString(36)}`
}

function emptyProjectsData() {
  return { version: PROJECTS_VERSION, projects: [] }
}

// 规范化结构：确保 version/projects，files 去重 + trim，单一归属（一个 basename 只属于首个出现的项目），id 唯一。
export function normalizeProjects(input) {
  const data = input && typeof input === 'object' ? input : {}
  const rawProjects = Array.isArray(data.projects) ? data.projects : []

  const seenBasenames = new Set()
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
      while (seenIds.has(candidate)) {
        suffix += 1
        candidate = `${id}-${suffix}`
      }
      id = candidate
    }
    seenIds.add(id)

    const rawFiles = Array.isArray(rawProject.files) ? rawProject.files : []
    const files = []
    for (const rawFile of rawFiles) {
      const basename = normalizeText(rawFile).trim()
      if (!basename) continue
      if (seenBasenames.has(basename)) continue // 单一归属
      seenBasenames.add(basename)
      files.push(basename)
    }

    projects.push({
      id,
      name: name || id,
      files
    })
  }

  return { version: PROJECTS_VERSION, projects }
}

export function parseProjectsYaml(text) {
  const raw = normalizeText(text).trim()
  if (!raw) return emptyProjectsData()
  try {
    const parsed = yaml.load(raw)
    return normalizeProjects(parsed)
  } catch {
    return emptyProjectsData()
  }
}

export function serializeProjectsYaml(data) {
  const normalized = normalizeProjects(data)
  return yaml.dump(normalized, { lineWidth: -1, noRefs: true })
}

// --- 本地读写 ---

function resolveLocalProjectsPath(dirPath) {
  const normalizedDir = normalizeText(dirPath).trim()
  if (!normalizedDir) {
    throw new Error('projects_local_dir_required')
  }
  return path.join(path.resolve(normalizedDir), PROJECTS_FILENAME)
}

export async function readLocalProjects(dirPath) {
  const normalizedDir = normalizeText(dirPath).trim()
  if (!normalizedDir) return emptyProjectsData()

  const filePath = resolveLocalProjectsPath(normalizedDir)
  try {
    const content = await fs.readFile(filePath, 'utf-8')
    return parseProjectsYaml(content)
  } catch (error) {
    if (error?.code === 'ENOENT') {
      return emptyProjectsData()
    }
    throw error
  }
}

export async function writeLocalProjects(dirPath, data) {
  const filePath = resolveLocalProjectsPath(dirPath)
  const content = serializeProjectsYaml(data)
  await fs.writeFile(filePath, content, { encoding: 'utf-8' })
  return { ok: true, path: filePath }
}

// --- 云端读写（复用 webdav readBackup/writeBackup） ---

export async function readCloudProjects(webdavConfig) {
  const result = await readBackup({ webdavConfig, filename: PROJECTS_FILENAME })
  if (!result || result.ok === false) {
    // 文件不存在视为空项目表
    return emptyProjectsData()
  }
  return parseProjectsYaml(result.content)
}

export async function writeCloudProjects(webdavConfig, data) {
  const content = serializeProjectsYaml(data)
  const result = await writeBackup({
    webdavConfig,
    filename: PROJECTS_FILENAME,
    content,
    overwrite: true,
    ensureDirectory: true
  })
  return result
}

// --- 归属合并 helper ---

function removeBasenameFromProjects(projects, basename) {
  const target = normalizeText(basename).trim()
  if (!target) return projects
  return projects.map((project) => ({
    ...project,
    files: project.files.filter((file) => file !== target)
  }))
}

// 将单个文件归属合并到目标 projectId（projectId 为空表示移出/未分组）。
// projectMeta 用于目标项目不存在时创建（{ id, name }）。
export function mergeFileAssignment(input, { basename, projectId, projectName } = {}) {
  const data = normalizeProjects(input)
  const target = normalizeText(basename).trim()
  if (!target) return data

  let projects = removeBasenameFromProjects(data.projects, target)

  const normalizedProjectId = normalizeText(projectId).trim()
  if (!normalizedProjectId) {
    // 未分组：仅移除
    return normalizeProjects({ version: data.version, projects })
  }

  let found = false
  projects = projects.map((project) => {
    if (project.id === normalizedProjectId) {
      found = true
      return { ...project, files: [...project.files, target] }
    }
    return project
  })

  if (!found) {
    projects.push({
      id: normalizedProjectId,
      name: normalizeText(projectName).trim() || normalizedProjectId,
      files: [target]
    })
  }

  return normalizeProjects({ version: data.version, projects })
}

// 将整个项目的归属（完整 files 列表）合并到目标数据。
// 用于项目级同步：目标项目 files 设为给定 files，并从其它项目移除这些 basename。
export function mergeProjectAssignment(input, project = {}) {
  const data = normalizeProjects(input)
  const projectId = normalizeText(project.id).trim()
  if (!projectId) return data

  const projectName = normalizeText(project.name).trim() || projectId
  const incomingFiles = Array.isArray(project.files)
    ? project.files.map((file) => normalizeText(file).trim()).filter(Boolean)
    : []
  const incomingSet = new Set(incomingFiles)

  // 从所有项目移除即将归属本项目的文件
  let projects = data.projects.map((existing) => ({
    ...existing,
    files: existing.files.filter((file) => !incomingSet.has(file))
  }))

  let found = false
  projects = projects.map((existing) => {
    if (existing.id === projectId) {
      found = true
      return { ...existing, name: projectName, files: incomingFiles }
    }
    return existing
  })

  if (!found) {
    projects.push({ id: projectId, name: projectName, files: incomingFiles })
  }

  return normalizeProjects({ version: data.version, projects })
}

// 查询某 basename 当前所属项目（返回 { id, name } 或 null）
export function findProjectByBasename(input, basename) {
  const data = normalizeProjects(input)
  const target = normalizeText(basename).trim()
  if (!target) return null
  for (const project of data.projects) {
    if (project.files.includes(target)) {
      return { id: project.id, name: project.name }
    }
  }
  return null
}
