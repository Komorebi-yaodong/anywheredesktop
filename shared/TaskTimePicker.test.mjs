/* eslint-disable vue/one-component-per-file -- Synthetic host and picker boundary exercise the real SFC in one isolated regression. */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { createRequire } from 'node:module'
import { fileURLToPath, pathToFileURL } from 'node:url'

const directory = path.dirname(fileURLToPath(import.meta.url))
const root = path.resolve(directory, '..')
const dependencyRoot = fs.existsSync(path.join(root, 'package.json'))
  ? root
  : path.join(root, 'Anywhere_main')
const require = createRequire(path.join(dependencyRoot, 'package.json'))
const Vue = require('vue')
const { parse, compileScript, compileTemplate } = require('vue/compiler-sfc')
const { normalizeTaskSchedulePatch } = await import(
  pathToFileURL(path.join(directory, 'taskSchedule.js'))
)
const { ref, h, nextTick, createRenderer, defineComponent } = Vue
// Closing schedules a reconciliation tick, followed by its render tick.
const settle = async () => {
  await nextTick()
  await nextTick()
}

// Compile the actual SFC and run its render/setup with real Vue reactivity.
// Only the native picker boundary is substituted, so update-before-confirm and
// cancellation are deterministic without Electron, uTools, user config or a DOM.
const filename = fs.existsSync(path.join(root, 'render/main/components/TaskTimePicker.vue'))
  ? path.join(root, 'render/main/components/TaskTimePicker.vue')
  : path.join(root, 'Anywhere_main/src/components/TaskTimePicker.vue')
