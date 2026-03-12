const WINDOW_EVENT_CHANNEL = 'window:event-bus'

function createEnvelope({ sourceId, target, event, payload }) {
  return {
    sourceId: sourceId || null,
    target: target || 'broadcast',
    event,
    payload: payload ?? null,
    timestamp: Date.now()
  }
}

function sendToWindow(win, envelope) {
  if (!win || win.isDestroyed()) return false

  try {
    win.webContents.send(WINDOW_EVENT_CHANNEL, envelope)
    return true
  } catch {
    return false
  }
}

export function dispatchWindowEvent(
  { sourceId, target = 'broadcast', event, payload },
  { getWindowByRef, listWindows }
) {
  if (!event || typeof event !== 'string') {
    throw new Error('[eventBus] event is required')
  }

  const normalizedTarget = typeof target === 'string' && target.trim() ? target.trim() : 'broadcast'
  const envelope = createEnvelope({ sourceId, target: normalizedTarget, event, payload })

  if (normalizedTarget === 'broadcast' || normalizedTarget === '*') {
    const windows = listWindows()
    let delivered = 0

    for (const item of windows) {
      const win = getWindowByRef(item.id)
      if (sendToWindow(win, envelope)) delivered += 1
    }

    return {
      ok: true,
      mode: 'broadcast',
      delivered,
      event,
      target: normalizedTarget
    }
  }

  if (normalizedTarget.startsWith('type:')) {
    const targetType = normalizedTarget.slice(5)
    const windows = listWindows(targetType)
    let delivered = 0

    for (const item of windows) {
      const win = getWindowByRef(item.id)
      if (sendToWindow(win, envelope)) delivered += 1
    }

    return {
      ok: true,
      mode: 'type',
      delivered,
      event,
      target: normalizedTarget
    }
  }

  const targetWindow = getWindowByRef(normalizedTarget)
  if (!targetWindow) {
    return {
      ok: false,
      mode: 'direct',
      delivered: 0,
      event,
      target: normalizedTarget,
      reason: 'target_not_found'
    }
  }

  const delivered = sendToWindow(targetWindow, envelope) ? 1 : 0

  return {
    ok: delivered > 0,
    mode: 'direct',
    delivered,
    event,
    target: normalizedTarget,
    reason: delivered > 0 ? null : 'target_send_failed'
  }
}

export { WINDOW_EVENT_CHANNEL }
