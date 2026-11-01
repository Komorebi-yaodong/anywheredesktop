export const HOUR = 3_600_000
export const dayStart = (value) => new Date(value).setHours(0, 0, 0, 0)
export function shiftDay(value, days) {
  const date = new Date(value)
  date.setDate(date.getDate() + days)
  return date.getTime()
}
export function dayKey(value) {
  const date = new Date(value)
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`
}
export function usageRange(range, now = Date.now()) {
  const today = dayStart(now)
  if (range === '24h') return { start: now - 24 * HOUR, end: now + 1 }
  if (range === 'yesterday') return { start: shiftDay(today, -1), end: today }
  const days = range === '7d' ? 7 : range === '30d' ? 30 : 1
  return { start: shiftDay(today, 1 - days), end: now + 1 }
}
export function usageGranularity(range) {
  if (range === '30d') return 'day'
  if (range === '7d') return '4h'
  return 'hour'
}

function bucketBoundary(timestamp, granularity) {
  const date = new Date(timestamp)
  if (granularity === 'day') return dayStart(timestamp)
  if (granularity === '4h') return date.setHours(Math.floor(date.getHours() / 4) * 4, 0, 0, 0)
  // Subtract wall-clock minutes instead of setHours: keep repeated DST hours distinct.
  return timestamp - date.getMinutes() * 60_000 - date.getSeconds() * 1000 - date.getMilliseconds()
}
function nextBoundary(timestamp, granularity) {
  if (granularity === 'day') return shiftDay(timestamp, 1)
  if (granularity === 'hour') return timestamp + HOUR
  const date = new Date(timestamp)
  return date.setHours(date.getHours() + 4, 0, 0, 0)
}

const empty = () => ({
  requests: 0,
  succeeded: 0,
  failed: 0,
  cancelled: 0,
  usageReported: 0,
  inputTokens: 0,
  outputTokens: 0,
  cachedTokens: 0,
  totalTokens: 0
})
function add(target, record) {
  target.requests++
  if (record.status === 'success') target.succeeded++
  else if (record.status === 'cancelled') target.cancelled++
  else target.failed++
  if (record.usageKnown) target.usageReported++
  for (const key of ['inputTokens', 'outputTokens', 'cachedTokens', 'totalTokens'])
    target[key] += record[key]
}
function rates(value) {
  return {
    ...value,
    successRate: value.requests ? value.succeeded / value.requests : 0,
    inputRatio: value.totalTokens ? value.inputTokens / value.totalTokens : 0,
    outputRatio: value.totalTokens ? value.outputTokens / value.totalTokens : 0,
    cacheRatio: value.inputTokens ? value.cachedTokens / value.inputTokens : 0
  }
}

// All boundaries are evaluated in the current machine's local timezone, including DST days.
export function aggregateUsage(records, filters = {}, now = Date.now()) {
  const rangeKey = ['24h', 'today', 'yesterday', '7d', '30d'].includes(filters.range)
    ? filters.range
    : '30d'
  const range = usageRange(rangeKey, now)
  const granularity = usageGranularity(rangeKey)
  const today = dayStart(now)
  const heatStart = shiftDay(today, -364)
  const buckets = new Map()
  const heatmap = new Map()
  const providers = new Map()
  const agents = new Set()
  const models = new Set()
  const summary = empty()
  const bucketStart = (timestamp) => bucketBoundary(timestamp, granularity)
  for (
    let time = bucketStart(range.start);
    time < range.end;
    time = nextBoundary(time, granularity)
  ) {
    buckets.set(time, {
      timestamp: time,
      periodStart: Math.max(time, range.start),
      periodEnd: Math.min(nextBoundary(time, granularity), range.end),
      ...empty()
    })
  }
  for (let time = heatStart; time <= today; time = shiftDay(time, 1))
    heatmap.set(dayKey(time), { date: dayKey(time), timestamp: time, ...empty() })
  for (const record of records) {
    const previous = providers.get(record.providerId)
    if (!previous || previous.lastSeen <= record.endedAt) {
      providers.set(record.providerId, {
        id: record.providerId,
        name: record.providerName,
        lastSeen: record.endedAt
      })
    }
    agents.add(record.agentName)
    models.add(record.model)
    if (
      (filters.providerId && record.providerId !== filters.providerId) ||
      (filters.agentName && record.agentName !== filters.agentName) ||
      (filters.model && record.model !== filters.model)
    )
      continue
    const heat = heatmap.get(dayKey(record.endedAt))
    if (heat && record.endedAt <= now) add(heat, record)
    if (record.endedAt < range.start || record.endedAt >= range.end) continue
    add(summary, record)
    const bucket = buckets.get(bucketStart(record.endedAt))
    if (bucket) add(bucket, record)
  }
  return {
    range,
    granularity,
    summary: rates(summary),
    buckets: Array.from(buckets.values(), rates),
    trend: Array.from(buckets.values(), rates),
    heatmap: Array.from(heatmap.values()),
    options: {
      providers: Array.from(providers.values()),
      agents: [...agents].sort(),
      models: [...models].sort()
    }
  }
}
