import { createCipheriv, createDecipheriv, createHash, randomBytes, scryptSync } from 'node:crypto'
import { app } from 'electron'
import { dbStorageGetItem, dbStorageRemoveItem, dbStorageSetItem } from './db.js'

const SALT_BYTES = 16
const IV_BYTES = 12
const KEY_BYTES = 32
const SCRYPT_N = 1 << 15
const SCRYPT_R = 8
const SCRYPT_P = 1

function getDeviceSeed() {
  const hash = createHash('sha256')
  hash.update(`${app.getName()}::${app.getPath('userData')}::${process.platform}`)
  return hash.digest('hex')
}

function shardKey(prefix) {
  return `${prefix}::desktop`
}

function deriveKey(salt) {
  return scryptSync(getDeviceSeed(), salt, KEY_BYTES, {
    N: SCRYPT_N,
    r: SCRYPT_R,
    p: SCRYPT_P,
    maxmem: 128 * SCRYPT_N * (SCRYPT_R * 2 + 1)
  })
}

function encrypt(plain) {
  if (plain === undefined || plain === null) return null
  const text = typeof plain === 'string' ? plain : JSON.stringify(plain)
  const salt = randomBytes(SALT_BYTES)
  const iv = randomBytes(IV_BYTES)
  const key = deriveKey(salt)
  const cipher = createCipheriv('aes-256-gcm', key, iv)
  const ciphertext = Buffer.concat([cipher.update(text, 'utf8'), cipher.final()])
  const tag = cipher.getAuthTag()
  return {
    v: 1,
    salt: salt.toString('base64'),
    iv: iv.toString('base64'),
    ct: ciphertext.toString('base64'),
    tag: tag.toString('base64')
  }
}

function decrypt(blob) {
  if (!blob || typeof blob !== 'object') return undefined
  try {
    const salt = Buffer.from(blob.salt, 'base64')
    const iv = Buffer.from(blob.iv, 'base64')
    const ct = Buffer.from(blob.ct, 'base64')
    const tag = Buffer.from(blob.tag, 'base64')
    const key = deriveKey(salt)
    const decipher = createDecipheriv('aes-256-gcm', key, iv)
    decipher.setAuthTag(tag)
    return Buffer.concat([decipher.update(ct), decipher.final()]).toString('utf8')
  } catch {
    return undefined
  }
}

async function loadShard(id) {
  const result = await dbStorageGetItem(id, null)
  const value = result?.value
  return value && typeof value === 'object' ? value : null
}

async function saveShard(id, data) {
  await dbStorageSetItem(id, data || {})
}

function ensureMap(container, key) {
  if (!container || typeof container !== 'object') container = {}
  if (!container[key] || typeof container[key] !== 'object') container[key] = {}
  return container[key]
}

export async function loadTokens(serverId) {
  const shard = await loadShard(shardKey('mcpOAuthTokens'))
  if (!shard) return undefined
  const entry = shard[serverId]
  if (!entry) return undefined

  const accessToken = decrypt(entry.access_token)
  if (accessToken === undefined) return undefined
  const refreshToken = entry.refresh_token ? decrypt(entry.refresh_token) : undefined
  const idToken = entry.id_token ? decrypt(entry.id_token) : undefined

  return {
    access_token: accessToken,
    refresh_token: refreshToken === undefined ? undefined : refreshToken,
    id_token: idToken === undefined ? undefined : idToken,
    expires_at: entry.expires_at,
    scope: entry.scope,
    token_type: entry.token_type || 'Bearer'
  }
}

export async function saveTokens(serverId, tokens) {
  const id = shardKey('mcpOAuthTokens')
  const shard = (await loadShard(id)) || {}
  const slot = ensureMap(shard, serverId)
  slot.access_token = encrypt(tokens?.access_token)
  slot.refresh_token = tokens?.refresh_token ? encrypt(tokens.refresh_token) : null
  slot.id_token = tokens?.id_token ? encrypt(tokens.id_token) : null
  slot.expires_at = tokens?.expires_at
  slot.scope = tokens?.scope
  slot.token_type = tokens?.token_type || 'Bearer'
  slot.updatedAt = Date.now()
  await saveShard(id, shard)
}

