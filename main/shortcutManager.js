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

const ELECTRON_ACCELERATOR_KEY_MAP = new Map([
  ['Backquote', '`'],
  ['Minus', '-'],
  ['Equal', '='],
  ['BracketLeft', '['],
  ['BracketRight', ']'],
  ['Backslash', '\\'],
  ['Semicolon', ';'],
  ['Quote', "'"],
  ['Comma', ','],
  ['Period', '.'],
  ['Slash', '/']
])

const ELECTRON_ACCELERATOR_CANDIDATES = new Map([
  ['Space', ['Space', 'space']],
  ['Escape', ['Escape', 'Esc']],
  ['Plus', ['Plus']],
  ['Minus', ['-', 'Minus']],
  ['Backquote', ['`', 'Backquote']],
  ['Equal', ['=', 'Equal']],
  ['BracketLeft', ['[', 'BracketLeft']],
  ['BracketRight', [']', 'BracketRight']],
  ['Backslash', ['\\', 'Backslash']],
  ['Semicolon', [';', 'Semicolon']],
  ['Quote', ["'", 'Quote']],
  ['Comma', [',', 'Comma']],
  ['Period', ['.', 'Period']],
  ['Slash', ['/', 'Slash']]
])

const WINDOWS_RESERVED_ACCELERATOR_HINTS = new Map([
  ['Alt+Space', 'Windows 会优先将 Alt+Space 交给系统窗口菜单，通常无法作为稳定的全局快捷键。建议改用 Ctrl+Space、Alt+A 等组合。']
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

function toElectronAcceleratorCandidates(input = '') {
  const normalized = normalizeAccelerator(input)
  if (!normalized.ok) {
    return normalized
  }

  const tokens = normalized.accelerator.split('+').map((item) => item.trim()).filter(Boolean)
  const keyToken = tokens[tokens.length - 1] || ''
  const fallbackKey = ELECTRON_ACCELERATOR_KEY_MAP.get(keyToken) || keyToken
  const keyCandidates = ELECTRON_ACCELERATOR_CANDIDATES.get(keyToken) || [fallbackKey]
  const modifiers = tokens.slice(0, -1)
  const accelerators = uniq(
    keyCandidates
      .map((candidate) => [...modifiers, candidate].join('+'))
      .filter(Boolean)
  )

  return {
    ok: true,
    normalizedAccelerator: normalized.accelerator,
    accelerators
  }
}

function unregisterManagedShortcuts() {
  for (const accelerator of MANAGED_ACCELERATORS.values()) {
    globalShortcut.unregister(accelerator)
  }
  MANAGED_ACCELERATORS.clear()
  MANAGED_CALLBACKS.clear()
}

function buildRegisterFailureMessage(bindingLabel = '', normalizedAccelerator = '', attemptedAccelerators = []) {
  const attemptedList = uniq(attemptedAccelerators).filter(Boolean)
  const attemptedText = attemptedList.length > 0 ? `（已尝试：${attemptedList.join(' / ')}）` : ''
  const windowsReservedHint = process.platform === 'win32'
    ? WINDOWS_RESERVED_ACCELERATOR_HINTS.get(normalizedAccelerator) || ''
    : ''
  const reasonText = windowsReservedHint || `快捷键注册失败，可能已被系统或其他程序占用：${normalizedAccelerator}`
  return `${bindingLabel}：${reasonText}${attemptedText}`
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

  bindings.push({
    id: 'toggleFocusedWindowAutoClose',
    kind: 'toggleFocusedWindowAutoClose',
    label: '独立窗口失焦自动关闭快捷键',
    accelerator: typeof shortcuts.toggleFocusedWindowAutoClose === 'string'
      ? shortcuts.toggleFocusedWindowAutoClose
      : 'Alt+F',
    enabled: true
  })

  return bindings
}

export function validateDesktopShortcuts(desktopConfig = {}, options = {}) {
  const allowConflicts = options?.allowConflicts === true
  const warnings = []
  const bindings = collectBindings(desktopConfig)
  const usedAccelerators = new Map()
  const normalizedBindings = []

  for (const binding of bindings) {
    if (binding.kind === 'toggleFocusedWindowAutoClose' && !String(binding.accelerator || '').trim()) {
      normalizedBindings.push({
        ...binding,
        accelerator: ''
      })
      continue
    }

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
      const conflictMessage = `快捷键冲突：${binding.label} 与 ${conflict} 都使用了 ${normalized.accelerator}`
      if (!allowConflicts) {
        return {
          ok: false,
          error: conflictMessage
        }
      }
      warnings.push(conflictMessage)
    }

    if (!conflict) usedAccelerators.set(normalized.accelerator, binding.label)
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
        toggleFocusedWindowAutoClose: normalizedBindings.find((item) => item.kind === 'toggleFocusedWindowAutoClose')?.accelerator ?? 'Alt+F',
        promptBindings: nextPromptBindings
      }
    },
    bindings: normalizedBindings,
    warnings
  }
}

