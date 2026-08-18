import { runTaskById } from './task_runner.js'

import { reconcileTaskDeviceState, setCurrentTaskDeviceEnabled } from './task_devices.js'

const CHECK_INTERVAL_MS = 1000
const PROCESSED_SLOT_TTL_MS = 48 * 60 * 60 * 1000
let schedulerTimer = null
let isChecking = false
const processedRunSlots = new Map()

function parseTimeToParts(value) {
  if (typeof value !== 'string') return null
  const match = value.match(/^(\d{1,2}):(\d{2})$/)
  if (!match) return null
  const hours = Number(match[1])
  const minutes = Number(match[2])
  if (!Number.isInteger(hours) || !Number.isInteger(minutes)) return null
  if (hours < 0 || hours > 23 || minutes < 0 || minutes > 59) return null
  return { hours, minutes }
}

function formatHhMm(date) {
  return `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`
}

function formatYmd(date) {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(
    date.getDate()
  ).padStart(2, '0')}`
}

function isWithinIntervalRanges(task, nowDate) {
  if (!Array.isArray(task?.intervalTimeRanges) || task.intervalTimeRanges.length === 0) {
    return true
  }

  const nowHhMm = formatHhMm(nowDate)
  return task.intervalTimeRanges.some((range) => {
    if (Array.isArray(range) && range.length === 2) {
      return nowHhMm >= range[0] && nowHhMm <= range[1]
    }
    return false
  })
}

function buildRunSlotKey(taskId, task, nowDate) {
  return `${taskId}:${task.triggerType}:${formatYmd(nowDate)}:${formatHhMm(nowDate)}`
}

function isTimestampInCurrentSlot(timestamp, nowDate) {
  const numericTimestamp = Number(timestamp || 0)
  if (!Number.isFinite(numericTimestamp) || numericTimestamp <= 0) return false
  const date = new Date(numericTimestamp)
  return formatYmd(date) === formatYmd(nowDate) && formatHhMm(date) === formatHhMm(nowDate)
}

function pruneProcessedRunSlots(now = Date.now()) {
  for (const [slotKey, timestamp] of processedRunSlots.entries()) {
    if (now - timestamp > PROCESSED_SLOT_TTL_MS) {
      processedRunSlots.delete(slotKey)
    }
  }
}

function getDueRunSlotKey(taskId, task, now, nowDate) {
  if (!task || typeof task !== 'object' || !task.enabled) return null

  const currentH = nowDate.getHours()
  const currentM = nowDate.getMinutes()
  const slotKey = buildRunSlotKey(taskId, task, nowDate)

  if (processedRunSlots.has(slotKey) || task.lastRunSlotKey === slotKey) return null
  if (isTimestampInCurrentSlot(task.lastRunTime, nowDate)) return null

  if (task.triggerType === 'interval') {
    let shouldTrigger = false

    if (task.intervalStartTime) {
      const parsedStart = parseTimeToParts(task.intervalStartTime)
      if (!parsedStart) return null

      const currentTotalMins = currentH * 60 + currentM
      const startTotalMins = parsedStart.hours * 60 + parsedStart.minutes
      const intervalMins = Math.max(Number(task.intervalMinutes || 1), 1)

      if (currentTotalMins >= startTotalMins) {
        const diffMins = currentTotalMins - startTotalMins
        shouldTrigger = diffMins % intervalMins === 0
      }
    } else {
      const lastRun = Number(task.lastRunTime || 0)
      const intervalMs = Math.max(Number(task.intervalMinutes || 1), 1) * 60000
      shouldTrigger = now - lastRun >= intervalMs
    }

    return shouldTrigger && isWithinIntervalRanges(task, nowDate) ? slotKey : null
  }

  if (task.triggerType === 'daily' && task.dailyTime) {
    const parsed = parseTimeToParts(task.dailyTime)
    return parsed && currentH === parsed.hours && currentM === parsed.minutes ? slotKey : null
  }

  if (task.triggerType === 'weekly' && task.weeklyTime && Array.isArray(task.weeklyDays)) {
    const parsed = parseTimeToParts(task.weeklyTime)
    const currentDay = nowDate.getDay()
    return parsed && task.weeklyDays.includes(currentDay) && currentH === parsed.hours && currentM === parsed.minutes
      ? slotKey
      : null
  }

  if (task.triggerType === 'monthly' && task.monthlyTime) {
    const parsed = parseTimeToParts(task.monthlyTime)
    const currentMonthDay = nowDate.getDate()
    const validDays = Array.isArray(task.monthlyDays) ? task.monthlyDays : []
    return parsed && validDays.includes(currentMonthDay) && currentH === parsed.hours && currentM === parsed.minutes
      ? slotKey
      : null
  }

  if (task.triggerType === 'single' && task.singleDate && task.singleTime) {
    const parsed = parseTimeToParts(task.singleTime)
    const currentYmd = formatYmd(nowDate)
    return parsed && currentYmd === task.singleDate && currentH === parsed.hours && currentM === parsed.minutes
      ? slotKey
      : null
  }

  return null
}

async function checkTasks({ dataApi, openWindow } = {}) {
  if (isChecking) return
  isChecking = true

  try {
    const configResult = await dataApi.getConfig()
    const config = configResult?.config && typeof configResult.config === 'object' ? configResult.config : {}
    const tasks = config?.tasks && typeof config.tasks === 'object' ? config.tasks : {}
    let needsUpdate = false

    for (const taskId of Object.keys(tasks)) {
      const now = Date.now()
      const nowDate = new Date(now)
      const task = tasks[taskId]

      const deviceState = reconcileTaskDeviceState(task)
      if (!deviceState.enabled) continue
      needsUpdate = needsUpdate || deviceState.changed
      const slotKey = getDueRunSlotKey(taskId, task, now, nowDate)
      if (!slotKey) continue

      try {
        const runResult = await runTaskById({ taskId, dataApi, openWindow })
        if (!runResult?.success) {
          console.warn(`[Task Scheduler] task ${taskId} due but window did not open:`, runResult)
          continue
        }

        const completedAt = Date.now()
        task.lastRunTime = completedAt
        task.lastRunSlotKey = slotKey
        if (task.triggerType === 'single') {
          setCurrentTaskDeviceEnabled(task, false)
        }
        processedRunSlots.set(slotKey, completedAt)
        needsUpdate = true
      } catch (error) {
        console.error(`[Task Scheduler] failed to run task ${taskId}:`, error)
      }
    }

    if (needsUpdate) {
      await dataApi.updateConfigWithoutFeatures({ config })
    }
  } catch (error) {
    console.error('[Task Scheduler] check failed:', error)
  } finally {
    pruneProcessedRunSlots()
    isChecking = false
  }
}

export function startTaskScheduler({ dataApi, openWindow } = {}) {
  if (schedulerTimer) {
    return {
      ok: true,
      started: false,
      reason: 'already_started'
    }
  }

  if (!dataApi || typeof dataApi.getConfig !== 'function') {
    return {
      ok: false,
      started: false,
      reason: 'data_api_missing'
    }
  }

  if (typeof dataApi.updateConfigWithoutFeatures !== 'function' || typeof openWindow !== 'function') {
    return {
      ok: false,
      started: false,
      reason: 'dependencies_missing'
    }
  }

  schedulerTimer = setInterval(() => {
    void checkTasks({ dataApi, openWindow })
  }, CHECK_INTERVAL_MS)
  schedulerTimer.unref?.()

  void checkTasks({ dataApi, openWindow })

  console.info('[Task Scheduler] started')
  return {
    ok: true,
    started: true
  }
}

export function stopTaskScheduler() {
  if (schedulerTimer) {
    clearInterval(schedulerTimer)
    schedulerTimer = null
  }
  isChecking = false
  processedRunSlots.clear()
}

export const __taskSchedulerInternals = {
  getDueRunSlotKey,
  parseTimeToParts,
  formatYmd,
  formatHhMm
}
