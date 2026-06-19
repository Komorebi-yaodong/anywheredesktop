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
const activeTool = ref('pen')
const annotations = ref([])
const draftAnnotation = ref(null)
const isAnnotating = ref(false)

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
  const toolbarWidth = 292
  const left = Math.min(window.innerWidth - toolbarWidth - 12, Math.max(12, rect.x + rect.width - toolbarWidth))
  const top = Math.min(window.innerHeight - 48, Math.max(12, rect.y + rect.height + 8))
  return {
    left: `${left}px`,
    top: `${top}px`
  }
})

const renderedAnnotations = computed(() => {
  const list = [...annotations.value]
  if (draftAnnotation.value) list.push(draftAnnotation.value)
  return list
})

function applyInit(data = {}) {
  if (data?.preloadOnly === true) {
    return
  }

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
  isAnnotating.value = false
  annotations.value = []
  draftAnnotation.value = null
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

function toSelectionPoint(point) {
  const rect = selectionRect.value
  return {
    x: Math.max(0, Math.min(rect.width, point.x - rect.x)),
    y: Math.max(0, Math.min(rect.height, point.y - rect.y))
  }
}

function isInsideSelection(point) {
  if (!hasSelection.value) return false
  const rect = selectionRect.value
  return point.x >= rect.x && point.x <= rect.x + rect.width && point.y >= rect.y && point.y <= rect.y + rect.height
}

function createRectAnnotation(start, end) {
  const x = Math.min(start.x, end.x)
  const y = Math.min(start.y, end.y)
  const width = Math.abs(end.x - start.x)
  const height = Math.abs(end.y - start.y)
  return {
    type: 'rect',
    x,
    y,
    width,
    height,
    color: '#ff4d4f',
    lineWidth: 3
  }
}

function startAnnotation(point) {
  const local = toSelectionPoint(point)
  isAnnotating.value = true
  if (activeTool.value === 'rect') {
    draftAnnotation.value = {
      ...createRectAnnotation(local, local),
      start: local
    }
    return
  }

  draftAnnotation.value = {
    type: 'pen',
    points: [local],
    color: '#ff4d4f',
    lineWidth: 3
  }
}

function updateAnnotation(point) {
  if (!isAnnotating.value || !draftAnnotation.value) return
  const local = toSelectionPoint(point)
  if (draftAnnotation.value.type === 'rect') {
    draftAnnotation.value = {
      ...createRectAnnotation(draftAnnotation.value.start || local, local),
      start: draftAnnotation.value.start || local
    }
    return
  }

  draftAnnotation.value = {
    ...draftAnnotation.value,
    points: [...(draftAnnotation.value.points || []), local]
  }
}

function finishAnnotation() {
  if (!isAnnotating.value) return
  const draft = draftAnnotation.value
  isAnnotating.value = false
  draftAnnotation.value = null
  if (!draft) return

  if (draft.type === 'pen' && Array.isArray(draft.points) && draft.points.length >= 2) {
    annotations.value = [...annotations.value, draft]
  } else if (draft.type === 'rect' && draft.width >= 3 && draft.height >= 3) {
    const { start, ...rect } = draft
    annotations.value = [...annotations.value, rect]
  }
}

function onPointerDown(event) {
  if (isBusy.value || event.button !== 0) return
  const point = getLocalPoint(event)

  if (hasSelection.value && isInsideSelection(point)) {
    startAnnotation(point)
    try {
      rootRef.value?.setPointerCapture?.(event.pointerId)
    } catch {
      // ignore pointer capture failure
    }
    return
  }

  annotations.value = []
  draftAnnotation.value = null
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
  const point = getLocalPoint(event)
  if (isAnnotating.value) {
    updateAnnotation(point)
    return
  }

  if (!isDragging.value) return
  endPoint.x = point.x
  endPoint.y = point.y
}

function onPointerUp(event) {
  const point = getLocalPoint(event)
  if (isAnnotating.value) {
    updateAnnotation(point)
    finishAnnotation()
    return
  }

  if (!isDragging.value) return
  endPoint.x = point.x
  endPoint.y = point.y
  isDragging.value = false
  const rect = selectionRect.value
  hasSelection.value = rect.width >= 8 && rect.height >= 8
  if (!hasSelection.value) resetSelection()
}

function drawAnnotationOnCanvas(ctx, annotation, scaleX, scaleY) {
  ctx.save()
  ctx.strokeStyle = annotation.color || '#ff4d4f'
  ctx.lineWidth = Math.max(1, Number(annotation.lineWidth || 3) * Math.max(scaleX, scaleY))
  ctx.lineCap = 'round'
  ctx.lineJoin = 'round'

  if (annotation.type === 'pen' && Array.isArray(annotation.points) && annotation.points.length >= 2) {
    ctx.beginPath()
    annotation.points.forEach((point, index) => {
      const x = point.x * scaleX
      const y = point.y * scaleY
      if (index === 0) ctx.moveTo(x, y)
      else ctx.lineTo(x, y)
    })
    ctx.stroke()
  } else if (annotation.type === 'rect') {
    ctx.strokeRect(annotation.x * scaleX, annotation.y * scaleY, annotation.width * scaleX, annotation.height * scaleY)
  }

  ctx.restore()
}

async function cropSelectionToPngDataUrl() {
  const img = imageRef.value
  const rect = selectionRect.value
  if (!img || !capture.thumbnailDataUrl || rect.width < 1 || rect.height < 1) {
    throw new Error('请选择截图区域')
  }

  const naturalWidth = img.naturalWidth || imageNaturalSize.width || window.innerWidth
  const naturalHeight = img.naturalHeight || imageNaturalSize.height || window.innerHeight
  const imageScaleX = naturalWidth / window.innerWidth
  const imageScaleY = naturalHeight / window.innerHeight

  const sx = Math.max(0, Math.round(rect.x * imageScaleX))
  const sy = Math.max(0, Math.round(rect.y * imageScaleY))
  const sw = Math.max(1, Math.round(rect.width * imageScaleX))
  const sh = Math.max(1, Math.round(rect.height * imageScaleY))

  const canvas = document.createElement('canvas')
  canvas.width = sw
  canvas.height = sh
  const ctx = canvas.getContext('2d')
  if (!ctx) throw new Error('无法创建截图画布')
  ctx.drawImage(img, sx, sy, sw, sh, 0, 0, sw, sh)

  const annotationScaleX = sw / rect.width
  const annotationScaleY = sh / rect.height
  for (const annotation of annotations.value) {
    drawAnnotationOnCanvas(ctx, annotation, annotationScaleX, annotationScaleY)
  }

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

function undoAnnotation() {
  if (annotations.value.length === 0) return
  annotations.value = annotations.value.slice(0, -1)
}

function clearAnnotations() {
  annotations.value = []
  draftAnnotation.value = null
}

function handleKeydown(event) {
  if (event.ctrlKey && event.key.toLowerCase() === 'z') {
    event.preventDefault()
    undoAnnotation()
    return
  }

  if (event.key === 'Enter') {
    event.preventDefault()
    void confirmSelection()
  } else if (event.key === 'Escape') {
    event.preventDefault()
    void cancelSelection()
  }
}

function pointsToString(points = []) {
  return points.map((point) => `${point.x},${point.y}`).join(' ')
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
    <div v-if="hasSelection" class="selection-clear" :style="selectionStyle"></div>
    <div v-if="hasSelection || isDragging" class="selection-box" :style="selectionStyle">
      <svg v-if="hasSelection" class="annotation-svg" :viewBox="`0 0 ${selectionRect.width} ${selectionRect.height}`">
        <template v-for="(annotation, index) in renderedAnnotations" :key="index">
          <polyline
            v-if="annotation.type === 'pen'"
            :points="pointsToString(annotation.points)"
            :stroke="annotation.color"
            :stroke-width="annotation.lineWidth"
            fill="none"
            stroke-linecap="round"
            stroke-linejoin="round"
          />
          <rect
            v-else-if="annotation.type === 'rect'"
            :x="annotation.x"
            :y="annotation.y"
            :width="annotation.width"
            :height="annotation.height"
            :stroke="annotation.color"
            :stroke-width="annotation.lineWidth"
            fill="none"
          />
        </template>
      </svg>
    </div>
    <div v-if="hasSelection" class="toolbar" :style="toolbarStyle" @pointerdown.stop>
      <button class="tool-chip" :class="{ active: activeTool === 'pen' }" title="画笔" @click="activeTool = 'pen'">画笔</button>
      <button class="tool-chip" :class="{ active: activeTool === 'rect' }" title="矩形" @click="activeTool = 'rect'">矩形</button>
      <button class="tool-chip" title="撤销 Ctrl+Z" :disabled="annotations.length === 0" @click="undoAnnotation">撤销</button>
      <button class="tool-chip" title="清空标注" :disabled="annotations.length === 0" @click="clearAnnotations">清空</button>
      <button class="tool-button confirm" title="确认 Enter" @click="confirmSelection">✓</button>
      <button class="tool-button cancel" title="取消 Esc" @click="cancelSelection">×</button>
    </div>
    <div class="hint">
      <span>拖拽选择截图区域，选区内可画笔/矩形标注</span>
      <span>Enter 确认 · Esc 取消 · Ctrl+Z 撤销</span>
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
  background: rgba(77, 163, 255, 0.03);
  z-index: 3;
  pointer-events: none;
}

.annotation-svg {
  position: absolute;
  inset: 0;
  width: 100%;
  height: 100%;
  overflow: visible;
  pointer-events: none;
}

.toolbar {
  position: absolute;
  z-index: 10;
  display: flex;
  align-items: center;
  gap: 7px;
  padding: 7px;
  border: 1px solid rgba(255, 255, 255, 0.12);
  border-radius: 999px;
  background: linear-gradient(180deg, rgba(33, 37, 46, 0.94), rgba(18, 20, 26, 0.92));
  box-shadow:
    0 12px 32px rgba(0, 0, 0, 0.34),
    inset 0 1px 0 rgba(255, 255, 255, 0.08);
  backdrop-filter: blur(14px);
}

.tool-chip,
.tool-button {
  border: 0;
  color: #fff;
  cursor: pointer;
  outline: none;
  user-select: none;
  transition:
    transform 120ms ease,
    background 120ms ease,
    box-shadow 120ms ease,
    opacity 120ms ease;
}

.tool-chip {
  height: 34px;
  min-width: 48px;
  padding: 0 13px;
  border-radius: 999px;
  background: rgba(255, 255, 255, 0.1);
  color: rgba(255, 255, 255, 0.86);
  font-size: 13px;
  font-weight: 650;
  letter-spacing: 0.02em;
  box-shadow: inset 0 0 0 1px rgba(255, 255, 255, 0.06);
}

.tool-chip:hover:not(:disabled) {
  transform: translateY(-1px);
  background: rgba(255, 255, 255, 0.18);
  color: #fff;
}

.tool-chip.active {
  background: linear-gradient(135deg, #3867ff, #2853d8);
  color: #fff;
  box-shadow:
    0 5px 14px rgba(56, 103, 255, 0.34),
    inset 0 1px 0 rgba(255, 255, 255, 0.22);
}

.tool-chip:disabled {
  cursor: not-allowed;
  opacity: 0.38;
  color: rgba(255, 255, 255, 0.62);
  background: rgba(255, 255, 255, 0.07);
  box-shadow: none;
}

.tool-button {
  width: 38px;
  height: 38px;
  border-radius: 50%;
  font-size: 24px;
  font-weight: 800;
  line-height: 38px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  text-shadow: 0 1px 1px rgba(0, 0, 0, 0.18);
}

.tool-button:hover {
  transform: translateY(-1px) scale(1.04);
}

.tool-button:active,
.tool-chip:active:not(:disabled) {
  transform: translateY(0) scale(0.97);
}

.tool-button.confirm {
  background: linear-gradient(135deg, #22c774, #11a95c);
  box-shadow:
    0 6px 16px rgba(18, 185, 101, 0.34),
    inset 0 1px 0 rgba(255, 255, 255, 0.25);
}

.tool-button.cancel {
  background: linear-gradient(135deg, #ff4b69, #de2e50);
  box-shadow:
    0 6px 16px rgba(235, 59, 90, 0.34),
    inset 0 1px 0 rgba(255, 255, 255, 0.22);
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
  white-space: nowrap;
}
</style>
