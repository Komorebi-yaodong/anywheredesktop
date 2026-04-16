import fs from 'node:fs/promises'
import path from 'node:path'
import crypto from 'node:crypto'
import { app } from 'electron'

import { safeClone } from '../dataConverter.js'
import { fetchWithProxy } from './net.js'
import { getBuiltinServers as getBuiltinMcpServers } from './mcp_builtin.js'
import {
  get as dbGet,
  put as dbPut,
  allDocs as dbAllDocs,
  createDocIfMissing
} from './db.js'

const CONFIG_DOC_ID = 'config'
const PROMPTS_DOC_ID = 'prompts'
const PROVIDERS_DOC_ID = 'providers'
const MCP_SERVERS_DOC_ID = 'mcpServers'
const TASKS_DOC_ID = 'tasks'
const LOCAL_CONFIG_DOC_ID = 'config_local_desktop'
const CURRENT_CONFIG_VERSION = '2.6.10'

const BACKGROUND_CACHE_DOC_ID = 'background_cache'
const BACKGROUND_CACHE_DIR_NAME = 'background_cache'

let windowChannelNotifier = null

export function setWindowChannelNotifier(notifier) {
  windowChannelNotifier = typeof notifier === 'function' ? notifier : null
}

function emitWindowChannel(channel, payload = null) {
  if (typeof windowChannelNotifier !== 'function') return

  try {
    windowChannelNotifier(channel, deepClone(payload))
  } catch (error) {
    console.error(`[data] failed to emit window channel '${channel}':`, error)
  }
}

async function notifyConfigUpdated() {
  try {
    const latestConfig = await getConfig()
    emitWindowChannel('window:configUpdated', latestConfig.config)
    emitWindowChannel('config-updated', latestConfig.config)
  } catch (error) {
    console.error('[data] failed to notify config update:', error)
  }
}


function toFileUrl(filePath) {
  return `file://${String(filePath).replace(/\\/g, '/')}`
}

function getResourceFileUrl(fileName = '') {
  const resourcePath = path.join(app.getAppPath(), 'resources', fileName)
  return toFileUrl(resourcePath)
}

function getBackgroundCacheHash(url = '') {
  return crypto.createHash('md5').update(String(url)).digest('hex')
}

async function ensureBackgroundCacheDir() {
  const cacheDir = path.join(app.getPath('userData'), BACKGROUND_CACHE_DIR_NAME)
  await fs.mkdir(cacheDir, { recursive: true })
  return cacheDir
}


export const defaultConfig = {
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
        model: '',
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
    settingsCardOrder: ['general', 'desktop', 'voice', 'data', 'webdav'],
    settingsCardCollapsed: {
      general: false,
      desktop: false,
      voice: false,
      data: false,
      webdav: false
    },
    fastWindowPosition: null,
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
        desktop: {
      closeToTray: true,
      shortcuts: {
        mainToggle: 'Ctrl+Space',
        quickSummon: 'Alt+A',
        appendFollowUp: 'Alt+S',
        promptBindings: []
      },
      profile: {
        nickname: 'User',
        avatar: ''
      }
    },

voiceList: [
      'alloy-👩',
      'echo-👨‍🦰清晰',
      'nova-👩清晰',
      'sage-👧年轻',
      'shimmer-👧明亮',
      'fable-😐中性',
      'coral-👩客服',
      'ash-🧔‍♂️商业',
      'ballad-👨故事',
      'verse-👨诗歌',
      'onyx-👨‍🦰新闻',
      'Zephyr-👧明亮',
      'Puck-👦欢快',
      'Charon-👦信息丰富',
      'Kore-👩坚定',
      'Fenrir-👨‍🦰易激动',
      'Leda-👧年轻',
      'Orus-👨‍🦰鉴定',
      'Aoede-👩轻松',
      'Callirrhoe-👩随和',
      'Autonoe-👩明亮',
      'Enceladus-🧔‍♂️呼吸感',
      'Iapetus-👦清晰',
      'Umbriel-👦随和',
      'Algieba-👦平滑',
      'Despina-👩平滑',
      'Erinome-👩清晰',
      'Algenib-👨‍🦰沙哑',
      'Rasalgethi-👨‍🦰信息丰富',
      'Laomedeia-👩欢快',
      'Achernar-👩轻柔',
      'Alnilam-👦坚定',
      'Schedar-👦平稳',
      'Gacrux-👩成熟',
      'Pulcherrima-👩向前',
      'Achird-👦友好',
      'Zubenelgenubi-👦休闲',
      'Vindemiatrix-👩温柔',
      'Sadachbia-👨‍🦰活泼',
      'Sadaltager-👨‍🦰博学',
      'Sulafat-👩温暖'
    ]
  }
}

