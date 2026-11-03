import assert from 'node:assert/strict'
import { pathToFileURL } from 'node:url'
import { createRemoteSessionManager } from '../main/core/remote/sessionManager.js'
import { createBusinessProtocol } from '../main/core/remote/businessProtocol.js'
import { createOperationJournal } from '../main/core/remote/operationJournal.js'
import contract from '../packages/remote-contract/index.cjs'

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const deviceId = 'device-metadata-lifecycle-fixture',
  cid = 'conversation-metadata-lifecycle-fixture'
export async function runMetadataLifecycle(createRouter) {
  let cases = 0
  for (const promotion of [
    'none',
    'during-create',
    'during-command',
    'existing',
    'cleanup-failure'
  ]) {
    const items = [],
      calls = [],
      events = [],
      pending = []
    let manager,
      nextWindow = 0,
      openPromise,
      releaseClose
    const closeGate = new Promise((resolve) => {
      releaseClose = resolve
    })
    const window = () => ({
      id: `metadata-window-${++nextWindow}`,
      type: 'window',
      conversationId: cid,
      remoteHidden: true,
      mobileControlled: true,
      rendererReady: true,
      leasePending: false
    })
    if (promotion === 'existing') items.push(window())
    manager = createRemoteSessionManager({
      getConfig: async () => ({ config: { webdav: { localChatPath: 'synthetic-only' } } }),
      openConversation: async () => ({
        descriptor: { conversationId: cid, title: 'Synthetic' },
        sessionData: { CODE: 'AI' }
      }),
      listWindows: () => items,
      getWindowByRef: (id) =>
        items.some((item) => item.id === id) ? { isDestroyed: () => false } : null,
      openWindow: async () => {
        const item = window()
        items.push(item)
        if (promotion === 'during-create' && !openPromise)
          openPromise = manager.openForMobile({ deviceId, params: { conversationId: cid } })
        return { ok: true, id: item.id }
      },
      dispatchRemoteCommandToWindow: async (windowRef, command) => {
        calls.push(command.type)
        if (command.type === 'remote.shutdown') {
          if (promotion === 'cleanup-failure') return { ok: false }

          pending.push(
            closeGate.then(() => {
              const index = items.findIndex((item) => item.id === windowRef)
              if (index >= 0) items.splice(index, 1)
              manager.handleWindowClosed(windowRef)
            })
          )
        } else {
          if (promotion === 'during-command' && !openPromise)
            openPromise = manager.openForMobile({ deviceId, params: { conversationId: cid } })
          pending.push(
            sleep(5).then(() => {
              manager.handleRendererEvent({
                windowRef,
                payload: {
                  conversationId: cid,
                  requestId: command.requestId,
                  event: 'conversation.operation.completed',
                  payload: {
                    operation: command.type,
                    ...(command.type === 'conversation.delete'
                      ? { deleted: true }
                      : { revision: 2 })
                  }
                }
              })
              if (command.type === 'conversation.delete') {
                items.splice(0)
                manager.handleWindowClosed(windowRef)
              }
            })
          )
        }
        return { ok: true }
      },
      revealRemoteConversationWindow: () => ({ ok: true }),
      broadcastToDevice: (_id, event) => events.push(event),
      readinessTimeoutMs: 500
    })
    if (promotion === 'existing')
      await manager.openForMobile({ deviceId, params: { conversationId: cid } })
    const journal = createOperationJournal({ load: async () => null, save: async () => {} })
    const protocol = createBusinessProtocol({
      readService: {},
      getManager: () => manager,
      operations: journal,
      dispatch: (_, requestId, method, params) =>
        manager[
          {
            'conversation.project.set': 'setConversationProject',
            'conversation.rename': 'renameConversation',
            'conversation.delete': 'deleteConversation'
          }[method]
        ]({ deviceId, requestId, params })
    })
    const context = {
      device: { deviceId },
      capabilities: ['conversation.project.set', 'conversation.rename', 'conversation.delete']
    }
    const raw = async (method, params) => {
      if (method === 'remote.contract.negotiate') return protocol.negotiate(context, params)
      if (method === 'conversation.control.get')
        return manager.runtimeSnapshot({ deviceId, params })
      if (method === 'command.submit') return protocol.command(context, params)
      if (method === 'operation.status.get') return protocol.operationStatus(context, params)
      throw new Error(method)
    }
    const router = createRouter?.(raw)
    router?.welcome(['remote.contract.negotiate', 'conversation.control.get'])
    if (!router) protocol.negotiate(context, { versions: [{ major: 1, minor: 1 }] })
    let count = 0
    async function submit(method, extra) {
      const issuedAt = Date.now(),
        commandId = `command-${issuedAt}-lifecycle-fixture-${++count}`
      const params = { conversationId: cid, ...extra }
      if (router) await router.route(method, params, 20000, commandId, issuedAt)
      else
        await protocol.command(context, {
          commandId,
          issuedAt,
          method,
          params,
          preconditions: {
            controlEpoch: manager.runtimeSnapshot({ deviceId, params: { conversationId: cid } })
              .control.epoch
          }
        })
      return commandId
    }
    async function state(commandId) {
      if (router)
        return router.route(
          'conversation.request.get',
          { requestId: commandId },
          20000,
          'poll-lifecycle',
          Date.now()
        )
      const s = contract.validateDurableOperation(
        await protocol.operationStatus(context, { operationId: commandId })
      )
      return (
        s.progress || {
          terminal: s.terminal,
          event:
            s.state === 'succeeded'
              ? 'conversation.operation.completed'
              : 'conversation.operation.failed',
          result: s.receipt
        }
      )
    }
    async function finish(id) {
      for (let n = 0; n < 200; n++) {
        const s = await state(id)
        if (s.terminal) {
          assert.equal(
            s.event,
            'conversation.operation.completed',
            JSON.stringify({ promotion, s, calls })
          )
          return s
        }
        await sleep(5)
      }
      throw new Error('synthetic operation did not settle')
    }
    const moved = await submit('conversation.project.set', { projectId: '' })
    if (promotion === 'cleanup-failure') {
      let failed
      for (let n = 0; n < 200; n++) {
        failed = await state(moved)
        if (failed.terminal) break
        await sleep(5)
      }
      assert.equal(failed.event, 'conversation.operation.failed')
      assert.equal(failed.result.code, 'remote_writer_release_timeout')
      assert.equal(calls.filter((method) => method === 'conversation.project.set').length, 1)
      assert.equal(manager.openedSessions({ deviceId }).sessions.length, 0)
      items.splice(0)
      manager.handleWindowClosed('metadata-window-1')
      await manager.closeAll()
      releaseClose()
      await Promise.all(pending)
      cases++
      continue
    }

    if (promotion === 'none') {
      for (let n = 0; n < 100 && !calls.includes('remote.shutdown'); n++) await sleep(5)
      assert.ok(calls.includes('remote.shutdown'))
      assert.equal(
        manager.openedSessions({ deviceId }).sessions.length,
        0,
        'one-shot writer must never be offered as opened'
      )
      assert.equal(
        (await state(moved)).terminal,
        false,
        'close must finish before terminal completion'
      )
      releaseClose()
      await finish(moved)
      assert.equal(items.length, 0)
    } else {
      await finish(moved)
      await openPromise
      assert.equal(
        calls.includes('remote.shutdown'),
        false,
        'explicitly opened writer must survive metadata completion'
      )
      assert.equal(manager.openedSessions({ deviceId }).sessions.length, 1)
      releaseClose()
    }
    const renamed = await submit('conversation.rename', { title: 'Synthetic rename' })
    await finish(renamed)
    if (promotion === 'none') assert.equal(items.length, 0)
    const deleted = await submit('conversation.delete', { confirmed: true })
    await finish(deleted)
    assert.equal(items.length, 0)
    assert.equal(calls.filter((method) => method === 'conversation.project.set').length, 1)
    assert.equal(calls.filter((method) => method === 'conversation.rename').length, 1)
    assert.equal(calls.filter((method) => method === 'conversation.delete').length, 1)
    await Promise.all(pending)
    await manager.closeAll()
    cases++
  }
  console.log(
    JSON.stringify({
      ok: true,
      suite: 'remote-metadata-lifecycle',
      cases,
      mobileRouter: Boolean(createRouter)
    })
  )
}
if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url)
  await runMetadataLifecycle()
