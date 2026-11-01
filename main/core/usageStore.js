import fs from 'node:fs/promises'
import { createReadStream } from 'node:fs'
import { createInterface } from 'node:readline'
import path from 'node:path'
import { aggregateUsage } from './usageAnalytics.js'

const text = (value, max = 512) => (typeof value === 'string' ? value.trim().slice(0, max) : '')
const count = (value) => Number.isSafeInteger(value) && value >= 0

export function validateUsageRecord(value) {
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    !/^[\w-]{1,128}$/.test(value.id || '') ||
    !count(value.startedAt) ||
    !count(value.endedAt) ||
    value.startedAt > value.endedAt ||
    value.endedAt > 8_640_000_000_000_000 ||
    !['success', 'failed', 'cancelled'].includes(value.status) ||
    !['inputTokens', 'outputTokens', 'cachedTokens', 'totalTokens'].every((key) =>
      count(value[key])
    )
  ) {
    throw new Error('invalid_usage_record')
  }
  return {
    id: value.id,
    startedAt: value.startedAt,
    endedAt: value.endedAt,
    providerId: text(value.providerId),
    providerName: text(value.providerName),
    agentName: text(value.agentName) || '__DEFAULT__',
    model: text(value.model),
    source: text(value.source, 64),
    status: value.status,
    httpStatus:
      Number.isInteger(value.httpStatus) && value.httpStatus >= 100 && value.httpStatus <= 599
        ? value.httpStatus
        : null,
    usageKnown: value.usageKnown === true,
    inputTokens: value.inputTokens,
    outputTokens: value.outputTokens,
    cachedTokens: Math.min(value.cachedTokens, value.inputTokens),
    totalTokens: Math.max(value.totalTokens, value.inputTokens + value.outputTokens)
  }
}

// Only Main creates this store. A serialized append-only journal keeps config/chat writes independent.
export function createUsageStore(filePath) {
  let records = null
  let queue = Promise.resolve()
  const run = (operation) => {
    const next = queue.then(operation)
    queue = next.catch(() => {})
    return next
  }
  const load = async () => {
    if (records) return
    const next = new Map()
    try {
      const reader = createInterface({
        input: createReadStream(filePath, { encoding: 'utf8' }),
        crlfDelay: Infinity
      })
      let pending = null
      for await (const line of reader) {
        if (!line.trim()) continue
        if (line === '{"type":"usage-recovery"}') {
          pending = null
          continue
        }
        if (pending !== null) throw new Error('usage_journal_corrupt')
        try {
          const record = validateUsageRecord(JSON.parse(line))
          next.set(record.id, record)
        } catch {
          pending = line
        }
      }
      // A process crash may leave only the final append incomplete. Keep earlier durable records.
      if (pending !== null) console.warn('[Usage] Ignoring an incomplete journal tail.')
    } catch (error) {
      if (error.code !== 'ENOENT') throw error
    }
    records = next
  }
  const append = async (incoming) => {
    const fresh = incoming.filter((record) => !records.has(record.id))
    if (!fresh.length) return { ok: true, imported: 0 }
    await fs.mkdir(path.dirname(filePath), { recursive: true })
    const handle = await fs.open(filePath, 'a')
    try {
      // Leading newline isolates any incomplete tail left by a prior crash.
      await handle.writeFile(
        '\n{"type":"usage-recovery"}\n' +
          fresh.map((record) => JSON.stringify(record)).join('\n') +
          '\n',
        'utf8'
      )
      await handle.sync()
    } finally {
      await handle.close()
    }
    for (const record of fresh) records.set(record.id, record)
    return { ok: true, imported: fresh.length }
  }
  return {
    record: (input) =>
      run(async () => {
        const record = validateUsageRecord(input)
        await load()
        return append([record])
      }),
    query: (filters = {}, now = Date.now()) =>
      run(async () => {
        await load()
        return aggregateUsage(records.values(), filters, now)
      }),

    snapshot: () =>
      run(async () => {
        await load()
        return { version: 1, records: Array.from(records.values(), (record) => ({ ...record })) }
      }),
    import: (input) =>
      run(async () => {
        if (input?.version !== 1 || !Array.isArray(input.records))
          throw new Error('invalid_usage_backup')
        // Validate everything before writing; whitelist removes arbitrary config/credential fields.
        const incoming = Array.from(
          new Map(
            input.records.map((item) => {
              const record = validateUsageRecord(item)
              return [record.id, record]
            })
          ).values()
        )
        await load()
        return append(incoming)
      })
  }
}
