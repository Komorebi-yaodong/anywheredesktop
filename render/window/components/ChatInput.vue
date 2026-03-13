<script setup>
import { computed, nextTick, ref } from 'vue'
import { ElButton, ElFooter, ElInput, ElTag, ElTooltip } from 'element-plus'

const prompt = defineModel('prompt', { type: String, default: '' })
const fileList = defineModel('fileList', { type: Array, default: () => [] })
const selectedVoice = defineModel('selectedVoice', { type: String, default: '' })
const tempReasoningEffort = defineModel('tempReasoningEffort', { type: String, default: 'default' })

const props = defineProps({
  loading: Boolean,
  ctrlEnterToSend: Boolean,
  voiceList: { type: Array, default: () => [] },
  layout: { type: String, default: 'horizontal' },
  isMcpActive: Boolean,
  allMcpServers: { type: Array, default: () => [] },
  activeMcpIds: { type: Array, default: () => [] },
  activeSkillIds: { type: Array, default: () => [] },
  allSkills: { type: Array, default: () => [] }
})

const emit = defineEmits([
  'submit',
  'cancel',
  'clear-history',
  'remove-file',
  'upload',
  'send-audio',
  'open-mcp-dialog',
  'pick-file-start',
  'toggle-mcp',
  'toggle-skill',
  'open-skill-dialog'
])

const fileInputRef = ref(null)

const quickMcpList = computed(() =>
  props.allMcpServers
    .filter((server) => server?.isActive !== false)
    .slice(0, 6)
)
const quickSkillList = computed(() => props.allSkills.filter((skill) => skill?.name).slice(0, 6))

const canSubmit = computed(() => {
  const hasPrompt = Boolean(prompt.value?.trim())
  const hasFiles = Array.isArray(fileList.value) && fileList.value.length > 0
  return !props.loading && (hasPrompt || hasFiles)
})

const triggerFileUpload = () => {
  emit('pick-file-start')
  nextTick(() => {
    fileInputRef.value?.click()
  })
}

const handleFileChange = (event) => {
  const files = Array.from(event.target?.files || [])
  if (files.length > 0) {
    emit('upload', { file: files[0], fileList: files })
  }

  if (fileInputRef.value) {
    fileInputRef.value.value = ''
  }
}

const handleTextareaKeydown = (event) => {
  if (event.isComposing || event.key !== 'Enter') return

  const hasModifier = event.ctrlKey || event.metaKey

  if (props.ctrlEnterToSend) {
    if (!hasModifier) return
    event.preventDefault()
    if (canSubmit.value) emit('submit')
    return
  }

  if (event.shiftKey || hasModifier) return

  event.preventDefault()
  if (canSubmit.value) emit('submit')
}

const handleRemoveFile = (index) => {
  emit('remove-file', index)
}

const toggleMcp = (serverId) => {
  emit('toggle-mcp', serverId)
}

const toggleSkill = (skillName) => {
  emit('toggle-skill', skillName)
}

const selectReasoning = (value) => {
  tempReasoningEffort.value = value
}

const selectVoice = (value) => {
  selectedVoice.value = value
}

const resolveFileName = (file) => {
  if (!file) return 'unknown-file'
  if (typeof file === 'string') return file
  return file.name || file.fileName || 'unknown-file'
}

const isMcpActiveById = (id) => Array.isArray(props.activeMcpIds) && props.activeMcpIds.includes(id)
const isSkillActiveById = (id) => Array.isArray(props.activeSkillIds) && props.activeSkillIds.includes(id)
</script>

