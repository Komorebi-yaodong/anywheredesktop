import http from 'node:http'
import { URL } from 'node:url'
import { BrowserWindow, shell } from 'electron'

const DEFAULT_TIMEOUT_MS = 5 * 60 * 1000

export function loopbackRedirectUri(port) {
  return `http://127.0.0.1:${port}/callback`
}

export function determineRedirectUri(port = 0) {
  return loopbackRedirectUri(port)
}

export function parseCallbackQuery(searchParams) {
  return {
    code: searchParams.get('code') || undefined,
    state: searchParams.get('state') || undefined,
    iss: searchParams.get('iss') || undefined,
    error: searchParams.get('error') || undefined,
    error_description: searchParams.get('error_description') || undefined
  }
}

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

function respondAndClose(_req, res, params, expectedState, callbackResolve) {
  if (params.error) {
    res.writeHead(400, { 'Content-Type': 'text/html; charset=utf-8' })
    res.end(`<h1>登录失败</h1><p>${escapeHtml(params.error)}${params.error_description ? `: ${escapeHtml(params.error_description)}` : ''}</p>`)
    callbackResolve.reject(new Error(`OAuth error: ${params.error}${params.error_description ? ` - ${params.error_description}` : ''}`))
    return
  }

  if (!params.code) {
    res.writeHead(400, { 'Content-Type': 'text/html; charset=utf-8' })
    res.end('<h1>缺少授权码</h1>')
    callbackResolve.reject(new Error('OAuth callback missing code'))
    return
  }

  if (expectedState && params.state !== expectedState) {
    res.writeHead(400, { 'Content-Type': 'text/html; charset=utf-8' })
    res.end('<h1>state 不匹配（拒绝）</h1>')
    callbackResolve.reject(new Error('OAuth state mismatch'))
    return
  }

  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
  res.end('<h1>登录成功，可关闭此页面返回 Anywhere Desktop。</h1>')
  callbackResolve.resolve(params)
}

export function startLoopbackCallback({ expectedState, port = 0, timeoutMs = DEFAULT_TIMEOUT_MS }) {
  return new Promise((resolve, reject) => {
    let timer = null
    let callbackResolve = null
    const fetchCallbackParams = new Promise((innerResolve, innerReject) => {
      callbackResolve = {
        resolve: innerResolve,
        reject: innerReject
      }
    })

    const server = http.createServer((req, res) => {
      try {
        const reqUrl = new URL(req.url, `http://127.0.0.1:${server.address().port}`)
        const params = parseCallbackQuery(reqUrl.searchParams)
        respondAndClose(req, res, params, expectedState, callbackResolve)
      } catch (error) {
        res.writeHead(400, { 'Content-Type': 'text/html; charset=utf-8' })
        res.end(`<h1>Bad callback</h1><pre>${escapeHtml(String(error?.message || error))}</pre>`)
      }
    })

    server.on('error', (error) => {
      if (timer) clearTimeout(timer)
      reject(error)
    })

    server.listen(port, '127.0.0.1', () => {
      const boundPort = server.address().port
      timer = setTimeout(() => {
        cleanup()
        callbackResolve.reject(new Error('OAuth callback timed out'))
      }, timeoutMs)

      function cleanup() {
        if (timer) {
          clearTimeout(timer)
          timer = null
        }
        try {
          server.close()
        } catch {
          // ignore close errors
        }
      }

      resolve({
        redirectUri: loopbackRedirectUri(boundPort),
        server,
        cleanup,
        fetchCallbackParams
      })
    })
  })
}

export function normalizeExternalAuthorizationUrl(url) {
  let parsed
  try {
    parsed = new URL(String(url))
  } catch {
    throw new Error('Invalid OAuth authorization URL')
  }

  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error(`Unsafe OAuth authorization URL protocol: ${parsed.protocol}`)
  }

  return parsed.toString()
}

export async function openAuthorizationInExternal(url) {
  const normalizedUrl = normalizeExternalAuthorizationUrl(url)
  return shell.openExternal(normalizedUrl)
}

export function startBrowserWindowFallback({ authorizeUrl, redirectUri, expectedState, timeoutMs = DEFAULT_TIMEOUT_MS }) {
  return new Promise((resolve, reject) => {
    const redirectBase = String(redirectUri).split('?')[0]
    const timer = setTimeout(() => reject(new Error('BrowserWindow OAuth callback timed out')), timeoutMs)
    let win = null
    let settled = false

    const finish = (handler, payload) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      if (win && !win.isDestroyed()) {
        try {
          win.close()
        } catch {
          // ignore close errors
        }
      }
      handler(payload)
    }

    try {
      const safeAuthorizeUrl = normalizeExternalAuthorizationUrl(authorizeUrl)
      win = new BrowserWindow({
        width: 900,
        height: 700,
        show: true,
        autoHideMenuBar: true,
        webPreferences: {
          sandbox: true
        }
      })
      win.loadURL(safeAuthorizeUrl)

      const onNavigate = (_event, url) => {
        if (!url) return
        let parsed
        try {
          parsed = new URL(url)
        } catch {
          return
        }
        const candidate = `${parsed.protocol}//${parsed.host}${parsed.pathname}`
        if (!candidate.startsWith(redirectBase) && !url.startsWith(redirectBase)) return

        const params = parseCallbackQuery(parsed.searchParams)
        if (params.error) {
          finish(reject, new Error(`OAuth error: ${params.error}`))
        } else if (!params.code) {
          finish(reject, new Error('OAuth callback missing code'))
        } else if (expectedState && params.state !== expectedState) {
          finish(reject, new Error('OAuth state mismatch'))
        } else {
          finish(resolve, params)
        }
      }

      win.webContents.on('did-navigate', onNavigate)
      win.webContents.on('did-navigate-in-page', onNavigate)
      win.on('closed', () => {
        if (!settled) finish(reject, new Error('OAuth browser window closed before callback'))
      })
    } catch (error) {
      clearTimeout(timer)
      reject(new Error(`BrowserWindow OAuth fallback unavailable: ${error?.message || error}`))
    }
  })
}

export async function runAuthFlowWithFallback({ authorizeUrl, expectedState, preferredPort = 0, timeoutMs, loopback = null }) {
  let managedLoopback = loopback
  try {
    if (!managedLoopback) {
      managedLoopback = await startLoopbackCallback({ expectedState, port: preferredPort, timeoutMs })
    }
    await openAuthorizationInExternal(authorizeUrl)
    return await managedLoopback.fetchCallbackParams
  } catch {
    if (managedLoopback?.cleanup) managedLoopback.cleanup()
    const redirectUri = managedLoopback ? managedLoopback.redirectUri : loopbackRedirectUri(preferredPort)
    return await startBrowserWindowFallback({ authorizeUrl, redirectUri, expectedState, timeoutMs })
  } finally {
    if (managedLoopback?.cleanup) managedLoopback.cleanup()
  }
}
