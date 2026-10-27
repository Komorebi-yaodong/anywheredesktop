import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import vm from 'node:vm'
import {createConversationMetadataRouter} from '../main/core/conversationMetadataRouter.js'
import {createConversationWriteQueue} from '../render/window/utils/conversationWriteQueue.js'
import {executeConversationMetadataCommand} from '../render/window/utils/conversationMetadataCommand.js'
import {createConversationMutationQueue, createConversationPersistenceTracker, mergeConversationMutationRequests} from '../render/window/utils/conversationMutationQueue.js'
import {serializeError, serializeIpcPayload} from '../main/dataConverter.js'
import * as store from '../main/core/conversationStore.js'
import {readLocalProjects, writeLocalProjects} from '../main/core/projects.js'

const read = async name => (await fs.readFile(new URL('../' + name, import.meta.url), 'utf8')).replace(/\r\n/g, '\n')
const [app, chats, ipc, preload, zhText] = await Promise.all(['render/window/App.vue', 'render/main/components/Chats.vue', 'main/ipcHandler.js', 'preload/main_preload.js', 'render/main/locales/zh.json'].map(read))
const zh = JSON.parse(zhText)
const ref = value => ({value})
const tick = () => new Promise(resolve => setImmediate(resolve))
const receiptAttempts = []
await executeConversationMetadataCommand({requestId: 'synthetic-lost-ack', conversationId: 'synthetic', dirPath: 'synthetic-dir', expiresAt: Date.now() + 10000}, {
  getStorage: () => ({conversationId: 'synthetic', dirPath: 'synthetic-dir'}), canWrite: () => true, isClosing: () => false,
  checkRequest: async () => ({ok: true}), rename: async () => ({conversationId: 'synthetic', revision: 1, title: 'committed'}),
  publish: async () => {throw new Error('observer unavailable')},
  complete: async result => {receiptAttempts.push(result.ok); throw new Error('lost IPC acknowledgement')}
})
assert.deepEqual(receiptAttempts, [true], 'lost receipt after commit cannot emit a false failed mutation')


