import assert from 'node:assert/strict'
import { verifyRemoteFileInfo } from '../main/core/webdavVerification.js'

const content = Buffer.from('synthetic-sqlite-snapshot')
const path = '/anywhere/conversation-fixture.db'

const verified = verifyRemoteFileInfo({ type: 'file', size: content.length }, content)
assert.deepEqual(verified, { ok: true, bytes: content.length, remoteSize: content.length })

assert.throws(
  () => verifyRemoteFileInfo({ type: 'file', size: content.length + 1 }, content),
  /webdav_uploaded_file_size_mismatch/
)

assert.throws(
  () => verifyRemoteFileInfo({ type: 'directory', size: 0 }, content),
  /webdav_uploaded_file_missing/
)

assert.throws(
  () => verifyRemoteFileInfo(null, content),
  /webdav_uploaded_file_missing/
)

console.log(JSON.stringify({ ok: true, suite: 'webdav-write-verification' }))
