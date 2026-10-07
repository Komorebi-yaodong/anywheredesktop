import crypto from 'node:crypto'
import { normalizeIdentifier, remoteError } from './protocol.js'

const FORBIDDEN_PATH_KEYS = new Set([
  'path',
  'filepath',
  'dirpath',
  'dbfile',
  'legacyjson',
  'worktreedir',
  'localchatpath'
])

function asObject(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {}
}

function normalizeText(value = '') {
  return typeof value === 'string' ? value.trim() : ''
}

function normalizeTime(value = '') {
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? '' : date.toISOString()
}

function assertAllowedParameters(input = {}, allowedKeys = []) {
  const source = asObject(input)
  const allowed = new Set(allowedKeys)
  for (const key of Object.keys(source)) {
    const normalizedKey = key.toLowerCase()
    if (FORBIDDEN_PATH_KEYS.has(normalizedKey)) throw remoteError('remote_path_parameter_forbidden')
    if (!allowed.has(key)) throw remoteError('remote_parameter_unknown')
  }
}

function legacyConversationId(basename = '') {
  return `legacy_${crypto.createHash('sha256').update(String(basename)).digest('hex').slice(0, 32)}`
}

function encodeCursor(item) {
  return Buffer.from(JSON.stringify({
    updatedAt: item.updatedAt || '',
    conversationId: item.conversationId
  }), 'utf8').toString('base64url')
}

function decodeCursor(value = '') {
  if (!value) return null
  if (typeof value !== 'string' || value.length > 512 || !/^[A-Za-z0-9_-]+$/.test(value)) {
    throw remoteError('remote_cursor_invalid')
  }
  try {
    const parsed = JSON.parse(Buffer.from(value, 'base64url').toString('utf8'))
    const updatedAt = normalizeTime(parsed?.updatedAt)
    const conversationId = normalizeIdentifier(parsed?.conversationId, 'conversationId', { minLength: 16, maxLength: 160 })
    return { updatedAt, conversationId }
  } catch (error) {
    if (error?.code) throw error
    throw remoteError('remote_cursor_invalid')
  }
}

function toRemoteWindow(item = {}) {
  const conversationId = normalizeText(item.conversationId)
  if (!conversationId) return null
  return {
    windowId: normalizeText(item.id).slice(0, 160),
    conversationId,
    title: normalizeText(item.conversationTitle || item.title || item.displayName).slice(0, 240),
    revision: Math.max(0, Number(item.conversationRevision ?? item.revision) || 0),
    visible: item.visible === true,
    busy: item.busy === true,
    generating: item.generating === true,
    compacting: item.compacting === true,
    readOnly: item.readOnly === true,
    leasePending: item.leasePending === true,
    promptCode: normalizeText(item.promptCode || '__DEFAULT__') || '__DEFAULT__'
  }
}

function sortConversations(left, right) {
  const byTime = String(right.updatedAt || '').localeCompare(String(left.updatedAt || ''))
  return byTime || left.conversationId.localeCompare(right.conversationId)
}

