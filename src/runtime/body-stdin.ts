/** The fixed child's private stdin owner. Incoming buffers and collected copies
 * are erased; cancellation erases immediately, before the stream settles. */
import type { Readable } from 'node:stream';
import { BODY_START_BYTES } from './body-input-limit.js';
export async function readBodyStdin(source: Readable, signal: AbortSignal): Promise<Uint8Array> {
  const chunks: Buffer[] = []; let size = 0;
  const erase = () => { for (const chunk of chunks) chunk.fill(0); };
  const stop = () => { erase(); source.destroy(new Error('Body input cancelled')); };
  if (signal.aborted) throw new Error('Body input cancelled');
  signal.addEventListener('abort', stop, {once:true});
  try {
    for await (const data of source) {
      if (!(data instanceof Uint8Array) && typeof data !== 'string') throw new Error('Invalid body input');
      const chunk = Buffer.from(data);
      if (data instanceof Uint8Array) data.fill(0);
      chunks.push(chunk); size += chunk.length;
      if (signal.aborted || size > BODY_START_BYTES) throw new Error('Body input unavailable');
    }
    if (signal.aborted) throw new Error('Body input cancelled');
    const result = Buffer.concat(chunks);
    // Retain an eraser across the promise handoff into bodyProgram. The fixed
    // executable aborts its per-job signal on normal completion as well.
    const eraseResult = () => result.fill(0);
    signal.addEventListener('abort', eraseResult, {once:true});
    if (signal.aborted) { eraseResult(); throw new Error('Body input cancelled'); }
    return result;
  } finally { signal.removeEventListener('abort',stop); erase(); }
}
