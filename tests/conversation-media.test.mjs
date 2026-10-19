import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { createRemoteConversationMediaService, normalizeLocalMediaPath } from '../main/core/remote/conversationMedia.js'

const root = await fs.mkdtemp(path.join(os.tmpdir(), 'anywhere-conversation-media-'))
const mediaPath = path.join(root, 'fixture.png')
const deviceId = 'device-media-fixture-0001'
const otherDeviceId = 'device-media-fixture-0002'
const conversationId = 'conversation-media-fixture-0001'
const otherConversationId = 'conversation-media-fixture-0002'


assert.equal(normalizeLocalMediaPath('C:\\Fixture\\image.png'), 'C:\\Fixture\\image.png')
assert.equal(normalizeLocalMediaPath('file:///C:/Fixture/image.png'), 'C:/Fixture/image.png')
assert.equal(normalizeLocalMediaPath('file://C:/Fixture/image.png'), 'C:/Fixture/image.png')
assert.equal(normalizeLocalMediaPath('file:///Users/fixture/image.png'), '/Users/fixture/image.png')
assert.equal(normalizeLocalMediaPath('/home/fixture/audio.mp3'), '/home/fixture/audio.mp3')
assert.equal(normalizeLocalMediaPath('/tmp/fixture/video.mp4'), '/tmp/fixture/video.mp4')
assert.equal(normalizeLocalMediaPath('https://media.example/fixture.png'), '')
assert.equal(normalizeLocalMediaPath('http://media.example/fixture.png'), '')
assert.equal(normalizeLocalMediaPath('file://server/share/fixture.png'), '')


try {
  const fixture = Buffer.from('synthetic-png-media-fixture')
  await fs.writeFile(mediaPath, fixture)
  const service = createRemoteConversationMediaService()

  assert.equal(service.register({ deviceId, conversationId, source: 'https://media.example/fixture.png' }), null)
  assert.equal(service.register({ deviceId, conversationId, source: 'http://media.example/fixture.png' }), null)
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

  // Inline base64 images stored in SQLite must still be previewable without
  // sending the base64 payload into the message DTO.
  const inlineBytes = Buffer.from('synthetic-inline-image-fixture')
  const inlineSource = `data:image/png;base64,${inlineBytes.toString('base64')}`
  const inline = service.register({ deviceId, conversationId, source: inlineSource })
  assert.match(inline.mediaId, /^[A-Za-z0-9_-]{16,160}$/)
  assert.equal(inline.mimeType, 'image/png')
  assert.equal(inline.uri.includes('base64'), false)
  const inlineChunk = await service.get({
    deviceId,
    params: { conversationId, mediaId: inline.mediaId, offset: 0, length: 96 * 1024 }
  })
  assert.equal(Buffer.from(inlineChunk.data, 'base64url').toString(), inlineBytes.toString())
  assert.equal(service.register({ deviceId, conversationId, source: inlineSource }).mediaId, inline.mediaId)
  console.log(JSON.stringify({ ok: true, suite: 'conversation-media' }))
} finally {
  await fs.rm(root, { recursive: true, force: true })
}
