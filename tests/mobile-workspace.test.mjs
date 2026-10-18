import assert from 'node:assert/strict'
import { createMobileWorkspaceService } from '../main/core/remote/mobileWorkspace.js'

let config = {
  language: 'zh', themeMode: 'system',
  webdav: { localChatPath: 'PRIVATE_LOCAL_PATH' },
  remote: { enabled: true, host: '0.0.0.0', port: 17860 },
  skillPath: 'PRIVATE_SKILLS',
  prompts: { Code: { name: '代码助手', icon: 'https://example.test/icon.png', prompt: 'PRIVATE_PROMPT', model: 'p|m', autoSaveProjectId: 'work', defaultMcpServers: ['m1'], skillIds: ['s1'] } },
  providers: { p: { name: '安全服务商', api_key: 'PRIVATE_KEY' } },
  mcpServers: { m1: { name: 'MCP', tags: ['文件', 'Research'], command: 'PRIVATE_COMMAND' } }, tasks: { t1: { title: 'Task' }
  }
}
let projects = { version: 2, conversations: {}, projects: [{ id: 'work', name: '工作', files: [], conversationIds: [] }] }
let profileAvatar = 'file:///PRIVATE_AVATAR.png'
let normalizeAvatarDataUrl = (value) => value

let skillEnabled = true
const service = createMobileWorkspaceService({
  getConfig: async () => ({ config: structuredClone(config) }),
  updateConfig: async ({ config: next }) => { config = structuredClone(next); return { success: true } },
  getUser: async () => ({ nickname: 'Komorebi', avatar: profileAvatar }),
  readLocalProjects: async () => structuredClone(projects),
  writeLocalProjects: async (_dir, next) => { projects = structuredClone(next); return { ok: true } },
  normalizeAvatarDataUrl: async (value) => normalizeAvatarDataUrl(value),
  listSkills: () => [{ id: 's1', name: 'Skill One', description: 'Safe description', disabled: false, path: 'PRIVATE_SKILL_PATH' }],
  listToggleSkills: () => [{ id: 's1', name: 'Skill One', enabled: skillEnabled !== false }],
  toggleSkill: async (_root, id, enabled) => { if (id === 's1') skillEnabled = enabled },
  listProviderModels: async () => ({ models: [{ id: 'z-model' }, { id: 'a-model' }] })
})
const bootstrap = await service.bootstrap({ params: {} })
assert.equal(bootstrap.profile.displayName, 'Komorebi')
assert.equal(bootstrap.profile.avatarUrl, '')
assert.deepEqual(bootstrap.projects, [{ projectId: 'work', name: '工作', conversationCount: 0 }])
assert.deepEqual(bootstrap.assistants[0].name, '代码助手')
assert.equal(bootstrap.assistants[0].model, '安全服务商 | m')
assert.equal(JSON.stringify(bootstrap).includes('PRIVATE'), false)
profileAvatar = 'data:image/png;base64,AA=='
const avatarBootstrap = await service.bootstrap({ params: {} })
assert.equal(avatarBootstrap.profile.avatarDataUrl, profileAvatar)
assert.match(avatarBootstrap.profile.avatarVersion, /^[A-Za-z0-9_-]{16,}$/)
normalizeAvatarDataUrl = () => 'data:image/png;base64,AA=='
profileAvatar = `data:image/png;base64,${'A'.repeat(220000)}`
const normalizedAvatarBootstrap = await service.bootstrap({ params: {} })
assert.equal(normalizedAvatarBootstrap.profile.avatarDataUrl, 'data:image/png;base64,AA==')
normalizeAvatarDataUrl = (value) => value

profileAvatar = 'data:image/svg+xml;base64,PHN2Zy8+'
assert.equal((await service.bootstrap({ params: {} })).profile.avatarDataUrl, '')

