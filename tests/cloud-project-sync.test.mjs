import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import vm from 'node:vm'
import {normalizeProjects, serializeProjectsYaml, parseProjectsYaml, mergeProjectAssignment} from '../main/core/projects.js'

const source = (await fs.readFile(new URL('../render/main/components/Chats.vue', import.meta.url), 'utf8')).replace(/\r\n/g, '\n')
const section = (start, end) => {
  const from = source.indexOf(start), to = source.indexOf(end, from)
  assert.ok(from >= 0 && to > from, `missing actual Chats function: ${start}`)
  return source.slice(from, to)
}
const descriptor = (id, patch = {}) => ({conversationId: id, dbFile: `${id}.db`, title: `Synthetic ${id}`, revision: 1, ...patch})
const project = (id, ids = [], patch = {}) => ({id, name: `Project ${id}`, files: [], conversationIds: ids, ...patch})
const d1 = descriptor('synthetic-chat-1'), d2 = descriptor('synthetic-chat-2'), unrelated = descriptor('unrelated-chat')
const localData = (descriptors = [d1, d2], projects = [project('new-project', descriptors.map(d => d.conversationId))]) => normalizeProjects({
  conversations: Object.fromEntries(descriptors.map(d => [d.conversationId, d])), projects,
})

function fixture({local = localData(), cloud = {}, failUpload = '', failWrite = false, corruptReadback = false} = {}) {
  let saved = normalizeProjects(cloud)
  const writes = [], uploaded = [], errors = [], successes = [], sequence = []
  let mergeCalls = 0, refreshes = 0
  const clone = value => JSON.parse(JSON.stringify(value))
  const store = data => {
    if (failWrite) throw new Error('synthetic write failure')
    // Exercise the same normalization and serialization boundary as projects:writeCloud.
    saved = parseProjectsYaml(serializeProjectsYaml(data))
    writes.push(clone(saved))
    sequence.push('write')
    return {ok: true}
  }
  const context = {
    console: {warn() {}, error() {}}, AbortController, setTimeout,
    getSafeString: value => typeof value === 'string' ? value : '',
    formatSyncError: error => error?.message || String(error),
    buildWebdavInput: () => ({}), buildChatWebdavInput: () => ({}),
    localChatPath: {value: 'synthetic-only'},
    singleFileSyncing: {value: {}},
    localChatFiles: {value: Object.values(local.conversations || {}).map(d => ({format: 'sqlite', conversationId: d.conversationId, basename: d.dbFile}))},
    cloudChatFiles: {value: []},
    fetchCloudFiles: async () => {sequence.push('fetch-cloud')},
    ensureWebdavResult: value => {if (value?.ok === false) throw new Error('synthetic WebDAV failure'); return value},
    getJsonBasenameCandidate: value => String(value || '').endsWith('.json') ? value : `${value}.json`,
    isSameProjectFile: (left, right) => left === right || `${left}.json` === right,
    localProjects: {value: clone(local)}, cloudProjects: {value: saved},
    isWebdavConfigValid: {value: true}, isSyncing: {value: false}, syncProgress: {value: 0}, syncStatusText: {value: ''}, syncAbortController: {value: null},
    projectGroups: {value: local.projects.map(p => ({...p, files: p.conversationIds.map(id => ({format: 'sqlite', conversationId: id, basename: local.conversations[id].dbFile}))}))},
    getConversationReference: file => file.conversationId || file.basename,
    t: key => key,
    ElMessage: {success: message => successes.push(message), error: message => errors.push(message), warning() {}},
    refreshData: async () => {refreshes++},
    window: {api: {
      readCloudProjects: async () => {
        const result = clone(saved)
        if (corruptReadback && writes.length) result.projects.forEach(p => {p.conversationIds = []})
        return result
      },
      writeCloudProjects: async (_input, data) => store(data),
      listWebdavBackups: async () => ({ok: true, files: local.projects.flatMap(p => (p.files || []).map(basename => ({basename})))}),
      uploadCloudConversationRemote: async input => {
        if (input.conversationId === failUpload) throw new Error('synthetic upload failure')
        uploaded.push(input.conversationId)
        sequence.push(`upload:${input.conversationId}`)
        return {descriptor: local.conversations[input.conversationId]}
      },
      mergeProjectCloudProjects: async (_input, incoming) => {
        mergeCalls++
        sequence.push('merge-project')
        const merged = mergeProjectAssignment(saved, incoming)
        store(merged)
        return {ok: true, data: clone(saved)}
      },
    }},
  }
  vm.createContext(context)
  vm.runInContext([
    section('let cloudProjectsWriteQueue =', '// --- 自动清理功能状态 ---'),
    section('const normalizeProjectsResult =', 'async function fetchLocalProjects('),
    section('const findProjectOfBasename =', '// 渲染端镜像后端 mergeProjectAssignment'),
    section('const syncProject =', 'async function syncProjectToLocal'),
    section('const uploadDatabaseConversation =', 'const downloadDatabaseConversation ='),
    section('async function runConcurrentTasks(', 'async function intelligentUpload('),
    section('async function executeSync(', 'async function forceSyncFile('),
    section('async function forceSyncFile(', 'const computedFilesToClean ='),
    'globalThis.api = {syncProjectToCloud, reconcileUploadedCloudIndex, commitDatabaseProjectDescriptors, forceSyncFile};',
  ].join('\n'), context)
  return {context, writes, uploaded, errors, successes, sequence, api: context.api,
    cloud: () => clone(saved), mergeCalls: () => mergeCalls, refreshes: () => refreshes}
}
const owner = (data, id) => data.projects.filter(p => p.conversationIds.includes(id)).map(p => p.id)

