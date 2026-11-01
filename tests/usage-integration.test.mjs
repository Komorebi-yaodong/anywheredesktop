import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import vm from 'node:vm'
import { createRequire } from 'node:module'
import {
  compactNumber,
  smoothLinePath,
  createHeatmapScale,
  heatmapLevel
} from '../render/main/utils/usageChart.js'

const require = createRequire(import.meta.url)
const { parse, compileScript, compileTemplate, compileStyle } = require('@vue/compiler-sfc')
const read = (relative) => fs.readFile(new URL(relative, import.meta.url), 'utf8')
const extractFunction = (source, name) => {
  const start = source.indexOf(`async function ${name}(`)
  const end = source.indexOf('\n}', start)
  assert.ok(start >= 0 && end > start, name)
  return source.slice(start, end + 2)
}
const setting = await read('../render/main/components/Setting.vue')
let backupWritten, restoredConfig, usageImport
const current = {
  providers: { p: { name: 'P' } },
  webdav: { localChatPath: 'local-only' },
  remote: { private: true }
}
const statistics = { version: 1, records: [{ id: 'synthetic-record' }] }
let importData = { providers: { p: { name: 'P' } }, usageStatistics: statistics }
let throwStatistics = false
const api = {
  getUsageStatistics: async () => {
    if (throwStatistics) throw new Error('read error')
    return statistics
  },
  showSaveDialog: async () => ({ filePath: 'synthetic.json' }),
  writeLocalFile: async (_file, text) => {
    backupWritten = JSON.parse(text)
    return { ok: true }
  },
  showOpenDialog: async () => ({ filePaths: ['synthetic.json'] }),
  readLocalFile: async () => JSON.stringify(importData),
  importUsageStatistics: async (value) => {
    usageImport = value
  },
  restoreImportedConfig: async (value) => {
    restoredConfig = value
    return { ok: true }
  },
  getConfig: async () => ({ config: current })
}
const ctx = vm.createContext({
  window: { api },
  currentConfig: { value: current },
  console: { error() {} },
  ElMessage: { success() {}, error() {} },
  initCardOrder() {},
  t: (key) => key,
  getErrorMessage: (_error, fallback) => fallback,
  disableTasksInExportedConfig() {}
})
vm.runInContext(
  extractFunction(setting, 'exportConfig') +
    '\n' +
    extractFunction(setting, 'importConfig') +
    '\nthis.exports = { exportConfig, importConfig }',
  ctx
)
await ctx.exports.exportConfig()
assert.deepEqual(backupWritten.usageStatistics, statistics)
assert.equal(backupWritten.remote, undefined)
assert.equal(backupWritten.webdav.localChatPath, undefined)
assert.equal(current.webdav.localChatPath, 'local-only')
await ctx.exports.importConfig()
assert.deepEqual(JSON.parse(JSON.stringify(usageImport)), statistics)
assert.equal(restoredConfig.usageStatistics, undefined, 'statistics do not pollute normal config')
importData = { providers: { p: { name: 'legacy' } } }
usageImport = null
await ctx.exports.importConfig()
assert.equal(usageImport, null, 'legacy import preserves local statistics')
assert.equal(restoredConfig.providers.p.name, 'legacy')
backupWritten = null
throwStatistics = true
await ctx.exports.exportConfig()
assert.equal(
  backupWritten,
  null,
  'failed statistics export must not silently create incomplete backup'
)

