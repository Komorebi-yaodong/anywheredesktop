import fs from 'node:fs/promises'
import path from 'node:path'
import { app } from 'electron'
import { autoUpdater } from 'electron-updater'

const GITHUB_UPDATE_FEED = {
  provider: 'github',
  owner: 'Komorebi-yaodong',
  repo: 'anywheredesktop',
  releaseType: 'release'
}

const UPDATE_CLEANUP_MARKER = 'updater-cleanup.json'

let configured = false
let activeCheckPromise = null
let activeDownloadPromise = null
let lastStatus = {
  state: 'idle',
  percent: 0,
  message: '',
  info: null,
  error: null
}

function parseVersionParts(version = '') {
  return String(version || '')
    .trim()
    .replace(/^v/i, '')
    .split(/[.-]/)
    .map((part) => (/^\d+$/.test(part) ? Number(part) : part))
}

function compareVersions(a = '', b = '') {
  const aParts = parseVersionParts(a)
  const bParts = parseVersionParts(b)
  const maxLength = Math.max(aParts.length, bParts.length)

  for (let index = 0; index < maxLength; index += 1) {
    const left = aParts[index]
    const right = bParts[index]

    if (left === undefined && right === undefined) return 0
    if (left === undefined) return typeof right === 'number' ? -1 : 1
    if (right === undefined) return typeof left === 'number' ? 1 : -1

    if (typeof left === 'number' && typeof right === 'number') {
      if (left > right) return 1
      if (left < right) return -1
      continue
    }

    if (typeof left === 'number') return 1
    if (typeof right === 'number') return -1

    const compared = String(left).localeCompare(String(right))
    if (compared !== 0) return compared > 0 ? 1 : -1
  }

  return 0
}

function normalizeError(error) {
  const message = error?.message || String(error || 'unknown_error')
  return {
    message,
    name: error?.name || '',
    stack: error?.stack || ''
  }
}

function normalizeReleaseNotes(releaseNotes = '') {
  if (Array.isArray(releaseNotes)) {
    return releaseNotes
      .map((item) => {
        if (typeof item === 'string') return item
        if (item && typeof item === 'object') {
          return [item.version ? `## ${item.version}` : '', item.note || item.notes || ''].filter(Boolean).join('\n\n')
        }
        return ''
      })
      .filter(Boolean)
      .join('\n\n')
  }
  return typeof releaseNotes === 'string' ? releaseNotes : ''
}

function normalizeUpdateInfo(info = null) {
  if (!info || typeof info !== 'object') return null
  return {
    version: typeof info.version === 'string' ? info.version : '',
    releaseName: typeof info.releaseName === 'string' ? info.releaseName : '',
    releaseDate: typeof info.releaseDate === 'string' ? info.releaseDate : '',
    releaseNotes: normalizeReleaseNotes(info.releaseNotes),
    files: Array.isArray(info.files)
      ? info.files.map((file) => ({
          url: typeof file?.url === 'string' ? file.url : '',
          sha512: typeof file?.sha512 === 'string' ? file.sha512 : '',
          size: Number.isFinite(file?.size) ? file.size : 0
        }))
      : []
  }
}

function setStatus(nextStatus = {}) {
  lastStatus = {
    ...lastStatus,
    ...nextStatus
  }
  return lastStatus
}

function isSupportedRuntime() {
  if (!app.isPackaged) {
    return {
      ok: false,
      reason: 'not_packaged',
      message: '自动更新仅在正式安装包中可用。'
    }
  }

  if (process.platform === 'linux' && !process.env.APPIMAGE) {
    return {
      ok: false,
      reason: 'linux_not_appimage',
      message: 'Linux 自动更新仅支持 AppImage 运行环境。'
    }
  }

  return { ok: true }
}

