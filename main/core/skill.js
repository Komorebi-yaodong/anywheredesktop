import fs from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import AdmZip from 'adm-zip'

import { getBuiltinServers, getBuiltinTools } from './mcp_builtin.js'
import { get as dbGet } from './db.js'

/**
 * 获取所有内置工具的名称列表
 */
async function getAllBuiltinToolNames(mcpServers = {}) {
  const servers = getBuiltinServers()
  const allToolNames = []

  // 1) 优先读取主配置中的 MCP 服务状态
  let effectiveMcpServers = mcpServers
  try {
    if (!effectiveMcpServers || typeof effectiveMcpServers !== 'object' || Array.isArray(effectiveMcpServers)) {
      const mcpServersDoc = await dbGet('mcpServers')
      if (mcpServersDoc?.ok && mcpServersDoc.doc?.data && typeof mcpServersDoc.doc.data === 'object') {
        effectiveMcpServers = mcpServersDoc.doc.data
      }
    }
  } catch {
    // ignore, fallback to input
  }
  if (!effectiveMcpServers || typeof effectiveMcpServers !== 'object' || Array.isArray(effectiveMcpServers)) {
    effectiveMcpServers = {}
  }

  // 2) 读取工具缓存状态（用于工具级 enabled 过滤）
  let mcpToolCache = {}
  try {
    const cacheDoc = await dbGet('mcp_tools_cache')
    if (cacheDoc?.ok && cacheDoc.doc?.data && typeof cacheDoc.doc.data === 'object') {
      mcpToolCache = cacheDoc.doc.data
    }
  } catch {
    // ignore, fallback empty cache
  }

  for (const serverId of Object.keys(servers || {})) {
    const serverConfig = effectiveMcpServers?.[serverId]
    if (serverConfig && serverConfig.isActive === false) {
      continue
    }

    const tools = await getBuiltinTools(serverId)
    const cachedTools = Array.isArray(mcpToolCache?.[serverId]) ? mcpToolCache[serverId] : []

    if (Array.isArray(tools)) {
      for (const tool of tools) {
        const toolName = tool?.name
        if (typeof toolName !== 'string' || !toolName) continue
        if (toolName === 'sub_agent') continue

        const cachedTool = cachedTools.find((item) => item?.name === toolName)
        const isToolEnabled = cachedTool ? cachedTool.enabled !== false : tool?.enabled !== false
        if (!isToolEnabled) continue

        allToolNames.push(toolName)
      }
    }
  }

  return allToolNames
}

// 解析 Frontmatter（兼容 Claude Code Skill 常见 YAML：多行 |、数组、布尔值、带引号字符串）
function parseYamlScalar(rawValue) {
  const value = rawValue.trim()

  if (value === 'true') return true
  if (value === 'false') return false

  if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
    return value.slice(1, -1)
  }

  if (value.startsWith('[') && value.endsWith(']')) {
    const inner = value.slice(1, -1).trim()
    if (!inner) return []

    const items = []
    let current = ''
    let quote = null

    for (let i = 0; i < inner.length; i++) {
      const ch = inner[i]
      if ((ch === '"' || ch === "'") && inner[i - 1] !== '\\') {
        quote = quote === ch ? null : quote || ch
        current += ch
        continue
      }
      if (ch === ',' && !quote) {
        items.push(parseYamlScalar(current))
        current = ''
        continue
      }
      current += ch
    }

    if (current.trim()) items.push(parseYamlScalar(current))
    return items
  }

  return value
}