function deepClone(value) {
  return safeClone(value)
}


export function isValidProviderModelKey(config = {}, modelKey = '') {
  if (!modelKey || typeof modelKey !== 'string') return false
  const separatorIndex = modelKey.indexOf('|')
  if (separatorIndex <= 0) return false

  const providerId = modelKey.slice(0, separatorIndex)
  const modelName = modelKey.slice(separatorIndex + 1)
  if (!providerId || !modelName) return false

  const provider = config?.providers?.[providerId]
  if (!provider || provider.enable === false) return false
  return Array.isArray(provider.modelList) && provider.modelList.includes(modelName)
}

export function getOrderedProviderIds(config = {}) {
  const providers = config?.providers || {}
  const folders = config?.providerFolders || {}
  const order = Array.isArray(config?.providerOrder) ? config.providerOrder.map(String) : []
  const orderedProviderIds = []
  const seen = new Set()

  const sortedFolderIds = Object.keys(folders).sort((a, b) =>
    String(folders[a]?.name || '').localeCompare(String(folders[b]?.name || ''), 'zh-CN')
  )

  sortedFolderIds.forEach((folderId) => {
    order.forEach((id) => {
      const provider = providers[id]
      if (provider && provider.folderId === folderId && !seen.has(id)) {
        orderedProviderIds.push(id)
        seen.add(id)
      }
    })
  })

  order.forEach((id) => {
    const provider = providers[id]
    if (provider && (!provider.folderId || !folders[provider.folderId]) && !seen.has(id)) {
      orderedProviderIds.push(id)
      seen.add(id)
    }
  })

  Object.keys(providers).forEach((id) => {
    if (!seen.has(id)) {
      orderedProviderIds.push(id)
      seen.add(id)
    }
  })

  return orderedProviderIds
}

export function getFirstAvailableProviderModel(config = {}) {
  const providers = config?.providers || {}
  const orderedProviderIds = getOrderedProviderIds(config)

  for (const providerId of orderedProviderIds) {
    const provider = providers[providerId]
    if (!provider || provider.enable === false || !Array.isArray(provider.modelList)) continue
    const firstModel = provider.modelList.find((modelName) => typeof modelName === 'string' && modelName.trim())
    if (firstModel) {
      return `${providerId}|${firstModel}`
    }
  }

  return ''
}

export function resolveDefaultAssistantModel(config = {}) {
  if (isValidProviderModelKey(config, config?.defaultTaskModel)) {
    return config.defaultTaskModel
  }
  return getFirstAvailableProviderModel(config)
}

function getLocalConfigId() {
  return LOCAL_CONFIG_DOC_ID
}

function ensureObject(value, fallback = {}) {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    return value
  }
  return fallback
}

function sanitizePromptBindings(bindings = []) {
  if (!Array.isArray(bindings)) {
    return {
      value: [],
      changed: true
    }
  }

  let changed = false
  const nextBindings = []

  bindings.forEach((item, index) => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) {
      changed = true
      return
    }

    const id = typeof item.id === 'string' && item.id.trim() ? item.id.trim() : `prompt-${index}`
    const promptKey = typeof item.promptKey === 'string' ? item.promptKey.trim() : ''
    const accelerator = typeof item.accelerator === 'string' ? item.accelerator.trim() : ''
    const enabled = item.enabled !== false

    if (!promptKey || !accelerator) {
      changed = true
      return
    }

    if (id !== item.id || promptKey !== item.promptKey || accelerator !== item.accelerator || enabled !== item.enabled) {
      changed = true
    }

    nextBindings.push({
      id,
      promptKey,
      accelerator,
      enabled
    })
  })

  if (nextBindings.length !== bindings.length) {
    changed = true
  }

  return {
    value: nextBindings,
    changed
  }
}

function splitConfigForStorage(fullConfig) {
  const source = deepClone(fullConfig || {})
  const { prompts, providers, mcpServers, tasks, ...restOfConfig } = source

  const localConfigPart = {
    skillPath: restOfConfig.skillPath || '',
    localChatPath: restOfConfig?.webdav?.localChatPath || ''
  }

  delete restOfConfig.skillPath
  if (restOfConfig.webdav && typeof restOfConfig.webdav === 'object') {
    delete restOfConfig.webdav.localChatPath
  }

  return {
    baseConfigPart: { config: restOfConfig },
    promptsPart: ensureObject(prompts, {}),
    providersPart: ensureObject(providers, {}),
    mcpServersPart: ensureObject(mcpServers, {}),
    tasksPart: ensureObject(tasks, {}),
    localConfigPart
  }
}

function getBuiltinServers() {
  return getBuiltinMcpServers()
}

