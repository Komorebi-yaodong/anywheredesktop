import assert from 'node:assert/strict'
import { createRemoteSessionManager } from '../main/core/remote/sessionManager.js'

const CID = 'conversation-session-fixture-0001'
const DEVICE = 'device-session-fixture-0001'
function fixture({ existing = false, dispatchFailure = false, allowControlCommands = false, stalled = false, uploadManager = null, takeoverReceipt = 'ok' } = {}) {
  const items = existing ? [{ id: 'window-existing', type: 'window', conversationId: CID, rendererReady: true, leasePending: false, remoteHidden: false }] : []
  const commands = [], events = [], opens = []
  let blocked = null
  const blocker = stalled ? new Promise((resolve) => { blocked = resolve }) : null
  const manager = createRemoteSessionManager({
    getConfig: async () => ({ config: { webdav: { localChatPath: 'fixture-only-path' } } }),
    openConversation: async (input) => {
      assert.equal(input.dirPath, 'fixture-only-path')
      if (blocker) await blocker
      return { descriptor: { conversationId: CID, title: 'Fixture' }, sessionData: { CODE: 'AI' } }
    },
    listWindows: () => items,
    getWindowByRef: (ref) => items.some((item) => item.id === ref) ? { isDestroyed: () => false } : null,
    openWindow: async (type, payload) => {
      opens.push(payload)
      const item = { id: `window-created-${opens.length}`, type, conversationId: CID, remoteHidden: true, rendererReady: true }
      items.push(item)
      return { ok: true, id: item.id }
    },
    dispatchRemoteCommandToWindow: async (windowRef, command) => {
      commands.push({ windowRef, ...command })

      if (command.type === 'conversation.mobile.takeover' && takeoverReceipt !== 'timeout' && (!dispatchFailure || allowControlCommands)) manager.handleRendererEvent({windowRef, payload: {conversationId: command.conversationId, requestId: command.requestId, event: 'conversation.mobile.control.result', payload: {ok: takeoverReceipt === 'ok', code: 'remote_conversation_save_failed'}}})
      if (command.type === 'remote.shutdown') items.splice(items.findIndex((item) => item.id === windowRef), 1)
      return { ok: !dispatchFailure || (allowControlCommands && /^conversation\.mobile\.(takeover|handoff)$/.test(command.type)) }
    },
    revealRemoteConversationWindow: (ref) => { items.find((item) => item.id === ref).remoteHidden = false; return { ok: true } },
    broadcastToDevice: (deviceId, event, payload) => events.push({ deviceId, event, payload }),
    uploadManager,
    readinessTimeoutMs: 100
  })
  return { manager, items, commands, events, opens, unblock: () => blocked?.() }
}
const send = (manager, requestId = 'request-fixture-0001', deviceId = DEVICE, text = 'Hello') => manager.send({
  deviceId, requestId, params: { conversationId: CID, text }
})
function renderer(f, event, payload = {}, requestId = 'request-fixture-0001', windowRef = f.items[0].id) {
  return f.manager.handleRendererEvent({ windowRef, payload: { conversationId: CID, requestId, event, payload } })
}

