import crypto from 'node:crypto'
import contract from '../../../packages/remote-contract/index.cjs'

import {structuredPage} from './contentBlocks.js'
import {normalizeIdentifier, remoteError} from './protocol.js'

const routes = contract.routes

const RETENTION = 512
const safeId = (value, field = 'conversationId') => normalizeIdentifier(value, field, {minLength: 16, maxLength: 160})
const allowed = (value, keys) => {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(key => !keys.includes(key))) throw remoteError('remote_parameter_unknown')
}

/** Stable business facade. The legacy gateway/Renderer remain implementation details. */
export function createBusinessProtocol({readService, getManager, operations = null, dispatch = null}) {
  const serverEpoch = crypto.randomUUID()
  let sequence = 0
  const journal = []
  const negotiated = new WeakSet()
  const selectedMinor = new WeakMap()
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

    selectedMinor.set(context, params.versions.some(version => version?.major === 1 && version.minor >= 1) ? 1 : 0)
    return contract.validateNegotiation({selected: {major: 1, minor: selectedMinor.get(context)}, capabilities: available() ? [...contract.CAPABILITIES, ...(operations && dispatch && selectedMinor.get(context) >= 1 ? ['resource.read.v1', 'command.durable.v1', 'message.blocks.v1'] : [])] : [], serverEpoch, limits: {eventRetention: RETENTION, operationRetentionMs: 1800000, ...(operations && selectedMinor.get(context) >= 1 ? {durableOperations: operations.limits} : {})}})
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
    const value = contract.validateView({schemaVersion: '1.0', serverEpoch, sequence: at, cursor: cursor(at), page, runtime})
    return selectedMinor.get(context) >= 1 ? {...value, page: structuredPage(page)} : value
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
  function supports(context, method) {
    if (!context.capabilities?.includes(method)) throw remoteError('remote_method_unavailable')
  }
  async function resource(context, requestId, params) {
    authorize(context)
    allowed(params, ['resource', 'params'])
    if (selectedMinor.get(context) < 1 || !routes.queries.includes(params.resource)) throw remoteError('remote_resource_unsupported')
    supports(context, params.resource)
    let value = await dispatch(context, requestId, params.resource, params.params || {})
    if (params.resource === 'conversation.config.get') {
      const deadline = Date.now() + 55000
      while (Date.now() < deadline) {
        const progress = getManager().getRequest({deviceId: context.device.deviceId, params: {requestId}})
        if (progress.terminal) {
          if (progress.event.endsWith('.failed')) throw remoteError(progress.result?.code || 'remote_resource_read_failed')
          value = progress.result
          break
        }
        await new Promise(resolve => setTimeout(resolve, 50))
      }
      if (!value?.config) throw remoteError('remote_resource_read_timeout')
    }
    return {schemaVersion: '1.0', resource: params.resource, value: params.resource === 'conversation.messages.list' ? structuredPage(value) : value}
  }
  async function transfer(context, requestId, params) {
    authorize(context)
    allowed(params, ['method', 'params'])
    if (selectedMinor.get(context) < 1 || !routes.transfers.includes(params.method)) throw remoteError('remote_transfer_unsupported')
    supports(context, params.method)
    return dispatch(context, requestId, params.method, params.params || {})
  }

  async function command(context, params) {
    authorize(context)
    allowed(params, ['commandId', 'issuedAt', 'method', 'params', 'preconditions'])
    if (selectedMinor.get(context) < 1 || !operations || !routes.commands.includes(params.method)) throw remoteError('remote_command_unsupported')
    supports(context, params.method)
    const commandId = normalizeIdentifier(params.commandId, 'commandId', {minLength: 8, maxLength: 160})

    const timestamp = /^command-(\d{13})-[A-Za-z0-9_-]{16,}$/.exec(commandId)
    if (!timestamp || Number(timestamp[1]) !== params.issuedAt) throw remoteError('remote_command_id_invalid')
    const body = params.params && typeof params.params === 'object' && !Array.isArray(params.params) ? params.params : {}
    return operations.execute({deviceId: context.device.deviceId, commandId, issuedAt: params.issuedAt, method: params.method, params: body}, async () => {
      let expectedEpoch = params.preconditions?.controlEpoch
      let freshWriter = null
      const check = () => {
        if (routes.controlRequired.includes(params.method) && body.conversationId) {
          const session = getManager().getSession?.(body.conversationId)
          const runtime = getManager().runtimeSnapshot({deviceId: context.device.deviceId, params: {conversationId: body.conversationId}})
          // Closed history has no writer yet. Creating a new hidden writer for
          // the same device is allowed; an existing/foreign writer is not.
          if (expectedEpoch === 'window-none' && session?.hidden && !session.mobileControlled) freshWriter = session.windowRef
          if (freshWriter && session?.windowRef === freshWriter && session.hidden && (!session.mobileControlled || runtime.control.owner === 'this_device')) {
            expectedEpoch = runtime.control.epoch
            if (runtime.control.owner === 'this_device') freshWriter = null
          }
          if (typeof expectedEpoch !== 'string' || expectedEpoch !== runtime.control.epoch) throw remoteError('remote_control_epoch_conflict')
        }
      }
      check()
      return getManager().withCommandGuard(check, () => dispatch(context, commandId, params.method, body))
    }, routes.async.includes(params.method))
  }
  async function operationStatus(context, params) {
    authorize(context)
    allowed(params, ['operationId'])
    const operationId = normalizeIdentifier(params.operationId, 'operationId', {minLength: 8, maxLength: 160})
    if (selectedMinor.get(context) < 1 || !operations) throw remoteError('remote_method_unavailable')
    let record = await operations.get(context.device.deviceId, operationId)
    if (!record.terminal) {
      try {
        const progress = getManager().getRequest({deviceId: context.device.deviceId, params: {requestId: operationId}})
        await operations.update(context.device.deviceId, operationId, progress)
        record = await operations.get(context.device.deviceId, operationId)
      } catch (error) {
        if (!['remote_request_not_found', 'remote_request_unknown'].includes(error.code)) throw error
        // A missing in-memory request after dispatch cannot be treated as idle.
        await operations.interrupt(context.device.deviceId, operationId)
        record = await operations.get(context.device.deviceId, operationId)
      }
    }
    return record
  }

  return {negotiate, view, changes, operation, notify, available, resource, command, operationStatus, transfer}
}