<template>
  <el-footer class="chat-input-shell" :class="[`layout-${layout}`]">
    <div class="top-row">
      <div class="quick-tags">
        <el-tooltip content="打开 MCP 管理面板" placement="top" :show-after="300">
          <el-button class="compact-btn" size="small" @click="emit('open-mcp-dialog')">MCP</el-button>
        </el-tooltip>

        <el-tag
          v-for="server in quickMcpList"
          :key="server.id"
          size="small"
          class="quick-tag"
          :effect="isMcpActiveById(server.id) ? 'dark' : 'plain'"
          @click="toggleMcp(server.id)"
        >
          @{{ server.name || server.id }}
        </el-tag>

        <el-tag
          v-for="skill in quickSkillList"
          :key="skill.id || skill.name"
          size="small"
          class="quick-tag"
          type="success"
          :effect="isSkillActiveById(skill.id || skill.name) ? 'dark' : 'plain'"
          @click="toggleSkill(skill.name)"
        >
          /{{ skill.name }}
        </el-tag>
      </div>

      <div class="quick-controls">
        <div class="option-group">
          <span class="group-title">思考</span>
          <el-button size="small" text @click="selectReasoning('low')">低</el-button>
          <el-button size="small" text @click="selectReasoning('medium')">中</el-button>
          <el-button size="small" text @click="selectReasoning('high')">高</el-button>
        </div>

        <div class="option-group" v-if="voiceList.length > 0">
          <span class="group-title">语音</span>
          <el-button
            v-for="voice in voiceList.slice(0, 3)"
            :key="voice"
            size="small"
            text
            @click="selectVoice(voice)"
          >
            {{ voice }}
          </el-button>
        </div>
      </div>
    </div>

    <div v-if="fileList.length > 0" class="file-list">
      <div v-for="(file, index) in fileList" :key="`${resolveFileName(file)}-${index}`" class="file-item">
        <span class="file-name">{{ resolveFileName(file) }}</span>
        <button class="remove-btn" type="button" @click="handleRemoveFile(index)">移除</button>
      </div>
    </div>

    <div class="input-row">
      <input ref="fileInputRef" class="hidden-file-input" type="file" multiple @change="handleFileChange" />

      <el-button class="compact-btn" @click="triggerFileUpload">附件</el-button>

      <el-input
        v-model="prompt"
        class="prompt-input"
        type="textarea"
        :rows="2"
        resize="none"
        placeholder="输入消息，Enter 发送，Shift+Enter 换行"
        @keydown="handleTextareaKeydown"
      />

      <el-button type="primary" :disabled="!canSubmit" @click="emit('submit')">发送</el-button>
    </div>

    <div class="bottom-row">
      <span class="status-text">Reasoning: {{ tempReasoningEffort || 'default' }}</span>
      <span class="status-text">Voice: {{ selectedVoice || 'default' }}</span>
      <span class="status-text">MCP: {{ props.isMcpActive ? 'ON' : 'OFF' }}</span>

      <div class="actions">
        <el-button text @click="emit('open-skill-dialog')">Skills</el-button>
        <el-button text @click="emit('send-audio')">语音</el-button>
        <el-button text @click="emit('clear-history')">清空</el-button>
        <el-button text :disabled="!loading" @click="emit('cancel')">停止</el-button>
      </div>
    </div>
  </el-footer>
</template>

<style scoped>
.chat-input-shell {
  border-top: 1px solid var(--el-border-color);
  background: var(--el-bg-color);
  padding: 10px 12px;
  display: flex;
  flex-direction: column;
  gap: 10px;
  height: auto;
}

.top-row,
.bottom-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
}

.quick-tags {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 6px;
}

.quick-controls {
  display: flex;
  align-items: center;
  gap: 12px;
}

.option-group {
  display: flex;
  align-items: center;
  gap: 4px;
}

.group-title {
  font-size: 12px;
  color: var(--el-text-color-secondary);
}

.input-row {
  display: flex;
  align-items: flex-end;
  gap: 8px;
}

.prompt-input {
  flex: 1;
}

.compact-btn {
  flex-shrink: 0;
}

.hidden-file-input {
  display: none;
}

.file-list {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
}

.file-item {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  border: 1px solid var(--el-border-color);
  background: var(--el-fill-color-blank);
  border-radius: 8px;
  padding: 4px 8px;
}

.file-name {
  max-width: 220px;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  font-size: 12px;
}

.remove-btn {
  border: none;
  background: transparent;
  color: var(--el-color-danger);
  cursor: pointer;
  font-size: 12px;
  padding: 0;
}

.actions {
  display: inline-flex;
  align-items: center;
  gap: 2px;
}

.status-text {
  font-size: 12px;
  color: var(--el-text-color-secondary);
}

.layout-vertical .input-row {
  flex-direction: column;
  align-items: stretch;
}
</style>
