import { globalShortcut } from 'electron'

const MANAGED_ACCELERATORS = new Set()
const MANAGED_CALLBACKS = new Map()

const MODIFIER_ALIASES = new Map([
  ['ctrl', 'Ctrl'],
  ['control', 'Ctrl'],
  ['cmdorctrl', 'CommandOrControl'],
  ['commandorcontrol', 'CommandOrControl'],
  ['command', 'Command'],
  ['cmd', 'Command'],
  ['alt', 'Alt'],
  ['option', 'Alt'],
  ['shift', 'Shift'],
  ['super', 'Super'],
  ['meta', 'Super']
])

const MODIFIER_SET = new Set(['Ctrl', 'CommandOrControl', 'Command', 'Alt', 'Shift', 'Super'])
const VALID_SPECIAL_KEYS = new Set([
  'Space',
  'Tab',
  'Enter',
  'Escape',
  'Esc',
  'Up',
  'Down',
  'Left',
  'Right',
  'Plus',
  'Minus',
  'Delete',
  'Insert',
  'Home',
  'End',
  'PageUp',
  'PageDown'
])

const SYMBOL_KEY_ALIASES = new Map([
  ['`', 'Backquote'],
  ['~', 'Backquote'],
  ['-', 'Minus'],
  ['_', 'Minus'],
  ['=', 'Equal'],
  ['+', 'Equal'],
  ['[', 'BracketLeft'],
  ['{', 'BracketLeft'],
  [']', 'BracketRight'],
  ['}', 'BracketRight'],
  ['\\', 'Backslash'],
  ['|', 'Backslash'],
  [';', 'Semicolon'],
  [':', 'Semicolon'],
  ['\'', 'Quote'],
  ['"', 'Quote'],
  [',', 'Comma'],
  ['<', 'Comma'],
  ['.', 'Period'],
  ['>', 'Period'],
  ['/', 'Slash'],
  ['?', 'Slash']
])

function uniq(items = []) {
  return [...new Set(items)]
}

function normalizeModifierToken(token = '') {
  const compact = String(token).replace(/\s+/g, '').toLowerCase()
  return MODIFIER_ALIASES.get(compact) || null
}