function checkConfig(inputConfig) {
  const config = ensureObject(deepClone(inputConfig), {})
  let changed = false

  if (config.version !== CURRENT_CONFIG_VERSION) {
    config.version = CURRENT_CONFIG_VERSION
    changed = true
  }

  const obsoleteKeys = [
    'window_width',
    'window_height',
    'stream',
    'autoCloseOnBlur',
    'isAlwaysOnTop',
    'inputLayout',
    'tool_list',
    'promptOrder',
    'ModelsListByUser',
    'apiUrl',
    'apiKey',
    'modelList',
    'modelSelect',
    'activeProviderId',
    'showNotification'
  ]

  for (const key of obsoleteKeys) {
    if (config[key] !== undefined) {
      delete config[key]
      changed = true
    }
  }

  const rootDefaults = {
    defaultTaskModel: '',
    tasks: {},
    providers: { ...defaultConfig.config.providers },
    providerOrder: [...defaultConfig.config.providerOrder],
    providerFolders: {},
    prompts: deepClone(defaultConfig.config.prompts),
    mcpServers: {},
    tags: {},
    language: 'zh',
    skipLineBreak: false,
    CtrlEnterToSend: false,
    isDarkMode: false,
    themeMode: 'system',
    fix_position: false,
    isAlwaysOnTop_global: true,
    autoCloseOnBlur_global: true,
    autoSaveChat_global: false,
    zoom: 1,
    fastWindowPosition: null,
    voiceList: [...defaultConfig.config.voiceList],
    desktop: {
      closeToTray: true,
      shortcuts: {
        mainToggle: 'Ctrl+Space',
        quickSummon: 'Alt+A',
        appendFollowUp: 'Alt+S',
        promptBindings: []
      },
      profile: {
        nickname: 'User',
        avatar: ''
      }
    },
    settingsCardOrder: ['general', 'desktop', 'voice', 'data', 'webdav'],
    settingsCardCollapsed: {
      general: false,
      desktop: false,
      voice: false,
      data: false,
      webdav: false
    },
    webdav: {
      url: '',
      username: '',
      password: '',
      path: '/anywhere',
      data_path: '/anywhere_data',
      localChatPath: ''
    },
    skillPath: ''
  }

  for (const [key, value] of Object.entries(rootDefaults)) {
    if (config[key] === undefined) {
      config[key] = deepClone(value)
      changed = true
    }
  }

  config.providers = ensureObject(config.providers, deepClone(defaultConfig.config.providers))
  config.prompts = ensureObject(config.prompts, deepClone(defaultConfig.config.prompts))
  config.mcpServers = ensureObject(config.mcpServers, {})
  config.tasks = ensureObject(config.tasks, {})
  config.providerFolders = ensureObject(config.providerFolders, {})
  config.tags = ensureObject(config.tags, {})


  if (typeof config.autoSaveChat_global !== 'boolean') {
    config.autoSaveChat_global = false
    changed = true
  }

  for (const [promptKey, promptConfig] of Object.entries(config.prompts)) {
    if (!promptConfig || typeof promptConfig !== 'object' || Array.isArray(promptConfig)) {
      config.prompts[promptKey] = deepClone(defaultConfig.config.prompts.AI)
      changed = true
      continue
    }

    if (typeof promptConfig.autoSaveChat !== 'boolean') {
      promptConfig.autoSaveChat = false
      changed = true
    }
  }


  if (!Array.isArray(config.providerOrder) || config.providerOrder.length === 0) {
    config.providerOrder = Object.keys(config.providers)
    changed = true
  }

  if (!config.webdav || typeof config.webdav !== 'object') {
    config.webdav = deepClone(rootDefaults.webdav)
    changed = true
  } else {
    if (config.webdav.dataPath && !config.webdav.data_path) {
      config.webdav.data_path = config.webdav.dataPath
      delete config.webdav.dataPath
      changed = true
    }

    const webdavDefaults = {
      url: '',
      username: '',
      password: '',
      path: '/anywhere',
      data_path: '/anywhere_data',
      localChatPath: ''
    }

    for (const [key, value] of Object.entries(webdavDefaults)) {
      if (config.webdav[key] === undefined) {
        config.webdav[key] = value
        changed = true
      }
    }
  }

  if (!config.settingsCardOrder || !Array.isArray(config.settingsCardOrder)) {
    config.settingsCardOrder = ['general', 'desktop', 'voice', 'data', 'webdav']
    changed = true
  }

  if (!config.desktop || typeof config.desktop !== 'object') {
    config.desktop = deepClone(rootDefaults.desktop)
    changed = true
  } else {
    if (typeof config.desktop.closeToTray !== 'boolean') {
      config.desktop.closeToTray = true
      changed = true
    }
    if (!config.desktop.shortcuts || typeof config.desktop.shortcuts !== 'object') {
      config.desktop.shortcuts = deepClone(rootDefaults.desktop.shortcuts)
      changed = true
    } else {
      if (typeof config.desktop.shortcuts.mainToggle !== 'string' || !config.desktop.shortcuts.mainToggle.trim()) {
        config.desktop.shortcuts.mainToggle = 'Ctrl+Space'
        changed = true
      }
      if (typeof config.desktop.shortcuts.quickSummon !== 'string' || !config.desktop.shortcuts.quickSummon.trim()) {
        config.desktop.shortcuts.quickSummon = 'Alt+A'
        changed = true
      }
      if (typeof config.desktop.shortcuts.appendFollowUp !== 'string' || !config.desktop.shortcuts.appendFollowUp.trim()) {
        config.desktop.shortcuts.appendFollowUp = 'Alt+S'
        changed = true
      }
      const sanitizedPromptBindings = sanitizePromptBindings(config.desktop.shortcuts.promptBindings)
      config.desktop.shortcuts.promptBindings = sanitizedPromptBindings.value
      if (sanitizedPromptBindings.changed) {
        changed = true
      }
    }

    if (!config.desktop.profile || typeof config.desktop.profile !== 'object') {
      config.desktop.profile = deepClone(rootDefaults.desktop.profile)
      changed = true
    } else {
      if (typeof config.desktop.profile.nickname !== 'string') {
        config.desktop.profile.nickname = rootDefaults.desktop.profile.nickname
        changed = true
      } else {
        const normalizedNickname = config.desktop.profile.nickname.trim().slice(0, 12)
        if (config.desktop.profile.nickname !== normalizedNickname) {
          config.desktop.profile.nickname = normalizedNickname
          changed = true
        }
        if (!config.desktop.profile.nickname) {
          config.desktop.profile.nickname = rootDefaults.desktop.profile.nickname
          changed = true
        }
      }

      if (typeof config.desktop.profile.avatar !== 'string') {
        config.desktop.profile.avatar = rootDefaults.desktop.profile.avatar
        changed = true
      }
    }
  }

  if (!config.settingsCardCollapsed || typeof config.settingsCardCollapsed !== 'object') {
    config.settingsCardCollapsed = {
      general: false,
      desktop: false,
      voice: false,
      data: false,
      webdav: false
    }
    changed = true
  }

  for (const [cardKey, cardValue] of Object.entries(rootDefaults.settingsCardCollapsed)) {
    if (typeof config.settingsCardCollapsed[cardKey] !== 'boolean') {
      config.settingsCardCollapsed[cardKey] = cardValue
      changed = true
    }
  }

  for (const promptConfig of Object.values(config.prompts)) {
    if (!promptConfig || typeof promptConfig !== 'object' || Array.isArray(promptConfig)) continue
    const resolvedPromptModel = isValidProviderModelKey(config, promptConfig.model)
      ? promptConfig.model
      : resolveDefaultAssistantModel(config)
    if (promptConfig.model !== resolvedPromptModel) {
      promptConfig.model = resolvedPromptModel
      changed = true
    }
  }

  const builtinServers = getBuiltinServers()
  if (builtinServers && typeof builtinServers === 'object') {
    const mergedMcpServers = { ...config.mcpServers }
    for (const [id, server] of Object.entries(builtinServers)) {
      if (mergedMcpServers[id]) {
        mergedMcpServers[id] = {
          ...server,
          isActive: mergedMcpServers[id].isActive,
          isPersistent: mergedMcpServers[id].isPersistent
        }
      } else {
        mergedMcpServers[id] = server
        changed = true
      }
    }
    config.mcpServers = mergedMcpServers
  }

  return { config, changed }
}

