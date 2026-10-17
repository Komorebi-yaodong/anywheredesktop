import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { createRemoteConversationMediaService } from '../main/core/remote/conversationMedia.js'

const root = await fs.mkdtemp(path.join(os.tmpdir(), 'anywhere-conversation-media-'))
const mediaPath = path.join(root, 'fixture.png')
const deviceId = 'device-media-fixture-0001'
const otherDeviceId = 'device-media-fixture-0002'
const conversationId = 'conversation-media-fixture-0001'
const otherConversationId = 'conversation-media-fixture-0002'

try {
  const fixture = Buffer.from('synthetic-png-media-fixture')
  await fs.writeFile(mediaPath, fixture)
  const service = createRemoteConversationMediaService()
  const reference = service.register({ deviceId, conversationId, source: mediaPath })
  assert.match(reference.mediaId, /^[A-Za-z0-9_-]{16,160}$/)
  assert.equal(reference.uri.includes(root), false)
  assert.equal(reference.uri.includes('fixture.png'), false)
  assert.equal(reference.mimeType, 'image/png')
  const repeated = service.register({ deviceId, conversationId, source: mediaPath })
  assert.equal(repeated.mediaId, reference.mediaId)

  const chunk = await service.get({
    deviceId,
    params: { conversationId, mediaId: reference.mediaId, offset: 0, length: 96 * 1024 }
  })
  assert.equal(chunk.mimeType, 'image/png')
  assert.equal(Buffer.from(chunk.data, 'base64url').toString(), fixture.toString())
  assert.equal(JSON.stringify(chunk).includes(root), false)
  await assert.rejects(service.get({
    deviceId: otherDeviceId,
    params: { conversationId, mediaId: reference.mediaId, offset: 0, length: 8 }
  }), { code: 'remote_media_not_found' })
  await assert.rejects(service.get({
    deviceId,
    params: { conversationId: otherConversationId, mediaId: reference.mediaId, offset: 0, length: 8 }
  }), { code: 'remote_media_not_found' })
  await assert.rejects(service.get({
    deviceId,
    params: { conversationId, mediaId: reference.mediaId, offset: 0, length: 128 * 1024 }
  }), { code: 'remote_media_range_invalid' })
  console.log(JSON.stringify({ ok: true, suite: 'conversation-media' }))
} finally {
  await fs.rm(root, { recursive: true, force: true })
}
