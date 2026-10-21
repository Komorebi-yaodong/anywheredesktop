import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import vm from 'node:vm'
import {ref, computed} from 'vue'
import {parse, compileStyle} from '@vue/compiler-sfc'

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

const remoteStyles = compileStyle({source: parse(source).descriptor.styles[0].content, filename: 'RemoteConnections.vue', id: 'data-v-layout', scoped: true})
assert.deepEqual(remoteStyles.errors, [])
const layoutRules = remoteStyles.rawResult.root.nodes.filter(node => node.type === 'rule')
const layoutRoot = layoutRules.find(node => node.selector === '.remote-v2-content[data-v-layout]')
const layoutDecls = Object.fromEntries(layoutRoot.nodes.filter(node => node.type === 'decl').map(node => [node.prop, node.value]))
assert.equal(layoutDecls['grid-template-columns'], 'minmax(0, 1fr)')
assert.equal(layoutDecls['min-width'], '0')
assert.equal(layoutDecls['max-width'], '100%')
assert.equal(layoutDecls['box-sizing'], 'border-box')
assert.match(source, /width="min\(760px, calc\(100vw - 32px\)\)"/)
assert.match(source, /\.remote-service-card, \.section-heading, \.remote-device-item \{ flex-wrap: wrap;/)
assert.match(source, /\.remote-device-item > \.device-meta \{ flex: 1 1 220px;/)
assert.match(source, /\.remote-section, \.remote-device-list \{ grid-template-columns: minmax\(0, 1fr\);/)
assert.match(source, /@container \(max-width: 580px\)/)

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
// Compile the real scoped stylesheet: a global selector must never strip the
// composer target, and toolbar icon sizing must not affect the text action.
const {descriptor} = parse(input)
const compiled = compileStyle({source: descriptor.styles[0].content, filename: 'ChatInput.vue', id: 'data-v-control-fixture', scoped: true})
assert.deepEqual(compiled.errors, [])
const rules = compiled.rawResult.root.nodes.filter(node => node.type === 'rule')
const styleFor = selector => {
  const rule = rules.find(node => node.selector === selector)
  assert.ok(rule, `compiled style missing: ${selector}`)
  return Object.fromEntries(rule.nodes.filter(node => node.type === 'decl').map(node => [node.prop, node.value]))
}
const scope = '[data-v-control-fixture]'
const light = styleFor(`.chat-input-area-vertical${scope}`)
const dark = styleFor(`html.dark .chat-input-area-vertical${scope}`)
assert.equal(rules.some(node => node.selector === 'html.dark'), false, 'dark composer styles must not become page-wide')
const button = styleFor(`.remote-control-action .remote-takeover-button${scope}`)
assert.equal(button.width, 'auto')
assert.equal(button['min-width'], '108px')
assert.equal(button.height, '30px')
assert.equal(rules.some(node => /^\.chat-input-area-vertical \.el-button/.test(node.selector)), false)
assert.ok(rules.some(node => node.selector.includes('.input-actions-bar .el-button')))
assert.match(compiled.code, /\.el-textarea__inner::placeholder/)
assert.match(input, /此会话由远端控制，接管后可在此输入/)
assert.match(input, /正在接管/)
assert.match(chats, /所选会话仍由远端设备控制，需要打开被控制会话单独关闭。/)
assert.doesNotMatch(chats, /请先打开会话并点击“接管会话”|请先打开并接管远端会话/)

// Check actual CSS colors over worst-case black/white wallpaper. These numbers
// validate local scrim contrast only, not a substitute for real glass rendering.
const rgb = hex => hex.slice(1).match(/.{2}/g).map(part => parseInt(part, 16))
const luminance = color => color.map(value => {
  const s = value / 255
  return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4
}).reduce((sum, value, index) => sum + value * [0.2126, 0.7152, 0.0722][index], 0)
const contrast = (a, b) => {
  const values = [luminance(a), luminance(b)].sort((left, right) => right - left)
  return (values[0] + 0.05) / (values[1] + 0.05)
}
assert.ok(luminance(rgb(light['--composer-placeholder'])) > luminance(rgb(light['--composer-ink'])) * 1.5, 'light placeholder must visibly recede from typed text')
assert.ok(luminance(rgb(dark['--composer-placeholder'])) < luminance(rgb(dark['--composer-ink'])) * 0.75, 'dark placeholder must visibly recede from typed text')

for (const theme of [light, dark]) {
  const [r, g, b, alpha] = theme.background.match(/[\d.]+/g).map(Number)
  for (const wallpaper of [0, 255]) {
    const background = [r, g, b].map(value => value * alpha + wallpaper * (1 - alpha))
    for (const token of ['--composer-ink', '--composer-placeholder']) {
      assert.ok(contrast(rgb(theme[token]), background) >= 4.5, `${token} must remain readable on glass`)
    }
  }
}
assert.ok(contrast(rgb(button.color), rgb(button.background)) >= 4.5)

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
