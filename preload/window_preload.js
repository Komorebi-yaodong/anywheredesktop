import { contextBridge, webUtils, webFrame } from 'electron'
import path from 'node:path'
import fs from 'node:fs'
import os from 'node:os'
import { electronAPI } from '@electron-toolkit/preload'
import { createChatCompletion, getRandomItem, listProviderModels } from '../main/core/chat.js'

const defaultWindowType = 'window'
let windowType = defaultWindowType
let senderId = null
let latestInitMessage = null

const signalStore = new Map()
const callbackStore = new Map()

const defaultConfig = {
  config: {
    defaultTaskModel: '',
    tasks: {},
    providers: {
      '0': {
        name: 'default',
        url: 'https://api.openai.com/v1',
        api_key: '',
        apiType: 'chat_completions',
        modelList: [],
        enable: true
      }
    },
    providerOrder: ['0'],
    providerFolders: {},
    prompts: {
      AI: {
        type: 'over',
        prompt: '你是一个AI助手',
        showMode: 'window',
        model: '0|gpt-4o',
        enable: true,
        icon: '',
        stream: true,
        temperature: 0.7,
        isTemperature: false,
        isDirectSend_file: false,
        isDirectSend_normal: true,
        isDirectSend_image: true,
        ifTextNecessary: false,
        voice: null,
        reasoning_effort: 'default',
        defaultMcpServers: [],
        defaultSkills: [],
        window_width: 580,
        window_height: 740,
        position_x: 0,
        position_y: 0,
        autoCloseOnBlur: true,
        isAlwaysOnTop: true,
        autoSaveChat: false
      }
    },
    settingsCardOrder: ['general', 'voice', 'data', 'webdav'],
    settingsCardCollapsed: {
      general: false,
      voice: false,
      data: false,
      webdav: false
    },
    fastWindowPosition: { x: 0, y: 0 },
    mcpServers: {},
    skillPath: '',
    language: 'zh',
    tags: {},
    skipLineBreak: false,
    CtrlEnterToSend: false,
    isDarkMode: false,
    themeMode: 'system',
    fix_position: false,
    isAlwaysOnTop_global: true,
    autoCloseOnBlur_global: true,
    autoSaveChat_global: false,
    zoom: 1,
    webdav: {
      url: '',
      username: '',
      password: '',
      path: '/anywhere',
      data_path: '/anywhere_data',
      localChatPath: ''
    },
    voiceList: [
      'alloy-👩', 'echo-👨‍🦰清晰', 'nova-👩清晰', 'sage-👧年轻', 'shimmer-👧明亮', 'fable-😐中性',
      'coral-👩客服', 'ash-🧔‍♂️商业', 'ballad-👨故事', 'verse-👨诗歌', 'onyx-👨‍🦰新闻', 'Zephyr-👧明亮',
      'Puck-👦欢快', 'Charon-👦信息丰富', 'Kore-👩坚定', 'Fenrir-👨‍🦰易激动', 'Leda-👧年轻', 'Orus-👨‍🦰鉴定',
      'Aoede-👩轻松', 'Callirrhoe-👩随和', 'Autonoe-👩明亮', 'Enceladus-🧔‍♂️呼吸感', 'Iapetus-👦清晰',
      'Umbriel-👦随和', 'Algieba-👦平滑', 'Despina-👩平滑', 'Erinome-👩清晰', 'Algenib-👨‍🦰沙哑',
      'Rasalgethi-👨‍🦰信息丰富', 'Laomedeia-👩欢快', 'Achernar-👩轻柔', 'Alnilam-👦坚定', 'Schedar-👦平稳',
      'Gacrux-👩成熟', 'Pulcherrima-👩向前', 'Achird-👦友好', 'Zubenelgenubi-👦休闲', 'Vindemiatrix-👩温柔',
      'Sadachbia-👨‍🦰活泼', 'Sadaltager-👨‍🦰博学', 'Sulafat-👩温暖'
    ]
  }
}

