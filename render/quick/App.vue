<script setup>
import { computed, nextTick, onBeforeUnmount, onMounted, ref } from 'vue'
import { ElMessage } from 'element-plus'
import { pinyin } from 'pinyin-pro'

const senderId = ref('quick')
let hasInitPayloadApplied = false

const currentConfig = ref(null)
const queryText = ref('')
const selectedPromptKey = ref('')
const shouldShowSelection = ref(false)
const restoreCandidates = ref([])
const attachment = ref(createEmptyAttachment())
const inputRef = ref(null)

function createEmptyAttachment() {
  return {
    type: 'none',
    rawText: '',
    imageDataUrl: '',
    imageDataUrls: [],
    filePaths: [],
    previewLabel: ''
  }
}

function getErrorMessage(error, fallback = '操作失败') {
  if (!error) return fallback
  if (typeof error === 'string') return error
  if (typeof error?.message === 'string' && error.message) return error.message
  return fallback
}

function normalizeRegex(regexText = '') {
  const input = String(regexText || '').trim()
  if (!input) return null
  const match = input.match(/^\/(.*)\/([a-z]*)$/i)
  if (!match) return null
  try {
    return new RegExp(match[1], match[2])
  } catch {
    return null
  }
}

function normalizePromptType(type = '') {
  if (type === 'general') return 'general'
  if (type === 'over') return 'over'
  if (type === 'img') return 'img'
  if (type === 'files') return 'files'
  return 'general'
}

function getPromptIcon(prompt) {
  return typeof prompt?.icon === 'string' && prompt.icon ? prompt.icon : ''
}

function getPinyinProfile(text = '') {
  const source = String(text || '').trim()
  if (!source) {
    return {
      full: '',
      initials: '',
      compact: ''
    }
  }

  const normalized = source.toLowerCase()
  try {
    const full = pinyin(source, { toneType: 'none', type: 'array' })
      .map((item) => String(item || '').trim().toLowerCase())
      .filter(Boolean)
    const initials = full.map((item) => item[0] || '').join('')
    return {
      full: full.join(' '),
      initials,
      compact: full.join('')
    }
  } catch {
    const asciiWords = normalized.split(/[^a-z0-9]+/).filter(Boolean)
    return {
      full: asciiWords.join(' '),
      initials: asciiWords.map((item) => item[0] || '').join(''),
      compact: asciiWords.join('')
    }
  }
}

function buildPromptSearchProfile(prompt) {
  const name = String(prompt?.key || '')
  const lowerName = name.toLowerCase()
  const pinyinProfile = getPinyinProfile(name)

  return {
    lowerName,
    pinyinFull: pinyinProfile.full,
    pinyinInitials: pinyinProfile.initials,
    pinyinCompact: pinyinProfile.compact
  }
}

function getNameMatchScore(searchProfile, query = '', queryPinyin = { compact: '' }) {
  if (!query) return 0
  if (searchProfile.lowerName === query) return 3200
  if (searchProfile.lowerName.startsWith(query)) return 2800
  if (searchProfile.pinyinInitials && searchProfile.pinyinInitials === query) return 2600
  if (searchProfile.pinyinInitials && searchProfile.pinyinInitials.startsWith(query)) return 2400
  if (searchProfile.pinyinCompact && searchProfile.pinyinCompact.startsWith(query)) return 2200
  if (queryPinyin.compact && searchProfile.pinyinCompact && searchProfile.pinyinCompact.startsWith(queryPinyin.compact)) return 2100
  if (searchProfile.lowerName.includes(query)) return 1800
  if (searchProfile.pinyinFull && searchProfile.pinyinFull.includes(query)) return 1600
  return 0
}

function classifyTextAttachment(text = '') {
  const normalized = String(text || '')
  const trimmed = normalized.trim()
  if (!trimmed) return 'none'
  return /\r?\n/.test(trimmed) ? 'multiline-text' : 'singleline-text'
}

function getAttachmentPreviewLabel(next = createEmptyAttachment()) {
  if (next.type === 'files') {
    const first = next.previewLabel || next.filePaths[0]?.split(/[/\\]/).pop() || ''
    if (!first) return '文件'
    return first
  }

  if (next.type === 'img') {
    return '图片'
  }

  if (next.type === 'multiline-text' || next.type === 'text') {
    return String(next.rawText || '')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 60)
  }

  return ''
}

