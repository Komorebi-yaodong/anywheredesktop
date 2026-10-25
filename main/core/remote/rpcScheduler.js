import contract from '../../../packages/remote-contract/index.cjs'

const writes = new Set([...contract.routes.commands, 'business.config.replace'])
// These must be able to settle a writer that another command is waiting for.
const interrupts = new Set(['conversation.cancel', 'conversation.compact.cancel', 'conversation.choice.submit'])

/** Called only AFTER ordered authentication/decryption. Never owns AEAD state. */
export function createRpcScheduler() {
  const tails = new Map()
  function schedule(request, run) {
    const outer = request.params && typeof request.params === 'object' ? request.params : {}
    const method = request.method === 'command.submit' ? outer.method : request.method
    const params = request.method === 'command.submit' && outer.params && typeof outer.params === 'object' ? outer.params : outer
    if (!writes.has(method) || interrupts.has(method)) return run()
    const key = typeof params.conversationId === 'string' ? `conversation:${params.conversationId}` : 'management'
    const previous = tails.get(key) || Promise.resolve()
    const next = previous.catch(() => {}).then(run)
    tails.set(key, next)
    next.finally(() => {if (tails.get(key) === next) tails.delete(key)}).catch(() => {})
    return next
  }
  return {schedule}
}
