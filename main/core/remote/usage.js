import { remoteError } from './protocol.js'

const counters = [
  'requests',
  'succeeded',
  'failed',
  'cancelled',
  'usageReported',
  'inputTokens',
  'outputTokens',
  'cachedTokens',
  'totalTokens'
]
const ratios = ['successRate', 'inputRatio', 'outputRatio', 'cacheRatio']
const label = (value) => (typeof value === 'string' ? value.slice(0, 512) : '')
const number = (value) =>
  typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : 0
const metrics = (value) =>
  Object.fromEntries([...counters, ...ratios].map((key) => [key, number(value?.[key])]))

/** Aggregate-only projection. Never exposes the Main journal or arbitrary config. */
export function createRemoteUsageService({ query, getConfig = async () => ({}) }) {
  return {
    async get({ params = {} } = {}) {
      if (
        !params ||
        typeof params !== 'object' ||
        Array.isArray(params) ||
        Object.keys(params).some(
          (key) => !['range', 'providerId', 'agentName', 'model'].includes(key)
        )
      )
        throw remoteError('remote_parameter_unknown')
      const range = params.range ?? '24h'
      if (!['24h', 'today', 'yesterday', '7d', '30d'].includes(range))
        throw remoteError('remote_parameter_invalid')
      for (const key of ['providerId', 'agentName', 'model']) {
        if (
          params[key] !== undefined &&
          (typeof params[key] !== 'string' ||
            params[key].length > 512 ||
            [...params[key]].some((character) => character.charCodeAt(0) < 32))
        )
          throw remoteError('remote_parameter_invalid')
      }
      const filters = {
        range,
        providerId: params.providerId || '',
        agentName: params.agentName || '',
        model: params.model || ''
      }
      const result = await query(filters)
      const config = await getConfig()
      const bounded = (items, selected, identity) => {
        let budget = 8 * 1024
        const sorted = [...items].sort(
          (a, b) => Number(identity(b) === selected) - Number(identity(a) === selected)
        )
        let count = 0
        return sorted.filter((item) => {
          const size = Buffer.byteLength(JSON.stringify(item))
          if (count >= 200 || size > budget) return false
          budget -= size
          count++
          return true
        })
      }
      const providers = (result.options?.providers || []).map((item) => ({
        id: label(item.id),
        name: label(config?.config?.providers?.[item.id]?.name) || label(item.name)
      }))
      const value = {
        schemaVersion: '1.0',
        generatedAt: Date.now(),
        timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
        range: { start: number(result.range?.start), end: number(result.range?.end) },
        granularity: result.granularity,
        summary: metrics(result.summary),
        buckets: (result.buckets || []).slice(0, 64).map((item) => ({
          timestamp: number(item.timestamp),
          periodStart: number(item.periodStart),
          periodEnd: number(item.periodEnd),
          ...metrics(item)
        })),
        heatmap: (result.heatmap || []).slice(0, 366).map((item) => ({
          date: label(item.date),
          timestamp: number(item.timestamp),
          requests: number(item.requests)
        })),
        options: {
          providers: bounded(providers, filters.providerId, (item) => item.id),
          agents: bounded(
            (result.options?.agents || []).map(label),
            filters.agentName,
            (item) => item
          ),
          models: bounded((result.options?.models || []).map(label), filters.model, (item) => item)
        }
      }
      if (Buffer.byteLength(JSON.stringify(value)) > 96 * 1024)
        throw remoteError('remote_result_too_large')
      return value
    }
  }
}
