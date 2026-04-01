<script setup>
import { computed, onMounted, ref } from 'vue'
import { ElMessage } from 'element-plus'

const initialContext = window.api?.getWindowContext ? window.api.getWindowContext() : {}
const senderId = ref(initialContext.senderId || 'fast')
const currentPayload = ref({
  code: 'AI',
  type: 'empty',
  payload: '',
  userText: '',
  promptKey: '',
  triggerMode: ''
})
const promptConfig = ref({})
const providerInfo = ref({})
const sessionStatus = ref('booting')
const streamText = ref('')
const inlineInputText = ref('')
const deferredAttachments = ref([])
const lastError = ref('')
const sessionRequestId = ref('')
const currentConfig = ref(null)

function getErrorMessage(error, fallback = '操作失败') {
  if (!error) return fallback
  if (typeof error === 'string') return error
  if (typeof error?.message === 'string' && error.message) return error.message
  return fallback
}

function normalizePayloadSummary(payload = {}) {
  if (payload.type === 'img') {
    return payload.userText?.trim() ? `图片 + ${payload.userText.trim()}` : '图片'
  }

  if (payload.type === 'files') {
    const files = Array.isArray(payload.payload) ? payload.payload : []
    const first = files[0] || {}
    const firstName = first.name || first.path?.split(/[/\\]/).pop() || '文件'
    return payload.userText?.trim() ? `${firstName}${files.length > 1 ? ` 等 ${files.length} 项` : ''} + ${payload.userText.trim()}` : `${firstName}${files.length > 1 ? ` 等 ${files.length} 项` : ''}`
  }

  if (payload.type === 'multiline-text') {
    return '多行文本（待补充/编辑）'
  }

  if (payload.type === 'over') {
    return String(payload.payload || '').replace(/\s+/g, ' ').trim() || '文本'
  }

  return '等待内容…'
}

const promptTitle = computed(() => currentPayload.value.code || currentPayload.value.promptKey || 'AI')
const promptIcon = computed(() => {
  return typeof promptConfig.value?.icon === 'string' && promptConfig.value.icon ? promptConfig.value.icon : ''
})
const promptModelLabel = computed(() => {
  if (providerInfo.value?.modelValue) return providerInfo.value.modelValue
  if (promptConfig.value?.model) return promptConfig.value.model
  return ''
})
const renderedSummary = computed(() => normalizePayloadSummary(currentPayload.value))
const canCopy = computed(() => Boolean(streamText.value.trim()))
const canPaste = computed(() => Boolean(streamText.value.trim() || inlineInputText.value.trim()))
const displayText = computed(() => {
  if (streamText.value.trim()) return streamText.value.trim()
  if (inlineInputText.value.trim()) return inlineInputText.value.trim()
  return renderedSummary.value
})
const statusLabel = computed(() => {
  if (sessionStatus.value === 'streaming') return '正在生成…'
  if (sessionStatus.value === 'done') return '已完成，可复制或发送'
  if (sessionStatus.value === 'input-only') return deferredAttachments.value.length > 0 ? '当前内容需进入独立窗口继续处理' : '当前内容可直接发送到输入框'
  if (sessionStatus.value === 'empty') return '未检测到可处理内容'
  if (sessionStatus.value === 'error') return lastError.value || '执行失败'
  return '初始化中…'
})

function applyInitPayload(data = {}) {
  if (typeof data.senderId === 'string' && data.senderId) {
    senderId.value = data.senderId
  }

  currentPayload.value = {
    code: typeof data.code === 'string' && data.code ? data.code : promptTitle.value,
    type: typeof data.type === 'string' && data.type ? data.type : 'empty',
    payload: data.payload ?? '',
    userText: typeof data.userText === 'string' ? data.userText : '',
    promptKey: typeof data.promptKey === 'string' ? data.promptKey : '',
    triggerMode: typeof data.triggerMode === 'string' ? data.triggerMode : ''
  }

  promptConfig.value = data.promptConfig && typeof data.promptConfig === 'object' ? data.promptConfig : {}
  providerInfo.value = data.providerInfo && typeof data.providerInfo === 'object' ? data.providerInfo : {}
  inlineInputText.value = typeof data.inputText === 'string' ? data.inputText : ''
  deferredAttachments.value = Array.isArray(data.deferredAttachments) ? data.deferredAttachments : []

  if (data?.config && typeof data.config === 'object') {
    currentConfig.value = data.config
    document.documentElement.classList.toggle('dark', Boolean(data.config.isDarkMode))
  }
}

async function copyResult() {
  try {
    if (!canCopy.value) return
    await window.api.copyText(streamText.value)
    ElMessage.success('已复制到剪贴板')
  } catch (error) {
    ElMessage.error(getErrorMessage(error, '复制失败'))
  }
}

async function pasteToActiveInput() {
  try {
    const textToPaste = streamText.value.trim() || inlineInputText.value.trim()
    if (!textToPaste) return
    const result = await window.api.pasteTextToActiveInput(textToPaste)
    if (result?.ok) {
      ElMessage.success('已发送到当前输入框')
      await closeFastInput()
      return
    }
    throw new Error(result?.message || result?.reason || '发送失败')
  } catch (error) {
    ElMessage.error(getErrorMessage(error, '发送到输入框失败'))
  }
}

