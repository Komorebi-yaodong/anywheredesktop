import assert from 'node:assert/strict'
import { readFileSync, existsSync } from 'node:fs'
import { createRequire } from 'node:module'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import vm from 'node:vm'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const desktop = existsSync(path.join(root, 'render/main/components/Tasks.vue'))
const frontend = desktop ? root : path.join(root, 'Anywhere_main')
const require = createRequire(path.join(frontend, 'package.json'))
const { parse, compileScript } = require('vue/compiler-sfc')
const { ref, watch, nextTick } = require('vue')
const filename = desktop
  ? path.join(root, 'render/main/components/Tasks.vue')
  : path.join(frontend, 'src/components/Tasks.vue')
const { descriptor, errors } = parse(readFileSync(filename, 'utf8'), { filename })
assert.deepEqual(errors, [])
compileScript(descriptor, { id: 'task-skill-options', inlineTemplate: true })
const script = descriptor.scriptSetup.content.replaceAll('\r\n', '\n')
const template = descriptor.template.content
function between(start, end) {
  const a = script.indexOf(start)
  const b = script.indexOf(end, a + start.length)
  assert.ok(a >= 0 && b > a, start)
  return script.slice(a, b)
}
const skillSelect = template.match(
  /<el-select\b[^>]*v-model="selectedTask\.extraSkills"[\s\S]*?<\/el-select>/
)?.[0]
assert.ok(skillSelect)
assert.match(skillSelect, /:loading="skillOptionsLoading"/)
assert.match(skillSelect, /@visible-change="visible => visible && refreshTaskSkillOptions\(\)"/)
assert.match(skillSelect, /v-for="skill in availableSkills"/)
assert.match(skillSelect, /:value="skill\.name"/)

const currentConfig = ref({
  skillPath: 'fixture-a',
  tasks: { task: { extraSkills: ['existing'] } }
})
const requests = []
const lifecycle = {}
const warnings = []
const code = `${between('const availableSkills =', 'const taskConversationOptions =')}
${between('onActivated(async', 'watch(() => currentConfig.value?.tasks,')}
({ availableSkills, skillOptionsLoading, refreshTaskSkillOptions })`
const state = vm.runInNewContext(code, {
  ref,
  watch,
  currentConfig,
  onActivated: (callback) => {
    lifecycle.activate = callback
  },
  onDeactivated: (callback) => {
    lifecycle.deactivate = callback
  },
  refreshLocalProjectOptions: async () => {},
  refreshTaskConversationOptions: async () => {},
  handleGlobalKeyDown() {},
  console: { warn: (...args) => warnings.push(args) },
  window: {
    addEventListener() {},
    removeEventListener() {},
    api: {
      listSkills(dir) {
        return new Promise((resolve, reject) => requests.push({ dir, resolve, reject }))
      }
    }
  }
})
const names = () => Array.from(state.availableSkills.value, (skill) => skill.name)
const flush = async () => {
  await nextTick()
  await Promise.resolve()
}

await lifecycle.activate()
assert.equal(requests.length, 1)
assert.equal(state.skillOptionsLoading.value, true)
await state.refreshTaskSkillOptions()
assert.equal(requests.length, 1, 'opening during activation shares the in-flight request')
requests[0].resolve([{ name: 'existing' }])
await flush()
assert.deepEqual(names(), ['existing'])

lifecycle.deactivate()
await lifecycle.activate()
requests[1].resolve([{ name: 'newly added' }, { name: 'existing' }])
await flush()
assert.deepEqual(names(), ['existing', 'newly added'], 'returning from Skills updates the list')

const open = state.refreshTaskSkillOptions()
requests[2].resolve([{ name: 'edited externally' }])
await open
assert.deepEqual(
  names(),
  ['edited externally'],
  'opening also refreshes while staying on this page'
)

const old = state.refreshTaskSkillOptions()
currentConfig.value.skillPath = 'fixture-b'
await flush()
assert.equal(requests[4].dir, 'fixture-b')
assert.deepEqual(names(), [])
requests[3].resolve([{ name: 'old directory' }])
await old
assert.deepEqual(names(), [])
assert.equal(
  state.skillOptionsLoading.value,
  true,
  'obsolete requests cannot clear current loading'
)
requests[4].resolve([{ name: 'new directory' }])
await flush()
assert.deepEqual(names(), ['new directory'])

const failure = state.refreshTaskSkillOptions()
requests[5].reject(new Error('synthetic read failure'))
await failure
assert.equal(warnings.length, 1)
assert.deepEqual(names(), ['new directory'], 'same-directory failure keeps the previous list')
assert.equal(state.skillOptionsLoading.value, false)

const leaving = state.refreshTaskSkillOptions()
lifecycle.deactivate()
requests[6].resolve([{ name: 'late result' }])
await leaving
assert.deepEqual(names(), ['new directory'])
currentConfig.value.skillPath = ''
await flush()
assert.equal(requests.length, 7, 'inactive pages do not start background list scans')
await lifecycle.activate()
assert.deepEqual(names(), [])
assert.deepEqual(
  currentConfig.value.tasks.task.extraSkills,
  ['existing'],
  'refresh never changes selected Skills'
)
console.log(
  'PASS task Skill options: activation, dropdown refresh, stale replies, and retained selection'
)
