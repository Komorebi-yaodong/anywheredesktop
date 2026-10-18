function expectedContentBytes(content) {
  if (Buffer.isBuffer(content)) return content.length
  if (content instanceof Uint8Array) return content.byteLength
  if (content instanceof ArrayBuffer) return content.byteLength
  if (content && typeof content === 'object' && content.encoding === 'base64' && typeof content.data === 'string') {
    return Buffer.from(content.data, 'base64').length
  }
  return Buffer.byteLength(typeof content === 'string' ? content : JSON.stringify(content ?? {}), 'utf8')
}

/** Pure DAV response validation; safe to test without Electron/WebDAV credentials. */
export function verifyRemoteFileInfo(stat, expectedContent) {
  const expectedBytes = expectedContentBytes(expectedContent)
  if (!stat || String(stat.type || 'file') !== 'file') {
    throw new Error('webdav_uploaded_file_missing')
  }
  const remoteSize = Number(stat.size)
  // Some DAV implementations omit Content-Length in PROPFIND. When a numeric
  // size is available it is authoritative and must match the local snapshot.
  if (Number.isFinite(remoteSize) && remoteSize >= 0 && remoteSize !== expectedBytes) {
    throw new Error('webdav_uploaded_file_size_mismatch')
  }
  return { ok: true, bytes: expectedBytes, remoteSize: Number.isFinite(remoteSize) ? remoteSize : null }
}