function clearAttachment() {
  attachment.value = createEmptyAttachment()
  restoreCandidates.value = []
}

function clearQuickContent() {
  queryText.value = ''
  clearAttachment()
  shouldShowSelection.value = false
}

function setAttachment(next = {}) {
  attachment.value = {
    type: next.type || 'none',
    rawText: typeof next.rawText === 'string' ? next.rawText : '',
    imageDataUrl: typeof next.imageDataUrl === 'string' ? next.imageDataUrl : '',
    imageDataUrls: Array.isArray(next.imageDataUrls) ? next.imageDataUrls : [],
    filePaths: Array.isArray(next.filePaths) ? next.filePaths : [],
    previewLabel: typeof next.previewLabel === 'string' ? next.previewLabel : ''
  }
}

function focusInputToEnd() {
  nextTick(() => {
    const element = inputRef.value
    if (!element) return
    element.focus()
    const length = element.value?.length || 0
    try {
      element.setSelectionRange(length, length)
    } catch {
      // ignore unsupported selection API
    }
  })
}

function isPromptTextCompatible(prompt, rawText = '') {
  const promptType = normalizePromptType(prompt?.type)
  if (promptType === 'general') return true
  if (promptType !== 'over') return false

  const regex = normalizeRegex(prompt?.matchRegex)
  if (!regex) return true
  return regex.test(String(rawText || ''))
}

function isSvgFilePath(filePath = '') {
  return String(filePath || '').trim().toLowerCase().endsWith('.svg')
}

function getAttachmentFilterMode(nextAttachment = createEmptyAttachment()) {
  if (nextAttachment.type === 'img' && nextAttachment.imageDataUrl) return 'img'
  if (nextAttachment.type === 'files' && nextAttachment.filePaths.length > 0) {
    return nextAttachment.filePaths.every((filePath) => isSvgFilePath(filePath)) ? 'files' : 'files'
  }
  if (nextAttachment.type === 'multiline-text' && nextAttachment.rawText.trim()) return 'multiline-text'
  return 'none'
}

async function inspectSessionCandidates(paths = []) {
  const candidates = []
  for (const filePath of paths) {
    if (!String(filePath).toLowerCase().endsWith('.json')) continue
    try {
      const content = await window.api.readLocalFile(filePath, { encoding: 'utf8' })
      const text = typeof content === 'string' ? content : content?.content || ''
      const json = JSON.parse(text)
      if (json && json.anywhere_history === true) {
        candidates.push({
          filePath,
          fileName: filePath.split(/[/\\]/).pop() || filePath,
          code: json.CODE || 'AI',
          raw: text
        })
      }
    } catch {
      // ignore invalid json
    }
  }
  restoreCandidates.value = candidates
}

const allPrompts = computed(() => {
  const prompts = currentConfig.value?.prompts || {}
  return Object.entries(prompts)
    .filter(([, prompt]) => prompt && prompt.enable !== false)
    .map(([key, prompt]) => ({ key, ...prompt }))
})

const runtimeMode = computed(() => {
  if (attachment.value.type === 'img') return 'img'
  if (attachment.value.type === 'files') return 'files'
  if (attachment.value.type === 'multiline-text') return 'multiline-text'
  if (attachment.value.type === 'text') return 'text'
  return 'singleline-text'
})

