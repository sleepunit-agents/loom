// Task chip words from the same member-admitted records as Tasks and Work. The refs resolver owns admission and
// navigation: a collection record alone never creates a chip. Renamed tasks providers keep the resolver card. Missing rows may just be outside the recent window.
import type { RefCard } from './comms-refs';
import type { Rec } from './collections/runtime';

export function taskCardsOf(cards: ReadonlyMap<string, RefCard | null>, records: ReadonlyMap<string, Rec>): ReadonlyMap<string, RefCard | null> {
  let out: Map<string, RefCard | null> | undefined;
  for (const [ref, card] of cards) {
    if (!card || card.kind !== 'task' || !/^t-\d{1,9}$/.test(ref) || card.page !== `p/tasks/task/${ref}`) continue;
    const r = records.get(`tasks/task/${ref}`);
    if (!r || typeof r.title !== 'string') continue;
    // Status words belong to the tasks feed, including viewer-specific waiting labels and cancellation. The
    // generic collection lacks its TASKSTORE_OWNER context; do not invent a second, weaker status projection.
    const title = r.title.slice(0, 200);
    if (card.title === title) continue;
    const next = { ...card, title };
    (out ??= new Map(cards)).set(ref, next);
  }
  return out ?? cards;
}
