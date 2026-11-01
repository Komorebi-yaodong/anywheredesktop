export function clampViewport(start, size, length) {
  const nextSize = Math.max(Math.min(2, length), Math.min(length, Math.round(size)))
  return {
    start: Math.max(0, Math.min(Math.max(0, length - nextSize), Math.round(start))),
    size: nextSize
  }
}

export function zoomViewport(view, delta, anchor, length) {
  if (!length) return { start: 0, size: 0 }
  const size =
    delta < 0
      ? Math.max(2, Math.floor(view.size * 0.8))
      : Math.max(view.size + 1, Math.ceil(view.size * 1.25))
  const position = Math.max(0, Math.min(1, anchor))
  const nextSize = Math.min(length, size)
  return clampViewport(view.start + position * (view.size - nextSize), nextSize, length)
}

// Monotone cubic Hermite interpolation: passes through observations without overshoot.
export function smoothLinePath(points = []) {
  if (!points.length) return ''
  if (points.length === 1) return `M ${points[0].x} ${points[0].y}`
  const slopes = points
    .slice(1)
    .map((point, index) => (point.y - points[index].y) / (point.x - points[index].x))
  const tangents = points.map((_, index) => {
    if (index === 0) return slopes[0]
    if (index === points.length - 1) return slopes[index - 1]
    const left = slopes[index - 1],
      right = slopes[index]
    return left * right <= 0 ? 0 : (2 * left * right) / (left + right)
  })
  for (let index = 0; index < slopes.length; index++) {
    if (slopes[index] === 0) {
      tangents[index] = 0
      tangents[index + 1] = 0
      continue
    }
    const a = tangents[index] / slopes[index],
      b = tangents[index + 1] / slopes[index]
    const norm = Math.hypot(a, b)
    if (norm > 3) {
      tangents[index] = ((3 * a) / norm) * slopes[index]
      tangents[index + 1] = ((3 * b) / norm) * slopes[index]
    }
  }
  let line = `M ${points[0].x} ${points[0].y}`
  for (let index = 0; index < points.length - 1; index++) {
    const left = points[index],
      right = points[index + 1],
      third = (right.x - left.x) / 3
    line += ` C ${left.x + third} ${left.y + third * tangents[index]} ${right.x - third} ${right.y - third * tangents[index + 1]} ${right.x} ${right.y}`
  }
  return line
}

// Token units are decimal K/M/B in every UI language (never locale-dependent 万/亿).
export function compactNumber(value) {
  const numeric = Number.isFinite(Number(value)) ? Number(value) : 0
  const absolute = Math.abs(numeric)
  const units = [
    { scale: 1, suffix: '' },
    { scale: 1e3, suffix: 'K' },
    { scale: 1e6, suffix: 'M' },
    { scale: 1e9, suffix: 'B' }
  ]
  let index = absolute >= 1e9 ? 3 : absolute >= 1e6 ? 2 : absolute >= 1e3 ? 1 : 0
  if (index < 3 && Math.round((absolute / units[index].scale) * 10) / 10 >= 1000) index++
  const unit = units[index]
  return (
    new Intl.NumberFormat('en-US', { maximumFractionDigits: 1, useGrouping: false }).format(
      numeric / unit.scale
    ) + unit.suffix
  )
}