const detail = await service.assistantGet({ params: { code: 'Code' } })
assert.equal(detail.assistant.defaultProjectName, '工作')
const patched = await service.mutate({ deviceId: 'device-mobile-workspace-0001', requestId: 'request-workspace-patch-0001', params: { code: 'Code', expectedRevision: detail.assistant.revision, patch: { name: '编码助手', defaultProjectId: 'work' } } })
assert.equal(patched.assistant.name, '编码助手')
const created = await service.projectCreate({ deviceId: 'device-mobile-workspace-0001', requestId: 'request-project-create-0001', params: { name: '研究' } })
assert.equal(created.project.name, '研究')
assert.equal((await service.projectCreate({ deviceId: 'device-mobile-workspace-0001', requestId: 'request-project-create-0001', params: { name: '研究' } })).duplicate, true)
await assert.rejects(service.projectCreate({ deviceId: 'device-mobile-workspace-0001', requestId: 'request-project-forbidden', params: { name: 'x', dirPath: 'PRIVATE' } }), { code: 'remote_parameter_unknown' })
projects = {
  version: 2,
  conversations: {
    'conversation-safe-fixture': {
      conversationId: 'conversation-safe-fixture', dbFile: 'fixture.sqlite', title: 'Safe fixture', createdAt: '2026-10-17T00:00:00.000Z'
    }
  },
  projects: [{ id: 'work', name: '工作', files: [], conversationIds: ['conversation-safe-fixture'] }]
}
const renamedProject = await service.projectUpdate({ deviceId: 'device-mobile-workspace-0001', requestId: 'request-project-update-0001', params: { projectId: 'work', name: '已重命名项目' } })
assert.equal(renamedProject.project.name, '已重命名项目')
assert.deepEqual(projects.projects[0].conversationIds, ['conversation-safe-fixture'])
await assert.rejects(service.projectRemove({ deviceId: 'device-mobile-workspace-0001', requestId: 'request-project-remove-unconfirmed', params: { projectId: 'work', confirmed: false } }), { code: 'remote_project_delete_confirmation_required' })
const removedProject = await service.projectRemove({ deviceId: 'device-mobile-workspace-0001', requestId: 'request-project-remove-confirmed', params: { projectId: 'work', confirmed: true } })
assert.equal(removedProject.ungroupedConversationCount, 1)
assert.equal(projects.projects.length, 0)
assert.ok(projects.conversations['conversation-safe-fixture'])

config.tags = { 研究: ['Code'], 临时: ['Disabled'] }
config.prompts.Code = {
  name: '代码 Agent', enable: true, type: 'general', showMode: 'window', prompt: 'safe prompt', model: 'p|m', icon: '', stream: true,
  temperature: 0.35, isTemperature: true, isDirectSend_file: true, isDirectSend_normal: false, isDirectSend_image: false, ifTextNecessary: true,
  voice: '', reasoning_effort: 'high', defaultMcpServers: ['m1'], defaultSkills: ['s1'], autoSaveChat: true, autoSaveProjectId: 'work'
}
config.prompts.Disabled = { name: '停用 Agent', enable: false, type: 'over', showMode: 'fastinput', prompt: '', icon: '' }
const agentCatalog = await service.agentCatalog({ params: {} })
assert.deepEqual(agentCatalog.tags, ['临时', '研究'])
assert.equal(agentCatalog.agents[0].code, 'Code')
assert.deepEqual(agentCatalog.agents.find((agent) => agent.code === 'Code').tags, ['研究'])
const existingAgent = await service.agentGet({ params: { code: 'Code' } })
await service.agentMutate({ deviceId: 'device-mobile-workspace-0001', requestId: 'request-agent-patch-0001', params: { operation: 'patch', code: 'Code', expectedRevision: existingAgent.agent.revision, patch: { name: '已编辑 Agent', tags: ['研究'] } } })
assert.equal(config.prompts.Code.name, '已编辑 Agent')
assert.equal(config.prompts.Code.temperature, 0.35)
assert.equal(config.prompts.Code.isTemperature, true)
assert.equal(config.prompts.Code.isDirectSend_file, true)
await service.agentTagsMutate({ deviceId: 'device-mobile-workspace-0001', requestId: 'request-agent-tag-remove-0001', params: { operation: 'delete', name: '研究', confirmed: true } })
assert.equal(Object.hasOwn(config.tags, '研究'), false)
assert.ok(config.prompts.Code)
const createdAgent = await service.agentMutate({ deviceId: 'device-mobile-workspace-0001', requestId: 'request-agent-create-0001', params: { operation: 'create', code: 'mobile-agent', patch: { name: 'Mobile Agent', tags: ['临时'] } } })
assert.equal(createdAgent.agent.name, 'Mobile Agent')
assert.equal(config.prompts['mobile-agent'].temperature, 0.7)
assert.equal(config.prompts['mobile-agent'].isDirectSend_normal, true)
assert.deepEqual(config.tags.临时.sort(), ['Disabled', 'mobile-agent'])

