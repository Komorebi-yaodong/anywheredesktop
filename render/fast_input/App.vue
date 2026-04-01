<script setup>
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
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
const sessionStatus = ref('booting')
const streamText = ref('')
const inlineInputText = ref('')
const lastError = ref('')
const isCopied = ref(false)
const isDragging = ref(false)
const autoCopied = ref(false)
let copiedResetTimer = null
let blurAutoCloseTimer = null
let keyboardCleanup = null

function getErrorMessage(error, fallback = '操作失败') {
  if (!error) return fallback
  if (typeof error === 'string') return error
  if (typeof error?.message === 'string' && error.message) return error.message
  return fallback
}

const promptIcon = computed(() => {
  return typeof promptConfig.value?.icon === 'string' && promptConfig.value.icon ? promptConfig.value.icon : ''
})

const isFinishedState = computed(() => ['done', 'error', 'cancelled', 'empty', 'input-only'].includes(sessionStatus.value))

const displayText = computed(() => {
  if (sessionStatus.value === 'cancelled') {
    return '已取消快捷输入请求'
  }

  if (sessionStatus.value === 'error') {
    return lastError.value || '执行失败'
  }

  if (streamText.value.trim()) {
    return streamText.value.replace(/[\r\n]+/g, ' ').trim()
  }

  if (inlineInputText.value.trim()) {
    return inlineInputText.value.replace(/[\r\n]+/g, ' ').trim()
  }

  if (sessionStatus.value === 'empty') {
    return '请先复制或选择文本、文件、图片后再召唤'
  }

  if (sessionStatus.value === 'streaming') {
    return '等待内容…'
  }

  return '等待内容…'
})

const canCopy = computed(() => Boolean(streamText.value.trim()))
const canType = computed(() => Boolean(streamText.value.trim() || inlineInputText.value.trim()))
const leftButtonMode = computed(() => (isFinishedState.value && canCopy.value ? 'copy' : 'close'))
const shouldShowTypingButton = computed(() => sessionStatus.value === 'done' || sessionStatus.value === 'error' || sessionStatus.value === 'cancelled')

function clearBlurAutoCloseTimer() {
  if (blurAutoCloseTimer) {
    clearTimeout(blurAutoCloseTimer)
    blurAutoCloseTimer = null
  }
}

function scheduleBlurAutoClose() {
  clearBlurAutoCloseTimer()
  if (!isFinishedState.value) return
  blurAutoCloseTimer = setTimeout(() => {
    closeFastInput()
  }, 5000)
}

function resetCopiedStateSoon() {
  if (copiedResetTimer) clearTimeout(copiedResetTimer)
  copiedResetTimer = setTimeout(() => {
    isCopied.value = false
    copiedResetTimer = null
  }, 900)
}

function markFinishedState() {
  if (!autoCopied.value) return
  isCopied.value = true
  resetCopiedStateSoon()
}

function applyInitPayload(data = {}) {
  if (typeof data.senderId === 'string' && data.senderId) {
    senderId.value = data.senderId
  }

  currentPayload.value = {
    code: typeof data.code === 'string' && data.code ? data.code : 'AI',
    type: typeof data.type === 'string' && data.type ? data.type : 'empty',
    payload: data.payload ?? '',
    userText: typeof data.userText === 'string' ? data.userText : '',
    promptKey: typeof data.promptKey === 'string' ? data.promptKey : '',
    triggerMode: typeof data.triggerMode === 'string' ? data.triggerMode : ''
  }

  promptConfig.value = data.promptConfig && typeof data.promptConfig === 'object' ? data.promptConfig : {}
  inlineInputText.value = typeof data.inputText === 'string' ? data.inputText : ''

  if (data?.config && typeof data.config === 'object') {
    document.documentElement.classList.toggle('dark', Boolean(data.config.isDarkMode))
  }
}

async function closeFastInput() {
  clearBlurAutoCloseTimer()
  try {
    await window.api.closeWindow(senderId.value)
  } catch {
    // ignore fire-and-forget close
  }
}

async function copyResult(andClose = false) {
  try {
    if (!canCopy.value) {
      if (andClose) {
        await closeFastInput()
      }
      return
    }
    await window.api.copyText(streamText.value)
    isCopied.value = true
    resetCopiedStateSoon()
    if (andClose) {
      await closeFastInput()
    }
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
      await closeFastInput()
      return
    }
    throw new Error(result?.message || result?.reason || '发送失败')
  } catch (error) {
    ElMessage.error(getErrorMessage(error, '发送到输入框失败'))
  }
}