async function readDocData(docId, fallback) {
  const result = await dbGet(docId)
  if (!result?.ok || !result.doc) {
    return deepClone(fallback)
  }

  const docData = result.doc.data
  if (docData === undefined || docData === null) {
    return deepClone(fallback)
  }

  return deepClone(docData)
}

async function writeDocData(docId, data) {
  const existing = await dbGet(docId)
  const nextDoc = {
    _id: docId,
    data: deepClone(data)
  }

  if (existing?.ok && existing.doc?._rev) {
    nextDoc._rev = existing.doc._rev
  }

  return dbPut(nextDoc)
}

function parseKeyPath(keyPath) {
  if (typeof keyPath !== 'string' || !keyPath.trim()) {
    throw new Error('[data] keyPath is required')
  }
  return keyPath.trim().split('.').filter(Boolean)
}

function setByPath(target, pathParts, value) {
  let current = target
  for (let i = 0; i < pathParts.length - 1; i += 1) {
    const part = pathParts[i]
    if (!current[part] || typeof current[part] !== 'object') {
      current[part] = {}
    }
    current = current[part]
  }
  current[pathParts[pathParts.length - 1]] = value
}

async function ensureConfigDocsIfMissing() {
  const split = splitConfigForStorage(defaultConfig.config)

  await createDocIfMissing(CONFIG_DOC_ID, split.baseConfigPart)
  await createDocIfMissing(PROMPTS_DOC_ID, split.promptsPart)
  await createDocIfMissing(PROVIDERS_DOC_ID, split.providersPart)
  await createDocIfMissing(MCP_SERVERS_DOC_ID, split.mcpServersPart)
  await createDocIfMissing(TASKS_DOC_ID, split.tasksPart)
  await createDocIfMissing(getLocalConfigId(), split.localConfigPart)
}

