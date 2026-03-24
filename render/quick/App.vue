<script setup>
import { computed, onMounted, ref } from 'vue'
import { ElMessage } from 'element-plus'

const windowContext = window.api?.getWindowContext?.() || { senderId: 'quick' }
const senderId = windowContext.senderId || 'quick'

const currentConfig = ref(null)
const searchText = ref('')
const payloadType = ref('empty')
const imageDataUrl = ref('')
const filePaths = ref([])
const filePreviewName = ref('')
const selectedPromptKey = ref('')
const restoreCandidates = ref([])
const isReadonlyPreview = ref(false)

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

function getInitials(text = '') {
  return String(text || '')
    .split(/[^a-zA-Z0-9\u4e00-\u9fa5]+/)
    .filter(Boolean)
    .map((part) => /^[a-zA-Z]/.test(part) ? part[0].toLowerCase() : '')
    .join('')
}

function updateReadonlyPreviewState() {
  isReadonlyPreview.value = payloadType.value !== 'empty' && searchText.value.includes('\n')
}

function setAttachmentState(next = {}) {
  payloadType.value = next.type || 'empty'
  imageDataUrl.value = next.imageDataUrl || ''
  filePaths.value = Array.isArray(next.filePaths) ? next.filePaths : []
  filePreviewName.value = next.filePreviewName || (filePaths.value[0] ? filePaths.value[0].split(/[/\\]/).pop() || '' : '')
  updateReadonlyPreviewState()
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

const candidatePrompts = computed(() => {
  const prompts = allPrompts.value
  const rawQuery = searchText.value.trim()
  const query = rawQuery.toLowerCase()
  const runtimeType = payloadType.value
  const hasTextQuery = Boolean(query)

  const scored = prompts
    .map((prompt) => {
      const promptType = normalizePromptType(prompt.type)
      let score = 0
      const name = prompt.key || ''
      const lowerName = name.toLowerCase()
      const initials = getInitials(name)

      if (hasTextQuery) {
        if (lowerName === query) score += 2200
        else if (lowerName.startsWith(query)) score += 1600
        else if (initials && initials === query) score += 1400
        else if (lowerName.includes(query)) score += 900
        else if (initials && initials.includes(query)) score += 800
      }

      if (runtimeType === 'img') {
        if (promptType === 'img') score += hasTextQuery ? 180 : 420
        else if (promptType === 'general') score += hasTextQuery ? 120 : 180
      } else if (runtimeType === 'files') {
        if (promptType === 'files') score += hasTextQuery ? 180 : 420
        else if (promptType === 'general') score += hasTextQuery ? 120 : 180
      } else if (runtimeType === 'over') {
        if (promptType === 'over') {
          const regex = normalizeRegex(prompt.matchRegex)
          if (regex && regex.test(searchText.value)) score += 260
          else if (!regex) score += 160
        } else if (promptType === 'general') {
          score += 100
        }
      } else {
        score += promptType === 'general' ? 60 : 0
      }

      if (!hasTextQuery && score <= 0) return null

      if (hasTextQuery && score <= 0) {
        const searchable = `${lowerName} ${(prompt.prompt || '').toLowerCase()}`
        if (!searchable.includes(query)) return null
        score += 30
      }

      return {
        ...prompt,
        iconUrl: getPromptIcon(prompt),
        score,
        initials
      }
    })
    .filter(Boolean)
    .sort((a, b) => b.score - a.score || a.key.localeCompare(b.key))

  if (!selectedPromptKey.value && scored.length > 0) {
    selectedPromptKey.value = scored[0].key
  }

  return scored
})

function resolveWindowPayload(prompt) {
  const nextPayload = { code: prompt.key }

  if (payloadType.value === 'img' && imageDataUrl.value) {
    nextPayload.type = 'img'
    nextPayload.payload = imageDataUrl.value
    if (searchText.value.trim()) nextPayload.userText = searchText.value.trim()
  } else if (payloadType.value === 'files' && filePaths.value.length > 0) {
    nextPayload.type = 'files'
    nextPayload.payload = filePaths.value.map((filePath) => ({ path: filePath }))
    if (searchText.value.trim()) nextPayload.userText = searchText.value.trim()
  } else if (searchText.value.trim()) {
    nextPayload.type = 'over'
    nextPayload.payload = searchText.value.trim()
  }

  return nextPayload
}

async function closeQuick() {
  try {
    await window.api.closeWindow(senderId)
  } catch {
    // ignore fire-and-forget close
  }
}

async function openPrompt(prompt) {
  if (!prompt) return
  try {
    const payload = resolveWindowPayload(prompt)
    await window.api.openWindow('window', payload)
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

async function handleClipboardPayload(result = {}, forceOverride = false) {
  restoreCandidates.value = []

  const nextFilePaths = Array.isArray(result?.filePaths) ? result.filePaths : []
  const nextImage = typeof result?.imageDataUrl === 'string' ? result.imageDataUrl : ''
  const nextText = typeof result?.text === 'string' ? result.text : ''

  if (nextFilePaths.length > 0) {
    setAttachmentState({
      type: 'files',
      filePaths: nextFilePaths,
      filePreviewName: nextFilePaths[0]?.split(/[/\\]/).pop() || ''
    })
    if (forceOverride && nextText.trim()) {
      searchText.value = nextText
    }
    await inspectSessionCandidates(nextFilePaths)
    updateReadonlyPreviewState()
    return
  }

  if (nextImage) {
    setAttachmentState({ type: 'img', imageDataUrl: nextImage })
    if (forceOverride && nextText.trim()) {
      searchText.value = nextText
    }
    updateReadonlyPreviewState()
    return
  }

  if (nextText.trim()) {
    setAttachmentState({ type: nextText.includes('\n') ? 'over' : 'empty' })
    if (forceOverride || !searchText.value.trim()) {
      searchText.value = nextText
    }
    updateReadonlyPreviewState()
    return
  }

  if (!searchText.value.trim()) {
    setAttachmentState({ type: 'empty' })
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

async function handlePaste(event) {
  const items = Array.from(event.clipboardData?.items || [])
  if (!items.length) return

  for (const item of items) {
    if (item.kind !== 'file') continue
    event.preventDefault()
    const file = item.getAsFile()
    if (!file) continue

    if (file.type.startsWith('image/')) {
      const reader = new FileReader()
      reader.onload = () => {
        setAttachmentState({ type: 'img', imageDataUrl: String(reader.result || '') })
      }
      reader.readAsDataURL(file)
      return
    }

    const filePath = window.api.getDroppedFilePath?.(file)
    if (filePath) {
      setAttachmentState({
        type: 'files',
        filePaths: [filePath],
        filePreviewName: file.name || filePath.split(/[/\\]/).pop() || ''
      })
      await inspectSessionCandidates([filePath])
      return
    }
  }
}

onMounted(async () => {
  window.api?.onWindowInit?.((data) => {
    if (data?.type === 'files' && Array.isArray(data.payload)) {
      const paths = data.payload.map((item) => item?.path).filter(Boolean)
      setAttachmentState({
        type: 'files',
        filePaths: paths,
        filePreviewName: paths[0]?.split(/[/\\]/).pop() || ''
      })
      inspectSessionCandidates(paths)
    } else if (data?.type === 'img' && typeof data.payload === 'string') {
      setAttachmentState({ type: 'img', imageDataUrl: data.payload })
    } else if (data?.type === 'over' && typeof data.payload === 'string') {
      searchText.value = data.payload
      setAttachmentState({ type: data.payload.includes('\n') ? 'over' : 'empty' })
    } else if (data?.type === 'empty') {
      setAttachmentState({ type: 'empty' })
    }

    if (typeof data?.userText === 'string' && data.userText.trim()) {
      searchText.value = data.userText
    }

    if (data?.promptKey) {
      selectedPromptKey.value = data.promptKey
    }

    updateReadonlyPreviewState()
  })

  try {
    const result = await window.api.getConfig()
    currentConfig.value = result?.config || {}
    document.documentElement.classList.toggle('dark', Boolean(currentConfig.value?.isDarkMode))
  } catch (error) {
    ElMessage.error(getErrorMessage(error, '加载配置失败'))
  }

  await refreshFromClipboard(true)
})
</script>

<template>
  <div class="quick-shell">
    <div class="quick-panel">
      <div class="search-strip">
        <div v-if="payloadType === 'img' && imageDataUrl" class="left-preview image-preview">
          <img :src="imageDataUrl" alt="clipboard image" />
        </div>
        <div v-else-if="payloadType === 'files' && filePreviewName" class="left-preview file-preview">
          <span class="file-ext">{{ filePreviewName.split('.').pop()?.toUpperCase() || 'FILE' }}</span>
        </div>

        <div class="search-content">
          <textarea
            v-if="!isReadonlyPreview"
            v-model="searchText"
            class="search-input"
            placeholder="搜索"
            @paste="handlePaste"
          />
          <div v-else class="readonly-preview">{{ searchText }}</div>
        </div>
      </div>

      <div class="section-title">最佳匹配</div>

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
          v-for="prompt in candidatePrompts"
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
  padding: 10px 14px;
  box-sizing: border-box;
  background: transparent;
}

.quick-panel {
  width: min(1180px, 100%);
  display: flex;
  flex-direction: column;
  gap: 12px;
}

.search-strip {
  display: flex;
  align-items: center;
  gap: 12px;
  min-height: 64px;
  background: rgba(255, 255, 255, 0.92);
  border-radius: 16px;
  padding: 10px 14px;
  box-shadow: 0 16px 40px rgba(0, 0, 0, 0.12);
}

html.dark .search-strip {
  background: rgba(30, 30, 34, 0.94);
}

.left-preview {
  width: 52px;
  height: 52px;
  border-radius: 12px;
  overflow: hidden;
  flex-shrink: 0;
  background: rgba(0, 0, 0, 0.05);
  display: flex;
  align-items: center;
  justify-content: center;
}

html.dark .left-preview {
  background: rgba(255, 255, 255, 0.08);
}

.image-preview img {
  width: 100%;
  height: 100%;
  object-fit: cover;
}

.file-preview {
  color: #555561;
  font-size: 12px;
  font-weight: 700;
}

html.dark .file-preview {
  color: #f1f1f5;
}

.search-content {
  flex: 1;
  min-width: 0;
}

.search-input {
  width: 100%;
  height: 42px;
  border: none;
  outline: none;
  resize: none;
  overflow: hidden;
  background: transparent;
  font-size: 24px;
  line-height: 42px;
  color: #18181b;
  font-family: inherit;
  padding: 0;
}

html.dark .search-input {
  color: #f5f5f7;
}

.search-input::placeholder {
  color: #9a9aa3;
}

.readonly-preview {
  display: -webkit-box;
  -webkit-box-orient: vertical;
  -webkit-line-clamp: 2;
  overflow: hidden;
  white-space: pre-wrap;
  word-break: break-word;
  font-size: 18px;
  line-height: 1.4;
  color: #18181b;
}

html.dark .readonly-preview {
  color: #f5f5f7;
}

.section-title {
  font-size: 15px;
  font-weight: 700;
  color: #202028;
}

html.dark .section-title { color: #f1f1f5; }

.restore-zone {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
}

.restore-chip {
  border: none;
  border-radius: 999px;
  padding: 8px 12px;
  background: rgba(255, 255, 255, 0.9);
  color: #4e4e59;
  cursor: pointer;
}

html.dark .restore-chip {
  background: rgba(255, 255, 255, 0.08);
  color: #ececf0;
}

.grid-wrap {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(92px, 1fr));
  gap: 14px 12px;
}

.prompt-tile {
  border: none;
  background: transparent;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 8px;
  padding: 8px 4px;
  border-radius: 12px;
  cursor: pointer;
  transition: transform 0.18s ease, background 0.18s ease;
}

.prompt-tile:hover,
.prompt-tile.active {
  background: rgba(0, 0, 0, 0.05);
  transform: translateY(-1px);
}

html.dark .prompt-tile:hover,
html.dark .prompt-tile.active {
  background: rgba(255, 255, 255, 0.06);
}

.tile-icon-wrap {
  width: 58px;
  height: 58px;
  border-radius: 14px;
  overflow: hidden;
  background: rgba(255, 255, 255, 0.92);
  display: flex;
  align-items: center;
  justify-content: center;
}

html.dark .tile-icon-wrap {
  background: rgba(255, 255, 255, 0.08);
}

.tile-icon {
  width: 100%;
  height: 100%;
  object-fit: cover;
}

.tile-fallback {
  font-size: 22px;
  font-weight: 700;
  color: #565666;
}

html.dark .tile-fallback { color: #f2f2f6; }

.tile-name {
  font-size: 13px;
  line-height: 1.35;
  text-align: center;
  color: #2d2d36;
  word-break: break-word;
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
  overflow: hidden;
}

html.dark .tile-name { color: #f2f2f6; }

@media (max-width: 900px) {
  .quick-panel { width: 100%; }
  .search-input { font-size: 20px; }
}
</style>
