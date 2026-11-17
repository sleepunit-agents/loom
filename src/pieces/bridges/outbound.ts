import type { Venue } from './model.js';

/** Conservative legacy caps, measured in UTF-16 units so astral text also fits. */
const limits = { discord: 2000, slack: 3900 } as const;

/** Preserve every character, prefer a newline in the latter half of a chunk,
 * and never cut between a surrogate pair. No markup rewriting or IO here.
 */
export function replyParts(platform: Venue['platform'], text: string): string[] {
  if (!text.trim()) throw new Error('Empty bridge reply');
  const limit = limits[platform];
  const parts: string[] = [];
  let start = 0;
  while (start < text.length) {
    let end = Math.min(start + limit, text.length);
    if (end < text.length) {
      const newline = text.lastIndexOf('\n', end - 1);
      if (newline >= start + limit / 2) end = newline + 1;
      // A newline is a safe boundary; hard cuts may bisect an astral character.
      const before = text.charCodeAt(end - 1), after = text.charCodeAt(end);
      if (before >= 0xd800 && before <= 0xdbff && after >= 0xdc00 && after <= 0xdfff) end--;
    }
    parts.push(text.slice(start, end));
    start = end;
  }
  return parts;
}

/** A post that provably never left this process: refused before any request was made.
 * Everything else that fails is uncertain, because the platform may have accepted it.
 * `again` says whether trying later can help (a lifetime that ended) or not (an address
 * no request can be built from). */
export class BridgeReplyNotSent extends Error {
  constructor(readonly again: boolean) { super('Bridge reply was not sent'); }
}

/** One attempt for the engine's whole outbox row, never a retry loop.
 * The adapter's post callback MUST recheck authorization for every chunk, use
 * the bound address/thread and suppress platform-generated mentions. The engine
 * owns staging and durable uncertainty; this helper grants no right to send.
 * Only the final receipt is returned, matching the legacy send command.
 * BridgeReplyNotSent passes through only while no part has been posted; once
 * one part is out, a later part that was not sent still leaves the reply partial.
 */
export async function postReply(platform: Venue['platform'], text: string,
  post: (text: string) => Promise<{ id: string }>): Promise<{ id: string }> {
  const parts = replyParts(platform, text);
  let receipt: { id: string } | undefined;
  try {
    for (const part of parts) {
      const result = await post(part);
      if (!result || typeof result.id !== 'string' || !result.id.trim()) throw new Error();
      receipt = { id: result.id };
    }
  } catch (error) {
    if (error instanceof BridgeReplyNotSent && !receipt) throw error;
    // An upstream error can contain credentials, words, or a successful post.
    throw new Error('Bridge reply attempt uncertain');
  }
  return receipt!;
}