export async function getConfig() {
  await ensureConfigDocsIfMissing()

  const baseConfigPart = await readDocData(CONFIG_DOC_ID, { config: {} })
  const promptsPart = await readDocData(PROMPTS_DOC_ID, deepClone(defaultConfig.config.prompts))
  const providersPart = await readDocData(PROVIDERS_DOC_ID, deepClone(defaultConfig.config.providers))
  const mcpServersPart = await readDocData(MCP_SERVERS_DOC_ID, {})
  const tasksPart = await readDocData(TASKS_DOC_ID, {})
  const localPart = await readDocData(getLocalConfigId(), {
    skillPath: '',
    localChatPath: ''
  })

  const mergedConfig = ensureObject(baseConfigPart.config, {})
  mergedConfig.prompts = ensureObject(promptsPart, deepClone(defaultConfig.config.prompts))
  mergedConfig.providers = ensureObject(providersPart, deepClone(defaultConfig.config.providers))
  mergedConfig.mcpServers = ensureObject(mcpServersPart, {})
  mergedConfig.tasks = ensureObject(tasksPart, {})
  mergedConfig.skillPath = typeof localPart.skillPath === 'string' ? localPart.skillPath : ''

  if (!mergedConfig.webdav || typeof mergedConfig.webdav !== 'object') {
    mergedConfig.webdav = {}
  }

  mergedConfig.webdav.localChatPath =
    typeof localPart.localChatPath === 'string' ? localPart.localChatPath : ''

  const { config: checkedConfig, changed } = checkConfig(mergedConfig)

  if (changed) {
    await updateConfigWithoutFeatures({ config: checkedConfig })
    return {
      config: deepClone(checkedConfig)
    }
  }

  return {
    config: deepClone(checkedConfig)
  }
}

export async function saveSetting(keyPath, value) {
  await ensureConfigDocsIfMissing()

  const normalizedValue = deepClone(value)

  if (keyPath === 'skillPath' || keyPath === 'webdav.localChatPath') {
    const localDoc = await readDocData(getLocalConfigId(), {
      skillPath: '',
      localChatPath: ''
    })

    if (keyPath === 'skillPath') {
      localDoc.skillPath = normalizedValue || ''
    } else {
      localDoc.localChatPath = normalizedValue || ''
    }

    const writeResult = await writeDocData(getLocalConfigId(), localDoc)
    if (writeResult?.ok) {
      await notifyConfigUpdated()
    }
    return {
      success: Boolean(writeResult?.ok),
      message: writeResult?.ok ? '' : writeResult?.message || 'save local setting failed'
    }
  }

  const pathParts = parseKeyPath(keyPath)
  const rootKey = pathParts[0]

  if (rootKey === 'prompts' || rootKey === 'providers' || rootKey === 'mcpServers' || rootKey === 'tasks') {
    const docIdMap = {
      prompts: PROMPTS_DOC_ID,
      providers: PROVIDERS_DOC_ID,
      mcpServers: MCP_SERVERS_DOC_ID,
      tasks: TASKS_DOC_ID
    }

    const docId = docIdMap[rootKey]
    const docData = await readDocData(docId, {})

    if (pathParts.length < 3) {
      return {
        success: false,
        message: `invalid keyPath for ${rootKey}: ${keyPath}`
      }
    }

    const [, objectKey, ...rest] = pathParts
    if (!docData[objectKey] || typeof docData[objectKey] !== 'object') {
      docData[objectKey] = {}
    }

    setByPath(docData[objectKey], rest, normalizedValue)
    const writeResult = await writeDocData(docId, docData)
    if (writeResult?.ok) {
      await notifyConfigUpdated()
    }

    return {
      success: Boolean(writeResult?.ok),
      message: writeResult?.ok ? '' : writeResult?.message || 'save setting failed'
    }
  }

  const configDocData = await readDocData(CONFIG_DOC_ID, { config: {} })
  const configRoot = ensureObject(configDocData.config, {})
  setByPath(configRoot, pathParts, normalizedValue)
  configDocData.config = configRoot

  const writeResult = await writeDocData(CONFIG_DOC_ID, configDocData)
  if (writeResult?.ok) {
    await notifyConfigUpdated()
  }

  return {
    success: Boolean(writeResult?.ok),
    message: writeResult?.ok ? '' : writeResult?.message || 'save setting failed'
  }
}

