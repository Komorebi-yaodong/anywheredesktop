<script setup>
import { computed, nextTick, onBeforeUnmount, onMounted, reactive, ref } from 'vue'

const capture = reactive({
  captureId: '',
  thumbnailDataUrl: '',
  sourceName: '',
  display: null,
  prompt: null
})

const rootRef = ref(null)
const imageRef = ref(null)
const isDragging = ref(false)
const hasSelection = ref(false)
const startPoint = reactive({ x: 0, y: 0 })
const endPoint = reactive({ x: 0, y: 0 })
const imageNaturalSize = reactive({ width: 0, height: 0 })
const isBusy = ref(false)

const selectionRect = computed(() => {
  const x = Math.min(startPoint.x, endPoint.x)
  const y = Math.min(startPoint.y, endPoint.y)
  const width = Math.abs(endPoint.x - startPoint.x)
  const height = Math.abs(endPoint.y - startPoint.y)
  return { x, y, width, height }
})

const selectionStyle = computed(() => {
  const rect = selectionRect.value
  return {
    left: `${rect.x}px`,
    top: `${rect.y}px`,
    width: `${rect.width}px`,
    height: `${rect.height}px`
  }
})

const toolbarStyle = computed(() => {
  const rect = selectionRect.value
  const left = Math.min(window.innerWidth - 112, Math.max(12, rect.x + rect.width - 112))
  const top = Math.min(window.innerHeight - 48, Math.max(12, rect.y + rect.height + 8))
  return {
    left: `${left}px`,
    top: `${top}px`
  }
})

function applyInit(data = {}) {
  capture.captureId = typeof data.captureId === 'string' ? data.captureId : ''
  capture.thumbnailDataUrl = typeof data.thumbnailDataUrl === 'string' ? data.thumbnailDataUrl : ''
  capture.sourceName = typeof data.sourceName === 'string' ? data.sourceName : ''
  capture.display = data.display && typeof data.display === 'object' ? data.display : null
  capture.prompt = data.prompt && typeof data.prompt === 'object' ? data.prompt : null
  resetSelection()
  nextTick(() => {
    imageNaturalSize.width = imageRef.value?.naturalWidth || 0
    imageNaturalSize.height = imageRef.value?.naturalHeight || 0
  })
}

function resetSelection() {
  isDragging.value = false
  hasSelection.value = false
  startPoint.x = 0
  startPoint.y = 0
  endPoint.x = 0
  endPoint.y = 0
}

function getLocalPoint(event) {
  return {
    x: Math.max(0, Math.min(window.innerWidth, event.clientX)),
    y: Math.max(0, Math.min(window.innerHeight, event.clientY))
  }
}

function onPointerDown(event) {
  if (isBusy.value || event.button !== 0) return
  const point = getLocalPoint(event)
  startPoint.x = point.x
  startPoint.y = point.y
  endPoint.x = point.x
  endPoint.y = point.y
  isDragging.value = true
  hasSelection.value = false
  try {
    rootRef.value?.setPointerCapture?.(event.pointerId)
  } catch {
    // ignore pointer capture failure
  }
}

function onPointerMove(event) {
  if (!isDragging.value) return
  const point = getLocalPoint(event)
  endPoint.x = point.x
  endPoint.y = point.y
}

function onPointerUp(event) {
  if (!isDragging.value) return
  const point = getLocalPoint(event)
  endPoint.x = point.x
  endPoint.y = point.y
  isDragging.value = false
  const rect = selectionRect.value
  hasSelection.value = rect.width >= 8 && rect.height >= 8
  if (!hasSelection.value) resetSelection()
}

async function cropSelectionToPngDataUrl() {
  const img = imageRef.value
  const rect = selectionRect.value
  if (!img || !capture.thumbnailDataUrl || rect.width < 1 || rect.height < 1) {
    throw new Error('请选择截图区域')
  }

  const naturalWidth = img.naturalWidth || imageNaturalSize.width || window.innerWidth
  const naturalHeight = img.naturalHeight || imageNaturalSize.height || window.innerHeight
  const scaleX = naturalWidth / window.innerWidth
  const scaleY = naturalHeight / window.innerHeight

  const sx = Math.max(0, Math.round(rect.x * scaleX))
  const sy = Math.max(0, Math.round(rect.y * scaleY))
  const sw = Math.max(1, Math.round(rect.width * scaleX))
  const sh = Math.max(1, Math.round(rect.height * scaleY))

  const canvas = document.createElement('canvas')
  canvas.width = sw
  canvas.height = sh
  const ctx = canvas.getContext('2d')
  if (!ctx) throw new Error('无法创建截图画布')
  ctx.drawImage(img, sx, sy, sw, sh, 0, 0, sw, sh)
  return canvas.toDataURL('image/png')
}