function parseFrontmatter(content = '') {
  const normalized = content.replace(/\r\n/g, '\n')
  const regex = /^---\s*\n([\s\S]*?)\n---\s*\n?([\s\S]*)$/
  const match = normalized.match(regex)

  if (!match) {
    return {
      metadata: {},
      body: normalized
    }
  }

  const yamlStr = match[1]
  const body = match[2]
  const metadata = {}
  const lines = yamlStr.split('\n')

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    if (!line.trim() || line.trim().startsWith('#')) continue

    const keyMatch = line.match(/^([A-Za-z0-9_-]+):\s*(.*)$/)
    if (!keyMatch) continue

    const key = keyMatch[1].trim()
    const rawValue = keyMatch[2] ?? ''

    if (rawValue === '|' || rawValue === '>') {
      const blockLines = []
      for (i = i + 1; i < lines.length; i++) {
        const nextLine = lines[i]
        if (!nextLine.trim()) {
          blockLines.push('')
          continue
        }
        if (!/^\s+/.test(nextLine)) {
          i -= 1
          break
        }
        blockLines.push(nextLine.replace(/^\s{2}/, '').replace(/^\t/, ''))
      }
      metadata[key] = blockLines.join(rawValue === '>' ? ' ' : '\n').trim()
      continue
    }

    if (rawValue === '') {
      const listItems = []
      let foundIndentedList = false
      for (let j = i + 1; j < lines.length; j++) {
        const nextLine = lines[j]
        if (!nextLine.trim()) {
          if (foundIndentedList) continue
          break
        }
        const listMatch = nextLine.match(/^\s*-\s+(.*)$/)
        if (!listMatch) break
        foundIndentedList = true
        listItems.push(parseYamlScalar(listMatch[1]))
        i = j
      }
      metadata[key] = foundIndentedList ? listItems : ''
      continue
    }

    metadata[key] = parseYamlScalar(rawValue)
  }

  return { metadata, body }
}

function findSkillEntryDir(rootDir) {
  const directSkillPath = path.join(rootDir, 'SKILL.md')
  if (fs.existsSync(directSkillPath)) {
    return rootDir
  }

  const items = fs.readdirSync(rootDir, { withFileTypes: true })
  for (const item of items) {
    if (!item.isDirectory()) continue
    if (item.name.startsWith('.') || item.name === '__MACOSX' || item.name === 'node_modules') continue

    const fullPath = path.join(rootDir, item.name)
    const found = findSkillEntryDir(fullPath)
    if (found) return found
  }

  return null
}

// 递归读取目录结构
function getDirectoryStructure(dirPath, relativeRoot = '') {
  const result = []

  try {
    const items = fs.readdirSync(dirPath, { withFileTypes: true })

    for (const item of items) {
      if (item.name.startsWith('.') || item.name === 'node_modules') continue

      const fullPath = path.join(dirPath, item.name)
      const relPath = path.join(relativeRoot, item.name)

      if (item.isDirectory()) {
        result.push({
          name: item.name,
          path: relPath,
          type: 'directory',
          children: getDirectoryStructure(fullPath, relPath)
        })
      } else {
        result.push({
          name: item.name,
          path: relPath,
          type: 'file',
          size: `${(fs.statSync(fullPath).size / 1024).toFixed(2)} KB`
        })
      }
    }
  } catch (error) {
    console.error(`Error reading directory ${dirPath}:`, error)
  }

  result.sort((a, b) => {
    if (a.type === b.type) {
      return a.name.localeCompare(b.name)
    }
    return a.type === 'directory' ? -1 : 1
  })

  return result
}

/**
 * 获取 Skill 列表（元数据）
 */
export function listSkills(skillRootPath) {
  if (!skillRootPath || !fs.existsSync(skillRootPath)) {
    return []
  }

  const skills = []

  try {
    const items = fs.readdirSync(skillRootPath, { withFileTypes: true })

    for (const item of items) {
      if (!item.isDirectory()) continue

      const skillDir = path.join(skillRootPath, item.name)
      const skillMdPath = path.join(skillDir, 'SKILL.md')

      if (!fs.existsSync(skillMdPath)) continue

      try {
        const content = fs.readFileSync(skillMdPath, 'utf-8')
        const { metadata } = parseFrontmatter(content)

        skills.push({
          id: item.name,
          name: metadata.name || item.name,
          description: metadata.description || 'No description provided.',
          userInvocable: metadata['user-invocable'] !== false,
          disabled: metadata['disable-model-invocation'] === true,
          context: metadata.context || 'normal',
          allowedTools: metadata['allowed-tools'],
          path: skillDir
        })
      } catch (error) {
        console.error(`Error parsing skill ${item.name}:`, error)
      }
    }
  } catch (error) {
    console.error('Error listing skills:', error)
  }

  return skills
}

/**
 * 获取单个 Skill 详情
 */
export function getSkillDetails(skillRootPath, skillId) {
  const skillDir = path.join(skillRootPath, skillId)
  const skillMdPath = path.join(skillDir, 'SKILL.md')

  if (!fs.existsSync(skillMdPath)) {
    throw new Error(`Skill ${skillId} not found.`)
  }

  const content = fs.readFileSync(skillMdPath, 'utf-8')
  const { metadata, body } = parseFrontmatter(content)
  const fileStructure = getDirectoryStructure(skillDir)

  return {
    id: skillId,
    metadata,
    content: body,
    rawContent: content,
    files: fileStructure,
    absolutePath: skillDir
  }
}

