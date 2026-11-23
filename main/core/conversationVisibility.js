export function isConversationHidden(window = {}) {
  return window?.desktopHidden === true || window?.remoteHidden === true
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
