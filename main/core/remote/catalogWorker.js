import {parentPort} from 'node:worker_threads'
import {listLocalConversations} from '../conversationStore.js'

// Main supplies a configured directory, never a path from remote RPC params.
// No writer lease, snapshot writes, migrations or projects.yaml updates here.
parentPort.once('message', async directory => {
  try {
    const value = await listLocalConversations(directory, {readOnly: true})
    parentPort.postMessage({ok: true, value})
  } catch {
    parentPort.postMessage({ok: false})
  }
  parentPort.close()
})