async function closeFastInput() {
  try {
    await window.api.closeWindow(senderId.value)
  } catch {
    // ignore fire-and-forget close
  }
}

function handleFastInputEvent(event = {}) {
  const eventType = typeof event?.type === 'string' ? event.type : ''
  const payload = event?.payload && typeof event.payload === 'object' ? event.payload : {}

  if (eventType === 'session:init') {
    applyInitPayload(payload)
    sessionStatus.value = 'ready'
    lastError.value = ''
    streamText.value = ''
    return
  }

  if (eventType === 'session:start') {
    sessionStatus.value = 'streaming'
    lastError.value = ''
    return
  }

  if (eventType === 'session:idle') {
    sessionStatus.value = payload?.status || 'input-only'
    deferredAttachments.value = Array.isArray(payload?.deferredAttachments) ? payload.deferredAttachments : deferredAttachments.value
    inlineInputText.value = typeof payload?.inputText === 'string' ? payload.inputText : inlineInputText.value
    return
  }

  if (eventType === 'session:chunk') {
    sessionStatus.value = 'streaming'
    sessionRequestId.value = typeof payload?.requestId === 'string' ? payload.requestId : sessionRequestId.value
    streamText.value = typeof payload?.text === 'string' ? payload.text : streamText.value + (payload?.chunk || '')
    return
  }

  if (eventType === 'session:done') {
    sessionStatus.value = 'done'
    sessionRequestId.value = typeof payload?.requestId === 'string' ? payload.requestId : sessionRequestId.value
    streamText.value = typeof payload?.text === 'string' ? payload.text : streamText.value
    return
  }

  if (eventType === 'session:error') {
    sessionStatus.value = 'error'
    sessionRequestId.value = typeof payload?.requestId === 'string' ? payload.requestId : sessionRequestId.value
    lastError.value = typeof payload?.message === 'string' ? payload.message : '快捷输入执行失败'
    if (typeof payload?.text === 'string' && payload.text) {
      streamText.value = payload.text
    }
  }
}

if (window.api?.onWindowInit) {
  window.api.onWindowInit((payload = {}) => {
    if (typeof payload.windowType === 'string' && payload.windowType) {
      document.documentElement.dataset.windowType = payload.windowType
    }
    if (typeof payload.senderId === 'string' && payload.senderId) {
      senderId.value = payload.senderId
    }
  })
}

if (window.api?.onFastInputEvent) {
  window.api.onFastInputEvent((event) => {
    handleFastInputEvent(event)
  })
}

onMounted(async () => {
  try {
    const configResult = await window.api.getConfig()
    const nextConfig = configResult?.config || {}
    currentConfig.value = nextConfig
    document.documentElement.classList.toggle('dark', Boolean(nextConfig?.isDarkMode))
  } catch {
    // ignore initial config fallback failure
  }
})
</script>

<template>
  <div class="fast-shell">
    <div class="fast-card" :class="[`status-${sessionStatus}`]">
      <div class="card-glow"></div>

      <button class="side-button close-button" type="button" title="关闭" @click="closeFastInput">
        ✕
      </button>

      <div class="content-zone">
        <div class="title-row">
          <div class="icon-wrap">
            <img v-if="promptIcon" :src="promptIcon" :alt="promptTitle" class="prompt-icon" />
            <div v-else class="fallback-icon">{{ promptTitle.slice(0, 1).toUpperCase() }}</div>
          </div>
          <div class="title-copy">
            <div class="title-main">
              <span class="title-text">{{ promptTitle }}</span>
              <span v-if="promptModelLabel" class="model-chip">{{ promptModelLabel }}</span>
            </div>
            <div class="subtitle-text">{{ statusLabel }}</div>
          </div>
        </div>

        <div class="summary-row">{{ renderedSummary }}</div>

        <div class="stream-panel">
          <div class="stream-text">{{ displayText }}</div>
        </div>

        <div v-if="deferredAttachments.length > 0" class="attachment-tip">
          已暂存 {{ deferredAttachments.length }} 个附件，本轮快捷输入暂不直接处理附件投递。
        </div>

        <div v-if="lastError && sessionStatus === 'error'" class="error-tip">{{ lastError }}</div>
      </div>

      <div class="action-zone">
        <button
          v-if="sessionStatus === 'streaming'"
          class="side-button loading-button"
          type="button"
          title="生成中"
          disabled
        >
          <span class="spinner"></span>
        </button>
        <button
          v-else
          class="side-button paste-button"
          type="button"
          title="发送到当前输入框"
          :disabled="!canPaste"
          @click="pasteToActiveInput"
        >
          ⇪
        </button>
      </div>

      <button
        v-if="canCopy"
        class="copy-chip"
        type="button"
        title="复制结果"
        @click="copyResult"
      >
        复制结果
      </button>
    </div>
  </div>
</template>

<style scoped>
.fast-shell {
  min-height: 100vh;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 18px;
  background: transparent;
}

