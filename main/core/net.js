import { net } from 'electron'

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
    if (net && typeof net.fetch === 'function') {
      return await net.fetch(input, requestInit)
    }

    if (typeof fetch === 'function') {
      return await fetch(input, requestInit)
    }

    throw new Error('fetch_unavailable_in_current_context')
  } catch (error) {
    if (timeoutContext.isTimedOut()) {
      throw new Error(`web_request_timeout_${timeoutContext.timeoutMs}ms`)
    }
    throw error
  } finally {
    timeoutContext.cleanup()
  }
}
