import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import vm from 'node:vm'
import { ref } from 'vue'
import { createRemoteSessionManager } from '../main/core/remote/sessionManager.js'
import { createBusinessProtocol } from '../main/core/remote/businessProtocol.js'
import { createOperationJournal } from '../main/core/remote/operationJournal.js'
import * as store from '../main/core/conversationStore.js'
import { readLocalProjects, writeLocalProjects } from '../main/core/projects.js'

const source = (
  await fs.readFile(new URL('../render/window/App.vue', import.meta.url), 'utf8')
).replace(/\r\n/g, '\n')
const start = source.indexOf(
  "  if (['conversation.rename', 'conversation.delete', 'conversation.project.set'].includes(command.type))"
)
const end = source.indexOf('\n  if (', start + 10)
assert.ok(start > 0 && end > start)
const metadataHandler = source.slice(start, end)
const deviceId = 'device-bootstrap-fixture-001'
const methods = [
  ['conversation.delete', 'deleteConversation', { confirmed: true }],
  ['conversation.project.set', 'setConversationProject', { projectId: 'bootstrap-project' }],
  ['conversation.rename', 'renameConversation', { title: 'Renamed synthetic' }],
  ['conversation.send', 'send', { text: 'Synthetic message' }],
  [
    'conversation.message.edit',
    'editMessage',
    { uiMessageId: 'ui-bootstrap-fixture', content: 'Synthetic edit' }
  ],
  ['conversation.message.delete', 'deleteMessage', { uiMessageId: 'ui-bootstrap-fixture' }],
  ['conversation.message.reask', 'reaskMessage', { uiMessageId: 'ui-bootstrap-fixture' }],
  ['conversation.compact', 'compact', {}]
]
// Every shared writer-creating command, including the real startup metadata state.
for (const early of [false, true])
  for (const [method, handler, extra] of methods) {
    const cid = 'conversation-bootstrap-fixture-001',
      items = [],
      calls = []
    const manager = createRemoteSessionManager({
      getConfig: async () => ({ config: { webdav: { localChatPath: 'synthetic-only' } } }),
      openConversation: async () => ({
        descriptor: { conversationId: cid },
        sessionData: { CODE: 'AI' }
      }),
      listWindows: () => items,
      getWindowByRef: (id) =>
        items.some((x) => x.id === id) ? { isDestroyed: () => false } : null,
      openWindow: async () => {
        const item = {
          id: 'window-bootstrap-fixture',
          type: 'window',
          conversationId: cid,
          remoteHidden: true,
          mobileControlled: early,
          rendererReady: false,
          leasePending: true
        }
        items.push(item)
        setTimeout(() => {
          item.mobileControlled = true
          item.rendererReady = true
          item.leasePending = false
        }, 5)
        return { ok: true, id: item.id }
      },
      dispatchRemoteCommandToWindow: async (_, command) => {
        calls.push(command.type)
        return { ok: true }
      },
      revealRemoteConversationWindow: () => ({ ok: true }),
      broadcastToDevice() {},
      readinessTimeoutMs: 500
    })
    const operations = createOperationJournal({ load: async () => null, save: async () => {} })
    const protocol = createBusinessProtocol({
      readService: {},
      getManager: () => manager,
      operations,
      dispatch: (_, requestId, _method, params) => manager[handler]({ deviceId, requestId, params })
    })
    const context = { device: { deviceId }, capabilities: [method] }
    protocol.negotiate(context, { versions: [{ major: 1, minor: 1 }] })
    const issuedAt = Date.now(),
      commandId = `command-${issuedAt}-bootstrap-fixture-command`
    await protocol.command(context, {
      commandId,
      issuedAt,
      method,
      params: { conversationId: cid, ...extra },
      preconditions: { controlEpoch: 'window-none' }
    })
    const until = Date.now() + 1500
    while (!calls.includes(method) && Date.now() < until)
      await new Promise((resolve) => setTimeout(resolve, 10))
    assert.ok(
      calls.includes(method),
      `${method}, early=${early}: ${JSON.stringify(await operations.get(deviceId, commandId))}`
    )
    assert.equal(
      manager.runtimeSnapshot({ deviceId, params: { conversationId: cid } }).control.owner,
      'this_device'
    )
    items.splice(0)
    await manager.closeAll()
  }

