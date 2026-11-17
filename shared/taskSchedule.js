export function normalizeScheduleTime(value) {
  if (typeof value !== 'string') return ''
  const match = value.trim().match(/^(\d{1,2}):(\d{2})$/)
  if (!match || Number(match[1]) > 23 || Number(match[2]) > 59) return ''
  return `${match[1].padStart(2, '0')}:${match[2]}`
}

export function normalizeDailyTimes(value, strict = false) {
  if (!Array.isArray(value)) {
    if (strict) throw new Error('daily_times_must_be_array')
    return []
  }
  const times = value.map(normalizeScheduleTime)
  if (strict && times.some((time) => !time)) throw new Error('daily_times_invalid_HH_mm')
  return [...new Set(times.filter(Boolean))].sort()
}

export function normalizeMonthlySchedules(value, strict = false) {
  if (!Array.isArray(value)) {
    if (strict) throw new Error('monthly_schedules_must_be_array')
    return []
  }
  const items = value.map((item) => ({ day: item?.day, time: normalizeScheduleTime(item?.time) }))
  const valid = (item) =>
    Number.isInteger(item.day) && item.day >= 1 && item.day <= 31 && !!item.time
  if (strict && items.some((item) => !valid(item)))
    throw new Error('monthly_schedules_invalid_day_or_time')
  return [
    ...new Map(items.filter(valid).map((item) => [`${item.day}:${item.time}`, item])).values()
  ].sort((a, b) => a.day - b.day || a.time.localeCompare(b.time))
}

export function getDailyTimes(task = {}) {
  return Array.isArray(task.dailyTimes)
    ? normalizeDailyTimes(task.dailyTimes)
    : normalizeDailyTimes([task.dailyTime])
}

export function getMonthlySchedules(task = {}) {
  return Array.isArray(task.monthlySchedules)
    ? normalizeMonthlySchedules(task.monthlySchedules)
    : normalizeMonthlySchedules(
        (Array.isArray(task.monthlyDays) ? task.monthlyDays : []).map((day) => ({
          day,
          time: task.monthlyTime
        }))
      )
}

// New arrays are authoritative. Legacy edits replace their corresponding array,
// while edits to unrelated task fields leave the full schedule intact.
export function normalizeTaskSchedulePatch(current = {}, patch = {}) {
  const result = { ...patch }
  if (Object.prototype.hasOwnProperty.call(patch, 'dailyTimes'))
    result.dailyTimes = normalizeDailyTimes(patch.dailyTimes, true)
  else if (Object.prototype.hasOwnProperty.call(patch, 'dailyTime'))
    result.dailyTimes = normalizeDailyTimes([patch.dailyTime], true)
  if (result.dailyTimes) result.dailyTime = result.dailyTimes[0] || ''
  if (Object.prototype.hasOwnProperty.call(patch, 'monthlySchedules'))
    result.monthlySchedules = normalizeMonthlySchedules(patch.monthlySchedules, true)
  else if (
    Object.prototype.hasOwnProperty.call(patch, 'monthlyDays') ||
    Object.prototype.hasOwnProperty.call(patch, 'monthlyTime')
  ) {
    const days = patch.monthlyDays ?? current.monthlyDays ?? []
    if (!Array.isArray(days)) throw new Error('monthly_days_must_be_array')
    result.monthlySchedules = normalizeMonthlySchedules(
      days.map((day) => ({ day, time: patch.monthlyTime ?? current.monthlyTime })),
      true
    )
  }
  if (result.monthlySchedules) {
    result.monthlyDays = [...new Set(result.monthlySchedules.map((item) => item.day))]
    result.monthlyTime = result.monthlySchedules[0]?.time || ''
  }
  return result
}

export function isCalendarTaskDue(task, date) {
  const time = `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`
  if (task.triggerType === 'daily') return getDailyTimes(task).includes(time)
  if (task.triggerType === 'monthly')
    return getMonthlySchedules(task).some(
      (item) => item.day === date.getDate() && item.time === time
    )
  return false
}

export function taskCalendarSummary(task) {
  if (task.triggerType === 'daily') return getDailyTimes(task).join('、')
  if (task.triggerType === 'monthly')
    return getMonthlySchedules(task)
      .map((item) => `${item.day}日 ${item.time}`)
      .join('、')
  return ''
}

export function applyMcpTaskSchedule(current, input, creating = false) {
  const type = input.schedule_type || current.triggerType
  if (!['interval', 'daily', 'weekly', 'monthly', 'single'].includes(type))
    throw new Error('unknown_schedule_type')
  if (input.daily_times !== undefined && type !== 'daily')
    throw new Error('daily_times_requires_daily_schedule')
  if (input.monthly_schedules !== undefined && type !== 'monthly')
    throw new Error('monthly_schedules_requires_monthly_schedule')
  if (input.daily_times !== undefined && input.time_param !== undefined)
    throw new Error('use_daily_times_or_time_param_not_both')
  if (
    input.monthly_schedules !== undefined &&
    (input.monthly_days !== undefined || input.time_param !== undefined)
  )
    throw new Error('use_monthly_schedules_or_legacy_monthly_fields_not_both')
  const patch = { triggerType: type }
  if (input.daily_times !== undefined)
    patch.dailyTimes = normalizeDailyTimes(input.daily_times, true)
  if (input.monthly_schedules !== undefined)
    patch.monthlySchedules = normalizeMonthlySchedules(input.monthly_schedules, true)
  if (input.time_param !== undefined) {
    if (type === 'interval') {
      const minutes = Number(input.time_param)
      if (!Number.isInteger(minutes) || minutes <= 0) throw new Error('invalid_interval_minutes')
      patch.intervalMinutes = minutes
    } else {
      const time = normalizeScheduleTime(input.time_param)
      if (!time) throw new Error('invalid_time_use_HH_mm')
      patch[
        { daily: 'dailyTime', weekly: 'weeklyTime', monthly: 'monthlyTime', single: 'singleTime' }[
          type
        ]
      ] = time
    }
  } else if (
    creating &&
    !(type === 'daily' && input.daily_times !== undefined) &&
    !(type === 'monthly' && input.monthly_schedules !== undefined)
  ) {
    throw new Error('time_param_required_for_this_schedule')
  }
  if (input.weekly_days !== undefined) {
    if (
      !Array.isArray(input.weekly_days) ||
      input.weekly_days.some((day) => !Number.isInteger(day) || day < 0 || day > 6)
    )
      throw new Error('invalid_weekly_days')
    patch.weeklyDays = [...new Set(input.weekly_days)].sort()
  } else if (creating && type === 'weekly') throw new Error('weekly_days_required')
  if (input.monthly_days !== undefined) patch.monthlyDays = input.monthly_days
  else if (creating && type === 'monthly' && input.monthly_schedules === undefined)
    throw new Error('monthly_days_required')
  if (input.single_date !== undefined) {
    if (typeof input.single_date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(input.single_date))
      throw new Error('invalid_single_date')
    patch.singleDate = input.single_date
  }
  const normalized = normalizeTaskSchedulePatch(current, patch)
  const next = { ...current, ...normalized }
  if (
    (type === 'daily' && !getDailyTimes(next).length) ||
    (type === 'monthly' && !getMonthlySchedules(next).length) ||
    (type === 'weekly' && !next.weeklyDays?.length)
  )
    throw new Error('schedule_requires_at_least_one_trigger')
  return normalized
}
