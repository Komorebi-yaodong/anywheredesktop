<script setup>
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import TitleBar from './components/TitleBar.vue'
import ChatHeader from './components/ChatHeader.vue'

const initialContext = window.api?.getWindowContext ? window.api.getWindowContext() : {}
const senderId = ref(initialContext.senderId || 'unknown')

const windowState = ref({
  isAlwaysOnTop: false,
  autoCloseOnBlur: false,
  isDarkMode: false,
  os: 'win'
})

const model = ref('')
const modelMap = ref({})
const systemPrompt = ref('')
const isMcpLoading = ref(false)

const promptName = computed(() => 'Anywhere Desktop')
const conversationName = computed(() => `窗口会话 (${senderId.value})`)

const onMediaThemeChange = (event) => {
  const nextDark = Boolean(event?.matches)
  windowState.value.isDarkMode = nextDark
  document.documentElement.classList.toggle('dark', nextDark)
}

const syncTheme = async () => {
  let themeMode = 'light'

  try {
    const configResult = await window.api?.getConfig?.()
    const config = configResult?.ok ? (configResult.config || {}) : {}
    themeMode = config?.themeMode || 'light'
  } catch {
    themeMode = 'light'
  }

  const media = window.matchMedia('(prefers-color-scheme: dark)')
  const prefersDark = media.matches
  const shouldDark = themeMode === 'dark' || (themeMode === 'auto' && prefersDark)

  windowState.value.isDarkMode = shouldDark
  document.documentElement.classList.toggle('dark', shouldDark)
}

const handleMinimize = async () => {
  await window.api?.minimizeWindow?.()
}

const handleMaximize = async () => {
  await window.api?.maximizeOrRestoreWindow?.()
}

const handleClose = async () => {
  await window.api?.closeWindow?.()
}

const handleToggleAlwaysOnTop = async () => {
  const next = !windowState.value.isAlwaysOnTop
  const result = await window.api?.toggleAlwaysOnTop?.({ alwaysOnTop: next })
  if (result?.ok && typeof result.alwaysOnTop === 'boolean') {
    windowState.value.isAlwaysOnTop = result.alwaysOnTop
  }
}

const handleTogglePin = () => {
  windowState.value.autoCloseOnBlur = !windowState.value.autoCloseOnBlur
}

const handleSaveWindowSize = async () => {
  const bounds = {
    width: window.innerWidth,
    height: window.innerHeight
  }
  await window.api?.dbStorageSetItem?.('window:lastBounds', bounds)
}

const handleSaveSession = async () => {
  await window.api?.dbStorageSetItem?.('window:lastSession', {
    senderId: senderId.value,
    savedAt: Date.now()
  })
}

const handleOpenModelDialog = () => {
  // C.2 再接入真实模型选择弹窗
}

const handleShowSystemPrompt = () => {
  // C.2 再接入系统提示词编辑
}

const handleOpenSearch = () => {
  // C.2 再接入搜索 UI
}

let alwaysOnTopListener = null

let themeMediaQuery = null

onMounted(async () => {
  if (window.api?.onWindowInit) {
    window.api.onWindowInit((payload = {}) => {
      if (typeof payload.senderId === 'string' && payload.senderId) {
        senderId.value = payload.senderId
      }
    })
  }

  if (window.api?.onAlwaysOnTopChanged) {
    alwaysOnTopListener = (payload = {}) => {
      if (typeof payload.alwaysOnTop === 'boolean') {
        windowState.value.isAlwaysOnTop = payload.alwaysOnTop
      }
    }
    window.api.onAlwaysOnTopChanged(alwaysOnTopListener)
  }

  await syncTheme()

  themeMediaQuery = window.matchMedia('(prefers-color-scheme: dark)')
  themeMediaQuery.addEventListener('change', onMediaThemeChange)
})

onBeforeUnmount(() => {
  if (themeMediaQuery) {
    themeMediaQuery.removeEventListener('change', onMediaThemeChange)
  }
})
</script>

<template>
  <div class="window-shell" :class="{ dark: windowState.isDarkMode }">
    <TitleBar
      :favicon="'/icon.png'"
      :prompt-name="promptName"
      :conversation-name="conversationName"
      :is-always-on-top="windowState.isAlwaysOnTop"
      :auto-close-on-blur="windowState.autoCloseOnBlur"
      :is-dark-mode="windowState.isDarkMode"
      :os="windowState.os"
      @save-window-size="handleSaveWindowSize"
      @save-session="handleSaveSession"
      @toggle-pin="handleTogglePin"
      @toggle-always-on-top="handleToggleAlwaysOnTop"
      @minimize="handleMinimize"
      @maximize="handleMaximize"
      @close="handleClose"
    />

    <ChatHeader
      :model-map="modelMap"
      :model="model"
      :is-mcp-loading="isMcpLoading"
      :system-prompt="systemPrompt"
      @open-model-dialog="handleOpenModelDialog"
      @show-system-prompt="handleShowSystemPrompt"
      @open-search="handleOpenSearch"
    />

    <main class="chat-stage">
      <div class="placeholder-card">
        <h3>Phase C.1 已接入窗口壳层</h3>
        <p>下一步将迁移 ChatInput / ChatMessage 并打通真实聊天链路。</p>
      </div>
    </main>
  </div>
</template>

<style scoped>
.window-shell {
  width: 100vw;
  height: 100vh;
  display: flex;
  flex-direction: column;
  background: var(--el-bg-color-page);
  color: var(--el-text-color-primary);
  overflow: hidden;
}

.chat-stage {
  flex: 1;
  min-height: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 16px;
}

.placeholder-card {
  width: min(720px, 100%);
  border-radius: 12px;
  padding: 20px;
  border: 1px solid var(--el-border-color);
  background: var(--el-bg-color);
}

.placeholder-card h3 {
  margin: 0 0 8px;
}

.placeholder-card p {
  margin: 0;
  color: var(--el-text-color-regular);
}
</style>
