export function isConversationHidden(window = {}) {
  return window?.desktopHidden === true || window?.remoteHidden === true
}

// Electron's screen/window APIs use DIP. Compare coordinates on the display
// containing the release pointer, including displays with negative origins.
export function isConversationTrayDrop(platform, pointer, windowBounds, display) {
  if (platform !== 'win32' && platform !== 'darwin') return false
  const { bounds, workArea } = display || {}
  if (!pointer || !windowBounds || !bounds || !workArea) return false
  const { x, y } = pointer
  const right = bounds.x + bounds.width
  const bottom = bounds.y + bounds.height
  if (x < bounds.x || x >= right || y < bounds.y || y >= bottom) return false

  const workRight = workArea.x + workArea.width
  const workBottom = workArea.y + workArea.height
  const nearPointer =
    x >= right - 64 && (platform === 'win32' ? y >= bottom - 64 : y < bounds.y + 64)
  const nearWindow =
    Math.abs(windowBounds.x + windowBounds.width - workRight) <= 28 &&
    (platform === 'win32'
      ? Math.abs(windowBounds.y + windowBounds.height - workBottom) <= 28
      : Math.abs(windowBounds.y - workArea.y) <= 28)
  return nearPointer || nearWindow
}

export function visibleConversationPosition(bounds, workArea) {
  return {
    x: Math.max(workArea.x, Math.min(bounds.x, workArea.x + workArea.width - bounds.width)),
    y: Math.max(workArea.y, Math.min(bounds.y, workArea.y + workArea.height - bounds.height))
  }
}

function plainMenuTitle(value) {
  return Array.from(value, (char) => {
    const code = char.codePointAt(0)
    return code < 32 || code === 127 ? ' ' : char
  }).join('').trim()
}

export function trayConversationEntries(windows, mobileControlledWindowIds) {
  return windows.filter(isConversationHidden).map((window) => {
    const title =
      [window.conversationTitle, window.displayName]
        .filter((value) => typeof value === 'string')
        .map(plainMenuTitle)
        .find(Boolean) || '临时对话'
    return {
      windowRef: window.id,
      title: Array.from(title).slice(0, 60).join('').replaceAll('&', '&&'),
      mobile: mobileControlledWindowIds.has(window.id)
    }
  })
}
