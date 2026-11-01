import {parentPort} from 'node:worker_threads'
import {openConversation, loadRemoteConversationPage} from '../conversationStore.js'
import {createRemoteConversationMediaService} from './conversationMedia.js'

// Only Main supplies the configured directory/operation. No SQLite writes,
// migrations, lease acquisition or project-index updates are allowed here.
parentPort.once('message', async ({operation, params}) => {
  try {
    if (!['open', 'page'].includes(operation)) throw new Error('remote_read_operation_invalid')
    const media = []
    const registry = createRemoteConversationMediaService()
    const value = operation === 'open'
      ? await openConversation({...params, remoteReadOnly: true})
      : await loadRemoteConversationPage({...params, registerMedia: source => {
        const ref = registry.register({deviceId: 'worker-media-device', conversationId: params.conversationId, source})
        if (ref && !media.some(item => item.uri === ref.uri)) media.push({uri: ref.uri, source})
        return ref
      }})
    parentPort.postMessage({ok: true, value, media})
  } catch (error) {
    const code = ['conversation_not_found', 'conversation_id_required', 'conversation_local_dir_required'].includes(error?.message)
      ? error.message : 'remote_conversation_read_failed'
    parentPort.postMessage({ok: false, code})
  }
  parentPort.close()
})
