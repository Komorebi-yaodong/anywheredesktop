<script setup>
import { nextTick, onBeforeUnmount, ref, watch } from 'vue'
import { ElTimePicker } from 'element-plus'

const props = defineProps({
  modelValue: { type: String, default: '' }
})
const emit = defineEmits(['change'])
const draft = ref(props.modelValue)
let editing = false
let disposed = false

// Spinner picks update the local model before Element Plus emits change.
// Keep the parent schedule untouched until confirmation so sorting/deduplication
// and asynchronous config receipts cannot move the row while it is being edited.
watch(
  () => props.modelValue,
  (value) => {
    if (!editing) draft.value = value
  }
)

function handleVisibleChange(visible) {
  editing = visible
  if (!visible) {
    // Enter may close the panel before its change callback. Let that callback
    // and the parent's synchronous commit settle before reconciling the row.
    nextTick(() => {
      if (!disposed && !editing) draft.value = props.modelValue
    })
  }
}

function commit(value) {
  if (!disposed && typeof value === 'string' && value !== props.modelValue) {
    emit('change', value)
  }
}

onBeforeUnmount(() => {
  disposed = true
})
</script>

<template>
  <ElTimePicker
    v-model="draft"
    format="HH:mm"
    value-format="HH:mm"
    :clearable="false"
    @change="commit"
    @visible-change="handleVisibleChange"
  />
</template>