function handleLeftAction() {
  if (leftButtonMode.value === 'copy') {
    copyResult(true)
    return
  }
  closeFastInput()
}

function handleFastInputEvent(event = {}) {
  const eventType = typeof event?.type === 'string' ? event.type : ''
  const payload = event?.payload && typeof event.payload === 'object' ? event.payload : {}

  if (eventType === 'session:init') {
    applyInitPayload(payload)
    sessionStatus.value = 'ready'
    lastError.value = ''
    streamText.value = ''
    autoCopied.value = false
    isCopied.value = false
    clearBlurAutoCloseTimer()
    return
  }

  if (eventType === 'session:start') {
    sessionStatus.value = 'streaming'
    lastError.value = ''
    autoCopied.value = false
    isCopied.value = false
    clearBlurAutoCloseTimer()
    return
  }

  if (eventType === 'session:idle') {
    sessionStatus.value = payload?.status || 'ready'
    inlineInputText.value = typeof payload?.inputText === 'string' ? payload.inputText : inlineInputText.value
    autoCopied.value = false
    if (sessionStatus.value === 'empty' || sessionStatus.value === 'input-only') {
      scheduleBlurAutoClose()
    }
    return
  }

  if (eventType === 'session:chunk') {
    sessionStatus.value = 'streaming'
    streamText.value = typeof payload?.text === 'string' ? payload.text : streamText.value + (payload?.chunk || '')
    return
  }

  if (eventType === 'session:done') {
    sessionStatus.value = 'done'
    streamText.value = typeof payload?.text === 'string' ? payload.text : streamText.value
    autoCopied.value = Boolean(payload?.autoCopied)
    markFinishedState()
    return
  }

  if (eventType === 'session:error') {
    sessionStatus.value = String(payload?.message || '').includes('取消') ? 'cancelled' : 'error'
    lastError.value = typeof payload?.message === 'string' ? payload.message : '快捷输入执行失败'
    if (typeof payload?.text === 'string' && payload.text) {
      streamText.value = payload.text
    }
    autoCopied.value = Boolean(payload?.autoCopied)
    markFinishedState()
  }
}

function handleDragStart(event) {
  const textToDrag = streamText.value.trim() || inlineInputText.value.trim()
  if (!textToDrag) {
    event.preventDefault()
    return
  }
  event.dataTransfer?.setData('text/plain', textToDrag)
  isDragging.value = true
  clearBlurAutoCloseTimer()
}

function handleDragEnd() {
  isDragging.value = false
  if (isFinishedState.value) {
    closeFastInput()
  }
}

if (window.api?.onWindowInit) {
  window.api.onWindowInit((payload = {}) => {
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
    document.documentElement.classList.toggle('dark', Boolean(nextConfig?.isDarkMode))
  } catch {
    // ignore initial config fallback failure
  }

  const handleWindowFocus = () => {
    clearBlurAutoCloseTimer()
  }

  const handleWindowBlur = () => {
    if (isFinishedState.value) {
      scheduleBlurAutoClose()
    }
  }

  const handleKeydown = (event) => {
    if (event.key === 'Escape') {
      event.preventDefault()
      if (sessionStatus.value === 'streaming') {
        window.api.emitWindowEvent?.({
          target: senderId.value,
          event: 'fast-input:cancel-request',
          payload: { reason: 'user_cancelled' }
        }).catch(() => {})
        lastError.value = '已取消快捷输入请求'
        sessionStatus.value = 'cancelled'
        scheduleBlurAutoClose()
        return
      }
      closeFastInput()
    }
  }

  window.addEventListener('focus', handleWindowFocus)
  window.addEventListener('blur', handleWindowBlur)
  window.addEventListener('keydown', handleKeydown)

  keyboardCleanup = () => {
    window.removeEventListener('focus', handleWindowFocus)
    window.removeEventListener('blur', handleWindowBlur)
    window.removeEventListener('keydown', handleKeydown)
  }
})

onBeforeUnmount(() => {
  if (copiedResetTimer) clearTimeout(copiedResetTimer)
  clearBlurAutoCloseTimer()
  keyboardCleanup?.()
})
</script>

