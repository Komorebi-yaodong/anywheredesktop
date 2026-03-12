<script setup>
import { ref } from 'vue'

const appWindowType = window.api?.appWindowType || 'fast_window'
const lastIncomingEvent = ref('（暂无）')

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

const emitToWindowType = async () => {
  try {
    if (window.api?.emitWindowEvent) {
      await window.api.emitWindowEvent({
        target: 'type:window',
        event: 'append-message',
        payload: {
          from: 'fast_window',
          message: 'hello from fast window'
        }
      })
    }
  } catch (error) {
    console.error('[render:fast_window] emitToWindowType failed', error)
  }
}

if (window.api?.onWindowEvent) {
  window.api.onWindowEvent((event) => {
    lastIncomingEvent.value = JSON.stringify(event)
  })
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
      <button @click="emitToWindowType">发送消息到全部对话窗口</button>
    </div>
    <p>最近收到事件：{{ lastIncomingEvent }}</p>
  </div>
</template>