export async function updateConfigWithoutFeatures(newConfig) {
  const source = ensureObject(newConfig, {})
  const incomingConfig = ensureObject(source.config, {})
  const plainConfig = deepClone(incomingConfig)

  if (plainConfig.mcpServers && typeof plainConfig.mcpServers === 'object') {
    const serverToSave = {}
    const builtinIds = Object.keys(getBuiltinServers())

    for (const [id, server] of Object.entries(plainConfig.mcpServers)) {
      if (server?.type === 'builtin' || builtinIds.includes(id)) {
        serverToSave[id] = {
          id: server?.id || id,
          type: 'builtin',
          name: server?.name || id,
          isActive: Boolean(server?.isActive),
          isPersistent: Boolean(server?.isPersistent)
        }
      } else {
        serverToSave[id] = deepClone(server)
      }
    }

    plainConfig.mcpServers = serverToSave
  }

  const split = splitConfigForStorage(plainConfig)

  await Promise.all([
    writeDocData(CONFIG_DOC_ID, split.baseConfigPart),
    writeDocData(PROMPTS_DOC_ID, split.promptsPart),
    writeDocData(PROVIDERS_DOC_ID, split.providersPart),
    writeDocData(MCP_SERVERS_DOC_ID, split.mcpServersPart),
    writeDocData(TASKS_DOC_ID, split.tasksPart),
    writeDocData(getLocalConfigId(), split.localConfigPart)
  ])

  await notifyConfigUpdated()

  return {
    success: true
  }
}

export async function updateConfig(newConfig) {
  return updateConfigWithoutFeatures(newConfig)
}

export async function restoreImportedConfig(importedConfig = {}) {
  const importedRoot = ensureObject(deepClone(importedConfig), {})
  const currentResult = await getConfig()
  const currentConfig = ensureObject(currentResult?.config, {})

  const mergedConfig = {
    ...currentConfig,
    ...importedRoot
  }

  if (Object.prototype.hasOwnProperty.call(importedRoot, 'desktop')) {
    mergedConfig.desktop = importedRoot.desktop
  } else {
    mergedConfig.desktop = deepClone(currentConfig.desktop)
  }

  if (Object.prototype.hasOwnProperty.call(importedRoot, 'settingsCardOrder')) {
    mergedConfig.settingsCardOrder = importedRoot.settingsCardOrder
  } else {
    mergedConfig.settingsCardOrder = deepClone(currentConfig.settingsCardOrder)
  }

  if (Object.prototype.hasOwnProperty.call(importedRoot, 'settingsCardCollapsed')) {
    mergedConfig.settingsCardCollapsed = importedRoot.settingsCardCollapsed
  } else {
    mergedConfig.settingsCardCollapsed = deepClone(currentConfig.settingsCardCollapsed)
  }

  if (!Object.prototype.hasOwnProperty.call(importedRoot, 'skillPath')) {
    mergedConfig.skillPath = currentConfig.skillPath
  }

  if (
    Object.prototype.hasOwnProperty.call(importedRoot, 'webdav') &&
    importedRoot.webdav &&
    typeof importedRoot.webdav === 'object' &&
    !Array.isArray(importedRoot.webdav)
  ) {
    mergedConfig.webdav = {
      ...(currentConfig.webdav && typeof currentConfig.webdav === 'object' ? currentConfig.webdav : {}),
      ...importedRoot.webdav
    }
  }

  if (
    !importedRoot.webdav ||
    typeof importedRoot.webdav !== 'object' ||
    Array.isArray(importedRoot.webdav) ||
    !Object.prototype.hasOwnProperty.call(importedRoot.webdav, 'localChatPath')
  ) {
    if (!mergedConfig.webdav || typeof mergedConfig.webdav !== 'object' || Array.isArray(mergedConfig.webdav)) {
      mergedConfig.webdav = {}
    }
    mergedConfig.webdav.localChatPath = currentConfig?.webdav?.localChatPath || ''
  }

  return updateConfigWithoutFeatures({ config: mergedConfig })
}

