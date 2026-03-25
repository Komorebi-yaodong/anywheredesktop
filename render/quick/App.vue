<script setup>
import { computed, nextTick, onBeforeUnmount, onMounted, ref } from 'vue'
import { ElMessage } from 'element-plus'
import { pinyin } from 'pinyin-pro'

const senderId = ref('quick')

const currentConfig = ref(null)
const queryText = ref('')
const selectedPromptKey = ref('')
const restoreCandidates = ref([])
const attachment = ref(createEmptyAttachment())
let blurCloseTimer = null

function createEmptyAttachment() {
  return {
    type: 'none',
    rawText: '',
    imageDataUrl: '',
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
  const promptText = String(prompt?.prompt || '').toLowerCase()
  const pinyinProfile = getPinyinProfile(name)

  return {
    lowerName,
    promptText,
    pinyinFull: pinyinProfile.full,
    pinyinInitials: pinyinProfile.initials,
    pinyinCompact: pinyinProfile.compact
  }
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
    if (next.filePaths.length <= 1) return first
    return `${first} ${next.filePaths.length}`
  }

  if (next.type === 'img') {
    return '图片'
  }

  if (next.type === 'multiline-text') {
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

function setAttachment(next = {}) {
  attachment.value = {
    type: next.type || 'none',
    rawText: typeof next.rawText === 'string' ? next.rawText : '',
    imageDataUrl: typeof next.imageDataUrl === 'string' ? next.imageDataUrl : '',
    filePaths: Array.isArray(next.filePaths) ? next.filePaths : [],
    previewLabel: typeof next.previewLabel === 'string' ? next.previewLabel : ''
  }
}

function focusInputToEnd() {
  clearTimeout(blurCloseTimer)
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
  const mode = runtimeMode.value
  const attachmentLocked = mode !== 'singleline-text'

  const nameMatches = []
  const textMatches = []
  const typeMatches = []
  const fallbackMatches = []

  for (const prompt of prompts) {
    const promptType = normalizePromptType(prompt.type)
    const searchProfile = buildPromptSearchProfile(prompt)
    let nameScore = 0
    let textScore = 0

    const matchName = () => {
      if (!hasQuery) return 0
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

    const matchText = () => {
      if (!hasQuery || attachmentLocked) return 0
      if (!(promptType === 'over' || promptType === 'general')) return 0

      const regex = normalizeRegex(prompt.matchRegex)
      if (promptType === 'over') {
        if (regex && regex.test(rawQuery)) return 3200
        if (!regex) return 1900
      }

      const searchable = `${searchProfile.promptText} ${searchProfile.lowerName}`
      if (searchable.includes(query)) {
        return promptType === 'over' ? 2600 : 2200
      }

      return promptType === 'general' ? 1600 : 0
    }

    nameScore = matchName()
    textScore = matchText()

    const item = {
      ...prompt,
      iconUrl: getPromptIcon(prompt),
      score: 0
    }

    if (attachmentLocked) {
      if (nameScore > 0) {
        item.score = nameScore
        nameMatches.push(item)
        continue
      }

      if (!hasQuery) {
        if ((mode === 'img' && promptType === 'img') || (mode === 'files' && promptType === 'files') || (mode === 'multiline-text' && promptType === 'over')) {
          item.score = 900
          typeMatches.push(item)
        } else if (promptType === 'general') {
          item.score = 600
          fallbackMatches.push(item)
        } else {
          item.score = 100
          fallbackMatches.push(item)
        }
      }
      continue
    }

    if (textScore > 0) {
      item.score = textScore
      textMatches.push(item)
      continue
    }

    if (nameScore > 0) {
      item.score = nameScore
      nameMatches.push(item)
      continue
    }

    if (!hasQuery) {
      if (promptType === 'over' || promptType === 'general') {
        item.score = promptType === 'over' ? 700 : 620
        typeMatches.push(item)
      } else {
        item.score = 100
        fallbackMatches.push(item)
      }
    } else if (promptType === 'general') {
      item.score = 900
      fallbackMatches.push(item)
    }
  }

  const sorter = (a, b) => b.score - a.score || a.key.localeCompare(b.key, 'zh-CN')
  const sections = [
    ...textMatches.sort(sorter),
    ...nameMatches.sort(sorter),
    ...typeMatches.sort(sorter),
    ...fallbackMatches.sort(sorter)
  ]

  const deduped = []
  const seen = new Set()
  for (const item of sections) {
    if (seen.has(item.key)) continue
    seen.add(item.key)
    deduped.push(item)
  }

  if (!deduped.some((item) => item.key === selectedPromptKey.value)) {
    selectedPromptKey.value = deduped[0]?.key || ''
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

  if (attachment.value.type === 'files' && attachment.value.filePaths.length > 0) {
    payload.type = 'files'
    payload.payload = attachment.value.filePaths.map((filePath) => ({ path: filePath }))
    if (queryText.value.trim()) payload.userText = queryText.value.trim()
    return payload
  }

  if (attachment.value.type === 'multiline-text' && attachment.value.rawText.trim()) {
    payload.type = 'over'
    payload.payload = attachment.value.rawText.trim()
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

async function closeQuick() {
  try {
    await window.api.closeWindow(senderId.value)
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
    await closeQuick()
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
    await closeQuick()
  } catch (error) {
    ElMessage.error(getErrorMessage(error, '恢复对话失败'))
  }
}

function updateFromTextInput(text = '', forceOverride = false) {
  const normalizedText = String(text || '')
  const trimmed = normalizedText.trim()
  const textKind = classifyTextAttachment(trimmed)

  if (!trimmed) {
    if (forceOverride) {
      queryText.value = ''
      clearAttachment()
    }
    return
  }

  if (textKind === 'multiline-text') {
    setAttachment({
      type: 'multiline-text',
      rawText: trimmed,
      previewLabel: trimmed
    })
    if (forceOverride) queryText.value = ''
    return
  }

  if (forceOverride || !queryText.value.trim()) {
    queryText.value = trimmed
  }
}

async function handleClipboardPayload(result = {}, forceOverride = false) {
  restoreCandidates.value = []
  const nextFilePaths = Array.isArray(result?.filePaths) ? result.filePaths : []
  const nextImage = typeof result?.imageDataUrl === 'string' ? result.imageDataUrl : ''
  const nextText = typeof result?.text === 'string' ? result.text : ''

  if (nextFilePaths.length > 0) {
    setAttachment({
      type: 'files',
      filePaths: nextFilePaths,
      previewLabel: nextFilePaths[0]?.split(/[/\\]/).pop() || ''
    })
    queryText.value = classifyTextAttachment(nextText) === 'singleline-text' ? nextText.trim() : ''
    await inspectSessionCandidates(nextFilePaths)
    return
  }

  if (nextImage) {
    setAttachment({
      type: 'img',
      imageDataUrl: nextImage,
      previewLabel: '图片'
    })
    queryText.value = classifyTextAttachment(nextText) === 'singleline-text' ? nextText.trim() : ''
    return
  }

  if (nextText.trim()) {
    updateFromTextInput(nextText, forceOverride || true)
    return
  }

  if (forceOverride) {
    clearAttachment()
    queryText.value = ''
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
    await handleClipboardPayload(result, forceOverride)
  } catch (error) {
    ElMessage.error(getErrorMessage(error, '读取剪贴板失败'))
  }
}

function applyImageAttachment(dataUrl = '') {
  setAttachment({
    type: 'img',
    imageDataUrl: String(dataUrl || ''),
    previewLabel: '图片'
  })
  restoreCandidates.value = []
}

async function applyFileAttachment(paths = [], previewLabel = '') {
  const normalizedPaths = Array.isArray(paths) ? paths.filter(Boolean) : []
  if (!normalizedPaths.length) return
  setAttachment({
    type: 'files',
    filePaths: normalizedPaths,
    previewLabel: previewLabel || normalizedPaths[0]?.split(/[/\\]/).pop() || ''
  })
  await inspectSessionCandidates(normalizedPaths)
}

async function handlePaste(event) {
  const clipboardData = event.clipboardData
  if (!clipboardData) return

  const items = Array.from(clipboardData.items || [])
  const fileItems = items.filter((item) => item.kind === 'file')
  if (fileItems.length > 0) {
    event.preventDefault()
    for (const item of fileItems) {
      const file = item.getAsFile()
      if (!file) continue
      if (file.type.startsWith('image/')) {
        const reader = new FileReader()
        reader.onload = () => applyImageAttachment(String(reader.result || ''))
        reader.readAsDataURL(file)
        return
      }

      const filePath = window.api.getDroppedFilePath?.(file)
      if (filePath) {
        await applyFileAttachment([filePath], file.name || filePath.split(/[/\\]/).pop() || '')
        return
      }
    }
  }

  const pastedText = clipboardData.getData('text')
  if (!pastedText) return
  if (/\r?\n/.test(pastedText)) {
    event.preventDefault()
    updateFromTextInput(pastedText, true)
  }
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
    return
  }

  if (event.key === 'ArrowUp') {
    event.preventDefault()
    const list = candidateSections.value
    if (!list.length) return
    const currentIndex = list.findIndex((item) => item.key === selectedPromptKey.value)
    const nextIndex = currentIndex < 0 ? list.length - 1 : (currentIndex - 1 + list.length) % list.length
    selectedPromptKey.value = list[nextIndex].key
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

  if (event.key === 'Escape') {
    event.preventDefault()
    closeQuick()
    return
  }
}

function handleGlobalKeydown(event) {
  if (event.key === 'Escape') {
    event.preventDefault()
    event.stopPropagation()
    closeQuick()
    return
  }

  if (event.key === 'Backspace') {
    const active = document.activeElement
    if (active !== inputRef.value) return
    if (queryText.value.length > 0) return
    if (!hasAttachment.value) return
    event.preventDefault()
    clearAttachment()
  }
}

function handleWindowBlur() {
  clearTimeout(blurCloseTimer)
  blurCloseTimer = setTimeout(() => {
    closeQuick()
  }, 30)
}

onMounted(async () => {
  window.addEventListener('keydown', handleGlobalKeydown, true)
  window.addEventListener('blur', handleWindowBlur)

    window.api?.onConfigUpdated?.((newConfig) => {
    applyRuntimeConfig(newConfig || {})
  })


window.api?.onWindowInit?.((data) => {
    if (typeof data?.senderId === 'string' && data.senderId) {
      senderId.value = data.senderId
    }


    if (data?.type === 'files' && Array.isArray(data.payload)) {
      const paths = data.payload.map((item) => item?.path).filter(Boolean)
      applyFileAttachment(paths)
    } else if (data?.type === 'img' && typeof data.payload === 'string') {
      applyImageAttachment(data.payload)
    } else if (data?.type === 'over' && typeof data.payload === 'string') {
      updateFromTextInput(data.payload, true)
    } else if (data?.type === 'empty') {
      clearAttachment()
      queryText.value = ''
    }

    if (typeof data?.userText === 'string') {
      queryText.value = data.userText.trim()
    }

    if (data?.promptKey) {
      selectedPromptKey.value = data.promptKey
    }

    focusInputToEnd()
  })

  try {
    const result = await window.api.getConfig()
    applyRuntimeConfig(result?.config || {})
  } catch (error) {
    ElMessage.error(getErrorMessage(error, '加载配置失败'))
  }

  await refreshFromClipboard(true)
  focusInputToEnd()
  requestAnimationFrame(() => {
    focusInputToEnd()
  })
  setTimeout(() => {
    focusInputToEnd()
  }, 60)
})

onBeforeUnmount(() => {
  clearTimeout(blurCloseTimer)
  window.removeEventListener('keydown', handleGlobalKeydown, true)
  window.removeEventListener('blur', handleWindowBlur)
})
</script>

<template>
  <div class="quick-shell">
    <div class="quick-panel">
      <div class="quick-topbar">
        <div class="quick-search-row">
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
            placeholder="搜索"
            @paste="handlePaste"
            @keydown="handleKeydown"
          />
        </div>
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
          :class="{ active: selectedPromptKey === prompt.key }"
          @click="selectedPromptKey = prompt.key; openPrompt(prompt)"
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
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 8px 12px;
  box-sizing: border-box;
  background: #f7f7f8;
  overflow: hidden;
}

html.dark .quick-shell {
  background: #1f1f23;
}

.quick-panel {
  width: min(1280px, 100%);
  height: min(520px, calc(100vh - 16px));
  display: flex;
  flex-direction: column;
  gap: 10px;
  padding: 12px 14px 10px;
  border-radius: 14px;
  background: #f7f7f8;
  box-sizing: border-box;
  overflow: hidden;
}

html.dark .quick-panel {
  background: #1f1f23;
}

.quick-topbar {
  flex: 0 0 auto;
}

.quick-search-row {
  min-height: 52px;
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 6px 10px;
  border: 1px solid #d8d8df;
  border-radius: 10px;
  background: #ffffff;
  overflow: hidden;
}

html.dark .quick-search-row {
  border-color: #3a3a41;
  background: #2a2a2f;
}

.top-token {
  flex: 0 1 auto;
  min-width: 0;
  max-width: 360px;
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 4px 8px;
  border: 1px solid #d0d0d8;
  border-radius: 8px;
  background: #fafafa;
  overflow: hidden;
}

html.dark .top-token {
  border-color: #474750;
  background: #34343b;
}

.top-token-icon {
  flex-shrink: 0;
  font-size: 13px;
}

.top-token-label {
  min-width: 0;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  font-size: 14px;
  color: #2d2d36;
}

html.dark .top-token-label {
  color: #f3f3f6;
}

.top-token-count {
  flex-shrink: 0;
  width: 20px;
  height: 20px;
  border-radius: 999px;
  background: #2d2d36;
  color: #fff;
  font-size: 12px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
}

.search-input {
  flex: 1;
  min-width: 0;
  height: 38px;
  border: none;
  outline: none;
  background: transparent;
  font-size: 20px;
  line-height: 38px;
  color: #1f1f24;
  padding: 0;
}

html.dark .search-input {
  color: #f5f5f7;
}

.search-input::placeholder {
  color: #a0a0aa;
}

.recommend-title {
  flex: 0 0 auto;
  font-size: 14px;
  font-weight: 700;
  color: #111116;
}

html.dark .recommend-title {
  color: #f3f3f6;
}

.restore-zone {
  flex: 0 0 auto;
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  overflow: hidden;
}

.restore-chip {
  border: none;
  border-radius: 999px;
  padding: 6px 10px;
  background: #ececf1;
  color: #4e4e59;
  cursor: pointer;
}

html.dark .restore-chip {
  background: #33333a;
  color: #ececf0;
}

.grid-wrap {
  flex: 1;
  min-height: 0;
  display: grid;
  grid-template-columns: repeat(10, minmax(0, 1fr));
  gap: 10px 12px;
  align-content: start;
  overflow: hidden;
}

.prompt-tile {
  border: none;
  background: transparent;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 6px;
  padding: 4px 2px;
  border-radius: 10px;
  cursor: pointer;
  transition: background 0.16s ease;
}

.prompt-tile:hover,
.prompt-tile.active {
  background: rgba(0, 0, 0, 0.06);
}

html.dark .prompt-tile:hover,
html.dark .prompt-tile.active {
  background: rgba(255, 255, 255, 0.08);
}

.tile-icon-wrap {
  width: 46px;
  height: 46px;
  border-radius: 10px;
  overflow: hidden;
  background: #ffffff;
  display: flex;
  align-items: center;
  justify-content: center;
}

html.dark .tile-icon-wrap {
  background: #2a2a2f;
}

.tile-icon {
  width: 100%;
  height: 100%;
  object-fit: cover;
}

.tile-fallback {
  font-size: 18px;
  font-weight: 700;
  color: #565666;
}

html.dark .tile-fallback {
  color: #f2f2f6;
}

.tile-name {
  font-size: 11px;
  line-height: 1.2;
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
    font-size: 18px;
  }
}
</style>
