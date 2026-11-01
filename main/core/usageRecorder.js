import { randomUUID } from 'node:crypto'

let recordSink = null

// Main owns the journal. Preload installs an IPC sink instead of opening storage.
export function setUsageRecordSink(sink) {
  recordSink = sink
}

const token = (value) =>
  typeof value === 'number' && Number.isFinite(value) && value >= 0
    ? Math.min(Number.MAX_SAFE_INTEGER, Math.floor(value))
    : null

export function normalizeUsage(usage) {
  if (!usage || typeof usage !== 'object') return null
  const inputTokens = token(usage.prompt_tokens ?? usage.input_tokens)
  const outputTokens = token(usage.completion_tokens ?? usage.output_tokens)
  const cachedTokens = token(
    usage.prompt_tokens_details?.cached_tokens ??
      usage.input_tokens_details?.cached_tokens ??
      usage.cache_read_input_tokens ??
      usage.prompt_cache_hit_tokens
  )
  const totalTokens = token(usage.total_tokens)
  if ([inputTokens, outputTokens, cachedTokens, totalTokens].every((value) => value === null))
    return null
  return { inputTokens, outputTokens, cachedTokens, totalTokens }
}

// One logical SDK call (including its internal retries), not one chat turn or HTTP attempt.
export async function observeCompletion(request, params = {}, sink = recordSink) {
  if (typeof sink !== 'function') return request()
  const context = { ...params.usageContext }
  const model = params.model || ''
  const interruptedStatus = () =>
    /timeout|timedout/i.test(
      String(params.signal?.reason?.message || params.signal?.reason?.name || '')
    )
      ? 'failed'
      : 'cancelled'
  const startedAt = Date.now()
  const id = randomUUID()
  const usage = { inputTokens: 0, outputTokens: 0, cachedTokens: 0, totalTokens: 0 }
  let usageKnown = false
  let terminalStatus = null
  let httpStatus = null
  let finalization = null
  const capture = (item) => {
    const normalized = normalizeUsage(item?.usage ?? item?.response?.usage)
    if (normalized) {
      usageKnown = true
      for (const [key, value] of Object.entries(normalized)) {
        if (value !== null) usage[key] = value
      }
    }
    const status = item?.response?.status ?? item?.status
    if (
      item?.type === 'error' ||
      item?.error ||
      item?.type === 'response.failed' ||
      item?.type === 'response.incomplete' ||
      status === 'failed' ||
      status === 'incomplete'
    ) {
      terminalStatus = 'failed'
    } else if (item?.type === 'response.completed' || status === 'completed') {
      terminalStatus ||= 'success'
    }
  }
  const finalize = (status) => {
    if (finalization) return finalization
    params.signal?.removeEventListener('abort', onAbort)
    const record = {
      id,
      startedAt,
      endedAt: Date.now(),
      providerId: context.providerId || '',
      providerName: context.providerName || '',
      agentName: context.agentName || '__DEFAULT__',
      model,
      source: context.source || 'chat',
      status,
      httpStatus,
      usageKnown,
      ...usage,
      totalTokens: Math.max(usage.totalTokens, usage.inputTokens + usage.outputTokens)
    }
    // A journal error must not turn a completed model request into a retry/duplicate charge.
    finalization = Promise.resolve()
      .then(() => sink(record))
      .then((result) => {
        if (result?.ok === false) throw new Error('usage_record_write_failed')
      })
      .catch(() => console.error('[Usage] Failed to persist request statistics.'))
    return finalization
  }
  const onAbort = () => {
    void finalize(terminalStatus || interruptedStatus())
  }
  params.signal?.addEventListener('abort', onAbort, { once: true })
  try {
    if (params.signal?.aborted) onAbort()
    const response = await request()
    if (response && typeof response[Symbol.asyncIterator] === 'function') {
      return (async function* () {
        let exhausted = false
        try {
          for await (const item of response) {
            capture(item)
            yield item
          }
          exhausted = true
        } catch (error) {
          httpStatus = token(error?.status)
          await finalize(
            params.signal?.aborted || /AbortError|APIUserAbortError/.test(error?.name || '')
              ? interruptedStatus()
              : 'failed'
          )
          throw error
        } finally {
          const expectsTerminal = params.apiType === 'responses' || params.apiType === 'codex'
          await finalize(
            terminalStatus ||
              (params.signal?.aborted || !exhausted
                ? interruptedStatus()
                : expectsTerminal
                  ? 'failed'
                  : 'success')
          )
        }
      })()
    }
    capture(response)
    await finalize(terminalStatus || (params.signal?.aborted ? interruptedStatus() : 'success'))
    return response
  } catch (error) {
    httpStatus = token(error?.status)
    await finalize(
      params.signal?.aborted || /AbortError|APIUserAbortError/.test(error?.name || '')
        ? interruptedStatus()
        : 'failed'
    )
    throw error
  }
}
