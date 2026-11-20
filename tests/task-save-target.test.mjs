import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import vm from 'node:vm'

const source = (
  await readFile(new URL('../render/window/App.vue', import.meta.url), 'utf8')
).replaceAll('\r\n', '\n')
function between(from, to) {
  const start = source.indexOf(from)
  const end = source.indexOf(to, start + from.length)
  assert(start >= 0 && end > start, from)
  return source.slice(start, end)
}
const automaticSaving = between(
  'const shouldPersistCurrentSessionAutomatically =',
  'const cancelAutoNamingRequest ='
)
const saveSession = between('const autoSaveSession =', 'const autoSaveSessionRequestConfig =')
const taskSave = between('const persistScheduledTaskConversation =', 'const scheduleAutoSave =')

function fixture(task, storage = null, dirPath = 'fixture-directory') {
  const creates = [],
    writes = [],
    saves = []
  let projectReads = 0
  const c = {
    currentTaskConfig: { value: task },
    currentConversationStorage: { value: storage },
    currentConfig: {
      value: {
        webdav: { localChatPath: dirPath },
        prompts: { agent: { autoSaveProjectId: 'prompt-project' } }
      }
    },
    defaultConversationName: { value: storage?.title || '' },
    basic_msg: { value: { type: 'task' } },
    CODE: { value: 'agent' },
    conversationLease: { value: { leaseEpoch: 'fixture-lease' } },
    conversationInstanceId: 'fixture-instance',
    conversationPersistenceTracker: { markPersisted() {} },
    remoteConversationDeleted: { value: false },
    isCurrentPromptAutoSaveEnabled: () => true,
    isNamedLocalConversationAvailable: () => Boolean(storage),
    getSessionDataAsObject: () => ({ messages: [] }),
    ensureConversationWriteAccess: () => true,
    acquireCurrentConversationLease: async () => {},
    normalizeWindowProjects: (result) => result,
    sessionMutationVersion: 0,
    lastAutoSaveAt: 0,
    lastAutoSaveError: null,
    window: {
      api: {
        readLocalProjects: async () => {
          projectReads++
          return { projects: [{ id: 'task-project', name: 'Task project' }] }
        },
        createConversation: async (input) => {
          creates.push(input)
          return {
            descriptor: { conversationId: 'new-conversation', title: input.title, revision: 1 }
          }
        },
        saveConversationSnapshot: async (input) => {
          writes.push(input)
          return { title: input.title, revision: input.expectedRevision + 1 }
        }
      }
    }
  }
  const api = vm.runInNewContext(
    `${automaticSaving}\n${saveSession}\n${taskSave}\n({shouldPersistCurrentSessionAutomatically, autoSaveSession, persistScheduledTaskConversation})`,
    c
  )
  c.executeAutoSaveRequest = (request) => {
    saves.push(request)
    return api.autoSaveSession(request.force, request)
  }
  return {
    api: {
      ...api,
      finish: async () => (await api.persistScheduledTaskConversation(task)).savedConversationId
    },
    creates,
    writes,
    saves,
    get projectReads() {
      return projectReads
    }
  }
}

const off = fixture({ name: 'Fixture', autoSave: false, autoSaveProjectId: 'task-project' })
assert.equal(
  off.api.shouldPersistCurrentSessionAutomatically(),
  false,
  'Agent prompt auto-save cannot override the task toggle'
)
assert.equal(await off.api.finish(), '')
assert.equal(off.saves.length, 0)

const on = fixture({ name: 'Fixture', autoSave: true, autoSaveProjectId: 'task-project' })
assert.equal(await on.api.finish(), 'new-conversation')
assert.equal(on.creates[0].projectId, 'task-project')
assert.equal(on.creates[0].projectName, 'Task project')
assert.match(on.creates[0].title, /^定时任务-Fixture-/)

const existing = {
  conversationId: 'existing-conversation',
  dirPath: 'existing-directory',
  title: 'Existing title',
  revision: 2
}
const conversation = fixture(
  { conversationId: existing.conversationId, autoSave: false, autoSaveProjectId: 'stale-project' },
  existing,
  ''
)
assert.equal(await conversation.api.finish(), existing.conversationId)
assert.equal(conversation.writes[0].conversationId, existing.conversationId)
assert.equal(conversation.writes[0].title, existing.title)
assert.equal(conversation.writes[0].dirPath, existing.dirPath)
assert.equal(Object.hasOwn(conversation.writes[0], 'projectId'), false)
assert.equal(conversation.creates.length + conversation.projectReads, 0)

const missing = fixture({ conversationId: existing.conversationId, autoSave: true })
await assert.rejects(missing.api.finish(), /task_save_failed/)
assert.equal(missing.saves.length, 0, 'do not create a replacement if the target writer is missing')
console.log(
  'PASS task persistence: Agent opt-in/project, existing writer always saves, and missing writer never creates a substitute'
)
