<script setup>
import { onBeforeUnmount, onMounted, provide, ref, watch } from 'vue'
import Setting from './components/Setting.vue'
import Providers from './components/Providers.vue'
import Mcp from './components/Mcp.vue'
import Skills from './components/Skills.vue'
import Prompts from './components/Prompts.vue'
import Tasks from './components/Tasks.vue'

const appWindowType = ref('main')
const config = ref(null)
const loading = ref(false)
const loadError = ref('')
const activePage = ref('setting')

provide('config', config)

const defaultConfig = {
  themeMode: 'system',
  isDarkMode: false,
  isAlwaysOnTop_global: false,
  autoCloseOnBlur_global: false,
  autoSaveChat_global: false,
  skipLineBreak: false,
  CtrlEnterToSend: false,
  fix_position: false,
  voiceList: [],
  prompts: {},
  settingsCardOrder: ['general', 'voice', 'data', 'webdav'],
  settingsCardCollapsed: {
    general: false,
    voice: false,
    data: false,
    webdav: false
  },
  skillPath: '',
  webdav: {
    url: '',
    username: '',
    password: '',
    path: '/Anywhere',
    data_path: '/Anywhere/data',
    localChatPath: ''
  }
}

let systemThemeMediaQuery = null
let removeSystemThemeListener = null

function isPlainObject(value) {
  return Object.prototype.toString.call(value) === '[object Object]'
}

function deepMerge(target, source) {
  if (!isPlainObject(target) || !isPlainObject(source)) {
    return target
  }

  for (const [key, value] of Object.entries(source)) {
    if (Array.isArray(value)) {
      target[key] = [...value]
      continue
    }

    if (isPlainObject(value)) {
      if (!isPlainObject(target[key])) {
        target[key] = {}
      }
      deepMerge(target[key], value)
      continue
    }

    target[key] = value
  }

  return target
}

function ensureConfigShape(inputConfig) {
  const base = JSON.parse(JSON.stringify(defaultConfig))
  if (isPlainObject(inputConfig)) {
    deepMerge(base, inputConfig)
  }

  if (!Array.isArray(base.voiceList)) {
    base.voiceList = []
  }

  if (!isPlainObject(base.prompts)) {
    base.prompts = {}
  }

  if (!isPlainObject(base.webdav)) {
    base.webdav = JSON.parse(JSON.stringify(defaultConfig.webdav))
  }

  return base
}

function applyThemeClass() {
  const html = document.documentElement
  const mode = config.value?.themeMode || 'system'
  const isDarkMode = Boolean(config.value?.isDarkMode)
  const systemPrefersDark = systemThemeMediaQuery?.matches ?? false

  const shouldUseDark = mode === 'dark' || (mode === 'system' && systemPrefersDark) || isDarkMode

  if (shouldUseDark) {
    html.classList.add('dark')
  } else {
    html.classList.remove('dark')
  }
}

function bindSystemThemeListener() {
  if (typeof window?.matchMedia !== 'function') return

  systemThemeMediaQuery = window.matchMedia('(prefers-color-scheme: dark)')

  const handleSystemThemeChange = (event) => {
    if (!config.value || config.value.themeMode !== 'system') return

    config.value.isDarkMode = Boolean(event?.matches)
    if (window.api?.saveSetting) {
      window.api.saveSetting('isDarkMode', config.value.isDarkMode)
    }

    applyThemeClass()
  }

  if (typeof systemThemeMediaQuery.addEventListener === 'function') {
    systemThemeMediaQuery.addEventListener('change', handleSystemThemeChange)
    removeSystemThemeListener = () => {
      systemThemeMediaQuery?.removeEventListener('change', handleSystemThemeChange)
    }
    return
  }

  if (typeof systemThemeMediaQuery.addListener === 'function') {
    systemThemeMediaQuery.addListener(handleSystemThemeChange)
    removeSystemThemeListener = () => {
      systemThemeMediaQuery?.removeListener(handleSystemThemeChange)
    }
  }
}