// A bootstrap attestation is not permission for an unrelated writer or later takeover.
for (const change of [
  'foreign',
  'replaced',
  'revealed',
  'epoch',
  'closing',
  'readonly',
  'unattested',
  'bound-epoch'
]) {
  let session = null,
    ownEpoch = 'window-none',
    checkCalls = 0,
    dispatched = false
  const manager = {
    getSession: () => session,
    runtimeSnapshot: () => ({
      control: {
        epoch: ownEpoch,
        owner: session?.mobileDeviceId === deviceId ? 'this_device' : 'desktop'
      }
    }),
    withCommandGuard: async (guard, action) => {
      checkCalls++
      return action(guard)
    }
  }
  const operations = createOperationJournal({ load: async () => null, save: async () => {} })
  const protocol = createBusinessProtocol({
    readService: {},
    getManager: () => manager,
    operations,
    dispatch: async () => {
      // Model the exact capabilities ensureSession can call; no preexisting writer gets attested.
      const guardAction = manager.withCommandGuard
      assert.equal(typeof guardAction, 'function')
      const guard = manager.guard
      session = {
        conversationId: 'conversation-security-fixture',
        windowRef: 'own-window',
        controlEpoch: 'initial',
        hidden: true,
        mobileControlled: true,
        mobileDeviceId: ''
      }
      if (change !== 'unattested')
        guard.createdWriter({
          conversationId: session.conversationId,
          windowRef: session.windowRef,
          controlEpoch: session.controlEpoch
        })
      ownEpoch = 'startup-projection'
      guard()
      if (change === 'bound-epoch') {
        session.mobileDeviceId = deviceId
        session.controlEpoch = 'device-bound'
        ownEpoch = 'bound-projection'
        guard.bindWriter(session, deviceId, 'initial')
        session.controlEpoch = 'post-bind-external-change'
      }

      if (change === 'foreign') session.mobileDeviceId = 'another-device'
      if (change === 'replaced') session.windowRef = 'replacement'
      if (change === 'revealed') session.hidden = false
      if (change === 'epoch') session.controlEpoch = 'external-takeover'
      if (change === 'closing') session.closing = true
      if (change === 'readonly') session.readOnly = true
      ownEpoch = 'changed-projection'
      guard()
      dispatched = true
      return { ok: true }
    }
  })
  manager.withCommandGuard = (guard, action) => {
    manager.guard = guard
    checkCalls++
    return action()
  }
  const context = { device: { deviceId }, capabilities: ['conversation.delete'] }
  protocol.negotiate(context, { versions: [{ major: 1, minor: 1 }] })
  const issuedAt = Date.now(),
    commandId = `command-${issuedAt}-security-fixture-command`
  await protocol.command(context, {
    commandId,
    issuedAt,
    method: 'conversation.delete',
    params: { conversationId: 'conversation-security-fixture', confirmed: true },
    preconditions: { controlEpoch: 'window-none' }
  })
  await new Promise((resolve) => setTimeout(resolve, 20))
  const state = await operations.get(deviceId, commandId)
  assert.equal(state.state, 'failed', change)
  assert.equal(dispatched, false, change)
  assert.equal(checkCalls, 1)
}