async function run() {
  {
    const items = [], opens = [];
    let config = {config: {webdav: {localChatPath: 'PRIVATE_FIXTURE_PATH'}, prompts: {
      Code: {prompt: 'PRIVATE_PROMPT', apiKey: 'PRIVATE_KEY'}, Disabled: {enable: false}, Moon: {enable: true}
    }}};
    const manager = createRemoteSessionManager({
      getConfig: async () => config,
      openConversation: async () => { throw new Error('new creation must not read old conversations'); },
      listWindows: () => items,
      getWindowByRef: () => ({isDestroyed: () => false}),
      openWindow: async (type, payload) => {
        opens.push(payload);
        await Promise.resolve();
        const item = {id: `new-window-${opens.length}`, type, conversationId: `new-conversation-fixture-${opens.length}`,
          conversationTitle: payload.conversationTitle, rendererReady: true, leasePending: false, remoteHidden: true};
        items.push(item);
        return {ok: true, id: item.id};
      },
      dispatchRemoteCommandToWindow: async () => ({ok: true}),
      revealRemoteConversationWindow: () => ({ok: true}), broadcastToDevice() {}, readinessTimeoutMs: 100
    });
    const assistants = await manager.listAssistants({deviceId: DEVICE});
    assert.deepEqual(
      assistants.assistants.map(({ code, name }) => ({ code, name })),
      [{code: 'Code', name: 'Code'}, {code: 'Moon', name: 'Moon'}]
    );
    assert.equal(JSON.stringify(assistants).includes('PRIVATE'), false);
    const input = {deviceId: DEVICE, requestId: 'request-create-fixture-0001', params: {promptCode: 'Code'}};
    const [created, duplicate] = await Promise.all([manager.createConversation(input), manager.createConversation(input)]);
    assert.equal(duplicate.duplicate, true);
    assert.equal(duplicate.conversationId, created.conversationId);
    assert.equal(opens.length, 1);
    assert.equal(opens[0].remoteCreate, true);
    assert.equal(opens[0].code, 'Code');
    assert.equal(opens[0].type, 'empty');
    assert.equal(JSON.stringify(created).includes('PRIVATE'), false);
    await assert.rejects(manager.createConversation({...input, params: {promptCode: 'Moon'}}), {code: 'remote_request_id_conflict'});
    await assert.rejects(manager.createConversation({...input, requestId: 'request-create-disabled', params: {promptCode: 'Disabled'}}), {code: 'remote_assistant_invalid'});
    await assert.rejects(manager.createConversation({...input, requestId: 'request-create-unknown', params: {promptCode: 'Missing'}}), {code: 'remote_assistant_invalid'});
    await assert.rejects(manager.createConversation({...input, requestId: 'request-create-path', params: {promptCode: 'Code', dirPath: 'FORBIDDEN'}}), {code: 'remote_path_parameter_forbidden'});
    config = {config: {prompts: {Code: {}}}};
    await assert.rejects(manager.createConversation({...input, requestId: 'request-create-no-dir'}), {code: 'remote_conversation_directory_not_configured'});
    await manager.revokeDevice(DEVICE);
    await assert.rejects(manager.listAssistants({deviceId: DEVICE}), {code: 'remote_device_revoked'});
  }


  const f = fixture()
  const results = await Promise.all([send(f.manager), send(f.manager, 'request-fixture-0002')])
  assert.equal(results[0].queued, false)
  assert.equal(results[1].queued, true)
  assert.equal(results[1].position, 1)
  assert.equal(f.manager.listSendQueue({ deviceId: DEVICE, params: { conversationId: CID } }).items.length, 1)
  assert.equal(f.opens.length, 1)
  assert.equal(f.commands.filter((item) => item.type === 'conversation.send').length, 1)
  assert.equal(f.opens[0].remoteHidden, true)
  assert.equal(f.commands[0].autoApproveTools, true)
  assert.equal((await send(f.manager)).duplicate, true)
  await assert.rejects(send(f.manager, 'request-fixture-0001', DEVICE, 'Changed'), { code: 'remote_request_id_conflict' })
  await assert.rejects(f.manager.send({ deviceId: DEVICE, requestId: 'request-forbidden', params: { conversationId: CID, text: 'hi', dirPath: 'C:/other' } }), { code: 'remote_path_parameter_forbidden' })
  assert.equal(renderer(f, 'assistant.delta', {}, 'request-fixture-0001', 'window-spoof').ok, false)
  assert.equal(renderer(f, 'assistant.delta', {}, 'request-spoof').ok, false)
  renderer(f, 'assistant.started', { startedAt: 'fixture' })
  renderer(f, 'assistant.delta', { textDelta: 'Hello', reasoningDelta: 'Thought', password: 'SECRET', segmentId: 'bubble-1', toolCalls: [{ id: 'tool-live-safe-0001', name: 'execute_bash_command', approvalStatus: 'executing', args: '{"command":"PRIVATE_COMMAND","cwd":"C:/PRIVATE"}', result: 'api_key=SECRET; C:/PRIVATE/result.txt' }] })
  renderer(f, 'assistant.delta', { textDelta: ' World', segmentId: 'bubble-2', toolCalls: [{ id: 'tool-live-safe-0001', name: 'execute_bash_command', approvalStatus: 'executing', args: '{"command":"PRIVATE_COMMAND","cwd":"C:/PRIVATE"}', result: 'api_key=SECRET; C:/PRIVATE/result.txt' }] })
  const state = f.manager.getRequest({ deviceId: DEVICE, params: { requestId: 'request-fixture-0001' } })
  assert.equal(state.text, ' World')
  assert.equal(state.reasoning, '')
  assert.equal(state.segmentId, 'bubble-2')
  assert.equal(state.terminal, false)
  assert.deepEqual(state.toolCalls, [{ id: 'tool-live-safe-0001', name: 'execute_bash_command', status: 'executing', arguments: '[参数已隐藏]' }])
  assert.deepEqual(f.events.find((event) => event.event === 'assistant.delta')?.payload.toolCalls, state.toolCalls)

  assert.equal(JSON.stringify(f.events).includes('SECRET'), false)
  assert.equal(JSON.stringify(f.events).includes('PRIVATE_COMMAND'), false)
  assert.equal(JSON.stringify(f.events).includes('C:/PRIVATE'), false)
  assert.throws(() => f.manager.getRequest({ deviceId: 'device-other-fixture', params: { requestId: 'request-fixture-0001' } }), { code: 'remote_request_not_found' })
  renderer(f, 'assistant.completed', { revision: 3, completedAt: 'fixture' })
  assert.equal(f.manager.getRequest({ deviceId: DEVICE, params: { requestId: 'request-fixture-0001' } }).result.revision, 3)
  assert.equal(renderer(f, 'assistant.delta', { textDelta: 'late' }).ok, false)
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(f.commands.at(-1).requestId, 'request-fixture-0002')
  assert.equal(f.manager.listSendQueue({ deviceId: DEVICE, params: { conversationId: CID } }).items.length, 0)
  await assert.rejects(f.manager.cancel({ deviceId: 'device-other-fixture', requestId: 'cancel-fixture', params: { conversationId: CID } }), { code: 'remote_request_owner_mismatch' })
  await f.manager.cancel({ deviceId: DEVICE, requestId: 'cancel-fixture', params: { conversationId: CID } })
  assert.equal(f.commands.at(-1).targetRequestId, 'request-fixture-0002')
  renderer(f, 'assistant.cancelled', {}, 'request-fixture-0002')
  await send(f.manager, 'request-fixture-0003')
  renderer(f, 'assistant.completed', {}, 'request-fixture-0003')
  f.manager.showOnDesktop({ params: { conversationId: CID } })
  await f.manager.closeAll()
  assert.equal(f.commands.filter((command) => command.type === 'remote.shutdown').length, 0, 'revealed window belongs to Desktop')
  await assert.rejects(send(f.manager, 'request-stopped'), { code: 'remote_gateway_stopped' })

  const delayedIdle = fixture()
  await send(delayedIdle.manager, 'request-idle-active')
  await send(delayedIdle.manager, 'request-idle-queued')
  delayedIdle.items[0].busy = true
  renderer(delayedIdle, 'assistant.completed', {}, 'request-idle-active')
  assert.equal(delayedIdle.manager.listSendQueue({ deviceId: DEVICE, params: { conversationId: CID } }).items.length, 1)
  delayedIdle.items[0].busy = false
  await new Promise(resolve => setTimeout(resolve, 150))
  assert.equal(delayedIdle.commands.at(-1).requestId, 'request-idle-queued')
  renderer(delayedIdle, 'assistant.completed', {}, 'request-idle-queued')


  const releasable = fixture()
  await send(releasable.manager, 'request-release-idle')
  renderer(releasable, 'assistant.completed', {}, 'request-release-idle')
  assert.deepEqual(
    await releasable.manager.release({ deviceId: DEVICE, params: { conversationId: CID } }),
    { ok: true, conversationId: CID, released: false, mobileControlled: true }
  )
  assert.equal(releasable.commands.some((command) => command.type === 'remote.shutdown'), false)
  assert.equal(releasable.items.length, 1, 'navigation must not close a Mobile-controlled hidden writer; explicit handoff owns the transfer')

  const visibleRelease = fixture({ existing: true })
  assert.deepEqual(
    await visibleRelease.manager.release({ deviceId: DEVICE, params: { conversationId: CID } }),
    { ok: true, conversationId: CID, released: false }
  )
  assert.equal(visibleRelease.commands.length, 0, 'a Desktop-visible conversation must never be closed by Mobile release')

  const activeRelease = fixture()
  await send(activeRelease.manager, 'request-release-active')
  const activeResult = await activeRelease.manager.release({ deviceId: DEVICE, params: { conversationId: CID } })
  assert.equal(activeResult.released, false)
  assert.equal(activeResult.busy, true)
  assert.equal(activeRelease.commands.some((command) => command.type === 'remote.shutdown'), false)
  renderer(activeRelease, 'assistant.completed', {}, 'request-release-active')


  const removable = fixture()
  await send(removable.manager, 'request-queue-active')
  await send(removable.manager, 'request-queue-remove')
  assert.equal(removable.manager.removeQueuedSend({ deviceId: DEVICE, params: { conversationId: CID, requestId: 'request-queue-remove' } }).removed, true)
  assert.equal(removable.manager.listSendQueue({ deviceId: DEVICE, params: { conversationId: CID } }).items.length, 0)
  assert.equal(removable.manager.getSession(CID).activeRequestId, 'request-queue-active')
  renderer(removable, 'assistant.completed', {}, 'request-queue-active')


  for (const takeoverReceipt of ['timeout', 'failed']) {
    const rejected = fixture({existing: true, takeoverReceipt})
    await assert.rejects(rejected.manager.takeover({deviceId: DEVICE, params: {conversationId: CID}}), {code: takeoverReceipt === 'timeout' ? 'remote_mobile_takeover_timeout' : 'remote_conversation_save_failed'})
    assert.equal(rejected.manager.openedSessions({deviceId: DEVICE, params: {}}).sessions[0].mobileControlled, false)
    const command = rejected.commands.at(-1)
    assert.equal(renderer(rejected, 'conversation.mobile.control.result', {ok: true}, command.requestId).ok, false, 'late receipt cannot take control')
  }


  const takeoverFixture = fixture({ existing: true })
  // A conversation already open on Desktop is listable immediately, so Mobile
  // can take it over without opening it first.
  const desktopOpenList = takeoverFixture.manager.openedSessions({ deviceId: DEVICE, params: {} })
  assert.equal(desktopOpenList.sessions.length, 1)
  assert.equal(desktopOpenList.sessions[0].mobileControlled, false)
  assert.equal(desktopOpenList.sessions[0].windowId, 'window-existing')

  await assert.rejects(
    takeoverFixture.manager.send({ deviceId: DEVICE, requestId: 'request-visible-without-takeover', params: { conversationId: CID, text: 'must be rejected before takeover' } }),
    { code: 'remote_conversation_takeover_required' }
  )
  assert.equal(
    takeoverFixture.manager.openedSessions({ deviceId: DEVICE, params: {} }).sessions[0].mobileControlled,
    false,
    'a rejected visible-writer write must not grant Mobile control'
  )
  const rejectedBeforeDispatch = takeoverFixture.manager.getRequest({deviceId: DEVICE, params: {requestId: 'request-visible-without-takeover'}})
  assert.equal(rejectedBeforeDispatch.terminal, true, 'pre-dispatch rejection must not remain pending')
  assert.equal(rejectedBeforeDispatch.result.code, 'remote_conversation_takeover_required')
  takeoverFixture.items[0].busy = true
  await assert.rejects(takeoverFixture.manager.takeover({deviceId: DEVICE, params: {conversationId: CID}}), {code: 'remote_conversation_busy'})
  takeoverFixture.items[0].busy = false

  const openedForMobile = await takeoverFixture.manager.openForMobile({ deviceId: DEVICE, params: { conversationId: CID } })
  assert.equal(openedForMobile.mobileControlled, false)
  const takeoverList = takeoverFixture.manager.openedSessions({ deviceId: DEVICE, params: {} })
  assert.equal(takeoverList.sessions[0].mobileControlled, false)
  const taken = await takeoverFixture.manager.takeover({ deviceId: DEVICE, params: { conversationId: CID } })
  assert.equal(taken.mobileControlled, true)
  assert.equal(takeoverFixture.commands.at(-1).type, 'conversation.mobile.takeover')
  const controlledList = takeoverFixture.manager.openedSessions({ deviceId: DEVICE, params: {} })
  assert.equal(controlledList.sessions[0].controlledByThisDevice, true)
  await takeoverFixture.manager.send({ deviceId: DEVICE, requestId: 'request-takeover-write', params: { conversationId: CID, text: 'writer continues' } })
  assert.equal(takeoverFixture.commands.at(-1).type, 'conversation.send')
  renderer(takeoverFixture, 'assistant.completed', {}, 'request-takeover-write')
  const handed = await takeoverFixture.manager.handoff({ deviceId: DEVICE, params: { conversationId: CID } })
  assert.equal(handed.mobileControlled, false)
  assert.equal(takeoverFixture.commands.at(-1).type, 'conversation.mobile.handoff')
  await assert.rejects(takeoverFixture.manager.send({ deviceId: DEVICE, requestId: 'request-after-handoff', params: { conversationId: CID, text: 'must not commandeer desktop' } }), { code: 'remote_conversation_takeover_required' })

  const closable = fixture({ existing: true })
  await closable.manager.takeover({ deviceId: DEVICE, params: { conversationId: CID } })
  await assert.rejects(
    closable.manager.closeConversation({ deviceId: 'device-other-fixture', params: { conversationId: CID } }),
    { code: 'remote_conversation_controlled_by_other_device' },
  )
  const closed = await closable.manager.closeConversation({ deviceId: DEVICE, params: { conversationId: CID } })
  assert.equal(closed.closed, true)
  assert.equal(closable.commands.at(-1).type, 'remote.shutdown')
  assert.equal(closable.commands.at(-1).closeWindow, true)
  assert.equal(closable.items.length, 0)



  // Same conversation can be reacquired after writer shutdown/recreation.
  await closable.manager.takeover({deviceId: DEVICE, params: {conversationId: CID}})
  assert.equal(closable.manager.openedSessions({deviceId: DEVICE, params: {}}).sessions[0].controlledByThisDevice, true)
  await send(closable.manager, 'request-reopened-writer')
  renderer(closable, 'assistant.completed', {}, 'request-reopened-writer')
  await closable.manager.closeConversation({deviceId: DEVICE, params: {conversationId: CID}})


  const hiddenTakeover = fixture()
  await send(hiddenTakeover.manager, 'request-hidden-takeover')
  renderer(hiddenTakeover, 'assistant.completed', {}, 'request-hidden-takeover')
  const hiddenHandoff = await hiddenTakeover.manager.handoff({ deviceId: DEVICE, params: { conversationId: CID } })
  assert.equal(hiddenHandoff.hidden, false)
  assert.equal(hiddenTakeover.commands.at(-1).type, 'conversation.mobile.handoff')
  assert.equal(hiddenTakeover.commands.some((command) => command.type === 'remote.shutdown'), false, 'handoff must reveal the same writer instead of replacing it')


  const hiddenWriterWithObserver = fixture()
  await send(hiddenWriterWithObserver.manager, 'request-hidden-observer')
  renderer(hiddenWriterWithObserver, 'assistant.completed', {}, 'request-hidden-observer')
  const hiddenWriterRef = hiddenWriterWithObserver.items[0].id
  // Desktop history may open a second read-only observer while Mobile's hidden
  // writer remains authoritative. It must never replace that writer on handoff.
  hiddenWriterWithObserver.items.push({
    id: 'window-readonly-observer', type: 'window', conversationId: CID,
    rendererReady: true, leasePending: false, readOnly: true, remoteHidden: false
  })
  assert.deepEqual(
    hiddenWriterWithObserver.manager.observeOnDesktop({ conversationId: CID }),
    { ok: true, reused: true, conversationId: CID, windowId: hiddenWriterRef, mobileControlled: true }
  )
  assert.equal(hiddenWriterWithObserver.opens.length, 1, 'opening Desktop control reuses the hidden writer')
  const observedSession = hiddenWriterWithObserver.manager.openedSessions({ deviceId: DEVICE, params: {} }).sessions[0]
  assert.equal(observedSession.windowId, hiddenWriterRef)
  assert.equal(observedSession.hasDesktopObserver, true)
  const observerHandoff = await hiddenWriterWithObserver.manager.handoff({ deviceId: DEVICE, params: { conversationId: CID } })
  assert.equal(observerHandoff.windowId, hiddenWriterRef)
  assert.equal(hiddenWriterWithObserver.commands.at(-1).windowRef, hiddenWriterRef)
  assert.equal(hiddenWriterWithObserver.items.find((item) => item.id === hiddenWriterRef)?.remoteHidden, false)
  assert.equal(hiddenWriterWithObserver.items.find((item) => item.id === 'window-readonly-observer')?.readOnly, true)
  assert.equal(hiddenWriterWithObserver.manager.getSession(CID)?.windowRef, hiddenWriterRef)
  assert.equal(hiddenWriterWithObserver.manager.getSession(CID)?.mobileControlled, false)



  // Showing the Mobile writer and closing that very window ends its control;
  // no Desktop takeover is needed before a normal close releases the lease.
  const revealedThenClosed = fixture();
  await revealedThenClosed.manager.openForMobile({deviceId: DEVICE, params: {conversationId: CID}});
  const sameWriter = revealedThenClosed.items[0].id;
  const shown = revealedThenClosed.manager.observeOnDesktop({conversationId: CID});
  assert.equal(shown.windowId, sameWriter);
  assert.equal(revealedThenClosed.items[0].remoteHidden, false);
  assert.equal(revealedThenClosed.manager.controlledSessions().sessions.length, 1);
  revealedThenClosed.items.splice(0);
  revealedThenClosed.manager.handleWindowClosed(sameWriter);
  assert.equal(revealedThenClosed.manager.controlledSessions().sessions.length, 0);
  assert.equal(revealedThenClosed.manager.openedSessions({deviceId: DEVICE}).sessions.length, 0);
  assert.equal(revealedThenClosed.commands.some(item => item.type === 'conversation.desktop.takeover'), false);


  const localControl = fixture();
  await send(localControl.manager, 'request-local-active');
  await send(localControl.manager, 'request-local-queued');
  const controlled = localControl.manager.controlledSessions({deviceId: DEVICE});
  assert.equal(controlled.sessions.length, 1);
  assert.equal(controlled.sessions[0].deviceId, DEVICE);
  assert.equal(localControl.manager.controlledSessions({deviceId: 'device-other-fixture'}).sessions.length, 0);
  await assert.rejects(localControl.manager.takeoverOnDesktop({conversationId: CID}), {code: 'remote_takeover_confirmation_required'});
  const taking = localControl.manager.takeoverOnDesktop({conversationId: CID, confirmed: true});
  await new Promise(resolve => setImmediate(resolve));
  const transfer = localControl.commands.at(-1);
  assert.equal(transfer.type, 'conversation.desktop.takeover');
  assert.equal(localControl.manager.getRequest({deviceId: DEVICE, params: {requestId: 'request-local-queued'}}).event, 'assistant.cancelled');
  assert.equal(localControl.manager.handleRendererEvent({windowRef: 'spoof-window', payload: {event: 'conversation.desktop.control.result', requestId: transfer.requestId, conversationId: CID, payload: {ok: true}}}).ok, false);
  renderer(localControl, 'assistant.cancelled', {}, 'request-local-active');
  renderer(localControl, 'conversation.desktop.control.result', {ok: true}, transfer.requestId);
  await taking;
  assert.equal(localControl.opens.length, 1);
  assert.equal(localControl.manager.controlledSessions().sessions.length, 0);
  assert.equal(localControl.manager.openedSessions({deviceId: DEVICE}).sessions[0].controlledByThisDevice, false);
  await assert.rejects(send(localControl.manager, 'request-after-local-takeover'), {code: 'remote_conversation_takeover_required'});

  const failedControl = fixture();
  await failedControl.manager.openForMobile({deviceId: DEVICE, params: {conversationId: CID}});
  const failedTaking = failedControl.manager.takeoverOnDesktop({conversationId: CID, confirmed: true});
  await new Promise(resolve => setImmediate(resolve));
  renderer(failedControl, 'conversation.desktop.control.result', {ok: false}, failedControl.commands.at(-1).requestId);
  await assert.rejects(failedTaking, {code: 'remote_desktop_takeover_failed'});
  assert.equal(failedControl.manager.controlledSessions().sessions.length, 1);


  const mutations = fixture({ existing: true })

  await mutations.manager.takeover({ deviceId: DEVICE, params: { conversationId: CID } })
  const edited = await mutations.manager.editMessage({ deviceId: DEVICE, requestId: 'request-edit-fixture', params: {
    conversationId: CID, uiMessageId: 'ui-message-fixture-0001', content: 'Edited text'
  } })
  assert.equal(edited.operation, 'conversation.message.edit')
  assert.equal(mutations.commands.at(-1).content, 'Edited text')
  mutations.manager.handleRendererEvent({ windowRef: 'window-existing', payload: {
    conversationId: CID, requestId: 'request-edit-fixture', event: 'conversation.operation.completed',
    payload: { operation: 'conversation.message.edit', uiMessageId: 'ui-message-fixture-0001', revision: 8 }
  } })
  assert.equal(mutations.manager.getRequest({ deviceId: DEVICE, params: { requestId: 'request-edit-fixture' } }).terminal, true)
  assert.equal((await mutations.manager.editMessage({ deviceId: DEVICE, requestId: 'request-edit-fixture', params: {
    conversationId: CID, uiMessageId: 'ui-message-fixture-0001', content: 'Edited text'
  } })).duplicate, true)
  await assert.rejects(mutations.manager.editMessage({ deviceId: DEVICE, requestId: 'request-edit-fixture', params: {
    conversationId: CID, uiMessageId: 'ui-message-fixture-0001', content: 'Conflict'
  } }), { code: 'remote_request_id_conflict' })
  await mutations.manager.deleteMessage({ deviceId: DEVICE, requestId: 'request-delete-fixture', params: {
    conversationId: CID, uiMessageId: 'ui-message-fixture-0002'
  } })
  assert.equal(mutations.commands.at(-1).type, 'conversation.message.delete')
  mutations.manager.handleRendererEvent({ windowRef: 'window-existing', payload: {
    conversationId: CID, requestId: 'request-delete-fixture', event: 'conversation.operation.completed', payload: { revision: 9 }
  } })
  await mutations.manager.reaskMessage({ deviceId: DEVICE, requestId: 'request-reask-fixture', params: {
    conversationId: CID, uiMessageId: 'ui-message-fixture-0003'
  } })
  assert.equal(mutations.commands.at(-1).type, 'conversation.message.reask')
  await assert.rejects(mutations.manager.deleteMessage({ deviceId: DEVICE, requestId: 'request-index-forbidden', params: {
    conversationId: CID, uiMessageId: 'ui-message-fixture-0003', index: 2
  } }), { code: 'remote_parameter_unknown' })
  mutations.manager.handleRendererEvent({ windowRef: 'window-existing', payload: {
    conversationId: CID, requestId: 'request-reask-fixture', event: 'assistant.failed', payload: { code: 'remote_test_failure' }
  } })


  // User sequence: send -> edit -> reask -> rename -> multi-tool turns -> handoff -> reopen.
  const lifecycle = fixture()
  await send(lifecycle.manager, 'request-lifecycle-first')
  renderer(lifecycle, 'assistant.completed', {revision: 1}, 'request-lifecycle-first')
  await lifecycle.manager.editMessage({deviceId: DEVICE, requestId: 'request-lifecycle-edit', params: {conversationId: CID, uiMessageId: 'ui-lifecycle-user', content: 'corrected prose'}})
  renderer(lifecycle, 'conversation.operation.completed', {revision: 2}, 'request-lifecycle-edit')
  await lifecycle.manager.reaskMessage({deviceId: DEVICE, requestId: 'request-lifecycle-reask', params: {conversationId: CID, uiMessageId: 'ui-lifecycle-last'}})
  renderer(lifecycle, 'assistant.completed', {revision: 3}, 'request-lifecycle-reask')
  await lifecycle.manager.renameConversation({deviceId: DEVICE, requestId: 'request-lifecycle-rename', params: {conversationId: CID, title: 'Renamed synthetic conversation'}})
  renderer(lifecycle, 'conversation.operation.completed', {revision: 4}, 'request-lifecycle-rename')
  for (let index = 0; index < 3; index++) {
    const requestId = `request-lifecycle-tools-${index}`
    await send(lifecycle.manager, requestId)
    renderer(lifecycle, 'assistant.started', {}, requestId)
    for (let segment = 0; segment < 3; segment++) renderer(lifecycle, 'assistant.delta', {segmentId: `segment-${segment}`, toolCalls: [{id: `tool-${segment}`, name: 'read_file', status: 'finished'}]}, requestId)
    await assert.rejects(lifecycle.manager.takeover({deviceId: DEVICE, params: {conversationId: CID}}), {code: 'remote_conversation_busy'})
    renderer(lifecycle, 'assistant.completed', {revision: 5 + index}, requestId)
    assert.equal(lifecycle.manager.listSendQueue({deviceId: DEVICE, params: {conversationId: CID}}).activeRequestId, '')
  }
  await lifecycle.manager.handoff({deviceId: DEVICE, params: {conversationId: CID}})
  await lifecycle.manager.takeover({deviceId: DEVICE, params: {conversationId: CID}})
  await lifecycle.manager.closeConversation({deviceId: DEVICE, params: {conversationId: CID}})
  await lifecycle.manager.takeover({deviceId: DEVICE, params: {conversationId: CID}})
  assert.equal(lifecycle.manager.openedSessions({deviceId: DEVICE}).sessions[0].controlledByThisDevice, true)
  await lifecycle.manager.closeConversation({deviceId: DEVICE, params: {conversationId: CID}})


  const metadata = fixture({ existing: true })

  await metadata.manager.takeover({ deviceId: DEVICE, params: { conversationId: CID } })
  await assert.rejects(metadata.manager.renameConversation({
    deviceId: DEVICE, requestId: 'request-rename-empty', params: { conversationId: CID, title: '   ' }
  }), { code: 'remote_conversation_title_invalid' })
  await assert.rejects(metadata.manager.deleteConversation({
    deviceId: DEVICE, requestId: 'request-delete-unconfirmed', params: { conversationId: CID, confirmed: false }
  }), { code: 'remote_confirmation_required' })
  const renamed = await metadata.manager.renameConversation({
    deviceId: DEVICE, requestId: 'request-rename-conversation', params: { conversationId: CID, title: 'Renamed remotely' }
  })
  assert.equal(renamed.operation, 'conversation.rename')
  assert.equal(metadata.commands.at(-1).title, 'Renamed remotely')
  metadata.manager.handleRendererEvent({ windowRef: 'window-existing', payload: {
    conversationId: CID, requestId: 'request-rename-conversation', event: 'conversation.operation.completed',
    payload: { operation: 'conversation.rename', title: 'Renamed remotely', revision: 13, dbFile: 'MUST_NOT_LEAK' }
  } })
  const renameState = metadata.manager.getRequest({ deviceId: DEVICE, params: { requestId: 'request-rename-conversation' } })
  assert.equal(renameState.result.title, 'Renamed remotely')
  assert.equal(renameState.result.revision, 13)
  assert.equal(JSON.stringify(renameState).includes('MUST_NOT_LEAK'), false)
  assert.equal((await metadata.manager.renameConversation({
    deviceId: DEVICE, requestId: 'request-rename-conversation', params: { conversationId: CID, title: 'Renamed remotely' }
  })).duplicate, true)
  await assert.rejects(metadata.manager.renameConversation({
    deviceId: DEVICE, requestId: 'request-rename-conversation', params: { conversationId: CID, title: 'Conflict' }
  }), { code: 'remote_request_id_conflict' })

  await metadata.manager.deleteConversation({
    deviceId: DEVICE, requestId: 'request-delete-conversation', params: { conversationId: CID, confirmed: true }
  })
  assert.equal(metadata.commands.at(-1).type, 'conversation.delete')
  assert.equal(metadata.commands.at(-1).confirmed, true)
  metadata.manager.handleRendererEvent({ windowRef: 'window-existing', payload: {
    conversationId: CID, requestId: 'request-delete-conversation', event: 'conversation.operation.completed',
    payload: { operation: 'conversation.delete', deleted: true, revision: 13 }
  } })
  const deleteState = metadata.manager.getRequest({ deviceId: DEVICE, params: { requestId: 'request-delete-conversation' } })
  assert.equal(deleteState.result.deleted, true)
  await assert.rejects(send(metadata.manager, 'request-after-delete'), { code: 'remote_conversation_not_found' })
  assert.throws(() => metadata.manager.showOnDesktop({ params: { conversationId: CID } }), { code: 'remote_conversation_not_found' })


  const configFixture = fixture({ existing: true })

  await configFixture.manager.takeover({ deviceId: DEVICE, params: { conversationId: CID } })
  await assert.rejects(configFixture.manager.patchConfig({ deviceId: DEVICE, requestId: 'request-config-bad-1', params: {
    conversationId: CID, patch: { compact: { unknown: true } }
  } }), { code: 'remote_parameter_unknown' })
  await assert.rejects(configFixture.manager.patchConfig({ deviceId: DEVICE, requestId: 'request-config-bad-2', params: {
    conversationId: CID, patch: { compact: { triggerRatio: 2 } }
  } }), { code: 'remote_session_config_invalid' })
  const configAccepted = await configFixture.manager.patchConfig({ deviceId: DEVICE, requestId: 'request-config-patch', params: {
    conversationId: CID,
    patch: { model: 'provider|model', reasoningEffort: 'high', voice: '', mcpServerIds: ['mcp-1'], skillIds: ['Skill One'], systemPrompt: 'Session only', compact: { triggerRatio: 0.8, keepRecentRounds: 4 } }
  } })
  assert.equal(configAccepted.operation, 'conversation.config.patch')
  assert.equal(configFixture.commands.at(-1).patch.systemPrompt, 'Session only')
  configFixture.manager.handleRendererEvent({ windowRef: 'window-existing', payload: {
    conversationId: CID, requestId: 'request-config-patch', event: 'conversation.config.result', payload: {
      revision: 10, patched: ['model', 'systemPrompt'],
      config: { model: 'provider|model', reasoningEffort: 'high', voice: '', mcpServerIds: ['mcp-1'], skillIds: ['Skill One'], systemPrompt: 'Session only', compact: { triggerRatio: 0.8, keepRecentRounds: 4, secret: 'NO' } },
      options: {
        models: [{ value: 'provider|model', label: 'Model', api_key: 'NO' }],
        reasoningEfforts: ['default', 'high'],
        voices: [],
        mcpServers: [{ id: 'mcp-1', name: 'MCP', tags: ['Research', '文件'], preset: true, env: { SECRET: 'NO' }, cwd: 'NO' }],
        skills: [{ id: 'skill-1', name: 'Skill One', path: 'NO' }]
      }
    }
  } })
  const configState = configFixture.manager.getRequest({ deviceId: DEVICE, params: { requestId: 'request-config-patch' } })
  assert.equal(configState.result.config.systemPrompt, 'Session only')
  assert.deepEqual(configState.result.options.mcpServers, [{ id: 'mcp-1', name: 'MCP', tags: ['Research', '文件'], preset: true }])
  assert.equal(JSON.stringify(configState).includes('NO'), false)
  await configFixture.manager.getConfig({ deviceId: DEVICE, requestId: 'request-config-get', params: { conversationId: CID } })
  assert.equal(configFixture.commands.at(-1).type, 'conversation.config.get')
  configFixture.manager.handleRendererEvent({ windowRef: 'window-existing', payload: {
    conversationId: CID, requestId: 'request-config-get', event: 'conversation.config.result',
    payload: { revision: 10, config: {}, options: {} }
  } })


  const parallelRead = fixture({ existing: true })
  await parallelRead.manager.takeover({ deviceId: DEVICE, params: { conversationId: CID } })
  await send(parallelRead.manager, 'request-busy-generation')
  await parallelRead.manager.getConfig({ deviceId: DEVICE, requestId: 'request-busy-read', params: { conversationId: CID } })
  assert.equal(parallelRead.manager.getSession(CID).activeRequestId, 'request-busy-generation')
  renderer(parallelRead, 'conversation.config.result', { busy: true, config: {}, options: {} }, 'request-busy-read')
  assert.equal(parallelRead.manager.getRequest({ deviceId: DEVICE, params: { requestId: 'request-busy-read' } }).result.busy, true)
  assert.equal(parallelRead.manager.getSession(CID).activeRequestId, 'request-busy-generation')
  await parallelRead.manager.patchConfig({ deviceId: DEVICE, requestId: 'request-busy-patch', params: { conversationId: CID, patch: { model: 'p|new' } } })
  assert.equal(parallelRead.manager.getSession(CID).activeRequestId, 'request-busy-generation')
  renderer(parallelRead, 'conversation.config.result', {busy: true, deferred: true, config: {model: 'p|new'}}, 'request-busy-patch')
  assert.equal(parallelRead.manager.getRequest({deviceId: DEVICE, params: {requestId: 'request-busy-patch'}}).result.deferred, true)
  assert.equal(parallelRead.manager.getSession(CID).activeRequestId, 'request-busy-generation')
  assert.equal(parallelRead.manager.getRequest({deviceId: DEVICE, params: {requestId: 'request-busy-generation'}}).terminal, false)
  renderer(parallelRead, 'assistant.completed', {}, 'request-busy-generation')
  await parallelRead.manager.refreshContext({ deviceId: DEVICE, requestId: 'request-context-refresh', params: { conversationId: CID } })
  renderer(parallelRead, 'conversation.config.result', { config: { compact: { contextLength: 131072, contextLengthSource: 'api' } }, options: {} }, 'request-context-refresh')
  assert.equal(parallelRead.manager.getRequest({ deviceId: DEVICE, params: { requestId: 'request-context-refresh' } }).result.config.compact.contextLengthSource, 'api')


  const compactFixture = fixture({ existing: true })

  await compactFixture.manager.takeover({ deviceId: DEVICE, params: { conversationId: CID } })
  await compactFixture.manager.compact({ deviceId: DEVICE, requestId: 'request-compact-fixture', params: { conversationId: CID } })
  assert.equal(compactFixture.commands.at(-1).type, 'conversation.compact')
  compactFixture.manager.handleRendererEvent({ windowRef: 'window-existing', payload: {
    conversationId: CID, requestId: 'request-compact-fixture', event: 'conversation.compact.progress',
    payload: { percent: 44, stage: 'cascade', message: 'fixture', secret: 'NO' }
  } })
  const compactState = compactFixture.manager.getRequest({ deviceId: DEVICE, params: { requestId: 'request-compact-fixture' } })
  assert.equal(compactState.event, 'conversation.compact.progress')
  assert.equal(compactFixture.events.at(-1).payload.percent, 44)
  assert.equal(JSON.stringify(compactFixture.events.at(-1)).includes('NO'), false)
  await assert.rejects(compactFixture.manager.cancelCompact({ deviceId: 'device-other-fixture', requestId: 'cancel-compact-other', params: { conversationId: CID } }), { code: 'remote_request_owner_mismatch' })
  await compactFixture.manager.cancelCompact({ deviceId: DEVICE, requestId: 'cancel-compact-fixture', params: { conversationId: CID } })
  assert.equal(compactFixture.commands.at(-1).type, 'conversation.compact.cancel')
  compactFixture.manager.handleRendererEvent({ windowRef: 'window-existing', payload: {
    conversationId: CID, requestId: 'request-compact-fixture', event: 'conversation.compact.cancelled', payload: { revision: 11 }
  } })
  assert.equal(compactFixture.manager.getRequest({ deviceId: DEVICE, params: { requestId: 'request-compact-fixture' } }).terminal, true)


  const compactRevoked = fixture({ existing: true })
  await compactRevoked.manager.takeover({ deviceId: DEVICE, params: { conversationId: CID } })
  await compactRevoked.manager.compact({ deviceId: DEVICE, requestId: 'request-compact-revoke', params: { conversationId: CID } })
  await compactRevoked.manager.revokeDevice(DEVICE)
  assert.equal(compactRevoked.commands.at(-1).type, 'conversation.compact.cancel')

  const compactShutdown = fixture({ existing: true })
  await compactShutdown.manager.takeover({ deviceId: DEVICE, params: { conversationId: CID } })
  await compactShutdown.manager.compact({ deviceId: DEVICE, requestId: 'request-compact-shutdown', params: { conversationId: CID } })
  const compactClosing = compactShutdown.manager.closeAll()
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(compactShutdown.commands.at(-1).type, 'conversation.compact.cancel')
  compactShutdown.manager.handleRendererEvent({ windowRef: 'window-existing', payload: {
    conversationId: CID, requestId: 'request-compact-shutdown', event: 'conversation.compact.cancelled', payload: { revision: 12 }
  } })
  await compactClosing


  const reused = fixture({ existing: true })
  await reused.manager.takeover({ deviceId: DEVICE, params: { conversationId: CID } })
  await send(reused.manager)
  assert.equal(reused.opens.length, 0)
  await reused.manager.revokeDevice(DEVICE)
  assert.equal(reused.commands.at(-1).type, 'conversation.cancel')
  await assert.rejects(send(reused.manager, 'request-revoked'), { code: 'remote_device_revoked' })
  reused.manager.authorizeDevice(DEVICE)
  reused.manager.handleWindowClosed('window-existing')
  assert.equal(reused.events.at(-1).payload.code, 'remote_renderer_closed')

  const hidden = fixture()
  await send(hidden.manager)
  await hidden.manager.closeAll()
  assert.equal(hidden.commands.at(-1).type, 'remote.shutdown')
  assert.equal(hidden.items.length, 0)

  const racing = fixture({ stalled: true })
  const pending = send(racing.manager)
  await new Promise((resolve) => setTimeout(resolve, 5))
  const closing = racing.manager.closeAll()
  racing.unblock()
  await assert.rejects(pending, { code: 'remote_gateway_stopped' })
  await closing
  assert.equal(racing.commands.length, 0, 'stop invalidates a command waiting for repository')


  const uploadCalls = []
  const uploadManager = {
    async authorizeForRequest(input) { uploadCalls.push({ method: 'authorize', ...structuredClone(input) }); return [] },
    async releaseRequest(input) { uploadCalls.push({ method: 'release', ...structuredClone(input) }); return { ok: true } },
    async cleanupRequest(input) { uploadCalls.push({ method: 'cleanupRequest', ...structuredClone(input) }); return { ok: true } },
    async cleanupDevice(deviceId) { uploadCalls.push({ method: 'cleanupDevice', deviceId }); return { ok: true } },
    async cleanupWindow(windowRef) { uploadCalls.push({ method: 'cleanupWindow', windowRef }); return { ok: true } }
  }
  const withUploads = fixture({ existing: true, uploadManager })
  await withUploads.manager.takeover({ deviceId: DEVICE, params: { conversationId: CID } })
  const uploadIds = ['upload-session-fixture-0001', 'upload-session-fixture-0002']
  await withUploads.manager.send({
    deviceId: DEVICE, requestId: 'request-upload-session-1',
    params: { conversationId: CID, text: '', uploadIds }
  })
  assert.deepEqual(uploadCalls[0], {
    method: 'authorize', deviceId: DEVICE, requestId: 'request-upload-session-1',
    windowRef: 'window-existing', uploadIds
  })
  assert.deepEqual(withUploads.commands.at(-1).uploadIds, uploadIds)
  assert.equal(withUploads.commands.at(-1).text, '')
  assert.equal((await withUploads.manager.send({
    deviceId: DEVICE, requestId: 'request-upload-session-1', params: { conversationId: CID, text: '', uploadIds }
  })).duplicate, true)
  await assert.rejects(withUploads.manager.send({
    deviceId: DEVICE, requestId: 'request-upload-session-1', params: { conversationId: CID, text: '', uploadIds: [uploadIds[0]] }
  }), { code: 'remote_request_id_conflict' })
  withUploads.manager.handleRendererEvent({ windowRef: 'window-existing', payload: {
    conversationId: CID, requestId: 'request-upload-session-1', event: 'assistant.completed', payload: { revision: 12 }
  } })
  await new Promise((resolve) => setImmediate(resolve))
  assert.ok(uploadCalls.some((item) => item.method === 'cleanupRequest' && item.requestId === 'request-upload-session-1'))
  await assert.rejects(withUploads.manager.send({
    deviceId: DEVICE, requestId: 'request-upload-duplicate',
    params: { conversationId: CID, text: 'duplicate', uploadIds: [uploadIds[0], uploadIds[0]] }
  }), { code: 'remote_upload_ids_invalid' })

  const uploadFailureCalls = []
  const uploadFailureManager = {
    ...uploadManager,
    async authorizeForRequest(input) { uploadFailureCalls.push({ method: 'authorize', ...structuredClone(input) }); return [] },
    async releaseRequest(input) { uploadFailureCalls.push({ method: 'release', ...structuredClone(input) }); return { ok: true } }
  }
  const uploadDispatchFailed = fixture({ existing: true, dispatchFailure: true, allowControlCommands: true, uploadManager: uploadFailureManager })
  await uploadDispatchFailed.manager.takeover({ deviceId: DEVICE, params: { conversationId: CID } })
  await assert.rejects(uploadDispatchFailed.manager.send({
    deviceId: DEVICE, requestId: 'request-upload-dispatch-fail',
    params: { conversationId: CID, text: 'retryable', uploadIds: [uploadIds[0]] }
  }), { code: 'remote_renderer_dispatch_failed' })
  assert.equal(uploadFailureCalls[0].method, 'authorize')
  assert.equal(uploadFailureCalls[1].method, 'release')

  const failed = fixture({ dispatchFailure: true })
  await assert.rejects(send(failed.manager), { code: 'remote_renderer_dispatch_failed' })
  assert.equal(failed.manager.getSession(CID).activeRequestId, '')
  const readonly = fixture({ existing: true })
  readonly.items[0].readOnly = true
  await assert.rejects(send(readonly.manager), { code: 'remote_conversation_read_only' })
  console.log(JSON.stringify({ ok: true, suite: 'remote-session-manager' }))
}
await run()
