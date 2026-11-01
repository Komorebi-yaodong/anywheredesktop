import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import http from 'node:http'
import { createRequire } from 'node:module'
import { pathToFileURL, fileURLToPath } from 'node:url'

// Bundle the actual production request/recorder chain; only Electron transport is replaced
// with loopback Node fetch. No real config, credentials, app or external network is used.
const require = createRequire(import.meta.url)
const { build } = require('esbuild')
const root = fileURLToPath(new URL('..', import.meta.url))
const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'anywhere-usage-sdk-'))
const requestBodies = []
let attempts = 0
const server = http.createServer(async (req, res) => {
  let raw = ''
  for await (const chunk of req) raw += chunk
  const body = JSON.parse(raw)
  requestBodies.push(body)
  if (body.model === 'retry') {
    attempts++
    if (attempts === 1) {
      res.writeHead(500, { 'Content-Type': 'application/json' })
      res.end('{"error":{"message":"retry test"}}')
      return
    }
  }
  if (body.model === 'fail') {
    res.writeHead(401, { 'Content-Type': 'application/json' })
    res.end('{"error":{"message":"synthetic failure"}}')
    return
  }
  const usage = {
    prompt_tokens: 100,
    completion_tokens: 20,
    total_tokens: 120,
    prompt_tokens_details: { cached_tokens: 40 }
  }
  if (req.url.includes('/messages')) {
    const anthropicUsage = {
      input_tokens: 10,
      output_tokens: 20,
      cache_read_input_tokens: 70,
      cache_creation_input_tokens: 20
    }
    if (body.stream) {
      res.writeHead(200, { 'Content-Type': 'text/event-stream' })
      for (const [type, data] of [
        [
          'message_start',
          {
            type: 'message_start',
            message: {
              id: 'synthetic',
              type: 'message',
              role: 'assistant',
              content: [],
              model: body.model,
              usage: { ...anthropicUsage, output_tokens: 0 }
            }
          }
        ],
        [
          'content_block_start',
          { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }
        ],
        [
          'content_block_delta',
          { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'ok' } }
        ],
        [
          'message_delta',
          {
            type: 'message_delta',
            delta: { stop_reason: 'end_turn' },
            usage: { output_tokens: 20 }
          }
        ],
        ['message_stop', { type: 'message_stop' }]
      ])
        res.write(`event: ${type}\ndata: ${JSON.stringify(data)}\n\n`)
      res.end()
    } else {
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(
        JSON.stringify({
          id: 'synthetic',
          type: 'message',
          role: 'assistant',
          content: [{ type: 'text', text: 'ok' }],
          usage: anthropicUsage
        })
      )
    }
  } else if (req.url.includes('/responses')) {
    const response = {
      id: 'r',
      object: 'response',
      status: 'completed',
      output: [],
      usage: {
        input_tokens: 100,
        output_tokens: 20,
        total_tokens: 120,
        input_tokens_details: { cached_tokens: 40 }
      }
    }
    if (body.stream) {
      res.writeHead(200, { 'Content-Type': 'text/event-stream' })
      res.end(
        `event: response.completed\ndata: ${JSON.stringify({ type: 'response.completed', response })}\n\n`
      )
    } else {
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify(response))
    }
  } else if (body.stream) {
    res.writeHead(200, { 'Content-Type': 'text/event-stream' })
    for (const chunk of [
      { choices: [{ delta: { content: 'ok' }, index: 0 }] },
      { choices: [{ delta: {}, finish_reason: 'stop', index: 0 }], usage }
    ]) {
      res.write(`data: ${JSON.stringify(chunk)}\n\n`)
    }
    res.end('data: [DONE]\n\n')
  } else {
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(
      JSON.stringify({
        choices: [{ message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }],
        usage
      })
    )
  }
})
try {
  const outfile = path.join(dir, 'requests.cjs')
  await build({
    stdin: {
      contents:
        "export { createChatCompletion } from './main/core/chat.js'; export { setUsageRecordSink } from './main/core/usageRecorder.js'",
      resolveDir: root
    },
    outfile,
    bundle: true,
    platform: 'node',
    format: 'cjs',
    plugins: [
      {
        name: 'loopback-transport',
        setup(bundler) {
          bundler.onLoad({ filter: /[\\/]main[\\/]core[\\/]net\.js$/ }, () => ({
            contents:
              'export const BRIDGE_UA_HEADER="x-test-ua"; export const fetchWithProxy=(input,init)=>fetch(input,init)',
            loader: 'js'
          }))
        }
      }
    ]
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const url = `http://127.0.0.1:${server.address().port}/v1`
  const { createChatCompletion, setUsageRecordSink } = (await import(pathToFileURL(outfile)))
    .default
  const records = []
  setUsageRecordSink(async (record) => {
    records.push(record)
    return { ok: true }
  })
  const params = {
    baseUrl: url,
    apiKey: 'synthetic-key',
    model: 'test',
    messages: [{ role: 'user', content: 'synthetic' }],
    retryCount: 0,
    usageContext: {
      providerId: 'stable-id',
      providerName: 'Snapshot name',
      agentName: '__DEFAULT__'
    }
  }
  for (const apiType of ['chat_completions', 'responses', 'codex', 'claude']) {
    for (const stream of [false, true]) {
      const response = await createChatCompletion({ ...params, apiType, stream })
      if (stream) for await (const part of response) assert.ok(part)
      const record = records.at(-1)
      assert.equal(record.status, 'success', apiType)
      assert.equal(record.totalTokens, 120, apiType)
      assert.equal(record.cachedTokens, apiType === 'claude' ? 70 : 40, apiType)
      assert.equal(record.providerId, 'stable-id')
    }
  }
  assert.equal(records.length, 8)
  await createChatCompletion({ ...params, stream: false, model: 'retry', retryCount: 1 })
  assert.equal(attempts, 2)
  assert.equal(records.length, 9, 'SDK internal retry records only once')
  await assert.rejects(createChatCompletion({ ...params, stream: false, model: 'fail' }))
  assert.equal(records.at(-1).status, 'failed')
  assert.equal(records.at(-1).httpStatus, 401)
  assert.ok(
    requestBodies.every((body) => !('usageContext' in body)),
    'local identity never reaches API body'
  )
  assert.equal(records.length, 10)
  assert.ok(!JSON.stringify(records).includes('synthetic-key'))
  console.log(
    'Real SDK loopback: 4 protocols × stream/nonstream, Claude cache, internal retries, HTTP failure and request metadata isolation passed'
  )
} finally {
  server.closeAllConnections()
  await new Promise((resolve) => server.close(resolve))
  await fs.rm(dir, { recursive: true, force: true })
}
