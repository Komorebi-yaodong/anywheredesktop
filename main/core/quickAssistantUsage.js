const MAX_ACTIVE_USAGE_DAYS = 7

function normalizeDateKey(value = '') {
  return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value) ? value : ''
}

export function getLocalDateKey(date = new Date()) {
  const value = date instanceof Date ? date : new Date(date)
  if (Number.isNaN(value.getTime())) return ''
  const year = value.getFullYear()
  const month = String(value.getMonth() + 1).padStart(2, '0')
  const day = String(value.getDate()).padStart(2, '0')
  return `${year}-${month}-${day}`
}

export function normalizeQuickAssistantUsage(value = {}) {
  const source = value && typeof value === 'object' && !Array.isArray(value) ? value : {}
  const activeDates = [...new Set((Array.isArray(source.activeDates) ? source.activeDates : [])
    .map(normalizeDateKey)
    .filter(Boolean))]
    .sort()
    .slice(-MAX_ACTIVE_USAGE_DAYS)
  const activeDateSet = new Set(activeDates)
  const prompts = {}

  for (const [promptKey, rawCounts] of Object.entries(source.prompts || {})) {
    if (typeof promptKey !== 'string' || !promptKey.trim() || !rawCounts || typeof rawCounts !== 'object' || Array.isArray(rawCounts)) continue
    const counts = {}
    for (const [dateKey, rawCount] of Object.entries(rawCounts)) {
      const count = Math.floor(Number(rawCount))
      if (activeDateSet.has(dateKey) && Number.isFinite(count) && count > 0) {
        counts[dateKey] = count
      }
    }
    if (Object.keys(counts).length > 0) prompts[promptKey] = counts
  }

  return { activeDates, prompts }
}

export function recordQuickAssistantUsage(value = {}, promptKey = '', date = new Date()) {
  const normalizedPromptKey = typeof promptKey === 'string' ? promptKey.trim() : ''
  const dateKey = getLocalDateKey(date)
  const usage = normalizeQuickAssistantUsage(value)
  if (!normalizedPromptKey || !dateKey) return usage

  const activeDates = [...usage.activeDates]
  if (!activeDates.includes(dateKey)) activeDates.push(dateKey)
  activeDates.sort()
  const keptDates = activeDates.slice(-MAX_ACTIVE_USAGE_DAYS)
  const activeDateSet = new Set(keptDates)
  const prompts = {}

  for (const [key, counts] of Object.entries(usage.prompts)) {
    const retainedCounts = Object.fromEntries(Object.entries(counts).filter(([keyDate]) => activeDateSet.has(keyDate)))
    if (Object.keys(retainedCounts).length > 0) prompts[key] = retainedCounts
  }

  prompts[normalizedPromptKey] = {
    ...(prompts[normalizedPromptKey] || {}),
    [dateKey]: Math.max(0, Math.floor(Number(prompts[normalizedPromptKey]?.[dateKey]) || 0)) + 1
  }

  return { activeDates: keptDates, prompts }
}

export function getQuickAssistantWeight(value = {}, promptKey = '') {
  const normalizedPromptKey = typeof promptKey === 'string' ? promptKey.trim() : ''
  if (!normalizedPromptKey) return 0
  const usage = normalizeQuickAssistantUsage(value)
  const counts = usage.prompts[normalizedPromptKey] || {}
  return usage.activeDates.reduce((total, dateKey, index) => {
    const daysSinceLatestUse = usage.activeDates.length - 1 - index
    const recencyWeight = (MAX_ACTIVE_USAGE_DAYS - daysSinceLatestUse) / MAX_ACTIVE_USAGE_DAYS
    return total + (Math.max(0, Number(counts[dateKey]) || 0) * recencyWeight)
  }, 0)
}

export { MAX_ACTIVE_USAGE_DAYS }
