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

/** What one attempt achieved. `parts` is how many parts of the reply the platform has now confirmed,
 * counted from its start and including those confirmed before this attempt. `done` says that is all of
 * them. When it is not, `refused` is our own refusal when the next part provably never left this process;
 * without `refused` that part may have reached the platform. */
export interface ReplyAttempt { parts: number; done: boolean; refused?: BridgeReplyNotSent }

/** One attempt for the engine's outbox row, never a retry loop. It posts the reply's parts from part
 * `from` on (the parts before it were confirmed by an earlier attempt), and tells the engine of each part
 * the moment the platform confirms it, so that what is out is on record before the next part is tried.
 * The adapter's post callback MUST recheck authorization for every chunk, use
 * the bound address/thread and suppress platform-generated mentions. The engine
 * owns staging and durable uncertainty; this helper grants no right to send.
 * It stops at the first part that is not confirmed and says how far it got.
 * Nothing of an upstream error is returned: it can contain credentials or words.
 */
export async function postReply(platform: Venue['platform'], text: string, from: number,
  post: (text: string) => Promise<{ id: string }>, confirmed: (part: number, id: string) => void): Promise<ReplyAttempt> {
  // The parts are cut greedily from the start of a text that never changes, so they are the same parts every time.
  const parts = replyParts(platform, text);
  let next = Math.min(Math.max(from, 0), parts.length), refused: BridgeReplyNotSent | undefined;
  try {
    for (; next < parts.length; next++) {
      const result = await post(parts[next]);
      if (!result || typeof result.id !== 'string' || !result.id.trim()) throw new Error();
      confirmed(next, result.id);
    }
  } catch (error) {
    if (error instanceof BridgeReplyNotSent) refused = error;
  }
  return { parts: next, done: next === parts.length, ...(refused ? { refused } : {}) };
}
