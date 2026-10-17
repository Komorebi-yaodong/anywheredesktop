import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import { createRemoteSkillManagement } from '../main/core/remote/skillManagement.js'
const root = await fs.mkdtemp(path.join(os.tmpdir(), 'anywhere-skill-fixture-'))
try {
  const service = createRemoteSkillManagement({ listSkills: () => [{ id: 'fixture' }] })
  await service.save(root, 'fixture', {
    name: 'Test',
    description: 'Fixture',
    content: '# Instructions\nSafe',
    enabled: true,
    fork: false
  })
  assert.equal((await service.get(root, 'fixture')).content, '# Instructions\nSafe')
  await fs.writeFile(path.join(root, 'fixture', 'keep.txt'), 'fixture asset')
  await service.remove(root, 'fixture')
  assert.equal(await service.get(root, 'fixture'), null)
  assert.equal(await fs.readFile(path.join(root, 'fixture', 'keep.txt'), 'utf8'), 'fixture asset')
  await assert.rejects(service.get(root, '../escape'), { code: 'remote_identifier_invalid' })
  for (const id of ['C:escape', 'CON', 'NUL.txt', 'trailing.', 'trailing ']) await assert.rejects(service.get(root,id),{code:'remote_identifier_invalid'})

  console.log(JSON.stringify({ ok: true, suite: 'remote-skill-management' }))
} finally {
  await fs.rm(root, { recursive: true, force: true })
}
