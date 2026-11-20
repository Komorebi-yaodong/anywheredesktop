import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import vm from 'node:vm'
import {
  isConversationHidden,
  isConversationTrayDrop,
  trayConversationEntries,
  visibleConversationPosition
} from '../main/core/conversationVisibility.js'
import { runTaskById } from '../main/core/task_runner.js'
import { createRemoteSessionManager } from '../main/core/remote/sessionManager.js'
import { getCurrentTaskDevice } from '../main/core/task_devices.js'

const display = {
  bounds: { x: -1920, y: -100, width: 1920, height: 1080 },
  workArea: { x: -1920, y: -75, width: 1920, height: 1015 }
}
const nearBottom = { x: -600, y: 240, width: 600, height: 700 }
const nearTop = { ...nearBottom, y: -75 }
const middle = { ...nearBottom, x: -1610, y: 150 }
assert(isConversationTrayDrop('win32', { x: -590, y: 252 }, nearBottom, display))
assert(!isConversationTrayDrop('win32', { x: -590, y: -64 }, nearTop, display))
assert(isConversationTrayDrop('darwin', { x: -590, y: -64 }, nearTop, display))
assert(!isConversationTrayDrop('darwin', { x: -590, y: 252 }, nearBottom, display))
assert(isConversationTrayDrop('win32', { x: -12, y: 956 }, middle, display))
assert(isConversationTrayDrop('darwin', { x: -12, y: -85 }, middle, display))
assert(!isConversationTrayDrop('win32', { x: -900, y: 100 }, middle, display))
assert(!isConversationTrayDrop('win32', { x: 400, y: 252 }, nearBottom, display))
assert(!isConversationTrayDrop('linux', { x: -12, y: -85 }, nearTop, display))
assert.deepEqual(visibleConversationPosition({ ...nearBottom, x: -20, y: 920 }, display.workArea), {
  x: -600,
  y: 240
})

const desktopWindow = {
  id: 'desktop-window',
  desktopHidden: true,
  conversationTitle: '&fixture\nname'
}
const mobileWindow = { id: 'mobile-window', remoteHidden: true, displayName: 'Mobile fixture' }
const minimizedWindow = {
  id: 'ordinary-minimized',
  visible: false,
  conversationTitle: 'not hidden'
}
assert(!isConversationHidden(minimizedWindow))
assert.deepEqual(
  trayConversationEntries(
    [desktopWindow, mobileWindow, minimizedWindow],
    new Set(['mobile-window'])
  ),
  [
    { windowRef: desktopWindow.id, title: '&&fixture name', mobile: false },
    { windowRef: mobileWindow.id, title: 'Mobile fixture', mobile: true }
  ]
)
assert.equal(
  trayConversationEntries([desktopWindow], new Set([desktopWindow.id]))[0].mobile,
  true,
  'icon follows control, not hide origin'
)

const task = { name: 'fixture', promptKey: '__DEFAULT__', appliedDevices: [getCurrentTaskDevice()] }
const launches = []
const taskArgs = {
  taskId: 'fixture',
  dataApi: { getConfig: async () => ({ config: { tasks: { fixture: task } } }) },
  openWindow: async (type, payload) => {
    assert.equal(type, 'window')
    launches.push(payload)
    return { ok: true }
  }
}
for (const showWindow of [undefined, true, false]) {
  task.showWindow = showWindow
  assert.equal((await runTaskById(taskArgs)).success, true)
}
assert.deepEqual(
  launches.map((payload) => payload.desktopHidden),
  [false, false, true]
)
assert(
  launches.every((payload) => !payload.remoteHidden),
  'local scheduling never pretends to be Mobile'
)