const hasAttachment = computed(() => attachment.value.type !== 'none')
const attachmentPreviewLabel = computed(() => getAttachmentPreviewLabel(attachment.value))
const candidateSections = computed(() => {
  const prompts = allPrompts.value
  const rawQuery = queryText.value.trim()
  const query = rawQuery.toLowerCase()
  const queryPinyin = getPinyinProfile(rawQuery)
  const hasQuery = Boolean(query)
  const attachmentMode = getAttachmentFilterMode(attachment.value)
  const hasAttachmentFilter = attachmentMode !== 'none'

  const sorter = (a, b) => b.score - a.score || a.key.localeCompare(b.key, 'zh-CN')
  const firstPass = []
  const secondPassNameMatches = []
  const secondPassFallback = []

  for (const prompt of prompts) {
    const promptType = normalizePromptType(prompt.type)
    const searchProfile = buildPromptSearchProfile(prompt)
    const nameScore = getNameMatchScore(searchProfile, query, queryPinyin)
    const item = {
      ...prompt,
      iconUrl: getPromptIcon(prompt),
      score: 0
    }

    if (hasAttachmentFilter) {
      const isGeneralFallback = promptType === 'general'
      const isTypeMatch =
        (attachmentMode === 'img' && promptType === 'img') ||
        (attachmentMode === 'files' && promptType === 'files') ||
        (attachmentMode === 'multiline-text' && isPromptTextCompatible(prompt, attachment.value.rawText))

      if (!isTypeMatch && !isGeneralFallback) continue

      item.score = isTypeMatch ? 2400 : 1200
      firstPass.push(item)

      if (hasQuery) {
        if (nameScore > 0) {
          item.score = (isTypeMatch ? 5200 : 4200) + nameScore
          secondPassNameMatches.push(item)
        } else {
          secondPassFallback.push(item)
        }
      }
      continue
    }

    if (!hasQuery) {
      if (isPromptTextCompatible(prompt, rawQuery) && promptType === 'over') {
        item.score = 1800
        firstPass.push(item)
      } else if (promptType === 'general') {
        item.score = 1200
        firstPass.push(item)
      }
      continue
    }

    if (nameScore > 0) {
      item.score = 5200 + nameScore
      firstPass.push(item)
      continue
    }

    if (isPromptTextCompatible(prompt, rawQuery) && promptType === 'over') {
      item.score = 2600
      firstPass.push(item)
      continue
    }

    if (promptType === 'general') {
      item.score = 1400
      firstPass.push(item)
    }
  }

  const sections = hasAttachmentFilter && hasQuery
    ? secondPassNameMatches.sort(sorter)
    : firstPass.sort(sorter)

  const deduped = []
  const seen = new Set()
  for (const item of sections) {
    if (seen.has(item.key)) continue
    seen.add(item.key)
    deduped.push(item)
  }

  if (selectedPromptKey.value && !deduped.some((item) => item.key === selectedPromptKey.value)) {
    selectedPromptKey.value = ''
  }

  return deduped
})

const selectedPrompt = computed(() => {
  return candidateSections.value.find((item) => item.key === selectedPromptKey.value) || candidateSections.value[0] || null
})

function resolveQuickOpenPayload(prompt) {
  if (!prompt) return null
  const payload = { code: prompt.key }

  if (attachment.value.type === 'img' && attachment.value.imageDataUrl) {
    payload.type = 'img'
    payload.payload = attachment.value.imageDataUrl
    if (queryText.value.trim()) payload.userText = queryText.value.trim()
    return payload
  }

  if (attachment.value.type === 'image-files' && attachment.value.imageDataUrls.length > 0) {
    payload.type = 'files'
    payload.payload = attachment.value.imageDataUrls.map((dataUrl, index) => ({
      name: `clipboard-image-${index + 1}.png`,
      dataUrl
    }))
    if (queryText.value.trim()) payload.userText = queryText.value.trim()
    return payload
  }

  if (attachment.value.type === 'files' && attachment.value.filePaths.length > 0) {
    payload.type = 'files'
    payload.payload = attachment.value.filePaths.map((filePath) => ({ path: filePath }))
    if (queryText.value.trim()) payload.userText = queryText.value.trim()
    return payload
  }

  if (attachment.value.type === 'multiline-text' && attachment.value.rawText.trim()) {
    payload.type = 'multiline-text'
    payload.payload = attachment.value.rawText
    return payload
  }

  if (queryText.value.trim()) {
    payload.type = 'over'
    payload.payload = queryText.value.trim()
    return payload
  }

  payload.type = 'empty'
  payload.payload = ''
  return payload
}

async function hideQuick() {
  try {
    await window.api.closeWindow('quick')
  } catch {
    // ignore fire-and-forget close
  }
}

async function openPrompt(prompt) {
  if (!prompt) return
  try {
    const payload = resolveQuickOpenPayload(prompt)
    const showMode = prompt.showMode === 'fastinput' ? 'fast' : 'window'
    await window.api.openWindow(showMode, payload)
    await hideQuick()
  } catch (error) {
    ElMessage.error(getErrorMessage(error))
  }
}