async function confirmSelection() {
  if (isBusy.value) return
  if (!hasSelection.value) return
  isBusy.value = true
  try {
    const dataUrl = await cropSelectionToPngDataUrl()
    await window.api.confirmScreenshot({
      captureId: capture.captureId,
      dataUrl
    })
  } catch (error) {
    console.error('[screenshot] confirm failed', error)
    isBusy.value = false
  }
}

async function cancelSelection() {
  if (isBusy.value) return
  isBusy.value = true
  try {
    await window.api.cancelScreenshot({ captureId: capture.captureId })
  } catch (error) {
    console.error('[screenshot] cancel failed', error)
    isBusy.value = false
  }
}

function handleKeydown(event) {
  if (event.key === 'Enter') {
    event.preventDefault()
    void confirmSelection()
  } else if (event.key === 'Escape') {
    event.preventDefault()
    void cancelSelection()
  }
}

onMounted(() => {
  window.addEventListener('keydown', handleKeydown, true)
  window.api?.onWindowInit?.((data) => applyInit(data || {}))
})

onBeforeUnmount(() => {
  window.removeEventListener('keydown', handleKeydown, true)
})
</script>

<template>
  <div
    ref="rootRef"
    class="screenshot-root"
    @pointerdown="onPointerDown"
    @pointermove="onPointerMove"
    @pointerup="onPointerUp"
  >
    <img
      ref="imageRef"
      class="screen-image"
      :src="capture.thumbnailDataUrl"
      alt="screen"
      draggable="false"
      @load="imageNaturalSize.width = imageRef?.naturalWidth || 0; imageNaturalSize.height = imageRef?.naturalHeight || 0"
    />
    <div class="screen-dim"></div>
    <div v-if="hasSelection || isDragging" class="selection-box" :style="selectionStyle"></div>
    <div v-if="hasSelection" class="selection-clear" :style="selectionStyle"></div>
    <div v-if="hasSelection" class="toolbar" :style="toolbarStyle" @pointerdown.stop>
      <button class="tool-button confirm" title="确认 Enter" @click="confirmSelection">✓</button>
      <button class="tool-button cancel" title="取消 Esc" @click="cancelSelection">×</button>
    </div>
    <div class="hint">
      <span>拖拽选择截图区域</span>
      <span>Enter 确认 · Esc 取消</span>
    </div>
  </div>
</template>

<style scoped>
.screenshot-root {
  position: fixed;
  inset: 0;
  overflow: hidden;
  background: rgba(0, 0, 0, 0.01);
}

.screen-image {
  position: absolute;
  inset: 0;
  width: 100vw;
  height: 100vh;
  object-fit: fill;
  pointer-events: none;
}

.screen-dim {
  position: absolute;
  inset: 0;
  background: rgba(0, 0, 0, 0.32);
  pointer-events: none;
}

.selection-box,
.selection-clear {
  position: absolute;
  box-sizing: border-box;
  pointer-events: none;
}

.selection-clear {
  background: transparent;
  box-shadow: 0 0 0 9999px rgba(0, 0, 0, 0.32);
}

.selection-box {
  border: 2px solid #4da3ff;
  background: rgba(77, 163, 255, 0.06);
  z-index: 3;
}

.toolbar {
  position: absolute;
  z-index: 10;
  display: flex;
  gap: 8px;
  padding: 6px;
  border-radius: 999px;
  background: rgba(20, 22, 28, 0.9);
  box-shadow: 0 8px 24px rgba(0, 0, 0, 0.28);
}

.tool-button {
  width: 36px;
  height: 36px;
  border: 0;
  border-radius: 50%;
  color: #fff;
  font-size: 22px;
  line-height: 36px;
  cursor: pointer;
}

.tool-button.confirm {
  background: #20bf6b;
}

.tool-button.cancel {
  background: #eb3b5a;
}

.hint {
  position: absolute;
  left: 50%;
  bottom: 28px;
  transform: translateX(-50%);
  z-index: 8;
  display: flex;
  gap: 12px;
  padding: 8px 14px;
  border-radius: 999px;
  color: #fff;
  font-size: 13px;
  background: rgba(20, 22, 28, 0.72);
  pointer-events: none;
}
</style>
