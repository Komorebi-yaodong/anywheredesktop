import assert from 'node:assert/strict'
import {
  DEFAULT_REMOTE_SETTINGS,
  mergeLocalRemoteSettings,
  preserveLocalRemoteSettings,
  splitLocalRemoteSettings
} from '../main/core/remote/configLocal.js'

function run() {
  const localRemote = {
    enabled: true,
    host: '127.0.0.1',
    port: 19443,
    publicEndpoint: 'https://remote.example.test'
  }
  const fullConfig = {
    language: 'zh',
    themeMode: 'system',
    remote: localRemote,
    webdav: { url: 'https://dav.example.test', localChatPath: 'E:/Chats' }
  }

  const split = splitLocalRemoteSettings(fullConfig)
  assert.equal(Object.hasOwn(split.sharedConfig, 'remote'), false)
  assert.deepEqual(split.remote, localRemote)
  assert.equal(split.sharedConfig.language, 'zh')

  const merged = mergeLocalRemoteSettings(
    { ...split.sharedConfig, remote: { enabled: false, port: 28888 } },
    { remote: split.remote }
  )
  assert.deepEqual(merged.remote, localRemote)
  assert.equal(merged.language, 'zh')

  const preserved = preserveLocalRemoteSettings(
    {
      language: 'en',
      remote: { enabled: false, host: '0.0.0.0', port: 39999, publicEndpoint: '' }
    },
    merged
  )
  assert.equal(preserved.language, 'en')
  assert.deepEqual(preserved.remote, localRemote)

  const invalidLocal = mergeLocalRemoteSettings(
    { language: 'zh' },
    { remote: { enabled: true, publicEndpoint: 'http://plaintext.example.test' } }
  )
  assert.deepEqual(invalidLocal.remote, DEFAULT_REMOTE_SETTINGS)

  const disabledSplit = splitLocalRemoteSettings({ language: 'zh' })
  assert.deepEqual(disabledSplit.remote, DEFAULT_REMOTE_SETTINGS)
  assert.equal(Object.hasOwn(disabledSplit.sharedConfig, 'remote'), false)

  console.log(JSON.stringify({ ok: true, suite: 'remote-config-local' }))
}

run()
