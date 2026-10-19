import assert from 'node:assert/strict'
import fs from 'node:fs/promises'

const source = await fs.readFile(new URL('../render/main/App.vue', import.meta.url), 'utf8')

assert.match(source, /left: 'Anywhere Desktop', leftUrl: 'https:\/\/github\.com\/Komorebi-yaodong\/anywheredesktop'/)
assert.match(source, /left: 'Anywhere Mobile', leftUrl: 'https:\/\/github\.com\/Komorebi-yaodong\/anywhere-mobile', right: '', rightUrl: ''/)
assert.match(source, /item\.rightUrl \? ` <a href="\$\{item\.rightUrl\}"/)

console.log(JSON.stringify({ ok: true, suite: 'public-project-links' }))
