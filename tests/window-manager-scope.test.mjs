import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const source = await fs.readFile(path.join(root, 'main', 'windowManager.js'), 'utf8')

const displayNameStart = source.indexOf('function resolvePromptDisplayName')
const normalizerStart = source.indexOf('function normalizeConversationMetadataId')
const metadataStart = source.indexOf('function buildWindowMetadata')
assert(displayNameStart >= 0 && normalizerStart > displayNameStart && metadataStart > normalizerStart)

const displayNameBlock = source.slice(displayNameStart, normalizerStart)
assert.match(displayNameBlock, /return 'AI'\s*\n\}/, 'resolvePromptDisplayName must close before metadata normalizer declaration')
assert.match(source.slice(normalizerStart, metadataStart), /^function normalizeConversationMetadataId[\s\S]*?\n\}/, 'metadata normalizer must exist at module scope')
assert.match(source, /conversationId:\s*normalizeConversationMetadataId\(/)
assert.match(source, /const conversationId = normalizeConversationMetadataId\(source\.conversationId\)/)

assert.match(source, /const conversationDirectoryStore = new Map\(\)/)
const metadataBuilder = source.slice(metadataStart, source.indexOf('function resolveWindowConfig', metadataStart))
const metadataUpdate = source.slice(source.indexOf('export function updateConversationWindowMetadata'), source.indexOf('export function getWindowRefByWebContentsId'))
assert.doesNotMatch(metadataBuilder, /dirPath:/, 'private conversation locations cannot enter listWindows or remote metadata')
assert.doesNotMatch(metadataUpdate.slice(metadataUpdate.indexOf('const next =')), /dirPath:/, 'window-status updates cannot leak storage paths into public metadata')
assert.match(metadataUpdate, /conversationDirectoryStore\.set/)

console.log('Desktop window manager scope regression passed')