<template>
  <div class="fast-shell">
    <div class="fast-bar" :class="[`status-${sessionStatus}`]">
      <button
        class="icon-btn left-btn no-drag"
        :class="{ copied: isCopied, copy: leftButtonMode === 'copy' }"
        type="button"
        :title="leftButtonMode === 'copy' ? '复制并关闭' : '关闭'"
        @click="handleLeftAction"
      >
        <span v-if="leftButtonMode !== 'copy'">✕</span>
        <span v-else-if="isCopied">✓</span>
        <span v-else>⧉</span>
      </button>

      <div class="content-zone drag-region">
        <div class="content-text" :title="displayText">
          <img v-if="promptIcon" :src="promptIcon" :alt="currentPayload.code || 'AI'" class="inline-icon no-drag" />
          <span>{{ displayText }}</span>
        </div>
      </div>

      <div class="right-zone">
        <div v-if="sessionStatus === 'streaming'" class="stream-spinner" aria-hidden="true"></div>
        <button
          v-else-if="shouldShowTypingButton"
          class="icon-btn right-btn no-drag"
          :class="{ dragging: isDragging }"
          type="button"
          title="拖拽到输入框 / 点击直接输入"
          draggable="true"
          :disabled="!canType"
          @click="pasteToActiveInput"
          @dragstart="handleDragStart"
          @dragend="handleDragEnd"
        >
          ⇪
        </button>
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
  padding: 16px;
  background: transparent;
  user-select: none;
}

.fast-bar {
  -webkit-app-region: drag;
  width: min(100%, 560px);
  min-height: 52px;
  border-radius: 999px;
  background: rgba(255, 255, 255, 0.98);
  border: 1px solid rgba(0, 0, 0, 0.08);
  box-shadow: 0 12px 28px rgba(15, 23, 42, 0.12);
  display: grid;
  grid-template-columns: 36px 1fr 36px;
  align-items: center;
  gap: 8px;
  padding: 6px;
}

html.dark .fast-bar {
  background: rgba(30, 30, 30, 0.98);
  border-color: rgba(255, 255, 255, 0.12);
  box-shadow: 0 14px 32px rgba(0, 0, 0, 0.35);
}

.fast-bar.status-done,
.fast-bar.status-error,
.fast-bar.status-cancelled {
  animation: glow 0.45s ease-out;
}

.no-drag {
  -webkit-app-region: no-drag;
}

.drag-region {
  -webkit-app-region: drag;
}

.icon-btn {
  width: 30px;
  height: 30px;
  border: none;
  border-radius: 50%;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  background: transparent;
  color: #1f2937;
  cursor: pointer;
  font-size: 16px;
  transition: transform 0.15s ease, background-color 0.15s ease, color 0.15s ease, opacity 0.15s ease;
}

html.dark .icon-btn {
  color: #f3f4f6;
}

.icon-btn:hover:not(:disabled) {
  background: rgba(0, 0, 0, 0.06);
  transform: scale(1.04);
}

html.dark .icon-btn:hover:not(:disabled) {
  background: rgba(255, 255, 255, 0.1);
}

.left-btn:hover:not(:disabled) {
  color: #ef4444;
}

.left-btn.copy:hover:not(:disabled) {
  color: #10b981;
}

.left-btn.copied {
  color: #10b981;
}

.right-btn:hover:not(:disabled) {
  color: #8b5cf6;
}

.right-btn.dragging {
  opacity: 0.5;
  cursor: grabbing;
}

.icon-btn:disabled {
  opacity: 0.45;
  cursor: not-allowed;
}

.content-zone {
  min-width: 0;
  display: flex;
  align-items: center;
  overflow: hidden;
}

.content-text {
  min-width: 0;
  width: 100%;
  display: flex;
  align-items: center;
  gap: 10px;
  font-size: 14px;
  color: #1f2937;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

html.dark .content-text {
  color: #f3f4f6;
}

.content-text span {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.inline-icon {
  width: 24px;
  height: 24px;
  border-radius: 8px;
  object-fit: cover;
  flex-shrink: 0;
}

.right-zone {
  width: 30px;
  height: 30px;
  display: flex;
  align-items: center;
  justify-content: center;
}

.stream-spinner {
  width: 16px;
  height: 16px;
  border: 2px solid rgba(107, 114, 128, 0.2);
  border-top-color: #6b7280;
  border-radius: 50%;
  animation: spin 0.9s linear infinite;
}

html.dark .stream-spinner {
  border-color: rgba(209, 213, 219, 0.2);
  border-top-color: #e5e7eb;
}

@keyframes spin {
  to {
    transform: rotate(360deg);
  }
}

@keyframes glow {
  0% {
    box-shadow: 0 12px 28px rgba(15, 23, 42, 0.12);
  }
  40% {
    box-shadow: 0 12px 28px rgba(245, 158, 11, 0.2), inset 0 0 0 1px rgba(245, 158, 11, 0.35);
  }
  100% {
    box-shadow: 0 12px 28px rgba(15, 23, 42, 0.12);
  }
}
</style>
