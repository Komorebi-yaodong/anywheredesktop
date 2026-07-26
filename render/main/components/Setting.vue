<script setup>
import { ref, onMounted, onActivated, onDeactivated, onBeforeUnmount, computed, inject, h, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { Upload, UploadFilled, FolderOpened, Refresh, Delete as DeleteIcon, Download, Plus, ArrowRight, Check, Warning, Remove, Edit } from '@element-plus/icons-vue'
import { ElMessage, ElMessageBox, ElInput } from 'element-plus'
import { reactive, nextTick } from 'vue'
import draggable from 'vuedraggable'

const { t, locale } = useI18n()

const currentConfig = inject('config');

const SKILL_WEBDAV_MAX_PACKAGE_SIZE = 50 * 1024 * 1024
const skillSyncProgressVisible = ref(false)
const skillSyncProgress = reactive({
  token: '',
  callbackToken: '',
  current: 0,
  total: 0,
  completed: 0,
  success: 0,
  failed: 0,
  phase: '',
  skillId: '',
  cancelled: false,
  results: []
})
let stopSkillSyncProgressListener = null

function createSkillSyncToken(prefix = 'skill-sync') {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2)}`
}

function resetSkillSyncProgress(total = 0) {
  skillSyncProgress.token = createSkillSyncToken('skill-sync-signal')
  skillSyncProgress.callbackToken = createSkillSyncToken('skill-sync-callback')
  skillSyncProgress.current = 0
  skillSyncProgress.total = total
  skillSyncProgress.completed = 0
  skillSyncProgress.success = 0
  skillSyncProgress.failed = 0
  skillSyncProgress.phase = ''
  skillSyncProgress.skillId = ''
  skillSyncProgress.cancelled = false
  skillSyncProgress.results = []
}

function applySkillSyncProgress(payload = {}) {
  if (!payload || typeof payload !== 'object') return
  if (Number.isFinite(payload.total)) skillSyncProgress.total = payload.total
  if (Number.isFinite(payload.current)) skillSyncProgress.current = payload.current
  if (Number.isFinite(payload.completed)) skillSyncProgress.completed = payload.completed
  if (typeof payload.phase === 'string') skillSyncProgress.phase = payload.phase
  if (typeof payload.skillId === 'string') skillSyncProgress.skillId = payload.skillId
  if (payload.result && typeof payload.result === 'object') {
    skillSyncProgress.results = [...skillSyncProgress.results, payload.result]
    skillSyncProgress.success = skillSyncProgress.results.filter(item => item.ok).length
    skillSyncProgress.failed = skillSyncProgress.results.filter(item => !item.ok).length
  }
}

const skillSyncProgressPercent = computed(() => {
  if (!skillSyncProgress.total) return 0
  return Math.min(100, Math.round((skillSyncProgress.completed / skillSyncProgress.total) * 100))
})

function cancelSkillWebdavSync() {
  if (!skillSyncProgress.token || skillSyncProgress.cancelled) return
  skillSyncProgress.cancelled = true
  window.api.abortSignal?.(skillSyncProgress.token)
}

function bindSkillSyncProgressListener() {
  if (stopSkillSyncProgressListener) stopSkillSyncProgressListener()
  stopSkillSyncProgressListener = window.api.onWindowCallback?.((event = {}) => {
    if (event?.token !== skillSyncProgress.callbackToken) return
    applySkillSyncProgress(event.payload || {})
  }) || null
}

function unbindSkillSyncProgressListener() {
  if (stopSkillSyncProgressListener) {
    stopSkillSyncProgressListener()
    stopSkillSyncProgressListener = null
  }
}

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


function resolveToggleFocusedWindowAutoCloseFallbackShortcut(shortcuts = {}, currentValue = '') {
  const occupied = new Set()

  const pushShortcut = (value = '') => {
    const normalized = toDisplayShortcut(value)
    if (normalized) occupied.add(normalized)
  }

  pushShortcut(shortcuts?.mainToggle)
  pushShortcut(shortcuts?.quickSummon)
  pushShortcut(shortcuts?.appendFollowUp)

  const promptBindings = Array.isArray(shortcuts?.promptBindings) ? shortcuts.promptBindings : []
  promptBindings.forEach((item) => {
    if (item?.enabled === false) return
    pushShortcut(item?.accelerator)
  })

  const normalizedCurrent = toDisplayShortcut(currentValue)
  if (normalizedCurrent && !['Alt+F', 'Alt+Shift+F'].includes(normalizedCurrent)) {
    return normalizedCurrent
  }
  if (normalizedCurrent && !occupied.has(normalizedCurrent)) {
    return normalizedCurrent
  }

  if (!occupied.has('Alt+F')) return 'Alt+F'
  if (!occupied.has('Alt+Shift+F')) return 'Alt+Shift+F'
  return ''
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
  } else if (shortcutRecorder.value.target === 'toggleFocusedWindowAutoClose') {
    currentConfig.value.desktop.shortcuts.toggleFocusedWindowAutoClose = accelerator
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

onActivated(() => {
  window.addEventListener('keydown', handleShortcutRecorderKeydown, true)
})

onDeactivated(() => {
  stopShortcutRecording()
  window.removeEventListener('keydown', handleShortcutRecorderKeydown, true)
})

watch(() => currentConfig.value, (newVal) => {
  if (newVal) {
    ensureDesktopConfig();
    ensureDesktopProfileConfig();
    initCardOrder();
  }
}, { once: true });


onBeforeUnmount(() => {
  stopShortcutRecording()
  unbindSkillSyncProgressListener()
  window.removeEventListener('keydown', handleShortcutRecorderKeydown, true)
  window.removeEventListener('mouseup', stopSelectableDrag)
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
    ElMessage.error(t('setting.desktop.profile.avatar.invalidFile'))
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
  if (typeof currentConfig.value.desktop.shortcuts.toggleFocusedWindowAutoClose !== 'string') {
    currentConfig.value.desktop.shortcuts.toggleFocusedWindowAutoClose = resolveToggleFocusedWindowAutoCloseFallbackShortcut(currentConfig.value.desktop.shortcuts)
  } else {
    currentConfig.value.desktop.shortcuts.toggleFocusedWindowAutoClose = resolveToggleFocusedWindowAutoCloseFallbackShortcut(
      currentConfig.value.desktop.shortcuts,
      currentConfig.value.desktop.shortcuts.toggleFocusedWindowAutoClose
    )
  }

  currentConfig.value.desktop.shortcuts.mainToggle = toDisplayShortcut(currentConfig.value.desktop.shortcuts.mainToggle) || 'Ctrl+Space'
  currentConfig.value.desktop.shortcuts.quickSummon = toDisplayShortcut(currentConfig.value.desktop.shortcuts.quickSummon) || 'Alt+A'
  currentConfig.value.desktop.shortcuts.appendFollowUp = toDisplayShortcut(currentConfig.value.desktop.shortcuts.appendFollowUp) || 'Alt+S'
  currentConfig.value.desktop.shortcuts.toggleFocusedWindowAutoClose = toDisplayShortcut(currentConfig.value.desktop.shortcuts.toggleFocusedWindowAutoClose)
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
      label: t('setting.desktop.appendFollowUp.label'),
      accelerator: currentConfig.value.desktop.shortcuts.appendFollowUp
    }
  ]

  const toggleFocusedWindowAutoCloseShortcut = toDisplayShortcut(currentConfig.value.desktop.shortcuts.toggleFocusedWindowAutoClose)
  if (toggleFocusedWindowAutoCloseShortcut) {
    bindings.push({
      label: t('setting.desktop.toggleFocusedWindowAutoClose.label'),
      accelerator: toggleFocusedWindowAutoCloseShortcut
    })
  }

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
  currentConfig.value.desktop.shortcuts.toggleFocusedWindowAutoClose = toggleFocusedWindowAutoCloseShortcut
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

    if (window.api && window.api.getCompactCache) {
      try {
        const compactCache = await window.api.getCompactCache();
        const models = compactCache?.models && typeof compactCache.models === 'object'
          ? compactCache.models
          : null;
        if (models && Object.keys(models).length > 0) {
          configToExport.compactCache = { models };
        }
      } catch (error) {
        console.warn('[exportConfig] compact cache export skipped:', error);
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

    if (importedData.compactCache && window.api && window.api.importCompactCache) {
      const compactModels = importedData.compactCache?.models && typeof importedData.compactCache.models === 'object'
        ? importedData.compactCache.models
        : (typeof importedData.compactCache === 'object' ? importedData.compactCache : {});
      const compactResult = await window.api.importCompactCache(compactModels);
      if (compactResult && compactResult.ok === false) {
        throw new Error(getErrorMessage(compactResult, 'import compact cache failed'));
      }
      delete importedData.compactCache;
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

            if (window.api && window.api.getCompactCache) {
              try {
                const compactCache = await window.api.getCompactCache();
                const models = compactCache?.models && typeof compactCache.models === 'object'
                  ? compactCache.models
                  : null;
                if (models && Object.keys(models).length > 0) {
                  configToBackup.compactCache = { models };
                }
              } catch (error) {
                console.warn('[backupToWebdav] compact cache export skipped:', error);
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
    const result = await window.api?.listWebdavBackups?.(
      buildWebdavInput({ includeSessionMetadata: false })
    )

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

    if (importedData.compactCache && window.api && window.api.importCompactCache) {
      const compactModels = importedData.compactCache?.models && typeof importedData.compactCache.models === 'object'
        ? importedData.compactCache.models
        : (typeof importedData.compactCache === 'object' ? importedData.compactCache : {});
      const compactResult = await window.api.importCompactCache(compactModels);
      if (compactResult && compactResult.ok === false) {
        throw new Error(getErrorMessage(compactResult, 'import compact cache failed'));
      }
      delete importedData.compactCache;
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


async function selectSkillStoragePath() {
  const path = await window.api.selectDirectory();
  if (path) {
    currentConfig.value.skillPath = path;
    saveSingleSetting('skillPath', path);
  }
}

async function selectLocalChatPath() {
  const path = await window.api.selectDirectory();
  if (path) {
    currentConfig.value.webdav.localChatPath = path;
    saveSingleSetting('webdav.localChatPath', path);
  }
}


const skillWebdavDialogVisible = ref(false)
const skillWebdavManagerVisible = ref(false)
const skillWebdavLoading = ref(false)
const skillWebdavSyncSelection = ref([])
const skillWebdavCloudSelection = ref([])
const cloudSkillFiles = ref([])


const selectableDragState = reactive({
  active: false,
  mode: '',
  targetSelected: true,
  lastIndex: {
    sync: -1,
    cloud: -1
  }
})

function getSelectableItems(mode) {
  return mode === 'cloud' ? cloudSkillFiles.value : (currentConfig.value.__localSkillCandidates || [])
}

function getSelectableSelectionRef(mode) {
  return mode === 'cloud' ? skillWebdavCloudSelection : skillWebdavSyncSelection
}

function getSelectableId(item = {}) {
  return String(item?.id || '').trim()
}

function isSelectableSelected(mode, id) {
  return getSelectableSelectionRef(mode).value.includes(id)
}

function setSelectableSelection(mode, ids = []) {
  const next = Array.from(new Set(ids.map(id => String(id || '').trim()).filter(Boolean)))
  getSelectableSelectionRef(mode).value = next
}

function setSelectableItemSelected(mode, item, selected) {
  if (skillWebdavLoading.value) return
  const id = getSelectableId(item)
  if (!id) return
  const current = new Set(getSelectableSelectionRef(mode).value)
  if (selected) current.add(id)
  else current.delete(id)
  setSelectableSelection(mode, Array.from(current))
}

function toggleSelectableItem(mode, item, selected = undefined) {
  const id = getSelectableId(item)
  if (!id) return
  const nextSelected = typeof selected === 'boolean' ? selected : !isSelectableSelected(mode, id)
  setSelectableItemSelected(mode, item, nextSelected)
}

function selectSelectableRange(mode, fromIndex, toIndex, selected = true) {
  const items = getSelectableItems(mode)
  const start = Math.max(0, Math.min(fromIndex, toIndex))
  const end = Math.min(items.length - 1, Math.max(fromIndex, toIndex))
  const current = new Set(getSelectableSelectionRef(mode).value)
  for (let index = start; index <= end; index += 1) {
    const id = getSelectableId(items[index])
    if (!id) continue
    if (selected) current.add(id)
    else current.delete(id)
  }
  setSelectableSelection(mode, Array.from(current))
}

function handleSelectableMouseDown(mode, item, index, event) {
  if (skillWebdavLoading.value || event?.button !== 0) return
  event?.preventDefault?.()
  if (event?.shiftKey && selectableDragState.lastIndex[mode] >= 0) {
    selectSelectableRange(mode, selectableDragState.lastIndex[mode], index, true)
    selectableDragState.lastIndex[mode] = index
    return
  }
  const targetSelected = !isSelectableSelected(mode, getSelectableId(item))
  selectableDragState.active = true
  selectableDragState.mode = mode
  selectableDragState.targetSelected = targetSelected
  selectableDragState.lastIndex[mode] = index
  toggleSelectableItem(mode, item, targetSelected)
  window.addEventListener('mouseup', stopSelectableDrag, { once: true })
}

function handleSelectableMouseEnter(mode, item) {
  if (!selectableDragState.active || selectableDragState.mode !== mode || skillWebdavLoading.value) return
  toggleSelectableItem(mode, item, selectableDragState.targetSelected)
}

function stopSelectableDrag() {
  selectableDragState.active = false
  selectableDragState.mode = ''
}

function selectAllSelectable(mode) {
  if (skillWebdavLoading.value) return
  setSelectableSelection(mode, getSelectableItems(mode).map(getSelectableId))
}

function clearSelectableSelection(mode) {
  if (skillWebdavLoading.value) return
  setSelectableSelection(mode, [])
}

function invertSelectableSelection(mode) {
  if (skillWebdavLoading.value) return
  const current = new Set(getSelectableSelectionRef(mode).value)
  const next = getSelectableItems(mode)
    .map(getSelectableId)
    .filter(id => id && !current.has(id))
  setSelectableSelection(mode, next)
}

function getSelectedCloudSkillRows() {
  const selectedIds = new Set(skillWebdavCloudSelection.value)
  return cloudSkillFiles.value.filter(item => selectedIds.has(getSelectableId(item)))
}

function sleep(ms = 0) {
  return new Promise(resolve => window.setTimeout(resolve, ms))
}

async function runSkillTasksWithConcurrency(items, worker, concurrency = 1, options = {}) {
  const queue = [...items]
  const results = []
  const workerCount = Math.min(Math.max(1, concurrency), queue.length || 1)
  const retries = Number.isFinite(options.retries) ? Math.max(0, options.retries) : 2
  const retryDelay = Number.isFinite(options.retryDelay) ? Math.max(0, options.retryDelay) : 350

  await Promise.all(Array.from({ length: workerCount }, async () => {
    while (queue.length) {
      const item = queue.shift()
      let lastError = null
      for (let attempt = 0; attempt <= retries; attempt += 1) {
        try {
          const result = await worker(item, attempt)
          results.push({ ...result, attempts: attempt + 1 })
          lastError = null
          break
        } catch (error) {
          lastError = error
          if (attempt < retries) await sleep(retryDelay * (attempt + 1))
        }
      }
      if (lastError) results.push({ ok: false, item, error: lastError, attempts: retries + 1 })
      await sleep(80)
    }
  }))
  return results
}

const localSkillOptions = computed(() => {
  if (!currentConfig.value?.skillPath) return []
  return []
})

function resolveSkillWebdavRemotePath(skillId = '') {
  const basePath = String(currentConfig.value?.webdav?.path || '/anywhere').trim() || '/anywhere'
  const normalizedBase = basePath.endsWith('/') ? basePath.slice(0, -1) : basePath
  return `${normalizedBase}/skill${skillId ? `/${skillId}` : ''}`
}

async function loadLocalSkillCandidates() {
  const root = String(currentConfig.value?.skillPath || '').trim()
  if (!root) {
    skillWebdavSyncSelection.value = []
    return []
  }
  try {
    const list = await window.api.listSkills(root)
    return Array.isArray(list) ? list : []
  } catch (error) {
    ElMessage.error(`${t('skills.alerts.listFailed')}: ${error.message}`)
    return []
  }
}

async function openSkillWebdavSyncDialog() {
  if (!currentConfig.value?.skillPath) {
    ElMessage.warning(t('skills.pathNotSet'))
    return
  }
  const skills = await loadLocalSkillCandidates()
  skillWebdavSyncSelection.value = skills.map(item => item.id)
  currentConfig.value.__localSkillCandidates = skills
  skillWebdavDialogVisible.value = true
}

async function uploadSelectedSkillsToWebdav() {
  const skillRootPath = String(currentConfig.value?.skillPath || '').trim()
  if (!skillRootPath) {
    ElMessage.warning(t('skills.pathNotSet'))
    return
  }
  if (!skillWebdavSyncSelection.value.length) {
    ElMessage.warning(t('common.noFileSelected'))
    return
  }

  const selectedIds = [...skillWebdavSyncSelection.value]
  resetSkillSyncProgress(selectedIds.length)
  bindSkillSyncProgressListener()
  skillWebdavLoading.value = true
  skillSyncProgressVisible.value = true
  try {
    const result = await window.api.uploadSkillsToWebdav({
      skillRootPath,
      skillIds: selectedIds,
      remotePath: resolveSkillWebdavRemotePath(),
      maxPackageSizeBytes: SKILL_WEBDAV_MAX_PACKAGE_SIZE,
      meta: {
        signalToken: skillSyncProgress.token,
        callbackToken: skillSyncProgress.callbackToken
      },
      webdavConfig: resolveWebdavBackupConfig()
    })
    const results = Array.isArray(result?.results) ? result.results : []
    skillSyncProgress.results = results
    skillSyncProgress.completed = results.length
    skillSyncProgress.success = results.filter(item => item.ok).length
    skillSyncProgress.failed = results.filter(item => !item.ok).length
    if (skillSyncProgress.failed > 0) {
      ElMessage.warning(`Skill 同步完成：成功 ${skillSyncProgress.success} 个，失败 ${skillSyncProgress.failed} 个`)
    } else {
      ElMessage.success(`已同步 ${skillSyncProgress.success} 个 Skill 到云端`)
      skillWebdavDialogVisible.value = false
    }
  } catch (error) {
    if (skillSyncProgress.cancelled) {
      ElMessage.warning(`已取消同步，已完成 ${skillSyncProgress.completed}/${skillSyncProgress.total}`)
    } else {
      ElMessage.error(`Skill 同步失败：${error.message}`)
    }
  } finally {
    skillWebdavLoading.value = false
    unbindSkillSyncProgressListener()
  }
}

async function fetchCloudSkills() {
  skillWebdavLoading.value = true
  try {
    const result = await window.api.listSkillsFromWebdav({
      remotePath: resolveSkillWebdavRemotePath(),
      webdavConfig: resolveWebdavBackupConfig()
    })
    cloudSkillFiles.value = Array.isArray(result?.skills) ? result.skills : []
    const availableIds = new Set(cloudSkillFiles.value.map(item => item.id))
    skillWebdavCloudSelection.value = skillWebdavCloudSelection.value.filter(id => availableIds.has(id))
  } catch (error) {
    cloudSkillFiles.value = []
    ElMessage.error(`获取云端 Skill 失败：${error.message}`)
  } finally {
    skillWebdavLoading.value = false
  }
}

async function openSkillWebdavManager() {
  skillWebdavManagerVisible.value = true
  await fetchCloudSkills()
}

async function deleteSelectedCloudSkills() {
  if (!skillWebdavCloudSelection.value.length) {
    ElMessage.warning(t('common.noFileSelected'))
    return
  }
  await ElMessageBox.confirm(`确定删除选中的 ${skillWebdavCloudSelection.value.length} 个云端 Skill 吗？`, t('common.warningTitle'), { type: 'warning' })
  skillWebdavLoading.value = true
  try {
    await window.api.deleteSkillsFromWebdav({
      skillIds: [...skillWebdavCloudSelection.value],
      remotePath: resolveSkillWebdavRemotePath(),
      webdavConfig: resolveWebdavBackupConfig()
    })
    skillWebdavCloudSelection.value = []
    await fetchCloudSkills()
    ElMessage.success(t('common.deleteSuccess'))
  } finally {
    skillWebdavLoading.value = false
  }
}

async function pullCloudSkillWorker(skill, skillRootPath) {
  await window.api.pullSkillFromWebdav({
    skillId: skill.id,
    skillRootPath,
    remotePath: resolveSkillWebdavRemotePath(),
    webdavConfig: resolveWebdavBackupConfig()
  })
  return { ok: true, skillId: skill.id }
}

async function pullCloudSkillToLocal(skill) {
  const skillRootPath = String(currentConfig.value?.skillPath || '').trim()
  if (!skillRootPath) {
    ElMessage.warning(t('skills.pathNotSet'))
    return
  }
  skillWebdavLoading.value = true
  try {
    await pullCloudSkillWorker(skill, skillRootPath)
    ElMessage.success('已拉取到本地')
  } catch (error) {
    ElMessage.error(`拉取 Skill 失败：${error.message}`)
  } finally {
    skillWebdavLoading.value = false
  }
}

async function pullSelectedCloudSkillsToLocal() {
  const skillRootPath = String(currentConfig.value?.skillPath || '').trim()
  if (!skillRootPath) {
    ElMessage.warning(t('skills.pathNotSet'))
    return
  }
  const selectedRows = getSelectedCloudSkillRows()
  if (!selectedRows.length) {
    ElMessage.warning(t('common.noFileSelected'))
    return
  }
  skillWebdavLoading.value = true
  try {
    const results = await runSkillTasksWithConcurrency(
      selectedRows,
      async (skill) => pullCloudSkillWorker(skill, skillRootPath),
      1,
      { retries: 2, retryDelay: 500 }
    )
    const success = results.filter(item => item.ok).length
    const failed = results.length - success
    if (failed > 0) {
      const failedNames = results
        .filter(item => !item.ok)
        .map(item => item?.item?.id || item?.skillId || 'unknown')
        .slice(0, 5)
        .join('、')
      ElMessage.warning(`拉取完成：成功 ${success} 个，失败 ${failed} 个${failedNames ? `（${failedNames}）` : ''}`)
    } else {
      ElMessage.success(`拉取完成：成功 ${success} 个`)
    }
  } catch (error) {
    ElMessage.error(`批量拉取 Skill 失败：${error.message}`)
  } finally {
    skillWebdavLoading.value = false
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
                      <el-button class="shortcut-record-btn" :class="{ 'is-recording': shortcutRecorder.active && shortcutRecorder.target === 'mainToggle' }" @click="startShortcutRecording('mainToggle')">
                        {{ shortcutRecorder.active && shortcutRecorder.target === 'mainToggle' ? t('setting.desktop.mainToggle.placeholder') : toDisplayShortcut(currentConfig.desktop.shortcuts.mainToggle) || t('setting.desktop.mainToggle.placeholder') }}
                      </el-button>
                    </div>

                    <div class="setting-option-item">
                      <div class="setting-text-content">
                        <span class="setting-option-label">{{ t('setting.desktop.quickSummon.label') }}</span>
                        <span class="setting-option-description">{{ t('setting.desktop.quickSummon.description') }}</span>
                      </div>
                      <el-button class="shortcut-record-btn" :class="{ 'is-recording': shortcutRecorder.active && shortcutRecorder.target === 'quickSummon' }" @click="startShortcutRecording('quickSummon')">
                        {{ shortcutRecorder.active && shortcutRecorder.target === 'quickSummon' ? t('setting.desktop.quickSummon.placeholder') : toDisplayShortcut(currentConfig.desktop.shortcuts.quickSummon) || t('setting.desktop.quickSummon.placeholder') }}
                      </el-button>
                    </div>

                    <div class="setting-option-item">
                      <div class="setting-text-content">
                        <span class="setting-option-label">{{ t('setting.desktop.appendFollowUp.label') }}</span>
                        <span class="setting-option-description">{{ t('setting.desktop.appendFollowUp.description') }}</span>
                      </div>
                      <el-button class="shortcut-record-btn" :class="{ 'is-recording': shortcutRecorder.active && shortcutRecorder.target === 'appendFollowUp' }" @click="startShortcutRecording('appendFollowUp')">
                        {{ shortcutRecorder.active && shortcutRecorder.target === 'appendFollowUp' ? t('setting.desktop.appendFollowUp.placeholder') : toDisplayShortcut(currentConfig.desktop.shortcuts.appendFollowUp) || t('setting.desktop.appendFollowUp.placeholder') }}
                      </el-button>
                    </div>


                    <div class="setting-option-item">
                      <div class="setting-text-content">
                        <span class="setting-option-label">{{ t('setting.desktop.toggleFocusedWindowAutoClose.label') }}</span>
                        <span class="setting-option-description">{{ t('setting.desktop.toggleFocusedWindowAutoClose.description') }}</span>
                      </div>
                      <el-button class="shortcut-record-btn" :class="{ 'is-recording': shortcutRecorder.active && shortcutRecorder.target === 'toggleFocusedWindowAutoClose' }" @click="startShortcutRecording('toggleFocusedWindowAutoClose')">
                        {{ shortcutRecorder.active && shortcutRecorder.target === 'toggleFocusedWindowAutoClose' ? t('setting.desktop.toggleFocusedWindowAutoClose.placeholder') : toDisplayShortcut(currentConfig.desktop.shortcuts.toggleFocusedWindowAutoClose) || t('setting.desktop.toggleFocusedWindowAutoClose.placeholder') }}
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
                        <el-button class="shortcut-record-btn small" :class="{ 'is-recording': shortcutRecorder.active && shortcutRecorder.target === 'promptBinding' && shortcutRecorder.index === index }" @click="startShortcutRecording('promptBinding', index)">
                          {{ shortcutRecorder.active && shortcutRecorder.target === 'promptBinding' && shortcutRecorder.index === index ? t('setting.desktop.promptShortcuts.shortcutPlaceholder') : (toDisplayShortcut(binding.accelerator) || t('setting.desktop.promptShortcuts.shortcutPlaceholder')) }}
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
                    <div class="setting-option-item">
                      <div class="setting-text-content">
                        <span class="setting-option-label">{{ t('setting.dataManagement.localSkillPath') }}</span>
                        <span class="setting-option-description">{{ t('setting.dataManagement.localSkillPathPlaceholder') }}</span>
                      </div>
                      <el-input v-model="currentConfig.skillPath"
                        @change="(value) => saveSingleSetting('skillPath', value)"
                        :placeholder="t('setting.dataManagement.localSkillPathPlaceholder')" style="width: 320px;">
                        <template #append>
                          <el-button @click="selectSkillStoragePath">{{ t('setting.webdav.selectFolder') }}</el-button>
                        </template>
                      </el-input>
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

                    <div class="setting-option-item">
                      <div class="setting-text-content">
                        <span class="setting-option-label">Skill WebDAV</span>
                        <span class="setting-option-description">将本地 Skill 同步到 `WebDAV 配置路径/skill/`，或管理云端 Skill 备份</span>
                      </div>
                      <div class="webdav-actions" style="display: flex; gap: 12px;">
                        <el-button @click="openSkillWebdavSyncDialog" :icon="Upload" plain>同步到 WebDAV</el-button>
                        <el-button @click="openSkillWebdavManager" :icon="FolderOpened" plain>管理备份</el-button>
                      </div>
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

<el-dialog v-model="skillWebdavDialogVisible" title="同步 Skill 到 WebDAV" width="620px" top="4vh" :close-on-click-modal="false" class="skill-webdav-sync-dialog">
      <div class="selectable-toolbar">
        <span class="selectable-count">已选 {{ skillWebdavSyncSelection.length }} / {{ (currentConfig.__localSkillCandidates || []).length }}</span>
        <div class="selectable-actions">
          <el-button size="small" text @click="selectAllSelectable('sync')" :disabled="skillWebdavLoading">全选</el-button>
          <el-button size="small" text @click="clearSelectableSelection('sync')" :disabled="skillWebdavLoading">清空</el-button>
          <el-button size="small" text @click="invertSelectableSelection('sync')" :disabled="skillWebdavLoading">反选</el-button>
        </div>
      </div>
      <el-scrollbar max-height="300px" class="selectable-list-scroll skill-sync-list-scroll">
        <div class="selectable-list" :class="{ 'is-disabled': skillWebdavLoading }">
          <div
            v-for="(skill, index) in (currentConfig.__localSkillCandidates || [])"
            :key="skill.id"
            class="selectable-row"
            :class="{ 'is-selected': isSelectableSelected('sync', skill.id) }"
            @mousedown="handleSelectableMouseDown('sync', skill, index, $event)"
            @mouseenter="handleSelectableMouseEnter('sync', skill)"
          >
            <el-checkbox :model-value="isSelectableSelected('sync', skill.id)" @click.prevent />
            <div class="selectable-main">
              <div class="selectable-title">{{ skill.name || skill.id }}</div>
              <div class="selectable-subtitle">{{ skill.id }}</div>
            </div>
          </div>
        </div>
      </el-scrollbar>
      <div class="selectable-hint">提示：点击行可切换选择，按住鼠标拖过多行可批量选择/取消，Shift + 点击可范围选择。</div>
      <template #footer>
        <el-button @click="skillWebdavDialogVisible = false" :disabled="skillWebdavLoading">{{ t('common.cancel') }}</el-button>
        <el-button type="primary" :loading="skillWebdavLoading" @click="uploadSelectedSkillsToWebdav">同步</el-button>
      </template>
    </el-dialog>

    <el-dialog v-model="skillSyncProgressVisible" title="Skill 云端同步进度" width="520px" top="8vh" :close-on-click-modal="false" :show-close="!skillWebdavLoading">
      <div class="skill-sync-progress-panel">
        <el-progress :percentage="skillSyncProgressPercent" :status="skillSyncProgress.failed > 0 ? 'warning' : undefined" />
        <div class="skill-sync-progress-meta">
          <span>已处理 {{ skillSyncProgress.completed }} / {{ skillSyncProgress.total }}</span>
          <span>成功 {{ skillSyncProgress.success }}，失败 {{ skillSyncProgress.failed }}</span>
        </div>
        <div class="skill-sync-current" v-if="skillWebdavLoading">
          当前：{{ skillSyncProgress.skillId || '-' }}
          <span v-if="skillSyncProgress.phase">（{{ skillSyncProgress.phase }}）</span>
        </div>
        <el-alert v-if="skillSyncProgress.cancelled" title="正在取消同步，已开始的当前任务会尽快停止" type="warning" :closable="false" show-icon />
        <el-scrollbar v-if="skillSyncProgress.results.some(item => !item.ok)" max-height="140px" class="skill-sync-failures">
          <div v-for="item in skillSyncProgress.results.filter(row => !row.ok)" :key="item.skillId" class="skill-sync-failure-row">
            <strong>{{ item.skillId }}</strong>
            <span>{{ item.message || '同步失败' }}</span>
          </div>
        </el-scrollbar>
      </div>
      <template #footer>
        <el-button v-if="skillWebdavLoading" type="warning" plain @click="cancelSkillWebdavSync" :disabled="skillSyncProgress.cancelled">取消同步</el-button>
        <el-button v-else @click="skillSyncProgressVisible = false">{{ t('common.close') }}</el-button>
      </template>
    </el-dialog>

<el-dialog v-model="skillWebdavManagerVisible" title="云端 Skill 管理" width="860px" top="6vh" :close-on-click-modal="false" class="skill-cloud-manager-dialog">
      <div v-loading="skillWebdavLoading" class="cloud-skill-manager-panel">
        <div class="selectable-toolbar">
          <span class="selectable-count">已选 {{ skillWebdavCloudSelection.length }} / {{ cloudSkillFiles.length }}</span>
          <div class="selectable-actions">
            <el-button size="small" text @click="selectAllSelectable('cloud')" :disabled="skillWebdavLoading">全选</el-button>
            <el-button size="small" text @click="clearSelectableSelection('cloud')" :disabled="skillWebdavLoading">清空</el-button>
            <el-button size="small" text @click="invertSelectableSelection('cloud')" :disabled="skillWebdavLoading">反选</el-button>
          </div>
        </div>
        <div class="cloud-skill-header">
          <span></span>
          <span>名称</span>
          <span>ID</span>
          <span>更新时间</span>
          <span>操作</span>
        </div>
        <el-scrollbar max-height="320px" class="selectable-list-scroll cloud-skill-scroll">
          <div class="selectable-list" :class="{ 'is-disabled': skillWebdavLoading }">
            <div
              v-for="(skill, index) in cloudSkillFiles"
              :key="skill.id"
              class="selectable-row cloud-skill-row"
              :class="{ 'is-selected': isSelectableSelected('cloud', skill.id) }"
              @mousedown="handleSelectableMouseDown('cloud', skill, index, $event)"
              @mouseenter="handleSelectableMouseEnter('cloud', skill)"
            >
              <el-checkbox :model-value="isSelectableSelected('cloud', skill.id)" @click.prevent />
              <div class="cloud-skill-name">
                <div class="selectable-title">{{ skill.name || skill.id }}</div>
                <div v-if="skill.description" class="selectable-subtitle">{{ skill.description }}</div>
              </div>
              <div class="cloud-skill-id">{{ skill.id }}</div>
              <div class="cloud-skill-time">{{ formatDate(skill.updatedAt) }}</div>
              <div class="cloud-skill-actions">
                <el-button link type="primary" @mousedown.stop @click="pullCloudSkillToLocal(skill)">拉取</el-button>
              </div>
            </div>
          </div>
        </el-scrollbar>
        <div class="selectable-hint">提示：点击行/拖过多行可多选，Shift + 点击可范围选择；“拉取选中”会并发拉取所选 Skill。</div>
      </div>
      <template #footer>
        <div class="dialog-footer">
          <div class="footer-left">
            <el-button :icon="Refresh" @click="fetchCloudSkills" :disabled="skillWebdavLoading"></el-button>
          </div>
          <div class="footer-right">
            <el-button type="primary" plain @click="pullSelectedCloudSkillsToLocal" :disabled="skillWebdavCloudSelection.length === 0" :loading="skillWebdavLoading">拉取选中</el-button>
            <el-button type="danger" plain :icon="DeleteIcon" @click="deleteSelectedCloudSkills" :disabled="skillWebdavCloudSelection.length === 0 || skillWebdavLoading">{{ t('common.deleteSelected') }}</el-button>
            <el-button @click="skillWebdavManagerVisible = false" :disabled="skillWebdavLoading">{{ t('common.close') }}</el-button>
          </div>
        </div>
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

.skill-sync-progress-panel {
  display: flex;
  flex-direction: column;
  gap: 12px;
}

.skill-sync-progress-meta {
  display: flex;
  justify-content: space-between;
  color: var(--panda-text-sub);
  font-size: 13px;
}

.skill-sync-current {
  color: var(--panda-text-main);
  font-size: 13px;
  background: var(--panda-bg);
  border: 1px solid var(--panda-border);
  border-radius: 8px;
  padding: 8px 10px;
}

.skill-sync-failures {
  border: 1px solid var(--panda-border);
  border-radius: 8px;
  background: var(--panda-bg);
}

.skill-sync-failure-row {
  display: flex;
  flex-direction: column;
  gap: 3px;
  padding: 8px 10px;
  font-size: 12px;
  color: var(--panda-text-sub);
  border-bottom: 1px solid var(--panda-border);
}

.skill-sync-failure-row:last-child {
  border-bottom: none;
}

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
  display: grid;
  grid-template-columns: 46px auto;
  align-items: center;
  column-gap: 8px;
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
  width: 36px;
  height: 36px;
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
  display: grid;
  grid-template-columns: repeat(2, 24px);
  justify-content: start;
  gap: 6px;
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
  gap: 6px;
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
:deep(.el-input__count-inner){
  background-color: transparent !important;
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

.selectable-toolbar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
  margin-bottom: 12px;
  padding: 10px 12px;
  border: 1px solid var(--panda-border, var(--el-border-color));
  border-radius: 10px;
  background: color-mix(in srgb, var(--panda-card-bg, var(--el-fill-color)) 72%, transparent);
}

.selectable-count {
  font-size: 13px;
  font-weight: 600;
  color: var(--panda-text-sub, var(--el-text-color-secondary));
}

.selectable-actions {
  display: flex;
  align-items: center;
  gap: 6px;
  flex-wrap: wrap;
}

.selectable-list-scroll {
  border: 1px solid var(--panda-border, var(--el-border-color));
  border-radius: 12px;
  background-color: var(--panda-bg, var(--el-fill-color-light));
  box-shadow: inset 0 1px 0 rgba(255, 255, 255, 0.04);
}

.selectable-list {
  padding: 10px;
  user-select: none;
}

.selectable-list.is-disabled {
  opacity: 0.64;
  pointer-events: none;
}

.selectable-row {
  display: flex;
  align-items: center;
  gap: 12px;
  min-height: 48px;
  padding: 10px 12px;
  border: 1px solid transparent;
  border-radius: 10px;
  cursor: pointer;
  transition: background-color 0.18s ease, box-shadow 0.18s ease, border-color 0.18s ease, transform 0.18s ease;
}

.selectable-row + .selectable-row {
  margin-top: 6px;
}

.selectable-row:hover {
  background-color: color-mix(in srgb, var(--panda-card-bg, var(--el-fill-color)) 88%, transparent);
  border-color: color-mix(in srgb, var(--panda-border, var(--el-border-color)) 78%, transparent);
}

.selectable-row.is-selected {
  background: linear-gradient(180deg, rgba(64, 158, 255, 0.12) 0%, rgba(64, 158, 255, 0.08) 100%);
  border-color: rgba(64, 158, 255, 0.42);
  box-shadow: 0 10px 24px -22px rgba(64, 158, 255, 0.9), 0 0 0 1px rgba(64, 158, 255, 0.18) inset;
}

.selectable-main {
  min-width: 0;
  flex: 1;
}

.selectable-title {
  font-size: 14px;
  font-weight: 600;
  line-height: 1.35;
  color: var(--panda-text-main, var(--el-text-color-primary));
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.selectable-subtitle {
  margin-top: 4px;
  font-size: 12px;
  line-height: 1.4;
  color: var(--panda-text-sub, var(--el-text-color-secondary));
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.selectable-hint {
  margin-top: 10px;
  font-size: 12px;
  line-height: 1.5;
  color: var(--panda-text-sub, var(--el-text-color-secondary));
}

:deep(.skill-webdav-sync-dialog .el-dialog__header) {
  padding: 16px 20px 10px;
}

:deep(.skill-webdav-sync-dialog .el-dialog__body) {
  padding: 10px 20px 12px;
}

:deep(.skill-webdav-sync-dialog .el-dialog__footer) {
  padding: 10px 20px 16px;
  border-top: 1px solid var(--panda-border, var(--el-border-color));
}

.skill-webdav-sync-dialog .selectable-toolbar {
  margin-bottom: 10px;
}

.skill-webdav-sync-dialog .selectable-hint {
  margin-top: 10px;
}

.skill-webdav-sync-dialog .selectable-row {
  min-height: 46px;
  padding: 10px 12px;
}

.skill-webdav-sync-dialog .selectable-list {
  padding: 8px;
}

.cloud-skill-manager-panel {
  min-height: 180px;
}

.cloud-skill-header,
.cloud-skill-row {
  display: grid;
  grid-template-columns: 40px minmax(220px, 1.6fr) minmax(160px, 1.05fr) 158px 72px;
  align-items: center;
  column-gap: 14px;
}

.cloud-skill-header {
  padding: 2px 16px 10px 16px;
  font-size: 12px;
  font-weight: 600;
  letter-spacing: 0;
  color: var(--panda-text-sub, var(--el-text-color-secondary));
}

.cloud-skill-row {
  min-height: 62px;
}

.cloud-skill-name,
.cloud-skill-id,
.cloud-skill-time {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.cloud-skill-id {
  font-family: monospace;
  font-size: 12px;
  color: var(--panda-text-sub, var(--el-text-color-secondary));
}

.cloud-skill-time {
  font-size: 12px;
  color: var(--panda-text-sub, var(--el-text-color-secondary));
}

.cloud-skill-actions {
  display: flex;
  justify-content: center;
}



/* Settings experience refinement: visual-only, preserves ordering and persistence logic. */
.settings-page-container {
  --panda-bg: #f5f7fb;
  --panda-card-bg: rgba(255, 255, 255, 0.9);
  --panda-text-main: #18181b;
  --panda-text-sub: #71717a;
  --panda-accent: #2563eb;
  --panda-border: rgba(24, 24, 27, 0.1);
  --panda-hover: rgba(37, 99, 235, 0.055);
  --panda-shadow: 0 18px 40px -34px rgba(15, 23, 42, 0.36), inset 0 1px 0 rgba(255, 255, 255, 0.8);
  position: relative;
}

html.dark .settings-page-container {
  --panda-bg: rgba(9, 9, 11, 0.54);
  --panda-card-bg: rgba(24, 24, 27, 0.78);
  --panda-text-main: #f4f4f5;
  --panda-text-sub: #a1a1aa;
  --panda-accent: #60a5fa;
  --panda-border: rgba(255, 255, 255, 0.095);
  --panda-hover: rgba(96, 165, 250, 0.1);
  --panda-shadow: 0 22px 44px -34px rgba(0, 0, 0, 0.78), inset 0 1px 0 rgba(255, 255, 255, 0.04);
}

.settings-scrollbar-wrapper {
  max-width: 1060px;
}

.settings-content {
  padding: 8px clamp(4px, 1.5vw, 16px) 64px;
}

.draggable-list {
  gap: 14px;
}

.settings-card {
  border-radius: 18px;
  border-color: var(--panda-border);
  background: var(--panda-card-bg);
  box-shadow: var(--panda-shadow);
  backdrop-filter: blur(16px) saturate(132%);
  -webkit-backdrop-filter: blur(16px) saturate(132%);
  transition: transform 0.22s ease, border-color 0.22s ease, box-shadow 0.22s ease;
}

.settings-card:hover {
  transform: translateY(-2px);
  border-color: color-mix(in srgb, var(--panda-accent) 28%, var(--panda-border));
  box-shadow: 0 22px 46px -34px rgba(15, 23, 42, 0.5), inset 0 1px 0 rgba(255, 255, 255, 0.76);
}

html.dark .settings-card:hover {
  box-shadow: 0 24px 48px -32px rgba(0, 0, 0, 0.8), inset 0 1px 0 rgba(255, 255, 255, 0.045);
}

.card-header {
  min-height: 58px;
  padding: 15px 18px 15px 20px;
  border-bottom-color: var(--panda-border);
  background: linear-gradient(105deg, color-mix(in srgb, var(--panda-bg) 64%, transparent), transparent 62%);
  transition: background-color 0.18s ease, color 0.18s ease;
}

.card-header:hover {
  background: linear-gradient(105deg, var(--panda-hover), transparent 70%);
}

.card-header:focus-visible {
  outline: 2px solid color-mix(in srgb, var(--panda-accent) 70%, transparent);
  outline-offset: -3px;
}

.card-header > span,
.card-header :deep(span) {
  font-size: 15px;
  font-weight: 720;
  letter-spacing: -0.025em;
}

.collapse-icon {
  width: 28px;
  height: 28px;
  padding: 5px;
  border: 1px solid var(--panda-border);
  background: color-mix(in srgb, var(--panda-bg) 78%, transparent);
  color: var(--panda-text-sub);
}

.collapse-icon.is-expanded {
  background: linear-gradient(135deg, #2563eb, #4f46e5);
  border-color: transparent;
  color: #ffffff;
  box-shadow: 0 8px 16px -12px rgba(37, 99, 235, 0.92);
}

.card-body {
  padding: 8px 16px 16px;
}

.setting-option-item {
  min-height: 62px;
  padding: 12px 14px;
  margin-bottom: 4px;
  border-radius: 12px;
  border-color: transparent;
  transition: background-color 0.18s ease, border-color 0.18s ease, transform 0.18s ease;
}

.setting-option-item:hover {
  border-color: color-mix(in srgb, var(--panda-border) 78%, var(--panda-accent));
  background-color: var(--panda-hover);
}

.setting-option-item:focus-within {
  border-color: color-mix(in srgb, var(--panda-accent) 58%, var(--panda-border));
  background-color: var(--panda-hover);
}

.setting-text-content {
  gap: 4px;
}

.setting-option-label {
  font-size: 13px;
  font-weight: 680;
  letter-spacing: -0.012em;
}

.setting-option-description {
  max-width: 620px;
  font-size: 12px;
  line-height: 1.5;
}

.desktop-shortcut-list {
  margin: 14px 4px 2px;
  padding: 14px;
  gap: 10px;
  border: 1px solid var(--panda-border);
  border-radius: 14px;
  background: color-mix(in srgb, var(--panda-bg) 74%, transparent);
}

.desktop-shortcut-list-head {
  padding: 2px 2px 8px;
}

.desktop-shortcut-row {
  border-radius: 12px;
  background: color-mix(in srgb, var(--panda-card-bg) 86%, var(--panda-bg));
  transition: border-color 0.18s ease, box-shadow 0.18s ease;
}

.desktop-shortcut-row:focus-within {
  border-color: color-mix(in srgb, var(--panda-accent) 52%, var(--panda-border));
  box-shadow: 0 12px 24px -22px color-mix(in srgb, var(--panda-accent) 64%, transparent);
}

.shortcut-record-btn {
  min-height: 34px;
  border-style: dashed !important;
  font-family: ui-monospace, SFMono-Regular, Consolas, 'Liberation Mono', monospace;
  font-size: 12px !important;
  letter-spacing: 0.015em;
  transition: border-color 0.18s ease, color 0.18s ease, background-color 0.18s ease, box-shadow 0.18s ease;
}

.shortcut-record-btn:hover {
  border-color: color-mix(in srgb, var(--panda-accent) 62%, var(--panda-border)) !important;
  background: var(--panda-hover) !important;
}

.shortcut-record-btn.is-recording {
  color: #ffffff !important;
  border-style: solid !important;
  border-color: transparent !important;
  background: linear-gradient(135deg, #2563eb, #4f46e5) !important;
  box-shadow: 0 10px 20px -14px rgba(37, 99, 235, 0.92);
  animation: shortcut-recording-pulse 1.35s ease-in-out infinite;
}

:deep(.el-input__wrapper),
:deep(.el-select__wrapper) {
  min-height: 34px;
  border-radius: 10px;
  border-color: var(--panda-border);
  background: color-mix(in srgb, var(--panda-bg) 84%, transparent);
}

:deep(.el-input__wrapper:hover),
:deep(.el-select__wrapper:hover) {
  border-color: color-mix(in srgb, var(--panda-accent) 40%, var(--panda-border));
}

:deep(.el-input__wrapper.is-focus),
:deep(.el-select__wrapper.is-focused) {
  border-color: var(--panda-accent);
  box-shadow: 0 0 0 3px color-mix(in srgb, var(--panda-accent) 18%, transparent) !important;
}

.el-button:not(.is-link) {
  min-height: 32px;
  border-radius: 10px;
  transition: transform 0.16s ease, border-color 0.16s ease, background-color 0.16s ease, box-shadow 0.16s ease;
}

.el-button:not(.is-link):hover {
  transform: translateY(-1px);
  border-color: color-mix(in srgb, var(--panda-accent) 42%, var(--panda-border));
}

.el-button:not(.is-link):active {
  transform: translateY(0) scale(0.98);
}

:deep(.el-switch__core) {
  box-shadow: inset 0 1px 2px rgba(0, 0, 0, 0.14);
}

:deep(.el-switch.is-checked .el-switch__core) {
  background: linear-gradient(135deg, #2563eb, #4f46e5);
}

@keyframes shortcut-recording-pulse {
  50% { box-shadow: 0 0 0 5px rgba(37, 99, 235, 0.12), 0 10px 20px -14px rgba(37, 99, 235, 0.92); }
}

@media (prefers-reduced-motion: reduce) {
  .settings-card,
  .setting-option-item,
  .shortcut-record-btn,
  .el-button:not(.is-link) {
    transition: none;
  }

  .shortcut-record-btn.is-recording {
    animation: none;
  }
}

</style>
