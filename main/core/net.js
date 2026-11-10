import { app, net, session } from 'electron'
import { createIdempotentSerialApplier } from './idempotentApply.js'

function buildHeadersCompat(inputHeaders = {}) {
  try {
    return new Headers(inputHeaders || {})
  } catch {
    return {
      has: (key) => Object.prototype.hasOwnProperty.call(inputHeaders || {}, key),
      set: (key, value) => {
        inputHeaders[key] = value
      },
      toJSON: () => ({ ...(inputHeaders || {}) })
    }
  }
}


const DEFAULT_FETCH_TIMEOUT_MS = 30000


const DEFAULT_PROXY_BYPASS_RULES = '<local>'
const UPDATER_SESSION_PARTITION = 'electron-updater'
const PROXY_SCHEMES = new Set(['http:', 'https:', 'socks5:'])

export function normalizeNetworkProxyConfig(input = {}) {
  const source = input && typeof input === 'object' ? input : {}
  const enabled = source.enabled === true
  const server = typeof source.server === 'string' ? source.server.trim() : ''
  const bypassRules = typeof source.bypassRules === 'string' && source.bypassRules.trim()
    ? source.bypassRules.trim()
    : DEFAULT_PROXY_BYPASS_RULES

  if (!enabled) return { enabled: false, server: '', bypassRules }
  if (!server) throw new Error('network_proxy_server_required')

  let parsed
  try {
    parsed = new URL(server)
  } catch {
    throw new Error('network_proxy_server_invalid')
  }

  const rawAuthority = server.slice(server.indexOf('://') + 3)
  const hasExplicitPort = /^[^:\[\]]+:\d+$/.test(rawAuthority)
  if (!PROXY_SCHEMES.has(parsed.protocol) || !parsed.hostname || !hasExplicitPort || parsed.username || parsed.password || !['', '/'].includes(parsed.pathname) || parsed.search || parsed.hash) {
    throw new Error('network_proxy_server_invalid')
  }

  return {
    enabled: true,
    server,
    bypassRules
  }
}

async function applyProxyToSession(targetSession, proxyConfig) {
  if (typeof targetSession?.setProxy !== 'function') return
  await targetSession.setProxy(proxyConfig)
  await targetSession.closeAllConnections?.()
}

async function applyNormalizedNetworkProxyConfig(config) {
  const proxyConfig = config.enabled
    ? { mode: 'fixed_servers', proxyRules: config.server, proxyBypassRules: config.bypassRules }
    : { mode: 'direct' }

  if (typeof app?.setProxy === 'function') {
    await app.setProxy(proxyConfig)
  }

  await applyProxyToSession(session?.defaultSession, proxyConfig)

  // electron-updater uses this isolated in-memory partition rather than defaultSession.
  // Keep it synchronized so update checks and package downloads honor networkProxy too.
  const updaterSession = typeof session?.fromPartition === 'function'
    ? session.fromPartition(UPDATER_SESSION_PARTITION, { cache: false })
    : null
  await applyProxyToSession(updaterSession, proxyConfig)
}

const applyNetworkProxyConfigOnce = createIdempotentSerialApplier({
  normalize: normalizeNetworkProxyConfig,
  getFingerprint: (config) => JSON.stringify(config),
  apply: applyNormalizedNetworkProxyConfig
})

export async function applyNetworkProxyConfig(input = {}) {
  return await applyNetworkProxyConfigOnce(input)
}


function normalizeTimeoutMs(value, fallback = DEFAULT_FETCH_TIMEOUT_MS) {
  const numericValue = Number(value)
  return Number.isFinite(numericValue) && numericValue > 0 ? numericValue : fallback
}

function createTimeoutContext(init = {}) {
  const upstreamSignal = init?.signal
  const timeoutMs = normalizeTimeoutMs(init?.timeout ?? init?.timeoutMs)

  let timedOut = false
  const controller = new AbortController()

  const forwardAbort = () => {
    try {
      controller.abort(upstreamSignal?.reason)
    } catch {
      controller.abort()
    }
  }

  if (upstreamSignal) {
    if (upstreamSignal.aborted) {
      forwardAbort()
    } else {
      upstreamSignal.addEventListener('abort', forwardAbort, { once: true })
    }
  }

  const timeoutId = setTimeout(() => {
    timedOut = true
    try {
      controller.abort(new Error(`fetch_timeout_${timeoutMs}ms`))
    } catch {
      controller.abort()
    }
  }, timeoutMs)

  return {
    signal: controller.signal,
    timeoutMs,
    isTimedOut: () => timedOut,
    headersReceived: () => clearTimeout(timeoutId),
    cleanup: () => {
      clearTimeout(timeoutId)
      if (upstreamSignal) {
        upstreamSignal.removeEventListener('abort', forwardAbort)
      }
    }
  }
}

