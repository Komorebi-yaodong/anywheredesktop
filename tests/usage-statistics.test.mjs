import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import vm from 'node:vm'
import { createUsageStore, validateUsageRecord } from '../main/core/usageStore.js'
import { normalizeUsage, observeCompletion } from '../main/core/usageRecorder.js'
import {
  aggregateUsage,
  dayKey,
  dayStart,
  shiftDay,
  usageRange,
  HOUR
} from '../main/core/usageAnalytics.js'

const now = new Date(2026, 10, 1, 12, 30).getTime()
const base = {
  id: 'one',
  startedAt: now - 1000,
  endedAt: now,
  providerId: 'p1',
  providerName: 'Old name',
  agentName: '__DEFAULT__',
  model: 'model-a',
  source: 'chat',
  status: 'success',
  usageKnown: true,
  inputTokens: 100,
  outputTokens: 20,
  cachedTokens: 40,
  totalTokens: 120
}
const captured = []
const params = {
  model: 'model-a',
  usageContext: { providerId: 'p1', providerName: 'Old name', agentName: '__DEFAULT__' },
  apiKey: 'secret-key',
  messages: [{ content: 'private prompt' }]
}
const sink = (record) => captured.push(record)
const collect = async (stream) => {
  const out = []
  for await (const item of stream) out.push(item)
  return out
}
assert.deepEqual(
  normalizeUsage({
    input_tokens: 100,
    output_tokens: 20,
    input_tokens_details: { cached_tokens: 40 }
  }),
  { inputTokens: 100, outputTokens: 20, cachedTokens: 40, totalTokens: null }
)
assert.equal(normalizeUsage({ nonsense: 1 }), null)
const response = {
  choices: [],
  usage: {
    prompt_tokens: 100,
    completion_tokens: 20,
    total_tokens: 120,
    prompt_tokens_details: { cached_tokens: 40 }
  }
}
assert.equal(await observeCompletion(async () => response, params, sink), response)
assert.equal(captured[0].totalTokens, 120)
assert.equal(captured[0].cachedTokens, 40)
assert.equal(captured[0].status, 'success')
assert.ok(!JSON.stringify(captured).includes('secret-key'))
assert.ok(!JSON.stringify(captured).includes('private prompt'))
await assert.rejects(
  observeCompletion(
    async () => {
      throw Object.assign(new Error('HTTP 429 secret-key'), { status: 429 })
    },
    params,
    sink
  )
)
assert.equal(captured.at(-1).httpStatus, 429)
assert.equal(captured.at(-1).status, 'failed')
assert.equal(captured.at(-1).usageKnown, false)
async function* chunks() {
  yield { choices: [{ delta: { content: 'hi' } }] }
  yield response
  yield response // cumulative usage must not be summed twice
}
const stream = await observeCompletion(async () => chunks(), params, sink)
const before = captured.length
assert.equal((await collect(stream)).length, 3)
assert.equal(captured.length, before + 1)
assert.equal(captured.at(-1).totalTokens, 120)
async function* partialFailure() {
  yield response
  throw new Error('socket reset')
}
await assert.rejects(
  collect(await observeCompletion(async () => partialFailure(), params, sink)),
  /reset/
)
assert.equal(captured.at(-1).status, 'failed')
assert.equal(captured.at(-1).totalTokens, 120)
for await (const chunk of await observeCompletion(async () => chunks(), params, sink)) {
  assert.ok(chunk)
  break
}
assert.equal(captured.at(-1).status, 'cancelled')
const timeoutController = new AbortController()
const timedStream = await observeCompletion(
  async () => chunks(),
  { ...params, signal: timeoutController.signal },
  sink
)
timeoutController.abort(new Error('compact_stream_idle_timeout'))
await collect(timedStream)
assert.equal(captured.at(-1).status, 'failed', 'timeouts are failures, not user cancellations')
const mutableParams = { ...params, usageContext: { ...params.usageContext } }
const snapshotted = await observeCompletion(async () => chunks(), mutableParams, sink)
mutableParams.usageContext.providerName = 'Changed during request'
await collect(snapshotted)
assert.equal(captured.at(-1).providerName, 'Old name')
const controller = new AbortController()
const aborted = await observeCompletion(
  async () => chunks(),
  { ...params, signal: controller.signal },
  sink
)
const countBeforeAbort = captured.length
controller.abort()
await collect(aborted)
assert.equal(captured.length, countBeforeAbort + 1)
assert.equal(captured.at(-1).status, 'cancelled')
for (const type of ['responses', 'codex']) {
  async function* responses() {
    yield {
      type: 'response.completed',
      response: {
        status: 'completed',
        usage: { input_tokens: 55, output_tokens: 5, input_tokens_details: { cached_tokens: 10 } }
      }
    }
  }
  await collect(
    await observeCompletion(async () => responses(), { ...params, apiType: type }, sink)
  )
  assert.equal(captured.at(-1).status, 'success')
  assert.equal(captured.at(-1).totalTokens, 60)
  async function* incomplete() {
    yield { type: 'response.incomplete', response: { status: 'incomplete' } }
  }
  await collect(
    await observeCompletion(async () => incomplete(), { ...params, apiType: type }, sink)
  )
  assert.equal(captured.at(-1).status, 'failed')
  await collect(
    await observeCompletion(
      async () => (async function* () {})(),
      { ...params, apiType: type },
      sink
    )
  )
  assert.equal(captured.at(-1).status, 'failed', 'Responses requires an explicit terminal event')
}
assert.equal(
  await observeCompletion(
    async () => 42,
    params,
    async () => {
      throw new Error('disk full')
    }
  ),
  42
)

