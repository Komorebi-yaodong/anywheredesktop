import { safeClone } from '../dataConverter.js'
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
const CURRENT_CONFIG_VERSION = '2.1.15'

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

function getLocalConfigId() {
  return LOCAL_CONFIG_DOC_ID
}

function ensureObject(value, fallback = {}) {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    return value
  }
  return fallback
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
  return {}
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
    settingsCardOrder: ['general', 'voice', 'data', 'webdav'],
    settingsCardCollapsed: {
      general: false,
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
    config.settingsCardOrder = ['general', 'voice', 'data', 'webdav']
    changed = true
  }

  if (!config.settingsCardCollapsed || typeof config.settingsCardCollapsed !== 'object') {
    config.settingsCardCollapsed = {
      general: false,
      voice: false,
      data: false,
      webdav: false
    }
    changed = true
  }

  if (!config.defaultTaskModel) {
    const firstProviderId = config.providerOrder[0]
    const firstProvider = config.providers[firstProviderId]
    const firstModel = firstProvider?.modelList?.[0]
    if (firstProviderId && firstModel) {
      config.defaultTaskModel = `${firstProviderId}|${firstModel}`
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

  return {
    success: true
  }
}

export async function updateConfig(newConfig) {
  return updateConfigWithoutFeatures(newConfig)
}

export async function exportMemoryData() {
  const result = await dbAllDocs({ includeDocs: true })
  const rows = Array.isArray(result?.rows) ? result.rows : []

  return rows
    .map((row) => row?.doc)
    .filter((doc) => doc && typeof doc._id === 'string' && doc._id.startsWith('anywhere_mem_'))
    .map((doc) => deepClone(doc))
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