async function loadConfig() {
  loading.value = true
  loadError.value = ''

  try {
    if (!window.api?.getConfig) {
      throw new Error('window.api.getConfig 不可用')
    }

    const result = await window.api.getConfig()
    config.value = ensureConfigShape(result?.config)
    applyThemeClass()
  } catch (error) {
    config.value = ensureConfigShape({})
    loadError.value = String(error?.message || error)
    applyThemeClass()
  } finally {
    loading.value = false
  }
}

watch(
  () => [config.value?.themeMode, config.value?.isDarkMode],
  () => {
    applyThemeClass()
  }
)

onMounted(async () => {
  const context = window.api?.getWindowContext ? window.api.getWindowContext() : {}
  if (typeof context?.appWindowType === 'string' && context.appWindowType) {
    appWindowType.value = context.appWindowType
  }

  bindSystemThemeListener()
  await loadConfig()
})

onBeforeUnmount(() => {
  if (typeof removeSystemThemeListener === 'function') {
    removeSystemThemeListener()
  }
})
</script>

<template>
  <div class="main-shell">
    <header class="main-header">
      <h1>Anywhere Main (Desktop)</h1>
      <span class="sub">窗口类型：{{ appWindowType }}</span>
    </header>


    <section v-if="!loading && !loadError" class="main-nav">
      <el-button-group>
        <el-button :type="activePage === 'setting' ? 'primary' : 'default'" @click="activePage = 'setting'">
          设置
        </el-button>
        <el-button :type="activePage === 'providers' ? 'primary' : 'default'" @click="activePage = 'providers'">
          服务商
        </el-button>
        <el-button :type="activePage === 'mcp' ? 'primary' : 'default'" @click="activePage = 'mcp'">
          MCP
        </el-button>
        <el-button :type="activePage === 'skills' ? 'primary' : 'default'" @click="activePage = 'skills'">
          技能
        </el-button>
        <el-button :type="activePage === 'prompts' ? 'primary' : 'default'" @click="activePage = 'prompts'">
          快捷助手
        </el-button>
        <el-button :type="activePage === 'tasks' ? 'primary' : 'default'" @click="activePage = 'tasks'">
          定时任务
        </el-button>



      </el-button-group>
    </section>

    <section v-if="loading" class="state-card">正在加载配置...</section>

    <section v-else-if="loadError" class="state-card error">
      <p>配置加载失败：{{ loadError }}</p>
      <button @click="loadConfig">重试</button>
    </section>

    <template v-else-if="config">
      <Setting v-if="activePage === 'setting'" />
      <Providers v-else-if="activePage === 'providers'" />
      <Mcp v-else-if="activePage === 'mcp'" />
      <Skills v-else-if="activePage === 'skills'" />
      <Prompts v-else-if="activePage === 'prompts'" />
      <Tasks v-else-if="activePage === 'tasks'" />



    </template>
  </div>
</template>

<style scoped>
.main-shell {
  height: 100vh;
  display: flex;
  flex-direction: column;
}

.main-header {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  padding: 12px 16px;
  border-bottom: 1px solid var(--el-border-color-light);
}

.main-header h1 {
  font-size: 16px;
  margin: 0;
}

.sub {
  font-size: 12px;
  color: var(--el-text-color-secondary);
}

.state-card {
  margin: 16px;
  padding: 12px;
  border: 1px solid var(--el-border-color);
  border-radius: 8px;
  color: var(--el-text-color-regular);
}

.state-card.error {
  border-color: var(--el-color-danger-light-5);
  color: var(--el-color-danger);
}


.main-nav {
  margin: 10px 16px 0;
}

button {
  margin-top: 8px;
  border: 1px solid var(--el-border-color);
  background: var(--el-bg-color-overlay);
  border-radius: 6px;
  padding: 6px 10px;
  cursor: pointer;
}
</style>
