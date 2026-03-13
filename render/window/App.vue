<script setup>
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import { ElMessage } from 'element-plus'
import TitleBar from './components/TitleBar.vue'
import ChatHeader from './components/ChatHeader.vue'
import ChatInput from './components/ChatInput.vue'

const initialContext = window.api?.getWindowContext ? window.api.getWindowContext() : {}
const senderId = ref(initialContext.senderId || 'unknown')

const windowState = ref({
  isAlwaysOnTop: false,
  autoCloseOnBlur: false,
  isDarkMode: false,
  os: 'win',
  voiceList: []
})

const model = ref('')
const modelMap = ref({})
const systemPrompt = ref('')
const isMcpLoading = ref(false)
const prompt = ref('')
const fileList = ref([])
const selectedVoice = ref('')
const tempReasoningEffort = ref('default')

const loading = ref(false)
const ctrlEnterToSend = ref(false)
const inputLayout = ref('horizontal')
const isMcpActive = ref(true)
const allMcpServers = ref([])
const activeMcpIds = ref([])
const activeSkillIds = ref([])
const allSkills = ref([])


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
  ElMessage.info('模型选择弹窗将在 C.2 聊天链路接入时完成')
}

const handleShowSystemPrompt = () => {
  ElMessage.info('系统提示词编辑将在 C.2 聊天链路接入时完成')
}

const handleOpenSearch = () => {
  ElMessage.info('搜索 UI 将在 C.2 聊天链路接入时完成')
}

const resolveFileName = (file) => {
  if (!file) return 'unknown-file'
  if (typeof file === 'string') return file
  return file.name || file.fileName || 'unknown-file'
}

const handleSubmit = () => {
  if (loading.value) return
  const hasPrompt = Boolean(prompt.value?.trim())
  const hasFiles = fileList.value.length > 0

  if (!hasPrompt && !hasFiles) {
    ElMessage.warning('请输入消息或选择文件后再发送')
    return
  }

  ElMessage.success('发送逻辑将在 C.2 聊天链路接入时完成')
}

const handleCancel = () => {
  loading.value = false
}

const handleClearHistory = () => {
  ElMessage.info('清空历史逻辑将在 C.2 对接')
}

const handleRemoveFile = (index) => {
  if (typeof index !== 'number') return
  fileList.value.splice(index, 1)
}

const detectOs = async () => {
  try {
    const result = await window.api?.getCurrentTime?.()
    if (result?.ok && typeof result.platform === 'string') {
      const platform = result.platform.toLowerCase()
      if (platform.includes('darwin') || platform.includes('mac')) {
        windowState.value.os = 'macos'
        return
      }
      if (platform.includes('linux')) {
        windowState.value.os = 'linux'
        return
      }
    }
  } catch {
    // fallback below
  }

  if (navigator.userAgent.includes('Mac')) {
    windowState.value.os = 'macos'
  } else if (navigator.userAgent.includes('Linux')) {
    windowState.value.os = 'linux'
  } else {
    windowState.value.os = 'win'
  }
}


const normalizePickedFiles = async (files = []) => {
  const normalized = []

  for (const raw of files) {
    const name = raw?.name || ''
    const path = raw?.path || raw?.filePath || ''

    if (!name && !path) continue

    if (window.api?.isFileTypeSupported && name) {
      try {
        const support = await window.api.isFileTypeSupported(name)
        if (support?.ok === false || support?.supported === false) {
          continue
        }
      } catch {
        // ignore support check errors, fallback to optimistic include
      }
    }

    normalized.push({
      name: name || resolveFileName(raw),
      path
    })
  }

  return normalized
}

const handleUpload = async (payload = {}) => {
  const pickedFiles = Array.isArray(payload.fileList)
    ? payload.fileList
    : payload.file
      ? [payload.file]
      : []

  const normalized = await normalizePickedFiles(pickedFiles)
  if (normalized.length === 0) {
    ElMessage.warning('未识别到可用文件')
    return
  }

  fileList.value = [...fileList.value, ...normalized]
}

const handlePickFileStart = async () => {
  try {
    if (!window.api?.showOpenDialog) return

    const result = await window.api.showOpenDialog({
      properties: ['openFile', 'multiSelections']
    })

    if (!result?.ok || result.canceled || !Array.isArray(result.filePaths)) {
      return
    }

    const files = result.filePaths.map((filePath) => ({
      name: filePath.split(/[/\\]/).pop() || filePath,
      path: filePath
    }))

    const normalized = await normalizePickedFiles(files)
    if (normalized.length > 0) {
      fileList.value = [...fileList.value, ...normalized]
    }
  } catch (error) {
    ElMessage.error(error?.message || '选择文件失败')
  }
}

const handleSendAudio = () => {
  ElMessage.info('语音发送链路将在后续子任务接入')
}

