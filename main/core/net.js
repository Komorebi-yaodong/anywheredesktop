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

  if (net && typeof net.fetch === 'function') {
    return await net.fetch(input, normalizedInit)
  }

  if (typeof fetch === 'function') {
    return await fetch(input, normalizedInit)
  }

  throw new Error('fetch_unavailable_in_current_context')
}
