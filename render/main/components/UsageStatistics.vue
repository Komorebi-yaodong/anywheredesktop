<script setup>
import {
  computed,
  inject,
  onActivated,
  onBeforeUnmount,
  onDeactivated,
  reactive,
  ref,
  watch
} from 'vue'
import { useI18n } from 'vue-i18n'
import {
  Refresh,
  DataAnalysis,
  CircleCheck,
  Coin,
  Download,
  Upload,
  Connection
} from '@element-plus/icons-vue'
import UsageTrend from './UsageTrend.vue'
import { compactNumber, createHeatmapScale, heatmapLevel } from '../utils/usageChart.js'

const { t, locale } = useI18n()
const config = inject('config')
const filters = reactive({
  range: '30d',
  providerId: '',
  agentName: '',
  model: ''
})
const result = ref(null)
const loading = ref(false)
const error = ref(false)
const updatedAt = ref(null)
let timer = null,
  revision = 0,
  active = false
const ranges = ['24h', 'today', 'yesterday', '7d', '30d']
const summary = computed(() => result.value?.summary || {})
const lang = computed(() => (locale.value === 'zh' ? 'zh-CN' : 'en-US'))
const number = (value) => new Intl.NumberFormat(lang.value).format(value || 0)
const compact = (value) => compactNumber(value)
const percent = (value) => `${((value || 0) * 100).toFixed(1)}%`
const agentLabel = (name) => (name === '__DEFAULT__' ? t('usage.defaultAgent') : name)
const providerOptions = computed(() =>
  (result.value?.options.providers || []).map((provider) => {
    const current = config.value?.providers?.[provider.id]
    return {
      id: provider.id,
      label: current?.name || provider.name || t('usage.unknownProvider')
    }
  })
)
const cards = computed(() => [
  {
    key: 'requests',
    value: summary.value.requests,
    icon: DataAnalysis,
    detail: t('usage.completedRequests'),
    meta: `${number(summary.value.succeeded)} ${t('usage.successful')}`,
    color: 'primary'
  },
  {
    key: 'successRate',
    value: summary.value.successRate,
    icon: CircleCheck,
    detail: `${number(summary.value.succeeded)} / ${number(summary.value.requests)}`,
    meta: `${number(summary.value.succeeded)} / ${number(summary.value.requests)}`,
    color: 'success',
    rate: true
  },
  {
    key: 'totalTokens',
    value: summary.value.totalTokens,
    meta: t('usage.reportedShort', { count: number(summary.value.usageReported) }),
    icon: Coin,
    detail: t('usage.reportedCount', {
      reported: number(summary.value.usageReported),
      total: number(summary.value.requests)
    }),
    color: 'primary'
  },
  {
    key: 'inputTokens',
    value: summary.value.inputTokens,
    icon: Download,
    detail: `${t('usage.shareOfTotal')} ${percent(summary.value.inputRatio)}`,
    meta: `${t('usage.share')} ${percent(summary.value.inputRatio)}`,
    color: 'success'
  },
  {
    key: 'outputTokens',
    value: summary.value.outputTokens,
    icon: Upload,
    detail: `${t('usage.shareOfTotal')} ${percent(summary.value.outputRatio)}`,
    meta: `${t('usage.share')} ${percent(summary.value.outputRatio)}`,
    color: 'primary'
  },
  {
    key: 'cachedTokens',
    value: summary.value.cachedTokens,
    icon: Connection,
    detail: `${t('usage.shareOfInput')} ${percent(summary.value.cacheRatio)}`,
    meta: `${t('usage.cacheHitRate')} ${percent(summary.value.cacheRatio)}`,
    color: 'success'
  }
])
const heatDays = computed(() => {
  const days = result.value?.heatmap || []
  if (!days.length) return []
  const weekday = (new Date(days[0].timestamp).getDay() + 6) % 7
  return [...Array.from({ length: weekday }, () => null), ...days]
})
const heatScale = computed(() => createHeatmapScale())
const heatLevel = (day) => heatmapLevel(day?.requests)
const heatBandLabel = (band) => {
  const count =
    band.max === null
      ? `${number(band.min)}+`
      : band.min === band.max
        ? number(band.min)
        : `${number(band.min)}–${number(band.max)}`
  return t('usage.heatmapBand', { count })
}
const heatTotal = computed(() =>
  (result.value?.heatmap || []).reduce((total, day) => total + day.requests, 0)
)
const months = computed(() => {
  const list = []
  heatDays.value.forEach((day, index) => {
    if (
      day &&
      (index === heatDays.value.findIndex(Boolean) || new Date(day.timestamp).getDate() === 1)
    ) {
      list.push({
        column: Math.floor(index / 7) + 1,
        label: new Date(day.timestamp).toLocaleDateString(lang.value, { month: 'short' })
      })
    }
  })
  return list
})
const heatTitle = (day) =>
  `${day.date} · ${t('usage.requests')}: ${number(day.requests)} · ${t('usage.totalTokens')}: ${number(day.totalTokens)}`