const handleOpenMcpDialog = () => {
  ElMessage.info('MCP 选择面板将在后续子任务接入')
}

const toArray = (value) => (Array.isArray(value) ? value : [])


const initQuickOptions = async () => {
  try {
    const result = await window.api?.getConfig?.()
    const config = result?.ok ? (result.config || {}) : {}

    const servers = toArray(config.mcpServers)
    allMcpServers.value = servers

    activeMcpIds.value = servers
      .filter((server) => server?.isActive !== false)
      .map((server) => server.id)
      .filter(Boolean)

    const skills = toArray(config.skills)
    allSkills.value = skills.map((skill) => ({
      id: skill.id || skill.name,
      name: skill.name || skill.id
    }))

    activeSkillIds.value = allSkills.value.slice(0, 3).map((skill) => skill.id || skill.name).filter(Boolean)

    const modelList = toArray(config.modelList)
    const firstModel = modelList[0]
    if (firstModel?.value) {
      model.value = firstModel.value
    } else if (typeof config.model === 'string') {
      model.value = config.model
    }

    const modelEntries = modelList
      .map((item) => [item?.value, item?.name || item?.value])
      .filter(([key]) => Boolean(key))

    modelMap.value = Object.fromEntries(modelEntries)

    systemPrompt.value = typeof config.systemPrompt === 'string' ? config.systemPrompt : ''

    ctrlEnterToSend.value = Boolean(config.CtrlEnterToSend)
    inputLayout.value = typeof config.inputLayout === 'string' ? config.inputLayout : 'horizontal'

    const voices = Array.isArray(config.voiceList) ? config.voiceList.filter((item) => typeof item === 'string') : []
    if (voices.length > 0) {
      selectedVoice.value = voices[0]
    }

    isMcpActive.value = activeMcpIds.value.length > 0
  } catch {
    allMcpServers.value = []
    allSkills.value = []
    activeMcpIds.value = []
    activeSkillIds.value = []
    isMcpActive.value = false
  }
}

const handleQuickMcpToggle = (serverId) => {
  if (!serverId) return
  if (activeMcpIds.value.includes(serverId)) {
    activeMcpIds.value = activeMcpIds.value.filter((id) => id !== serverId)
  } else {
    activeMcpIds.value = [...activeMcpIds.value, serverId]
  }

  isMcpActive.value = activeMcpIds.value.length > 0
}

const handleQuickSkillToggle = (skillName) => {
  if (!skillName) return
  if (activeSkillIds.value.includes(skillName)) {
    activeSkillIds.value = activeSkillIds.value.filter((id) => id !== skillName)
  } else {
    activeSkillIds.value = [...activeSkillIds.value, skillName]
  }
}

const toggleSkillDialog = () => {
  ElMessage.info('Skill 面板将在后续子任务接入')
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
  await initQuickOptions()

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
      <div class="chat-placeholder">
        <div class="chat-message ai">你好，我是 Anywhere Desktop 窗口端占位会话。</div>
        <div class="chat-message user" v-if="prompt.trim()">{{ prompt }}</div>
      </div>
    </main>

    <ChatInput
      v-model:prompt="prompt"
      v-model:file-list="fileList"
      v-model:selected-voice="selectedVoice"
      v-model:temp-reasoning-effort="tempReasoningEffort"
      :loading="loading"
      :ctrl-enter-to-send="ctrlEnterToSend"
      :voice-list="windowState.voiceList"
      :layout="inputLayout"
      :is-mcp-active="isMcpActive"
      :all-mcp-servers="allMcpServers"
      :active-mcp-ids="activeMcpIds"
      :active-skill-ids="activeSkillIds"
      :all-skills="allSkills"
      @submit="handleSubmit"
      @cancel="handleCancel"
      @clear-history="handleClearHistory"
      @remove-file="handleRemoveFile"
      @upload="handleUpload"
      @send-audio="handleSendAudio"
      @open-mcp-dialog="handleOpenMcpDialog"
      @pick-file-start="handlePickFileStart"
      @toggle-mcp="handleQuickMcpToggle"
      @toggle-skill="handleQuickSkillToggle"
      @open-skill-dialog="toggleSkillDialog"
    />
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
  align-items: stretch;
  justify-content: center;
  padding: 16px;
  overflow: auto;
}

.chat-placeholder {
  width: min(860px, 100%);
  display: flex;
  flex-direction: column;
  gap: 10px;
}

.chat-message {
  max-width: 78%;
  border-radius: 12px;
  padding: 10px 12px;
  line-height: 1.5;
  border: 1px solid var(--el-border-color);
  background: var(--el-bg-color);
}

.chat-message.ai {
  align-self: flex-start;
}

.chat-message.user {
  align-self: flex-end;
  background: var(--el-fill-color);
}
</style>