/**
 * 生成 Skill Tool 的 OpenAI Definition
 */
export function generateSkillToolDefinition(skills, rootPath) {
  const availableSkillsText = skills
    .filter((skill) => !skill.disabled)
    .map((skill) => {
      const modeTag = skill.context === 'fork' ? '[Sub-Agent]' : '[Direct]'
      return `- ${skill.name} ${modeTag}: ${skill.description}`
    })
    .join('\n')

  let description = 'Execute a skill within the main conversation\n'
  if (rootPath) {
    description += `Current Skills Library Path: "${rootPath}"\n`
  }

  description += `
When users ask you to perform tasks, check if any of the available skills below can help complete the task more effectively. Skills provide specialized capabilities and domain knowledge.

When users ask you to run a "slash command" or reference "/<something>" (e.g., "/commit", "/review-pr"), they are referring to a skill. Use this tool to invoke the corresponding skill.

Example:
  User: "run /commit"
  Assistant: [Calls Skill tool with skill: "commit"]

MODES:
1. Direct Mode: Returns instructions for YOU to follow.
2. Sub-Agent Mode (Fork): If a skill requires a sub-agent (usually complex tasks), this tool will automatically trigger the sub-agent. You must provide 'task' and 'context' to guide it.

How to invoke:
- Use this tool with the skill name and optional arguments
- Examples:
  - \`skill: "pdf"\` - invoke the pdf skill
  - \`skill: "commit", args: "-m 'Fix bug'"\` - invoke with arguments

Important:
- When a skill is relevant, you must invoke this tool IMMEDIATELY as your first action
- NEVER just announce or mention a skill in your text response without actually calling this tool
- This is a BLOCKING REQUIREMENT: invoke the relevant Skill tool BEFORE generating any other response about the task
- Do Not invoke a skill that is already Launched
- Only the skills listed below are available and only use skills listed in "Available skills" below， do not make assumptions about other skills.

Available skills:
${availableSkillsText}
`

  return {
    type: 'function',
    function: {
      name: 'Skill',
      description,
      parameters: {
        type: 'object',
        properties: {
          skill: {
            description: 'The name of the skill to execute.',
            type: 'string',
            enum: skills.map((skill) => skill.name)
          },
          args: {
            description:
              "The Input Variables for the skill template. Use this to fill placeholders like '$ARGUMENTS' or '$1' in the skill file. Examples: a git commit message, a file path, or a jira ticket ID. If the skill description implies a specific input format (e.g. 'Usage: /skill [url]'), put that input here.",
            type: 'string'
          },
          task: {
            description:
              "The Specific Instruction for the Sub-Agent. Use this to describe WHAT you want the Sub-Agent to actually DO with this skill. (e.g., 'Use this skill to refactor the login page', 'Follow this skill to deploy to prod'). Required for Sub-Agent mode.",
            type: 'string'
          },
          context: {
            description:
              "Optional context/background information for the Sub-Agent (e.g. 'The user is on Windows', 'Previous code analysis results'). Required for Sub-Agent mode.",
            type: 'string'
          },
          tools: {
            type: 'array',
            items: { type: 'string' },
            description:
              "Optional. Explicitly specify tool names to grant to the Sub-Agent. Defaults to all builtin tools if omitted. Required for Sub-Agent mode."
          },
          planning_level: {
            type: 'string',
            enum: ['fast', 'medium', 'high'],
            description: "Complexity level for Sub-Agent. Defaults to 'medium'. Required for Sub-Agent mode."
          },
          model_route: {
            type: 'string',
            enum: ['superior', 'general', 'fast'],
            description: "Optional. Choose which default assistant route the Sub-Agent should use based on the task difficulty. Defaults to 'general'."
          },
          custom_steps: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                id: { type: 'string' },
                title: { type: 'string' },
                prompt: { type: 'string' },
                first_step_completion_trigger: { type: 'string' },
                repeat_on_hit: { type: 'boolean' },
                trigger_type: { type: 'string', enum: ['contains', 'regex'] },
                completion_keyword: { type: 'string' }
              },
              required: ['title', 'prompt']
            },
            description:
              'Optional custom workflow steps for Sub-Agent. If provided, Sub-Agent follows these steps instead of default behavior.'
          }
        },
        required: ['skill'],
        additionalProperties: false
      }
    }
  }
}