function normalizeKeyTokenFromCode(code = '', fallbackKey = '') {
  const normalizedCode = String(code || '').trim()
  if (!normalizedCode) return null

  const codeMap = {
    Backquote: 'Backquote',
    Minus: 'Minus',
    Equal: 'Equal',
    BracketLeft: 'BracketLeft',
    BracketRight: 'BracketRight',
    Backslash: 'Backslash',
    Semicolon: 'Semicolon',
    Quote: 'Quote',
    Comma: 'Comma',
    Period: 'Period',
    Slash: 'Slash',
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

  if (codeMap[normalizedCode]) {
    return codeMap[normalizedCode]
  }

  if (/^Key[A-Z]$/.test(normalizedCode)) {
    return normalizedCode.slice(3)
  }

  if (/^Digit[0-9]$/.test(normalizedCode)) {
    return normalizedCode.slice(5)
  }

  if (/^F([1-9]|1[0-9]|2[0-4])$/.test(normalizedCode)) {
    return normalizedCode
  }

  return normalizeKeyToken(fallbackKey)
}


function normalizeKeyToken(token = '') {
  const trimmed = String(token).trim()
  if (!trimmed) return null
  if (/^[a-zA-Z]$/.test(trimmed)) return trimmed.toUpperCase()
  if (/^[0-9]$/.test(trimmed)) return trimmed
  if (/^F([1-9]|1[0-9]|2[0-4])$/i.test(trimmed)) return trimmed.toUpperCase()
  if (VALID_SPECIAL_KEYS.has(trimmed)) return trimmed
  if (SYMBOL_KEY_ALIASES.has(trimmed)) return SYMBOL_KEY_ALIASES.get(trimmed)
  const lower = trimmed.toLowerCase()
  if (lower === 'space') return 'Space'
  if (lower === 'esc' || lower === 'escape') return 'Escape'
  if (lower === 'plus') return 'Plus'
  if (lower === 'minus') return 'Minus'
  if (lower === 'tab') return 'Tab'
  if (lower === 'enter' || lower === 'return') return 'Enter'
  if (lower === 'up') return 'Up'
  if (lower === 'down') return 'Down'
  if (lower === 'left') return 'Left'
  if (lower === 'right') return 'Right'
  if (lower === 'delete' || lower === 'del') return 'Delete'
  if (lower === 'insert' || lower === 'ins') return 'Insert'
  if (lower === 'home') return 'Home'
  if (lower === 'end') return 'End'
  if (lower === 'pageup') return 'PageUp'
  if (lower === 'pagedown') return 'PageDown'
  const normalizedSpecial = {
    backquote: 'Backquote',
    equal: 'Equal',
    bracketleft: 'BracketLeft',
    bracketright: 'BracketRight',
    backslash: 'Backslash',
    semicolon: 'Semicolon',
    quote: 'Quote',
    comma: 'Comma',
    period: 'Period',
    slash: 'Slash'
  }
  return normalizedSpecial[lower] || null
}

export function normalizeAccelerator(input = '') {
  const raw = String(input || '').trim()
  if (!raw) {
    return {
      ok: false,
      error: '快捷键不能为空'
    }
  }

  const tokens = raw.split('+').map((item) => item.trim()).filter(Boolean)
  if (tokens.length < 2) {
    return {
      ok: false,
      error: '快捷键必须包含至少一个修饰键和一个普通键'
    }
  }

  const modifiers = []
  let keyToken = null

  for (const token of tokens) {
    const modifier = normalizeModifierToken(token)
    if (modifier) {
      modifiers.push(modifier)
      continue
    }

    if (keyToken) {
      return {
        ok: false,
        error: '快捷键只能包含一个普通键'
      }
    }

    keyToken = normalizeKeyToken(token)
    if (!keyToken) {
      return {
        ok: false,
        error: `不支持的按键：${token}`
      }
    }
  }

  if (!keyToken) {
    return {
      ok: false,
      error: '快捷键缺少普通键'
    }
  }

  const uniqueModifiers = uniq(modifiers)
  if (uniqueModifiers.length === 0) {
    return {
      ok: false,
      error: '快捷键必须包含至少一个修饰键'
    }
  }

  if (uniqueModifiers.some((token) => !MODIFIER_SET.has(token))) {
    return {
      ok: false,
      error: '快捷键包含不支持的修饰键'
    }
  }

  const accelerator = [...uniqueModifiers, keyToken].join('+')
  return {
    ok: true,
    accelerator
  }
}

function unregisterManagedShortcuts() {
  for (const accelerator of MANAGED_ACCELERATORS.values()) {
    globalShortcut.unregister(accelerator)
  }
  MANAGED_ACCELERATORS.clear()
  MANAGED_CALLBACKS.clear()
}

function registerManagedShortcut(accelerator, callback) {
  const success = globalShortcut.register(accelerator, callback)
  if (!success) {
    throw new Error(`快捷键注册失败，可能已被系统或其他程序占用：${accelerator}`)
  }
  MANAGED_ACCELERATORS.add(accelerator)
  MANAGED_CALLBACKS.set(accelerator, callback)
}

function collectBindings(desktopConfig = {}) {
  const shortcuts = desktopConfig?.shortcuts && typeof desktopConfig.shortcuts === 'object'
    ? desktopConfig.shortcuts
    : {}

  const bindings = []

  bindings.push({
    id: 'mainToggle',
    kind: 'mainToggle',
    label: '主界面快捷键',
    accelerator: shortcuts.mainToggle || 'Ctrl+Space',
    enabled: true
  })

  bindings.push({
    id: 'quickSummon',
    kind: 'quickSummon',
    label: '召唤快捷键',
    accelerator: shortcuts.quickSummon || 'Alt+A',
    enabled: true
  })

  bindings.push({
    id: 'appendFollowUp',
    kind: 'appendFollowUp',
    label: '自动追问快捷键',
    accelerator: shortcuts.appendFollowUp || 'Alt+S',
    enabled: true
  })

  const promptBindings = Array.isArray(shortcuts.promptBindings) ? shortcuts.promptBindings : []
  promptBindings.forEach((item, index) => {
    if (!item || item.enabled === false) return
    bindings.push({
      id: item.id || `prompt-${index}`,
      kind: 'promptBinding',
      label: `快捷助手快捷键 ${item.promptKey || index + 1}`,
      accelerator: item.accelerator || '',
      promptKey: item.promptKey || '',
      enabled: true
    })
  })

  return bindings
}

export function validateDesktopShortcuts(desktopConfig = {}) {
  const bindings = collectBindings(desktopConfig)
  const usedAccelerators = new Map()
  const normalizedBindings = []

  for (const binding of bindings) {
    const normalized = normalizeAccelerator(binding.accelerator)
    if (!normalized.ok) {
      return {
        ok: false,
        error: `${binding.label}：${normalized.error}`
      }
    }

    if (binding.kind === 'promptBinding' && !binding.promptKey) {
      return {
        ok: false,
        error: '快捷助手快捷键必须绑定到具体的快捷助手'
      }
    }

    const conflict = usedAccelerators.get(normalized.accelerator)
    if (conflict) {
      return {
        ok: false,
        error: `快捷键冲突：${binding.label} 与 ${conflict} 都使用了 ${normalized.accelerator}`
      }
    }

    usedAccelerators.set(normalized.accelerator, binding.label)
    normalizedBindings.push({
      ...binding,
      accelerator: normalized.accelerator
    })
  }

  const nextPromptBindings = (Array.isArray(desktopConfig?.shortcuts?.promptBindings)
    ? desktopConfig.shortcuts.promptBindings
    : []
  ).map((item, index) => {
    const normalized = normalizeAccelerator(item?.accelerator || '')
    return {
      id: item?.id || `prompt-${index}`,
      promptKey: item?.promptKey || '',
      enabled: item?.enabled !== false,
      accelerator: normalized.ok ? normalized.accelerator : item?.accelerator || ''
    }
  })

  return {
    ok: true,
    normalizedDesktop: {
      closeToTray: desktopConfig?.closeToTray !== false,
      shortcuts: {
        mainToggle: normalizedBindings.find((item) => item.kind === 'mainToggle')?.accelerator || 'Ctrl+Space',
        quickSummon: normalizedBindings.find((item) => item.kind === 'quickSummon')?.accelerator || 'Alt+A',
        appendFollowUp: normalizedBindings.find((item) => item.kind === 'appendFollowUp')?.accelerator || 'Alt+S',
        promptBindings: nextPromptBindings
      }
    },
    bindings: normalizedBindings
  }
}

export function syncDesktopShortcuts(desktopConfig = {}, handlers = {}) {
  const validated = validateDesktopShortcuts(desktopConfig)
  if (!validated.ok) {
    throw new Error(validated.error)
  }

  unregisterManagedShortcuts()

  try {
    validated.bindings.forEach((binding) => {
      if (binding.kind === 'mainToggle') {
        registerManagedShortcut(binding.accelerator, () => {
          handlers?.onMainToggle?.()
        })
        return
      }

      if (binding.kind === 'quickSummon') {
        registerManagedShortcut(binding.accelerator, () => {
          handlers?.onQuickSummon?.()
        })
        return
      }

      if (binding.kind === 'appendFollowUp') {
        registerManagedShortcut(binding.accelerator, () => {
          handlers?.onAppendFollowUp?.()
        })
        return
      }

      if (binding.kind === 'promptBinding') {
        registerManagedShortcut(binding.accelerator, () => {
          handlers?.onPromptTrigger?.(binding.promptKey)
        })
      }
    })
  } catch (error) {
    unregisterManagedShortcuts()
    throw error
  }

  return {
    ok: true,
    desktop: validated.normalizedDesktop,
    bindings: validated.bindings.map((item) => ({
      kind: item.kind,
      accelerator: item.accelerator,
      promptKey: item.promptKey || null
    }))
  }
}

export function clearDesktopShortcuts() {
  unregisterManagedShortcuts()
}

export function getRegisteredDesktopShortcuts() {
  return [...MANAGED_ACCELERATORS]
}
