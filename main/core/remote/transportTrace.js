// TEMPORARY: remove after field root-cause verification, including export/tests.
import {performance} from 'node:perf_hooks'
const events = new Set(['connection', 'input_progress', 'frame', 'decrypted', 'rejected', 'upload_start', 'upload_done', 'upload_failed', 'ack_submit', 'ack_flushed', 'send_submit', 'send_flushed', 'send_failed', 'ping_received', 'pong_received', 'pong_submitted', 'close', 'socket_error', 'loop_lag'])
const methods = new Set(['attachment.begin', 'attachment.chunk', 'attachment.complete', 'attachment.abort', 'remote.ping', 'other'])
const codes = new Set(['remote_payload_size_invalid', 'remote_frame_auth_failed', 'remote_frame_out_of_order', 'remote_frame_replayed', 'remote_upload_write_failed', 'remote_upload_busy', 'remote_upload_chunk_order_invalid', 'remote_upload_size_mismatch', 'remote_upload_integrity_failed', 'remote_upload_unavailable', 'remote_upload_state_invalid'])
export function createTransportTrace({now = () => performance.now()} = {}) {
  const started = now(), rows = []
  let serial = 0, timer = null
  function record(event, fields = {}) {
    if (!events.has(event)) return
    const row = {atMs: Math.max(0, Math.round(now() - started)), event}
    for (const key of ['generation', 'bytes', 'totalBytes', 'elapsedMs', 'bufferedBytes', 'sequence', 'closeCode']) {
      const n = fields[key]
      if (Number.isSafeInteger(n) && n >= 0) row[key] = n
    }
    if (fields.method) row.method = methods.has(fields.method) ? fields.method : 'other'
    if (fields.code) row.code = codes.has(fields.code) ? fields.code : 'other'
    rows.push(row); if (rows.length > 512) rows.shift()
  }
  return {
    record,
    nextGeneration: () => ++serial,
    snapshot: () => ({schema: 1, side: 'desktop', rows: rows.map(row => ({...row}))}),
    start() {
      if (timer) return
      let expected = now() + 1000
      timer = setInterval(() => {const current = now(); const lag = Math.max(0, Math.round(current - expected)); expected = current + 1000; if (lag >= 100) record('loop_lag', {elapsedMs: lag})}, 1000)
      timer.unref?.()
    },
    stop() {if (timer) clearInterval(timer); timer = null}
  }
}