config.providers.p = { ...config.providers.p, name: 'Provider', enable: true, modelList: ['m', 'fast', 'superior'] }
const routesCatalog = await service.agentCatalog({ params: {} })
assert.deepEqual(routesCatalog.routes, { general: '', superior: '', fast: '' })
const routesSaved = await service.agentRoutesMutate({ deviceId: 'device-mobile-workspace-0001', requestId: 'request-agent-routes-0001', params: { expectedRevision: routesCatalog.routesRevision, routes: { general: 'p|m', superior: 'p|superior', fast: 'p|fast' } } })
assert.deepEqual(routesSaved.routes, { general: 'p|m', superior: 'p|superior', fast: 'p|fast' })
assert.equal(config.defaultTaskModel, 'p|m')
assert.equal(config.defaultSuperiorModel, 'p|superior')
assert.equal(config.defaultFastModel, 'p|fast')
await assert.rejects(service.agentRoutesMutate({ deviceId: 'device-mobile-workspace-0001', requestId: 'request-agent-routes-stale-0001', params: { expectedRevision: routesCatalog.routesRevision, routes: { general: '', superior: '', fast: '' } } }), { code: 'remote_workspace_revision_conflict' })

config.providers = {
  p: { name: '安全 Provider', enable: true, url: 'https://provider.example.test/v1', api_key: 'PRIVATE_PROVIDER_KEY_1,PRIVATE_PROVIDER_KEY_2', apiType: 'chat_completions', headers: { 'X-Private': 'PRIVATE_HEADER_VALUE' }, retryCount: 3, modelList: ['model-z'], folderId: 'work-folder' },
  root: { name: '未分类 Provider', enable: false, url: '', api_key: '', headers: {}, retryCount: 2, modelList: [], folderId: '' }
}
config.providerOrder = ['p', 'root']
config.providerFolders = { 'work-folder': { name: '工作', collapsed: false } }
const providerCatalog = await service.providerCatalog({ params: {} })
assert.equal(providerCatalog.folders[0].name, '工作')
assert.deepEqual(providerCatalog.providers.map((provider) => provider.id), ['p', 'root'])
assert.equal(providerCatalog.providers[0].apiKeyCount, 2)
assert.deepEqual(providerCatalog.providers[0].headerNames, ['X-Private'])
assert.equal(JSON.stringify(providerCatalog).includes('PRIVATE_PROVIDER_KEY'), false)
assert.equal(JSON.stringify(providerCatalog).includes('PRIVATE_HEADER_VALUE'), false)
const providerDetail = await service.providerGet({ params: { id: 'p' } })
await service.providerMutate({ deviceId: 'device-mobile-workspace-0001', requestId: 'request-provider-patch-0001', params: { operation: 'patch', id: 'p', expectedRevision: providerDetail.provider.revision, patch: { name: '已编辑 Provider' } } })
assert.equal(config.providers.p.name, '已编辑 Provider')
assert.equal(config.providers.p.api_key, 'PRIVATE_PROVIDER_KEY_1,PRIVATE_PROVIDER_KEY_2')
assert.equal(config.providers.p.headers['X-Private'], 'PRIVATE_HEADER_VALUE')
const patchedProvider = await service.providerGet({ params: { id: 'p' } })
await service.providerMutate({ deviceId: 'device-mobile-workspace-0001', requestId: 'request-provider-header-0001', params: { operation: 'patch', id: 'p', expectedRevision: patchedProvider.provider.revision, patch: { headerOps: { set: { 'X-New': 'new-value' }, remove: ['X-Private'] } } } })
assert.equal(config.providers.p.headers['X-Private'], undefined)
assert.equal(config.providers.p.headers['X-New'], 'new-value')
const remoteModels = await service.providerModelsFetch({ params: { id: 'p' } })
assert.deepEqual(remoteModels.models, ['a-model', 'z-model'])
await service.providerFoldersMutate({ deviceId: 'device-mobile-workspace-0001', requestId: 'request-provider-folder-delete-0001', params: { operation: 'delete', id: 'work-folder', confirmed: true } })
assert.equal(config.providers.p.folderId, '')
assert.equal(Object.hasOwn(config.providerFolders, 'work-folder'), false)
const createdProvider = await service.providerMutate({ deviceId: 'device-mobile-workspace-0001', requestId: 'request-provider-create-0001', params: { operation: 'create', id: 'mobile-provider', patch: { name: 'Mobile Provider' } } })
assert.equal(createdProvider.provider.name, 'Mobile Provider')
assert.equal(config.providers['mobile-provider'].retryCount, 3)
assert.deepEqual(config.providers['mobile-provider'].modelList, [])

