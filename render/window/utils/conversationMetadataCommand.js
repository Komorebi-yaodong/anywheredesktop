export async function executeConversationMetadataCommand(command, {
  getStorage, canWrite, isClosing, checkRequest, rename, complete, publish
}) {
  if (!command || typeof command.requestId !== 'string' || typeof command.conversationId !== 'string') return;
  const receipt = {requestId: command.requestId, conversationId: command.conversationId};
  let committed = false;
  try {
    if (isClosing()) throw new Error('conversation_closing');
    const storage = getStorage();
    if (!storage || storage.conversationId !== command.conversationId || storage.dirPath !== command.dirPath) throw new Error('conversation_metadata_window_mismatch');
    if (!canWrite()) throw new Error('conversation_write_lease_lost');
    if (!(command.expiresAt > Date.now()) || !(await checkRequest(receipt))?.ok) throw new Error('conversation_metadata_request_expired');
    // State can change while Main validates the request. Recheck at the write boundary.
    if (isClosing()) throw new Error('conversation_closing');
    const latest = getStorage();
    if (!canWrite() || latest?.conversationId !== command.conversationId || latest?.dirPath !== command.dirPath) throw new Error('conversation_write_lease_lost');
    if (!(command.expiresAt > Date.now())) throw new Error('conversation_metadata_request_expired');
    const result = await rename(command);
    committed = true;
    // The commit is authoritative even if its observer/status notification cannot be delivered.
    try {await publish();} catch { /* do not turn a committed rename into a retry */ }
    await complete({...receipt, ok: true, result});
  } catch (error) {
    if (committed) return; // Lost completion is uncertain; never report a committed mutation as rejected.
    await complete({...receipt, ok: false, code: /^conversation_[a-z_]+$/.test(error?.message || '') ? error.message : 'conversation_metadata_failed'}).catch(() => {});
  }
}
