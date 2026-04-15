<script setup>
import { ref, onMounted, onBeforeUnmount, computed, inject, h, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { Upload, UploadFilled, FolderOpened, Refresh, Delete as DeleteIcon, Download, Plus, ArrowRight, Check, Warning, Remove, Edit } from '@element-plus/icons-vue'
import { ElMessage, ElMessageBox, ElInput } from 'element-plus'
import { reactive, nextTick } from 'vue'
import draggable from 'vuedraggable'

const { t, locale } = useI18n()

const currentConfig = inject('config');
const selectedLanguage = ref(locale.value);

const collapsedCards = ref({
  general: false,
  desktop: false,
  voice: false,
  data: false,
  webdav: false
});

const cardDefinitions = {
  general: { id: 'general', titleKey: 'setting.title' },
  desktop: { id: 'desktop', titleKey: 'setting.desktop.title' },
  voice: { id: 'voice', titleKey: 'setting.voice.title' },
  data: { id: 'data', titleKey: 'setting.dataManagement.title' },
  webdav: { id: 'webdav', titleKey: null, staticTitle: 'WebDAV' }
};

const settingsCards = ref([]);
const shortcutRecorder = ref({
  target: '',
  index: -1,
  active: false
});

function stopShortcutRecording() {
  shortcutRecorder.value = { target: '', index: -1, active: false }
}

const DISPLAY_SHORTCUT_KEY_BY_CODE = {
  Backquote: '`',
  Minus: '-',
  Equal: '=',
  BracketLeft: '[',
  BracketRight: ']',
  Backslash: '\\',
  Semicolon: ';',
  Quote: "'",
  Comma: ',',
  Period: '.',
  Slash: '/',
  Space: 'Space',
  Tab: 'Tab',
  Enter: 'Enter',
  Escape: 'Escape',
  ArrowUp: 'Up',
  ArrowDown: 'Down',
  ArrowLeft: 'Left',
  ArrowRight: 'Right',
  Delete: 'Delete',
  Insert: 'Insert',
  Home: 'Home',
  End: 'End',
  PageUp: 'PageUp',
  PageDown: 'PageDown'
}

const DISPLAY_SHORTCUT_ALIASES = {
  backquote: '`',
  minus: '-',
  equal: '=',
  bracketleft: '[',
  bracketright: ']',
  backslash: '\\',
  semicolon: ';',
  quote: "'",
  comma: ',',
  period: '.',
  slash: '/',
  space: 'Space',
  enter: 'Enter',
  return: 'Enter',
  esc: 'Escape',
  escape: 'Escape',
  tab: 'Tab',
  up: 'Up',
  down: 'Down',
  left: 'Left',
  right: 'Right',
  delete: 'Delete',
  del: 'Delete',
  insert: 'Insert',
  ins: 'Insert',
  home: 'Home',
  end: 'End',
  pageup: 'PageUp',
  pagedown: 'PageDown'
}

function normalizeShortcutDisplayToken(value = '') {
  const trimmed = String(value || '').trim()
  if (!trimmed) return ''
  if (/^[a-zA-Z]$/.test(trimmed)) return trimmed.toUpperCase()
  if (/^[0-9]$/.test(trimmed)) return trimmed
  if (/^F([1-9]|1[0-9]|2[0-4])$/i.test(trimmed)) return trimmed.toUpperCase()
  return DISPLAY_SHORTCUT_ALIASES[trimmed.toLowerCase()] || trimmed
}

function toDisplayShortcut(value = '') {
  const tokens = String(value || '').split('+').map((item) => item.trim()).filter(Boolean)
  if (!tokens.length) return ''
  return tokens.map((token) => {
    const modifier = normalizeModifierToken(token)
    if (modifier) return modifier
    return normalizeShortcutDisplayToken(token)
  }).filter(Boolean).join('+')
}

function normalizeRecordedAccelerator(event) {
  const modifiers = []
  if (event.ctrlKey || event.metaKey) modifiers.push('Ctrl')
  if (event.altKey) modifiers.push('Alt')
  if (event.shiftKey) modifiers.push('Shift')

  const rawKey = String(event.key || '').trim()
  if (!rawKey || ['Control', 'Shift', 'Alt', 'Meta'].includes(rawKey)) {
    return ''
  }

  const code = String(event.code || '').trim()

  let normalizedKey = ''
  if (DISPLAY_SHORTCUT_KEY_BY_CODE[code]) {
    normalizedKey = DISPLAY_SHORTCUT_KEY_BY_CODE[code]
  } else if (/^Key[A-Z]$/.test(code)) {
    normalizedKey = code.slice(3)
  } else if (/^Digit[0-9]$/.test(code)) {
    normalizedKey = code.slice(5)
  } else if (/^F([1-9]|1[0-9]|2[0-4])$/.test(code)) {
    normalizedKey = code
  } else if (rawKey === ' ') {
    normalizedKey = 'Space'
  } else if (rawKey.length === 1) {
    normalizedKey = normalizeShortcutDisplayToken(rawKey)
  } else {
    normalizedKey = normalizeShortcutDisplayToken(rawKey)
  }

  if (!modifiers.length || !normalizedKey) {
    return ''
  }
  return [...modifiers, normalizedKey].join('+')
}

function handleShortcutRecorderKeydown(event) {
  if (!shortcutRecorder.value.active) return
  event.preventDefault()
  event.stopPropagation()

  if (event.key === 'Escape') {
    stopShortcutRecording()
    return
  }

  const accelerator = normalizeRecordedAccelerator(event)
  if (!accelerator) return

  ensureDesktopConfig()
  if (shortcutRecorder.value.target === 'mainToggle') {
    currentConfig.value.desktop.shortcuts.mainToggle = accelerator
  } else if (shortcutRecorder.value.target === 'quickSummon') {
    currentConfig.value.desktop.shortcuts.quickSummon = accelerator
  } else if (shortcutRecorder.value.target === 'appendFollowUp') {
    currentConfig.value.desktop.shortcuts.appendFollowUp = accelerator
  } else if (shortcutRecorder.value.target === 'promptBinding' && shortcutRecorder.value.index > -1) {
    currentConfig.value.desktop.shortcuts.promptBindings[shortcutRecorder.value.index].accelerator = accelerator
  }

  stopShortcutRecording()
  handleDesktopShortcutChange()
}

function startShortcutRecording(target, index = -1) {
  shortcutRecorder.value = { target, index, active: true }
}


function initCardOrder() {
  if (currentConfig.value && currentConfig.value.settingsCardOrder) {
    const order = currentConfig.value.settingsCardOrder;
    settingsCards.value = order
      .map(id => cardDefinitions[id])
      .filter(Boolean); 
    
    const missingIds = Object.keys(cardDefinitions).filter(id => !order.includes(id));
    missingIds.forEach(id => settingsCards.value.push(cardDefinitions[id]));
  } else {
    settingsCards.value = [
      cardDefinitions.general,
      cardDefinitions.desktop,
      cardDefinitions.voice,
      cardDefinitions.data,
      cardDefinitions.webdav
    ];
  }
  
  if (currentConfig.value && currentConfig.value.settingsCardCollapsed) {
    collapsedCards.value = {
      ...collapsedCards.value,
      ...currentConfig.value.settingsCardCollapsed
    };
  }
}

const onOrderChange = async () => {
  const newOrder = settingsCards.value.map(card => card.id);
  currentConfig.value.settingsCardOrder = newOrder;
  await saveSingleSetting('settingsCardOrder', newOrder);
};

function toggleCard(cardName) {
  collapsedCards.value[cardName] = !collapsedCards.value[cardName];
  
  if (currentConfig.value) {
    const plainState = JSON.parse(JSON.stringify(collapsedCards.value));
    
    currentConfig.value.settingsCardCollapsed = plainState;
    saveSingleSetting('settingsCardCollapsed', plainState);
  }
}

const isBackupManagerVisible = ref(false);
const backupFiles = ref([]);
const isTableLoading = ref(false);
const selectedFiles = ref([]);
const currentPage = ref(1);
const pageSize = ref(10);

const paginatedFiles = computed(() => {
  const start = (currentPage.value - 1) * pageSize.value;
  const end = start + pageSize.value;
  return backupFiles.value.slice(start, end);
});

const formatDate = (dateString) => {
  if (!dateString) return 'N/A';
  const date = new Date(dateString);
  return date.toLocaleString();
};

const formatBytes = (bytes, decimals = 2) => {
  if (bytes === 0) return '0 Bytes';
  const k = 1024;
  const dm = decimals < 0 ? 0 : decimals;
  const sizes = ['Bytes', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(dm)) + ' ' + sizes[i];
};


function getErrorMessage(error, fallback = 'unknown_error') {
  if (!error) return fallback;
  if (typeof error === 'string') return error;
  if (typeof error?.message === 'string' && error.message) return error.message;
  if (typeof error?.reason === 'string' && error.reason) return error.reason;
  if (typeof error?.error === 'string' && error.error) return error.error;
  if (error?.error && typeof error.error === 'object') {
    return getErrorMessage(error.error, fallback);
  }
  return fallback;
}


function resolveWebdavBackupConfig() {
  const webdav = currentConfig.value?.webdav || {};
  const path = String(webdav.path || '/anywhere').trim();
  return {
    url: String(webdav.url || '').trim(),
    username: String(webdav.username || ''),
    password: String(webdav.password || ''),
    path: path || '/anywhere'
  };
}




function getWebdavConfig() {
  const webdav = currentConfig.value?.webdav || {}
  return {
    url: String(webdav.url || '').trim(),
    username: String(webdav.username || ''),
    password: String(webdav.password || ''),
    path: String(webdav.path || '/anywhere').trim()
  }
}

function buildWebdavInput(extra = {}) {
  return {
    webdavConfig: resolveWebdavBackupConfig(),
    ...extra
  }
}


onMounted(() => {
  window.addEventListener('keydown', handleShortcutRecorderKeydown, true)
  if (['ja', 'ru'].includes(locale.value)) {
    handleLanguageChange('zh');
  } else {
    selectedLanguage.value = locale.value;
  }
  
  if (currentConfig.value) {
    ensureDesktopConfig();
    ensureDesktopProfileConfig();
    initCardOrder();
  }
});

watch(() => currentConfig.value, (newVal) => {
  if (newVal) {
    ensureDesktopConfig();
    ensureDesktopProfileConfig();
    initCardOrder();
  }
}, { once: true });


onBeforeUnmount(() => {
  window.removeEventListener('keydown', handleShortcutRecorderKeydown, true)
})


async function saveSingleSetting(keyPath, value) {
  try {
    if (window.api && window.api.saveSetting) {
      await window.api.saveSetting(keyPath, value);
    }
  } catch (error) {
    console.error(`Error saving setting for ${keyPath}:`, error);
    ElMessage.error(`${t('setting.alerts.saveFailedPrefix')} ${keyPath}`);
  }
}

const DEFAULT_USER_NICKNAME = 'User'
const USER_NICKNAME_MAX_LENGTH = 12
const showAvatarEditDialog = ref(false)
const avatarEditorState = reactive({
  imgUrl: '',
  scale: 1,
  radius: 50,
  offsetX: 0,
  offsetY: 0
})
const avatarEditorCanvasRef = ref(null)
let avatarEditorImageObj = null
let isDraggingAvatarImage = false
let avatarLastMouseX = 0
let avatarLastMouseY = 0

function normalizeDesktopNickname(value = '') {
  const raw = typeof value === 'string' ? value : String(value || '')
  const trimmed = raw.trim()
  return trimmed.slice(0, USER_NICKNAME_MAX_LENGTH)
}

function ensureDesktopProfileConfig() {
  ensureDesktopConfig()
  if (!currentConfig.value.desktop.profile || typeof currentConfig.value.desktop.profile !== 'object') {
    currentConfig.value.desktop.profile = {
      nickname: DEFAULT_USER_NICKNAME,
      avatar: ''
    }
  }

  if (typeof currentConfig.value.desktop.profile.nickname !== 'string') {
    currentConfig.value.desktop.profile.nickname = DEFAULT_USER_NICKNAME
  }
  currentConfig.value.desktop.profile.nickname = normalizeDesktopNickname(currentConfig.value.desktop.profile.nickname) || DEFAULT_USER_NICKNAME

  if (typeof currentConfig.value.desktop.profile.avatar !== 'string') {
    currentConfig.value.desktop.profile.avatar = ''
  }
}

async function saveDesktopProfileConfig() {
  ensureDesktopProfileConfig()
  const normalizedNickname = normalizeDesktopNickname(currentConfig.value.desktop.profile.nickname)
  if (!normalizedNickname) {
    currentConfig.value.desktop.profile.nickname = DEFAULT_USER_NICKNAME
  } else {
    currentConfig.value.desktop.profile.nickname = normalizedNickname
  }

  await saveSingleSetting('desktop.profile', JSON.parse(JSON.stringify(currentConfig.value.desktop.profile)))
  ElMessage.success(t('setting.alerts.saveSuccess'))
}

async function handleDesktopNicknameBlur() {
  await saveDesktopProfileConfig()
}

function processProfileAvatarFile(file) {
  const isImage = file?.type?.startsWith('image/')
  if (!isImage) {
    ElMessage.error('头像仅支持 JPG、PNG、WEBP 等图片格式')
    return
  }

  const reader = new FileReader()
  reader.onload = (e) => {
    openProfileAvatarEditor(e.target?.result || '')
  }
  reader.readAsDataURL(file)
}

function openProfileAvatarEditor(dataUrl) {
  if (!dataUrl) return
  avatarEditorState.imgUrl = dataUrl
  avatarEditorState.scale = 1
  avatarEditorState.radius = 50
  avatarEditorState.offsetX = 0
  avatarEditorState.offsetY = 0

  avatarEditorImageObj = new Image()
  avatarEditorImageObj.onload = () => {
    showAvatarEditDialog.value = true
    nextTick(() => drawProfileAvatarCanvas())
  }
  avatarEditorImageObj.src = dataUrl
}

function drawProfileAvatarCanvas() {
  const canvas = avatarEditorCanvasRef.value
  if (!canvas || !avatarEditorImageObj) return
  const ctx = canvas.getContext('2d')
  const size = 256

  ctx.clearRect(0, 0, size, size)
  ctx.save()
  ctx.beginPath()
  const r = (avatarEditorState.radius / 100) * size
  ctx.roundRect(0, 0, size, size, r)
  ctx.clip()

  const imgAspect = avatarEditorImageObj.width / avatarEditorImageObj.height
  let drawW = size * avatarEditorState.scale
  let drawH = size * avatarEditorState.scale

  if (imgAspect > 1) {
    drawH = size * avatarEditorState.scale
    drawW = drawH * imgAspect
  } else {
    drawW = size * avatarEditorState.scale
    drawH = drawW / imgAspect
  }

  const x = (size - drawW) / 2 + avatarEditorState.offsetX
  const y = (size - drawH) / 2 + avatarEditorState.offsetY
  ctx.drawImage(avatarEditorImageObj, x, y, drawW, drawH)
  ctx.restore()
}

async function saveEditedProfileAvatar() {
  const canvas = avatarEditorCanvasRef.value
  if (!canvas) return
  ensureDesktopProfileConfig()
  currentConfig.value.desktop.profile.avatar = canvas.toDataURL('image/png')
  showAvatarEditDialog.value = false
  await saveDesktopProfileConfig()
}

function handleProfileAvatarUploadChange(file) {
  processProfileAvatarFile(file)
  return false
}

function handleProfileAvatarDrop(event) {
  const file = event.dataTransfer?.files?.[0]
  if (file) processProfileAvatarFile(file)
}

function handleProfileAvatarPaste(event) {
  const items = (event.clipboardData || event.originalEvent?.clipboardData)?.items || []
  for (const item of items) {
    if (item.kind === 'file') {
      const blob = item.getAsFile()
      if (blob) processProfileAvatarFile(blob)
      return
    }
  }
}

function handleProfileAvatarCanvasMouseDown(event) {
  isDraggingAvatarImage = true
  avatarLastMouseX = event.clientX
  avatarLastMouseY = event.clientY
}

function handleProfileAvatarCanvasMouseMove(event) {
  if (!isDraggingAvatarImage) return
  const dx = event.clientX - avatarLastMouseX
  const dy = event.clientY - avatarLastMouseY
  avatarEditorState.offsetX += dx
  avatarEditorState.offsetY += dy
  avatarLastMouseX = event.clientX
  avatarLastMouseY = event.clientY
  drawProfileAvatarCanvas()
}

function handleProfileAvatarCanvasMouseUp() {
  isDraggingAvatarImage = false
}

function handleProfileAvatarCanvasWheel(event) {
  event.preventDefault()
  const delta = event.deltaY > 0 ? -0.1 : 0.1
  let newScale = avatarEditorState.scale + delta
  if (newScale < 0.1) newScale = 0.1
  if (newScale > 5) newScale = 5
  avatarEditorState.scale = newScale
  drawProfileAvatarCanvas()
}

function ensureDesktopConfig() {
  if (!currentConfig.value.desktop || typeof currentConfig.value.desktop !== 'object') {
    currentConfig.value.desktop = {}
  }
  if (typeof currentConfig.value.desktop.closeToTray !== 'boolean') {
    currentConfig.value.desktop.closeToTray = true
  }
  if (!currentConfig.value.desktop.shortcuts || typeof currentConfig.value.desktop.shortcuts !== 'object') {
    currentConfig.value.desktop.shortcuts = {}
  }
  if (!Array.isArray(currentConfig.value.desktop.shortcuts.promptBindings)) {
    currentConfig.value.desktop.shortcuts.promptBindings = []
  }
  if (!currentConfig.value.desktop.shortcuts.mainToggle) {
    currentConfig.value.desktop.shortcuts.mainToggle = 'Ctrl+Space'
  }
  if (!currentConfig.value.desktop.shortcuts.quickSummon) {
    currentConfig.value.desktop.shortcuts.quickSummon = 'Alt+A'
  }
  if (!currentConfig.value.desktop.shortcuts.appendFollowUp) {
    currentConfig.value.desktop.shortcuts.appendFollowUp = 'Alt+S'
  }

  currentConfig.value.desktop.shortcuts.mainToggle = toDisplayShortcut(currentConfig.value.desktop.shortcuts.mainToggle) || 'Ctrl+Space'
  currentConfig.value.desktop.shortcuts.quickSummon = toDisplayShortcut(currentConfig.value.desktop.shortcuts.quickSummon) || 'Alt+A'
  currentConfig.value.desktop.shortcuts.appendFollowUp = toDisplayShortcut(currentConfig.value.desktop.shortcuts.appendFollowUp) || 'Alt+S'
  currentConfig.value.desktop.shortcuts.promptBindings = currentConfig.value.desktop.shortcuts.promptBindings.map((item, index) => ({
    id: item?.id || `binding_${index}`,
    promptKey: item?.promptKey || '',
    enabled: item?.enabled !== false,
    accelerator: toDisplayShortcut(item?.accelerator || '')
  }))
}

function normalizeModifierToken(token = '') {
  const compact = String(token).replace(/\s+/g, '').toLowerCase()
  const modifierMap = {
    ctrl: 'Ctrl',
    control: 'Ctrl',
    cmdorctrl: 'CommandOrControl',
    commandorcontrol: 'CommandOrControl',
    alt: 'Alt',
    option: 'Alt',
    shift: 'Shift',
    cmd: 'Command',
    command: 'Command',
    super: 'Super',
    meta: 'Super'
  }
  return modifierMap[compact] || null
}

function normalizeKeyToken(token = '') {
  const value = String(token || '').trim()
  if (!value) return ''
  if (/^[a-zA-Z]$/.test(value)) return value.toUpperCase()
  if (/^[0-9]$/.test(value)) return value
  if (/^F([1-9]|1[0-9]|2[0-4])$/i.test(value)) return value.toUpperCase()
  const symbolMap = {
    '`': '`',
    '~': '`',
    '-': '-',
    '_': '-',
    '=': '=',
    '+': '=',
    '[': '[',
    '{': '[',
    ']': ']',
    '}': ']',
    '\\': '\\',
    '|': '\\',
    ';': ';',
    ':': ';',
    "'": "'",
    '"': "'",
    ',': ',',
    '<': ',',
    '.': '.',
    '>': '.',
    '/': '/',
    '?': '/'
  }
  if (symbolMap[value]) return symbolMap[value]
  const aliasMap = {
    space: 'Space',
    enter: 'Enter',
    return: 'Enter',
    esc: 'Escape',
    escape: 'Escape',
    tab: 'Tab',
    backquote: '`',
    minus: '-',
    equal: '=',
    bracketleft: '[',
    bracketright: ']',
    backslash: '\\',
    semicolon: ';',
    quote: "'",
    comma: ',',
    period: '.',
    slash: '/',
    up: 'Up',
    down: 'Down',
    left: 'Left',
    right: 'Right',
    delete: 'Delete',
    del: 'Delete',
    insert: 'Insert',
    ins: 'Insert',
    home: 'Home',
    end: 'End',
    pageup: 'PageUp',
    pagedown: 'PageDown'
  }
  return aliasMap[value.toLowerCase()] || value
}

function normalizeShortcutValue(value = '') {
  const tokens = String(value || '').split('+').map((item) => item.trim()).filter(Boolean)
  if (tokens.length < 2) {
    return { ok: false, error: t('setting.desktop.alerts.invalidShortcut') }
  }

  const modifiers = []
  let normalKey = ''
  for (const token of tokens) {
    const modifier = normalizeModifierToken(token)
    if (modifier) {
      if (!modifiers.includes(modifier)) modifiers.push(modifier)
      continue
    }

    if (normalKey) {
      return { ok: false, error: t('setting.desktop.alerts.invalidShortcut') }
    }
    normalKey = normalizeKeyToken(token)
  }

  if (!modifiers.length || !normalKey) {
    return { ok: false, error: t('setting.desktop.alerts.invalidShortcut') }
  }

  return {
    ok: true,
    accelerator: [...modifiers, normalKey].join('+')
  }
}

function validateDesktopShortcutDraft() {
  ensureDesktopConfig()
  const bindings = [
    {
      label: t('setting.desktop.mainToggle.label'),
      accelerator: currentConfig.value.desktop.shortcuts.mainToggle
    },
    {
      label: t('setting.desktop.quickSummon.label'),
      accelerator: currentConfig.value.desktop.shortcuts.quickSummon
    },
    {
      label: '自动追问快捷键',
      accelerator: currentConfig.value.desktop.shortcuts.appendFollowUp
    }
  ]

  currentConfig.value.desktop.shortcuts.promptBindings.forEach((item, index) => {
    if (item?.enabled === false) return
    if (!item?.promptKey) {
      throw new Error(`${t('setting.desktop.promptShortcuts.title')} #${index + 1}：${t('setting.desktop.alerts.promptRequired')}`)
    }
    bindings.push({
      label: item?.promptKey || `${t('setting.desktop.promptShortcuts.title')} #${index + 1}`,
      accelerator: item?.accelerator || ''
    })
  })

  const acceleratorMap = new Map()
  for (const binding of bindings) {
    const normalized = normalizeShortcutValue(binding.accelerator)
    if (!normalized.ok) {
      return normalized
    }
    if (acceleratorMap.has(normalized.accelerator)) {
      return {
        ok: false,
        error: t('setting.desktop.alerts.shortcutConflict', {
          a: binding.label,
          b: acceleratorMap.get(normalized.accelerator),
          shortcut: normalized.accelerator
        })
      }
    }
    acceleratorMap.set(normalized.accelerator, binding.label)
  }

  currentConfig.value.desktop.shortcuts.mainToggle = normalizeShortcutValue(currentConfig.value.desktop.shortcuts.mainToggle).accelerator
  currentConfig.value.desktop.shortcuts.quickSummon = normalizeShortcutValue(currentConfig.value.desktop.shortcuts.quickSummon).accelerator
  currentConfig.value.desktop.shortcuts.appendFollowUp = normalizeShortcutValue(currentConfig.value.desktop.shortcuts.appendFollowUp).accelerator
  currentConfig.value.desktop.shortcuts.promptBindings = currentConfig.value.desktop.shortcuts.promptBindings.map((item) => ({
    id: item.id,
    promptKey: item.promptKey,
    enabled: item.enabled !== false,
    accelerator: normalizeShortcutValue(item.accelerator).accelerator
  }))

  return { ok: true }
}

async function saveDesktopConfig() {
  ensureDesktopConfig()
  let validation
  try {
    validation = validateDesktopShortcutDraft()
  } catch (error) {
    ElMessage.error(getErrorMessage(error, t('setting.alerts.saveFailedPrefix')))
    return false
  }
  if (!validation.ok) {
    ElMessage.error(validation.error)
    return false
  }

  await saveSingleSetting('desktop', JSON.parse(JSON.stringify(currentConfig.value.desktop)))
  ElMessage.success(t('setting.alerts.saveSuccess'))
  return true
}

function addPromptShortcutBinding() {
  ensureDesktopConfig()
  currentConfig.value.desktop.shortcuts.promptBindings.push({
    id: `binding_${Date.now()}`,
    promptKey: '',
    accelerator: 'Alt+1',
    enabled: true
  })
}

async function removePromptShortcutBinding(index) {
  ensureDesktopConfig()
  currentConfig.value.desktop.shortcuts.promptBindings.splice(index, 1)
  await saveDesktopConfig()
}

async function handleDesktopShortcutChange() {
  await saveDesktopConfig()
}

const availableWindowPrompts = computed(() => {
  const prompts = currentConfig.value?.prompts || {}
  return Object.entries(prompts)
    .filter(([, prompt]) => prompt?.enable !== false)
    .map(([key, prompt]) => ({ key, ...prompt }))
    .sort((a, b) => a.key.localeCompare(b.key))
})


async function saveFullConfig() {
  if (!currentConfig.value) return;
  try {
    const configToSave = { config: JSON.parse(JSON.stringify(currentConfig.value)) };
    if (window.api && window.api.updateConfigWithoutFeatures) {
      await window.api.updateConfigWithoutFeatures(configToSave);
    }
  } catch (error) {
    console.error("Error saving settings config:", error);
  }
}

function handleLanguageChange(lang) {
  locale.value = lang;
  localStorage.setItem('language', lang);
  selectedLanguage.value = lang;
}

async function handleGlobalToggleChange(key, value) {
  if (!currentConfig.value || !currentConfig.value.prompts) return;

  if (key === 'isAlwaysOnTop') {
    currentConfig.value.isAlwaysOnTop_global = value;
  } else if (key === 'autoCloseOnBlur') {
    currentConfig.value.autoCloseOnBlur_global = value;
  } else if (key === 'autoSaveChat') {
    currentConfig.value.autoSaveChat_global = value;
  }

  Object.keys(currentConfig.value.prompts).forEach(promptKey => {
    const prompt = currentConfig.value.prompts[promptKey];
    if (prompt) {
      prompt[key] = value;
    }
  });

  await saveFullConfig();
  ElMessage.success(t('setting.alerts.saveSuccess'));
}

async function exportConfig() {
  if (!currentConfig.value) return;
  try {
    const configToExport = JSON.parse(JSON.stringify(currentConfig.value));

    if (configToExport.webdav && configToExport.webdav.localChatPath) {
      delete configToExport.webdav.localChatPath;
    }

    if (configToExport.skillPath !== undefined) {
      delete configToExport.skillPath;
    }

    if (window.api && window.api.exportMemoryData) {
      const memories = await window.api.exportMemoryData();
      if (memories && memories.length > 0) {
        configToExport.memories = memories;
      }
    }

    const saveResult = await window.api?.showSaveDialog?.({
      title: t('setting.dataManagement.exportButton'),
      defaultPath: 'Anywhere_config.json',
      filters: [{ name: 'JSON', extensions: ['json'] }]
    });

    if (!saveResult || saveResult.canceled || !saveResult.filePath) {
      return;
    }

    const jsonString = JSON.stringify(configToExport, null, 2);
    const writeResult = await window.api?.writeLocalFile?.(saveResult.filePath, jsonString, {
      encoding: 'utf8'
    });

    if (writeResult?.ok === false) {
      throw new Error(getErrorMessage(writeResult, 'write config file failed'));
    }

    ElMessage.success(t('setting.alerts.exportSuccess'));
  } catch (error) {
    console.error("Error exporting config:", error);
    ElMessage.error(t('setting.alerts.exportFailed'));
  }
}

async function importConfig() {
  try {
    const openResult = await window.api?.showOpenDialog?.({
      title: t('setting.dataManagement.importButton'),
      properties: ['openFile'],
      filters: [{ name: 'JSON', extensions: ['json'] }]
    });

    if (!openResult || openResult.canceled || !Array.isArray(openResult.filePaths) || openResult.filePaths.length === 0) {
      return;
    }

    const filePath = openResult.filePaths[0];
    const readResult = await window.api?.readLocalFile?.(filePath, { encoding: 'utf8' });

    if (readResult && readResult.ok === false) {
      throw new Error(getErrorMessage(readResult, 'read config file failed'));
    }

    const rawContent = typeof readResult === 'string'
      ? readResult
      : typeof readResult?.content === 'string'
        ? readResult.content
        : '';
    const importedData = JSON.parse(rawContent);

    if (typeof importedData !== 'object' || importedData === null) {
      throw new Error("Imported file is not a valid configuration object.");
    }

    if (importedData.memories && window.api && window.api.importMemoryData) {
      const memoryResult = await window.api.importMemoryData(importedData.memories);
      if (memoryResult && memoryResult.ok === false) {
        throw new Error(getErrorMessage(memoryResult, 'import memory failed'));
      }
      delete importedData.memories;
    }

    if (window.api && window.api.restoreImportedConfig) {
      const configResult = await window.api.restoreImportedConfig(importedData);
      if (configResult && configResult.ok === false) {
        throw new Error(getErrorMessage(configResult, 'update config failed'));
      }
      const result = await window.api.getConfig();
      if (result && result.config) {
        currentConfig.value = result.config;
        initCardOrder();
      }
    }

    ElMessage.success(t('setting.alerts.importSuccess'));
  } catch (err) {
    console.error("Error importing configuration:", err);
    ElMessage.error(t('setting.alerts.importFailed'));
  }
}

async function handleThemeChange(mode) {
  if (!currentConfig.value) return;

  await saveSingleSetting('themeMode', mode);

  let newIsDarkMode = currentConfig.value.isDarkMode;

  if (mode === 'system') {
    newIsDarkMode = window.matchMedia('(prefers-color-scheme: dark)').matches;
  } else if (mode === 'dark') {
    newIsDarkMode = true;
  } else {
    newIsDarkMode = false;
  }

  currentConfig.value.isDarkMode = newIsDarkMode;
  await saveSingleSetting('isDarkMode', newIsDarkMode);
}

const addNewVoice = () => {
  ElMessageBox.prompt(t('setting.voice.addPromptMessage'), t('setting.voice.addPromptTitle'), {
    confirmButtonText: t('common.confirm'),
    cancelButtonText: t('common.cancel'),
    inputValidator: (value) => {
      if (!value || value.trim() === '') return t('setting.voice.addFailEmpty');
      if (currentConfig.value.voiceList.includes(value.trim())) return t('setting.voice.addFailExists');
      return true;
    },
  }).then(({ value }) => {
    const newVoice = value.trim();
    if (!currentConfig.value.voiceList) {
      currentConfig.value.voiceList = [];
    }
    currentConfig.value.voiceList.push(newVoice);
    saveFullConfig();
    ElMessage.success(t('setting.voice.addSuccess'));
  }).catch(() => { });
};

const editVoice = (oldVoice) => {
  ElMessageBox.prompt(t('setting.voice.editPromptMessage'), t('setting.voice.editPromptTitle'), {
    confirmButtonText: t('common.confirm'),
    cancelButtonText: t('common.cancel'),
    inputValue: oldVoice,
    inputValidator: (value) => {
      const trimmedValue = value.trim();
      if (!trimmedValue) return t('setting.voice.addFailEmpty');
      if (trimmedValue !== oldVoice && currentConfig.value.voiceList.includes(trimmedValue)) {
        return t('setting.voice.addFailExists');
      }
      return true;
    },
  }).then(({ value }) => {
    const newVoice = value.trim();
    if (newVoice === oldVoice) return;
    const index = currentConfig.value.voiceList.indexOf(oldVoice);
    if (index > -1) {
      currentConfig.value.voiceList[index] = newVoice;
      Object.values(currentConfig.value.prompts).forEach(prompt => {
        if (prompt.voice === oldVoice) {
          prompt.voice = newVoice;
        }
      });
      saveFullConfig();
      ElMessage.success(t('setting.voice.editSuccess'));
    }
  }).catch(() => { });
};

const deleteVoice = (voiceToDelete) => {
  const index = currentConfig.value.voiceList.indexOf(voiceToDelete);
  if (index > -1) {
    currentConfig.value.voiceList.splice(index, 1);
    Object.values(currentConfig.value.prompts).forEach(prompt => {
      if (prompt.voice === voiceToDelete) {
        prompt.voice = null;
      }
    });
    saveFullConfig();
  }
};

async function backupToWebdav() {
  if (!currentConfig.value) return;
  const { url } = getWebdavConfig();
  if (!url) {
    ElMessage.error(t('setting.webdav.alerts.urlRequired'));
    return;
  }

  const now = new Date();
  const timestamp = `${now.getFullYear()}${(now.getMonth() + 1).toString().padStart(2, '0')}${now.getDate().toString().padStart(2, '0')}${now.getHours().toString().padStart(2, '0')}${now.getMinutes().toString().padStart(2, '0')}${now.getSeconds().toString().padStart(2, '0')}`;
  const defaultBasename = `Anywhere-${timestamp}`;

  const inputValue = ref(defaultBasename);

  try {
    await ElMessageBox({
      title: t('setting.webdav.backup.confirmTitle'),
      message: () => h('div', { style: 'display: flex; flex-direction: column; align-items: center; width: 100%;' }, [
        h('p', { style: 'margin-bottom: 15px; font-size: 14px; color: var(--text-secondary); text-align: center; width: 100%;' }, t('setting.webdav.backup.confirmMessage')),
        h(ElInput, {
          modelValue: inputValue.value,
          'onUpdate:modelValue': (val) => { inputValue.value = val; },
          placeholder: t('setting.webdav.backup.inputFilename'),
          autofocus: true,
          style: 'width: 100%; max-width: 400px;'
        }, {
          append: () => h('div', { class: 'input-suffix-display' }, '.json')
        })
      ]),
      showCancelButton: true,
      confirmButtonText: t('common.confirm'),
      cancelButtonText: t('common.cancel'),
      customClass: 'filename-prompt-dialog',
      center: true,
      beforeClose: async (action, instance, done) => {
        if (action === 'confirm') {
          let finalBasename = inputValue.value.trim();
          if (!finalBasename) {
            ElMessage.error(t('setting.webdav.backup.emptyFilenameError'));
            return;
          }

          const filename = `${finalBasename}.json`;

          instance.confirmButtonLoading = true;
          ElMessage.info(t('setting.webdav.alerts.backupInProgress'));

          try {
            const configToBackup = JSON.parse(JSON.stringify(currentConfig.value));
            if (configToBackup.webdav && configToBackup.webdav.localChatPath) {
              delete configToBackup.webdav.localChatPath;
            }
            if (configToBackup.skillPath !== undefined) {
              delete configToBackup.skillPath;
            }

            if (window.api && window.api.exportMemoryData) {
              const memories = await window.api.exportMemoryData();
              if (memories && memories.length > 0) {
                configToBackup.memories = memories;
              }
            }

            const writeResult = await window.api?.writeWebdavBackup?.(
              buildWebdavInput({
                filename,
                content: JSON.stringify(configToBackup, null, 2),
                overwrite: true,
                ensureDirectory: true
              })
            )

            if (!writeResult || writeResult.ok === false) {
              throw new Error(getErrorMessage(writeResult, 'webdav_write_failed'))
            }

            ElMessage.success(t('setting.webdav.alerts.backupSuccess'));
            done();
          } catch (error) {
            console.error("WebDAV backup failed:", error);
            ElMessage.error(`${t('setting.webdav.alerts.backupFailed')}: ${error.message}`);
          } finally {
            instance.confirmButtonLoading = false;
          }
        } else {
          done();
        }
      }
    });
  } catch (error) {
    if (error === 'cancel' || error === 'close') {
      ElMessage.info(t('setting.webdav.backup.cancelled'));
    } else {
      console.error("MessageBox error:", error);
    }
  }
}

async function openBackupManager() {
  if (!currentConfig.value) return;
  const { url } = getWebdavConfig();
  if (!url) {
    ElMessage.error(t('setting.webdav.alerts.urlRequired'));
    return;
  }
  isBackupManagerVisible.value = true;
  await fetchBackupFiles();
}

async function fetchBackupFiles() {
  isTableLoading.value = true;

  try {
    const result = await window.api?.listWebdavBackups?.(buildWebdavInput())

    if (!result || result.ok === false) {
      throw new Error(getErrorMessage(result, 'webdav_list_failed'))
    }

    if (!result.exists) {
      backupFiles.value = [];
      ElMessage.warning(t('setting.webdav.manager.pathNotFound'));
      return;
    }

    backupFiles.value = Array.isArray(result.files) ? result.files : []
  } catch (error) {
    console.error("Failed to fetch backup files:", error);
    ElMessage.error(`${t('setting.webdav.manager.fetchFailed')}: ${error.message}`);
    backupFiles.value = [];
  } finally {
    isTableLoading.value = false;
  }
}

async function restoreFromWebdav(file) {
  try {
    await ElMessageBox.confirm(
      t('setting.webdav.manager.confirmRestore', { filename: file.basename }),
      t('common.warningTitle'),
      {
        confirmButtonText: t('common.confirm'),
        cancelButtonText: t('common.cancel'),
        type: 'warning',
      }
    );

    ElMessage.info(t('setting.webdav.alerts.restoreInProgress'));

    const readResult = await window.api?.readWebdavBackup?.(
      buildWebdavInput({ filename: file.basename })
    )

    if (!readResult || readResult.ok === false) {
      throw new Error(getErrorMessage(readResult, 'webdav_read_failed'))
    }

    const importedData = JSON.parse(readResult.content || '{}');

    if (typeof importedData !== 'object' || importedData === null) {
      throw new Error("Downloaded file is not a valid configuration object.");
    }

    if (importedData.memories && window.api && window.api.importMemoryData) {
      const memoryResult = await window.api.importMemoryData(importedData.memories);
      if (memoryResult && memoryResult.ok === false) {
        throw new Error(getErrorMessage(memoryResult, 'import memory failed'));
      }
      delete importedData.memories;
    }

    if (window.api && window.api.restoreImportedConfig) {
      const configResult = await window.api.restoreImportedConfig(importedData);
      if (configResult && configResult.ok === false) {
        throw new Error(getErrorMessage(configResult, 'update config failed'));
      }
      const result = await window.api.getConfig();
      if (result && result.config) {
        currentConfig.value = result.config;
        initCardOrder();
      }
    }

    ElMessage.success(t('setting.webdav.alerts.restoreSuccess'));
    isBackupManagerVisible.value = false;

  } catch (error) {
    if (error !== 'cancel' && error !== 'close') {
      console.error("WebDAV restore failed:", error);
      ElMessage.error(`${t('setting.webdav.alerts.restoreFailed')}: ${error.message}`);
    }
  }
}

async function deleteFile(file) {
  try {
    await ElMessageBox.confirm(
      t('setting.webdav.manager.confirmDelete', { filename: file.basename }),
      t('common.warningTitle'),
      { type: 'warning' }
    );

    const deleteResult = await window.api?.deleteWebdavBackup?.(
      buildWebdavInput({ filename: file.basename })
    )

    if (!deleteResult || deleteResult.ok === false) {
      throw new Error(getErrorMessage(deleteResult, 'webdav_delete_failed'))
    }

    ElMessage.success(t('setting.webdav.manager.deleteSuccess'));
    await fetchBackupFiles();
  } catch (error) {
    if (error !== 'cancel' && error !== 'close') {
      console.error("Failed to delete file:", error);
      ElMessage.error(`${t('setting.webdav.manager.deleteFailed')}: ${error.message}`);
    }
  }
}

async function deleteSelectedFiles() {
  if (selectedFiles.value.length === 0) {
    ElMessage.warning(t('setting.webdav.manager.noFileSelected'));
    return;
  }

  try {
    await ElMessageBox.confirm(
      t('setting.webdav.manager.confirmDeleteMultiple', { count: selectedFiles.value.length }),
      t('common.warningTitle'),
      { type: 'warning' }
    );

    const filenames = selectedFiles.value
      .map((item) => item?.basename)
      .filter((name) => typeof name === 'string' && name.trim())

    const deleteResult = await window.api?.deleteWebdavBackups?.(
      buildWebdavInput({ filenames })
    )

    if (!deleteResult || deleteResult.ok === false) {
      throw new Error(getErrorMessage(deleteResult, 'webdav_delete_multiple_failed'))
    }

    if (Array.isArray(deleteResult.failed) && deleteResult.failed.length > 0) {
      const firstError = deleteResult.failed[0]
      ElMessage.warning(`${t('setting.webdav.manager.deleteFailedMultiple')}: ${firstError?.message || 'unknown_error'}`)
    } else {
      ElMessage.success(t('setting.webdav.manager.deleteSuccessMultiple'));
    }

    await fetchBackupFiles();
  } catch (error) {
    if (error !== 'cancel' && error !== 'close') {
      console.error("Failed to delete selected files:", error);
      ElMessage.error(`${t('setting.webdav.manager.deleteFailedMultiple')}: ${error.message}`);
    }
  }
}

const handleSelectionChange = (val) => {
  selectedFiles.value = val;
};

async function selectLocalChatPath() {
  const path = await window.api.selectDirectory();
  if (path) {
    currentConfig.value.webdav.localChatPath = path;
    saveSingleSetting('webdav.localChatPath', path);
  }
}
</script>

<template>
  <div class="settings-page-container">
    <el-scrollbar class="settings-scrollbar-wrapper">
      <div class="settings-content">
        <draggable 
          v-model="settingsCards" 
          item-key="id" 
          handle=".card-header" 
          animation="300"
          ghost-class="sortable-ghost"
          drag-class="sortable-drag"
          class="draggable-list"
          @end="onOrderChange"
        >
          <template #item="{ element }">
            <div class="settings-card">
              <div class="card-header" :class="{ 'is-collapsed': collapsedCards[element.id] }" @click="toggleCard(element.id)">
                <span v-if="element.id === 'voice'">
                  <el-tooltip :content="t('setting.voice.description')" placement="top">
                    <span>{{ t(element.titleKey) }}</span>
                  </el-tooltip>
                </span>
                <span v-else>{{ element.titleKey ? t(element.titleKey) : element.staticTitle }}</span>
                <el-icon class="collapse-icon" :class="{ 'is-expanded': !collapsedCards[element.id] }"><ArrowRight /></el-icon>
              </div>

              <el-collapse-transition>
                <div v-show="!collapsedCards[element.id]">
                  
                  <div v-if="element.id === 'general'" class="card-body">
                    <div class="setting-option-item">
                      <div class="setting-text-content">
                        <span class="setting-option-label">{{ t('setting.language.label') }}</span>
                        <span class="setting-option-description">{{ t('setting.language.selectPlaceholder') }}</span>
                      </div>
                      <el-select v-model="selectedLanguage" @change="handleLanguageChange" size="default" style="width: 120px;">
                        <el-option :label="t('setting.language.chinese')" value="zh"></el-option>
                        <el-option :label="t('setting.language.english')" value="en"></el-option>
                      </el-select>
                    </div>
                    <div class="setting-option-item">
                      <div class="setting-text-content">
                        <span class="setting-option-label">{{ t('setting.darkMode.label') }}</span>
                        <span class="setting-option-description">{{ t('setting.darkMode.description') }}</span>
                      </div>
                      <el-select v-model="currentConfig.themeMode" @change="handleThemeChange" size="default"
                        style="width: 120px;">
                        <el-option :label="t('setting.darkMode.system')" value="system"></el-option>
                        <el-option :label="t('setting.darkMode.light')" value="light"></el-option>
                        <el-option :label="t('setting.darkMode.dark')" value="dark"></el-option>
                      </el-select>
                    </div>
                    <div class="setting-option-item">
                      <div class="setting-text-content">
                        <span class="setting-option-label">{{ t('setting.isAlwaysOnTop_global.label') }}</span>
                        <span class="setting-option-description">{{ t('setting.isAlwaysOnTop_global.description') }}</span>
                      </div>
                      <el-switch v-model="currentConfig.isAlwaysOnTop_global"
                        @change="(value) => handleGlobalToggleChange('isAlwaysOnTop', value)" />
                    </div>
                    <div class="setting-option-item">
                      <div class="setting-text-content">
                        <span class="setting-option-label">{{ t('setting.autoCloseOnBlur_global.label') }}</span>
                        <span class="setting-option-description">{{ t('setting.autoCloseOnBlur_global.description') }}</span>
                      </div>
                      <el-switch v-model="currentConfig.autoCloseOnBlur_global"
                        @change="(value) => handleGlobalToggleChange('autoCloseOnBlur', value)" />
                    </div>
                    <div class="setting-option-item">
                      <div class="setting-text-content">
                        <span class="setting-option-label">{{ t('setting.autoSaveChat_global.label') }}</span>
                        <span class="setting-option-description">{{ t('setting.autoSaveChat_global.description') }}</span>
                      </div>
                      <el-switch v-model="currentConfig.autoSaveChat_global"
                        @change="(value) => handleGlobalToggleChange('autoSaveChat', value)" />
                    </div>
                    <div class="setting-option-item">
                      <div class="setting-text-content">
                        <span class="setting-option-label">{{ t('setting.skipLineBreak.label') }}</span>
                        <span class="setting-option-description">{{ t('setting.skipLineBreak.description') }}</span>
                      </div>
                      <el-switch v-model="currentConfig.skipLineBreak"
                        @change="(value) => saveSingleSetting('skipLineBreak', value)" />
                    </div>
                    <div class="setting-option-item">
                      <div class="setting-text-content">
                        <span class="setting-option-label">{{ t('setting.ctrlEnter.label') }}</span>
                        <span class="setting-option-description">{{ t('setting.ctrlEnter.description') }}</span>
                      </div>
                      <el-switch v-model="currentConfig.CtrlEnterToSend"
                        @change="(value) => saveSingleSetting('CtrlEnterToSend', value)" />
                    </div>
                    <div class="setting-option-item no-border">
                      <div class="setting-text-content">
                        <span class="setting-option-label">{{ t('setting.fixPosition.label') }}</span>
                        <span class="setting-option-description">{{ t('setting.fixPosition.description') }}</span>
                      </div>
                      <el-switch v-model="currentConfig.fix_position"
                        @change="(value) => saveSingleSetting('fix_position', value)" />
                    </div>
                  </div>

                  
                  <div v-if="element.id === 'desktop'" class="card-body">
                    <div class="setting-option-item desktop-profile-item">
                      <div class="setting-text-content">
                        <span class="setting-option-label">{{ t('setting.desktop.profile.avatar.label') }}</span>
                        <span class="setting-option-description">{{ t('setting.desktop.profile.avatar.description') }}</span>
                      </div>
                      <div class="desktop-profile-avatar-editor" @paste="handleProfileAvatarPaste" tabindex="0" style="outline: none;">
                        <el-upload
                          class="desktop-avatar-uploader"
                          action="#"
                          drag
                          :show-file-list="false"
                          :before-upload="handleProfileAvatarUploadChange"
                          accept="image/png, image/jpeg, image/webp"
                          @drop.prevent="handleProfileAvatarDrop"
                          @dragover.prevent
                        >
                          <template v-if="currentConfig.desktop.profile.avatar">
                            <el-avatar :src="currentConfig.desktop.profile.avatar" shape="square" :size="48" class="desktop-avatar-preview" />
                            <div class="icon-hover-mask" @click.stop.prevent="openProfileAvatarEditor(currentConfig.desktop.profile.avatar)">
                              <el-icon><Edit /></el-icon>
                            </div>
                          </template>
                          <template v-else>
                            <div class="icon-uploader-placeholder">
                              <el-icon :size="18"><UploadFilled /></el-icon>
                              <div class="icon-upload-text" style="font-size: 9px; margin-top: 3px; color: var(--panda-text-sub); line-height: 1.15; white-space: pre-line;">
                                {{ t('setting.desktop.profile.avatar.uploadText') }}
                              </div>
                            </div>
                          </template>
                        </el-upload>

                        <div class="icon-button-group desktop-avatar-button-group">
                          <el-button class="icon-action-button" size="small" @click="currentConfig.desktop.profile.avatar && openProfileAvatarEditor(currentConfig.desktop.profile.avatar)" :disabled="!currentConfig.desktop.profile.avatar" :title="t('setting.desktop.profile.avatar.editTooltip')">
                            <el-icon><Edit /></el-icon>
                          </el-button>
                          <el-button class="icon-action-button" size="small" @click="currentConfig.desktop.profile.avatar = ''; saveDesktopProfileConfig()" :disabled="!currentConfig.desktop.profile.avatar" :title="t('setting.desktop.profile.avatar.removeTooltip')">
                            <el-icon><DeleteIcon /></el-icon>
                          </el-button>
                        </div>
                      </div>
                    </div>

                    <div class="setting-option-item desktop-profile-item">
                      <div class="setting-text-content">
                        <span class="setting-option-label">{{ t('setting.desktop.profile.nickname.label') }}</span>
                        <span class="setting-option-description">{{ t('setting.desktop.profile.nickname.description') }}</span>
                      </div>
                      <el-input
                        v-model="currentConfig.desktop.profile.nickname"
                        maxlength="12"
                        show-word-limit
                        class="desktop-profile-input"
                        :placeholder="t('setting.desktop.profile.nickname.placeholder')"
                        @blur="handleDesktopNicknameBlur"
                      />
                    </div>

                    <div class="setting-option-item">
                      <div class="setting-text-content">
                        <span class="setting-option-label">{{ t('setting.desktop.closeToTray.label') }}</span>
                        <span class="setting-option-description">{{ t('setting.desktop.closeToTray.description') }}</span>
                      </div>
                      <el-switch v-model="currentConfig.desktop.closeToTray" @change="handleDesktopShortcutChange" />
                    </div>

                    <div class="setting-option-item">
                      <div class="setting-text-content">
                        <span class="setting-option-label">{{ t('setting.desktop.mainToggle.label') }}</span>
                        <span class="setting-option-description">{{ t('setting.desktop.mainToggle.description') }}</span>
                      </div>
                      <el-button class="shortcut-record-btn" @click="startShortcutRecording('mainToggle')">
                        {{ shortcutRecorder.active && shortcutRecorder.target === 'mainToggle' ? '请按下快捷键…' : toDisplayShortcut(currentConfig.desktop.shortcuts.mainToggle) || t('setting.desktop.mainToggle.placeholder') }}
                      </el-button>
                    </div>

                    <div class="setting-option-item">
                      <div class="setting-text-content">
                        <span class="setting-option-label">{{ t('setting.desktop.quickSummon.label') }}</span>
                        <span class="setting-option-description">{{ t('setting.desktop.quickSummon.description') }}</span>
                      </div>
                      <el-button class="shortcut-record-btn" @click="startShortcutRecording('quickSummon')">
                        {{ shortcutRecorder.active && shortcutRecorder.target === 'quickSummon' ? '请按下快捷键…' : toDisplayShortcut(currentConfig.desktop.shortcuts.quickSummon) || t('setting.desktop.quickSummon.placeholder') }}
                      </el-button>
                    </div>

                    <div class="setting-option-item">
                      <div class="setting-text-content">
                        <span class="setting-option-label">自动追问快捷键</span>
                        <span class="setting-option-description">按下后自动追问；仅一个窗口时直接追问，多个窗口时打开追问选择界面。</span>
                      </div>
                      <el-button class="shortcut-record-btn" @click="startShortcutRecording('appendFollowUp')">
                        {{ shortcutRecorder.active && shortcutRecorder.target === 'appendFollowUp' ? '请按下快捷键…' : toDisplayShortcut(currentConfig.desktop.shortcuts.appendFollowUp) || 'Alt+S' }}
                      </el-button>
                    </div>

                    <div class="desktop-shortcut-list">
                      <div class="desktop-shortcut-list-head">
                        <div>
                          <div class="setting-option-label">{{ t('setting.desktop.promptShortcuts.title') }}</div>
                          <div class="setting-option-description">{{ t('setting.desktop.promptShortcuts.description') }}</div>
                        </div>
                        <el-button plain :icon="Plus" @click="addPromptShortcutBinding">{{ t('setting.desktop.promptShortcuts.addButton') }}</el-button>
                      </div>

                      <div v-if="!currentConfig.desktop.shortcuts.promptBindings.length" class="desktop-shortcut-empty">
                        {{ t('setting.desktop.promptShortcuts.empty') }}
                      </div>

                      <div v-for="(binding, index) in currentConfig.desktop.shortcuts.promptBindings" :key="binding.id || index" class="desktop-shortcut-row">
                        <el-select v-model="binding.promptKey" style="width: 220px;" filterable @change="handleDesktopShortcutChange">
                          <el-option v-for="prompt in availableWindowPrompts" :key="prompt.key" :label="prompt.key" :value="prompt.key" />
                        </el-select>
                        <el-button class="shortcut-record-btn small" @click="startShortcutRecording('promptBinding', index)">
                          {{ shortcutRecorder.active && shortcutRecorder.target === 'promptBinding' && shortcutRecorder.index === index ? '请按下快捷键…' : (toDisplayShortcut(binding.accelerator) || t('setting.desktop.promptShortcuts.shortcutPlaceholder')) }}
                        </el-button>
                        <el-switch v-model="binding.enabled" @change="handleDesktopShortcutChange" />
                        <el-button text type="danger" :icon="Remove" @click="removePromptShortcutBinding(index)" />
                      </div>
                    </div>
                  </div>

<div v-if="element.id === 'voice'" class="card-body">
                    <div class="voice-list-container">
                      <el-tag v-for="voice in currentConfig.voiceList" :key="voice" closable @click="editVoice(voice)"
                        @close="deleteVoice(voice)" class="voice-tag" size="large">
                        {{ voice }}
                      </el-tag>
                      <el-button class="add-voice-button" type="primary" plain :icon="Plus" @click="addNewVoice">
                        {{ t('setting.voice.add') }}
                      </el-button>
                    </div>
                  </div>

                  <div v-if="element.id === 'data'" class="card-body">
                    <div class="setting-option-item">
                      <div class="setting-text-content">
                        <span class="setting-option-label">{{ t('setting.dataManagement.exportLabel') }}</span>
                        <span class="setting-option-description">{{ t('setting.dataManagement.exportDesc') }}</span>
                      </div>
                      <el-button @click="exportConfig" :icon="Download" size="default" plain>{{
                        t('setting.dataManagement.exportButton')
                      }}</el-button>
                    </div>
                    <div class="setting-option-item">
                      <div class="setting-text-content">
                        <span class="setting-option-label">{{ t('setting.dataManagement.importLabel') }}</span>
                        <span class="setting-option-description">{{ t('setting.dataManagement.importDesc') }}</span>
                      </div>
                      <el-button @click="importConfig" :icon="Upload" size="default" plain>{{
                        t('setting.dataManagement.importButton')
                      }}</el-button>
                    </div>
                    <div class="setting-option-item no-border">
                      <div class="setting-text-content">
                        <span class="setting-option-label">{{ t('setting.webdav.localChatPath') }}</span>
                        <span class="setting-option-description">{{ t('setting.webdav.localChatPathPlaceholder') }}</span>
                      </div>
                      <el-input v-model="currentConfig.webdav.localChatPath"
                        @change="(value) => saveSingleSetting('webdav.localChatPath', value)"
                        :placeholder="t('setting.webdav.localChatPathPlaceholder')" style="width: 320px;">
                        <template #append>
                          <el-button @click="selectLocalChatPath">{{ t('setting.webdav.selectFolder') }}</el-button>
                        </template>
                      </el-input>
                    </div>
                  </div>

                  <div v-if="element.id === 'webdav'" class="card-body">
                    <div class="setting-option-item">
                      <div class="setting-text-content">
                        <span class="setting-option-label">{{ t('setting.webdav.url') }}</span>
                      </div>
                      <el-input v-model="currentConfig.webdav.url" @change="(value) => saveSingleSetting('webdav.url', value)"
                        :placeholder="t('setting.webdav.urlPlaceholder')" style="width: 320px;" />
                    </div>
                    
                    <div class="setting-option-item">
                      <div class="setting-text-content">
                        <span class="setting-option-label">{{ t('setting.webdav.username') }}</span>
                      </div>
                      <el-input v-model="currentConfig.webdav.username" @change="(value) => saveSingleSetting('webdav.username', value)"
                        :placeholder="t('setting.webdav.usernamePlaceholder')" style="width: 320px;" />
                    </div>

                    <div class="setting-option-item">
                      <div class="setting-text-content">
                        <span class="setting-option-label">{{ t('setting.webdav.password') }}</span>
                      </div>
                      <el-input v-model="currentConfig.webdav.password" @change="(value) => saveSingleSetting('webdav.password', value)" type="password" show-password
                        :placeholder="t('setting.webdav.passwordPlaceholder')" style="width: 320px;" />
                    </div>

                    <div class="setting-option-item">
                      <div class="setting-text-content">
                        <span class="setting-option-label">{{ t('setting.webdav.path') }}</span>
                      </div>
                      <el-input v-model="currentConfig.webdav.path" @change="(value) => saveSingleSetting('webdav.path', value)"
                        :placeholder="t('setting.webdav.pathPlaceholder')" style="width: 320px;" />
                    </div>

                    <div class="setting-option-item">
                      <div class="setting-text-content">
                        <span class="setting-option-label">{{ t('setting.webdav.dataPath') }}</span>
                      </div>
                      <el-input v-model="currentConfig.webdav.data_path" @change="(value) => saveSingleSetting('webdav.data_path', value)"
                        :placeholder="t('setting.webdav.dataPathPlaceholder')" style="width: 320px;" />
                    </div>

                    <div class="setting-option-item no-border">
                      <div class="setting-text-content">
                        <span class="setting-option-label">{{ t('setting.webdav.backupRestoreTitle') }}</span>
                      </div>
                      <div class="webdav-actions" style="display: flex; gap: 12px;">
                        <el-button @click="backupToWebdav" :icon="Upload" plain>{{ t('setting.webdav.backupButton') }}</el-button>
                        <el-button @click="openBackupManager" :icon="FolderOpened" plain>{{ t('setting.webdav.restoreButton') }}</el-button>
                      </div>
                    </div>
                  </div>

                </div>
              </el-collapse-transition>
            </div>
          </template>
        </draggable>
      </div>
    </el-scrollbar>

    
    <el-dialog v-model="showAvatarEditDialog" :title="t('setting.desktop.profile.avatar.dialogTitle')" width="400px" :close-on-click-modal="false" append-to-body>
      <div class="icon-edit-container">
        <div class="canvas-wrapper">
          <canvas ref="avatarEditorCanvasRef" width="256" height="256" @mousedown="handleProfileAvatarCanvasMouseDown"
            @mousemove="handleProfileAvatarCanvasMouseMove" @mouseup="handleProfileAvatarCanvasMouseUp" @mouseleave="handleProfileAvatarCanvasMouseUp"
            @wheel="handleProfileAvatarCanvasWheel"></canvas>
          <div class="canvas-hint">{{ t('setting.desktop.profile.avatar.editorHint') }}</div>
        </div>

        <div class="editor-controls">
          <div class="control-row">
            <span class="label">{{ t('setting.desktop.profile.avatar.scale') }}</span>
            <el-slider v-model="avatarEditorState.scale" :min="0.1" :max="3" :step="0.1" @input="drawProfileAvatarCanvas" />
          </div>
          <div class="control-row">
            <span class="label">{{ t('setting.desktop.profile.avatar.radius') }}</span>
            <el-slider v-model="avatarEditorState.radius" :min="0" :max="50" :step="1" @input="drawProfileAvatarCanvas" :format-tooltip="val => val + '%'" />
          </div>
        </div>
      </div>
      <template #footer>
        <el-button @click="showAvatarEditDialog = false">{{ t('common.cancel') }}</el-button>
        <el-button type="primary" @click="saveEditedProfileAvatar">{{ t('common.confirm') }}</el-button>
      </template>
    </el-dialog>

<el-dialog v-model="isBackupManagerVisible" :title="t('setting.webdav.manager.title')" width="700px" top="10vh"
      :destroy-on-close="true" style="max-width: 90vw;" class="backup-manager-dialog">
      <el-table :data="paginatedFiles" v-loading="isTableLoading" @selection-change="handleSelectionChange"
        style="width: 100%" max-height="50vh" border stripe>
        <el-table-column type="selection" width="50" align="center" />
        <el-table-column prop="basename" :label="t('setting.webdav.manager.filename')" sortable show-overflow-tooltip
          min-width="160" />
        <el-table-column prop="lastmod" :label="t('setting.webdav.manager.modifiedTime')" width="170" sortable
          align="center">
          <template #default="scope">{{ formatDate(scope.row.lastmod) }}</template>
        </el-table-column>
        <el-table-column prop="size" :label="t('setting.webdav.manager.size')" width="100" sortable align="center">
          <template #default="scope">{{ formatBytes(scope.row.size) }}</template>
        </el-table-column>
        <el-table-column :label="t('setting.webdav.manager.actions')" width="120" align="center">
          <template #default="scope">
            <div class="action-buttons-container">
              <el-button link type="primary" @click="restoreFromWebdav(scope.row)">{{
                t('setting.webdav.manager.restore') }}</el-button>
              <el-divider direction="vertical" />
              <el-button link type="danger" @click="deleteFile(scope.row)">{{ t('setting.webdav.manager.delete')
              }}</el-button>
            </div>
          </template>
        </el-table-column>
      </el-table>

      <template #footer>
        <div class="dialog-footer">
          <div class="footer-left">
            <el-button :icon="Refresh" @click="fetchBackupFiles"></el-button>
            <el-button type="danger" :icon="DeleteIcon" @click="deleteSelectedFiles"
              :disabled="selectedFiles.length === 0">
              ({{ selectedFiles.length }})
            </el-button>
          </div>
          <div class="footer-center">
            <el-pagination v-if="backupFiles.length > 0" v-model:current-page="currentPage" v-model:page-size="pageSize"
              :page-sizes="[10, 20, 50, 100]" :total="backupFiles.length"
              layout="total, sizes, prev, pager, next, jumper" background size="small" />
          </div>
          <div class="footer-right">
            <el-button @click="isBackupManagerVisible = false">{{ t('common.close') }}</el-button>
          </div>
        </div>
      </template>
    </el-dialog>
  </div>
</template>

<style scoped>
.settings-page-container {
  --panda-bg: #F4F4F5; 
  --panda-card-bg: #FFFFFF;
  --panda-text-main: #18181B;
  --panda-text-sub: #71717A;
  --panda-accent: #18181B;
  --panda-border: #E4E4E7;
  --panda-hover: #F4F4F5;
  --panda-shadow: 0 4px 6px -1px rgba(0, 0, 0, 0.05), 0 2px 4px -1px rgba(0, 0, 0, 0.03);
  
  height: 100%;
  width: 100%;
  display: flex;
  justify-content: center;
  overflow: hidden;
  font-family: 'Inter', -apple-system, BlinkMacSystemFont, sans-serif;
}

html.dark .settings-page-container {
  --panda-bg: #000000;
  --panda-card-bg: #18181B;
  --panda-text-main: #FFFFFF;
  --panda-text-sub: #A1A1AA;
  --panda-accent: #FFFFFF;
  --panda-border: #27272A;
  --panda-hover: #27272A;
  --panda-shadow: 0 4px 20px rgba(0, 0, 0, 0.5);
}


html.dark .desktop-avatar-uploader :deep(.el-upload-dragger) {
  background: color-mix(in srgb, var(--panda-card-bg) 98%, #000);
}

html.dark .icon-action-button {
  background: color-mix(in srgb, var(--panda-card-bg) 96%, #000);
  border-color: color-mix(in srgb, var(--panda-border) 82%, transparent);
  color: var(--panda-text-sub);
}


.settings-scrollbar-wrapper {
  height: 100%;
  width: 100%;
  max-width: 1000px;
}

.settings-content {
  padding: 20px 20px 60px 20px;
  display: flex;
  flex-direction: column;
}

.draggable-list {
  display: flex;
  flex-direction: column;
  gap: 16px;
}

.sortable-ghost {
  opacity: 0.4;
  background-color: var(--panda-bg);
  border: 1px dashed var(--panda-text-sub);
  box-shadow: none;
}

.sortable-drag {
  cursor: grabbing;
  opacity: 1;
  background-color: var(--panda-card-bg);
  box-shadow: 0 16px 32px -8px rgba(0, 0, 0, 0.15);
  transform: scale(1.01);
}

.settings-card {
  background-color: var(--panda-card-bg);
  border-radius: 12px;
  border: 1px solid var(--panda-border);
  box-shadow: var(--panda-shadow);
  overflow: hidden;
  transition: transform 0.2s ease, box-shadow 0.2s ease;
}

.settings-card:hover {
  transform: translateY(-1px);
  box-shadow: 0 8px 12px -3px rgba(0, 0, 0, 0.08);
}

.card-header {
  padding: 14px 20px;
  font-size: 15px;
  color: var(--panda-text-main);
  display: flex;
  justify-content: space-between;
  align-items: center;
  cursor: grab;
  user-select: none;
  background-color: transparent;
  transition: background-color 0.2s;
  border-bottom: 1px solid var(--panda-border);
}

.card-header:active {
  cursor: grabbing;
}

.card-header.is-collapsed {
  border-bottom: 1px solid transparent;
}

.card-header:hover {
  background-color: var(--panda-hover);
}

.card-header > span,
.card-header :deep(span) {
  font-weight: 700;
  letter-spacing: -0.3px;
}

.collapse-icon {
  color: var(--panda-text-sub);
  transition: transform 0.3s cubic-bezier(0.34, 1.56, 0.64, 1);
  font-size: 16px;
  background-color: var(--panda-bg);
  border-radius: 50%;
  padding: 4px;
  width: 24px;
  height: 24px;
}

.collapse-icon.is-expanded {
  transform: rotate(90deg);
  background-color: var(--panda-accent);
  color: var(--panda-card-bg);
}

.card-body {
  padding: 4px 20px 20px 20px;
}

.setting-option-item {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 10px 12px;
  margin-bottom: 2px;
  border-radius: 8px;
  background-color: transparent;
  border: 1px solid transparent;
  transition: all 0.2s ease;
  gap: 16px;
}

.setting-option-item:hover {
  background-color: var(--panda-hover);
}

.setting-option-item:last-child,
.setting-option-item.no-border {
  margin-bottom: 0;
}

.setting-text-content {
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  justify-content: center;
  gap: 2px;
  flex: 1;
  min-width: 0;
}

.setting-option-label {
  font-size: 14px;
  font-weight: 600;
  color: var(--panda-text-main);
}

.setting-option-description {
  font-size: 12px;
  color: var(--panda-text-sub);
  line-height: 1.3;
}


.desktop-shortcut-list {
  display: flex;
  flex-direction: column;
  gap: 10px;
  margin-top: 12px;
}

.desktop-shortcut-list-head {
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: 12px;
  padding: 8px 12px 2px;
}

.desktop-shortcut-row {
  display: grid;
  grid-template-columns: minmax(0, 220px) 180px 60px 40px;
  gap: 10px;
  align-items: center;
  padding: 12px;
  border-radius: 12px;
  background: var(--panda-bg);
  border: 1px solid var(--panda-border);
}

.shortcut-record-btn {
  min-width: 220px;
  justify-content: flex-start;
}

.shortcut-record-btn.small {
  min-width: 180px;
}


.desktop-profile-item {
  align-items: flex-start;
}

.desktop-profile-input {
  width: 220px;
}

.desktop-profile-avatar-editor {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  flex-shrink: 0;
  padding: 0;
  border: none;
  background: transparent;
}

.desktop-avatar-uploader {
  position: relative;
}

.desktop-avatar-uploader :deep(.el-upload),
.desktop-avatar-uploader :deep(.el-upload-dragger) {
  width: 44px;
  height: 44px;
  border-radius: 12px;
}

.desktop-avatar-uploader :deep(.el-upload-dragger) {
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 0;
  border: 1px solid color-mix(in srgb, var(--panda-border) 84%, transparent);
  background: color-mix(in srgb, var(--panda-card-bg) 96%, var(--panda-bg));
  overflow: hidden;
  transition: border-color 0.2s ease, background 0.2s ease, transform 0.2s ease, box-shadow 0.2s ease;
  box-shadow: 0 6px 14px -12px rgba(24, 24, 27, 0.3);
}

.desktop-avatar-uploader:hover :deep(.el-upload-dragger) {
  border-color: color-mix(in srgb, var(--panda-accent) 24%, var(--panda-border));
  background: var(--panda-card-bg);
  box-shadow: 0 8px 18px -12px rgba(24, 24, 27, 0.34);
}

.desktop-avatar-preview {
  width: 34px;
  height: 34px;
  border-radius: 10px;
  display: block;
  box-shadow: 0 8px 18px -14px rgba(24, 24, 27, 0.28);
}

.desktop-avatar-button-group {
  flex-direction: row;
  gap: 4px;
  padding-left: 0;
  align-items: center;
  flex-shrink: 0;
}

.icon-hover-mask {
  position: absolute;
  inset: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  background: rgba(24, 24, 27, 0.42);
  color: #fff;
  opacity: 0;
  transition: opacity 0.2s ease;
  border-radius: 14px;
}

.desktop-avatar-uploader:hover .icon-hover-mask {
  opacity: 1;
}

.icon-button-group {
  display: flex;
  gap: 8px;
}

.icon-action-button {
  width: 24px;
  min-width: 24px;
  height: 24px;
  padding: 0;
  border-radius: 8px;
  border: 1px solid var(--panda-border);
  background: color-mix(in srgb, var(--panda-card-bg) 96%, var(--panda-bg));
  color: var(--panda-text-sub);
}

.icon-action-button:hover {
  color: var(--panda-text-main);
  border-color: color-mix(in srgb, var(--panda-accent) 18%, var(--panda-border));
  background: var(--panda-card-bg);
}

.icon-uploader-placeholder {
  width: 100%;
  height: 100%;
  display: flex;
  align-items: center;
  justify-content: center;
  color: var(--panda-text-sub);
}

.icon-upload-text {
  display: none;
}


.icon-edit-container {
  display: flex;
  flex-direction: column;
  gap: 16px;
}

.canvas-wrapper {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 10px;
}

.canvas-wrapper canvas {
  width: 256px;
  height: 256px;
  border-radius: 20px;
  background: var(--panda-bg);
  border: 1px solid var(--panda-border);
  cursor: grab;
}

.canvas-wrapper canvas:active {
  cursor: grabbing;
}

.canvas-hint {
  font-size: 12px;
  color: var(--panda-text-sub);
}

.editor-controls {
  display: flex;
  flex-direction: column;
  gap: 12px;
}

.control-row {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.control-row .label {
  font-size: 13px;
  font-weight: 600;
  color: var(--panda-text-main);
}



.desktop-shortcut-empty {
  padding: 14px 12px;
  border-radius: 12px;
  color: var(--panda-text-sub);
  background: var(--panda-bg);
  border: 1px dashed var(--panda-border);
  font-size: 12px;
}

.voice-list-container {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  padding: 8px 0;
}

.voice-tag {
  font-size: 12px;
  height: 30px;
  padding: 0 14px;
  cursor: pointer;
  border-radius: 15px;
  border: 1px solid var(--panda-border);
  background-color: var(--panda-card-bg);
  color: var(--panda-text-main);
  font-weight: 500;
  transition: all 0.2s cubic-bezier(0.25, 0.8, 0.5, 1);
  display: inline-flex;
  align-items: center;
}

.voice-tag:hover {
  transform: scale(1.03);
  border-color: var(--panda-accent);
  background-color: var(--panda-accent);
  color: var(--panda-card-bg);
  box-shadow: 0 2px 8px rgba(0,0,0,0.1);
}

.add-voice-button {
  border: 1px dashed var(--panda-text-sub) !important;
  color: var(--panda-text-sub) !important;
  height: 30px;
  border-radius: 15px;
  padding: 0 16px;
  background-color: transparent !important;
  transition: all 0.2s;
  font-weight: 600;
  font-size: 12px;
}

.add-voice-button:hover {
  border-color: var(--panda-accent) !important;
  color: var(--panda-accent) !important;
  background-color: var(--panda-hover) !important;
}

.el-switch {
  --el-switch-on-color: var(--panda-accent);
  --el-switch-off-color: var(--panda-border);
  height: 20px;
  flex-shrink: 0;
}
:deep(.el-switch__core) {
  border: 2px solid transparent;
  background-color: var(--panda-border);
  min-width: 36px;
  height: 20px;
}
:deep(.el-switch.is-checked .el-switch__core) {
  background-color: var(--panda-accent);
  border-color: var(--panda-accent);
}
:deep(.el-switch__action) {
  width: 16px;
  height: 16px;
  box-shadow: 0 1px 2px rgba(0,0,0,0.2);
}

.el-select,
.el-input,
.el-input-number {
  flex-shrink: 0;
}

:deep(.el-input__wrapper),
:deep(.el-select__wrapper) {
  background-color: var(--panda-bg);
  box-shadow: none !important;
  border: 1px solid var(--panda-border);
  border-radius: 8px;
  padding: 4px 10px;
  height: 30px;
  transition: all 0.2s ease;
}

:deep(.el-input__inner) {
  color: var(--panda-text-main);
  font-weight: 500;
  font-size: 13px;
  height: 30px;
}

:deep(.el-input__wrapper.is-focus),
:deep(.el-select__wrapper.is-focused) {
  background-color: var(--panda-card-bg);
  border-color: var(--panda-accent);
  box-shadow: 0 0 0 1px var(--panda-accent) inset !important;
}

.el-button:not(.is-link) {
  border-radius: 8px;
  font-weight: 600;
  border: 1px solid var(--panda-border);
  color: var(--panda-text-main);
  background-color: var(--panda-card-bg);
  height: 30px;
  padding: 0 14px;
  font-size: 13px;
}

.el-button:not(.is-link):hover {
  background-color: var(--panda-hover);
  border-color: var(--panda-text-sub);
  color: var(--panda-text-main);
}

.el-button--primary:not(.is-link),
.el-button--primary.is-plain:not(.is-link) {
  background-color: var(--panda-accent) !important;
  border-color: var(--panda-accent) !important;
  color: var(--panda-card-bg) !important;
}

.el-button--primary:not(.is-link):hover,
.el-button--primary.is-plain:not(.is-link):hover {
  opacity: 0.85;
}

.webdav-actions .el-button {
  height: 32px;
  padding: 0 16px;
}

.action-buttons-container {
  display: flex;
  justify-content: center;
  align-items: center;
}

.action-buttons-container .el-divider--vertical {
  border-color: var(--panda-border);
}

.dialog-footer {
  display: flex;
  justify-content: space-between;
  align-items: center;
  width: 100%;
  padding-top: 10px;
  gap: 15px;
}

.footer-left {
  display: flex;
  align-items: center;
  gap: 0px;
  flex-shrink: 0; 
  white-space: nowrap;
}

.footer-left .el-button {
  margin: 0;
}

.footer-center {
  flex-grow: 1;
  display: flex;
  justify-content: center;
  min-width: 0; 
  overflow-x: auto;
}

.footer-center::-webkit-scrollbar {
  display: none;
}

.footer-right {
  flex-shrink: 0;
}

:deep(.el-table) {
  --el-table-border-color: var(--panda-border);
  --el-table-header-bg-color: var(--panda-bg);
  --el-table-tr-bg-color: var(--panda-card-bg);
  --el-table-text-color: var(--panda-text-main);
  border-radius: 12px;
  overflow: hidden;
  border: 1px solid var(--panda-border);
}

:deep(.el-table th.el-table__cell) {
  background-color: var(--panda-bg);
  color: var(--panda-text-sub);
  font-weight: 600;
  padding: 8px 0;
}

:deep(.el-table td.el-table__cell) {
  padding: 8px 0;
}

:deep(.el-pagination.is-background .el-pager li) {
  background-color: var(--panda-bg);
  color: var(--panda-text-sub);
  border-radius: 6px;
  min-width: 28px;
  height: 28px;
}

:deep(.el-pagination.is-background .el-pager li.is-active) {
  background-color: var(--panda-accent);
  color: var(--panda-card-bg);
}

:deep(.el-dialog) {
  background-color: var(--panda-card-bg);
  border-radius: 16px;
  border: 1px solid var(--panda-border);
}

:deep(.el-dialog__title) {
  color: var(--panda-text-main);
  font-weight: 700;
}

:deep(.backup-manager-dialog .el-dialog__header) {
  padding: 16px 20px !important;
  border-bottom: 1px solid var(--panda-border);
}

:deep(.backup-manager-dialog .el-dialog__body) {
  padding: 16px 20px !important;
}

:deep(.backup-manager-dialog .el-dialog__footer) {
  padding: 0px 20px 12px;
  background-color: var(--panda-bg);
  border-top: 1px solid var(--panda-border);
}

@media (max-width: 760px) {
  .desktop-shortcut-row {
    grid-template-columns: 1fr;
  }

  .desktop-shortcut-list-head {
    flex-direction: column;
    align-items: stretch;
  }
}

</style>