.fast-card {
  position: relative;
  width: min(100%, 560px);
  min-height: 136px;
  border-radius: 999px;
  background: rgba(255, 255, 255, 0.96);
  border: 1px solid rgba(22, 24, 35, 0.08);
  box-shadow: 0 18px 46px rgba(15, 23, 42, 0.16);
  backdrop-filter: blur(18px);
  display: grid;
  grid-template-columns: 42px 1fr 42px;
  align-items: center;
  gap: 10px;
  padding: 14px 18px;
  overflow: hidden;
}

html.dark .fast-card {
  background: rgba(26, 28, 34, 0.96);
  border-color: rgba(255, 255, 255, 0.08);
  box-shadow: 0 22px 52px rgba(0, 0, 0, 0.4);
}

.fast-card.status-done {
  border-color: rgba(245, 158, 11, 0.5);
}

.fast-card.status-error {
  border-color: rgba(239, 68, 68, 0.45);
}

.card-glow {
  position: absolute;
  inset: 0;
  pointer-events: none;
  background: radial-gradient(circle at top center, rgba(99, 102, 241, 0.12), transparent 58%);
}

html.dark .card-glow {
  background: radial-gradient(circle at top center, rgba(139, 92, 246, 0.16), transparent 58%);
}

.content-zone {
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 8px;
  z-index: 1;
}

.title-row {
  display: flex;
  align-items: center;
  gap: 12px;
  min-width: 0;
}

.icon-wrap {
  width: 44px;
  height: 44px;
  border-radius: 14px;
  overflow: hidden;
  flex-shrink: 0;
  background: rgba(15, 23, 42, 0.06);
  display: flex;
  align-items: center;
  justify-content: center;
}

html.dark .icon-wrap {
  background: rgba(255, 255, 255, 0.1);
}

.prompt-icon {
  width: 100%;
  height: 100%;
  object-fit: cover;
}

.fallback-icon {
  font-size: 18px;
  font-weight: 800;
  color: #4b5563;
}

html.dark .fallback-icon {
  color: #f3f4f6;
}

.title-copy {
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.title-main {
  display: flex;
  align-items: center;
  gap: 8px;
  min-width: 0;
}

.title-text {
  font-size: 15px;
  font-weight: 800;
  color: #161824;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

html.dark .title-text {
  color: #f5f7fb;
}

.model-chip {
  flex-shrink: 0;
  max-width: 220px;
  padding: 2px 8px;
  border-radius: 999px;
  background: rgba(99, 102, 241, 0.1);
  color: #4f46e5;
  font-size: 11px;
  font-weight: 600;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

html.dark .model-chip {
  background: rgba(139, 92, 246, 0.18);
  color: #c4b5fd;
}

.subtitle-text,
.summary-row,
.stream-text,
.attachment-tip {
  color: #4b5563;
}

html.dark .subtitle-text,
html.dark .summary-row,
html.dark .stream-text,
html.dark .attachment-tip {
  color: #cbd5e1;
}

.subtitle-text {
  font-size: 12px;
}

.summary-row {
  font-size: 12px;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.stream-panel {
  min-height: 24px;
  max-height: 58px;
  overflow: hidden;
}

.stream-text {
  font-size: 13px;
  line-height: 1.45;
  word-break: break-word;
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
  overflow: hidden;
}

.attachment-tip {
  font-size: 11px;
}

.error-tip {
  color: #dc2626;
  font-size: 12px;
}

.side-button {
  width: 34px;
  height: 34px;
  border: none;
  border-radius: 50%;
  background: rgba(15, 23, 42, 0.06);
  color: #111827;
  cursor: pointer;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  transition: transform 0.15s ease, background-color 0.15s ease, color 0.15s ease;
  z-index: 1;
}

.side-button:hover:not(:disabled) {
  transform: scale(1.05);
  background: rgba(15, 23, 42, 0.1);
}

.side-button:disabled {
  cursor: not-allowed;
  opacity: 0.55;
}

html.dark .side-button {
  background: rgba(255, 255, 255, 0.1);
  color: #f9fafb;
}

.close-button:hover {
  color: #dc2626;
}

.paste-button:hover:not(:disabled) {
  color: #7c3aed;
}

.action-zone {
  display: flex;
  justify-content: center;
  align-items: center;
}

.copy-chip {
  position: absolute;
  left: 50%;
  bottom: 10px;
  transform: translateX(-50%);
  border: none;
  border-radius: 999px;
  padding: 6px 12px;
  background: rgba(16, 185, 129, 0.12);
  color: #059669;
  font-size: 11px;
  font-weight: 700;
  cursor: pointer;
  z-index: 2;
}

html.dark .copy-chip {
  background: rgba(16, 185, 129, 0.18);
  color: #6ee7b7;
}

.spinner {
  width: 14px;
  height: 14px;
  border-radius: 50%;
  border: 2px solid rgba(99, 102, 241, 0.18);
  border-top-color: #6366f1;
  animation: spin 0.9s linear infinite;
}

html.dark .spinner {
  border-color: rgba(196, 181, 253, 0.2);
  border-top-color: #c4b5fd;
}

@keyframes spin {
  to {
    transform: rotate(360deg);
  }
}
</style>