/**
 * 处理 Skill 调用
 */
export async function resolveSkillInvocation(skillRootPath, skillName, toolArgsObj, options = {}) {
  const skills = listSkills(skillRootPath)
  const targetSkill = skills.find((skill) => skill.name === skillName)

  if (!targetSkill) {
    return `Error: Skill "${skillName}" not found.`
  }

  const details = getSkillDetails(skillRootPath, targetSkill.id)
  let instructions = details.content

  const argsInput = typeof toolArgsObj === 'object' ? (toolArgsObj.args || '') : toolArgsObj || ''
  const taskInput = typeof toolArgsObj === 'object' ? (toolArgsObj.task || '') : ''

  if (instructions.includes('$ARGUMENTS')) {
    instructions = instructions.replace(/\$ARGUMENTS/g, argsInput)
  } else if (argsInput) {
    instructions += `\n\n### Input Arguments\n${argsInput}`
  }

  const sessionId = Date.now().toString(36)
  instructions = instructions.replace(/\$\{CLAUDE_SESSION_ID\}/g, sessionId)

  let assetsInfo = ''

  if (details.files.length > 0) {
    assetsInfo += '\n\n### Skill Directory Assets\n'
    assetsInfo += `The following files are available in the skill directory (${details.absolutePath}):\n`

    function renderFiles(files, indent = '') {
      let output = ''
      for (const file of files) {
        if (file.name.toLowerCase() === 'skill.md') continue
        output += `${indent}- ${file.name} (${file.type})\n`
        if (file.children) {
          output += renderFiles(file.children, `${indent}  `)
        }
      }
      return output
    }

    const fileTreeStr = renderFiles(details.files)
    if (fileTreeStr.trim()) {
      assetsInfo += fileTreeStr
      assetsInfo += "\nNote: If referenced in the instructions, you can read these files (e.g., files in the `references` directory, rather than scripts/*) and run the relevant scripts (do not read the script files themselves, such as those in the `scripts` directory). Note: Modifying files in the skill directory without permission is prohibited.\n"
      assetsInfo += "(Note: 'SKILL.md' contains the instructions you are currently reading, so it is hidden from this list.)\n"
    }
  }

  if (targetSkill.context === 'fork') {
    let fullTask = `Skill Launched: ${targetSkill.name}\n\n`

    if (targetSkill.description) {
      fullTask += `### Description\n${targetSkill.description}\n\n`
    }

    fullTask += `### Standard Operating Procedures (SOP)\n${instructions}`
    fullTask += assetsInfo

    if (taskInput) {
      fullTask += `\n### Current Task Request\n${taskInput}`
    }

    let toolsToUse = []

    if (Array.isArray(toolArgsObj?.tools) && toolArgsObj.tools.length > 0) {
      toolsToUse = toolArgsObj.tools
    } else if (targetSkill.allowedTools) {
      toolsToUse = Array.isArray(targetSkill.allowedTools)
        ? targetSkill.allowedTools
        : String(targetSkill.allowedTools)
            .split(',')
            .map((item) => item.trim())
            .filter(Boolean)
    } else {      toolsToUse = await getAllBuiltinToolNames(options?.mcpServers || {})
    }

    return {
      __isForkRequest: true,
      subAgentArgs: {
        task: fullTask,
        context: toolArgsObj?.context || 'No additional context.',
        tools: toolsToUse,
        planning_level: toolArgsObj?.planning_level || 'medium',
        model_route: toolArgsObj?.model_route || 'general',
        custom_steps: toolArgsObj?.custom_steps
      }
    }
  }

  let response = `## Skill Launched: ${targetSkill.name}\n\n`
  response += `### Instructions\n${instructions}\n\n`

  if (targetSkill.allowedTools) {
    const toolsStr = Array.isArray(targetSkill.allowedTools)
      ? targetSkill.allowedTools.join(', ')
      : targetSkill.allowedTools
    response += `### Tool Restrictions\nYou are requested to only use the following tools: ${toolsStr}\n\n`
  }

  response += assetsInfo

  if (taskInput) {
    response += `\n\n### Current Task Request\n${taskInput}`
  }

  response += `\n\n### End of Skill Instructions\n ${targetSkill.name} launched successfully. Please use the skill correctly according to the Instructions, and do not repeatedly launch the same skill. `

  return response
}

/**
 * 保存/创建 Skill
 */
