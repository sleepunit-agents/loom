/** The member's own writes from this page (docs/specs/boards.md, "Live reads and their cost": "Now").
 *
 * A brick's data is read again only every few seconds, so what the member does here must not wait for that: the
 * page is told the moment loom has answered one of its own writes, and asks for its bricks' data now (./main.tsx).
 * Every write a page sends is a POST to loom's own `/api/…` door, whoever sends it: `memberOperation`
 * (../data/operation.ts) and the desktop's command helpers the bricks reuse (Tempo's, Bridges', Secrets', a
 * ticket's, an answer's). So this file watches that one door, once, and no brick and no helper is changed.
 * It only watches: the request and its answer pass through untouched, and a caller that was handed its own
 * `fetch` (every suite) is not seen at all. Import it before anything that might keep `fetch` for later. */
const told = new Set<(path: string) => void>();
/** Tell `tell` after each write of this page that loom answered without an error, with the door's path. */
export function afterOwnWrite(tell: (path: string) => void): () => void {
  told.add(tell);
  return () => { told.delete(tell); };
}
const real = globalThis.fetch;
if (typeof real === 'function') {
  globalThis.fetch = async function watched(input: RequestInfo | URL, init?: RequestInit) {
    const reply = await real.call(globalThis, input, init);
    if (typeof input === 'string' && input.startsWith('/api/') && init?.method === 'POST' && reply.ok) {
      const path = input.split('?')[0];
      for (const tell of [...told]) { try { tell(path); } catch { /* a listener never breaks a write */ } }
    }
    return reply;
  };
}
