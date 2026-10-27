// Pure display recovery: canonical history is never changed and tools are never executed.
const callsOf = message => Array.isArray(message?.tool_calls) ? message.tool_calls : []
const callIds = message => callsOf(message).map(call => call?.id).filter(id => typeof id === 'string' && id)

export function recoverMissingToolProjection(fullHistory = [], chatShow = []) {
  const canonicalById = new Map()
  const duplicateIds = new Set()
  for (const [index, message] of fullHistory.entries()) {
    if (!message?.storageId) continue
    if (canonicalById.has(message.storageId)) duplicateIds.add(message.storageId)
    canonicalById.set(message.storageId, {message, index})
  }
  const textOf = content => Array.isArray(content) ? content.filter(part => part?.type === 'text').map(part => part.text || '').join('') : (content || '')
  let separated = 0
  const output = chatShow.map(ui => {
    let linked = canonicalById.get(ui?.storageId)
    const ids = callIds(ui).sort()
    if (!linked && ids.length && /(?:\*\*错误信息\*\*|\*\*请求已取消\*\*)/.test(textOf(ui.content))) {
      const errors = fullHistory.map((message, index) => ({message, index})).filter(entry => entry.message.role === 'assistant'
        && !callsOf(entry.message).length && textOf(entry.message.content) === textOf(ui.content))
      if (errors.length === 1) linked = errors[0]
    }
    if (!linked || duplicateIds.has(ui.storageId) || ui.role !== 'assistant' || !ids.length
      || new Set(ids).size !== ids.length || callsOf(linked.message).length
      || textOf(ui.content) !== textOf(linked.message.content)
      || !/(?:\*\*错误信息\*\*|\*\*请求已取消\*\*)/.test(textOf(linked.message.content))) return ui
    // Old builds rebound the mixed error/tool bubble to the plain error row on save.
    // Split only an exact call-ID match immediately preceding that error segment.
    let cursor = linked.index - 1
    while (fullHistory[cursor]?.role === 'tool') cursor--
    const tool = fullHistory[cursor]
    const previousIds = callIds(tool).sort()
    if (tool?.role !== 'assistant' || !tool.storageId || duplicateIds.has(tool.storageId)
      || ids.length !== previousIds.length || !ids.every((id, index) => id === previousIds[index])) return ui
    separated++
    return {...ui, storageId: linked.message.storageId, tool_calls: []}
  })
  const represented = new Set()
  const representedCalls = new Set()
  for (const message of output) {
    if (message?.storageId) represented.add(message.storageId)
    for (const id of callIds(message)) representedCalls.add(id)
  }
  let nextId = chatShow.reduce((max, message) => Math.max(max, Number(message?.id) || 0), 0) + 1
  let recovered = 0
  for (const [index, message] of fullHistory.entries()) {
    const ids = callIds(message)
    if (message?.role !== 'assistant' || !message.storageId || duplicateIds.has(message.storageId)
      || represented.has(message.storageId) || !ids.length || ids.length !== callsOf(message).length
      || new Set(ids).size !== ids.length || ids.some(id => representedCalls.has(id))) continue
    // Place only by exact canonical storage identity, never by matching text/array position.
    const nextUiIndex = output.findIndex(ui => {
      const canonical = canonicalById.get(ui?.storageId)
      return canonical && !duplicateIds.has(ui.storageId) && canonical.index > index
    })
    const previousUiIndex = output.findLastIndex(ui => {
      const canonical = canonicalById.get(ui?.storageId)
      return canonical && !duplicateIds.has(ui.storageId) && canonical.index < index
    })
    if (nextUiIndex < 0 && previousUiIndex < 0) continue
    const results = new Map()
    for (let cursor = index + 1; fullHistory[cursor]?.role === 'tool'; cursor++) {
      const result = fullHistory[cursor]
      if (ids.includes(result.tool_call_id)) results.set(result.tool_call_id, result.content)
    }
    const neighbor = output[nextUiIndex >= 0 ? nextUiIndex : previousUiIndex]
    const content = Array.isArray(message.content) ? message.content
      : (typeof message.content === 'string' && message.content ? [{type: 'text', text: message.content}] : [])
    const bubble = {
      id: nextId++, role: 'assistant', storageId: message.storageId,
      uiStorageId: `recovered-tool-${message.storageId}`,
      content, reasoning_content: message.reasoning_content || '', status: '',
      ...(message.tokenUsage ? {tokenUsage: message.tokenUsage} : {}),
      ...(neighbor?.aiName ? {aiName: neighbor.aiName} : {}),
      tool_calls: callsOf(message).map(call => ({
        id: call.id, name: call.function?.name || call.name || '',
        args: call.function?.arguments ?? call.args ?? '',
        result: results.has(call.id) ? results.get(call.id) : '[未记录工具结果]',
        approvalStatus: 'finished'
      }))
    }
    output.splice(nextUiIndex >= 0 ? nextUiIndex : previousUiIndex + 1, 0, bubble)
    represented.add(message.storageId)
    ids.forEach(id => representedCalls.add(id))
    recovered++
  }
  return {messages: output, recovered, separated}
}