export function saveSkill(skillRootPath, skillId, content) {
  const skillDir = path.join(skillRootPath, skillId)
  if (!fs.existsSync(skillDir)) {
    fs.mkdirSync(skillDir, { recursive: true })
  }

  const skillMdPath = path.join(skillDir, 'SKILL.md')
  fs.writeFileSync(skillMdPath, content, 'utf-8')
  return true
}

/**
 * 删除 Skill
 */
export function deleteSkill(skillRootPath, skillId) {
  const skillDir = path.join(skillRootPath, skillId)
  if (!fs.existsSync(skillDir)) {
    return false
  }

  fs.rmSync(skillDir, { recursive: true, force: true })
  return true
}

/**
 * 导出 Skill 为 .skill
 */

/**
 * 切换 Skill 的 Sub-Agent(Fork) 模式
 */
export function toggleSkillForkMode(skillRootPath, skillId, enableFork = false) {
  const details = getSkillDetails(skillRootPath, skillId)
  const meta = { ...(details.metadata || {}) }
  const body = details.content || ''

  if (enableFork) {
    meta.context = 'fork'
  } else {
    delete meta.context
  }

  const lines = ['---']
  for (const [key, value] of Object.entries(meta)) {
    if (value === undefined || value === null || value === '') continue

    if (Array.isArray(value)) {
      lines.push(`${key}: [${value.join(', ')}]`)
      continue
    }

    if (typeof value === 'boolean') {
      lines.push(`${key}: ${value ? 'true' : 'false'}`)
      continue
    }

    lines.push(`${key}: ${String(value)}`)
  }
  lines.push('---', '', body)

  return saveSkill(skillRootPath, skillId, lines.join('\n'))
}


function generateEnvExampleContent(envContent) {
  return String(envContent || '')
    .split(/\r\n|\n|\r/)
    .map((line) => {
      if (!line.includes('=')) return line

      const equalIndex = line.indexOf('=')
      return `${line.slice(0, equalIndex + 1)}`
    })
    .join('\n')
}

function addSkillDirectoryToZip(zip, sourceDir, options = {}) {
  const hideEnv = options?.hideEnv === true

  const walk = (currentDir, relativeDir = '') => {
    const entries = fs.readdirSync(currentDir, { withFileTypes: true })
    const hasEnvExampleInCurrentDir = entries.some((entry) => entry.isFile() && entry.name === '.env.example')

    for (const entry of entries) {
      const absolutePath = path.join(currentDir, entry.name)
      const relativePath = relativeDir ? path.join(relativeDir, entry.name) : entry.name
      const zipRelativePath = relativePath.split(path.sep).join('/')
      const zipDir = path.posix.dirname(zipRelativePath) === '.' ? '' : path.posix.dirname(zipRelativePath)

      if (hideEnv && entry.isFile() && entry.name === '.env') {
        const envExampleName = hasEnvExampleInCurrentDir ? '.env.example2' : '.env.example'
        const envExamplePath = zipDir ? `${zipDir}/${envExampleName}` : envExampleName
        const envExampleContent = generateEnvExampleContent(fs.readFileSync(absolutePath, 'utf8'))
        zip.addFile(envExamplePath, Buffer.from(envExampleContent, 'utf8'))
        continue
      }

      if (entry.isDirectory()) {
        walk(absolutePath, relativePath)
        continue
      }

      if (entry.isFile()) {
        zip.addLocalFile(absolutePath, zipDir, path.posix.basename(zipRelativePath))
      }
    }
  }

  walk(sourceDir)
}

export function exportSkillToPackage(skillRootPath, skillId, outputDir, options = {}) {
  return new Promise((resolve, reject) => {
    try {
      const skillDir = path.join(skillRootPath, skillId)
      if (!fs.existsSync(skillDir)) {
        reject(new Error(`Skill directory not found: ${skillDir}`))
        return
      }

      const zip = new AdmZip()
      addSkillDirectoryToZip(zip, skillDir, options)

      const outputFilename = `${skillId}.skill`
      const outputPath = path.join(outputDir, outputFilename)

      zip.writeZip(outputPath)
      resolve(outputPath)
    } catch (error) {
      reject(error)
    }
  })
}

/**
 * 解压 .skill/.zip 包并定位包含 SKILL.md 的目录
 */