for (const file of ['UsageStatistics.vue', 'UsageTrend.vue']) {
  const source = await read(`../render/main/components/${file}`)
  const { descriptor, errors } = parse(source)
  assert.deepEqual(errors, [])
  compileScript(descriptor, { id: file })
  assert.deepEqual(
    compileTemplate({ source: descriptor.template.content, filename: file, id: file }).errors,
    []
  )
  for (const style of descriptor.styles)
    assert.deepEqual(
      compileStyle({ source: style.content, filename: file, id: file, scoped: style.scoped })
        .errors,
      []
    )
}
const app = await read('../render/main/App.vue')
assert.ok(app.indexOf("t('usage.title')\" placement") < app.indexOf('<!-- 1. Chats'))
assert.match(app, /<UsageStatistics v-else-if="tab === 7"/)
const source = await read('../main/core/chat.js')
assert.match(source, /delete requestParams.usageContext/)
assert.match(source, /observeCompletion\(\(\) => executeChatCompletion\(requestParams\), params\)/)
assert.match(await read('../preload/window_preload.js'), /setUsageRecordSink.*usage:record/)
assert.match(await read('../main/ipcHandler.js'), /setUsageRecordSink.*usageStore.record/)
for (const file of [
  '../render/window/App.vue',
  '../main/core/fastInput.js',
  '../main/core/compact.js',
  '../main/core/mcp_builtin.js'
]) {
  assert.match(await read(file), /usageContext:[\s\S]*providerId/)
}
for (const lang of ['zh', 'en']) {
  const messages = JSON.parse(await read(`../render/main/locales/${lang}.json`))
  assert.ok(messages.usage.defaultAgent)
  if (lang === 'zh') {
    assert.equal(messages.usage.agent, '智能体')
    assert.equal(messages.usage.defaultAgent, '默认智能体')
    assert.ok(!JSON.stringify(messages.usage).includes('快捷助手'))
  }
}
for (const [value, expected] of [
  [0, '0'],
  [999, '999'],
  [1000, '1K'],
  [1500, '1.5K'],
  [418000, '418K'],
  [999960, '1M'],
  [1e6, '1M'],
  [41.8e6, '41.8M'],
  [1e9, '1B'],
  [2.17e9, '2.2B']
]) {
  assert.equal(compactNumber(value, 'zh-CN'), expected)
  assert.equal(compactNumber(value, 'en-US'), expected)
}
const statisticsPage = await read('../render/main/components/UsageStatistics.vue')
assert.match(
  statisticsPage,
  /label: current\?\.name \|\| provider.name \|\| t\('usage.unknownProvider'\)/
)
assert.ok(!statisticsPage.includes("key: 'failed'"), 'exactly six metric cards, no Failures card')
assert.match(statisticsPage, /<details class="trend-breakdown">/)
assert.match(statisticsPage, /class="metric-value-row"/)
assert.match(statisticsPage, /<el-tooltip placement="top"/)
assert.match(statisticsPage, /class="metric-meta"/)
assert.match(statisticsPage, /class="usage-toolbar"/)
assert.match(statisticsPage, /v-model="filters.range"/)
assert.ok(!statisticsPage.includes('<h2>'), 'dashboard must not repeat the main header title')
assert.match(statisticsPage, /class="table-ratio"/)
assert.ok(!statisticsPage.includes('heatMax'), 'no busiest-day max scaling')

assert.ok(!statisticsPage.includes('v-model="filters.granularity"'))
assert.match(statisticsPage, /:points="result\?\.trend \|\| \[\]"/)

assert.ok(
  !statisticsPage.includes('usage-empty'),
  'zero usage must keep the regular dashboard layout'
)
assert.match(statisticsPage, /class="metrics-grid"/)
for (const key of ['adaptiveScale', 'heatmapScaleHint', 'methodology', 'footnote', 'empty']) {
  assert.ok(!statisticsPage.includes(`usage.${key}`), 'no developer explanations in the dashboard')
  for (const language of ['zh', 'en']) {
    const messages = JSON.parse(await read(`../render/main/locales/${language}.json`))
    assert.equal(messages.usage[key], undefined)
  }
}

