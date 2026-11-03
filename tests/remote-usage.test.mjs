import assert from 'node:assert/strict'
import { aggregateUsage } from '../main/core/usageAnalytics.js'
import { createRemoteUsageService } from '../main/core/remote/usage.js'
const now = Date.now()
const record = {
  providerId: 'p1',
  providerName: 'Snapshot',
  agentName: 'Agent',
  model: 'model',
  endedAt: now - 1000,
  status: 'success',
  usageKnown: true,
  inputTokens: 20,
  outputTokens: 10,
  cachedTokens: 5,
  totalTokens: 30,
  secret: 'never-send',
  url: 'private'
}
let reads = 0
const service = createRemoteUsageService({
  query: async (filters) => {
    reads++
    return { ...aggregateUsage([record], filters, now), records: [record], apiKey: 'never-send' }
  },
  getConfig: async () => ({
    config: { providers: { p1: { name: 'Current', api_key: 'never-send' } } }
  })
})
const result = await service.get({ params: { range: '24h' } })
assert.equal(result.summary.requests, 1)
assert.equal(result.summary.totalTokens, 30)
assert.equal(result.options.providers[0].name, 'Current')
assert.equal(result.heatmap.length, 365)
assert.equal(result.buckets.length, 25)
assert.equal(JSON.stringify(result).includes('never-send'), false)
assert.equal('records' in result, false)
for (const params of [
  { range: 'all' },
  { path: 'x' },
  { model: [] },
  { agentName: 'a'.repeat(513) },
  { providerId: '\n' },
  []
])
  await assert.rejects(service.get({ params }), (error) =>
    error.code.startsWith('remote_parameter')
  )
assert.equal(reads, 1)
for (const range of ['24h', 'today', 'yesterday', '7d', '30d']) {
  const full = aggregateUsage([record], { range }, now)
  const projected = await service.get({ params: { range } })
  assert.equal(projected.buckets.length, full.buckets.length)
}

assert.equal((await service.get({ params: { model: 'other' } })).summary.requests, 0)
const many = aggregateUsage([], { range: '7d' }, now)
many.options = {
  providers: Array.from({ length: 1000 }, (_, i) => ({
    id: `p${i}`,
    name: '合成服务商'.repeat(80)
  })),
  agents: Array.from({ length: 1000 }, (_, i) => `agent-${i}`),
  models: Array.from({ length: 1000 }, (_, i) => `model-${i}`)
}
const bounded = await createRemoteUsageService({ query: async () => many }).get({
  params: { providerId: 'p999', agentName: 'agent-999', model: 'model-999' }
})
assert.equal(bounded.options.providers[0].id, 'p999')
assert.equal(bounded.options.agents[0], 'agent-999')
assert.equal(bounded.options.models[0], 'model-999')
for (const options of Object.values(bounded.options)) {
  assert.ok(options.length <= 200)
  assert.ok(Buffer.byteLength(JSON.stringify(options)) < 8300)
}
assert.ok(Buffer.byteLength(JSON.stringify(bounded)) <= 96 * 1024)

console.log(
  JSON.stringify({ ok: true, suite: 'remote-usage', aggregateOnly: true, validatedFilters: true })
)