// Actual Renderer metadata branch -> actual SQLite store with its own lease.
// No Main write fallback. All fixtures are created in a new temporary directory.
const root = await fs.mkdtemp(path.join(os.tmpdir(), 'anywhere-remote-bootstrap-'))
try {
  const untouched = await store.createConversation({
    dirPath: root,
    title: 'Untouched',
    sessionData: {
      CODE: 'AI',
      fullHistory: [{ role: 'user', content: 'control fixture' }],
      chat_show: []
    }
  })
  const controlFile = path.join(root, untouched.descriptor.dbFile)
  const controlHash = await fs.readFile(controlFile)
  let projects = await readLocalProjects(root)
  await writeLocalProjects(root, {
    ...projects,
    projects: [{ id: 'bootstrap-project', name: 'Target', files: [], conversationIds: [] }]
  })
  for (const [method, handler, extra] of methods.slice(0, 3)) {
    const created = await store.createConversation({
      dirPath: root,
      title: 'Original',
      sessionData: {
        CODE: 'AI',
        fullHistory: [{ role: 'user', content: 'target fixture' }],
        chat_show: []
      }
    })
    const cid = created.descriptor.conversationId,
      items = [],
      executions = []
    let manager, renderer
    manager = createRemoteSessionManager({
      getConfig: async () => ({ config: { webdav: { localChatPath: root } } }),
      openConversation: store.openConversation,
      listWindows: () => items,
      getWindowByRef: (id) =>
        items.some((x) => x.id === id) ? { isDestroyed: () => false } : null,
      openWindow: async () => {
        const item = {
          id: `writer-${cid}`,
          type: 'window',
          conversationId: cid,
          remoteHidden: true,
          mobileControlled: true,
          rendererReady: false,
          leasePending: true
        }
        items.push(item)
        const lease = await store.acquireWriteLease({
          dirPath: root,
          conversationId: cid,
          holderInstanceId: item.id
        })
        assert.equal(lease.ok, true)
        const opened = await store.openConversation({ dirPath: root, reference: cid })
        const emit = async (event, command, payload) =>
          manager.handleRendererEvent({
            windowRef: item.id,
            payload: { conversationId: cid, requestId: command.requestId, event, payload }
          })
        renderer = {
          Error,
          Date,
          console,
          activeRemoteCommand: ref(null),
          isClosingWindow: ref(false),
          loading: ref(false),
          compacting: ref(false),
          isPreparingSend: ref(false),
          isMcpLoading: ref(false),
          autoSaveExecutionPromise: null,
          currentConversationStorage: ref({ ...opened.descriptor, dirPath: root }),
          currentConfig: ref({ webdav: { localChatPath: root } }),
          conversationInstanceId: item.id,
          conversationLease: ref(lease),
          remoteConversationDeleted: ref(false),
          mobileControlActive: ref(true),
          remoteHiddenWriter: ref(true),
          ensureConversationWriteAccess: () => lease.ok,
          emitRemoteRendererEvent: emit,
          emitRemoteRendererEventAndWait: emit,
          finalizeRemoteCommand: (event, command, payload) => {
            emit(event, command, payload)
            renderer.activeRemoteCommand.value = null
          },
          renameOwnedConversation: async (input) => {
            const result = await store.renameConversation({
              ...input,
              title: input.title || renderer.currentConversationStorage.value.title,
              expectedRevision: renderer.currentConversationStorage.value.revision,
              holderInstanceId: item.id,
              leaseEpoch: lease.leaseEpoch
            })
            renderer.currentConversationStorage.value = {
              ...renderer.currentConversationStorage.value,
              ...result
            }
            return result
          },
          window: { api: { readLocalProjects, deleteConversation: store.deleteConversation } },
          clearScheduledAutoSave() {},
          scheduleConversationWindowStatusSync() {},
          stopConversationLeaseHeartbeat() {},
          closePage: async () => {
            items.splice(0)
            manager.handleWindowClosed(item.id)
            return true
          },
          syncAutoCloseOnBlurListener() {},
          flushAppendBuffer: async () => {},
          remoteCommandExecutionPromise: null
        }
        item.rendererReady = true
        item.leasePending = false
        return { ok: true, id: item.id }
      },
      dispatchRemoteCommandToWindow: async (_, command) => {
        if (command.type === 'remote.shutdown') {
          items.splice(0)
          return { ok: true }
        }
        renderer.command = command
        executions.push(vm.runInNewContext(`(async () => {${metadataHandler}})()`, renderer))
        return { ok: true }
      },
      revealRemoteConversationWindow: () => ({ ok: true }),
      broadcastToDevice() {},
      readinessTimeoutMs: 500
    })
    const operations = createOperationJournal({ load: async () => null, save: async () => {} })
    const protocol = createBusinessProtocol({
      readService: {},
      getManager: () => manager,
      operations,
      dispatch: (_, requestId, _method, params) => manager[handler]({ deviceId, requestId, params })
    })
    const context = { device: { deviceId }, capabilities: [method] }
    protocol.negotiate(context, { versions: [{ major: 1, minor: 1 }] })
    const issuedAt = Date.now(),
      commandId = `command-${issuedAt}-sqlite-fixture-command`
    await protocol.command(context, {
      commandId,
      issuedAt,
      method,
      params: { conversationId: cid, ...extra },
      preconditions: { controlEpoch: 'window-none' }
    })
    const until = Date.now() + 3000
    let state
    do {
      await new Promise((resolve) => setTimeout(resolve, 10))
      state = await protocol.operationStatus(context, { operationId: commandId })
    } while (!state.terminal && Date.now() < until)
    assert.equal(state.state, 'succeeded', JSON.stringify(state))
    await Promise.all(executions)
    projects = await readLocalProjects(root)
    if (method === 'conversation.delete') {
      await assert.rejects(fs.stat(path.join(root, created.descriptor.dbFile)), { code: 'ENOENT' })
      assert.equal(await store.conversationExists({ dirPath: root, conversationId: cid }), false)
    } else {
      const opened = await store.openConversation({ dirPath: root, reference: cid })
      if (method === 'conversation.rename') assert.equal(opened.descriptor.title, extra.title)
      else
        assert.ok(
          projects.projects.find((x) => x.id === extra.projectId).conversationIds.includes(cid)
        )
      await store.releaseWriteLease({
        dirPath: root,
        conversationId: cid,
        holderInstanceId: `writer-${cid}`,
        leaseEpoch: renderer.conversationLease.value.leaseEpoch
      })
    }
    assert.deepEqual(
      await fs.readFile(controlFile),
      controlHash,
      'other conversation database must not change'
    )
    items.splice(0)
    await manager.closeAll()
  }
} finally {
  await fs.rm(root, { recursive: true, force: true })
}
console.log(
  JSON.stringify({
    ok: true,
    suite: 'remote-writer-bootstrap',
    sharedCommandCases: 16,
    sqliteCases: 3,
    securityCases: 8
  })
)
