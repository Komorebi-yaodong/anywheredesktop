<script setup>
import { ref } from 'vue'

const appWindowType = window.api?.appWindowType || 'main'
const lastIncomingEvent = ref('（暂无）')

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

const emitToAllWindows = async () => {
  try {
    if (window.api?.emitWindowEvent) {
      await window.api.emitWindowEvent({
        target: 'type:window',
        event: 'append-message',
        payload: {
          from: 'main',
          message: 'hello from main'
        }
      })
    }
  } catch (error) {
    console.error('[render:main] emitToAllWindows failed', error)
  }
}

const refreshWindows = async () => {
  try {
    if (window.api?.listWindows) {
      const result = await window.api.listWindows('')
      lastIncomingEvent.value = JSON.stringify(result)
    }
  } catch (error) {
    console.error('[render:main] refreshWindows failed', error)
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
    <h1>Anywhere Main (Desktop)</h1>
    <p>当前窗口：{{ appWindowType }}</p>
    <div class="actions">
      <button @click="openWindow('window')">打开对话窗口</button>
      <button @click="openWindow('fast')">打开快捷窗口</button>
      <button @click="hideMainWindow">隐藏主窗口</button>
      <button @click="emitToAllWindows">广播到对话窗口</button>
      <button @click="refreshWindows">查询窗口列表</button>
    </div>
    <p>最近收到事件：{{ lastIncomingEvent }}</p>
  </div>
</template>
