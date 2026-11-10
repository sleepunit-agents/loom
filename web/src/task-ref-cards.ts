// Task chip words from the same member-admitted records as Tasks and Work. The refs resolver owns admission and
// navigation: a collection record alone never creates a chip. Renamed tasks providers keep the resolver card. Missing rows may just be outside the recent window.
import type { RefCard } from './comms-refs';
import type { Rec } from './collections/runtime';

export function taskCardsOf(cards: ReadonlyMap<string, RefCard | null>, records: ReadonlyMap<string, Rec>): ReadonlyMap<string, RefCard | null> {
  let out: Map<string, RefCard | null> | undefined;
  for (const [ref, card] of cards) {
    if (!card || card.kind !== 'task' || !/^t-\d{1,9}$/.test(ref) || card.page !== `p/tasks/task/${ref}`) continue;
    const r = records.get(`tasks/task/${ref}`);
    if (!r || typeof r.title !== 'string' || !['open', 'in_progress', 'closed'].includes(String(r.status))) continue;
    const status = r.status === 'closed' ? 'Closed' : r.blocked === true ? 'Blocked' : r.status === 'in_progress' ? 'In progress' : 'Open';
    const tone = r.status === 'closed' ? 'ok' : r.blocked === true ? 'bad' : undefined;
    const title = r.title.slice(0, 200);
    if (card.title === title && card.status === status && card.tone === tone) continue;
    const next = { ...card, title, status };
    delete next.tone;
    if (tone) next.tone = tone;
    (out ??= new Map(cards)).set(ref, next);
  }
  return out ?? cards;
}