// Regression: the real project-sync coordinator verifies membership BEFORE its final project merge.
const first = fixture()
await first.api.syncProjectToCloud('new-project')
assert.deepEqual(first.errors, [], 'first upload to an empty cloud must create the project before readback')
assert.equal(first.mergeCalls(), 1)
assert.equal(first.refreshes(), 1)
assert.ok(first.successes.includes('chats.projects.syncProjectSuccess'))
for (const d of [d1, d2]) {
  assert.equal(first.cloud().conversations[d.conversationId].dbFile, d.dbFile)
  assert.deepEqual(owner(first.cloud(), d.conversationId), ['new-project'])
  assert.deepEqual(owner(first.writes[0], d.conversationId), ['new-project'], 'batch readback must already be valid')
}
assert.equal(first.sequence[0].startsWith('upload:'), true, 'do not publish ownership before upload')
await first.api.syncProjectToCloud('new-project')
assert.equal(first.errors.length, 0)
assert.equal(first.cloud().projects.filter(p => p.id === 'new-project').length, 1)
assert.deepEqual(first.cloud().projects[0].conversationIds.sort(), [d1.conversationId, d2.conversationId].sort())

// Single/partial uploads preserve pre-existing cloud members and same-name, different-ID projects.
const existing = localData([unrelated, d1], [
  project('existing-project', [unrelated.conversationId], {name: 'Cloud name', files: ['keep.json']}),
  project('previous-owner', [d1.conversationId]),
  project('same-name-other-id', [], {name: 'Project new-project'}),
])
const retained = fixture({cloud: existing})
await retained.api.reconcileUploadedCloudIndex({projectDescriptors: [d1, d1, d2]})
assert.deepEqual(owner(retained.cloud(), d1.conversationId), ['new-project'])
assert.deepEqual(owner(retained.cloud(), unrelated.conversationId), ['existing-project'])
assert.deepEqual(retained.cloud().projects.find(p => p.id === 'existing-project').files, ['keep.json'])
assert.ok(retained.cloud().projects.some(p => p.id === 'same-name-other-id'))
assert.equal(retained.cloud().projects.find(p => p.id === 'new-project').name, 'Project new-project')

const sameId = fixture({cloud: localData([unrelated], [project('new-project', [unrelated.conversationId], {name: 'Keep cloud name', files: ['keep.json']})])})
await sameId.api.reconcileUploadedCloudIndex({projectDescriptors: [d1, d2]})
const mergedProject = sameId.cloud().projects.find(p => p.id === 'new-project')
assert.equal(mergedProject.name, 'Keep cloud name')
assert.deepEqual(mergedProject.files, ['keep.json'])
assert.deepEqual(mergedProject.conversationIds.sort(), [unrelated.conversationId, d1.conversationId, d2.conversationId].sort())

// Legacy aliases can identify a local owner; ungrouped uploads must remain ungrouped.
const legacyDescriptor = descriptor('legacy-converted', {legacyJson: 'old-chat.json'})
const legacy = fixture({local: {projects: [project('legacy-owner', [], {files: ['old-chat.json']})]}})
await legacy.api.reconcileUploadedCloudIndex({projectDescriptors: [legacyDescriptor]})
assert.deepEqual(owner(legacy.cloud(), legacyDescriptor.conversationId), ['legacy-owner'])
assert.equal(legacy.cloud().projects[0].files.includes(legacyDescriptor.dbFile), false)
const ungrouped = fixture({local: localData([d1], []), cloud: localData([d1], [project('old-owner', [d1.conversationId])])})
await ungrouped.api.reconcileUploadedCloudIndex({projectDescriptors: [d1]})
assert.deepEqual(owner(ungrouped.cloud(), d1.conversationId), [])
assert.equal(ungrouped.cloud().projects.length, 1)

