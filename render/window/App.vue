<script setup>
const appWindowType = window.api?.appWindowType || 'window'

const openWindow = async (type) => {
  try {
    if (window.api?.openWindow) {
      await window.api.openWindow(type)
    }
  } catch (error) {
    console.error('[render:window] openWindow failed', error)
  }
}


const showMainWindow = async () => {
  try {
    if (window.api?.showMainWindow) {
      await window.api.showMainWindow()
    }
  } catch (error) {
    console.error('[render:window] showMainWindow failed', error)
  }
}
</script>

<template>
  <div class="page">
    <h1>Anywhere Window (Desktop)</h1>
    <p>当前窗口：{{ appWindowType }}</p>
    <div class="actions">
      <button @click="openWindow('main')">打开主窗口</button>

      <button @click="showMainWindow">显示主窗口</button>
      <button @click="openWindow('fast')">打开快捷窗口</button>
    </div>
  </div>
</template>