const source = fs.readFileSync(filename, 'utf8')
const parsed = parse(source, { filename })
assert.deepEqual(parsed.errors, [])
const compiled = compileScript(parsed.descriptor, {
  id: 'time-picker-regression',
  inlineTemplate: true
})
const code = compiled.content
  .replace(
    /import\s*\{([^}]+)\}\s*from\s*['"]vue['"];?/g,
    (_match, names) => `const {${names.replace(/\s+as\s+/g, ': ')}} = Vue;`
  )
  .replace(/import\s*\{\s*ElTimePicker\s*\}\s*from\s*['"]element-plus['"];?/, '')
  .replace('export default', 'return')
const controls = []
const PickerBoundary = defineComponent({
  props: { modelValue: { type: String, default: '' } },
  emits: ['update:modelValue', 'change', 'visible-change'],
  setup(props, { emit, attrs }) {
    controls.push({ props, emit, attrs })
    return () => h('input', { value: props.modelValue })
  }
})
const Component = new Function('Vue', 'ElTimePicker', code)(Vue, PickerBoundary)
const node = (type) => ({ type, children: [], props: {} })
const { createApp } = createRenderer({
  createElement: node,
  createText: (text) => ({ ...node('text'), text }),
  createComment: (text) => ({ ...node('comment'), text }),
  setText: (target, text) => {
    target.text = text
  },
  setElementText: (target, text) => {
    target.text = text
  },
  patchProp: (target, key, _old, value) => {
    target.props[key] = value
  },
  insert(target, parent, anchor = null) {
    if (target.parent) target.parent.children.splice(target.parent.children.indexOf(target), 1)
    const index = anchor ? parent.children.indexOf(anchor) : -1
    parent.children.splice(index < 0 ? parent.children.length : index, 0, target)
    target.parent = parent
  },
  remove(target) {
    if (target.parent) target.parent.children.splice(target.parent.children.indexOf(target), 1)
  },
  parentNode: (target) => target.parent,
  nextSibling: (target) =>
    target.parent?.children[target.parent.children.indexOf(target) + 1] || null
})

const task = ref('task-a')
const monthly = ref(false)
const config = ref({
  'task-a': {
    dailyTimes: ['09:00', '18:00'],
    monthlySchedules: [
      { day: 1, time: '09:00' },
      { day: 20, time: '18:00' }
    ]
  },
  'task-b': { dailyTime: '07:30', monthlyDays: [3], monthlyTime: '07:30' }
})
const writes = []
const app = createApp({
  setup() {
    return () => {
      const id = task.value
      const current = config.value[id]
      const key = monthly.value ? 'monthlySchedules' : 'dailyTimes'
      const slots = monthly.value
        ? current.monthlySchedules ||
          current.monthlyDays.map((day) => ({ day, time: current.monthlyTime }))
        : current.dailyTimes || [current.dailyTime]
      return h(
        'div',
        {},
        slots.map((slot, index) =>
          h(Component, {
            key: `${id}:${key}:${index}`,
            modelValue: monthly.value ? slot.time : slot,
            'data-slot': `${id}:${key}:${index}`,
            onChange(value) {
              const next = slots.map((item, offset) =>
                offset !== index ? item : monthly.value ? { ...item, time: value } : value
              )
              const patch = normalizeTaskSchedulePatch(current, { [key]: next })
              writes.push({ id, patch })
              config.value[id] = { ...current, ...patch }
            }
          })
        )
      )
    }
  }
})
try {
  app.mount(node('root'))
  await settle()
  let first = controls.at(-2)
  assert.equal(first.props.modelValue, '09:00')
  first.emit('visible-change', true)
  for (const value of ['10:00', '10:15', '11:45']) {
    first.emit('update:modelValue', value)
    await settle()
    assert.equal(
      first.props.modelValue,
      value,
      'spinner edits must not snap back to the old parent value'
    )
  }
  assert.equal(writes.length, 0, 'scrolling is not a persistence event')
  assert.deepEqual(config.value['task-a'].dailyTimes, ['09:00', '18:00'])
  first.emit('change', '11:45')
  await settle()
  assert.deepEqual(config.value['task-a'].dailyTimes, ['11:45', '18:00'])
  assert.equal(writes.length, 1)
  first.emit('visible-change', false)
  await settle()

  // Cancel mirrors the picker reverting its live model, without change.
  first.emit('visible-change', true)
  first.emit('update:modelValue', '22:30')
  await settle()
  first.emit('update:modelValue', '11:45')
  first.emit('visible-change', false)
  await settle()
  assert.equal(first.props.modelValue, '11:45')
  assert.equal(writes.length, 1, 'cancel must not save')

  // A config refresh while the panel is open must not override its live value.
  first.emit('visible-change', true)
  first.emit('update:modelValue', '23:50')
  config.value['task-a'] = { ...config.value['task-a'], dailyTimes: ['12:00', '18:00'] }
  await settle()
  assert.equal(first.props.modelValue, '23:50')
  assert.equal(writes.length, 1)
  first.emit('change', '23:50')
  await settle()
  assert.deepEqual(
    config.value['task-a'].dailyTimes,
    ['18:00', '23:50'],
    'sort only on commit, preserving the other slot'
  )
  first.emit('visible-change', false)
  await settle()
  assert.equal(first.props.modelValue, '18:00')

  // A keyed task switch removes the old picker. Delayed callbacks cannot write
  // its draft to the newly selected task, even if the original child emits late.
  first.emit('visible-change', true)
  first.emit('update:modelValue', '21:00')
  task.value = 'task-b'
  await settle()
  first.emit('change', '21:00')
  await settle()
  assert.equal(writes.length, 2)
  first = controls.at(-1)
  assert.equal(first.props.modelValue, '07:30', 'legacy dailyTime remains editable')
  first.emit('visible-change', true)
  first.emit('update:modelValue', '08:25')
  await settle()
  first.emit('visible-change', false)
  assert.equal(
    first.props.modelValue,
    '08:25',
    'Enter closes before change; keep the live value for the same-tick confirmation'
  )
  first.emit('change', '08:25')
  await settle()
  assert.deepEqual(config.value['task-b'].dailyTimes, ['08:25'])
  assert.equal(config.value['task-b'].dailyTime, '08:25')

  monthly.value = true
  task.value = 'task-a'
  await settle()
  const month = controls.findLast(
    (control) => control.attrs['data-slot'] === 'task-a:monthlySchedules:0'
  )
  assert.ok(month, 'locate the first monthly slot by identity, not mount ordering')
  month.emit('visible-change', true)
  month.emit('update:modelValue', '16:20')
  await settle()
  assert.equal(month.props.modelValue, '16:20')
  assert.equal(writes.length, 3)
  month.emit('change', '16:20')
  await settle()
  assert.deepEqual(config.value['task-a'].monthlySchedules, [
    { day: 1, time: '16:20' },
    { day: 20, time: '18:00' }
  ])
  month.emit('visible-change', false)
  await settle()
  month.emit('visible-change', true)
  month.emit('update:modelValue', '18:00')
  await settle()
  assert.equal(writes.length, 4)
  month.emit('update:modelValue', '16:20')
  month.emit('visible-change', false)
  await settle()
  assert.equal(month.props.modelValue, '16:20')
  assert.equal(writes.length, 4)
} finally {
  app.unmount()
}

// Verify both actual task-page picker bindings compile and have task-scoped keys.
const page = fs.existsSync(path.join(root, 'render/main/components/Tasks.vue'))
  ? path.join(root, 'render/main/components/Tasks.vue')
  : path.join(root, 'Anywhere_main/src/components/Tasks.vue')
const descriptor = parse(fs.readFileSync(page, 'utf8'), { filename: page }).descriptor
const script = compileScript(descriptor, { id: 'task-page-regression' })
const template = compileTemplate({
  source: descriptor.template.content,
  filename: page,
  id: 'task-page-regression',
  compilerOptions: { bindingMetadata: script.bindings }
})
assert.deepEqual(template.errors, [])
assert.match(template.code, /\$setup\["TaskTimePicker"\]/)
assert.match(
  descriptor.template.content,
  /<TaskTimePicker :key="`\$\{activeTaskId\}:daily:\$\{idx\}`"/
)
assert.match(
  descriptor.template.content,
  /<TaskTimePicker :key="`\$\{activeTaskId\}:monthly:\$\{idx\}`"/
)
console.log(
  'PASS task time picker: live spinner/input, confirm-only save, cancel, refresh isolation, multi-slot sort, task switch, legacy daily time and monthly pairs'
)