// Mixed JSON + SQLite batches can create the same project without losing either category.
const mixedLocal = localData([d1, d2], [project('mixed', [d1.conversationId, d2.conversationId], {files: ['legacy.json']})])
const mixed = fixture({local: mixedLocal})
await mixed.api.reconcileUploadedCloudIndex({jsonBasenames: ['legacy.json'], projectDescriptors: [d1, d2]})
assert.deepEqual(mixed.cloud().projects.find(p => p.id === 'mixed').files, ['legacy.json'])
assert.deepEqual(owner(mixed.cloud(), d1.conversationId), ['mixed'])
assert.deepEqual(owner(mixed.cloud(), d2.conversationId), ['mixed'])
const jsonOnly = fixture({local: {projects: [project('json-only', [], {files: ['only.json']})]}})
await jsonOnly.api.reconcileUploadedCloudIndex({jsonBasenames: ['only.json']})
assert.deepEqual(jsonOnly.cloud().projects.find(p => p.id === 'json-only').files, ['only.json'])


// Both descriptor commit paths must use identical create-if-missing semantics.
const direct = fixture()
await direct.api.commitDatabaseProjectDescriptors([d1, d2, d1])
assert.deepEqual(owner(direct.cloud(), d1.conversationId), ['new-project'])
assert.deepEqual(owner(direct.cloud(), d2.conversationId), ['new-project'])

// The direct single-conversation upload uses the same index coordinator without a project merge.
const single = fixture()
await single.api.forceSyncFile(d1.conversationId, 'upload', new AbortController().signal)
assert.deepEqual(single.errors, [])
assert.equal(single.mergeCalls(), 0)
assert.deepEqual(owner(single.cloud(), d1.conversationId), ['new-project'])
assert.equal(single.cloud().conversations[d2.conversationId], undefined)
assert.equal(single.context.singleFileSyncing.value[d1.conversationId], false)
assert.equal(single.successes.length, 1)

// Multiple distinct new projects are created independently; empty uploads do not invent descriptors.
const multiple = fixture({local: localData([d1, d2], [project('one', [d1.conversationId]), project('two', [d2.conversationId])])})
await multiple.api.reconcileUploadedCloudIndex({projectDescriptors: [d1, d2]})
assert.deepEqual(owner(multiple.cloud(), d1.conversationId), ['one'])
assert.deepEqual(owner(multiple.cloud(), d2.conversationId), ['two'])
const empty = fixture({local: localData([], [project('empty')])})
await empty.api.syncProjectToCloud('empty')
assert.deepEqual(empty.errors, [])
assert.deepEqual(empty.uploaded, [])
assert.equal(empty.cloud().projects[0].id, 'empty')


// Concurrent index requests remain serialized and do not overwrite each other.
const concurrent = fixture()
await Promise.all([
  concurrent.api.reconcileUploadedCloudIndex({projectDescriptors: [d1]}),
  concurrent.api.reconcileUploadedCloudIndex({projectDescriptors: [d2]}),
])
assert.deepEqual(owner(concurrent.cloud(), d1.conversationId), ['new-project'])
assert.deepEqual(owner(concurrent.cloud(), d2.conversationId), ['new-project'])

// Do not claim success or add failed uploads to the project.
const partial = fixture({failUpload: d2.conversationId})
await partial.api.syncProjectToCloud('new-project')
assert.equal(partial.successes.length, 0)
assert.ok(partial.errors.some(message => message.startsWith('project_upload_incomplete:')))
assert.equal(partial.mergeCalls(), 0)
assert.equal(partial.cloud().conversations[d2.conversationId], undefined)
assert.deepEqual(owner(partial.cloud(), d1.conversationId), ['new-project'])
for (const options of [{failWrite: true}, {corruptReadback: true}]) {
  const failed = fixture(options)
  await failed.api.syncProjectToCloud('new-project')
  assert.equal(failed.successes.length, 0)
  assert.ok(failed.errors.length > 0)
  assert.equal(failed.mergeCalls(), 0)
}
console.log(JSON.stringify({ok: true, suite: 'cloud-project-sync', actualChatsCoordinator: true, emptyCloud: true, idempotent: true, partialSingleConcurrent: true, readbackFailureGuard: true}))