export function extractSkillPackage(filePath) {
  return new Promise((resolve, reject) => {
    try {
      const zip = new AdmZip(filePath)
      const tempDir = path.join(os.tmpdir(), 'anywhere_skill_import', Date.now().toString())

      if (!fs.existsSync(tempDir)) {
        fs.mkdirSync(tempDir, { recursive: true })
      }

      zip.extractAllTo(tempDir, true)

      const finalDir = findSkillEntryDir(tempDir)
      if (!finalDir) {
        throw new Error('Invalid skill package: SKILL.md not found')
      }

      resolve(finalDir)
    } catch (error) {
      reject(error)
    }
  })
}


function extractSkillPackageFromBuffer(buffer, skillId = 'skill') {
  const zip = new AdmZip(Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer || []))
  const tempRoot = path.join(os.tmpdir(), 'anywhere_skill_cloud_pull', `${Date.now()}_${skillId}`)
  fs.mkdirSync(tempRoot, { recursive: true })
  zip.extractAllTo(tempRoot, true)
  const finalDir = findSkillEntryDir(tempRoot)
  if (!finalDir) {
    throw new Error('Invalid skill package: SKILL.md not found')
  }
  return finalDir
}


async function copyDirectoryContentsSafe(sourceDir, targetDir) {
  await fsp.mkdir(targetDir, { recursive: true })
  const entries = await fsp.readdir(sourceDir, { withFileTypes: true })
  for (const entry of entries) {
    const sourcePath = path.join(sourceDir, entry.name)
    const targetPath = path.join(targetDir, entry.name)
    if (entry.isDirectory()) {
      await copyDirectoryContentsSafe(sourcePath, targetPath)
      continue
    }
    if (!entry.isFile()) continue
    await fsp.mkdir(path.dirname(targetPath), { recursive: true })
    await fsp.copyFile(sourcePath, targetPath)
  }
}