export async function clearTokens(serverId) {
  const id = shardKey('mcpOAuthTokens')
  const shard = (await loadShard(id)) || {}
  if (shard[serverId]) {
    delete shard[serverId]
    await saveShard(id, shard)
  }
}

export async function loadClientInfo(serverId) {
  const shard = await loadShard(shardKey('mcpOAuthClients'))
  if (!shard) return undefined
  const entry = shard[serverId]
  if (!entry) return undefined

  const clientId = decrypt(entry.client_id)
  if (clientId === undefined) return undefined
  const clientSecret = entry.client_secret ? decrypt(entry.client_secret) : undefined

  return {
    client_id: clientId,
    client_secret: clientSecret === undefined ? undefined : clientSecret,
    redirect_uris: entry.redirect_uris,
    grant_types: entry.grant_types,
    token_endpoint_auth_method: entry.token_endpoint_auth_method,
    registered_at: entry.registered_at
  }
}

export async function saveClientInfo(serverId, info) {
  const id = shardKey('mcpOAuthClients')
  const shard = (await loadShard(id)) || {}
  const slot = ensureMap(shard, serverId)
  slot.client_id = encrypt(info?.client_id)
  slot.client_secret = info?.client_secret ? encrypt(info.client_secret) : null
  slot.redirect_uris = info?.redirect_uris
  slot.grant_types = info?.grant_types
  slot.token_endpoint_auth_method = info?.token_endpoint_auth_method
  slot.registered_at = info?.registered_at || Date.now()
  await saveShard(id, shard)
}

export async function clearClientInfo(serverId) {
  const id = shardKey('mcpOAuthClients')
  const shard = (await loadShard(id)) || {}
  if (shard[serverId]) {
    delete shard[serverId]
    await saveShard(id, shard)
  }
}

export async function loadCodeVerifier(serverId) {
  const shard = await loadShard(shardKey('mcpOAuthVerifiers'))
  if (!shard) return undefined
  return shard[serverId] || undefined
}

export async function saveCodeVerifier(serverId, verifier) {
  const id = shardKey('mcpOAuthVerifiers')
  const shard = (await loadShard(id)) || {}
  const slot = ensureMap(shard, serverId)
  slot.value = verifier
  slot.updatedAt = Date.now()
  await saveShard(id, shard)
}

export async function clearCodeVerifier(serverId) {
  const id = shardKey('mcpOAuthVerifiers')
  const shard = (await loadShard(id)) || {}
  if (shard[serverId]) {
    delete shard[serverId]
    await saveShard(id, shard)
  }
}

export async function saveDiscoveryState(serverId, state) {
  const id = shardKey('mcpOAuthDiscovery')
  const shard = (await loadShard(id)) || {}
  shard[serverId] = state || {}
  await saveShard(id, shard)
}

export async function discoveryState(serverId) {
  const shard = await loadShard(shardKey('mcpOAuthDiscovery'))
  return shard ? shard[serverId] : undefined
}

export async function invalidateCredentials(serverId, scope = 'all') {
  switch (scope) {
    case 'all':
      await clearTokens(serverId)
      await clearClientInfo(serverId)
      await clearCodeVerifier(serverId)
      break
    case 'tokens':
      await clearTokens(serverId)
      break
    case 'client':
      await clearClientInfo(serverId)
      break
    case 'verifier':
      await clearCodeVerifier(serverId)
      break
    default:
      break
  }
}

export function isExpired(expiresAt, skewMs = 60_000) {
  if (!expiresAt) return false
  const exp = typeof expiresAt === 'number' ? expiresAt : Date.parse(expiresAt)
  if (!Number.isFinite(exp)) return false
  return Date.now() >= (exp - skewMs)
}

export async function clearAllOAuthData() {
  await Promise.all([
    dbStorageRemoveItem(shardKey('mcpOAuthTokens')),
    dbStorageRemoveItem(shardKey('mcpOAuthClients')),
    dbStorageRemoveItem(shardKey('mcpOAuthVerifiers')),
    dbStorageRemoveItem(shardKey('mcpOAuthDiscovery'))
  ])
}

export { decrypt, deriveKey, encrypt, getDeviceSeed, shardKey }
