<script setup>
import { onBeforeUnmount, onMounted, ref, watch } from 'vue'

const initialContext = window.api?.getWindowContext ? window.api.getWindowContext() : {}
const appWindowType = ref(initialContext.appWindowType || 'main')
const senderId = ref(initialContext.senderId || 'main')
const lastIncomingEvent = ref('（暂无）')

const loadingConfig = ref(false)
const config = ref(null)
const configJson = ref('')

const themeMode = ref('system')
const isDarkMode = ref(false)
const skillPath = ref('')
const localChatPath = ref('')

const memoryPayload = ref('[]')
const operationLog = ref([])

let systemThemeMediaQuery = null
let removeSystemThemeListener = null

function applyThemeClass(targetMode = themeMode.value, targetDark = isDarkMode.value) {
  const html = document.documentElement
  const systemPrefersDark = systemThemeMediaQuery?.matches ?? false

  const shouldUseDark = targetMode === 'dark' || (targetMode === 'system' && systemPrefersDark) || targetDark

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
    if (themeMode.value === 'system') {
      isDarkMode.value = Boolean(event?.matches)
      applyThemeClass('system', isDarkMode.value)
    }
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


function appendLog(message, payload = null) {
  const timestamp = new Date().toLocaleTimeString()
  const line = payload ? `${timestamp} ${message} ${JSON.stringify(payload)}` : `${timestamp} ${message}`
  operationLog.value.unshift(line)
  if (operationLog.value.length > 20) {
    operationLog.value = operationLog.value.slice(0, 20)
  }
}

function syncSettingDraftByConfig(currentConfig) {
  if (!currentConfig || typeof currentConfig !== 'object') return

  themeMode.value = currentConfig.themeMode || 'system'
  isDarkMode.value = Boolean(currentConfig.isDarkMode)
  skillPath.value = currentConfig.skillPath || ''
  localChatPath.value = currentConfig?.webdav?.localChatPath || ''
}

async function loadConfig() {
  loadingConfig.value = true
  try {
    if (!window.api?.getConfig) {
      throw new Error('window.api.getConfig 不可用')
    }

    const result = await window.api.getConfig()
    const nextConfig = result?.config || null

    config.value = nextConfig
    configJson.value = JSON.stringify(nextConfig || {}, null, 2)
    syncSettingDraftByConfig(nextConfig)

    appendLog('[配置] 已刷新', { hasConfig: Boolean(nextConfig) })
  } catch (error) {
    appendLog('[配置] 刷新失败', { error: String(error?.message || error) })
    console.error('[render:main] loadConfig failed', error)
  } finally {
    loadingConfig.value = false
  }
}

async function saveQuickSettings() {
  try {
    if (!window.api?.saveSetting) {
      throw new Error('window.api.saveSetting 不可用')
    }

    await window.api.saveSetting('themeMode', themeMode.value)
    await window.api.saveSetting('isDarkMode', isDarkMode.value)
    await window.api.saveSetting('skillPath', skillPath.value)
    await window.api.saveSetting('webdav.localChatPath', localChatPath.value)

    appendLog('[配置] 快速设置保存成功')
    await loadConfig()
  } catch (error) {
    appendLog('[配置] 快速设置保存失败', { error: String(error?.message || error) })
    console.error('[render:main] saveQuickSettings failed', error)
  }
}

async function saveFullConfigByJson() {
  try {
    if (!window.api?.updateConfig) {
      throw new Error('window.api.updateConfig 不可用')
    }

    const parsed = JSON.parse(configJson.value)
    await window.api.updateConfig({ config: parsed })

    appendLog('[配置] 全量配置保存成功')
    await loadConfig()
  } catch (error) {
    appendLog('[配置] 全量配置保存失败', { error: String(error?.message || error) })
    console.error('[render:main] saveFullConfigByJson failed', error)
  }
}

async function exportMemoriesToTextarea() {
  try {
    if (!window.api?.exportMemoryData) {
      throw new Error('window.api.exportMemoryData 不可用')
    }

    const memories = await window.api.exportMemoryData()
    memoryPayload.value = JSON.stringify(memories || [], null, 2)
    appendLog('[Memory] 导出成功', { count: Array.isArray(memories) ? memories.length : 0 })
  } catch (error) {
    appendLog('[Memory] 导出失败', { error: String(error?.message || error) })
    console.error('[render:main] exportMemoriesToTextarea failed', error)
  }
}

async function importMemoriesFromTextarea() {
  try {
    if (!window.api?.importMemoryData) {
      throw new Error('window.api.importMemoryData 不可用')
    }

    const parsed = JSON.parse(memoryPayload.value)
    const result = await window.api.importMemoryData(parsed)

    appendLog('[Memory] 导入完成', result)
  } catch (error) {
    appendLog('[Memory] 导入失败', { error: String(error?.message || error) })
    console.error('[render:main] importMemoriesFromTextarea failed', error)
  }
}

async function openWindow(type) {
  try {
    if (window.api?.openWindow) {
      await window.api.openWindow(type)
      appendLog('[窗口] 已打开窗口', { type })
    }
  } catch (error) {
    appendLog('[窗口] 打开失败', { type, error: String(error?.message || error) })
  }
}

async function hideMainWindow() {
  try {
    if (window.api?.hideMainWindow) {
      await window.api.hideMainWindow()
      appendLog('[窗口] 已最小化主窗口')
    }
  } catch (error) {
    appendLog('[窗口] 最小化失败', { error: String(error?.message || error) })
  }
}

async function refreshWindows() {
  try {
    if (window.api?.listWindows) {
      const result = await window.api.listWindows('')
      lastIncomingEvent.value = JSON.stringify(result)
      appendLog('[窗口] 窗口列表刷新完成')
    }
  } catch (error) {
    appendLog('[窗口] 列表刷新失败', { error: String(error?.message || error) })
  }
}

if (window.api?.onWindowEvent) {
  window.api.onWindowEvent((event) => {
    lastIncomingEvent.value = JSON.stringify(event)
  })
}

if (window.api?.onWindowInit) {
  window.api.onWindowInit((payload = {}) => {
    if (typeof payload.windowType === 'string' && payload.windowType) {
      appWindowType.value = payload.windowType
    }

    if (typeof payload.senderId === 'string' && payload.senderId) {
      senderId.value = payload.senderId
    }
  })
}

watch(
  [themeMode, isDarkMode],
  ([nextMode, nextDark]) => {
    applyThemeClass(nextMode, nextDark)
  },
  { immediate: true }
)


onMounted(async () => {
  bindSystemThemeListener()
  await loadConfig()
  applyThemeClass()
})

onBeforeUnmount(() => {
  if (typeof removeSystemThemeListener === 'function') {
    removeSystemThemeListener()
  }
})
</script>

<template>
  <div class="page">
    <h1>Anywhere Main (Desktop)</h1>
    <p>当前窗口：{{ appWindowType }} | senderId：{{ senderId }}</p>

    <section class="card">
      <h2>窗口联调</h2>
      <div class="actions">
        <button @click="openWindow('window')">打开对话窗口</button>
        <button @click="openWindow('fast')">打开快捷窗口</button>
        <button @click="hideMainWindow">最小化主窗口</button>
        <button @click="refreshWindows">查询窗口列表</button>
      </div>
      <p class="muted">最近事件：{{ lastIncomingEvent }}</p>
    </section>

    <section class="card">
      <h2>配置联调（Step B.2.1）</h2>
      <div class="actions">
        <button :disabled="loadingConfig" @click="loadConfig">刷新配置</button>
        <button @click="saveQuickSettings">保存快速设置</button>
      </div>

      <div class="grid">
        <label>
          Theme Mode
          <select v-model="themeMode">
            <option value="system">system</option>
            <option value="dark">dark</option>
            <option value="light">light</option>
          </select>
        </label>

        <label>
          Is Dark Mode
          <input v-model="isDarkMode" type="checkbox" />
        </label>

        <label>
          Skill Path
          <input v-model="skillPath" type="text" placeholder="例如：E:\\Programming\\Anywhere\\skill" />
        </label>

        <label>
          WebDAV Local Chat Path
          <input v-model="localChatPath" type="text" placeholder="例如：E:\\Data\\AnywhereChat" />
        </label>
      </div>

      <label class="full-width">
        全量配置 JSON（可直接编辑后保存）
        <textarea v-model="configJson" rows="12"></textarea>
      </label>
      <div class="actions">
        <button @click="saveFullConfigByJson">保存全量配置</button>
      </div>
    </section>

    <section class="card">
      <h2>Memory 导入导出联调</h2>
      <div class="actions">
        <button @click="exportMemoriesToTextarea">导出 Memory</button>
        <button @click="importMemoriesFromTextarea">导入 Memory</button>
      </div>
      <textarea v-model="memoryPayload" rows="10"></textarea>
    </section>

    <section class="card">
      <h2>操作日志</h2>
      <ul class="logs">
        <li v-for="line in operationLog" :key="line">{{ line }}</li>
      </ul>
    </section>
  </div>
</template>

<style scoped>
.page {
  padding: 16px;
  font-family: 'Segoe UI', 'PingFang SC', sans-serif;
  color: #1f2937;
}

.card {
  border: 1px solid #d1d5db;
  border-radius: 8px;
  padding: 12px;
  margin-bottom: 12px;
  background: #ffffff;
}

.actions {
  display: flex;
  gap: 8px;
  flex-wrap: wrap;
  margin-bottom: 8px;
}

button {
  padding: 6px 10px;
  border-radius: 6px;
  border: 1px solid #9ca3af;
  background: #f3f4f6;
  cursor: pointer;
}

button:hover {
  background: #e5e7eb;
}

.grid {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 8px;
}

label {
  display: flex;
  flex-direction: column;
  gap: 6px;
  font-size: 13px;
}

.full-width {
  display: block;
  margin-top: 8px;
}

input[type='text'],
select,
textarea {
  border: 1px solid #cbd5e1;
  border-radius: 6px;
  padding: 6px 8px;
  font-family: 'Consolas', 'Courier New', monospace;
}

.muted {
  color: #6b7280;
  font-size: 12px;
}

.logs {
  margin: 0;
  padding-left: 18px;
  max-height: 220px;
  overflow: auto;
  font-size: 12px;
  line-height: 1.5;
}
</style>