async function restoreSession(candidate) {
  try {
    await window.api.openWindow('window', {
      code: candidate.code,
      type: 'over',
      payload: candidate.raw,
      filename: candidate.fileName
    })
  } catch (error) {
    ElMessage.error(getErrorMessage(error, '恢复对话失败'))
  }
}

function updateFromTextInput(text = '', forceOverride = false) {
  const normalizedText = String(text || '')
  const trimmed = normalizedText.trim()
  const textKind = classifyTextAttachment(normalizedText)

  if (!trimmed) {
    if (forceOverride) {
      clearQuickContent()
    }
    return
  }

  if (forceOverride) {
    const preservedText = textKind === 'multiline-text' ? normalizedText : trimmed
    setAttachment({
      type: textKind === 'multiline-text' ? 'multiline-text' : 'text',
      rawText: preservedText,
      previewLabel: trimmed
    })
    queryText.value = ''
    focusInputToEnd()
    return
  }

  queryText.value = trimmed
}

async function handleClipboardPayload(result = {}, forceOverride = false) {
  restoreCandidates.value = []
  const nextFilePaths = Array.isArray(result?.filePaths) ? result.filePaths : []
  const nextImage = typeof result?.imageDataUrl === 'string' ? result.imageDataUrl : ''
  const nextText = typeof result?.text === 'string' ? result.text : ''

  if (nextFilePaths.length > 0) {
    await applyFileAttachment(nextFilePaths)
    return
  }

  if (nextImage) {
    applyImageAttachment(nextImage)
    return
  }

  if (nextText.trim()) {
    updateFromTextInput(nextText, true)
    return
  }

  if (forceOverride) {
    clearQuickContent()
  }
}

function applyRuntimeConfig(config = null) {
  currentConfig.value = config && typeof config === 'object' ? config : {}
  document.documentElement.classList.toggle('dark', Boolean(currentConfig.value?.isDarkMode))

  const prompts = currentConfig.value?.prompts || {}
  const currentSelected = selectedPromptKey.value
  if (currentSelected) {
    const selectedPromptConfig = prompts[currentSelected]
    if (!selectedPromptConfig || selectedPromptConfig.enable === false) {
      selectedPromptKey.value = ''
    }
  }
}


async function refreshFromClipboard(forceOverride = false) {
  try {
    const result = await window.api.captureSelectionPayload?.() || await window.api.readClipboardPayload()
    if (forceOverride && hasInitPayloadApplied) {
      return
    }
    await handleClipboardPayload(result, forceOverride)
  } catch (error) {
    ElMessage.error(getErrorMessage(error, '读取剪贴板失败'))
  }
}

function applyImageAttachment(dataUrl = '') {
  const normalizedDataUrl = String(dataUrl || '')
  if (normalizedDataUrl.startsWith('data:image/svg+xml')) {
    setAttachment({
      type: 'files',
      filePaths: ['clipboard.svg'],
      previewLabel: 'clipboard.svg'
    })
    restoreCandidates.value = []
    return
  }

  setAttachment({
    type: 'img',
    imageDataUrl: normalizedDataUrl,
    previewLabel: '图片'
  })
  restoreCandidates.value = []
  focusInputToEnd()
}

async function applyFileAttachment(paths = [], previewLabel = '') {
  const normalizedPaths = Array.isArray(paths) ? paths.filter(Boolean) : []
  if (!normalizedPaths.length) return
  setAttachment({
    type: 'files',
    filePaths: normalizedPaths,
    previewLabel: previewLabel || normalizedPaths[0]?.split(/[/\\]/).pop() || ''
  })
  queryText.value = ''
  await inspectSessionCandidates(normalizedPaths)
  focusInputToEnd()
}

