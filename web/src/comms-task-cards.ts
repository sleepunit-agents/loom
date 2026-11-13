// Task chip words from the same member-admitted records as Tasks and Work. The refs resolver owns admission and
// navigation: a collection record alone never creates a chip. Renamed tasks providers keep the resolver card. Missing rows may just be outside the recent window.
import type { RefCard } from './comms-refs';
import type { Rec } from './collections/runtime';

export function taskCardsOf(cards: ReadonlyMap<string, RefCard | null>, records: ReadonlyMap<string, Rec>, viewer = ''): ReadonlyMap<string, RefCard | null> {
  let out: Map<string, RefCard | null> | undefined;
  for (const [ref, card] of cards) {
    if (!card || card.kind !== 'task' || !/^t-\d{1,9}$/.test(ref) || card.page !== `p/tasks/task/${ref}`) continue;
    const r = records.get(`tasks/task/${ref}`);
    if (!r || typeof r.title !== 'string') { (out ??= new Map(cards)).set(ref,null); continue; }
    // The provider's own formatter supplies both wordings. Older providers or malformed rows retain the resolver's
    // state. No inference from raw task status, assignee or blocked flags; TASKSTORE_OWNER belongs to the piece.
    const state = r.refState;
    let status = card.status, tone = card.tone;
    if (state && typeof state === 'object' && !Array.isArray(state)) {
      const s = state as Record<string, unknown>;
      if (typeof s.status === 'string' && s.status.length <= 24 && typeof s.ownerStatus === 'string' && s.ownerStatus.length <= 24
        && (s.owner === null || typeof s.owner === 'string') && (s.tone === null || s.tone === 'bad' || s.tone === 'warn' || s.tone === 'ok')) {
        status = viewer && viewer === s.owner ? s.ownerStatus : s.status;
        tone = s.tone ?? undefined;
      }
    }
    const title = r.title.slice(0, 200);
    if (card.title === title && card.status === status && card.tone === tone) continue;
    const next = { ...card, title, status, tone };
    (out ??= new Map(cards)).set(ref, next);
  }
  return out ?? cards;
}