const bucketDate = (timestamp) =>
  new Date(timestamp).toLocaleString(lang.value, {
    month: '2-digit',
    day: '2-digit',
    ...(result.value?.granularity !== 'day'
      ? { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }
      : {})
  })
const orderedBuckets = computed(() => [...(result.value?.buckets || [])].reverse())
async function load(silent = false) {
  const version = ++revision
  if (!silent) loading.value = true
  try {
    const next = await window.api.queryUsageStatistics({ ...filters })
    if (version !== revision || !active) return
    result.value = next
    updatedAt.value = new Date()
    error.value = false
  } catch {
    if (version === revision && active) error.value = true
  } finally {
    if (version === revision) loading.value = false
  }
}
watch(filters, () => {
  if (active) load()
})
onActivated(() => {
  active = true
  load()
  timer = setInterval(() => load(true), 15_000)
})
function stop() {
  active = false
  revision++
  clearInterval(timer)
  timer = null
  loading.value = false
}
onDeactivated(stop)
onBeforeUnmount(stop)
</script>

<template>
  <section class="usage-page" :aria-label="t('usage.title')">
    <div class="usage-panel filters-panel">
      <div class="usage-toolbar">
        <div class="filter-selects">
          <label class="date-filter"
            ><span>{{ t('usage.date') }}</span>
            <el-select v-model="filters.range" :aria-label="t('usage.timeRange')">
              <el-option
                v-for="range in ranges"
                :key="range"
                :value="range"
                :label="t(`usage.ranges.${range}`)"
              />
            </el-select>
          </label>
          <label
            ><span>{{ t('usage.provider') }}</span
            ><el-select
              v-model="filters.providerId"
              clearable
              filterable
              :placeholder="t('usage.allProviders')"
              :aria-label="t('usage.provider')"
            >
              <el-option
                v-for="provider in providerOptions"
                :key="provider.id"
                :value="provider.id"
                :label="provider.label"
              /> </el-select
          ></label>
          <label
            ><span>{{ t('usage.agent') }}</span
            ><el-select
              v-model="filters.agentName"
              clearable
              filterable
              :placeholder="t('usage.allAgents')"
              :aria-label="t('usage.agent')"
            >
              <el-option
                v-for="agent in result?.options.agents || []"
                :key="agent"
                :value="agent"
                :label="agentLabel(agent)"
              /> </el-select
          ></label>
          <label
            ><span>{{ t('usage.model') }}</span
            ><el-select
              v-model="filters.model"
              clearable
              filterable
              :placeholder="t('usage.allModels')"
              :aria-label="t('usage.model')"
            >
              <el-option
                v-for="model in result?.options.models || []"
                :key="model"
                :value="model"
                :label="model || '—'"
              /> </el-select
          ></label>
        </div>
        <div class="update-actions">
          <small v-if="updatedAt"
            >{{ t('usage.updated') }}
            <time>{{ updatedAt.toLocaleTimeString(lang, { hourCycle: 'h23' }) }}</time></small
          >
          <el-button :icon="Refresh" :loading="loading" @click="load()">{{
            t('usage.refresh')
          }}</el-button>
        </div>
      </div>
    </div>
    <el-alert
      v-if="error"
      :title="t('usage.loadFailed')"
      type="error"
      :closable="false"
      show-icon
    />
    <div class="metrics-grid" :aria-busy="loading">
      <article
        v-for="card in cards"
        :key="card.key"
        class="usage-panel metric-card"
        :class="`metric-${card.color}`"
      >
        <div class="metric-label">
          <span class="metric-icon"
            ><el-icon><component :is="card.icon" /></el-icon></span
          >{{ t(`usage.${card.key}`) }}
        </div>
        <div class="metric-value-row">
          <el-tooltip placement="top" :show-after="120">
            <template #content
              ><div class="metric-tooltip-label">{{ t(`usage.${card.key}`) }}</div>
              <strong>{{ card.rate ? percent(card.value) : number(card.value) }}</strong>
              <div class="metric-tooltip-detail">{{ card.detail }}</div></template
            >
            <strong class="metric-value" tabindex="0">{{
              card.rate ? percent(card.value) : compact(card.value)
            }}</strong>
          </el-tooltip>
          <small class="metric-meta" :title="card.detail">{{ card.meta }}</small>
        </div>
      </article>
    </div>
    <div class="usage-panel chart-panel">
      <UsageTrend
        :points="result?.trend || []"
        :granularity="result?.granularity || 'day'"
        :range-key="filters.range"
      />
      <details class="trend-breakdown">
        <summary>
          {{ t('usage.showDetails') }} ·
          {{
            t(
              result?.granularity === 'hour'
                ? 'usage.hour'
                : result?.granularity === '4h'
                  ? 'usage.fourHours'
                  : 'usage.day'
            )
          }}
        </summary>
        <el-table :data="orderedBuckets" max-height="330" size="small" stripe>
          <el-table-column :label="t('usage.time')" width="140"
            ><template #default="{ row }">{{
              bucketDate(row.timestamp)
            }}</template></el-table-column
          >
          <el-table-column
            prop="requests"
            :label="t('usage.requests')"
            min-width="90"
            align="right"
          />
          <el-table-column :label="t('usage.successRate')" min-width="95" align="right"
            ><template #default="{ row }">{{ percent(row.successRate) }}</template></el-table-column
          >

          <el-table-column
            v-for="key in ['totalTokens', 'inputTokens', 'outputTokens', 'cachedTokens']"
            :key="key"
            :label="t(`usage.${key}`)"
            min-width="125"
            align="right"
          >
            <template #default="{ row }"
              ><span :title="number(row[key])">{{ compact(row[key]) }}</span
              ><small v-if="key !== 'totalTokens'" class="table-ratio">
                ({{
                  percent(
                    row[
                      key === 'inputTokens'
                        ? 'inputRatio'
                        : key === 'outputTokens'
                          ? 'outputRatio'
                          : 'cacheRatio'
                    ]
                  )
                }})</small
              ></template
            >
          </el-table-column>
        </el-table>
      </details>
    </div>
    <div class="usage-panel heatmap-panel">
      <div class="section-heading">
        <div>
          <h3>{{ t('usage.heatmap') }}</h3>
          <p>{{ t('usage.heatmapSummary', { count: number(heatTotal) }) }}</p>
        </div>
        <span class="section-badge">365 {{ t('usage.days') }}</span>
      </div>
      <div class="heat-scroll">
        <div class="heat-months">
          <span
            v-for="(month, index) in months"
            :key="index"
            :style="{ gridColumn: month.column }"
            >{{ month.label }}</span
          >
        </div>
        <div class="heat-layout">
          <div class="week-labels">
            <span>{{ t('usage.mon') }}</span
            ><span>{{ t('usage.wed') }}</span
            ><span>{{ t('usage.fri') }}</span>
          </div>
          <div class="heat-grid">
            <template v-for="(day, index) in heatDays" :key="index">
              <el-tooltip v-if="day" :content="heatTitle(day)" placement="top" :show-after="100">
                <span
                  :class="`heat-cell heat-${heatLevel(day)}`"
                  :aria-label="heatTitle(day)"
                  :title="heatTitle(day)"
                  tabindex="0"
                /> </el-tooltip
              ><span v-else class="heat-cell heat-padding" />
            </template>
          </div>
        </div>
      </div>
      <div class="heat-legend">
        <span>{{ t('usage.less') }}</span>
        <el-tooltip
          v-for="band in heatScale.bands"
          :key="band.level"
          :content="heatBandLabel(band)"
          placement="top"
          :show-after="100"
        >
          <span
            :class="`heat-cell heat-${band.level}`"
            :aria-label="heatBandLabel(band)"
            tabindex="0"
          />
        </el-tooltip>
        <span>{{ t('usage.more') }}</span>
      </div>
    </div>
  </section>