function configureAutoUpdater() {
  if (configured) return

  autoUpdater.autoDownload = false
  autoUpdater.autoInstallOnAppQuit = false
  autoUpdater.allowPrerelease = false
  autoUpdater.allowDowngrade = false
  autoUpdater.disableWebInstaller = true
  autoUpdater.setFeedURL(GITHUB_UPDATE_FEED)

  autoUpdater.on('checking-for-update', () => {
    setStatus({ state: 'checking', percent: 0, message: '正在连接 GitHub 检查更新...', error: null })
  })

  autoUpdater.on('update-available', (info) => {
    setStatus({ state: 'available', percent: 0, message: '发现新版本。', info: normalizeUpdateInfo(info), error: null })
  })

  autoUpdater.on('update-not-available', (info) => {
    setStatus({ state: 'not-available', percent: 0, message: '当前已是最新版本。', info: normalizeUpdateInfo(info), error: null })
  })

  autoUpdater.on('download-progress', (progress = {}) => {
    const percent = Number.isFinite(progress.percent) ? Math.max(0, Math.min(100, progress.percent)) : 0
    setStatus({
      state: 'downloading',
      percent,
      message: `正在下载更新 ${percent.toFixed(1)}%`,
      error: null
    })
  })

  autoUpdater.on('update-downloaded', (info) => {
    setStatus({ state: 'downloaded', percent: 100, message: '更新已下载，等待安装确认。', info: normalizeUpdateInfo(info), error: null })
  })

  autoUpdater.on('error', (error) => {
    setStatus({
      state: 'error',
      message: '连接 GitHub 或下载更新失败。',
      error: normalizeError(error)
    })
  })

  configured = true
}

function buildNotAvailableResult(updateInfo = null) {
  const normalizedInfo = normalizeUpdateInfo(updateInfo) || updateInfo
  setStatus({ state: 'not-available', percent: 0, message: '当前已是最新版本。', info: normalizedInfo, error: null })
  return {
    ok: true,
    state: 'not-available',
    hasUpdate: false,
    currentVersion: app.getVersion(),
    latestVersion: normalizedInfo?.version || app.getVersion(),
    message: '当前已是最新版本。',
    info: normalizedInfo,
    platform: process.platform,
    arch: process.arch
  }
}

function buildAvailableResult(updateInfo = null) {
  const normalizedInfo = normalizeUpdateInfo(updateInfo)
  setStatus({ state: 'available', percent: 0, message: '发现新版本。', info: normalizedInfo, error: null })
  return {
    ok: true,
    state: 'available',
    hasUpdate: true,
    currentVersion: app.getVersion(),
    latestVersion: normalizedInfo?.version || '',
    message: '发现新版本。',
    info: normalizedInfo,
    platform: process.platform,
    arch: process.arch
  }
}

export function getUpdateStatus() {
  return {
    ok: true,
    ...lastStatus,
    currentVersion: app.getVersion(),
    latestVersion: lastStatus.info?.version || '',
    hasUpdate: lastStatus.state === 'available' || lastStatus.state === 'downloading' || lastStatus.state === 'downloaded',
    platform: process.platform,
    arch: process.arch,
    feed: { ...GITHUB_UPDATE_FEED }
  }
}

export async function checkForAppUpdate() {
  const supported = isSupportedRuntime()
  if (!supported.ok) {
    return {
      ok: false,
      reason: supported.reason,
      message: supported.message,
      currentVersion: app.getVersion(),
      platform: process.platform,
      arch: process.arch
    }
  }

  configureAutoUpdater()

  if (activeCheckPromise) {
    return activeCheckPromise
  }

  activeCheckPromise = (async () => {
    try {
      setStatus({ state: 'checking', percent: 0, message: '正在连接 GitHub 检查更新...', error: null })
      const checkResult = await autoUpdater.checkForUpdates()
      const updateInfo = normalizeUpdateInfo(checkResult?.updateInfo)

      if (!checkResult?.updateInfo || compareVersions(updateInfo?.version || '', app.getVersion()) <= 0) {
        return buildNotAvailableResult(updateInfo)
      }

      return buildAvailableResult(checkResult.updateInfo)
    } catch (error) {
      const normalizedError = normalizeError(error)
      setStatus({
        state: 'error',
        message: '无法访问 GitHub 或检查更新失败。',
        error: normalizedError
      })
      return {
        ok: false,
        state: 'error',
        reason: 'github_update_check_failed',
        message: '无法访问 GitHub 或检查更新失败，请确认当前网络可以访问 GitHub Releases。',
        error: normalizedError,
        currentVersion: app.getVersion(),
        platform: process.platform,
        arch: process.arch
      }
    } finally {
      activeCheckPromise = null
    }
  })()

  return activeCheckPromise
}