function normalizeSkillId(value = '') {
  return String(value || '').trim().replace(/[\\/:*?"<>|]/g, '-')
}

function normalizeSkillRemoteRoot(remoteBasePath = '') {
  const normalized = String(remoteBasePath || '').trim().replace(/\\/g, '/')
  if (!normalized) {
    return '/anywhere/skill'
  }
  return normalized.startsWith('/') ? normalized.replace(/\/+$/, '') : `/${normalized.replace(/\/+$/, '')}`
}

function serializeSkillTreeToEntries(sourceDir, relativeDir = '') {
  const entries = []
  const dirents = fs.readdirSync(sourceDir, { withFileTypes: true })

  dirents.forEach((entry) => {
    if (entry.name === 'node_modules') return
    const absolutePath = path.join(sourceDir, entry.name)
    const relativePath = relativeDir ? path.posix.join(relativeDir, entry.name) : entry.name

    if (entry.isDirectory()) {
      entries.push({ type: 'directory', relativePath })
      entries.push(...serializeSkillTreeToEntries(absolutePath, relativePath))
      return
    }

    if (entry.isFile()) {
      entries.push({
        type: 'file',
        relativePath,
        content: fs.readFileSync(absolutePath)
      })
    }
  })

  return entries
}

async function ensureWebdavDirectoryChain(writeWebdavBackup, webdavConfig, remotePath = '') {
  const normalizedRemotePath = normalizeSkillRemoteRoot(remotePath)
  const segments = normalizedRemotePath.split('/').filter(Boolean)
  let currentPath = ''

  for (const segment of segments) {
    currentPath += `/${segment}`
    await writeWebdavBackup({
      webdavConfig,
      remotePath: currentPath,
      filename: '.keep',
      content: '',
      overwrite: true,
      ensureDirectory: true
    })
  }
}

export async function uploadSkillsToWebdav(options = {}) {
  const skillRootPath = path.resolve(String(options?.skillRootPath || ''))
  const writeWebdavBackup = options?.writeWebdavBackup
  const webdavConfig = options?.webdavConfig || {}
  const remoteRoot = normalizeSkillRemoteRoot(options?.remotePath)
  const signal = options?.signal
  const onProgress = typeof options?.onProgress === 'function' ? options.onProgress : null
  const maxPackageSizeBytes = Number.isFinite(options?.maxPackageSizeBytes)
    ? Math.max(1, Number(options.maxPackageSizeBytes))
    : 50 * 1024 * 1024
  const skillIds = Array.isArray(options?.skillIds)
    ? options.skillIds.map((item) => normalizeSkillId(item)).filter(Boolean)
    : []

  const throwIfAborted = () => {
    if (signal?.aborted) {
      const reason = signal.reason instanceof Error ? signal.reason.message : (signal.reason || 'cancelled')
      throw new Error(String(reason || 'cancelled'))
    }
  }

  const emitProgress = (payload = {}) => {
    if (!onProgress) return
    try {
      onProgress({
        total: skillIds.length,
        ...payload
      })
    } catch {
      // ignore progress listener errors
    }
  }

  if (!skillRootPath || !fs.existsSync(skillRootPath)) {
    throw new Error('skill_root_path_required')
  }
  if (typeof writeWebdavBackup !== 'function') {
    throw new Error('write_webdav_backup_required')
  }

  throwIfAborted()
  await ensureWebdavDirectoryChain(writeWebdavBackup, webdavConfig, remoteRoot)

  const tempDir = path.join(os.tmpdir(), 'anywhere_skill_sync', Date.now().toString())
  fs.mkdirSync(tempDir, { recursive: true })

  const results = []
  try {
    for (let index = 0; index < skillIds.length; index += 1) {
      const skillId = skillIds[index]
      throwIfAborted()
      emitProgress({ phase: 'packing', current: index, completed: results.length, skillId })

      try {
        const skillDir = path.join(skillRootPath, skillId)
        const skillMdPath = path.join(skillDir, 'SKILL.md')
        if (!fs.existsSync(skillMdPath)) {
          const item = { skillId, ok: false, message: 'skill_not_found' }
          results.push(item)
          emitProgress({ phase: 'failed', current: index + 1, completed: results.length, skillId, result: item })
          continue
        }

        const outputPath = await exportSkillToPackage(skillRootPath, skillId, tempDir, { hideEnv: false })
        throwIfAborted()
        const stat = fs.statSync(outputPath)
        if (stat.size > maxPackageSizeBytes) {
          const item = {
            skillId,
            ok: false,
            message: '文件过大超过限制“50MB”',
            code: 'FILE_TOO_LARGE',
            size: stat.size,
            limit: maxPackageSizeBytes
          }
          results.push(item)
          emitProgress({ phase: 'failed', current: index + 1, completed: results.length, skillId, result: item })
          continue
        }

        emitProgress({ phase: 'uploading', current: index, completed: results.length, skillId })
        const content = fs.readFileSync(outputPath)
        throwIfAborted()
        await writeWebdavBackup({
          webdavConfig,
          remotePath: remoteRoot,
          filename: `${skillId}.skill`,
          content,
          overwrite: true,
          ensureDirectory: true
        })
        const item = { skillId, ok: true, size: stat.size }
        results.push(item)
        emitProgress({ phase: 'completed', current: index + 1, completed: results.length, skillId, result: item })
      } catch (error) {
        if (signal?.aborted) throw error
        const item = { skillId, ok: false, message: error?.message || String(error || 'upload_failed') }
        results.push(item)
        emitProgress({ phase: 'failed', current: index + 1, completed: results.length, skillId, result: item })
      }
    }

    return {
      ok: true,
      remotePath: remoteRoot,
      results
    }
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true })
  }
}

export async function listSkillsFromWebdav(options = {}) {
  const listWebdavDirectory = options?.listWebdavDirectory
  const readWebdavBackup = options?.readWebdavBackup
  const includeMetadata = options?.includeMetadata === true
  const webdavConfig = options?.webdavConfig || {}
  const remoteRoot = normalizeSkillRemoteRoot(options?.remotePath)

  if (typeof listWebdavDirectory !== 'function') {
    throw new Error('list_webdav_directory_required')
  }

  const rootResult = await listWebdavDirectory({ webdavConfig, remotePath: remoteRoot, includeDirectories: false, includeFiles: true })
  if (!rootResult || rootResult.ok === false) {
    throw new Error(rootResult?.message || rootResult?.error || 'webdav_list_failed')
  }
  if (!rootResult.exists) {
    return { ok: true, skills: [], remotePath: remoteRoot }
  }

  const files = Array.isArray(rootResult.files) ? rootResult.files.filter(item => String(item?.basename || '').toLowerCase().endsWith('.skill')) : []
  const skills = []
  for (const item of files) {
    const skillId = normalizeSkillId(String(item?.basename || '').replace(/\.skill$/i, ''))
    let metadata = {}
    if (includeMetadata && typeof readWebdavBackup === 'function') {
      let tempDir = ''
      try {
        const readResult = await readWebdavBackup({ webdavConfig, remotePath: remoteRoot, filename: `${skillId}.skill` })
        tempDir = await extractSkillPackageFromBuffer(readResult?.content, skillId)
        const skillMdPath = path.join(tempDir, 'SKILL.md')
        if (fs.existsSync(skillMdPath)) {
          metadata = parseFrontmatter(fs.readFileSync(skillMdPath, 'utf8')).metadata || {}
        }
      } catch {
        metadata = {}
      } finally {
        if (tempDir) fs.rmSync(path.dirname(tempDir), { recursive: true, force: true })
      }
    }

    skills.push({
      id: skillId,
      name: metadata.name || skillId,
      description: metadata.description || '',
      updatedAt: item?.updatedAt || item?.lastmod || '',
      createdAt: item?.createdAt || '',
      size: item?.size || 0,
      remotePath: remoteRoot,
      metadataLoaded: includeMetadata
    })
  }

  return {
    ok: true,
    remotePath: remoteRoot,
    skills
  }
}

