<script setup>
const appWindowType = window.api?.appWindowType || 'fast_window'

const openWindow = async (type) => {
  try {
    if (window.api?.openWindow) {
      await window.api.openWindow(type)
    }
  } catch (error) {
    console.error('[render:fast_window] openWindow failed', error)
  }
}


const showMainWindow = async () => {
  try {
    if (window.api?.showMainWindow) {
      await window.api.showMainWindow()
    }
  } catch (error) {
    console.error('[render:fast_window] showMainWindow failed', error)
  }
}
</script>

<template>
  <div class="page fast">
    <h1>Anywhere Fast Window</h1>
    <p>当前窗口：{{ appWindowType }}</p>
    <div class="actions">
      <button @click="openWindow('main')">主窗口</button>

      <button @click="showMainWindow">显示主窗口</button>
      <button @click="openWindow('window')">对话窗口</button>
    </div>
  </div>
</template>
