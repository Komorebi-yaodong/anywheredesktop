import { onBeforeUnmount, ref, watch } from 'vue'

const MODEL_RESOLVER_URL = 'https://llm-model.141277.xyz/v1/resolve'
const RESOLVE_TIMEOUT_MS = 8000
const ICON_CDN_HOSTS = new Set([
  'cdn.jsdelivr.net',
  'fastly.jsdelivr.net',
  'gcore.jsdelivr.net',
  'unpkg.com'
])
const VERSIONED_ICON_PATH = /^(@lobehub\/icons-static-svg@\d+\.\d+\.\d+\/icons\/[a-z0-9_-]+\.svg)$/i

export function buildModelLogoCandidates(value) {
  if (typeof value !== 'string' || !value.trim()) return []
  let url
  try {
    url = new URL(value.trim())
  } catch {
    return []
  }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) return []

  const candidates = [url.href]
  // Mirror only an exact, version-pinned icon path. Never copy query strings or
  // arbitrary remote paths to another host, and never downgrade TLS on failure.
  if (
    url.protocol !== 'https:' ||
    url.port ||
    url.search ||
    url.hash ||
    !ICON_CDN_HOSTS.has(url.hostname)
  )
    return candidates
  const packagePath =
    url.hostname === 'unpkg.com'
      ? url.pathname.slice(1)
      : url.pathname.startsWith('/npm/')
        ? url.pathname.slice(5)
        : ''
  if (!VERSIONED_ICON_PATH.test(packagePath)) return candidates

  candidates.push(
    `https://fastly.jsdelivr.net/npm/${packagePath}`,
    `https://gcore.jsdelivr.net/npm/${packagePath}`,
    `https://unpkg.com/${packagePath}`
  )
  return [...new Set(candidates)]
}

export function useModelLogo(model) {
  const currentModelLogo = ref('')
  const modelLogoRequestId = ref(0)
  let candidates = []
  let candidateIndex = 0
  let resolveController = null

  const resolveModelLogo = async (modelValue) => {
    const requestId = ++modelLogoRequestId.value
    resolveController?.abort()
    resolveController = null
    candidates = []
    candidateIndex = 0
    currentModelLogo.value = ''
    const parts = String(modelValue || '').split('|')
    const modelName = (parts[1] || parts[0] || '').trim()
    if (!modelName) return

    const controller = new AbortController()
    resolveController = controller
    const timeoutId = setTimeout(() => controller.abort(), RESOLVE_TIMEOUT_MS)
    try {
      const response = await fetch(`${MODEL_RESOLVER_URL}?model=${encodeURIComponent(modelName)}`, {
        signal: controller.signal,
        credentials: 'omit'
      })
      if (!response.ok) throw new Error(`model_logo_http_${response.status}`)
      const payload = await response.json()
      if (requestId !== modelLogoRequestId.value || controller.signal.aborted) return
      candidates = buildModelLogoCandidates(payload?.resolved?.logo)
      currentModelLogo.value = candidates[0] || ''
    } catch {
      if (requestId === modelLogoRequestId.value) currentModelLogo.value = ''
    } finally {
      clearTimeout(timeoutId)
      if (resolveController === controller) resolveController = null
    }
  }

  const handleModelLogoError = (failedImage = {}) => {
    // The event carries the original keyed image's identity, not current props:
    // a delayed error from an old model/CDN must not clear a newer model's logo.
    if (
      failedImage.requestId !== modelLogoRequestId.value ||
      failedImage.url !== currentModelLogo.value
    )
      return
    candidateIndex += 1
    currentModelLogo.value = candidates[candidateIndex] || ''
  }

  const stopWatching = watch(model, resolveModelLogo, { immediate: true })
  onBeforeUnmount(() => {
    stopWatching()
    modelLogoRequestId.value += 1
    resolveController?.abort()
  })

  return { currentModelLogo, modelLogoRequestId, handleModelLogoError }
}
