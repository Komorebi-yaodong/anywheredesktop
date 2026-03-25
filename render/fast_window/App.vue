<script setup>
import { computed, onMounted, ref } from 'vue'
import { ElMessage } from 'element-plus'

const initialContext = window.api?.getWindowContext ? window.api.getWindowContext() : {}
const appWindowType = ref(initialContext.appWindowType || 'fast_window')
const senderId = ref(initialContext.senderId || 'fast')
const currentConfig = ref(null)
const currentPayload = ref({ code: 'AI', type: 'empty', payload: '', userText: '' })
const promptConfig = ref(null)
const renderedSummary = ref('等待内容…')
const isInitializing = ref(false)
const lastError = ref('')

function getErrorMessage(error, fallback = '操作失败') {
  if (!error) return fallback
  if (typeof error === 'string') return error
  if (typeof error?.message === 'string' && error.message) return error.message
  return fallback
}

function normalizePromptConfig(config = {}, code = 'AI') {
  const prompts = config?.prompts && typeof config.prompts === 'object' ? config.prompts : {}
  return prompts[code] || prompts.AI || null
}

function buildSummary(payload = {}) {
  if (payload.type === 'img') {
    return payload.userText?.trim() ? `图片 + ${payload.userText.trim()}` : '图片'
  }

  if (payload.type === 'files') {
    const files = Array.isArray(payload.payload) ? payload.payload : []
    const firstPath = files[0]?.path || ''
    const firstName = firstPath ? firstPath.split(/[/\\]/).pop() || firstPath : '文件'
    const label = files.length > 1 ? `${firstName} 等 ${files.length} 项` : firstName
    return payload.userText?.trim() ? `${label} + ${payload.userText.trim()}` : label
  }

  if (payload.type === 'over') {
    return String(payload.payload || '').replace(/\s+/g, ' ').trim() || '文本'
  }

  return '等待内容…'
}

async function dispatchToWindow() {
  const payload = currentPayload.value
  if (!payload?.code) return

  try {
    await window.api.openWindow('window', payload)
    await window.api.closeWindow(senderId.value)
  } catch (error) {
    lastError.value = getErrorMessage(error)
    ElMessage.error(lastError.value)
  }
}

async function initializeFastWindow(payload = {}) {
  isInitializing.value = true
  lastError.value = ''

  try {
    if (!currentConfig.value) {
      const result = await window.api.getConfig()
      currentConfig.value = result?.config || {}
      document.documentElement.classList.toggle('dark', Boolean(currentConfig.value?.isDarkMode))
    }

    const code = typeof payload.code === 'string' && payload.code ? payload.code : 'AI'
    const nextPayload = {
      code,
      type: typeof payload.type === 'string' && payload.type ? payload.type : 'empty',
      payload: payload.payload ?? '',
      userText: typeof payload.userText === 'string' ? payload.userText : ''
    }

    currentPayload.value = nextPayload
    promptConfig.value = normalizePromptConfig(currentConfig.value, code)
    renderedSummary.value = buildSummary(nextPayload)

    await dispatchToWindow()
  } catch (error) {
    lastError.value = getErrorMessage(error, '初始化失败')
    ElMessage.error(lastError.value)
  } finally {
    isInitializing.value = false
  }
}

const promptTitle = computed(() => currentPayload.value.code || 'AI')
const promptIcon = computed(() => {
  return typeof promptConfig.value?.icon === 'string' && promptConfig.value.icon ? promptConfig.value.icon : ''
})

if (window.api?.onWindowInit) {
  window.api.onWindowInit((payload = {}) => {
    if (typeof payload.windowType === 'string' && payload.windowType) {
      appWindowType.value = payload.windowType
    }

    if (typeof payload.senderId === 'string' && payload.senderId) {
      senderId.value = payload.senderId
    }

    initializeFastWindow(payload)
  })
}

onMounted(async () => {
  try {
    const result = await window.api.getConfig()
    currentConfig.value = result?.config || {}
    document.documentElement.classList.toggle('dark', Boolean(currentConfig.value?.isDarkMode))
  } catch (error) {
    lastError.value = getErrorMessage(error, '加载配置失败')
  }
})
</script>

<template>
  <div class="fast-shell">
    <div class="fast-card">
      <div class="fast-icon-wrap">
        <img v-if="promptIcon" :src="promptIcon" :alt="promptTitle" class="fast-icon" />
        <div v-else class="fast-fallback">{{ promptTitle.slice(0, 1).toUpperCase() }}</div>
      </div>
      <div class="fast-copy">
        <div class="fast-title">{{ promptTitle }}</div>
        <div class="fast-summary">{{ renderedSummary }}</div>
        <div v-if="isInitializing" class="fast-status">正在召唤…</div>
        <div v-else-if="lastError" class="fast-status error">{{ lastError }}</div>
        <div v-else class="fast-status">已转发到独立窗口</div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.fast-shell {
  min-height: 100vh;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 20px;
  box-sizing: border-box;
  background: transparent;
}

.fast-card {
  width: min(560px, 100%);
  min-height: 92px;
  display: flex;
  align-items: center;
  gap: 14px;
  padding: 16px 18px;
  border-radius: 18px;
  background: rgba(255, 255, 255, 0.94);
  box-shadow: 0 18px 42px rgba(0, 0, 0, 0.16);
}

html.dark .fast-card {
  background: rgba(30, 30, 34, 0.96);
}

.fast-icon-wrap {
  width: 58px;
  height: 58px;
  border-radius: 14px;
  overflow: hidden;
  flex-shrink: 0;
  background: rgba(0, 0, 0, 0.06);
  display: flex;
  align-items: center;
  justify-content: center;
}

html.dark .fast-icon-wrap {
  background: rgba(255, 255, 255, 0.1);
}

.fast-icon {
  width: 100%;
  height: 100%;
  object-fit: cover;
}

.fast-fallback {
  font-size: 22px;
  font-weight: 700;
  color: #565666;
}

html.dark .fast-fallback {
  color: #f2f2f6;
}

.fast-copy {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.fast-title {
  font-size: 16px;
  font-weight: 700;
  color: #202028;
}

html.dark .fast-title {
  color: #f5f5f7;
}

.fast-summary {
  font-size: 13px;
  color: #4f4f59;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

html.dark .fast-summary {
  color: #d6d6dd;
}

.fast-status {
  font-size: 12px;
  color: #7b7b85;
}

.fast-status.error {
  color: #d84b4b;
}
</style>
