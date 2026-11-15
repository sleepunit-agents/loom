import { call, callOnce } from '../../data';
/** Only idempotent metadata reads/opens queue while the write socket connects.
 * Private words remain single-send; their stable client ID permits manual retry. */
export async function conversationOperation(name: string, input: object, queued = false): Promise<void> {
  const result = await (queued ? call(name, input) : callOnce(name, input)).result;
  if (!result.ok) throw new Error(result.message);
}