export function createRemoteConversationReadService({
  getConfig,
  listLocalConversations,
  readLocalProjects,
  loadRemoteConversationPage,
  listWindows
} = {}) {
  if (typeof getConfig !== 'function') throw new Error('remote_read_get_config_required')
  if (typeof listLocalConversations !== 'function') throw new Error('remote_read_list_conversations_required')
  if (typeof readLocalProjects !== 'function') throw new Error('remote_read_projects_required')
  if (typeof loadRemoteConversationPage !== 'function') throw new Error('remote_read_page_required')
  if (typeof listWindows !== 'function') throw new Error('remote_read_windows_required')

  async function getLocalDirectory() {
    const result = await getConfig()
    const directory = normalizeText(result?.config?.webdav?.localChatPath)
    return directory
  }

  function getWindows(params = {}) {
    assertAllowedParameters(params, [])
    const rawWindows = listWindows('window')
    const windows = (Array.isArray(rawWindows) ? rawWindows : [])
      .map(toRemoteWindow)
      .filter(Boolean)
      .sort((left, right) => left.windowId.localeCompare(right.windowId))
    return {
      ok: true,
      windows,
      updatedAt: new Date().toISOString()
    }
  }

  async function listConversations(params = {}) {
    assertAllowedParameters(params, ['limit', 'cursor'])
    const limit = Math.min(200, Math.max(1, Math.floor(Number(params.limit) || 100)))
    const cursor = decodeCursor(params.cursor || '')
    const directory = await getLocalDirectory()
    const windowResult = getWindows()
    const openByConversationId = new Map(windowResult.windows.map((item) => [item.conversationId, item]))

    if (!directory) {
      return {
        ok: true,
        configured: false,
        conversations: [],
        projects: [],
        page: { limit, nextCursor: null, hasMore: false },
        catalogRevision: crypto.createHash('sha256').update('unconfigured').digest('base64url')
      }
    }

    const [rawConversations, projectsData] = await Promise.all([
      listLocalConversations(directory),
      readLocalProjects(directory)
    ])
    const projects = Array.isArray(projectsData?.projects) ? projectsData.projects : []
    const projectByConversationId = new Map()
    const projectByFile = new Map()
    for (const project of projects) {
      const publicProject = { projectId: normalizeText(project.id), name: normalizeText(project.name) }
      for (const conversationId of Array.isArray(project.conversationIds) ? project.conversationIds : []) {
        projectByConversationId.set(conversationId, publicProject)
      }
      for (const basename of Array.isArray(project.files) ? project.files : []) {
        projectByFile.set(basename, publicProject)
      }
    }

    const conversations = (Array.isArray(rawConversations) ? rawConversations : [])
      .map((item) => {
        const isSqlite = item?.format === 'sqlite' && normalizeText(item.conversationId)
        const conversationId = isSqlite
          ? normalizeText(item.conversationId)
          : legacyConversationId(item?.basename || item?.filename || item?.title)
        const project = isSqlite
          ? projectByConversationId.get(conversationId) || null
          : projectByFile.get(item?.basename || item?.filename) || null
        const window = openByConversationId.get(conversationId) || null
        return {
          conversationId,
          title: (normalizeText(item?.title) || 'Untitled').slice(0, 240),
          format: isSqlite ? 'sqlite' : 'legacy-json',
          revision: isSqlite ? Math.max(0, Number(item?.revision) || 0) : 0,
          createdAt: normalizeTime(item?.createdAt),
          updatedAt: normalizeTime(item?.updatedAt || item?.lastmod),
          byteSize: Math.max(0, Number(item?.size) || 0),
          project,
          migrationRequired: !isSqlite,
          readable: Boolean(isSqlite),
          window
        }
      })
      .sort(sortConversations)

    let startIndex = 0
    if (cursor) {
      const matchedIndex = conversations.findIndex((item) =>
        item.conversationId === cursor.conversationId && item.updatedAt === cursor.updatedAt
      )
      if (matchedIndex < 0) throw remoteError('remote_cursor_stale')
      startIndex = matchedIndex + 1
    }
    const pageItems = conversations.slice(startIndex, startIndex + limit)
    const hasMore = startIndex + pageItems.length < conversations.length
    const safeProjects = projects.map((project) => ({
      projectId: normalizeText(project.id),
      name: normalizeText(project.name).slice(0, 160),
      conversationIds: pageItems
        .filter((item) => item.project?.projectId === normalizeText(project.id))
        .map((item) => item.conversationId)
    }))
    const catalogRevision = crypto.createHash('sha256').update(JSON.stringify({
      conversations: conversations.map((item) => [item.conversationId, item.revision, item.updatedAt, item.window?.busy || false]),
      projects: safeProjects
    })).digest('base64url')

    return {
      ok: true,
      configured: true,
      conversations: pageItems,
      projects: safeProjects,
      windows: windowResult.windows,
      page: {
        limit,
        nextCursor: hasMore && pageItems.length > 0 ? encodeCursor(pageItems.at(-1)) : null,
        hasMore
      },
      catalogRevision
    }
  }

  async function listMessages(params = {}) {
    assertAllowedParameters(params, ['conversationId', 'beforeUiOrder', 'pageSize'])
    const conversationId = normalizeIdentifier(params.conversationId, 'conversationId', { minLength: 16, maxLength: 160 })
    if (conversationId.startsWith('legacy_')) throw remoteError('remote_conversation_migration_required')
    const directory = await getLocalDirectory()
    if (!directory) throw remoteError('remote_conversation_directory_not_configured')
    return loadRemoteConversationPage({
      dirPath: directory,
      conversationId,
      beforeUiOrder: params.beforeUiOrder,
      pageSize: params.pageSize
    })
  }

  return {
    listConversations,
    listMessages,
    getWindows
  }
}