export async function exportMemoryData() {
  const result = await dbAllDocs({ includeDocs: true })
  const rows = Array.isArray(result?.rows) ? result.rows : []

  return rows
    .map((row) => row?.doc)
    .filter((doc) => doc && typeof doc._id === 'string' && doc._id.startsWith('anywhere_mem_'))
    .map((doc) => deepClone(doc))
}

export async function getMcpToolCache() {
  const result = await dbGet('mcp_tools_cache')
  if (!result?.ok || !result.doc) {
    return {}
  }

  const cache = result.doc?.data
  if (!cache || typeof cache !== 'object') {
    return {}
  }

  return deepClone(cache)
}

export async function saveMcpToolCache(serverId, tools = [], options = {}) {
  if (typeof serverId !== 'string' || !serverId.trim()) {
    throw new Error('[data] serverId is required')
  }

  const normalizedId = serverId.trim()
  const normalizedTools = Array.isArray(tools) ? deepClone(tools) : []
  const emitEvent = options?.emitEvent !== false
  const reason = typeof options?.reason === 'string' && options.reason.trim()
    ? options.reason.trim()
    : 'manual'
  const maxRetries = Number.isInteger(options?.maxRetries) && options.maxRetries > 0
    ? options.maxRetries
    : 3

  for (let attempt = 0; attempt < maxRetries; attempt += 1) {
    const existing = await dbGet('mcp_tools_cache')
    const latestData = existing?.ok && existing.doc?.data && typeof existing.doc.data === 'object'
      ? deepClone(existing.doc.data)
      : {}
    const previousTools = latestData[normalizedId]

    let isSame = false
    try {
      isSame = JSON.stringify(previousTools ?? []) === JSON.stringify(normalizedTools)
    } catch {
      isSame = false
    }

    if (isSame) {
      return {
        success: true,
        id: normalizedId,
        tools: normalizedTools,
        skipped: true,
        reason
      }
    }

    latestData[normalizedId] = normalizedTools
    const doc = {
      _id: 'mcp_tools_cache',
      data: latestData
    }

    if (existing?.ok && existing.doc?._rev) {
      doc._rev = existing.doc._rev
    }

    const putResult = await dbPut(doc)

    if (putResult?.ok) {
      if (emitEvent) {
        const payload = {
          serverId: normalizedId,
          reason,
          emitReloadSuggested: reason !== 'auto-bootstrap'
        }
        emitWindowChannel('window:mcpCacheUpdated', payload)
        emitWindowChannel('mcp-cache-updated', payload)
      }

      return {
        success: true,
        id: normalizedId,
        tools: normalizedTools,
        reason
      }
    }

    const message = String(putResult?.message || putResult?.error || '').toLowerCase()
    const isConflict = message.includes('conflict') || message.includes('revision') || putResult?.name === 'conflict'

    if (!isConflict || attempt === maxRetries - 1) {
      return {
        success: false,
        id: normalizedId,
        tools: normalizedTools,
        reason,
        message: putResult?.message || putResult?.error || 'save mcp tool cache failed'
      }
    }
  }

  return {
    success: false,
    id: normalizedId,
    tools: normalizedTools,
    reason,
    message: 'save mcp tool cache retry exhausted'
  }
}





const debugDataLog = () => {}
const debugDataError = () => {}

export function notifySkillsUpdated() {
  emitWindowChannel('window:skillsUpdated')
  emitWindowChannel('skills-updated')
}

export async function getUser() {
  const configResult = await getConfig()
  const config = configResult?.config && typeof configResult.config === 'object' ? configResult.config : {}
  const profile = config?.desktop?.profile && typeof config.desktop.profile === 'object'
    ? config.desktop.profile
    : {}

  const rawNickname = typeof profile.nickname === 'string' ? profile.nickname.trim() : ''
  const nickname = rawNickname.slice(0, 12) || 'User'
  const rawAvatar = typeof profile.avatar === 'string' ? profile.avatar.trim() : ''
  const avatar = rawAvatar || getResourceFileUrl('user.png')

  return {
    avatar,
    nickname
  }
}

