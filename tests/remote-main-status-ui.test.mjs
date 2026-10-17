import assert from 'node:assert/strict'
import fs from 'node:fs/promises'

const source = await fs.readFile(new URL('../render/main/App.vue', import.meta.url), 'utf8')
assert.match(source, /const remoteStatus = ref\(\{ devicesOnline: 0 \}\)/)
assert.match(source, /hasOnlineMobile = computed\(\(\) => Number\(remoteStatus\.value\?\.devicesOnline\) > 0\)/)
assert.match(source, /window\.api\.getRemoteStatus\(\)/)
assert.match(source, /window\.api\?\.onRemoteStatusChanged/)
assert.match(source, /remote-online/)
assert.match(source, /:is-dot="hasOnlineMobile"/)
console.log('Remote main status UI regression passed: online Mobile state highlights the Remote icon')
