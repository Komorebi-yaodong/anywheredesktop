// A FIFO for database operations that cannot be coalesced (e.g. a rename receipt).
// Autosave still coalesces in its existing queue before entering this single writer lane.
export function createConversationWriteQueue() {
  let tail = Promise.resolve();
  const run = (operation) => {
    const result = tail.then(operation);
    tail = result.catch(() => {});
    return result;
  };
  return {run, whenIdle: () => tail};
}
