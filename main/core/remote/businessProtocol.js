import crypto from 'node:crypto'
import contract from '../../../packages/remote-contract/index.cjs'
import {normalizeIdentifier, remoteError} from './protocol.js'

const RETENTION = 512
const safeId = (value, field = 'conversationId') => normalizeIdentifier(value, field, {minLength: 16, maxLength: 160})
const allowed = (value, keys) => {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(key => !keys.includes(key))) throw remoteError('remote_parameter_unknown')
}

/** Stable business facade. The legacy gateway/Renderer remain implementation details. */
export function createBusinessProtocol({readService, getManager}) {
  const serverEpoch = crypto.randomUUID()
  let sequence = 0
  const journal = []
  const negotiated = new WeakSet()
  const cursor = at => `${serverEpoch}:${at}`
  function notify(event, payload = {}, deviceId = '') {
    if (!event.startsWith('conversation.') && !event.startsWith('assistant.')) return
    const conversationId = typeof payload.conversationId === 'string' ? payload.conversationId : null
    journal.push({sequence: ++sequence, conversationId, resources: ['conversation', 'runtime', 'messages', 'tasks'], deviceId})
    if (journal.length > RETENTION) journal.shift()
  }
  function available() {return Boolean(readService && typeof getManager()?.runtimeSnapshot === 'function')}
  function negotiate(context, params) {
    allowed(params, ['versions'])
    if (!Array.isArray(params.versions) || !params.versions.some(version => version?.major === 1 && Number.isInteger(version.minor) && version.minor >= 0)) throw remoteError('remote_contract_version_unsupported')
    negotiated.add(context)
    return contract.validateNegotiation({selected: {...contract.VERSION}, capabilities: available() ? [...contract.CAPABILITIES] : [], serverEpoch, limits: {eventRetention: RETENTION, operationRetentionMs: 1800000}})
  }
  function authorize(context) {
    if (!negotiated.has(context)) throw remoteError('remote_contract_negotiation_required')
    if (!available()) throw remoteError('remote_method_unavailable')
  }
  async function view(context, params) {
    authorize(context)
    allowed(params, ['conversationId', 'beforeUiOrder', 'pageSize'])
    const conversationId = safeId(params.conversationId)
    // Capture cursor BEFORE async reads; all changes during the read remain
    // available for catch-up. A view is not a cross-store transaction.
    const at = sequence
    const page = await readService.listMessages({deviceId: context.device.deviceId, params})
    const runtime = getManager().runtimeSnapshot({deviceId: context.device.deviceId, params: {conversationId}})
    return contract.validateView({schemaVersion: '1.0', serverEpoch, sequence: at, cursor: cursor(at), page, runtime})
  }
  function changes(context, params) {
    authorize(context)
    allowed(params, ['conversationId', 'cursor'])
    const conversationId = safeId(params.conversationId)
    const raw = typeof params.cursor === 'string' ? params.cursor : ''
    const prefix = `${serverEpoch}:`
    const suffix = raw.startsWith(prefix) ? raw.slice(prefix.length) : ''
    const after = /^\d{1,16}$/.test(suffix) ? Number(suffix) : -1
    const resyncRequired = !Number.isSafeInteger(after) || after < 0 || after > sequence || after < (journal[0]?.sequence ?? sequence + 1) - 1
    const events = resyncRequired ? [] : journal.filter(entry => entry.sequence > after &&
      (!entry.deviceId || entry.deviceId === context.device.deviceId) &&
      (!entry.conversationId || entry.conversationId === conversationId)).map(entry => ({sequence: entry.sequence, conversationId: entry.conversationId, resources: entry.resources}))
    return contract.validateChanges({serverEpoch, cursor: cursor(sequence), sequence, resyncRequired, hasMore: false, events})
  }
  function operation(context, params) {
    authorize(context)
    allowed(params, ['operationId'])
    const operationId = normalizeIdentifier(params.operationId, 'operationId', {minLength: 8, maxLength: 160})
    const progress = getManager().getRequest({deviceId: context.device.deviceId, params: {requestId: operationId}})
    const state = progress.terminal ? progress.event.endsWith('.failed') ? 'failed' : progress.event.endsWith('.cancelled') ? 'cancelled' : 'succeeded'
      : progress.event === 'conversation.queue.pending' ? 'queued' : progress.event.includes('pending') || progress.event.includes('accepted') ? 'accepted' : 'running'
    return contract.validateOperation({operationId, conversationId: progress.conversationId, state, terminal: progress.terminal, progress})
  }
  return {negotiate, view, changes, operation, notify, available}
}
