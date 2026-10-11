import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { createRemoteUploadManager } from '../main/core/remote/uploadManager.js'

const DEVICE = 'device-upload-fixture-0001'
const OTHER_DEVICE = 'device-upload-fixture-0002'
const REQUEST = 'request-upload-fixture-0001'
const WINDOW = 'window-upload-fixture'
const digest = (value) => crypto.createHash('sha256').update(value).digest('base64url')
const encoded = (value) => Buffer.from(value).toString('base64url')
let beginSequence = 0

async function begin(manager, data, overrides = {}, deviceId = DEVICE, requestId = '') {
  beginSequence += 1
  return manager.begin({
    deviceId,
    requestId: requestId || `request-upload-begin-${String(beginSequence).padStart(4, '0')}`,
    params: {
      name: 'fixture.txt',
      type: 'text/plain',
      size: data.length,
      sha256: digest(data),
      ...overrides
    }
  })
}

async function main() {
  const sandbox = await fs.mkdtemp(path.join(os.tmpdir(), 'anywhere-remote-upload-test-'))
  try {
    let clock = Date.now()
    const root = path.join(sandbox, 'uploads')
    const manager = createRemoteUploadManager({ tempRoot: root, now: () => clock, ttlMs: 1000, cleanupIntervalMs: 60_000 })
    const payload = Buffer.from('encrypted upload fixture')
    const started = await begin(manager, payload)
    assert.equal(started.upload.state, 'uploading')
    assert.equal(started.upload.maxChunkBytes, 128 * 1024)

    const duplicateBegin = await manager.begin({
      deviceId: DEVICE,
      requestId: 'request-upload-begin-0001',
      params: { name: 'fixture.txt', type: 'text/plain', size: payload.length, sha256: digest(payload) }
    })
    assert.equal(duplicateBegin.duplicate, true)
    assert.equal(duplicateBegin.upload.uploadId, started.upload.uploadId)
    await assert.rejects(manager.begin({
      deviceId: DEVICE,
      requestId: 'request-upload-begin-0001',
      params: { name: 'changed.txt', type: 'text/plain', size: payload.length, sha256: digest(payload) }
    }), { code: 'remote_request_id_conflict' })
    assert.equal(JSON.stringify(started).includes(root), false, 'temporary paths must never cross the API boundary')

    await assert.rejects(manager.chunk({
      deviceId: OTHER_DEVICE,
      params: { uploadId: started.upload.uploadId, index: 0, data: encoded(payload) }
    }), { code: 'remote_upload_not_found' })
    await assert.rejects(manager.chunk({
      deviceId: DEVICE,
      params: { uploadId: started.upload.uploadId, index: 1, data: encoded(payload) }
    }), { code: 'remote_upload_chunk_order_invalid' })

    const first = payload.subarray(0, 8)
    const second = payload.subarray(8)
    const progress = await manager.chunk({
      deviceId: DEVICE,
      params: { uploadId: started.upload.uploadId, index: 0, data: encoded(first) }
    })
    assert.equal(progress.upload.receivedBytes, first.length)
    assert.equal(progress.upload.nextChunkIndex, 1)

    const duplicateChunk = await manager.chunk({
      deviceId: DEVICE,
      params: { uploadId: started.upload.uploadId, index: 0, data: encoded(first) }
    })
    assert.equal(duplicateChunk.duplicate, true, 'lost chunk acknowledgements may be retried idempotently')
    assert.equal(duplicateChunk.upload.receivedBytes, first.length)
    await assert.rejects(manager.chunk({
      deviceId: DEVICE,
      params: { uploadId: started.upload.uploadId, index: 0, data: encoded(Buffer.alloc(first.length, 1)) }
    }), { code: 'remote_upload_chunk_conflict' })
    await manager.chunk({
      deviceId: DEVICE,
      params: { uploadId: started.upload.uploadId, index: 1, data: encoded(second) }
    })
    const completed = await manager.complete({ deviceId: DEVICE, params: { uploadId: started.upload.uploadId } })
    assert.equal(completed.upload.state, 'completed')
    assert.equal((await manager.complete({ deviceId: DEVICE, params: { uploadId: started.upload.uploadId } })).duplicate, true)

    await assert.rejects(manager.consumeForRenderer({
      windowRef: WINDOW,
      requestId: REQUEST,
      uploadId: started.upload.uploadId
    }), { code: 'remote_upload_not_authorized' })
    const descriptors = await manager.authorizeForRequest({
      deviceId: DEVICE,
      requestId: REQUEST,
      windowRef: WINDOW,
      uploadIds: [started.upload.uploadId]
    })
    assert.deepEqual(descriptors, [{ uploadId: started.upload.uploadId, name: 'fixture.txt', type: 'text/plain', size: payload.length }])
    await assert.rejects(manager.consumeForRenderer({
      windowRef: 'window-spoof',
      requestId: REQUEST,
      uploadId: started.upload.uploadId
    }), { code: 'remote_upload_not_authorized' })
    const consumed = await manager.consumeForRenderer({
      windowRef: WINDOW,
      requestId: REQUEST,
      uploadId: started.upload.uploadId
    })
    assert.equal(consumed.base64, payload.toString('base64'))
    assert.equal(Object.hasOwn(consumed, 'path'), false)
    assert.equal(Object.hasOwn(consumed, 'url'), false)
    await assert.rejects(manager.consumeForRenderer({
      windowRef: WINDOW,
      requestId: REQUEST,
      uploadId: started.upload.uploadId
    }), { code: 'remote_upload_not_authorized' })

    await assert.rejects(begin(manager, payload, { name: '../escape.txt' }), { code: 'remote_upload_name_invalid' })
    await assert.rejects(begin(manager, payload, { name: 'C:\\escape.txt' }), { code: 'remote_upload_name_invalid' })
    await assert.rejects(begin(manager, payload, { sha256: 'not-a-digest' }), { code: 'remote_invalid_base64url' })

    await assert.rejects(begin(manager, Buffer.alloc(0)), { code: 'remote_upload_size_invalid' })

    const tooMuch = await begin(manager, Buffer.from('small'), { size: 4 })
    await assert.rejects(manager.chunk({
      deviceId: DEVICE,
      params: { uploadId: tooMuch.upload.uploadId, index: 0, data: encoded('12345') }
    }), { code: 'remote_upload_size_mismatch' })
    assert.equal(manager.getUpload(tooMuch.upload.uploadId), null, 'size mismatch must delete partial state')

    const corrupt = await begin(manager, Buffer.from('expected'))
    await manager.chunk({
      deviceId: DEVICE,
      params: { uploadId: corrupt.upload.uploadId, index: 0, data: encoded('tampered') }
    })
    await assert.rejects(manager.complete({ deviceId: DEVICE, params: { uploadId: corrupt.upload.uploadId } }), {
      code: 'remote_upload_integrity_failed'
    })
    assert.equal(manager.getUpload(corrupt.upload.uploadId), null, 'integrity failure must delete the temporary file')

    const expiringData = Buffer.from('expires')
    const expiring = await begin(manager, expiringData)
    clock += 1001
    const expired = await manager.cleanupExpired()
    assert.equal(expired.removed, 1)
    assert.equal(manager.getUpload(expiring.upload.uploadId), null)

    const revokeData = Buffer.from('revoke')
    const revokeOne = await begin(manager, revokeData)
    const revokeTwo = await begin(manager, revokeData)
    assert.equal((await manager.cleanupDevice(DEVICE)).removed, 2)
    assert.equal(manager.getUpload(revokeOne.upload.uploadId), null)
    assert.equal(manager.getUpload(revokeTwo.upload.uploadId), null)

    const quotaRoot = path.join(sandbox, 'quota')
    const quotaManager = createRemoteUploadManager({
      tempRoot: quotaRoot,
      maxFileBytes: 8,
      maxDeviceBytes: 10,
      maxConcurrent: 2,
      maxRetained: 3,
      maxChunkBytes: 4,
      ttlMs: 1000
    })
    const four = Buffer.from('1234')
    await begin(quotaManager, four, {}, DEVICE)
    await begin(quotaManager, four, {}, DEVICE)
    await assert.rejects(begin(quotaManager, Buffer.from('1'), {}, DEVICE), { code: 'remote_upload_concurrency_exceeded' })
    await assert.rejects(begin(quotaManager, Buffer.alloc(9), {}, OTHER_DEVICE), { code: 'remote_upload_size_invalid' })
    const otherSix = await begin(quotaManager, Buffer.from('123456'), {}, OTHER_DEVICE)
    await assert.rejects(begin(quotaManager, Buffer.from('12345'), {}, OTHER_DEVICE), { code: 'remote_upload_quota_exceeded' })
    await assert.rejects(quotaManager.chunk({
      deviceId: OTHER_DEVICE,
      params: { uploadId: otherSix.upload.uploadId, index: 0, data: encoded('12345') }
    }), { code: 'remote_invalid_base64url' })
    await quotaManager.stop()
    await assert.rejects(fs.stat(quotaRoot), { code: 'ENOENT' })

    await manager.stop()
    await assert.rejects(fs.stat(root), { code: 'ENOENT' })
    await assert.rejects(begin(manager, Buffer.from('stopped')), { code: 'remote_gateway_stopped' })
    await manager.initialize()
    const restarted = await begin(manager, Buffer.from('restarted'))
    assert.equal(restarted.upload.state, 'uploading')
    await manager.stop()
    console.log(JSON.stringify({ ok: true, suite: 'remote-upload-manager' }))
  } finally {
    await fs.rm(sandbox, { recursive: true, force: true })
  }
}

main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