// Exercise actual Claude adaptation, not a copied usage normalizer.
const anthropic = await fs.readFile(new URL('../main/core/anthropic.js', import.meta.url), 'utf8')
const adaptation = anthropic.slice(
  anthropic.indexOf('function mapUsage('),
  anthropic.indexOf('// Anthropic 非流式')
)
const sandbox = vm.createContext({})
vm.runInContext(
  adaptation + '\nthis.mapUsage = mapUsage; this.adapt = streamAnthropicAsOpenAI',
  sandbox
)
const mapped = sandbox.mapUsage({
  input_tokens: 10,
  output_tokens: 20,
  cache_read_input_tokens: 70,
  cache_creation_input_tokens: 20
})
assert.equal(mapped.prompt_tokens, 100)
assert.equal(mapped.total_tokens, 120)
assert.equal(mapped.prompt_tokens_details.cached_tokens, 70)
async function* claude() {
  yield {
    type: 'message_start',
    message: {
      usage: { input_tokens: 10, cache_read_input_tokens: 70, cache_creation_input_tokens: 20 }
    }
  }
  yield { type: 'message_delta', usage: { output_tokens: 20 } }
}
await collect(await observeCompletion(async () => sandbox.adapt(claude()), params, sink))
assert.equal(captured.at(-1).totalTokens, 120)
assert.equal(captured.at(-1).cachedTokens, 70)

// Journal concurrency, restart, malformed backup atomicity and interrupted append recovery.
const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'anywhere-usage-'))
try {
  const file = path.join(dir, 'statistics.jsonl')
  const store = createUsageStore(file)
  await Promise.all(
    Array.from({ length: 50 }, (_, i) =>
      store.record({ ...base, id: `r-${i}`, apiKey: 'not-stored' })
    )
  )
  assert.equal((await store.snapshot()).records.length, 50)
  await store.record({ ...base, id: 'r-1' })
  const backup = await store.snapshot()
  assert.equal((await store.import(backup)).imported, 0)
  assert.equal((await createUsageStore(file).snapshot()).records.length, 50)
  assert.ok(!(await fs.readFile(file, 'utf8')).includes('not-stored'))
  const replacement = createUsageStore(path.join(dir, 'new-computer.jsonl'))
  assert.equal((await replacement.import(backup)).imported, 50)
  assert.deepEqual(await replacement.snapshot(), backup)
  await assert.rejects(
    store.import({
      version: 1,
      records: [
        { ...base, id: 'new' },
        { ...base, endedAt: -1 }
      ]
    }),
    /invalid/
  )
  assert.equal((await store.snapshot()).records.length, 50)
  await fs.appendFile(file, '{"id": "interrupted')
  const recovered = createUsageStore(file)
  assert.equal((await recovered.snapshot()).records.length, 50)
  await recovered.record({ ...base, id: 'after-recovery' })
  assert.equal((await createUsageStore(file).snapshot()).records.length, 51)
  assert.throws(() => validateUsageRecord({ ...base, inputTokens: NaN }), /invalid/)
  assert.throws(() => validateUsageRecord({ ...base, id: '../path' }), /invalid/)
} finally {
  await fs.rm(dir, { recursive: true, force: true })
}