const root = await fs.mkdtemp(path.join(os.tmpdir(), 'anywhere-metadata-rename-'))
const routes = new Map(), windows = [{id: 'main', type: 'main'}], contexts = new Map(), updates = []
let beforeDispatch = null
const handlerContext = {
  ipcMain: {handle: (name, callback) => routes.set(name, callback)}, BrowserWindow: {fromWebContents: () => null},
  serializeError, serializeIpcPayload, createConversationMetadataRouter,
  listWindows: () => windows, getWindowRefByWebContentsId: id => id,
  getWindowByRef: id => contexts.has(id) ? {} : null,
  getConversationWindowDirectory: id => contexts.get(id)?.currentConversationStorage.value?.dirPath || '',
  conversationApi: store, notifyConversationMetadataChanged: result => updates.push(result),
  dispatchWindowEvent: async envelope => {
    const c = contexts.get(envelope.target)
    if (!c) return {ok: false}
    if (beforeDispatch) await beforeDispatch(envelope)
    void c.runLocal(envelope.payload)
    return {ok: true, delivered: 1}
  }
}
const wrap = ipc.slice(ipc.indexOf('function handleInvoke('), ipc.indexOf('export function registerIpcHandlers('))
const start = ipc.indexOf('  const conversationMetadataRouter =')
const end = ipc.indexOf("  handleInvoke('conversation:delete'", start)
vm.runInNewContext(wrap + ipc.slice(start, end), handlerContext)
const invokeFor = sender => vm.runInNewContext(preload.slice(preload.indexOf('function invokeOrThrow('), preload.indexOf("electronAPI.ipcRenderer.on('window:init'")) + '\ninvokeOrThrow', {
  electronAPI: {ipcRenderer: {invoke: (channel, input) => routes.get(channel)({sender: {id: sender}}, input)}}
})
const mainInvoke = invokeFor('main')
async function createWriter({hidden = false, generating = false} = {}) {
  const created = await store.createConversation({dirPath: root, title: 'Original', sessionData: {
    fullHistory: [{role: 'user', content: 'synthetic body'}], chat_show: [{id: 1, role: 'user', content: [{type: 'text', text: 'synthetic body'}]}]
  }})
  const conversationId = created.descriptor.conversationId
  const id = `synthetic-writer-${windows.length}`
  const lease = await store.acquireWriteLease({dirPath: root, conversationId, holderInstanceId: id, holderApp: 'desktop'})
  const opened = await store.openConversation({dirPath: root, reference: conversationId, pageSize: 0})
  const projects = await readLocalProjects(root)
  if (!projects.projects.some(project => project.id === 'test-project')) await writeLocalProjects(root, {...projects, projects: [...projects.projects, {id: 'test-project', name: 'Test Project', files: [], conversationIds: []}]})
  const item = {id, type: 'window', conversationId, remoteHidden: hidden, mobileControlled: hidden, rendererReady: true, leasePending: false, readOnly: false}
  windows.push(item)
  const invoke = invokeFor(id)
  const c = {
    console, Date, Object, Error, Promise, setTimeout, clearTimeout, createConversationWriteQueue, createConversationMutationQueue,
    executeConversationMetadataCommand, mergeAutoSaveRequests: mergeConversationMutationRequests,
    localMetadataExecutions: new Set(), conversationWriteQueue: createConversationWriteQueue(), currentConversationStorage: ref({...opened.descriptor, dirPath: root}),
    defaultConversationName: ref(opened.descriptor.title), currentConfig: ref({webdav: {localChatPath: root}}),
    conversationLease: ref(lease), conversationInstanceId: id, isClosingWindow: ref(false),
    mobileControlActive: ref(hidden), compacting: ref(false), loading: ref(generating), activeRemoteCommand: ref(generating ? {requestId: 'parent-turn'} : null),
    remoteConversationDeleted: ref(false), sessionMutationVersion: 0, scheduledAutoSaveRequest: null, autoSaveTimer: null, autoSaveExecutionPromise: null,
    conversationPersistenceTracker: createConversationPersistenceTracker(), shouldPersistCurrentSessionAutomatically: () => true,
    ensureConversationWriteAccess: () => !item.readOnly && !item.leasePending,
    scheduleConversationWindowStatusSync() {},
    buildConversationWindowStatus: () => ({conversationId, title: c.defaultConversationName.value, revision: c.currentConversationStorage.value.revision, mobileControlled: c.mobileControlActive.value}),
    window: {api: {
      renameConversation: input => invoke('conversation:rename', input),
      checkConversationMetadataRequest: input => invoke('conversation:metadataCheck', input),
      completeConversationMetadataRequest: input => invoke('conversation:metadataResult', input),
      updateConversationWindowStatus: async status => {item.conversationTitle = status.title; item.conversationRevision = status.revision; return {ok: true}}
    }}
  }
  c.autoSaveSession = async () => {
    const storage = c.currentConversationStorage.value
    const saved = await store.saveConversationSnapshot({dirPath: root, conversationId, expectedRevision: storage.revision, holderInstanceId: id, leaseEpoch: lease.leaseEpoch,
      title: c.defaultConversationName.value, sessionData: {...opened.sessionData, sessionMetadata: {title: c.defaultConversationName.value}}})
    c.currentConversationStorage.value = {...storage, revision: saved.revision, title: saved.title}
    return true
  }
  c.autoSaveSessionRequestConfig = c.autoSaveSession
  const blockStart = app.indexOf('const autoSaveMutationQueue =')
  const blockEnd = app.indexOf('watch([model, selectedVoice', blockStart)
  vm.runInNewContext(app.slice(blockStart, blockEnd) + '\nglobalThis.runLocal = runLocalConversationMetadataCommand; globalThis.renameOwned = renameOwnedConversation; globalThis.save = executeAutoSaveRequest;', c)
  contexts.set(id, c)
  return {created, conversationId, id, c, item, lease, opened}
}
async function fromList(f, title, projectId = '') {
  const state = await store.openConversation({dirPath: root, reference: f.conversationId, pageSize: 0})
  const notices = []
  const context = {
    renameDialog: ref({file: {...state.descriptor, format: 'sqlite'}, title, projectId, originalProjectId: '', visible: true, busy: false}),
    activeView: ref('local'), localChatPath: ref(root), resolveFileBasename: file => file?.dbFile, normalizeTitleValue: file => file?.title,
    window: {api: {renameConversation: input => mainInvoke('conversation:rename', input)}}, fetchLocalProjects: async () => {}, refreshData: async () => {},
    t: key => key.split('.').reduce((value, part) => value?.[part], zh) || key,
    ElMessage: {success: message => notices.push(['success', message]), error: message => notices.push(['error', message])}
  }
  const begin = chats.indexOf('async function confirmRenameFile()')
  await vm.runInNewContext(chats.slice(begin, chats.indexOf('async function deleteFiles(', begin)) + '\nconfirmRenameFile', context)()
  return notices
}
try {
  for (const hidden of [false, true]) {
    const f = await createWriter({hidden, generating: hidden})
    const parent = f.c.activeRemoteCommand.value
    assert.equal((await fromList(f, `Renamed-${hidden}`, 'test-project'))[0][0], 'success')
    assert.equal(f.c.defaultConversationName.value, `Renamed-${hidden}`)
    assert.equal(f.item.conversationTitle, `Renamed-${hidden}`)
    assert.equal(f.c.loading.value, hidden)
    assert.equal(f.c.activeRemoteCommand.value, parent)
    assert.equal(f.c.mobileControlActive.value, hidden)
    await f.c.save({force: true, version: 1})
    const reopened = await store.openConversation({dirPath: root, reference: f.conversationId, pageSize: 0})
    assert.equal(reopened.descriptor.title, `Renamed-${hidden}`, 'later autosave cannot restore old title')
    assert.equal(reopened.descriptor.revision, f.c.currentConversationStorage.value.revision)
    assert.equal(reopened.sessionData.fullHistory[0].content, 'synthetic body')
    assert.equal((await readLocalProjects(root)).projects.find(p => p.id === 'test-project').conversationIds.includes(f.conversationId), true)
    assert.equal((await store.loadRemoteConversationPage({dirPath: root, conversationId: f.conversationId})).conversation.title, `Renamed-${hidden}`)
  }
  const f = await createWriter({hidden: true, generating: true})
  let release
  const blocker = f.c.conversationWriteQueue.run(() => new Promise(resolve => {release = resolve}))
  await tick()
  const first = fromList(f, 'First')
  const second = fromList(f, 'Second')
  const save = f.c.save({force: true, version: 2})
  await tick(); release(true); await blocker
  assert.equal((await first)[0][0], 'success')
  assert.equal((await second)[0][0], 'success')
  await save
  assert.equal(f.c.defaultConversationName.value, 'Second')

  await f.c.renameOwned({dirPath: root, conversationId: f.conversationId, projectId: 'test-project'})
  assert.equal(f.c.defaultConversationName.value, 'Second', 'a queued project-only change cannot restore an old title')

  const queuedClose = await createWriter({hidden: true})
  let releaseBlocked, entered
  const enteredPromise = new Promise(resolve => {entered = resolve})
  const closeBlock = queuedClose.c.conversationWriteQueue.run(() => new Promise(resolve => {releaseBlocked = resolve}))
  await tick()
  beforeDispatch = async () => {entered()}
  const closePending = fromList(queuedClose, 'Must not change after queue')
  await enteredPromise
  await tick()
  queuedClose.c.isClosingWindow.value = true
  releaseBlocked(true)
  await closeBlock
  assert.equal((await closePending)[0][0], 'error', 'closing while queued cancels before database mutation')
  assert.equal((await store.openConversation({dirPath: root, reference: queuedClose.conversationId})).descriptor.title, 'Original')
  beforeDispatch = null


  const closing = await createWriter({hidden: true})
  beforeDispatch = async () => {closing.c.isClosingWindow.value = true}
  assert.equal((await fromList(closing, 'Must not change'))[0][0], 'error')
  assert.equal((await store.openConversation({dirPath: root, reference: closing.conversationId})).descriptor.title, 'Original')
  beforeDispatch = null
  const lost = await createWriter({hidden: true})
  beforeDispatch = async () => {lost.item.readOnly = true}
  const notice = await fromList(lost, 'Must not change')
  assert.equal(notice[0][0], 'error')
  assert.match(notice[0][1], /conversation_write_lease_lost/)
  beforeDispatch = null
  const busy = await createWriter({hidden: true})
  busy.c.compacting.value = true
  assert.match((await fromList(busy, 'Must wait for compaction'))[0][1], /conversation_busy/)
  assert.equal(busy.c.defaultConversationName.value, 'Original')
  busy.c.compacting.value = false


  assert.match(ipc, /input\?\.event === 'conversation:metadata-command'/, 'generic event bus cannot spoof a metadata command')
  assert.match(app, /envelope\.sourceId !== 'conversation-metadata-router'/)
  assert.ok(updates.length >= 4, 'completed local mutations publish catalog invalidation')
  console.log(JSON.stringify({ok: true, suite: 'conversation-metadata-rename', actualHistoryPreloadIpcRendererSqlite: true, hiddenVisibleGenerating: true, orderedAutosave: true, closingLeaseFailure: true}))
} finally {
  for (const [id, c] of contexts) await store.releaseWriteLease({dirPath: root, conversationId: c.currentConversationStorage.value.conversationId, holderInstanceId: id, leaseEpoch: c.conversationLease.value.leaseEpoch})
  await fs.rm(root, {recursive: true, force: true})
}
