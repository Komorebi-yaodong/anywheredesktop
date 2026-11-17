import crypto from 'node:crypto'
import { stableStringify } from './protocol.js'

const key = crypto.randomBytes(32)
const entries = new Map()
let initialized = false
let paths = { projectRoot: '', skillRoot: '' }
export function workspaceRevisionPaths() {
  return { ...paths }
}
const token = (value) =>
  crypto.createHmac('sha256', key).update(stableStringify(value)).digest('base64url')
export function updateWorkspaceRevision(domain, value) {
  const hash = token(value)
  if (entries.get(domain)?.hash !== hash) entries.set(domain, { hash, updatedAt: Date.now() })
}
export function updateConfigurationRevisions(config) {
  paths = { projectRoot: config.webdav?.localChatPath || '', skillRoot: config.skillPath || '' }
  const pick = (keys) => keys.map((name) => config[name] ?? null)
  updateWorkspaceRevision('providers', pick(['providers', 'providerFolders', 'providerOrder']))
  updateWorkspaceRevision(
    'agents',
    pick([
      'prompts',
      'tags',
      'defaultTaskModel',
      'defaultSuperiorModel',
      'defaultFastModel',
      'voiceList'
    ])
  )
  updateWorkspaceRevision('tasks', pick(['tasks']))
  updateWorkspaceRevision('mcp', pick(['mcpServers']))
  updateWorkspaceRevision('skillsRoot', config.skillPath || '')
  updateWorkspaceRevision('general', [
    config.desktop?.profile || null,
    ...pick(['language', 'themeMode'])
  ])
  updateWorkspaceRevision('projectRoot', config.webdav?.localChatPath || '')
  initialized = true
}
export function workspaceRevisionsReady() {
  return initialized
}
export function readWorkspaceRevisions() {
  const values = Object.fromEntries([...entries].map(([name, value]) => [name, { ...value }]))
  return { ok: true, revision: token(values), resources: values, checkedAt: Date.now() }
}
export function touchWorkspaceSkills() {
  updateWorkspaceRevision('skillsContent', crypto.randomUUID())
}
