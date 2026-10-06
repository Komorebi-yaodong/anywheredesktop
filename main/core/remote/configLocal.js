import { sanitizeRemoteSettingsForConfig } from './protocol.js'

const DEFAULT_REMOTE_SETTINGS = Object.freeze({
  enabled: false,
  host: '0.0.0.0',
  port: 17860,
  publicEndpoint: ''
})

function clone(value) {
  return JSON.parse(JSON.stringify(value))
}

function asObject(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {}
}

export function normalizeLocalRemoteSettings(value, fallback = DEFAULT_REMOTE_SETTINGS) {
  try {
    return sanitizeRemoteSettingsForConfig(asObject(value))
  } catch {
    return sanitizeRemoteSettingsForConfig(asObject(fallback))
  }
}

/**
 * Removes machine-local Remote listener settings from a shared config snapshot.
 * Paired-device credentials and identity keys are never part of either object.
 */
export function splitLocalRemoteSettings(fullConfig = {}, fallback = DEFAULT_REMOTE_SETTINGS) {
  const sharedConfig = clone(asObject(fullConfig))
  const remote = normalizeLocalRemoteSettings(sharedConfig.remote, fallback)
  delete sharedConfig.remote
  return { sharedConfig, remote }
}

/** Merge local Remote settings into a shared config snapshot for Desktop runtime/UI use. */
export function mergeLocalRemoteSettings(sharedConfig = {}, localConfig = {}, fallback = DEFAULT_REMOTE_SETTINGS) {
  const merged = clone(asObject(sharedConfig))
  const local = asObject(localConfig)
  merged.remote = normalizeLocalRemoteSettings(local.remote, fallback)
  return merged
}

/**
 * Full config saves/imports may update shared settings, but cannot overwrite the
 * current machine's listener state, port, bind host, or Tunnel endpoint.
 */
export function preserveLocalRemoteSettings(incomingConfig = {}, storedConfig = {}, fallback = DEFAULT_REMOTE_SETTINGS) {
  const next = clone(asObject(incomingConfig))
  next.remote = normalizeLocalRemoteSettings(asObject(storedConfig).remote, fallback)
  return next
}

export { DEFAULT_REMOTE_SETTINGS }
