import { runTaskById } from './task_runner.js'

const CHECK_INTERVAL_MS = 1000
let schedulerTimer = null
let lastCheckMinute = Math.floor(Date.now() / 60000)
let isChecking = false

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

function shouldTriggerTask(task, now, nowDate) {
  if (!task || typeof task !== 'object' || !task.enabled) return false

  const lastRun = Number(task.lastRunTime || 0)
  const safeCooldown = now - lastRun > 60000
  const currentH = nowDate.getHours()
  const currentM = nowDate.getMinutes()

  if (task.triggerType === 'interval') {
    let shouldTrigger = false

    if (task.intervalStartTime) {
      const parsedStart = parseTimeToParts(task.intervalStartTime)
      if (!parsedStart) return false

      const currentTotalMins = currentH * 60 + currentM
      const startTotalMins = parsedStart.hours * 60 + parsedStart.minutes
      const intervalMins = Math.max(Number(task.intervalMinutes || 1), 1)

      if (currentTotalMins >= startTotalMins) {
        const diffMins = currentTotalMins - startTotalMins
        if (diffMins % intervalMins === 0 && safeCooldown) {
          shouldTrigger = true
        }
      }
    } else {
      const intervalMs = Math.max(Number(task.intervalMinutes || 1), 1) * 60000
      if (now - lastRun >= intervalMs) {
        shouldTrigger = true
      }
    }

    return shouldTrigger && isWithinIntervalRanges(task, nowDate)
  }

  if (task.triggerType === 'daily' && task.dailyTime) {
    const parsed = parseTimeToParts(task.dailyTime)
    return Boolean(parsed && currentH === parsed.hours && currentM === parsed.minutes && safeCooldown)
  }

  if (task.triggerType === 'weekly' && task.weeklyTime && Array.isArray(task.weeklyDays)) {
    const parsed = parseTimeToParts(task.weeklyTime)
    const currentDay = nowDate.getDay()
    return Boolean(
      parsed &&
        task.weeklyDays.includes(currentDay) &&
        currentH === parsed.hours &&
        currentM === parsed.minutes &&
        safeCooldown
    )
  }

  if (task.triggerType === 'monthly' && task.monthlyTime) {
    const parsed = parseTimeToParts(task.monthlyTime)
    const currentMonthDay = nowDate.getDate()
    const validDays = Array.isArray(task.monthlyDays) ? task.monthlyDays : []
    return Boolean(
      parsed &&
        validDays.includes(currentMonthDay) &&
        currentH === parsed.hours &&
        currentM === parsed.minutes &&
        safeCooldown
    )
  }

  if (task.triggerType === 'single' && task.singleDate && task.singleTime) {
    const parsed = parseTimeToParts(task.singleTime)
    const currentYmd = formatYmd(nowDate)
    return Boolean(
      parsed &&
        currentYmd === task.singleDate &&
        currentH === parsed.hours &&
        currentM === parsed.minutes &&
        safeCooldown
    )
  }

  return false
}

async function checkTasks({ dataApi, openWindow } = {}) {
  if (isChecking) return
  isChecking = true

  try {
    const currentMinute = Math.floor(Date.now() / 60000)
    if (currentMinute <= lastCheckMinute) return
    lastCheckMinute = currentMinute

    const configResult = await dataApi.getConfig()
    const config = configResult?.config && typeof configResult.config === 'object' ? configResult.config : {}
    const tasks = config?.tasks && typeof config.tasks === 'object' ? config.tasks : {}
    const now = Date.now()
    const nowDate = new Date(now)
    let needsUpdate = false

    for (const taskId of Object.keys(tasks)) {
      const task = tasks[taskId]
      if (!shouldTriggerTask(task, now, nowDate)) continue

      task.lastRunTime = now
      if (task.triggerType === 'single') {
        task.enabled = false
      }
      needsUpdate = true

      try {
        await runTaskById({ taskId, dataApi, openWindow })
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

  lastCheckMinute = Math.floor(Date.now() / 60000)
  schedulerTimer = setInterval(() => {
    void checkTasks({ dataApi, openWindow })
  }, CHECK_INTERVAL_MS)
  schedulerTimer.unref?.()

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
}

export const __taskSchedulerInternals = {
  shouldTriggerTask,
  parseTimeToParts,
  formatYmd,
  formatHhMm
}
