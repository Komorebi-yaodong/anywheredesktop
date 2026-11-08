import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import vm from 'node:vm'
const source = await fs.readFile(new URL('../main/core/task_scheduler.js', import.meta.url), 'utf8')
const start = source.indexOf('async function checkTasks(')
const block = source.slice(start, source.indexOf('export function startTaskScheduler', start))
const task = {conversationId: 'fixture', triggerType: 'single'}
const processedRunSlots = new Map()
let runs = 0, saves = 0
const dataApi = {getConfig: async () => ({config: {tasks: {task}}}), updateConfigWithoutFeatures: async () => {saves++}}
const c = {Date, Object, console: {warn() {}, error() {}}, isChecking: false, processedRunSlots,
  reconcileTaskDeviceState: () => ({enabled: true, changed: false}), getDueRunSlotKey: () => processedRunSlots.size ? null : 'slot',
  runTaskById: async () => {runs++; return {success: false, reason: 'task_receipt_timeout'}},
  setCurrentTaskDeviceEnabled: (value, enabled) => {value.enabled = enabled}, pruneProcessedRunSlots() {}}
const check = vm.runInNewContext(`${block}; checkTasks`, c)
await check({dataApi, openWindow() {}})
await check({dataApi, openWindow() {}})
assert.equal(runs, 1, 'unknown delivered task cannot be replayed in the same slot')
assert.equal(saves, 1)
assert.equal(task.enabled, false)
assert.equal(task.lastRunSlotKey, 'slot')
console.log('PASS scheduler receipt timeout records unknown slot without replay or marking success')