const cid = 'conversation-visibility-fixture'
const deviceId = 'device-visibility-fixture'
const item = { ...desktopWindow, type: 'window', conversationId: cid, rendererReady: true }
const commands = []
const manager = createRemoteSessionManager({
  getConfig: async () => ({ config: {} }),
  openConversation: async () => {
    throw Error('must not read storage for an open writer')
  },
  revealRemoteConversationWindow: () => {
    item.desktopHidden = false
    return { ok: true }
  },
  listWindows: () => [item],
  getWindowByRef: () => ({ isDestroyed: () => false }),
  openWindow: () => {
    throw Error('a second writer must never open')
  },
  dispatchRemoteCommandToWindow: async (windowRef, command) => {
    commands.push(command.type)
    if (command.type === 'conversation.mobile.takeover') {
      manager.handleRendererEvent({
        windowRef,
        payload: {
          conversationId: cid,
          requestId: command.requestId,
          event: 'conversation.mobile.control.result',
          payload: { ok: true, controlEpoch: command.controlEpoch }
        }
      })
    }
    return { ok: true }
  },
  broadcastToDevice() {}
})
const params = { conversationId: cid }
const getRuntime = () => manager.runtimeSnapshot({ deviceId, params })
assert.equal(getRuntime().control.owner, 'desktop')
const opened = await manager.openForMobile({ deviceId, params })
assert.equal(opened.mobileControlled, false)
assert.equal(opened.observingDesktop, true)
assert.equal(manager.openedSessions({ deviceId }).sessions[0].hidden, true)
await assert.rejects(
  manager.send({
    deviceId,
    requestId: 'request-no-implicit-control',
    params: { ...params, text: 'fixture' }
  }),
  { code: 'remote_conversation_takeover_required' }
)
assert.equal((await manager.release({ deviceId, params })).released, false)
assert.deepEqual(commands, [])
await manager.takeover({ deviceId, params })
assert.equal(getRuntime().control.owner, 'this_device')
assert(manager.mobileControlledWindowIds().has(item.id))
const ownedEpoch = getRuntime().control.epoch
item.desktopHidden = false
assert.equal(
  getRuntime().control.epoch,
  ownedEpoch,
  'restoring visibility does not transfer control'
)
assert.equal(getRuntime().control.owner, 'this_device')

// Exact logic in the chat executor: a hidden stream gets real incremental
// delivery and autosave even when Chromium never calls requestAnimationFrame.
const source = (
  await readFile(new URL('../render/window/App.vue', import.meta.url), 'utf8')
).replaceAll('\r\n', '\n')
const start = source.indexOf('        const cancelScheduledStreamingDisplay =')
const end = source.indexOf('        for await (const part of stream)', start)
assert(start > 0 && end > start)
const timers = new Map(),
  frames = new Map()
let serial = 0,
  updates = 0
const state = { value: true }
const displaySchedule = vm.runInNewContext(
  `let streamingDisplayRafId = null; let streamingDisplayTimer = null; let cancelPendingStreamingDisplay; ${source.slice(start, end)}; ({scheduleStreamingDisplay, cancelPendingStreamingDisplay});`,
  {
    conversationUiHidden: state,
    setTimeout: (callback) => {
      timers.set(++serial, callback)
      return serial
    },
    clearTimeout: (id) => timers.delete(id),
    requestAnimationFrame: (callback) => {
      frames.set(++serial, callback)
      return serial
    },
    cancelAnimationFrame: (id) => frames.delete(id),
    flushStreamingDisplay: () => {
      updates++
    }
  }
)
displaySchedule.scheduleStreamingDisplay()
displaySchedule.scheduleStreamingDisplay()
assert.equal(timers.size, 1)
assert.equal(frames.size, 0)
;[...timers.values()][0]()
assert.equal(updates, 1)
state.value = false
displaySchedule.scheduleStreamingDisplay()
assert.equal(frames.size, 1)
;[...frames.values()][0]()
assert.equal(timers.size, 0)
assert.equal(updates, 2)
displaySchedule.scheduleStreamingDisplay()
displaySchedule.cancelPendingStreamingDisplay()
assert.equal(timers.size + frames.size, 0)
console.log(
  'PASS hidden conversations: platform corners, tray owners, task default, Mobile gates and background streaming'
)