async function collectSkillRemoteFiles(listWebdavDirectory, webdavConfig, remotePath, relativePrefix = '') {
  const result = await listWebdavDirectory({ webdavConfig, remotePath, includeDirectories: true, includeFiles: true })
  if (!result?.exists) return []

  const files = []
  for (const item of Array.isArray(result.files) ? result.files : []) {
    const basename = String(item?.basename || item?.filename || '').trim()
    if (!basename || basename === '.keep') continue
    if (item.type === 'directory') {
      const nested = await collectSkillRemoteFiles(listWebdavDirectory, webdavConfig, `${remotePath}/${basename}`, relativePrefix ? `${relativePrefix}/${basename}` : basename)
      files.push(...nested)
      continue
    }

    files.push({
      remotePath,
      filename: basename,
      relativePath: relativePrefix ? `${relativePrefix}/${basename}` : basename
    })
  }

  return files
}


export async function deleteSkillsFromWebdav(options = {}) {
  const deleteWebdavDirectoryContents = options?.deleteWebdavDirectoryContents
  const webdavConfig = options?.webdavConfig || {}
  const remoteRoot = normalizeSkillRemoteRoot(options?.remotePath)
  const skillIds = Array.isArray(options?.skillIds)
    ? options.skillIds.map((item) => normalizeSkillId(item)).filter(Boolean)
    : []

  if (typeof deleteWebdavDirectoryContents !== 'function') {
    throw new Error('webdav_delete_helpers_required')
  }

  const filenames = skillIds.map(skillId => `${skillId}.skill`)
  await deleteWebdavDirectoryContents({ webdavConfig, remotePath: remoteRoot, filenames })
  return { ok: true, remotePath: remoteRoot, results: skillIds.map(skillId => ({ skillId, ok: true })) }
}

export async function pullSkillFromWebdav(options = {}) {
  const readWebdavBackupBinary = options?.readWebdavBackupBinary
  const skillRootPath = path.resolve(String(options?.skillRootPath || ''))
  const webdavConfig = options?.webdavConfig || {}
  const remoteRoot = normalizeSkillRemoteRoot(options?.remotePath)
  const skillId = normalizeSkillId(options?.skillId)

  if (!skillRootPath) throw new Error('skill_root_path_required')
  if (!skillId) throw new Error('skill_id_required')
  if (typeof readWebdavBackupBinary !== 'function') {
    throw new Error('webdav_read_helpers_required')
  }

  const readResult = await readWebdavBackupBinary({ webdavConfig, remotePath: remoteRoot, filename: `${skillId}.skill` })
  if (!readResult || readResult.ok === false) {
    throw new Error(readResult?.message || readResult?.reason || readResult?.error || 'webdav_read_failed')
  }

  let extractedDir = ''
  let extractedRoot = ''
  const targetDir = path.join(skillRootPath, skillId)
  try {
    extractedDir = extractSkillPackageFromBuffer(readResult?.content, skillId)
    extractedRoot = path.dirname(extractedDir)

    await fsp.mkdir(skillRootPath, { recursive: true })
    await copyDirectoryContentsSafe(extractedDir, targetDir)

    return {
      ok: true,
      skillId,
      targetDir,
      mode: 'overwrite-files'
    }
  } finally {
    if (extractedRoot && fs.existsSync(extractedRoot)) {
      try {
        await fsp.rm(extractedRoot, { recursive: true, force: true })
      } catch {
        // ignore cleanup failure
      }
    }
  }
}
