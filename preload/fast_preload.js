import { contextBridge } from 'electron'
import { electronAPI } from '@electron-toolkit/preload'

const defaultWindowType = 'fast_window'
let windowType = defaultWindowType
let windowSenderId = 'fast'

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
  openWindow: (type) => electronAPI.ipcRenderer.invoke('window:open', type),
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
  copyText: (text) => electronAPI.ipcRenderer.invoke('system:clipboard:copyText', text),
  copyImage: (input) => electronAPI.ipcRenderer.invoke('system:clipboard:copyImage', input),
  readClipboardText: () => electronAPI.ipcRenderer.invoke('system:clipboard:readText'),
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
  exportMemoryData: () => electronAPI.ipcRenderer.invoke('data:exportMemoryData'),
  importMemoryData: (memories) => electronAPI.ipcRenderer.invoke('data:importMemoryData', memories),

  createChatCompletion: (params = {}) =>
    electronAPI.ipcRenderer.invoke('chat:createCompletion', params),

  getMcpToolCache: () => electronAPI.ipcRenderer.invoke('mcp:getToolCache'),
  saveMcpToolCache: (serverId, tools = []) =>
    electronAPI.ipcRenderer.invoke('mcp:saveToolCache', serverId, tools),
  initializeMcpClient: (activeServerConfigs = {}) =>
    electronAPI.ipcRenderer.invoke('mcp:initializeClient', activeServerConfigs),
  testMcpConnection: (serverConfig = {}) =>
    electronAPI.ipcRenderer.invoke('mcp:testConnection', serverConfig),
  testInvokeMcpTool: (serverConfig = {}, toolName = '', args = {}) =>
    electronAPI.ipcRenderer.invoke('mcp:testInvokeTool', serverConfig, toolName, args),
  invokeMcpTool: (toolName = '', toolArgs = {}, context = null) =>
    electronAPI.ipcRenderer.invoke('mcp:invokeTool', toolName, toolArgs, context),
  closeMcpClient: () => electronAPI.ipcRenderer.invoke('mcp:closeClient'),

  listSkills: (skillRootPath = '') => electronAPI.ipcRenderer.invoke('skill:list', skillRootPath),
  getSkillDetails: (skillRootPath = '', skillId = '') =>
    electronAPI.ipcRenderer.invoke('skill:getDetails', skillRootPath, skillId),
  saveSkill: (skillRootPath = '', skillId = '', content = '') =>
    electronAPI.ipcRenderer.invoke('skill:save', skillRootPath, skillId, content),
  deleteSkill: (skillRootPath = '', skillId = '') =>
    electronAPI.ipcRenderer.invoke('skill:delete', skillRootPath, skillId),
  exportSkillToPackage: (skillRootPath = '', skillId = '', outputDir = '') =>
    electronAPI.ipcRenderer.invoke('skill:exportPackage', skillRootPath, skillId, outputDir),
  extractSkillPackage: (filePath = '') =>
    electronAPI.ipcRenderer.invoke('skill:extractPackage', filePath),
  getSkillToolDefinition: (skillRootPath = '', enabledSkillNames = []) =>
    electronAPI.ipcRenderer.invoke('skill:getToolDefinition', skillRootPath, enabledSkillNames),
  resolveSkillInvocation: (skillRootPath = '', skillName = '', toolArgsObj = {}, globalContext = null) =>
    electronAPI.ipcRenderer.invoke(
      'skill:resolveInvocation',
      skillRootPath,
      skillName,
      toolArgsObj,
      globalContext
    ),
  pathJoin: (...args) => electronAPI.ipcRenderer.invoke('skill:pathJoin', ...args),
  handleFilePath: (filePath) => electronAPI.ipcRenderer.invoke('file:handleFilePath', filePath),
  sendfileDirect: (filePathList) => electronAPI.ipcRenderer.invoke('file:sendfileDirect', filePathList),
  saveFile: (options) => electronAPI.ipcRenderer.invoke('file:saveFile', options),
  selectDirectory: () => electronAPI.ipcRenderer.invoke('file:selectDirectory'),
  listJsonFiles: (dirPath) => electronAPI.ipcRenderer.invoke('file:listJsonFiles', dirPath),
  readLocalFile: (filePath, options = {}) =>
    electronAPI.ipcRenderer.invoke('file:readLocalFile', filePath, options),
  renameLocalFile: (oldPath, newPath) =>
    electronAPI.ipcRenderer.invoke('file:renameLocalFile', oldPath, newPath),
  deleteLocalFile: (filePath) => electronAPI.ipcRenderer.invoke('file:deleteLocalFile', filePath),
  writeLocalFile: (filePath, content, options = {}) =>
    electronAPI.ipcRenderer.invoke('file:writeLocalFile', filePath, content, options),
  setFileMtime: (filePath, mtime) => electronAPI.ipcRenderer.invoke('file:setFileMtime', filePath, mtime),
  isFileTypeSupported: (fileName) => electronAPI.ipcRenderer.invoke('file:isFileTypeSupported', fileName),
  parseFileObject: (fileObj) => electronAPI.ipcRenderer.invoke('file:parseFileObject', fileObj),
  copyLocalPath: (srcPath, destPath) =>
    electronAPI.ipcRenderer.invoke('file:copyLocalPath', srcPath, destPath),

  listWebdavBackups: (input = {}) => electronAPI.ipcRenderer.invoke('webdav:listBackups', input),
  writeWebdavBackup: (input = {}) => electronAPI.ipcRenderer.invoke('webdav:writeBackup', input),
  readWebdavBackup: (input = {}) => electronAPI.ipcRenderer.invoke('webdav:readBackup', input),
  deleteWebdavBackup: (input = {}) => electronAPI.ipcRenderer.invoke('webdav:deleteBackup', input),
  deleteWebdavBackups: (input = {}) => electronAPI.ipcRenderer.invoke('webdav:deleteBackups', input),
  minimizeWindow: (windowRef = '') =>
    electronAPI.ipcRenderer.invoke('window:minimize', { windowRef }),
  maximizeOrRestoreWindow: (windowRef = '') =>
    electronAPI.ipcRenderer.invoke('window:maximizeOrRestore', { windowRef }),
  closeWindow: (windowRef = '') => electronAPI.ipcRenderer.invoke('window:close', { windowRef }),
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
    console.error('[preload:fast_window]', error)
  }
} else {
  window.electron = electronAPI
  window.api = api
}