config.providers = {
  alpha: { name: 'Alpha', enable: true, folderId: 'folder-a' },
  beta: { name: 'Beta', enable: true, folderId: 'folder-a' },
  gamma: { name: 'Gamma', enable: true, folderId: '' },
  legacy: { name: 'Legacy', enable: true, folderId: 'missing-folder' }
}
config.providerFolders = { 'folder-a': { name: 'A', collapsed: false } }
config.providerOrder = ['alpha', 'beta', 'gamma', 'legacy']
await service.providerOrderMutate({ deviceId: 'device-mobile-workspace-0001', requestId: 'request-provider-order-0001', params: { folderId: 'folder-a', providerIds: ['beta', 'alpha'] } })
assert.deepEqual(config.providerOrder, ['beta', 'alpha', 'gamma', 'legacy'])
await service.providerOrderMutate({ deviceId: 'device-mobile-workspace-0001', requestId: 'request-provider-order-root-0001', params: { folderId: '', providerIds: ['legacy', 'gamma'] } })
assert.deepEqual(config.providerOrder, ['beta', 'alpha', 'legacy', 'gamma'])
await assert.rejects(service.providerOrderMutate({ deviceId: 'device-mobile-workspace-0001', requestId: 'request-provider-order-cross-folder-0001', params: { folderId: 'folder-a', providerIds: ['alpha', 'gamma'] } }), { code: 'remote_provider_order_invalid' })


config.providers = {
  p: { name: '安全 Provider', enable: true, url: 'https://provider.example.test/v1', api_key: 'PRIVATE_PROVIDER_KEY_1,PRIVATE_PROVIDER_KEY_2', apiType: 'chat_completions', headers: { 'X-Private': 'PRIVATE_HEADER_VALUE' }, retryCount: 3, modelList: ['model-z'], folderId: '' }
}
config.providerOrder = ['p']
config.providerFolders = {}


const catalog = await service.managementCatalog({ params: {} })
assert.deepEqual(catalog.sections.map((item) => item.id), ['assistants', 'providers', 'mcp', 'skills', 'tasks', 'general', 'about'])
assert.equal(JSON.stringify(catalog).includes('PRIVATE'), false)

const providers = await service.managementDetails({ params: { section: 'providers' } })
assert.equal(providers.items[0].hasApiKey, true)
assert.equal(JSON.stringify(providers).includes('PRIVATE_KEY'), false)
const mcp = await service.managementDetails({ params: { section: 'mcp' } })
assert.deepEqual(mcp.items[0].tags, ['文件', 'Research'])
assert.equal(JSON.stringify(mcp).includes('PRIVATE_COMMAND'), false)
const skills = await service.managementDetails({ params: { section: 'skills' } })
assert.equal(skills.items[0].name, 'Skill One')
assert.equal(JSON.stringify(skills).includes('PRIVATE_SKILL_PATH'), false)

assert.equal(skills.items[0].enabled, true)
await service.managementPatch({ deviceId: 'device-mobile-workspace-0001', requestId: 'request-management-skill-disable', params: { section: 'skills', id: 's1', expectedRevision: skills.items[0].revision, patch: { enabled: false } } })
assert.equal(skillEnabled, false)
const disabledSkills = await service.managementDetails({ params: { section: 'skills' } })
assert.equal(disabledSkills.items[0].enabled, false)
const generalDetails = await service.managementDetails({ params: { section: 'general' } })
assert.equal(JSON.stringify(generalDetails).includes('PRIVATE_LOCAL_PATH'), false)
const patchInput = { deviceId: 'device-mobile-workspace-0001', requestId: 'request-management-patch-0001', params: { section: 'providers', id: 'p', expectedRevision: providers.items[0].revision, patch: { name: 'New Provider', apiKey: 'NEW_SYNTHETIC_KEY' } } }
await service.managementPatch(patchInput)
assert.equal(config.providers.p.api_key, 'NEW_SYNTHETIC_KEY')
assert.equal(config.providers.p.name, 'New Provider')
assert.equal(config.webdav.localChatPath, 'PRIVATE_LOCAL_PATH')
assert.equal((await service.managementPatch(patchInput)).duplicate, true)
await assert.rejects(service.managementPatch({ ...patchInput, requestId: 'request-management-stale-0001' }), { code: 'remote_workspace_revision_conflict' })
await assert.rejects(service.managementPatch({ ...patchInput, requestId: 'request-management-command', params: { ...patchInput.params, patch: { command: 'not-allowed' } } }), { code: 'remote_parameter_unknown' })
await service.managementPatch({ deviceId: patchInput.deviceId, requestId: 'request-management-general', params: { section: 'general', expectedRevision: generalDetails.revision, patch: { displayName: 'Test' } } })
assert.equal(config.desktop.profile.nickname, 'Test')
assert.equal(config.themeMode, 'system')
await assert.rejects(
  service.managementPatch({ deviceId: patchInput.deviceId, requestId: 'request-management-general-forbidden', params: { section: 'general', expectedRevision: generalDetails.revision, patch: { themeMode: 'dark' } } }),
  { code: 'remote_parameter_unknown' }
)

console.log(JSON.stringify({ ok: true, suite: 'mobile-workspace' }))
