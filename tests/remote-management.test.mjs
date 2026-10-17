import assert from 'node:assert/strict'
import { createRemoteManagementService } from '../main/core/remote/management.js'
const DEVICE = 'device-management-fixture-0001'
let config = {
  providers: {},
  prompts: {},
  mcpServers: {
    local: {
      name: 'Local',
      transport: 'stdio',
      command: 'PRIVATE_COMMAND',
      env: { TOKEN: 'PRIVATE_TOKEN' }
    }
  },
  tasks: {},
  desktop: { profile: { nickname: 'Test' } },
  skillPath: 'fixture-root'
}
const skillMap = new Map()
const service = createRemoteManagementService({
  getConfig: async () => ({ config: structuredClone(config) }),
  updateConfig: async ({ config: next }) => {
    config = structuredClone(next)
    return { success: true }
  },
  readProjects: async () => ({ projects: [] }),
  skills: {
    list: async () => [...skillMap].map(([id, s]) => ({ id, ...s })),
    get: async (_root, id) => skillMap.get(id) || null,
    save: async (_root, id, v) => skillMap.set(id, v),
    remove: async (_root, id) => skillMap.delete(id)
  },
  getTaskDevice: () => ({ machineCode: 'PRIVATE_MACHINE', deviceName: 'fixture' }),
  setTaskEnabled: (task, enabled, device) => {
    task.enabled = enabled
    task.appliedDevices = enabled ? [device] : []
  }
})
let sequence = 0
const mutate = (params) =>
  service.mutate({ deviceId: DEVICE, requestId: `request-management-${++sequence}`, params })
for (const section of ['assistants', 'providers', 'mcp', 'skills', 'tasks']) {
  const patch =
    section === 'skills'
      ? { name: 'Skill', content: 'Instructions', enabled: true }
      : section === 'tasks'
        ? {
            name: 'Task',
            triggerType: 'weekly',
            weeklyDays: [1, 3],
            weeklyTime: '09:00',
            enabled: true
          }
        : section === 'providers'
          ? {
              name: 'Provider',
              api_key: 'PRIVATE_KEY',
              headers: { Authorization: 'PRIVATE_HEADER' }
            }
          : { name: 'Entry' }
  await mutate({ section, id: 'fixture-id', operation: 'create', patch })
  const detail = await service.catalog({ params: { section, id: 'fixture-id' } })
  assert.ok(detail.revision)
  assert.equal(JSON.stringify(detail).includes('PRIVATE_'), false)
  await mutate({
    section,
    id: 'fixture-id',
    operation: 'patch',
    expectedRevision: detail.revision,
    patch: { name: 'Changed' }
  })
  await assert.rejects(
    mutate({ section, id: 'fixture-id', operation: 'delete', expectedRevision: detail.revision }),
    { code: 'remote_confirmation_required' }
  )
  const next = await service.catalog({ params: { section, id: 'fixture-id' } })
  await mutate({
    section,
    id: 'fixture-id',
    operation: 'delete',
    expectedRevision: next.revision,
    confirmed: true
  })
  await assert.rejects(service.catalog({ params: { section, id: 'fixture-id' } }), {
    code: 'remote_workspace_item_not_found'
  })
}
const local = await service.catalog({ params: { section: 'mcp', id: 'local' } })
assert.equal(local.localOnly, true)
assert.deepEqual(
  local.schema.map((f) => f.key),
  ['name', 'isActive']
)
await assert.rejects(
  mutate({
    section: 'mcp',
    id: 'local',
    operation: 'patch',
    expectedRevision: local.revision,
    patch: { url: 'https://example.test' }
  }),
  { code: 'remote_management_local_only' }
)
await assert.rejects(
  mutate({ section: 'skills', id: '../escape', operation: 'create', patch: { name: 'bad' } }),
  { code: 'remote_identifier_invalid' }
)
await assert.rejects(
  mutate({ section: 'tasks', id: 'bad-time', operation: 'create', patch: { weeklyTime: '99:99' } }),
  { code: 'remote_management_invalid' }
)
console.log(JSON.stringify({ ok: true, suite: 'remote-management' }))
