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

/** What one attempt achieved. `posted` is the text the platform confirmed, in order from the start, and
 * `id` its last confirmed post. `rest` is the text that is not confirmed; empty means the whole reply is
 * out. With a `rest`, `refused` is our own refusal when its first part provably never left this process;
 * without `refused` that part may have reached the platform. */
export interface ReplyAttempt { posted: string; id?: string; rest: string; refused?: BridgeReplyNotSent }

/** One attempt for the engine's outbox row, never a retry loop.
 * The adapter's post callback MUST recheck authorization for every chunk, use
 * the bound address/thread and suppress platform-generated mentions. The engine
 * owns staging and durable uncertainty; this helper grants no right to send.
 * It stops at the first part that is not confirmed and says how far it got, so
 * the engine can keep what is out and deal with the remainder on its own.
 * Nothing of an upstream error is returned: it can contain credentials or words.
 */
export async function postReply(platform: Venue['platform'], text: string,
  post: (text: string) => Promise<{ id: string }>): Promise<ReplyAttempt> {
  const parts = replyParts(platform, text);
  let confirmed = 0, id: string | undefined, refused: BridgeReplyNotSent | undefined;
  try {
    for (const part of parts) {
      const result = await post(part);
      if (!result || typeof result.id !== 'string' || !result.id.trim()) throw new Error();
      id = result.id; confirmed++;
    }
  } catch (error) {
    if (error instanceof BridgeReplyNotSent) refused = error;
  }
  // The parts are cut greedily from the start, so cutting the remainder again later gives the same parts.
  return { posted: parts.slice(0, confirmed).join(''), ...(id === undefined ? {} : { id }), rest: parts.slice(confirmed).join(''), ...(refused ? { refused } : {}) };
}