export async function savePromptWindowSettings(promptKey, settings = {}) {
  debugDataLog('savePromptWindowSettings:enter', { promptKey, settings })
  if (typeof promptKey !== 'string' || !promptKey.trim()) {
    const result = {
      success: false,
      message: 'promptKey is required'
    }
    debugDataError('savePromptWindowSettings:invalid-prompt-key', result)
    return result
  }

  const normalizedPromptKey = promptKey.trim()
  const nextSettings = safeClone(settings || {})
  const configResult = await getConfig()
  const currentFullConfig = configResult?.config && typeof configResult.config === 'object' ? configResult.config : {}

  if (!currentFullConfig.prompts || typeof currentFullConfig.prompts !== 'object') {
    currentFullConfig.prompts = {}
  }

  if (!currentFullConfig.prompts[normalizedPromptKey] || typeof currentFullConfig.prompts[normalizedPromptKey] !== 'object') {
    const result = {
      success: false,
      message: `Prompt '${normalizedPromptKey}' not found`
    }
    debugDataError('savePromptWindowSettings:prompt-not-found', result)
    return result
  }

  currentFullConfig.prompts[normalizedPromptKey] = {
    ...currentFullConfig.prompts[normalizedPromptKey],
    ...nextSettings
  }

  debugDataLog('savePromptWindowSettings:before-updateConfigWithoutFeatures', {
    promptKey: normalizedPromptKey,
    nextPromptConfig: currentFullConfig.prompts[normalizedPromptKey]
  })

  await updateConfigWithoutFeatures({ config: currentFullConfig })

  const result = {
    success: true,
    message: ''
  }
  debugDataLog('savePromptWindowSettings:success', {
    promptKey: normalizedPromptKey,
    result
  })
  return result
}

export async function addTaskHistory(taskId, logEntry) {
  if (typeof taskId !== 'string' || !taskId.trim()) {
    return {
      success: false,
      message: 'taskId is required'
    }
  }

  const normalizedTaskId = taskId.trim()
  const tasksDoc = await readDocData(TASKS_DOC_ID, {})
  const task = tasksDoc[normalizedTaskId]

  if (!task || typeof task !== 'object') {
    return {
      success: false,
      message: `Task '${normalizedTaskId}' not found`
    }
  }

  const history = Array.isArray(task.history) ? [...task.history] : []
  history.unshift(safeClone(logEntry))
  task.history = history.slice(0, 50)
  tasksDoc[normalizedTaskId] = task
  await writeDocData(TASKS_DOC_ID, tasksDoc)

  return {
    success: true,
    historyCount: task.history.length
  }
}

export async function getCachedBackgroundImage(url = '') {
  if (typeof url !== 'string' || !url.trim()) return null

  const cacheDoc = await readDocData(BACKGROUND_CACHE_DOC_ID, {})
  const hash = getBackgroundCacheHash(url)
  const fileName = cacheDoc?.[hash]
  if (!fileName) return null

  const filePath = path.join(await ensureBackgroundCacheDir(), fileName)

  try {
    return await fs.readFile(filePath)
  } catch {
    return null
  }
}

export async function cacheBackgroundImage(url = '') {
  if (typeof url !== 'string' || !url.trim()) {
    return {
      success: false,
      message: 'url is required'
    }
  }

  const response = await fetchWithProxy(url)
  if (!response.ok) {
    throw new Error(`Failed to fetch background image: ${response.status} ${response.statusText}`)
  }

  const arrayBuffer = await response.arrayBuffer()
  const buffer = Buffer.from(arrayBuffer)
  const contentType = response.headers.get('content-type') || 'image/png'
  const extensionMap = {
    'image/png': '.png',
    'image/jpeg': '.jpg',
    'image/jpg': '.jpg',
    'image/webp': '.webp',
    'image/gif': '.gif',
    'image/svg+xml': '.svg'
  }
  const ext = extensionMap[contentType.toLowerCase()] || '.img'
  const hash = getBackgroundCacheHash(url)
  const fileName = `${hash}${ext}`
  const cacheDir = await ensureBackgroundCacheDir()
  const filePath = path.join(cacheDir, fileName)
  await fs.writeFile(filePath, buffer)

  const cacheDoc = await readDocData(BACKGROUND_CACHE_DOC_ID, {})
  cacheDoc[hash] = fileName
  await writeDocData(BACKGROUND_CACHE_DOC_ID, cacheDoc)

  return {
    success: true,
    fileName,
    size: buffer.byteLength
  }
}

export async function importMemoryData(memories) {
  if (!Array.isArray(memories) || memories.length === 0) {
    return {
      success: true,
      imported: 0,
      skipped: 0
    }
  }

  let imported = 0
  let skipped = 0

  for (const mem of memories) {
    const memoryDoc = ensureObject(mem, null)
    if (!memoryDoc || typeof memoryDoc._id !== 'string' || !memoryDoc._id.startsWith('anywhere_mem_')) {
      skipped += 1
      continue
    }

    const existing = await dbGet(memoryDoc._id)
    const nextDoc = deepClone(memoryDoc)

    if (existing?.ok && existing.doc?._rev) {
      nextDoc._rev = existing.doc._rev
    } else {
      delete nextDoc._rev
    }

    const putResult = await dbPut(nextDoc)
    if (putResult?.ok) {
      imported += 1
    } else {
      skipped += 1
    }
  }

  return {
    success: true,
    imported,
    skipped
  }
}
