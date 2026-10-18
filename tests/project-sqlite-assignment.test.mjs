import assert from 'node:assert/strict'
import { mergeProjectAssignment, normalizeProjects } from '../main/core/projects.js'

const conversationId = 'conversation-scheduled-task-fixture-0001'
const dbFile = 'conversation-scheduled-task-fixture-0001.db'
const source = normalizeProjects({
  version: 2,
  conversations: {
    [conversationId]: {
      conversationId,
      dbFile,
      title: 'Synthetic scheduled task',
      storageMode: 'local',
      revision: 3,
      createdAt: '2026-10-18T00:00:00.000Z',
      updatedAt: '2026-10-18T00:00:01.000Z'
    }
  },
  projects: [
    { id: 'previous-project', name: 'Previous', files: [], conversationIds: [conversationId] }
  ]
})

const merged = mergeProjectAssignment(source, {
  id: 'scheduled-project',
  name: 'Scheduled project',
  files: ['legacy-chat.json'],
  conversationIds: [conversationId]
})

assert.deepEqual(merged.conversations[conversationId], source.conversations[conversationId])
assert.deepEqual(
  merged.projects.find((project) => project.id === 'scheduled-project'),
  {
    id: 'scheduled-project',
    name: 'Scheduled project',
    files: ['legacy-chat.json'],
    conversationIds: [conversationId]
  }
)
assert.deepEqual(
  merged.projects.find((project) => project.id === 'previous-project')?.conversationIds,
  [],
  'a SQLite descriptor must have one project owner after project sync'
)
assert.equal(
  merged.projects.find((project) => project.id === 'scheduled-project')?.files.includes(dbFile),
  false,
  'SQLite snapshots are indexed through conversationIds, never as legacy JSON files'
)

console.log(JSON.stringify({ ok: true, suite: 'project-sqlite-assignment' }))