async function handlePaste(event) {
  const clipboardData = event.clipboardData
  if (!clipboardData) return

  const items = Array.from(clipboardData.items || [])
  const fileItems = items.filter((item) => item.kind === 'file')
  if (fileItems.length > 0) {
    event.preventDefault()

    const imageDataUrls = []
    const filePaths = []

    for (const item of fileItems) {
      const file = item.getAsFile()
      if (!file) continue

      if (file.type.startsWith('image/') && file.type !== 'image/svg+xml') {
        const dataUrl = await new Promise((resolve, reject) => {
          const reader = new FileReader()
          reader.onload = () => resolve(String(reader.result || ''))
          reader.onerror = () => reject(new Error('读取图片失败'))
          reader.readAsDataURL(file)
        }).catch(() => '')
        if (dataUrl) imageDataUrls.push(dataUrl)
        continue
      }

      const filePath = window.api.getDroppedFilePath?.(file)
      if (filePath) filePaths.push(filePath)
    }

    if (filePaths.length > 0) {
      await applyFileAttachment(filePaths, filePaths[0]?.split(/[/\\]/).pop() || '')
      return
    }

    if (imageDataUrls.length === 1) {
      applyImageAttachment(imageDataUrls[0])
      return
    }

    if (imageDataUrls.length > 1) {
      setAttachment({
        type: 'image-files',
        imageDataUrls,
        previewLabel: `图片 ${imageDataUrls.length}`
      })
      restoreCandidates.value = []
      focusInputToEnd()
      return
    }
  }

  const pastedText = clipboardData.getData('text')
  if (!pastedText) return
  if (/\r?\n/.test(pastedText)) {
    event.preventDefault()
    updateFromTextInput(pastedText, true)
    return
  }

  clearAttachment()
}

function handleKeydown(event) {
  if (event.isComposing) return

  if (event.key === 'ArrowDown') {
    event.preventDefault()
    const list = candidateSections.value
    if (!list.length) return
    const currentIndex = list.findIndex((item) => item.key === selectedPromptKey.value)
    const nextIndex = currentIndex < 0 ? 0 : (currentIndex + 1) % list.length
    selectedPromptKey.value = list[nextIndex].key
    shouldShowSelection.value = true
    return
  }

  if (event.key === 'ArrowUp') {
    event.preventDefault()
    const list = candidateSections.value
    if (!list.length) return
    const currentIndex = list.findIndex((item) => item.key === selectedPromptKey.value)
    const nextIndex = currentIndex < 0 ? list.length - 1 : (currentIndex - 1 + list.length) % list.length
    selectedPromptKey.value = list[nextIndex].key
    shouldShowSelection.value = true
    return
  }

  if (event.key === 'Enter') {
    event.preventDefault()
    if (restoreCandidates.value.length > 0 && !queryText.value.trim() && attachment.value.type === 'files') {
      restoreSession(restoreCandidates.value[0])
      return
    }
    openPrompt(selectedPrompt.value)
    return
  }

  if (event.key === 'Backspace' && !queryText.value && hasAttachment.value) {
    event.preventDefault()
    clearAttachment()
    return
  }

  if (event.key === 'Escape') {
    event.preventDefault()
    if (queryText.value.trim() || hasAttachment.value) {
      clearQuickContent()
      shouldShowSelection.value = false
      focusInputToEnd()
      return
    }
    hideQuick()
  }
}

function handleGlobalKeydown(event) {
  const active = document.activeElement
  const isInputActive = active === inputRef.value || active === document.body || active === document.documentElement
  if (!isInputActive) return

  if (event.key === 'Backspace' && !queryText.value && hasAttachment.value) {
    event.preventDefault()
    event.stopPropagation()
    clearAttachment()
    return
  }

  if (event.key === 'Escape') {
    event.preventDefault()
    event.stopPropagation()
    if (queryText.value.trim() || hasAttachment.value) {
      clearQuickContent()
      shouldShowSelection.value = false
      focusInputToEnd()
      return
    }
    hideQuick()
  }
}

