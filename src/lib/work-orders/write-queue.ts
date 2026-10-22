/** Serialize this editor's writes. A failed write cancels already-waiting writes;
 * a later deliberate retry is allowed, still using the last confirmed revision. */
export function createTicketWriteQueue() {
  let tail: Promise<boolean> | null = null;
  return {
    enqueue(write: () => Promise<boolean>): Promise<boolean> {
      const previous = tail;
      const result = (async () => {
        if (previous && !await previous.catch(() => false)) return false;
        return write();
      })();
      tail = result;
      const clear = () => { if (tail === result) tail = null; };
      void result.then(clear, clear);
      return result;
    },
  };
}
