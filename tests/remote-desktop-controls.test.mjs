import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import vm from 'node:vm'
import {ref, computed} from 'vue'

const root = new URL('../', import.meta.url)
const read = file => fs.readFile(new URL(file, root), 'utf8')
const source = await read('render/main/components/RemoteConnections.vue')
const script = source.slice(source.indexOf('const visible ='), source.indexOf('defineExpose('))
const calls = []
let sessions = [
  {conversationId: 'conversation-one-fixture', deviceId: 'phone-one', title: 'One', hidden: true},
  {conversationId: 'conversation-two-fixture', deviceId: 'phone-two', title: 'Two', hidden: false}
]
const sandbox = {
  ref, computed, onBeforeUnmount() {}, console,
  ElMessage: {error: message => calls.push(['error', message]), success: message => calls.push(['success', message]), warning() {}},
  ElMessageBox: {confirm: async () => {calls.push(['confirm'])}},
  window: {api: {
    listRemoteControlledSessions: async () => ({ok: true, sessions}),
    observeRemoteConversation: async conversationId => {calls.push(['open', conversationId]); return {ok: true, reused: true}},
    takeoverRemoteConversation: async (conversationId, confirmed) => {calls.push(['takeover', conversationId, confirmed]); sessions = sessions.filter(session => session.conversationId !== conversationId); return {ok: true}}
  }}
}
const ui = vm.runInNewContext(script + '\n;({viewDeviceSessions, deviceSessions, sessionCount, openControlledSession, takeOverSession})', sandbox)
await ui.viewDeviceSessions({deviceId: 'phone-one', displayName: 'Long device name fixture'})
assert.equal(ui.deviceSessions.value.length, 1)
assert.equal(ui.deviceSessions.value[0].title, 'One')
assert.equal(ui.sessionCount({deviceId: 'phone-two'}), 1)
await ui.openControlledSession(ui.deviceSessions.value[0])
assert.deepEqual(calls.find(call => call[0] === 'open'), ['open', 'conversation-one-fixture'])
assert.equal(calls.some(call => call[0] === 'takeover'), false, 'opening must not silently take control')
await ui.takeOverSession(ui.deviceSessions.value[0])
assert.deepEqual(calls.find(call => call[0] === 'takeover'), ['takeover', 'conversation-one-fixture', true])
assert.equal(ui.deviceSessions.value.length, 0)
assert.ok(calls.findIndex(call => call[0] === 'confirm') < calls.findIndex(call => call[0] === 'takeover'))

const chats = await read('render/main/components/Chats.vue')
assert.match(chats, /remote-control-tag[\s\S]*?@click\.stop="openRemoteControlledFile\(row.file\)"/)
assert.match(chats, /\.remote-control-tag\s*\{[^}]*max-width:\s*132px;[^}]*text-overflow:\s*ellipsis/)
assert.match(chats, /\.list-title.is-remote-controlled[^}]*var\(--el-color-primary\)/)
assert.match(chats, /const controlled = normalizedFiles.find/)
const chatBlock = chats.slice(chats.indexOf('const remoteControlledSessions'), chats.indexOf('const currentPage'))
const history = vm.runInNewContext(chatBlock + '\n;({refreshRemoteControls, remoteControlForFile, openRemoteControlledFile})', {
  ref, activeView: ref('local'), window: sandbox.window, ElMessage: sandbox.ElMessage
})
await history.refreshRemoteControls()
assert.equal(history.remoteControlForFile({conversationId: 'conversation-two-fixture'}).deviceId, 'phone-two')
await history.openRemoteControlledFile({conversationId: 'conversation-two-fixture'})
assert.ok(calls.some(call => call[0] === 'open' && call[1] === 'conversation-two-fixture'))
const input = await read('render/window/components/ChatInput.vue')
assert.match(input, /v-if="remoteControlled" class="remote-control-action"/)
assert.match(input, /@click="emit\('takeover-session'\)"/)
const window = await read('render/window/App.vue')
assert.match(window, /:remote-controlled="mobileControlActive"/)
assert.match(window, /@takeover-session="requestDesktopTakeover"/)
assert.match(window, /const accepted = await emitRemoteRendererEventAndWait\('conversation.desktop.control.result'/)
assert.match(window, /if \(accepted\?\.ok !== true\) throw/)
assert.match(window, /pendingRemoteConfigPatch: pendingRemoteConfigPatch.value/)
assert.match(window, /pendingRemoteConfigPatch.value = jsonData.pendingRemoteConfigPatch/)
const ipc = await read('main/ipcHandler.js')
assert.match(ipc, /sender.type === 'window' && sender.conversationId !== input.conversationId/)
const gateway = await read('main/core/remote/index.js')
assert.doesNotMatch(gateway, /case 'remote:(controlledSessions|takeoverOnDesktop)'/)
console.log(JSON.stringify({ok: true, suite: 'remote-desktop-controls'}))