</template>

<style scoped>
.usage-page {
  display: flex;
  flex-direction: column;
  gap: 18px;
  padding: 6px 8px 22px 2px;
  color: var(--text-primary);
  max-width: 1500px;
  margin: 0 auto;
  height: 100%;
  overflow-y: auto;
}
.usage-page > * {
  flex-shrink: 0;
}
h3 {
  font-size: 15px;
  font-weight: 650;
  margin: 0;
}
p {
  color: var(--text-secondary);
  font-size: 12px;
  margin: 0;
  line-height: 1.7;
}
.update-actions {
  display: flex;
  align-items: center;
  gap: 10px;
  flex-shrink: 0;
  white-space: nowrap;
}
.update-actions time {
  font-variant-numeric: tabular-nums;
}
.update-actions small {
  font-size: 11px;
  color: var(--text-secondary);
}
.usage-panel {
  border: 1px solid var(--el-border-color-light);
  border-radius: 18px;
  background: var(--el-bg-color-overlay);
  box-shadow: 0 5px 20px -15px rgba(24, 24, 27, 0.15);
}
.filters-panel {
  padding: 12px;
  overflow-x: auto;
}
.usage-toolbar {
  display: flex;
  align-items: center;
  gap: 12px;
  min-width: 930px;
}
.filter-selects {
  display: grid;
  grid-template-columns: 1.15fr repeat(3, 1fr);
  flex: 1;
  gap: 8px;
  min-width: 0;
}
.filter-selects label {
  display: flex;
  align-items: center;
  min-width: 0;
  border: 1px solid transparent;
  border-radius: 12px;
  background: var(--bg-tertiary);
  padding: 0 8px 0 14px;
  transition:
    border-color 0.15s,
    background 0.15s;
}
.filter-selects label > span {
  flex-shrink: 0;
  padding-right: 12px;
  margin-right: 4px;
  border-right: 1px solid var(--border-primary);
  font-size: 12px;
  line-height: 20px;
  color: var(--text-secondary);
}
.filter-selects .el-select {
  flex: 1;
  min-width: 0;
  width: 0;
}
.filter-selects :deep(.el-select__wrapper) {
  background: transparent !important;
  background-color: transparent !important;
  box-shadow: none !important;
  border: 0 !important;
  border-radius: 0;
  min-height: 40px;
}
html.dark .usage-page .filter-selects :deep(.el-select__wrapper),
html.dark .usage-page .filter-selects :deep(.el-select__wrapper.is-focused) {
  background-color: transparent !important;
  box-shadow: none !important;
}
.filter-selects label:hover {
  border-color: var(--border-primary);
}