const records = [
  base,
  { ...base, id: 'renamed', providerName: 'New name', endedAt: now + 1 },
  {
    ...base,
    id: 'failed',
    status: 'failed',
    providerId: 'p2',
    providerName: 'New name',
    agentName: 'Code',
    model: 'b',
    endedAt: now - HOUR
  },
  { ...base, id: 'cancelled', status: 'cancelled', endedAt: now - 2 * HOUR },
  { ...base, id: 'yesterday', endedAt: dayStart(now) - 1 },
  { ...base, id: 'old', endedAt: shiftDay(dayStart(now), -60) }
]
const stats = aggregateUsage(records, { range: 'today', granularity: 'hour' }, now)
assert.equal(stats.summary.requests, 3)
assert.equal(stats.summary.succeeded, 1)
assert.equal(stats.summary.failed, 1)
assert.equal(stats.summary.cancelled, 1)
assert.equal(stats.summary.successRate, 1 / 3)
assert.equal(stats.summary.totalTokens, 360)
assert.equal(stats.summary.cacheRatio, 0.4)
assert.equal(stats.options.providers.length, 2, 'same names do not merge different provider IDs')
assert.equal(stats.options.providers.find((p) => p.id === 'p1').name, 'New name')
assert.equal(aggregateUsage(records, { range: 'today', providerId: 'p1' }, now).summary.requests, 2)
assert.equal(
  aggregateUsage(records, { range: 'today', agentName: 'Code', model: 'b' }, now).summary.requests,
  1
)
assert.equal(aggregateUsage(records, { range: 'yesterday' }, now).summary.requests, 1)
assert.equal(stats.heatmap.length, 365)
assert.equal(stats.heatmap.find((d) => d.date === dayKey(shiftDay(dayStart(now), -60))).requests, 1)
assert.equal(aggregateUsage(records, { range: '30d' }, now).trend.length, 30)
assert.equal(usageRange('24h', now).start, now - 24 * HOUR)
assert.equal(usageRange('7d', now).start, shiftDay(dayStart(now), -6))
for (const range of ['24h', 'today', 'yesterday', '7d', '30d']) {
  const zero = aggregateUsage([], { range }, now)
  for (const key of [
    'requests',
    'successRate',
    'inputTokens',
    'outputTokens',
    'cachedTokens',
    'totalTokens',
    'inputRatio',
    'outputRatio',
    'cacheRatio'
  ])
    assert.equal(zero.summary[key], 0)
  assert.ok(zero.trend.length > 0, 'empty usage still supplies regular zero-valued chart points')
  assert.ok(zero.trend.every((point) => point.requests === 0 && point.totalTokens === 0))
  assert.ok(zero.buckets.every((bucket) => bucket.requests === 0))
}
// Each request belongs to exactly one visible bucket, including partial edge hours.
for (const [range, granularity] of [
  ['24h', 'hour'],
  ['today', 'hour'],
  ['yesterday', 'hour'],
  ['7d', '4h'],
  ['30d', 'day']
]) {
  const { start, end } = usageRange(range, now)
  const timestamps = [start - 1, start, start + 1, end - 1, end]
  for (let time = start; time < end; time += 15 * 60_000) timestamps.push(time)
  const samples = timestamps.map((endedAt, index) => ({ ...base, id: `bucket-${index}`, endedAt }))
  const aggregated = aggregateUsage(samples, { range }, now)
  const included = samples.filter((record) => record.endedAt >= start && record.endedAt < end)
  assert.equal(aggregated.granularity, granularity)
  assert.equal(
    aggregated.trend.reduce((sum, bucket) => sum + bucket.requests, 0),
    included.length
  )
  assert.equal(aggregated.summary.requests, included.length)
  assert.deepEqual(aggregated.trend, aggregated.buckets)
  assert.equal(aggregated.trend[0].periodStart, start)
  assert.equal(aggregated.trend.at(-1).periodEnd, end)
  if (range === '24h')
    assert.equal(aggregated.trend.length, 25, '24 hours can include two partial edge buckets')
  if (range === 'yesterday') assert.equal(aggregated.trend.length, 24)
  if (range === '7d') assert.equal(aggregated.trend.length, 40)
  if (range === '30d') assert.equal(aggregated.trend.length, 30)
}

// Real DST calendar boundaries: repeated hours remain separate, spring gaps add no fake hour.
const savedTimezone = process.env.TZ
try {
  process.env.TZ = 'America/New_York'
  for (const [month, date, expectedHours] of [
    [2, 9, 23],
    [10, 2, 25]
  ]) {
    const nextDay = new Date(2025, month, date + 1, 12).getTime()
    const interval = usageRange('yesterday', nextDay)
    const samples = []
    for (let timestamp = interval.start; timestamp < interval.end; timestamp += 15 * 60_000) {
      samples.push({ ...base, id: `dst-${timestamp}`, endedAt: timestamp })
    }
    const stats = aggregateUsage(samples, { range: 'yesterday' }, nextDay)
    assert.equal(stats.trend.length, expectedHours)
    assert.equal(
      stats.trend.reduce((sum, bucket) => sum + bucket.requests, 0),
      samples.length
    )
    const week = aggregateUsage(samples, { range: '7d' }, nextDay)
    assert.equal(
      week.trend.reduce((sum, bucket) => sum + bucket.requests, 0),
      samples.length
    )
    assert.equal(week.heatmap.length, 365)
  }
} finally {
  if (savedTimezone === undefined) delete process.env.TZ
  else process.env.TZ = savedTimezone
}

console.log(
  'Usage statistics: recorder, protocols, persistence, migration, filtering and calendar boundaries passed'
)