export function syncDesktopShortcuts(desktopConfig = {}, handlers = {}) {
  const validated = validateDesktopShortcuts(desktopConfig, { allowConflicts: true })
  if (!validated.ok) {
    throw new Error(validated.error)
  }

  unregisterManagedShortcuts()

  const warnings = [...(Array.isArray(validated.warnings) ? validated.warnings : [])]
  const registeredBindings = []

  validated.bindings.forEach((binding) => {
    if (binding.kind === 'toggleFocusedWindowAutoClose' && !String(binding.accelerator || '').trim()) {
      return
    }

    const electronAccelerators = toElectronAcceleratorCandidates(binding.accelerator)
    if (!electronAccelerators.ok) {
      warnings.push(`${binding.label}：${electronAccelerators.error}`)
      return
    }

    let registeredElectronAccelerator = ''

    try {
      const attemptedAccelerators = []
      for (const candidate of electronAccelerators.accelerators) {
        attemptedAccelerators.push(candidate)
        try {
          if (binding.kind === 'mainToggle') {
            registerManagedShortcut(candidate, () => {
              handlers?.onMainToggle?.()
            })
          } else if (binding.kind === 'quickSummon') {
            registerManagedShortcut(candidate, () => {
              handlers?.onQuickSummon?.()
            })
          } else if (binding.kind === 'appendFollowUp') {
            registerManagedShortcut(candidate, () => {
              handlers?.onAppendFollowUp?.()
            })
          } else if (binding.kind === 'toggleFocusedWindowAutoClose') {
            registerManagedShortcut(candidate, () => {
              handlers?.onToggleFocusedWindowAutoClose?.()
            })
          } else if (binding.kind === 'promptBinding') {
            registerManagedShortcut(candidate, () => {
              handlers?.onPromptTrigger?.(binding.promptKey)
            })
          }

          registeredElectronAccelerator = candidate
          break
        } catch {
          // try next accelerator candidate
        }
      }

      if (!registeredElectronAccelerator) {
        throw new Error(
          buildRegisterFailureMessage(
            binding.label,
            electronAccelerators.normalizedAccelerator,
            attemptedAccelerators
          )
        )
      }

      registeredBindings.push({
        ...binding,
        electronAccelerator: registeredElectronAccelerator
      })
    } catch (error) {
      warnings.push(error?.message || `${binding.label}：快捷键注册失败`)
    }
  })

  return {
    ok: true,
    desktop: validated.normalizedDesktop,
    bindings: registeredBindings.map((item) => ({
      kind: item.kind,
      accelerator: item.accelerator,
      electronAccelerator: item.electronAccelerator,
      promptKey: item.promptKey || null
    })),
    warnings
  }
}

export function clearDesktopShortcuts() {
  unregisterManagedShortcuts()
}

export function getRegisteredDesktopShortcuts() {
  return [...MANAGED_ACCELERATORS]
}