.filter-selects label:focus-within {
  border-color: var(--el-color-primary);
}
@media (max-width: 700px) {
  .filter-selects label {
    padding-left: 10px;
    padding-right: 2px;
  }
  .filter-selects label > span {
    font-size: 11px;
    padding-right: 7px;
    margin-right: 0;
  }
  .filter-selects :deep(.el-select__wrapper) {
    padding-left: 6px;
    padding-right: 6px;
  }
}
.metrics-grid {
  display: grid;
  grid-template-columns: repeat(6, minmax(0, 1fr));
  gap: 10px;
}
.metric-card {
  padding: 13px 14px;
  min-width: 0;
}

.metric-label {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 12px;
  color: var(--text-secondary);
}
.metric-icon {
  color: var(--el-color-primary);
  background: var(--el-color-primary-light-9);
  width: 27px;
  height: 27px;
  border-radius: 8px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
}
.metric-success .metric-icon {
  color: var(--el-color-success);
  background: var(--el-color-success-light-9);
}
.metric-danger .metric-icon {
  color: var(--el-color-danger);
  background: var(--el-color-danger-light-9);
}
.metric-value-row {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 8px;
  margin-top: 10px;
}
.metric-value {
  display: block;
  flex-shrink: 0;
  font-size: 25px;
  font-weight: 700;
  line-height: 1.25;
  letter-spacing: -0.03em;
  font-variant-numeric: tabular-nums;
  cursor: help;
}
.metric-meta {
  min-width: 0;
  text-align: right;
  color: var(--text-secondary);
  font-size: 10px;
  line-height: 1.3;
}
.metric-tooltip-label {
  font-size: 11px;
  margin-bottom: 3px;
  opacity: 0.8;
}
.metric-tooltip-detail {
  font-size: 11px;
  margin-top: 4px;
  opacity: 0.8;
}
.metric-danger strong {
  color: var(--el-color-danger);
}
.chart-panel,
.heatmap-panel,
.detail-panel {
  padding: 20px;
}
.section-heading {
  display: flex;
  justify-content: space-between;
  gap: 12px;
  align-items: flex-start;
  margin-bottom: 20px;
}
.section-heading p {
  margin-top: 6px;
}
.section-badge {
  font-size: 10px;
  white-space: nowrap;
  border: 1px solid var(--el-border-color-light);
  color: var(--text-secondary);
  padding: 3px 9px;
  border-radius: 99px;
}
.heat-scroll {
  overflow-x: auto;
  padding-bottom: 6px;
}
.heat-months {
  margin-left: 32px;
  display: grid;
  grid-auto-columns: 14px;
  grid-auto-flow: column;
  gap: 4px;
  min-width: 940px;
  height: 22px;
  font-size: 10px;
  color: var(--text-secondary);
}
.heat-months span {
  white-space: nowrap;
}
.heat-layout {
  display: flex;
  gap: 8px;
}
.week-labels {
  display: grid;
  grid-template-rows: repeat(7, 14px);
  row-gap: 4px;
  width: 24px;
  flex-shrink: 0;
  font-size: 9px;
  color: var(--text-secondary);
}
.week-labels span {
  align-self: center;
  line-height: 14px;
}
.week-labels span:nth-child(1) {
  grid-row: 1;
}
.week-labels span:nth-child(2) {
  grid-row: 3;
}
.week-labels span:nth-child(3) {
  grid-row: 5;
}
.heat-grid {
  display: grid;
  grid-template-rows: repeat(7, 14px);
  grid-auto-columns: 14px;
  grid-auto-flow: column;
  gap: 4px;
}
.heat-cell {
  display: inline-block;
  width: 14px;
  height: 14px;
  border-radius: 3px;
  flex-shrink: 0;
}
.heat-grid .heat-cell:not(.heat-padding):hover {
  outline: 1px solid var(--text-secondary);
  outline-offset: 2px;
}
.heat-0 {
  background: var(--el-fill-color);
  border: 1px solid var(--el-border-color-lighter);
}
.heat-1 {
  background: #9be9a8;
}
.heat-2 {
  background: #40c463;
}
.heat-3 {
  background: #30a14e;
}
.heat-4 {
  background: #216e39;
}
html.dark .heat-1 {
  background: #0e4429;
}
html.dark .heat-2 {
  background: #006d32;
}
html.dark .heat-3 {
  background: #26a641;
}
html.dark .heat-4 {
  background: #39d353;
}
.heat-legend {
  display: flex;
  justify-content: flex-end;
  align-items: center;
  gap: 5px;
  font-size: 10px;
  color: var(--text-secondary);
  margin-top: 10px;
}
.table-ratio {
  display: inline;
  font-size: 11px;
  color: var(--text-secondary);
}
.trend-breakdown :deep(.el-table .cell) {
  white-space: nowrap;
}
.trend-breakdown {
  border-top: 1px solid var(--el-border-color-light);
  margin-top: 16px;
  padding-top: 12px;
}
.trend-breakdown summary {
  font-size: 12px;
  color: var(--text-secondary);
  cursor: pointer;
  user-select: none;
}
.trend-breakdown[open] summary {
  margin-bottom: 14px;
}
@media (max-width: 900px) {
  .metrics-grid {
    grid-template-columns: repeat(3, minmax(0, 1fr));
  }
}
@media (max-width: 640px) {
  .filter-selects {
    gap: 8px;
  }
  .filter-selects label {
    min-width: 0;
  }
  .metrics-grid {
    grid-template-columns: repeat(3, minmax(0, 1fr));
  }

  .chart-panel,
  .heatmap-panel,
  .detail-panel,
  .filters-panel {
    padding: 14px;
  }
}
</style>