const baseline = createHeatmapScale([])
assert.deepEqual(baseline.thresholds, [10, 25, 50])
for (const [requests, expected] of [
  [0, 0],
  [1, 1],
  [2, 1],
  [10, 1],
  [11, 2],
  [25, 2],
  [26, 3],
  [50, 3],
  [51, 4]
]) {
  assert.equal(heatmapLevel(requests, baseline.thresholds), expected)
}
for (const counts of [[2], [2, 2], Array(365).fill(0), [...Array(19).fill(10), 10000]]) {
  assert.deepEqual(
    createHeatmapScale(counts.map((requests) => ({ requests }))).thresholds,
    [10, 25, 50]
  )
}
const adapted = createHeatmapScale(
  [...Array(365).fill(0), ...Array(20).fill(100)].map((requests) => ({ requests }))
)
assert.equal(adapted.p90, 100, 'inactive days do not distort the personal baseline')
assert.deepEqual(adapted.thresholds, [20, 50, 100])
assert.equal(heatmapLevel(2, adapted.thresholds), 1)
assert.equal(heatmapLevel(100, adapted.thresholds), 3)
assert.equal(heatmapLevel(101, adapted.thresholds), 4)
for (const counts of [[51], [1000], [10, 20, 30, 40, 100, 150, 170]]) {
  const scale = createHeatmapScale(counts.map((requests) => ({ requests })))
  scale.bands.slice(1).forEach((band, index) => {
    assert.equal(band.min, scale.bands[index].max + 1)
    if (band.max !== null) assert.ok(band.max >= band.min)
  })
}
assert.deepEqual(
  createHeatmapScale([{ requests: NaN }, { requests: -1 }, { requests: Infinity }]).thresholds,
  [10, 25, 50]
)

assert.equal(smoothLinePath([]), '')
assert.equal(smoothLinePath([{ x: 1, y: 2 }]), 'M 1 2')
for (const values of [
  [0, 8, 0, 16, 4, 0],
  [0, 0, 0, 0],
  [5, 5, 8, 8, 0],
  [10, 8, 4, 1]
]) {
  const points = values.map((y, x) => ({ x: x * 10, y }))
  const path = smoothLinePath(points)
  const segments = [
    ...path.matchAll(/C ([\d.e+-]+) ([\d.e+-]+) ([\d.e+-]+) ([\d.e+-]+) ([\d.e+-]+) ([\d.e+-]+)/g)
  ]
  assert.equal(segments.length, values.length - 1)
  segments.forEach((segment, index) => {
    const [, , a, , b, endX, endY] = segment.map(Number)
    assert.equal(endX, points[index + 1].x)
    assert.equal(endY, points[index + 1].y)
    for (let step = 0; step <= 100; step++) {
      const t = step / 100
      const y =
        (1 - t) ** 3 * values[index] +
        3 * (1 - t) ** 2 * t * a +
        3 * (1 - t) * t ** 2 * b +
        t ** 3 * values[index + 1]
      assert.ok(
        y >= Math.min(values[index], values[index + 1]) - 1e-9 &&
          y <= Math.max(values[index], values[index + 1]) + 1e-9,
        'smooth curve cannot invent peaks or negative usage'
      )
    }
  })
}
const trendSource = await read('../render/main/components/UsageTrend.vue')
assert.ok(!trendSource.includes("t('usage.trendHint')"))
assert.ok(!trendSource.includes('<polyline'))

assert.ok(!trendSource.includes('@wheel'), 'chart must not intercept page scrolling')
assert.ok(!trendSource.includes('@pointerdown'), 'no drag-to-pan interaction')
assert.ok(!trendSource.includes('@keydown'), 'no zoom/pan shortcuts')
assert.ok(!trendSource.includes('resetZoom'), 'no obsolete reset button')
assert.match(trendSource, /const visible = computed\(\(\) => props.points\)/)
assert.match(trendSource, /@pointermove="move"/)
assert.match(trendSource, /periodLabel\(active\)/)
console.log(
  'Usage integration: real export/import functions, SFC compilation, routing, labels and non-intercepting chart passed'
)
