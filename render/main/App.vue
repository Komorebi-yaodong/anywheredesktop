<script setup>
const appWindowType = window.api?.appWindowType || 'main'

const openWindow = async (type) => {
  try {
    if (window.api?.openWindow) {
      await window.api.openWindow(type)
    }
  } catch (error) {
    console.error('[render:main] openWindow failed', error)
  }
}


const hideMainWindow = async () => {
  try {
    if (window.api?.hideMainWindow) {
      await window.api.hideMainWindow()
    }
  } catch (error) {
    console.error('[render:main] hideMainWindow failed', error)
  }
}
</script>

<template>
  <div class="page">
    <h1>Anywhere Main (Desktop)</h1>
    <p>当前窗口：{{ appWindowType }}</p>
    <div class="actions">
      <button @click="openWindow('window')">打开对话窗口</button>
      <button @click="openWindow('fast')">打开快捷窗口</button>

      <button @click="hideMainWindow">隐藏主窗口</button>
    </div>
  </div>
</template>
