<script setup>
import { ref } from 'vue'

const appWindowType = window.api?.appWindowType || 'window'
const lastIncomingEvent = ref('（暂无）')

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

const emitToMainWindow = async () => {
  try {
    if (window.api?.emitWindowEvent) {
      await window.api.emitWindowEvent({
        target: 'main',
        event: 'append-message',
        payload: {
          from: 'window',
          message: 'hello from window'
        }
      })
    }
  } catch (error) {
    console.error('[render:window] emitToMainWindow failed', error)
  }
}

if (window.api?.onWindowEvent) {
  window.api.onWindowEvent((event) => {
    lastIncomingEvent.value = JSON.stringify(event)
  })
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
      <button @click="emitToMainWindow">发送消息到主窗口</button>
    </div>
    <p>最近收到事件：{{ lastIncomingEvent }}</p>
  </div>
</template>
