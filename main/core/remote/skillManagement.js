import fs from 'node:fs/promises'
import path from 'node:path'
import yaml from 'js-yaml'
import { remoteError } from './protocol.js'

export function createRemoteSkillManagement({ listSkills, notify = () => {} }) {
  async function location(root, id, { create = false } = {}) {
    if (typeof root !== 'string' || !root.trim())
      throw remoteError('remote_skill_root_not_configured')
    if (
      typeof id !== 'string' ||
      !id ||
      id.length > 160 ||
      /[\\/:*?"<>|\x00-\x1f]/.test(id) ||
      /[. ]$/.test(id) || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(id) ||
      ['.', '..'].includes(id)
    )
      throw remoteError('remote_identifier_invalid')
    const base = path.resolve(root),
      dir = path.join(base, id),
      file = path.join(dir, 'SKILL.md')
    const rootStat = await fs.lstat(base).catch(() => null)
    if (!rootStat?.isDirectory() || rootStat.isSymbolicLink())
      throw remoteError('remote_skill_root_invalid')
    const stat = await fs.lstat(dir).catch(() => null)
    if (stat && (!stat.isDirectory() || stat.isSymbolicLink()))
      throw remoteError('remote_skill_path_invalid')
    if (create && !stat) await fs.mkdir(dir)
    const fileStat = await fs.lstat(file).catch(() => null)
    if (fileStat && (!fileStat.isFile() || fileStat.isSymbolicLink() || fileStat.size > 128 * 1024))
      throw remoteError('remote_skill_file_invalid')
    return { dir, file, exists: Boolean(fileStat) }
  }
  async function get(root, id) {
    const entry = await location(root, id)
    if (!entry.exists) return null
    const raw = await fs.readFile(entry.file, 'utf8')
    const match = raw.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)([\s\S]*)$/)
    let metadata = {}
    if (match) {
      try {
        const parsed = yaml.load(match[1])
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) metadata = parsed
      } catch {
        throw remoteError('remote_skill_metadata_invalid')
      }
    }
    return {
      name: String(metadata.name || id),
      description: String(metadata.description || ''),
      enabled: metadata['disable-model-invocation'] !== true,
      fork: metadata.context === 'fork',
      content: match ? match[2] : raw,
      metadata
    }
  }
  async function save(root, id, value) {
    const { file } = await location(root, id, { create: true })
    const metadata = {
      ...value.metadata,
      name: value.name,
      description: value.description,
      'disable-model-invocation': value.enabled === false,
      context: value.fork ? 'fork' : 'normal'
    }
    const content = `---\n${yaml.dump(metadata, { noRefs: true, lineWidth: -1 })}---\n${value.content}`
    const temp = `${file}.${process.pid}.${Date.now()}.tmp`
    await fs.writeFile(temp, content, { flag: 'wx' })
    try {
      await fs.rename(temp, file)
    } catch {
      await fs.unlink(temp).catch(() => {})
      throw remoteError('remote_skill_save_failed')
    }
    notify()
  }
  async function setEnabled(root, id, enabled) {
    const current = await get(root, id)
    if (!current) throw remoteError('remote_workspace_item_not_found')
    await save(root, id, { ...current, enabled: enabled === true })
    return { ok: true }
  }


  async function remove(root, id) {
    const { file, exists } = await location(root, id)
    if (exists) await fs.unlink(file)
    notify()
  }
  async function list(root) {
    if (!root) return []
    const entries = await listSkills(root)
    const results = []
    for (const item of entries) {
      try {
        const value = await get(root, item.id)
        if (value) results.push({ id: item.id, name: value.name, enabled: value.enabled })
      } catch {
        /* Skip unsafe entries without logging paths. */
      }
    }
    return results
  }
  return { get, save, setEnabled, remove, list }
}
