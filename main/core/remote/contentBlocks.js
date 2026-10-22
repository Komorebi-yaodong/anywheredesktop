const string = value => typeof value === 'string' ? value : ''
const safeMedia = value => {
  const source = string(value)
  if (/^anywhere-media:\/\/[A-Za-z0-9_-]{16,160}(?:\?type=(?:image|audio|video))?$/.test(source)) return source
  try {const url = new URL(source); return url.protocol === 'https:' && !url.username && !url.password ? source : ''} catch {return ''}
}

/** Input MUST be the sanitized remote DTO, never raw database or provider data. */
export function messageBlocks(content) {
  return (Array.isArray(content) ? content : [content]).map(part => {
    if (typeof part === 'string') return {kind: 'markdown', text: part}
    if (!part || typeof part !== 'object') return {kind: 'notice', text: '不支持的消息内容'}
    if (part.type === 'text') return {kind: 'markdown', text: string(part.text)}
    const type = ['image', 'image_url', 'audio', 'video'].includes(part.type) ? part.type === 'image_url' ? 'image' : part.type : ''
    const uri = safeMedia(part.url || part.image_url?.url || part.image_url)
    if (type && uri) return {kind: type, uri, name: string(part.name).slice(0, 240)}
    if (['file', 'document', 'input_file', 'attachment', 'inline-attachment'].includes(part.type) || type) return {
      kind: 'file', name: string(part.name || part.filename || part.file?.filename).slice(0, 240) || '文件',
      mimeType: string(part.mimeType).slice(0, 160), byteSize: Math.max(0, Number(part.byteSize) || 0), previewable: false
    }
    return {kind: 'notice', text: '此内容类型暂不支持，请在 Desktop 查看'}
  })
}
export function structuredPage(page) {
  return {...page, messages: page.messages.map(message => {
    const payload = {...message.payload}
    delete payload.content
    return {...message, payload: {...payload, blocks: messageBlocks(message.payload.content)}}
  })}
}