onMounted(async () => {
  window.addEventListener('keydown', handleGlobalKeydown, true)

  window.api?.onConfigUpdated?.((newConfig) => {
    applyRuntimeConfig(newConfig || {})
  })

  window.api?.onWindowInit?.((data) => {


    hasInitPayloadApplied = false
    if (typeof data?.senderId === 'string' && data.senderId) {
      senderId.value = data.senderId
    }

    if (data?.type === 'files' && Array.isArray(data.payload)) {
      const paths = data.payload.map((item) => item?.path).filter(Boolean)
      applyFileAttachment(paths)
      hasInitPayloadApplied = paths.length > 0
    } else if (data?.type === 'img' && typeof data.payload === 'string') {
      applyImageAttachment(data.payload)
      hasInitPayloadApplied = Boolean(data.payload)
    } else if ((data?.type === 'over' || data?.type === 'multiline-text') && typeof data.payload === 'string') {
      updateFromTextInput(data.payload, true)
      hasInitPayloadApplied = Boolean(data.payload.trim())
    } else if (data?.type === 'empty') {
      clearQuickContent()
      shouldShowSelection.value = false
      focusInputToEnd()
    }

    if (typeof data?.userText === 'string' && data.userText.trim()) {
      queryText.value = data.userText.trim()
    }

    if (data?.promptKey) {
      selectedPromptKey.value = data.promptKey
      shouldShowSelection.value = Boolean(data.promptKey)
    }

    requestAnimationFrame(() => {
      focusInputToEnd()
    })
  })

  try {
    const result = await window.api.getConfig()
    applyRuntimeConfig(result?.config || {})
  } catch (error) {
    ElMessage.error(getErrorMessage(error, '加载配置失败'))
  }

  requestAnimationFrame(() => {
    focusInputToEnd()
  })
  setTimeout(() => {
    focusInputToEnd()
  }, 30)
})

onBeforeUnmount(() => {
  window.removeEventListener('keydown', handleGlobalKeydown, true)
})
</script>

<template>
  <div class="quick-shell">
    <div class="quick-content">
      <div class="quick-drag-layer"></div>
      <div class="quick-search-row quick-drag-handle">
          <div v-if="hasAttachment" class="top-token" :title="attachmentPreviewLabel">
            <span class="top-token-icon" v-if="attachment.type === 'files'">📄</span>
            <span class="top-token-icon" v-else-if="attachment.type === 'img'">🖼</span>
            <span class="top-token-icon" v-else>≡</span>
            <span class="top-token-label">{{ attachmentPreviewLabel }}</span>
            <span v-if="attachment.type === 'files' && attachment.filePaths.length > 1" class="top-token-count">{{ attachment.filePaths.length }}</span>
          </div>
          <input
            ref="inputRef"
            v-model="queryText"
            class="search-input"
            type="text"
            spellcheck="false"
            autocomplete="off"
            placeholder="搜索快捷助手，或粘贴文本、图片、文件"
            @paste="handlePaste"
            @keydown="handleKeydown"
          />
      </div>

      <div class="recommend-title">匹配推荐</div>

      <div v-if="restoreCandidates.length > 0" class="restore-zone">
        <button
          v-for="candidate in restoreCandidates"
          :key="candidate.filePath"
          class="restore-chip"
          type="button"
          @click="restoreSession(candidate)"
        >
          ↺ {{ candidate.fileName }}
        </button>
      </div>

      <div class="grid-wrap">
        <button
          v-for="prompt in candidateSections"
          :key="prompt.key"
          type="button"
          class="prompt-tile"
          :class="{ active: shouldShowSelection && selectedPromptKey === prompt.key }"
          @mouseenter="selectedPromptKey = prompt.key; shouldShowSelection = true"
          @click="selectedPromptKey = prompt.key; shouldShowSelection = true; openPrompt(prompt)"
        >
          <div class="tile-icon-wrap">
            <img v-if="prompt.iconUrl" :src="prompt.iconUrl" :alt="prompt.key" class="tile-icon" />
            <div v-else class="tile-fallback">{{ prompt.key.slice(0, 1).toUpperCase() }}</div>
          </div>
          <div class="tile-name">{{ prompt.key }}</div>
        </button>
      </div>
    </div>
  </div>
</template>

<style scoped>
.quick-shell {
  min-height: 100vh;
  height: 100vh;
  display: flex;
  align-items: stretch;
  justify-content: stretch;
  padding: 0;
  box-sizing: border-box;
  background: transparent;
  overflow: hidden;
}

.quick-content {
  position: relative;
  width: 100%;
  min-height: 100%;
  display: flex;
  flex-direction: column;
  justify-content: flex-start;
  gap: 8px;
  padding: 14px;
  border-radius: 8px;
  background: rgba(255, 255, 255, 0.96);
  box-shadow: none;
  box-sizing: border-box;
  -webkit-app-region: drag;
}

html.dark .quick-content {
  background: rgba(29, 31, 37, 1);
  box-shadow: none;
}

.quick-drag-layer {
  position: absolute;
  inset: 0;
  border-radius: 22px;
  pointer-events: none;
}