function normalizeFetchInit(init = {}) {
  const nextInit = { ...init }
  if (nextInit.body instanceof URLSearchParams) {
    nextInit.body = nextInit.body.toString()
    const headers = buildHeadersCompat(nextInit.headers || {})
    if (!headers.has('Content-Type')) {
      headers.set('Content-Type', 'application/x-www-form-urlencoded;charset=UTF-8')
    }
    nextInit.headers = typeof headers.toJSON === 'function' ? headers.toJSON() : headers
  }
  return nextInit
}

/**
 * 使用 Electron Chromium 网络栈发起请求，以便默认遵循系统代理/默认 Session 代理策略。
 * 当 Electron net.fetch 在当前运行上下文不可用时，回退到全局 fetch，避免 preload 场景报错。
 */
export async function fetchWithProxy(input, init = {}) {
  const normalizedInit = normalizeFetchInit(init)
  const timeoutContext = createTimeoutContext(normalizedInit)
  const requestInit = {
    ...normalizedInit,
    signal: timeoutContext.signal
  }

  try {
    const transport = net && typeof net.fetch === 'function' ? net.fetch.bind(net)
      : typeof fetch === 'function' ? fetch : null
    if (!transport) throw new Error('fetch_unavailable_in_current_context')
    const response = await transport(input, requestInit)
    // Header timeout is not a model-generation deadline. Preserve upstream cancellation until
    // response-body completion/cancel, rather than disconnecting it immediately after headers.
    timeoutContext.headersReceived()
    if (!response.body || typeof response.body.getReader !== 'function') {
      timeoutContext.cleanup()
      return response
    }
    const reader = response.body.getReader()
    let ended = false
    let streamController
    const finish = () => {
      if (ended) return
      ended = true
      timeoutContext.signal.removeEventListener('abort', onAbort)
      timeoutContext.cleanup()
      try { reader.releaseLock() } catch { /* a pending read releases after abort */ }
    }
    const cancelReader = () => {
      try { Promise.resolve(reader.cancel()).catch(() => {}).finally(() => { try { reader.releaseLock() } catch { /* pending reader */ } }) }
      catch { /* cancellation must retain its original outcome */ }
    }
    const onAbort = () => {
      if (ended) return
      const error = Object.assign(new Error('The operation was aborted.'), { name: 'AbortError' })
      streamController?.error(error)
      cancelReader()
      finish()
    }
    const body = new ReadableStream({
      start(controller) { streamController = controller },
      async pull(controller) {
        if (ended) return
        try {
          const item = await reader.read()
          if (ended) return
          if (item.done) { controller.close(); finish() }
          else controller.enqueue(item.value)
        } catch (error) { if (!ended) { controller.error(error); finish() } }
      },
      cancel() { cancelReader(); finish() }
    })
    timeoutContext.signal.addEventListener('abort', onAbort, { once: true })
    if (timeoutContext.signal.aborted) onAbort()
    const wrapped = new Response(body, { status: response.status, statusText: response.statusText, headers: response.headers })
    // Preserve response metadata while native body methods operate on the cancellable stream.
    return new Proxy(wrapped, {
      get(target, key) {
        if (['url', 'redirected', 'type'].includes(key)) return response[key]
        const value = Reflect.get(target, key, target)
        return typeof value === 'function' ? value.bind(target) : value
      }
    })
  } catch (error) {
    timeoutContext.cleanup()
    if (timeoutContext.isTimedOut()) throw new Error(`web_request_timeout_${timeoutContext.timeoutMs}ms`)
    throw error
  }
}

// User-Agent 是 Chromium 受保护请求头，net.fetch 会丢弃 RequestInit.headers 中的 User-Agent 并回退到 session UA。
// 因此调用方把目标 User-Agent 放入中转请求头 BRIDGE_UA_HEADER，由本拦截器在请求发出前还原为真正的 User-Agent。
export const BRIDGE_UA_HEADER = 'X-Anywhere-User-Agent'

let requestHeaderBridgeInstalled = false

export function installRequestHeaderBridge() {
  if (requestHeaderBridgeInstalled) return
  const targetSession = session?.defaultSession
  if (!targetSession?.webRequest) return

  targetSession.webRequest.onBeforeSendHeaders((details, callback) => {
    const headers = details.requestHeaders || {}
    let bridgedUserAgent = ''

    for (const key of Object.keys(headers)) {
      if (key.toLowerCase() === BRIDGE_UA_HEADER.toLowerCase()) {
        bridgedUserAgent = headers[key]
        delete headers[key]
      }
    }

    if (bridgedUserAgent) {
      for (const key of Object.keys(headers)) {
        if (key.toLowerCase() === 'user-agent') {
          delete headers[key]
        }
      }
      headers['User-Agent'] = bridgedUserAgent
    }

    callback({ requestHeaders: headers })
  })

  requestHeaderBridgeInstalled = true
}
