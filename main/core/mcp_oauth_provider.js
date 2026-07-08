import { randomBytes } from 'node:crypto'
import * as sdkAuthModule from '@modelcontextprotocol/sdk/client/auth.js'
import * as store from './mcp_oauth_store.js'
import * as cb from './mcp_oauth_cb.js'

if (typeof URL === 'function' && typeof URL.canParse !== 'function') {
  URL.canParse = function canParse(url, base) {
    try {
      new URL(url, base)
      return true
    } catch {
      return false
    }
  }
}

const sdkAuth = sdkAuthModule || null
const DEFAULT_REDIRECT_PORT = 0

export function buildOAuthClientProvider(serverId, serverConfig = {}, options = {}) {
  const oauth = (serverConfig.auth && serverConfig.auth.oauth) || {}
  const redirectPort = (oauth.redirectPath && Number(oauth.redirectPath)) || DEFAULT_REDIRECT_PORT
  const redirectUri = options.redirectUri ? String(options.redirectUri) : cb.determineRedirectUri(redirectPort)
  let pendingState = options.state ? String(options.state) : null

  return {
    get redirectUrl() {
      return redirectUri
    },
    get clientMetadata() {
      return {
        client_name: 'Anywhere MCP Client',
        redirect_uris: [redirectUri],
        grant_types: ['authorization_code', 'refresh_token'],
        response_types: ['code'],
        application_type: 'native',
        token_endpoint_auth_method: oauth.clientSecret ? 'client_secret_post' : 'none'
      }
    },
    async clientInformation() {
      if (oauth.clientId) {
        const stored = await store.loadClientInfo(serverId)
        const clientSecret = oauth.clientSecret || stored?.client_secret || undefined
        return {
          client_id: oauth.clientId,
          client_secret: clientSecret,
          redirect_uris: [redirectUri],
          grant_types: ['authorization_code', 'refresh_token'],
          token_endpoint_auth_method: clientSecret ? 'client_secret_post' : 'none'
        }
      }
      return await store.loadClientInfo(serverId)
    },
    async saveClientInformation(info) {
      await store.saveClientInfo(serverId, info)
    },
    async tokens() {
      return await store.loadTokens(serverId)
    },
    async saveTokens(tokens) {
      await store.saveTokens(serverId, tokens)
    },
    async redirectToAuthorization(url) {
      try {
        const parsed = new URL(String(url))
        pendingState = parsed.searchParams.get('state') || pendingState
      } catch {
        // ignore parse failures, sdk throws later if needed
      }
      await cb.openAuthorizationInExternal(url)
    },
    async codeVerifier() {
      const slot = await store.loadCodeVerifier(serverId)
      return slot ? slot.value : undefined
    },
    async saveCodeVerifier(verifier) {
      await store.saveCodeVerifier(serverId, verifier)
    },
    async state() {
      if (!pendingState) pendingState = randomBytes(16).toString('hex')
      return pendingState
    },
    async invalidateCredentials(scope) {
      await store.invalidateCredentials(serverId, scope || 'all')
    },
    _serverId: serverId,
    _getPendingState() {
      return pendingState
    },
    _redirectUri: redirectUri
  }
}

export function loadSdkAuth() {
  if (!sdkAuth) {
    throw new Error('Could not resolve @modelcontextprotocol/sdk auth module')
  }
  return sdkAuth
}

export function isUnauthorizedError(error) {
  if (!error) return false
  if (error.name === 'UnauthorizedError') return true
  return error.message === 'Unauthorized' || /unauthorized/i.test(String(error.message))
}

export function getProvider(serverId, serverConfig) {
  return buildOAuthClientProvider(serverId, serverConfig)
}

export async function finishAuthFlow({ serverId, provider, serverConfig, transport, callbackParams, serverUrl }) {
  const { code } = callbackParams || {}
  if (!code) throw new Error('finishAuthFlow: missing authorization code')

  if (transport && typeof transport.finishAuth === 'function') {
    await transport.finishAuth(code)
    const tokens = await provider.tokens()
    return { tokens }
  }

  const { auth, UnauthorizedError } = loadSdkAuth()
  const url = serverUrl || serverConfig?.url || serverConfig?.baseUrl
  if (!url) throw new Error('finishAuthFlow: serverUrl required when transport is absent')

  const result = await auth(provider, {
    serverUrl: url,
    authorizationCode: code,
    scope: serverConfig?.auth?.oauth?.scopes?.join(' ')
  })

  if (result !== 'AUTHORIZED') {
    throw new UnauthorizedError('finishAuthFlow: authorization exchange did not complete')
  }

  const tokens = await provider.tokens()
  return { tokens }
}

export async function refreshOAuthTokens(serverId, serverConfig = {}) {
  const provider = buildOAuthClientProvider(serverId, serverConfig)
  const tokens = await provider.tokens()
  if (!tokens || !tokens.refresh_token) throw new Error('No OAuth refresh token available')

  const serverUrl = serverConfig.url || serverConfig.baseUrl
  if (!serverUrl) throw new Error(`OAuth refresh requires a server url for ${serverId}`)

  const clientInformation = await provider.clientInformation()
  if (!clientInformation || !clientInformation.client_id) {
    throw new Error('OAuth client information is missing')
  }

  const { discoverOAuthServerInfo, refreshAuthorization, selectResourceURL } = loadSdkAuth()
  const serverInfo = await discoverOAuthServerInfo(serverUrl)
  const resource = typeof selectResourceURL === 'function'
    ? await selectResourceURL(serverUrl, provider, serverInfo.resourceMetadata)
    : undefined

  const refreshed = await refreshAuthorization(serverInfo.authorizationServerUrl, {
    metadata: serverInfo.authorizationServerMetadata,
    clientInformation,
    refreshToken: tokens.refresh_token,
    resource,
    addClientAuthentication: provider.addClientAuthentication
  })

  const merged = {
    ...tokens,
    ...refreshed,
    refresh_token: refreshed.refresh_token || tokens.refresh_token
  }
  await provider.saveTokens(merged)
  return merged
}
