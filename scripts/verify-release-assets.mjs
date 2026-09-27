import fs from 'node:fs/promises'
import path from 'node:path'
import process from 'node:process'

const rootDir = path.resolve(process.argv[2] || 'release-assets')

async function walkFiles(directory) {
  const entries = await fs.readdir(directory, { withFileTypes: true })
  const files = []

  for (const entry of entries) {
    const entryPath = path.join(directory, entry.name)
    if (entry.isDirectory()) {
      files.push(...(await walkFiles(entryPath)))
    } else if (entry.isFile()) {
      files.push(entryPath)
    }
  }

  return files
}

function normalizeYamlScalar(value = '') {
  const trimmed = String(value).trim()
  if (
    trimmed.length >= 2 &&
    ((trimmed.startsWith("'") && trimmed.endsWith("'")) ||
      (trimmed.startsWith('"') && trimmed.endsWith('"')))
  ) {
    return trimmed.slice(1, -1)
  }
  return trimmed
}

function getReferencedAssetNames(yamlText = '') {
  const names = []
  const urlPattern = /^\s*-\s+url:\s*(.+?)\s*$/gm
  let match

  while ((match = urlPattern.exec(yamlText)) !== null) {
    const rawValue = normalizeYamlScalar(match[1])
    const withoutQuery = rawValue.split(/[?#]/, 1)[0]
    const assetName = path.posix.basename(withoutQuery.replaceAll('\\', '/'))
    if (assetName) names.push(assetName)
  }

  return [...new Set(names)]
}

function assertUniqueReleaseAssetNames(files) {
  const pathsByName = new Map()

  for (const filePath of files) {
    const name = path.basename(filePath)
    const existing = pathsByName.get(name) || []
    existing.push(filePath)
    pathsByName.set(name, existing)
  }

  const duplicates = [...pathsByName.entries()].filter(([, paths]) => paths.length > 1)
  if (duplicates.length === 0) return

  const details = duplicates
    .map(([name, paths]) => `${name}: ${paths.map((item) => path.relative(rootDir, item)).join(', ')}`)
    .join('\n')
  throw new Error(`Duplicate GitHub Release asset names detected:\n${details}`)
}

async function verifyMetadataFile(metadataPath) {
  const directory = path.dirname(metadataPath)
  const siblingNames = new Set((await fs.readdir(directory)).map((name) => path.basename(name)))
  const yamlText = await fs.readFile(metadataPath, 'utf8')
  const referencedNames = getReferencedAssetNames(yamlText)

  if (referencedNames.length === 0) {
    throw new Error(`${path.relative(rootDir, metadataPath)} does not reference any release assets`)
  }

  const missingNames = referencedNames.filter((name) => !siblingNames.has(name))
  if (missingNames.length > 0) {
    throw new Error(
      `${path.relative(rootDir, metadataPath)} references missing assets: ${missingNames.join(', ')}`
    )
  }

  if (path.basename(metadataPath) === 'latest-mac.yml') {
    const hasZip = [...siblingNames].some((name) => name.endsWith('-mac.zip'))
    const hasDmg = [...siblingNames].some((name) => name.endsWith('-mac.dmg'))
    if (!hasZip || !hasDmg) {
      throw new Error('macOS release must include both a *-mac.zip updater payload and a *-mac.dmg manual installer')
    }
  }

  console.log(
    `[release-assets] ${path.relative(rootDir, metadataPath)} -> ${referencedNames.join(', ')}`
  )
}

async function main() {
  const files = await walkFiles(rootDir)
  assertUniqueReleaseAssetNames(files)

  const metadataFiles = files.filter((filePath) => /^latest.*\.ya?ml$/i.test(path.basename(filePath)))
  if (metadataFiles.length === 0) {
    throw new Error(`No latest*.yml update metadata found in ${rootDir}`)
  }

  for (const metadataPath of metadataFiles) {
    await verifyMetadataFile(metadataPath)
  }

  console.log(`[release-assets] verified ${metadataFiles.length} metadata file(s)`)
}

main().catch((error) => {
  console.error(`[release-assets] verification failed: ${error?.message || error}`)
  process.exitCode = 1
})