export async function downloadAppUpdate() {
  const supported = isSupportedRuntime()
  if (!supported.ok) {
    return {
      ok: false,
      reason: supported.reason,
      message: supported.message,
      currentVersion: app.getVersion(),
      platform: process.platform,
      arch: process.arch
    }
  }

  configureAutoUpdater()

  if (activeDownloadPromise) {
    return activeDownloadPromise
  }

  activeDownloadPromise = (async () => {
    try {
      if (!lastStatus.info?.version || compareVersions(lastStatus.info.version, app.getVersion()) <= 0) {
        const checkResult = await checkForAppUpdate()
        if (!checkResult?.ok || !checkResult?.hasUpdate) return checkResult
      }

      setStatus({ state: 'downloading', percent: 0, message: '正在从 GitHub 下载更新...', error: null })
      await autoUpdater.downloadUpdate()

      return {
        ok: true,
        state: 'downloaded',
        hasUpdate: true,
        currentVersion: app.getVersion(),
        latestVersion: lastStatus.info?.version || '',
        message: '更新已下载，重启后将自动安装。',
        info: lastStatus.info,
        platform: process.platform,
        arch: process.arch
      }
    } catch (error) {
      const normalizedError = normalizeError(error)
      setStatus({
        state: 'error',
        message: '无法访问 GitHub 或下载更新失败。',
        error: normalizedError
      })
      return {
        ok: false,
        state: 'error',
        reason: 'github_update_download_failed',
        message: '无法访问 GitHub 或下载更新失败，请确认当前网络可以访问 GitHub Releases。',
        error: normalizedError,
        currentVersion: app.getVersion(),
        platform: process.platform,
        arch: process.arch
      }
    } finally {
      activeDownloadPromise = null
    }
  })()

  return activeDownloadPromise
}

export async function clearDownloadedUpdateCache() {
  try {
    const cacheDir = autoUpdater.downloadedUpdateHelper?.cacheDir
    if (!cacheDir) return { ok: true, skipped: true, reason: 'cache_dir_unavailable' }
    const resolvedCacheDir = path.resolve(cacheDir)
    const userDataDir = path.resolve(app.getPath('userData'))
    if (!resolvedCacheDir.startsWith(userDataDir)) {
      return { ok: false, skipped: true, reason: 'cache_dir_outside_user_data' }
    }
    await fs.rm(resolvedCacheDir, { recursive: true, force: true })
    setStatus({ state: 'idle', percent: 0, message: '', info: null, error: null })
    return { ok: true, cleared: true, cacheDir: resolvedCacheDir }
  } catch (error) {
    return { ok: false, reason: 'clear_cache_failed', error: normalizeError(error) }
  }
}

export function installDownloadedUpdate() {
  try {
    configureAutoUpdater()
    autoUpdater.quitAndInstall(false, true)
    return {
      ok: true,
      state: 'installing',
      message: '正在退出并安装更新。'
    }
  } catch (error) {
    const normalizedError = normalizeError(error)
    setStatus({ state: 'error', message: '安装更新失败。', error: normalizedError })
    return {
      ok: false,
      state: 'error',
      reason: 'install_failed',
      message: '安装更新失败。',
      error: normalizedError
    }
  }
}

export const startAppUpdate = downloadAppUpdate
