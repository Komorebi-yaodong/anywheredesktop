import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import vm from 'node:vm'

// Execute the real resolver body with in-memory cache and synthetic HTTP only.
// Never touches the app database, configured providers, or network credentials.
const source = await fs.readFile(new URL('../main/core/compact.js', import.meta.url), 'utf8')
const normalize = source.slice(source.indexOf('function normalizeModelKey('), source.indexOf('function extractTextFromContent('))
const resolver = source.slice(source.indexOf('export async function resolveModelContextLength('), source.indexOf('function getSystemMessages('))
  .replace('export async function', 'async function')
  .replace("await import('./net.js')", '({fetchWithProxy: mockFetch})')

function fixture(responses, input = 'provider|vendor/model-fixture') {
  const writes = [], queries = [], timers = []
  const original = {contextLength: 65536, contextLengthManual: true, contextLengthSource: 'manual', resolvedId: 'model-fixture', triggerRatio: 0.8}
  const sandbox = {
    DEFAULT_CONTEXT_LENGTH: 262144, MODEL_RESOLVE_URL: 'https://example.invalid/resolve', MODEL_RESOLVE_AUTH: 'synthetic-only', AbortController,
    setTimeout: callback => { timers.push(callback); return timers.length }, clearTimeout() {},
    getModelCompactConfig: async () => ({ok: true, config: structuredClone(original)}),
    defaultModelCacheEntry: () => structuredClone(original),
    updateModelCompactConfig: async (key, patch) => { writes.push({key, patch}); return {ok: true, config: {...original, ...patch}} },
    mockFetch: async (url, options) => {
      queries.push(new URL(url).searchParams.get('model'))
      assert.equal(options.timeoutMs, 15000)
      assert.ok(options.signal)
      const next = responses.shift()
      if (typeof next === 'function') return next(options, timers)
      if (next instanceof Error) throw next
      return {ok: next.http == null || next.http === 200, status: next.http || 200, text: async () => next.raw ?? JSON.stringify(next.payload)}
    }
  }
  const resolve = vm.runInNewContext(`${normalize}\n${resolver}\nresolveModelContextLength`, sandbox)
  return {original, writes, queries, run: options => resolve(input, options || {forceRefresh: true, preferManual: false, requireApi: true})}
}

const success = fixture([{payload: {status: 'success', resolved: {id: 'vendor/model-fixture', context_length: 131072}}}])
assert.equal((await success.run()).contextLength, 131072)
assert.equal(success.writes[0].patch.contextLengthSource, 'api')
assert.equal(success.writes[0].patch.contextLengthManual, false)
assert.deepEqual(success.queries, ['vendor/model-fixture'])

const routed = fixture([{payload: {status: 'not_found'}}, {payload: {status: 'success', resolved: {context_length: 131072}}}])
assert.equal((await routed.run()).source, 'api')
assert.deepEqual(routed.queries, ['vendor/model-fixture', 'model-fixture'])

for (const [response, code] of [
  [{http: 401}, 'context_service_auth_failed'],
  [{http: 503}, 'context_service_unavailable'],
  [{payload: {status: 'error'}}, 'context_service_unavailable'],
  [{payload: {}}, 'context_response_invalid'],
  [{raw: '{broken'}, 'context_response_invalid'],
  [{payload: {status: 'success', resolved: {context_length: -1}}}, 'context_response_invalid'],
  [new Error('private-host/path/MUST_NOT_LEAK'), 'context_network_unavailable'],
  [new Error('web_request_timeout_15000ms'), 'context_lookup_timeout']
]) {
  const f = fixture([response])
  const result = await f.run()
  assert.equal(result.ok, false)
  assert.equal(result.code, code)
  assert.equal(result.contextLength, f.original.contextLength)
  assert.equal(result.config.contextLengthManual, true)
  assert.equal(f.writes.length, 0, 'failed explicit lookup must not mutate any cache key')
  assert.equal(JSON.stringify(result).includes('MUST_NOT_LEAK'), false)
}
const missing = fixture([], '')
assert.equal((await missing.run()).code, 'context_model_missing')
assert.equal(missing.writes.length, 0)
const noMatch = fixture([{http: 404}, {payload: {status: 'not_found'}}])
assert.equal((await noMatch.run()).code, 'context_model_not_found')
assert.equal(noMatch.writes.length, 0)

// Headers arriving is not completion: timeout still covers the body read.
const bodyTimeout = fixture([async (options, timers) => ({ok: true, text: async () => {
  timers.at(-1)()
  if (options.signal.aborted) throw Object.assign(new Error('body interrupted'), {name: 'AbortError'})
}})])
assert.equal((await bodyTimeout.run()).code, 'context_lookup_timeout')
assert.equal(bodyTimeout.writes.length, 0)

const manual = fixture([])
assert.equal((await manual.run({preferManual: true})).source, 'manual')
assert.equal(manual.queries.length, 0)
console.log(JSON.stringify({ok: true, suite: 'context-resolver'}))
