import assert from 'node:assert/strict'
import {
  MAX_AUTOMATIC_NETWORK_RETRIES,
  createNetworkRetryingStream,
  getNetworkRetryDelayMs,
  isRetryableNetworkError,
  runWithNetworkRetries,
  waitForNetworkRetryDelay
} from '../render/window/utils/conversationNetworkRetry.js'

const networkError = () => new Error('network error')
const collect = async (stream) => {
  const chunks = []
  for await (const chunk of stream) chunks.push(chunk)
  return chunks
}

assert.equal(MAX_AUTOMATIC_NETWORK_RETRIES, 3)
assert.deepEqual([1, 2, 3].map(getNetworkRetryDelayMs), [1000, 2000, 4000])
assert.equal(isRetryableNetworkError(networkError()), true)
assert.equal(isRetryableNetworkError(new Error('HTTP 401 unauthorized')), false)
assert.equal(isRetryableNetworkError(Object.assign(new Error('The operation was aborted.'), { name: 'AbortError' })), false)

let requestAttempts = 0
const retryNotices = []
const retryDelays = []
const result = await runWithNetworkRetries(async () => {
  requestAttempts += 1
  if (requestAttempts <= 3) throw networkError()
  return 'ok'
}, {
  maxRetries: MAX_AUTOMATIC_NETWORK_RETRIES,
  onRetry: ({ retryAttempt, maxRetries, delayMs }) => retryNotices.push({ retryAttempt, maxRetries, delayMs }),
  wait: async (delayMs) => { retryDelays.push(delayMs) }
})
assert.equal(result, 'ok')
assert.equal(requestAttempts, 4, 'first request plus three extra retries')
assert.deepEqual(retryNotices, [
  { retryAttempt: 1, maxRetries: 3, delayMs: 1000 },
  { retryAttempt: 2, maxRetries: 3, delayMs: 2000 },
  { retryAttempt: 3, maxRetries: 3, delayMs: 4000 }
])
assert.deepEqual(retryDelays, [1000, 2000, 4000])

let terminalAttempts = 0
await assert.rejects(
  runWithNetworkRetries(async () => {
    terminalAttempts += 1
    throw new Error('HTTP 400 invalid_request_error')
  }, { maxRetries: MAX_AUTOMATIC_NETWORK_RETRIES, wait: async () => assert.fail('4xx must not retry') }),
  /400/
)
assert.equal(terminalAttempts, 1)

const abortController = new AbortController()
const delayed = waitForNetworkRetryDelay(10_000, abortController.signal)
abortController.abort()
await assert.rejects(delayed, /aborted/i)

let streamAttempts = 0
async function* failBeforeOutput() {
  throw networkError()
}
async function* succeedAfterRetry() {
  yield { type: 'response.output_text.delta', delta: 'recovered' }
}
const recoveredChunks = await collect(createNetworkRetryingStream(() => {
  streamAttempts += 1
  return streamAttempts === 1 ? failBeforeOutput() : succeedAfterRetry()
}, {
  maxRetries: MAX_AUTOMATIC_NETWORK_RETRIES,
  isMeaningfulChunk: (chunk) => Boolean(chunk?.delta),
  wait: async () => {}
}))
assert.equal(streamAttempts, 2)
assert.deepEqual(recoveredChunks, [{ type: 'response.output_text.delta', delta: 'recovered' }])

let partialStreamAttempts = 0
async function* failAfterOutput() {
  yield { type: 'response.output_text.delta', delta: 'partial' }
  throw networkError()
}
await assert.rejects(
  collect(createNetworkRetryingStream(() => {
    partialStreamAttempts += 1
    return failAfterOutput()
  }, {
    maxRetries: MAX_AUTOMATIC_NETWORK_RETRIES,
    isMeaningfulChunk: (chunk) => Boolean(chunk?.delta),
    wait: async () => assert.fail('a partial stream must not be replayed')
  })),
  /network error/
)
assert.equal(partialStreamAttempts, 1)

console.log('Desktop conversation network retry regression passed')
