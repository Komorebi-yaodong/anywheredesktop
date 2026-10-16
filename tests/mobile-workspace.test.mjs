import assert from 'node:assert/strict'
import { createMobileWorkspaceService } from '../main/core/remote/mobileWorkspace.js'

let config = {
  language: 'zh', themeMode: 'system',
  webdav: { localChatPath: 'PRIVATE_LOCAL_PATH' },
  remote: { enabled: true, host: '0.0.0.0', port: 17860 },
  skillPath: 'PRIVATE_SKILLS',
  prompts: { Code: { name: '代码助手', icon: 'https://example.test/icon.png', prompt: 'PRIVATE_PROMPT', model: 'p|m', autoSaveProjectId: 'work', defaultMcpServers: ['m1'], skillIds: ['s1'] } },
  providers: { p: { api_key: 'PRIVATE_KEY' } },
  mcpServers: { m1: { name: 'MCP', command: 'PRIVATE_COMMAND' } }, tasks: { t1: { title: 'Task' }
  }
}
let projects = { version: 2, conversations: {}, projects: [{ id: 'work', name: '工作', files: [], conversationIds: [] }] }
const service = createMobileWorkspaceService({
  getConfig: async () => ({ config: structuredClone(config) }),
  updateConfig: async ({ config: next }) => { config = structuredClone(next); return { success: true } },
  getUser: async () => ({ nickname: 'Komorebi', avatar: 'file:///PRIVATE_AVATAR.png' }),
  readLocalProjects: async () => structuredClone(projects),
  writeLocalProjects: async (_dir, next) => { projects = structuredClone(next); return { ok: true } }
})
const bootstrap = await service.bootstrap({ params: {} })
assert.equal(bootstrap.profile.displayName, 'Komorebi')
assert.equal(bootstrap.profile.avatarUrl, '')
assert.deepEqual(bootstrap.projects, [{ projectId: 'work', name: '工作', conversationCount: 0 }])
assert.deepEqual(bootstrap.assistants[0].name, '代码助手')
assert.equal(JSON.stringify(bootstrap).includes('PRIVATE'), false)
const detail = await service.assistantGet({ params: { code: 'Code' } })
assert.equal(detail.assistant.defaultProjectName, '工作')
const patched = await service.mutate({ deviceId: 'device-mobile-workspace-0001', requestId: 'request-workspace-patch-0001', params: { code: 'Code', expectedRevision: detail.assistant.revision, patch: { name: '编码助手', defaultProjectId: 'work' } } })
assert.equal(patched.assistant.name, '编码助手')
const created = await service.projectCreate({ deviceId: 'device-mobile-workspace-0001', requestId: 'request-project-create-0001', params: { name: '研究' } })
assert.equal(created.project.name, '研究')
assert.equal((await service.projectCreate({ deviceId: 'device-mobile-workspace-0001', requestId: 'request-project-create-0001', params: { name: '研究' } })).duplicate, true)
await assert.rejects(service.projectCreate({ deviceId: 'device-mobile-workspace-0001', requestId: 'request-project-forbidden', params: { name: 'x', dirPath: 'PRIVATE' } }), { code: 'remote_parameter_unknown' })
const catalog = await service.managementCatalog({ params: {} })
assert.deepEqual(catalog.sections.map((item) => item.id), ['assistants', 'providers', 'mcp', 'skills', 'tasks', 'general', 'about'])
assert.equal(JSON.stringify(catalog).includes('PRIVATE'), false)
console.log(JSON.stringify({ ok: true, suite: 'mobile-workspace' }))
