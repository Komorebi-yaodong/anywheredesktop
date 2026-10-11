import assert from 'node:assert/strict'
import { createRemoteBusinessConfigService } from '../main/core/remote/businessConfig.js'

const DEVICE = 'device-business-config-0001'
let config = {
  language: 'zh',
  themeMode: 'system',
  remote: { enabled: true, host: '0.0.0.0', port: 17860, publicEndpoint: '' },
  skillPath: 'E:/PRIVATE_SKILLS',
  webdav: {
    url: 'https://dav.example.test', username: 'fixture-user', password: 'WEBDAV_SECRET',
    path: '/anywhere', data_path: '/anywhere_data', localChatPath: 'E:/PRIVATE_CHATS'
  },
  providers: {
    p1: { name: 'Provider', url: 'https://api.example.test', api_key: 'PROVIDER_SECRET', headers: { Authorization: 'HEADER_SECRET' }, modelList: ['m1'] }
  },
  prompts: { AI: { prompt: 'System', model: 'p1|m1' } },
  mcpServers: { m1: { name: 'MCP', command: 'fixture', env: { TOKEN: 'MCP_SECRET' }, headers: { Authorization: 'MCP_HEADER' } } },
  tasks: { t1: { title: 'Task', prompt: 'Do it' } }
}
let failNextSave = false
const writes = []
const service = createRemoteBusinessConfigService({
  getConfig: async () => ({ config: structuredClone(config) }),
  updateConfig: async ({ config: next }) => {
    writes.push(structuredClone(next))
    if (failNextSave) { failNextSave = false; return { success: false } }
    config = structuredClone(next)
    return { success: true, config: structuredClone(config) }
  }
})

const manifest = await service.get({ params: {} })
assert.deepEqual(manifest.sections.map((item) => item.name), ['general', 'providers', 'prompts', 'mcpServers', 'tasks'])
assert.ok(manifest.sections.every((item) => /^[A-Za-z0-9_-]{43}$/.test(item.revision)))

const general = await service.get({ params: { section: 'general' } })
assert.equal(general.value.webdav.password, 'WEBDAV_SECRET')
assert.equal(Object.hasOwn(general.value, 'remote'), false)
assert.equal(Object.hasOwn(general.value, 'skillPath'), false)
assert.equal(Object.hasOwn(general.value.webdav, 'localChatPath'), false)
assert.equal(JSON.stringify(general).includes('PRIVATE_CHATS'), false)
assert.equal(JSON.stringify(general).includes('PRIVATE_SKILLS'), false)

const providers = await service.get({ params: { section: 'providers' } })
assert.equal(providers.value.p1.api_key, 'PROVIDER_SECRET')
assert.equal(providers.value.p1.headers.Authorization, 'HEADER_SECRET')
const mcp = await service.get({ params: { section: 'mcpServers' } })
assert.equal(mcp.value.m1.env.TOKEN, 'MCP_SECRET')
assert.equal(mcp.value.m1.headers.Authorization, 'MCP_HEADER')

const providerReplacement = {
  p2: { name: 'New Provider', url: 'https://new.example.test', api_key: 'NEW_SECRET', headers: {}, modelList: ['new-model'] }
}
const replaced = await service.replace({
  deviceId: DEVICE,
  requestId: 'request-business-replace-0001',
  params: { section: 'providers', expectedRevision: providers.revision, value: providerReplacement }
})
assert.equal(replaced.value.p2.api_key, 'NEW_SECRET')
assert.deepEqual(config.providers, providerReplacement)
assert.equal(config.remote.port, 17860)
assert.equal(config.skillPath, 'E:/PRIVATE_SKILLS')
assert.equal(config.webdav.localChatPath, 'E:/PRIVATE_CHATS')
assert.equal((await service.replace({
  deviceId: DEVICE,
  requestId: 'request-business-replace-0001',
  params: { section: 'providers', expectedRevision: providers.revision, value: providerReplacement }
})).duplicate, true)
await assert.rejects(service.replace({
  deviceId: DEVICE,
  requestId: 'request-business-replace-0001',
  params: { section: 'providers', expectedRevision: providers.revision, value: { changed: {} } }
}), { code: 'remote_request_id_conflict' })
await assert.rejects(service.replace({
  deviceId: DEVICE,
  requestId: 'request-business-stale-0001',
  params: { section: 'providers', expectedRevision: providers.revision, value: providerReplacement }
}), { code: 'remote_business_config_revision_conflict' })

await assert.rejects(service.replace({
  deviceId: DEVICE,
  requestId: 'request-business-local-0001',
  params: { section: 'general', expectedRevision: general.revision, value: { remote: { enabled: false } } }
}), { code: 'remote_business_config_local_field_forbidden' })
await assert.rejects(service.replace({
  deviceId: DEVICE,
  requestId: 'request-business-path-0001',
  params: { section: 'general', expectedRevision: general.revision, value: { webdav: { localChatPath: 'C:/ATTACK' } } }
}), { code: 'remote_business_config_local_field_forbidden' })

const prompts = await service.get({ params: { section: 'prompts' } })
const beforeFailure = structuredClone(config)
failNextSave = true
await assert.rejects(service.replace({
  deviceId: DEVICE,
  requestId: 'request-business-failure-0001',
  params: { section: 'prompts', expectedRevision: prompts.revision, value: { AI: { prompt: 'Changed' } } }
}), { code: 'remote_business_config_save_failed' })
assert.deepEqual(config, beforeFailure)
assert.ok(writes.length >= 3, 'failed saves attempt a rollback through the existing config writer')

const polluted = JSON.parse('{"__proto__":{"polluted":true}}')
await assert.rejects(service.replace({
  deviceId: DEVICE,
  requestId: 'request-business-pollution',
  params: { section: 'tasks', expectedRevision: (await service.get({ params: { section: 'tasks' } })).revision, value: polluted }
}), { code: 'remote_business_config_invalid' })
await assert.rejects(service.replace({
  deviceId: DEVICE,
  requestId: 'request-business-large-0001',
  params: { section: 'tasks', expectedRevision: (await service.get({ params: { section: 'tasks' } })).revision, value: { huge: 'x'.repeat(177 * 1024) } }
}), { code: 'remote_business_config_too_large' })

console.log(JSON.stringify({ ok: true, suite: 'remote-business-config' }))
