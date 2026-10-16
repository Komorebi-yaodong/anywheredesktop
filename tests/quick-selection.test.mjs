import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import vm from 'node:vm'
import { computed, effectScope, nextTick, ref, watch } from 'vue'
import { pinyin } from 'pinyin-pro'

// Execute the real setup logic with synthetic data, without mounting Electron or reading user config.
const source = await fs.readFile(new URL('../render/quick/App.vue', import.meta.url), 'utf8')
const setup = source.match(/<script setup>([\s\S]*?)<\/script>/)?.[1]
assert.ok(setup, 'quick window setup must exist')
const scope = effectScope()
const context = vm.createContext({
  computed, nextTick, ref, watch, pinyin,
  onMounted() {},
  onBeforeUnmount() {},
  ElMessage: {},
  window: {},
  console
})
const state = scope.run(() => vm.runInContext(
  `${setup.replace(/^import .+$/gm, '')}\n;` +
  `({ currentConfig, queryText, selectedPromptKey, shouldShowSelection, candidateSections,
      selectedPrompt, attachment, quickMode, handleKeydown })`,
  context
))
const opened = []
context.recordOpened = (prompt) => opened.push(prompt?.key ?? null)
vm.runInContext('openPrompt = recordOpened', context)

function keydown(key, isComposing = false) {
  state.handleKeydown({ key, isComposing, preventDefault() {} })
}

function assertFirstSelected() {
  const firstKey = state.candidateSections.value[0]?.key || ''
  assert.equal(state.selectedPromptKey.value, firstKey)
  assert.equal(state.selectedPrompt.value?.key || '', firstKey)
  assert.equal(state.shouldShowSelection.value, Boolean(firstKey))
}

try {
  state.currentConfig.value = {
    prompts: {
      Alpha: { type: 'general' },
      Beta: { type: 'general' },
      Gamma: { type: 'general' },
      Disabled: { type: 'general', enable: false }
    }
  }
  await nextTick()
  assertFirstSelected()
  assert.equal(state.selectedPromptKey.value, 'Alpha')

  // The original first item remains eligible but is no longer ranked first.
  state.queryText.value = 'Beta'
  assertFirstSelected() // Even immediate Enter must dispatch the new first item.
  await nextTick()
  assert.ok(state.candidateSections.value.some((item) => item.key === 'Alpha'))
  assert.equal(state.candidateSections.value[0].key, 'Beta')
  assertFirstSelected()
  keydown('Enter')
  assert.equal(opened.at(-1), 'Beta')

  // Navigation must not invalidate the list or reset the user's manual selection.
  const rankedList = state.candidateSections.value
  keydown('ArrowRight')
  const manualKey = state.selectedPromptKey.value
  assert.notEqual(manualKey, 'Beta')
  assert.equal(state.candidateSections.value, rankedList)
  await nextTick()
  assert.equal(state.selectedPromptKey.value, manualKey)
  keydown('Enter')
  assert.equal(opened.at(-1), manualKey)
  keydown('Enter', true)
  assert.equal(opened.length, 2, 'IME confirmation must not dispatch a prompt')

  state.queryText.value = 'Gamma'
  await nextTick()
  assert.equal(state.selectedPromptKey.value, 'Gamma')
  assertFirstSelected()
  state.queryText.value = ''
  await nextTick()
  assert.equal(state.selectedPromptKey.value, 'Alpha')
  assertFirstSelected()

  // Window initialization can explicitly select a prompt after applying its input payload.
  state.queryText.value = 'Beta'
  state.selectedPromptKey.value = 'Gamma'
  await nextTick()
  assert.equal(state.selectedPromptKey.value, 'Gamma', 'explicit init selection must not be overwritten later')
  state.queryText.value = 'Gamma'
  assertFirstSelected()

  // Attachment filtering can produce no candidates; stale selection must be cleared.
  state.attachment.value = { type: 'multiline-text', rawText: 'synthetic\nattachment' }
  state.queryText.value = 'no-matching-assistant'
  await nextTick()
  assert.equal(state.candidateSections.value.length, 0)
  assertFirstSelected()
  state.queryText.value = 'Beta'
  await nextTick()
  assert.equal(state.selectedPromptKey.value, 'Beta')
  assertFirstSelected()

  // Append-only routing must not acquire a helper selection as the list changes.
  state.quickMode.value = 'append-only'
  state.selectedPromptKey.value = ''
  state.shouldShowSelection.value = false
  state.queryText.value = 'Gamma'
  await nextTick()
  assert.equal(state.selectedPromptKey.value, '')
  assert.equal(state.shouldShowSelection.value, false)

  console.log('Quick selection regression passed: reorder, Enter, navigation, clear, empty list, IME, append-only')
} finally {
  scope.stop()
}
