<script setup>
import { computed, ref, useId } from 'vue'
import { useI18n } from 'vue-i18n'
import { compactNumber, smoothLinePath } from '../utils/usageChart.js'

const props = defineProps({
  points: { type: Array, default: () => [] },
  granularity: { type: String, default: 'day' },
  rangeKey: { type: String, default: '30d' }
})
const { t, locale } = useI18n()
const hovered = ref(-1)
const WIDTH = 900,
  HEIGHT = 260,
  LEFT = 52,
  RIGHT = 72,
  TOP = 18,
  BOTTOM = 38
const plotWidth = WIDTH - LEFT - RIGHT
const plotHeight = HEIGHT - TOP - BOTTOM
const visible = computed(() => props.points)
const maxRequests = computed(() => Math.max(1, ...visible.value.map((day) => day.requests)))
const maxTokens = computed(() => Math.max(1, ...visible.value.map((day) => day.totalTokens)))
const x = (index) =>
  LEFT +
  (visible.value.length <= 1 ? plotWidth / 2 : (index / (visible.value.length - 1)) * plotWidth)
const y = (value, max) => TOP + plotHeight * (1 - value / max)
const gradientId = useId()
const requestPath = computed(() =>
  smoothLinePath(
    visible.value.map((day, index) => ({ x: x(index), y: y(day.requests, maxRequests.value) }))
  )
)
const tokenPath = computed(() =>
  smoothLinePath(
    visible.value.map((day, index) => ({ x: x(index), y: y(day.totalTokens, maxTokens.value) }))
  )
)
const area = (line) =>
  visible.value.length > 1
    ? `${line} L ${x(visible.value.length - 1)} ${HEIGHT - BOTTOM} L ${x(0)} ${HEIGHT - BOTTOM} Z`
    : ''