.restore-zone,
.grid-wrap,
.prompt-tile,
.restore-chip,
.search-input,
.top-token {
  -webkit-app-region: no-drag;
}

.quick-search-row {
  min-height: 52px;
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px 12px;
  border-radius: 16px;
  background: rgba(248, 250, 252, 0.96);
  overflow: hidden;
  -webkit-app-region: drag;
}

html.dark .quick-search-row {
  background: rgba(40, 43, 50, 0.98);
}

.top-token {
  flex: 0 1 auto;
  min-width: 0;
  max-width: 320px;
  display: inline-flex;
  align-items: center;
  gap: 5px;
  padding: 4px 8px;
  border-radius: 999px;
  background: rgba(231, 237, 244, 0.96);
  overflow: hidden;
}

html.dark .top-token {
  background: rgba(60, 64, 73, 0.94);
}

.top-token-icon {
  flex-shrink: 0;
  font-size: 11px;
}

.top-token-label {
  min-width: 0;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  font-size: 12px;
  color: #2d2d36;
}

html.dark .top-token-label {
  color: #f3f3f6;
}

.top-token-count {
  flex-shrink: 0;
  width: 16px;
  height: 16px;
  border-radius: 999px;
  background: #2d2d36;
  color: #fff;
  font-size: 10px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
}

.search-input {
  flex: 1;
  min-width: 0;
  height: 34px;
  border: none;
  outline: none;
  background: transparent;
  font-size: 15px;
  line-height: 34px;
  color: #1f1f24;
  padding: 0;
  cursor: text;
}

html.dark .search-input {
  color: #f5f5f7;
}

.search-input::placeholder {
  color: #9aa3b2;
}

.recommend-title {
  flex: 0 0 auto;
  font-size: 11px;
  font-weight: 700;
  color: #667085;
  padding-left: 2px;
}

html.dark .recommend-title {
  color: #aeb6c3;
}

.restore-zone {
  flex: 0 0 auto;
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  overflow: hidden;
}

.restore-chip {
  border: none;
  border-radius: 999px;
  padding: 5px 9px;
  background: rgba(242, 245, 249, 0.96);
  color: #4e4e59;
  cursor: pointer;
}

html.dark .restore-chip {
  background: rgba(44, 47, 55, 0.94);
  color: #ececf0;
}

.grid-wrap {
  display: grid;
  grid-template-columns: repeat(10, minmax(0, 1fr));
  grid-auto-rows: 78px;
  gap: 8px;
  overflow: hidden;
  max-height: calc(78px * 3 + 16px);
}

.prompt-tile {
  border: none;
  background: rgba(247, 249, 252, 0.96);
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 6px;
  padding: 6px 3px;
  border-radius: 12px;
  cursor: pointer;
  transition: transform 0.1s ease, background 0.1s ease;
}

.prompt-tile:hover,
.prompt-tile.active {
  background: rgba(237, 242, 248, 1);
  transform: translateY(-1px);
}

html.dark .prompt-tile {
  background: rgba(35, 38, 45, 0.92);
}

html.dark .prompt-tile:hover,
html.dark .prompt-tile.active {
  background: rgba(49, 54, 63, 0.98);
}

.tile-icon-wrap {
  width: 34px;
  height: 34px;
  border-radius: 10px;
  overflow: hidden;
  background: transparent;
  display: flex;
  align-items: center;
  justify-content: center;
}

.tile-icon {
  width: 100%;
  height: 100%;
  object-fit: cover;
}

.tile-fallback {
  font-size: 14px;
  font-weight: 700;
  color: #565666;
}

html.dark .tile-fallback {
  color: #f2f2f6;
}

.tile-name {
  font-size: 11.5px;
  line-height: 1.25;
  text-align: center;
  color: #2d2d36;
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
  overflow: hidden;
  word-break: break-word;
}

html.dark .tile-name {
  color: #f2f2f6;
}

@media (max-width: 1100px) {
  .grid-wrap {
    grid-template-columns: repeat(8, minmax(0, 1fr));
  }
}

@media (max-width: 860px) {
  .grid-wrap {
    grid-template-columns: repeat(6, minmax(0, 1fr));
  }

  .search-input {
    font-size: 14px;
  }
}
</style>
