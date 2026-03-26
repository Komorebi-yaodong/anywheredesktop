import { net } from 'electron'

function normalizeFetchInit(init = {}) {
  const nextInit = { ...init }
  if (nextInit.body instanceof URLSearchParams) {
    nextInit.body = nextInit.body.toString()
    const headers = new Headers(nextInit.headers || {})
    if (!headers.has('Content-Type')) {
      headers.set('Content-Type', 'application/x-www-form-urlencoded;charset=UTF-8')
    }
    nextInit.headers = headers
  }
  return nextInit
}

/**
 * 使用 Electron Chromium 网络栈发起请求，以便默认遵循系统代理/默认 Session 代理策略。
 */
export async function fetchWithProxy(input, init = {}) {
  return await net.fetch(input, normalizeFetchInit(init))
}