const date = (timestamp) =>
  new Date(timestamp).toLocaleString(locale.value === 'zh' ? 'zh-CN' : 'en-US', {
    month: '2-digit',
    day: '2-digit',
    ...(props.granularity === 'day' ? {} : { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' })
  })
const tickDate = (timestamp) => {
  if (props.granularity === 'day' || props.granularity === '4h' || props.rangeKey === '24h')
    return date(timestamp)
  return new Date(timestamp).toLocaleTimeString(locale.value === 'zh' ? 'zh-CN' : 'en-US', {
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23'
  })
}
const periodLabel = (point) =>
  props.granularity === 'day'
    ? date(point.timestamp)
    : `${date(point.periodStart ?? point.timestamp)} — ${date((point.periodEnd ?? point.timestamp) - 1)}`
const number = (value) => compactNumber(value)
const active = computed(() => visible.value[hovered.value])
function pointerFraction(event) {
  const rect = event.currentTarget.getBoundingClientRect()
  return Math.max(
    0,
    Math.min(1, (((event.clientX - rect.left) / rect.width) * WIDTH - LEFT) / plotWidth)
  )
}
function move(event) {
  hovered.value = Math.round(pointerFraction(event) * Math.max(0, visible.value.length - 1))
}
</script>

<template>
  <div class="trend-header">
    <div>
      <h3>{{ t('usage.trend') }}</h3>
    </div>
  </div>
  <div v-if="active" class="trend-detail" aria-live="polite">
    <strong>{{ periodLabel(active) }}</strong>
    <span class="requests">{{ t('usage.requests') }} {{ active.requests.toLocaleString() }}</span>
    <span class="tokens"
      >{{ t('usage.totalTokens') }} {{ active.totalTokens.toLocaleString() }}</span
    >
  </div>
  <div v-else class="trend-detail muted" aria-hidden="true"></div>
  <svg
    class="usage-trend"
    :viewBox="`0 0 ${WIDTH} ${HEIGHT}`"
    role="img"
    :aria-label="t('usage.trend')"
    @pointermove="move"
    @pointerleave="hovered = -1"
  >
    <g v-for="step in 5" :key="step">
      <line
        :x1="LEFT"
        :x2="WIDTH - RIGHT"
        :y1="TOP + ((step - 1) / 4) * plotHeight"
        :y2="TOP + ((step - 1) / 4) * plotHeight"
        class="grid-line"
      />
      <text
        :x="LEFT - 10"
        :y="TOP + ((step - 1) / 4) * plotHeight + 4"
        text-anchor="end"
        class="request-label"
      >
        {{ number((maxRequests * (5 - step)) / 4) }}
      </text>
      <text
        :x="WIDTH - RIGHT + 10"
        :y="TOP + ((step - 1) / 4) * plotHeight + 4"
        class="token-label"
      >
        {{ number((maxTokens * (5 - step)) / 4) }}
      </text>
    </g>
    <defs>
      <linearGradient :id="`${gradientId}-requests`" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0%" stop-color="var(--usage-request-color)" stop-opacity="0.13" />
        <stop offset="100%" stop-color="var(--usage-request-color)" stop-opacity="0" />
      </linearGradient>
      <linearGradient :id="`${gradientId}-tokens`" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0%" stop-color="var(--usage-token-color)" stop-opacity="0.1" />
        <stop offset="100%" stop-color="var(--usage-token-color)" stop-opacity="0" />
      </linearGradient>
    </defs>
    <path
      v-if="visible.length > 1"
      :d="area(requestPath)"
      :fill="`url(#${gradientId}-requests)`"
      class="trend-area"
    />
    <path
      v-if="visible.length > 1"
      :d="area(tokenPath)"
      :fill="`url(#${gradientId}-tokens)`"
      class="trend-area"
    />
    <path v-if="visible.length" :d="requestPath" class="request-line" />
    <path v-if="visible.length" :d="tokenPath" class="token-line" />
    <g v-for="(day, index) in visible" :key="day.timestamp">
      <circle :cx="x(index)" :cy="y(day.requests, maxRequests)" r="2.5" class="request-dot" />
      <circle :cx="x(index)" :cy="y(day.totalTokens, maxTokens)" r="2.5" class="token-dot" />
      <text
        v-if="
          index === 0 ||
          index === visible.length - 1 ||
          (index % Math.max(1, Math.ceil(visible.length / 8)) === 0 &&
            visible.length - 1 - index >= Math.max(1, Math.ceil(visible.length / 8) / 2))
        "
        :x="x(index)"
        :y="HEIGHT - 12"
        text-anchor="middle"
        class="date-label"
      >
        {{ tickDate(day.timestamp) }}
      </text>
    </g>
    <line
      v-if="active"
      :x1="x(hovered)"
      :x2="x(hovered)"
      :y1="TOP"
      :y2="HEIGHT - BOTTOM"
      class="crosshair"
    />
  </svg>
  <div class="trend-footer">
    <span class="requests">● {{ t('usage.requests') }}</span
    ><span class="tokens">● {{ t('usage.totalTokens') }}</span>
    <span v-if="visible.length" class="muted"
      >{{ date(visible[0].timestamp) }} — {{ date(visible[visible.length - 1].timestamp) }}</span
    >
  </div>
</template>

<style scoped>
.trend-header,
.usage-trend,
.trend-detail,
.trend-footer {
  --usage-request-color: #409eff;
  --usage-token-color: #14b8a6;
}
.trend-area {
  pointer-events: none;
}
.trend-header {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 12px;
}
h3 {
  font-size: 15px;
  font-weight: 650;
  margin: 0;
}
p {
  font-size: 12px;
  color: var(--text-secondary);
  margin: 6px 0 0;
}
.usage-trend {
  display: block;
  width: 100%;
  min-height: 190px;
  cursor: crosshair;
  touch-action: auto;
  user-select: none;
  outline-offset: 4px;
}
.grid-line {
  stroke: var(--el-border-color-lighter);
  stroke-dasharray: 3 5;
}
.request-line,
.token-line {
  fill: none;
  stroke-width: 2.3;
  stroke-linecap: round;
  stroke-linejoin: round;
}
.request-line {
  stroke: var(--usage-request-color);
}
.token-line {
  stroke: var(--usage-token-color);
}
.request-dot {
  fill: var(--usage-request-color);
}
.token-dot {
  fill: var(--usage-token-color);
}
.request-label,
.token-label,
.date-label {
  font-size: 11px;
  font-family: inherit;
}
.request-label,
.requests {
  fill: var(--usage-request-color);
  color: var(--usage-request-color);
}
.token-label,
.tokens {
  fill: var(--usage-token-color);
  color: var(--usage-token-color);
}
.date-label {
  fill: var(--text-secondary);
}
.crosshair {
  stroke: var(--text-secondary);
  stroke-dasharray: 4 4;
  opacity: 0.5;
  pointer-events: none;
}
.trend-detail {
  min-height: 30px;
  display: flex;
  flex-wrap: wrap;
  gap: 16px;
  align-items: center;
  font-size: 12px;
  padding-top: 8px;
}
.trend-footer {
  display: flex;
  justify-content: center;
  flex-wrap: wrap;
  gap: 20px;
  font-size: 12px;
}
.muted {
  color: var(--text-secondary);
}
</style>