function makeId(prefix) {
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`
}

function resolveSignalToken(token) {
  if (typeof token !== 'string' || !token) return null
  return signalStore.get(token) || null
}

function bindSignalAbortForwarding(token) {
  const signal = resolveSignalToken(token)
  if (!signal) return
  signal.addEventListener('abort', () => {
    electronAPI.ipcRenderer.send('window:signal-abort', token)
  }, { once: true })
}

function registerSignal(signal) {
  if (!signal || typeof signal !== 'object') return null
  const token = makeId('signal')
  signalStore.set(token, signal)
  bindSignalAbortForwarding(token)
  return token
}

function unregisterSignal(token) {
  if (typeof token === 'string' && token) signalStore.delete(token)
}

function registerCallback(callback) {
  if (typeof callback !== 'function') return null
  const token = makeId('callback')
  callbackStore.set(token, callback)
  return token
}

function resolveCallback(token) {
  if (typeof token !== 'string' || !token) return null
  return callbackStore.get(token) || null
}

function unregisterCallback(token) {
  if (typeof token === 'string' && token) callbackStore.delete(token)
}

function toPlainPayload(value) {
  if (value === undefined) return undefined
  return JSON.parse(JSON.stringify(value))
}

function invokeOrThrow(channel, ...args) {
  return electronAPI.ipcRenderer.invoke(channel, ...args).then((result) => {
    if (result && typeof result === 'object' && result.ok === false) {
      const message =
        (result.error && typeof result.error === 'object' && result.error.message) ||
        (typeof result.error === 'string' ? result.error : '') ||
        `IPC invoke failed: ${channel}`
      throw new Error(message)
    }
    return result
  })
}

function decodeSerializedBinary(value) {
  if (!value || typeof value !== 'object') return value
  if (value.__type === 'Buffer' && typeof value.data === 'string') {
    return Uint8Array.from(atob(value.data), (char) => char.charCodeAt(0))
  }
  return value
}

const debugPreloadLog = () => {}
const debugPreloadError = () => {}


electronAPI.ipcRenderer.on('window:init', (_event, data = {}) => {
  latestInitMessage = data
  if (typeof data.windowType === 'string' && data.windowType) {
    windowType = data.windowType
  }
  if (typeof data.senderId === 'string' && data.senderId) {
    senderId = data.senderId
  }
})

electronAPI.ipcRenderer.on('window:callback', (_event, data = {}) => {
  const callback = resolveCallback(data?.token)
  if (callback) callback(data?.payload)
})

async function handleCodeClick(text) {
  if (!text || typeof text !== 'string') return 'copied'

  const content = text.trim().replace(/^["']|["']$/g, '')
  if (/^https?:\/\//i.test(content) || /^mailto:/i.test(content)) {
    await electronAPI.ipcRenderer.invoke('system:shell:openExternal', content)
    return 'opened-url'
  }

  try {
    let resolvedPath = content
    if (content.startsWith('~')) {
      resolvedPath = path.join(os.homedir(), content.slice(1))
    }

    const isLikelyPath =
      /^[a-zA-Z]:[\\/]/.test(resolvedPath) ||
      resolvedPath.startsWith('/') ||
      resolvedPath.startsWith('./') ||
      resolvedPath.startsWith('../') ||
      resolvedPath.includes(path.sep)

    if (isLikelyPath && fs.existsSync(resolvedPath)) {
      await electronAPI.ipcRenderer.invoke('system:shell:openPath', resolvedPath)
      return 'opened-path'
    }
  } catch {
    // ignore path detection failure
  }

  await electronAPI.ipcRenderer.invoke('system:clipboard:copyText', text)
  return 'copied'
}

const api = {
  appWindowType: defaultWindowType,
  defaultConfig,

  getUser: () => invokeOrThrow('data:getUser'),

  getDefaultUserAvatar: () => invokeOrThrow('data:getUser').then((user) => user?.avatar || ''),
  getDefaultAiAvatar: () => 'file:///E:/Programming/Anywhere_desktop/resources/icon.png',

  openWindow: (type, payload = null) => electronAPI.ipcRenderer.invoke('window:open', type, payload),
  showMainWindow: () => electronAPI.ipcRenderer.invoke('window:showMain'),
  hideMainWindow: () => electronAPI.ipcRenderer.invoke('window:hideMain'),
  listWindows: (type = '') => electronAPI.ipcRenderer.invoke('window:list', type),
  emitWindowEvent: (input) => electronAPI.ipcRenderer.invoke('window:event:emit', input),
  onWindowEvent: (callback) => {
    if (typeof callback !== 'function') return
    electronAPI.ipcRenderer.on('window:event-bus', (_event, data) => callback(data))
  },
  onWindowInit: (callback) => {
    if (typeof callback !== 'function') return
    if (latestInitMessage) callback(latestInitMessage)
    electronAPI.ipcRenderer.on('window:init', (_event, data) => callback(data))
  },
  getWindowContext: () => ({ appWindowType: windowType, senderId }),
  getDroppedFilePath: (file) => {
    try {
      return webUtils.getPathForFile(file) || ''
    } catch {
      return ''
    }
  },

  copyText: (text) => electronAPI.ipcRenderer.invoke('system:clipboard:copyText', text),
  copyImage: (input) => {
    const normalizedInput = typeof input === 'string' && input.startsWith('data:image/') ? { dataUrl: input } : input
    return electronAPI.ipcRenderer.invoke('system:clipboard:copyImage', normalizedInput)
  },
  readClipboardText: async () => {
    const result = await electronAPI.ipcRenderer.invoke('system:clipboard:readText')
    return result?.text ?? ''
  },
  showOpenDialog: (options) => electronAPI.ipcRenderer.invoke('system:dialog:open', options),
  showSaveDialog: (options) => electronAPI.ipcRenderer.invoke('system:dialog:save', options),
  shellOpenPath: (targetPath) => electronAPI.ipcRenderer.invoke('system:shell:openPath', targetPath),
  shellShowItemInFolder: (targetPath) => electronAPI.ipcRenderer.invoke('system:shell:showItemInFolder', targetPath),
  shellOpenExternal: (url) => electronAPI.ipcRenderer.invoke('system:shell:openExternal', url),
  desktopCaptureSources: async (options) => {
    const result = await electronAPI.ipcRenderer.invoke('system:desktop:getSources', options)
    return result?.sources || []
  },
  getDesktopSources: (options) => electronAPI.ipcRenderer.invoke('system:desktop:getSources', options),
  setZoomFactor: (factor) => {
    const numericFactor = Number(factor)
    if (!Number.isFinite(numericFactor) || numericFactor <= 0) {
      return false
    }
    webFrame.setZoomFactor(numericFactor)
    return true
  },

  dbIsReady: () => electronAPI.ipcRenderer.invoke('db:isReady'),
  dbStats: () => electronAPI.ipcRenderer.invoke('db:stats'),
  dbGet: (id) => electronAPI.ipcRenderer.invoke('db:get', id),
  dbPut: (doc) => electronAPI.ipcRenderer.invoke('db:put', doc),
  dbRemove: (id, rev = '') => electronAPI.ipcRenderer.invoke('db:remove', id, rev),
  dbAllDocs: (options) => electronAPI.ipcRenderer.invoke('db:allDocs', options),
  dbBulkDocs: (docs) => electronAPI.ipcRenderer.invoke('db:bulkDocs', docs),
  dbPostAttachment: (input) => electronAPI.ipcRenderer.invoke('db:postAttachment', input),
  dbGetAttachment: (input) => electronAPI.ipcRenderer.invoke('db:getAttachment', input),
  dbStorageSetItem: (key, value) => electronAPI.ipcRenderer.invoke('dbStorage:setItem', key, value),
  dbStorageGetItem: (key, fallback = null) => electronAPI.ipcRenderer.invoke('dbStorage:getItem', key, fallback),
  dbStorageRemoveItem: (key) => electronAPI.ipcRenderer.invoke('dbStorage:removeItem', key),
  dbStorageListKeys: () => electronAPI.ipcRenderer.invoke('dbStorage:listKeys'),

  getConfig: () => electronAPI.ipcRenderer.invoke('data:getConfig'),
  saveSetting: (keyPath, value) => electronAPI.ipcRenderer.invoke('data:saveSetting', keyPath, value),
  updateConfig: (nextConfig) => electronAPI.ipcRenderer.invoke('data:updateConfig', nextConfig),
  updateConfigWithoutFeatures: (nextConfig) => electronAPI.ipcRenderer.invoke('data:updateConfigWithoutFeatures', nextConfig),
  exportMemoryData: () => electronAPI.ipcRenderer.invoke('data:exportMemoryData'),
  importMemoryData: (memories) => electronAPI.ipcRenderer.invoke('data:importMemoryData', memories),
  coderedirect: (label = '', payload = null) => electronAPI.ipcRenderer.invoke('data:coderedirect', label, payload),
  runTaskNow: (taskId = '') => electronAPI.ipcRenderer.invoke('data:runTaskNow', taskId),
  savePromptWindowSettings: async (promptKey, settings) => {
    debugPreloadLog('savePromptWindowSettings:before', { promptKey, settings })
    try {
      const result = await electronAPI.ipcRenderer.invoke('data:savePromptWindowSettings', promptKey, settings)
      debugPreloadLog('savePromptWindowSettings:after', result)
      return result
    } catch (error) {
      debugPreloadError('savePromptWindowSettings:error', error)
      throw error
    }
  },
  addTaskHistory: (taskId, logEntry) => electronAPI.ipcRenderer.invoke('data:addTaskHistory', taskId, logEntry),
  getCachedBackgroundImage: async (url) => decodeSerializedBinary(await electronAPI.ipcRenderer.invoke('data:getCachedBackgroundImage', url)),
  cacheBackgroundImage: (url) => electronAPI.ipcRenderer.invoke('data:cacheBackgroundImage', url),

  createChatCompletion: async (params = {}) => {
    const signalToken = registerSignal(params?.signal)
    try {
      const nextParams = { ...params }
      delete nextParams.signal
      return await createChatCompletion({ ...nextParams, signal: resolveSignalToken(signalToken) })
    } finally {
      unregisterSignal(signalToken)
    }
  },
  getRandomItem,
  listProviderModels,

  getMcpToolCache: async () => {
    const result = await electronAPI.ipcRenderer.invoke('mcp:getToolCache')
    return result?.cache || result || {}
  },
  saveMcpToolCache: (serverId, tools = []) => electronAPI.ipcRenderer.invoke('mcp:saveToolCache', serverId, toPlainPayload(tools) || []),
  initializeMcpClient: (activeServerConfigs = {}) => electronAPI.ipcRenderer.invoke('mcp:initializeClient', toPlainPayload(activeServerConfigs) || {}),
  testMcpConnection: (serverConfig = {}) => electronAPI.ipcRenderer.invoke('mcp:testConnection', toPlainPayload(serverConfig) || {}),
  testInvokeMcpTool: (serverConfig = {}, toolName = '', args = {}) => electronAPI.ipcRenderer.invoke('mcp:testInvokeTool', toPlainPayload(serverConfig) || {}, toolName, toPlainPayload(args) || {}),
  invokeMcpTool: async (toolName = '', toolArgs = {}, signal = null, context = null) => {
    const signalToken = registerSignal(signal)
    const callbackToken = registerCallback(context?.onUpdate)
    const nextContext = context && typeof context === 'object'
      ? { ...toPlainPayload(context), senderId: context.senderId || senderId || null }
      : senderId
        ? { senderId }
        : null

    if (nextContext && callbackToken) delete nextContext.onUpdate

    try {
      const result = await electronAPI.ipcRenderer.invoke('mcp:invokeToolLive', toolName, toPlainPayload(toolArgs) || {}, {
        signalToken,
        callbackToken,
        aborted: Boolean(signal?.aborted),
        context: nextContext
      })

      if (result && typeof result === 'object' && result.ok === false) {
        const message =
          (result.error && typeof result.error === 'object' && result.error.message) ||
          (typeof result.error === 'string' ? result.error : '') ||
          'MCP invoke failed'
        const error = new Error(message)
        error.name = result.error?.name || 'Error'
        error.details = result.error || null
        throw error
      }

      return result
    } finally {
      unregisterSignal(signalToken)
      unregisterCallback(callbackToken)
    }
  },
  closeMcpClient: () => electronAPI.ipcRenderer.invoke('mcp:closeClient'),

  listSkills: (skillRootPath = '') => invokeOrThrow('skill:list', skillRootPath),
  getSkillDetails: (skillRootPath = '', skillId = '') => invokeOrThrow('skill:getDetails', skillRootPath, skillId),
  saveSkill: (skillRootPath = '', skillId = '', content = '') => invokeOrThrow('skill:save', skillRootPath, skillId, content),
  deleteSkill: (skillRootPath = '', skillId = '') => invokeOrThrow('skill:delete', skillRootPath, skillId),
  exportSkillToPackage: (skillRootPath = '', skillId = '', outputDir = '') => invokeOrThrow('skill:exportPackage', skillRootPath, skillId, outputDir),
  extractSkillPackage: (filePath = '') => invokeOrThrow('skill:extractPackage', filePath),
  getSkillToolDefinition: (skillRootPath = '', enabledSkillNames = []) => invokeOrThrow('skill:getToolDefinition', skillRootPath, enabledSkillNames),
  resolveSkillInvocation: async (skillRootPath = '', skillName = '', toolArgsObj = {}, globalContext = null, signal = null) => {
    const signalToken = registerSignal(signal)
    const callbackToken = registerCallback(globalContext?.onUpdate)
    const nextContext = globalContext && typeof globalContext === 'object'
      ? { ...toPlainPayload(globalContext), senderId: globalContext.senderId || senderId || null }
      : null

    if (nextContext && callbackToken) delete nextContext.onUpdate

    try {
      return await electronAPI.ipcRenderer.invoke('skill:resolveInvocationLive', skillRootPath, skillName, toPlainPayload(toolArgsObj) || {}, {
        signalToken,
        callbackToken,
        aborted: Boolean(signal?.aborted),
        context: nextContext
      })
    } finally {
      unregisterSignal(signalToken)
      unregisterCallback(callbackToken)
    }
  },
  pathJoin: (...args) => path.join(...args),
  toggleSkillForkMode: (skillRootPath = '', skillId = '', enableFork = false) => invokeOrThrow('skill:toggleForkMode', skillRootPath, skillId, enableFork),

  handleFilePath: (filePath) => invokeOrThrow('file:handleFilePath', filePath),
  sendfileDirect: (filePathList) => invokeOrThrow('file:sendfileDirect', filePathList),
  saveFile: (options) => invokeOrThrow('file:saveFile', options),
  selectDirectory: () => invokeOrThrow('file:selectDirectory'),
  listJsonFiles: (dirPath) => invokeOrThrow('file:listJsonFiles', dirPath),
  readLocalFile: (filePath, options = {}) => invokeOrThrow('file:readLocalFile', filePath, options),
  renameLocalFile: (oldPath, newPath) => invokeOrThrow('file:renameLocalFile', oldPath, newPath),
  deleteLocalFile: (filePath) => invokeOrThrow('file:deleteLocalFile', filePath),
  writeLocalFile: (filePath, content, options = {}) => invokeOrThrow('file:writeLocalFile', filePath, content, options),
  setFileMtime: (filePath, mtime) => invokeOrThrow('file:setFileMtime', filePath, mtime),
  isFileTypeSupported: (fileName) => invokeOrThrow('file:isFileTypeSupported', fileName),
  probeFilePathSupport: (filePath) => invokeOrThrow('file:probePathSupport', filePath),
  parseFileObject: (fileObj) => invokeOrThrow('file:parseFileObject', fileObj),
  copyLocalPath: (srcPath, destPath) => invokeOrThrow('file:copyLocalPath', srcPath, destPath),

  readRemoteText: (url, options = {}) => invokeOrThrow('file:readRemoteText', url, options),
  readRemoteBinary: (url, options = {}) => invokeOrThrow('file:readRemoteBinary', url, options),

  readRemoteText: (url, options = {}) => invokeOrThrow('file:readRemoteText', url, options),
  readRemoteBinary: (url, options = {}) => invokeOrThrow('file:readRemoteBinary', url, options),

  readRemoteText: (url, options = {}) => invokeOrThrow('file:readRemoteText', url, options),
  readRemoteBinary: (url, options = {}) => invokeOrThrow('file:readRemoteBinary', url, options),

  listWebdavBackups: (input = {}) => electronAPI.ipcRenderer.invoke('webdav:listBackups', input),
  writeWebdavBackup: (input = {}) => electronAPI.ipcRenderer.invoke('webdav:writeBackup', input),
  readWebdavBackup: (input = {}) => electronAPI.ipcRenderer.invoke('webdav:readBackup', input),
  moveWebdavFile: (input = {}) => electronAPI.ipcRenderer.invoke('webdav:moveFile', input),
  deleteWebdavBackup: (input = {}) => electronAPI.ipcRenderer.invoke('webdav:deleteBackup', input),
  deleteWebdavBackups: (input = {}) => electronAPI.ipcRenderer.invoke('webdav:deleteBackups', input),

  handleCodeClick,
  minimizeWindow: (windowRef = '') => electronAPI.ipcRenderer.invoke('window:minimize', { windowRef }),
  maximizeOrRestoreWindow: (windowRef = '') => electronAPI.ipcRenderer.invoke('window:maximizeOrRestore', { windowRef }),
  closeWindow: (windowRef = '') => {
    electronAPI.ipcRenderer.send('window:close', { windowRef })
    return Promise.resolve({ ok: true, action: 'close', windowRef: windowRef || null, dispatched: true })
  },
  toggleAlwaysOnTop: (payload = {}) => {
    const input = typeof payload === 'boolean' ? { alwaysOnTop: payload } : payload && typeof payload === 'object' ? payload : {}
    return electronAPI.ipcRenderer.invoke('window:toggleAlwaysOnTop', input)
  },
  windowControl: async (action, windowRef = '') => {
    const actionMap = {
      'minimize-window': 'window:minimize',
      minimize: 'window:minimize',
      'maximize-window': 'window:maximizeOrRestore',
      maximize: 'window:maximizeOrRestore',
      'close-window': 'window:close',
      close: 'window:close'
    }
    const channel = actionMap[action]
    if (!channel) {
      const unsupported = { ok: false, error: 'unsupported_window_action', action }
      debugPreloadError('windowControl:unsupported', unsupported)
      return Promise.resolve(unsupported)
    }
    debugPreloadLog('windowControl:before', { action, channel, windowRef })
    try {
      if (channel === 'window:close') {
        electronAPI.ipcRenderer.send(channel, { windowRef })
        const result = { ok: true, action: 'close', windowRef: windowRef || null, dispatched: true }
        debugPreloadLog('windowControl:after', { action, channel, windowRef, result })
        return result
      }
      const result = await electronAPI.ipcRenderer.invoke(channel, { windowRef })
      debugPreloadLog('windowControl:after', { action, channel, windowRef, result })
      return result
    } catch (error) {
      debugPreloadError('windowControl:error', { action, channel, windowRef, error })
      throw error
    }
  },
  onAlwaysOnTopChanged: (callback) => {
    if (typeof callback !== 'function') return
    electronAPI.ipcRenderer.on('window:alwaysOnTopChanged', (_event, payload) => callback(payload?.alwaysOnTop ?? payload))
    electronAPI.ipcRenderer.on('always-on-top-changed', (_event, payload) => callback(payload))
  },
  onConfigUpdated: (callback) => {
    if (typeof callback !== 'function') return
    electronAPI.ipcRenderer.on('window:configUpdated', (_event, newConfig) => callback(newConfig))
    electronAPI.ipcRenderer.on('config-updated', (_event, newConfig) => callback(newConfig))
  },
  onMcpCacheUpdated: (callback) => {
    if (typeof callback !== 'function') return
    electronAPI.ipcRenderer.on('window:mcpCacheUpdated', (_event, serverId) => callback(serverId))
    electronAPI.ipcRenderer.on('mcp-cache-updated', (_event, serverId) => callback(serverId))
  },
  onSkillsUpdated: (callback) => {
    if (typeof callback !== 'function') return
    electronAPI.ipcRenderer.on('window:skillsUpdated', () => callback())
    electronAPI.ipcRenderer.on('skills-updated', () => callback())
  }
}

const preloadCompat = {
  receiveMsg: (callback) => {
    if (typeof callback !== 'function') return
    if (latestInitMessage) callback(latestInitMessage)
    electronAPI.ipcRenderer.on('window:init', (_event, data) => callback(data))
  },
  onAppendMessage: (callback) => {
    if (typeof callback !== 'function') return
    electronAPI.ipcRenderer.on('window:event-bus', (_event, envelope) => {
      const eventName = envelope?.event
      if (eventName === 'coderedirect' || eventName === 'append-message' || eventName === 'window-append-msg') {
        callback(envelope?.payload ?? envelope)
      }
      if (eventName === 'task:run-now') {
        callback(envelope)
      }
    })
    electronAPI.ipcRenderer.on('window-append-msg', (_event, data) => callback(data))
  }
}

if (process.contextIsolated) {
  try {
    contextBridge.exposeInMainWorld('electron', electronAPI)
    contextBridge.exposeInMainWorld('api', api)
    contextBridge.exposeInMainWorld('preload', preloadCompat)
  } catch (error) {
    console.error('[preload:window]', error)
  }
} else {
  window.electron = electronAPI
  window.api = api
  window.preload = preloadCompat
}
