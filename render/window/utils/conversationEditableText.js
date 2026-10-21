// File-parser text blocks are immutable attachments when editing prose.
export function isExtractedFileText(value) {
  return typeof value === 'string' && /^file name:[^\r\n]+\r?\nfile content:\r?\n/i.test(value) && /\r?\nfile end\s*$/i.test(value)
}

export function replaceConversationEditableText(content, text) {
  if (!Array.isArray(content)) {
    if (isExtractedFileText(content)) return [{type: 'text', text: content}, {type: 'text', text}]
    if (content && typeof content === 'object' && (content.type !== 'text' || isExtractedFileText(content.text))) {
      return [content, {type: 'text', text}]
    }
    return text
  }
  // Keep original attachment objects and their order. Replace the complete
  // editable prose, not a lossy display/Markdown reconstruction of the message.
  const result = []
  let inserted = false
  for (const part of content) {
    const editable = part?.type === 'text' && typeof part.text === 'string' && !isExtractedFileText(part.text)
    if (!editable) { result.push(part); continue }
    if (!inserted) { result.push({...part, text}); inserted = true }
  }
  if (!inserted) result.push({type: 'text', text})
  return result
}
