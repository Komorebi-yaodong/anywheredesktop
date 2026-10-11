import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import yaml from 'js-yaml'

const root = new URL('../', import.meta.url)
const [builderSource, packageSource] = await Promise.all([
  fs.readFile(new URL('electron-builder.yml', root), 'utf8'),
  fs.readFile(new URL('package.json', root), 'utf8')
])

const builderConfig = yaml.load(builderSource)
const packageJson = JSON.parse(packageSource)
const files = Array.isArray(builderConfig?.files) ? builderConfig.files : []

const requiredExclusions = [
  '!tests/**',
  '!coverage/**',
  '!{jest.config.*,vitest.config.*,playwright.config.*}',
  '!node_modules/{fluent-ffmpeg,pngjs}/coverage/**',
  '!node_modules/zod/src/**/tests/**'
]

for (const exclusion of requiredExclusions) {
  assert.ok(files.includes(exclusion), `missing package exclusion: ${exclusion}`)
}

assert.equal(typeof packageJson?.scripts?.['test:remote'], 'string', true, 'source test scripts must remain available')
assert.equal(typeof packageJson?.scripts?.['test:package-contents'], 'string', true, 'package-content regression must remain runnable')

console.log(JSON.stringify({ ok: true, suite: 'package-contents', exclusions: requiredExclusions.length }))
