import { contextBridge, webUtils } from 'electron'
import path from 'node:path'
import { electronAPI } from '@electron-toolkit/preload'

const defaultWindowType = 'main'
let windowType = defaultWindowType
let windowSenderId = 'main'


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


electronAPI.ipcRenderer.on('window:init', (_event, data = {}) => {
  if (typeof data.windowType === 'string' && data.windowType) {
    windowType = data.windowType
  }

  if (typeof data.senderId === 'string' && data.senderId) {
    windowSenderId = data.senderId
  }
})

const api = {
  appWindowType: defaultWindowType,
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
    electronAPI.ipcRenderer.on('window:init', (_event, data) => callback(data))
  },
  getWindowContext: () => ({
    appWindowType: windowType,
    senderId: windowSenderId
  }),
  getDroppedFilePath: (file) => {
    try {
      const resolvedPath = webUtils.getPathForFile(file)
      return resolvedPath || ''
    } catch {
      return ''
    }
  },

  copyText: (text) => electronAPI.ipcRenderer.invoke('system:clipboard:copyText', text),
  copyImage: (input) => electronAPI.ipcRenderer.invoke('system:clipboard:copyImage', input),
  readClipboardText: () => electronAPI.ipcRenderer.invoke('system:clipboard:readText'),
  readClipboardPayload: () => electronAPI.ipcRenderer.invoke('system:clipboard:readPayload'),
  captureSelectionPayload: () => electronAPI.ipcRenderer.invoke('system:clipboard:captureSelection'),
  showOpenDialog: (options) => electronAPI.ipcRenderer.invoke('system:dialog:open', options),
  showSaveDialog: (options) => electronAPI.ipcRenderer.invoke('system:dialog:save', options),
  shellOpenPath: (targetPath) => electronAPI.ipcRenderer.invoke('system:shell:openPath', targetPath),
  shellShowItemInFolder: (targetPath) =>
    electronAPI.ipcRenderer.invoke('system:shell:showItemInFolder', targetPath),
  shellOpenExternal: (url) => electronAPI.ipcRenderer.invoke('system:shell:openExternal', url),
  getDesktopSources: (options) => electronAPI.ipcRenderer.invoke('system:desktop:getSources', options),
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
  dbStorageGetItem: (key, fallback = null) =>
    electronAPI.ipcRenderer.invoke('dbStorage:getItem', key, fallback),
  dbStorageRemoveItem: (key) => electronAPI.ipcRenderer.invoke('dbStorage:removeItem', key),
  dbStorageListKeys: () => electronAPI.ipcRenderer.invoke('dbStorage:listKeys'),
  getConfig: () => electronAPI.ipcRenderer.invoke('data:getConfig'),
  saveSetting: (keyPath, value) => electronAPI.ipcRenderer.invoke('data:saveSetting', keyPath, value),
  updateConfig: (nextConfig) => electronAPI.ipcRenderer.invoke('data:updateConfig', nextConfig),
  updateConfigWithoutFeatures: (nextConfig) =>
    electronAPI.ipcRenderer.invoke('data:updateConfigWithoutFeatures', nextConfig),
  restoreImportedConfig: (importedConfig) =>
    electronAPI.ipcRenderer.invoke('data:restoreImportedConfig', importedConfig),
  exportMemoryData: () => electronAPI.ipcRenderer.invoke('data:exportMemoryData'),
  importMemoryData: (memories) => electronAPI.ipcRenderer.invoke('data:importMemoryData', memories),

  coderedirect: (label = '', payload = null) =>
    electronAPI.ipcRenderer.invoke('data:coderedirect', label, payload),
  runTaskNow: (taskId = '') => electronAPI.ipcRenderer.invoke('data:runTaskNow', taskId),

  createChatCompletion: (params = {}) =>
    electronAPI.ipcRenderer.invoke('chat:createCompletion', params),

  getRandomItem: (list = '') => electronAPI.ipcRenderer.invoke('chat:getRandomItem', list),

  listProviderModels: (input = {}) => electronAPI.ipcRenderer.invoke('chat:listProviderModels', input),

  getMcpToolCache: () => electronAPI.ipcRenderer.invoke('mcp:getToolCache'),
  saveMcpToolCache: (serverId, tools = []) =>
    electronAPI.ipcRenderer.invoke('mcp:saveToolCache', serverId, toPlainPayload(tools) || []),
  initializeMcpClient: (activeServerConfigs = {}) =>
    electronAPI.ipcRenderer.invoke('mcp:initializeClient', toPlainPayload(activeServerConfigs) || {}),
  testMcpConnection: (serverConfig = {}) =>
    electronAPI.ipcRenderer.invoke('mcp:testConnection', toPlainPayload(serverConfig) || {}),
  testInvokeMcpTool: (serverConfig = {}, toolName = '', args = {}) =>
    electronAPI.ipcRenderer.invoke(
      'mcp:testInvokeTool',
      toPlainPayload(serverConfig) || {},
      toolName,
      toPlainPayload(args) || {}
    ),
  invokeMcpTool: (toolName = '', toolArgs = {}, context = null) =>
    electronAPI.ipcRenderer.invoke(
      'mcp:invokeTool',
      toolName,
      toPlainPayload(toolArgs) || {},
      toPlainPayload(context)
    ),
  closeMcpClient: () => electronAPI.ipcRenderer.invoke('mcp:closeClient'),

  listSkills: (skillRootPath = '') => invokeOrThrow('skill:list', skillRootPath),
  getSkillDetails: (skillRootPath = '', skillId = '') =>
    invokeOrThrow('skill:getDetails', skillRootPath, skillId),
  saveSkill: (skillRootPath = '', skillId = '', content = '') =>
    invokeOrThrow('skill:save', skillRootPath, skillId, content),
  deleteSkill: (skillRootPath = '', skillId = '') =>
    invokeOrThrow('skill:delete', skillRootPath, skillId),
  exportSkillToPackage: (skillRootPath = '', skillId = '', outputDir = '') =>
    invokeOrThrow('skill:exportPackage', skillRootPath, skillId, outputDir),
  extractSkillPackage: (filePath = '') =>
    invokeOrThrow('skill:extractPackage', filePath),
  getSkillToolDefinition: (skillRootPath = '', enabledSkillNames = []) =>
    invokeOrThrow('skill:getToolDefinition', skillRootPath, enabledSkillNames),
  resolveSkillInvocation: (skillRootPath = '', skillName = '', toolArgsObj = {}, globalContext = null) =>
    invokeOrThrow(
      'skill:resolveInvocation',
      skillRootPath,
      skillName,
      toolArgsObj,
      globalContext
    ),
  pathJoin: (...args) => path.join(...args),
  handleFilePath: (filePath) => invokeOrThrow('file:handleFilePath', filePath),
  sendfileDirect: (filePathList) => invokeOrThrow('file:sendfileDirect', filePathList),
  saveFile: (options) => invokeOrThrow('file:saveFile', options),
  selectDirectory: () => invokeOrThrow('file:selectDirectory'),
  listJsonFiles: (dirPath) => invokeOrThrow('file:listJsonFiles', dirPath),
  readLocalFile: (filePath, options = {}) =>
    invokeOrThrow('file:readLocalFile', filePath, options),
  renameLocalFile: (oldPath, newPath) =>
    invokeOrThrow('file:renameLocalFile', oldPath, newPath),
  deleteLocalFile: (filePath) => invokeOrThrow('file:deleteLocalFile', filePath),
  writeLocalFile: (filePath, content, options = {}) =>
    invokeOrThrow('file:writeLocalFile', filePath, content, options),
  setFileMtime: (filePath, mtime) => invokeOrThrow('file:setFileMtime', filePath, mtime),
  isFileTypeSupported: (fileName) => invokeOrThrow('file:isFileTypeSupported', fileName),
  parseFileObject: (fileObj) => invokeOrThrow('file:parseFileObject', fileObj),
  copyLocalPath: (srcPath, destPath) =>
    invokeOrThrow('file:copyLocalPath', srcPath, destPath),

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
  minimizeWindow: (windowRef = '') =>
    electronAPI.ipcRenderer.invoke('window:minimize', { windowRef }),
  maximizeOrRestoreWindow: (windowRef = '') =>
    electronAPI.ipcRenderer.invoke('window:maximizeOrRestore', { windowRef }),
  closeWindow: (windowRef = '') => {
    electronAPI.ipcRenderer.send('window:close', { windowRef })
    return Promise.resolve({ ok: true, action: 'close', windowRef: windowRef || null, dispatched: true })
  },
  toggleAlwaysOnTop: (payload = {}) => {
    const input =
      typeof payload === 'boolean'
        ? { alwaysOnTop: payload }
        : payload && typeof payload === 'object'
          ? payload
          : {}

    return electronAPI.ipcRenderer.invoke('window:toggleAlwaysOnTop', input)
  },
  windowControl: (action, windowRef = '') => {
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
      return Promise.resolve({ ok: false, error: 'unsupported_window_action', action })
    }

    if (channel === 'window:close') {
      electronAPI.ipcRenderer.send(channel, { windowRef })
      return Promise.resolve({ ok: true, action: 'close', windowRef: windowRef || null, dispatched: true })
    }

    return electronAPI.ipcRenderer.invoke(channel, { windowRef })
  },
  onAlwaysOnTopChanged: (callback) => {
    if (typeof callback !== 'function') return
    electronAPI.ipcRenderer.on('window:alwaysOnTopChanged', (_event, payload) => callback(payload))
  }
}

if (process.contextIsolated) {
  try {
    contextBridge.exposeInMainWorld('electron', electronAPI)
    contextBridge.exposeInMainWorld('api', api)
  } catch (error) {
    console.error('[preload:main]', error)
  }
} else {
  window.electron = electronAPI
  window.api = api
}
