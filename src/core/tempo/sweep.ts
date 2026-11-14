import type { Clock } from '../clock.js';
import type { Recipient } from './volume.js';

export interface OpenItem { id: string; words: string; openedAt: string }
export interface SweepPart {
  name: string;
  /** Each part applies its own recipient routing and returns only open items. */
  open(who: Recipient): readonly OpenItem[];
}
export interface SweepSummary {
  part: string; count: number; oldestAt: string; ageMs: number; items: readonly OpenItem[];
}
export interface SweepDelivery { id: string; who: Recipient; summaries: readonly SweepSummary[]; words: string }
/** The operation target of a standing trigger. One inbox item per recipient,
 * however many parts contribute. Ordinary inbox settling does the admission. */
export class Sweep {
  private parts = new Map<string, SweepPart>();
  constructor(private clock: Clock, private deliver: (delivery: SweepDelivery) => void) {}
  register(part: SweepPart): () => void {
    if (!part.name || this.parts.has(part.name)) throw new Error('Duplicate or empty sweep part');
    this.parts.set(part.name, part);
    return () => { if (this.parts.get(part.name) === part) this.parts.delete(part.name); };
  }
  run(who: Recipient, occurrence: string): readonly SweepSummary[] {
    if (!occurrence) throw new Error('Sweep needs an occurrence identifier');
    const summaries: SweepSummary[] = [];
    for (const part of this.parts.values()) {
      const unique = new Map<string, OpenItem>();
      for (const item of part.open(who)) {
        if (!Number.isFinite(Date.parse(item.openedAt))) throw new Error('Invalid open-item date');
        unique.set(item.id, item);
      }
      const items = [...unique.values()].sort((a, b) => Date.parse(a.openedAt) - Date.parse(b.openedAt) || a.id.localeCompare(b.id));
      if (items.length) summaries.push({ part: part.name, count: items.length, oldestAt: items[0].openedAt, ageMs: Math.max(0, this.clock.now() - Date.parse(items[0].openedAt)), items });
    }
    if (summaries.length) this.deliver({ id: JSON.stringify(['sweep', who.kind, who.id, occurrence]), who, summaries, words: summaries.map(s => {
      const hours = Math.floor(s.ageMs / 3_600_000);
      const age = hours >= 24 ? `${Math.floor(hours / 24)} days` : hours > 0 ? `${hours} hours` : `${Math.floor(s.ageMs / 60_000)} minutes`;
      return `${s.part}: ${s.count} open, oldest ${age}\n${s.items.map(i => `- ${i.id}: ${i.words.replace(/[\r\n]+/g, ' ')}`).join('\n')}`;
    }).join('\n\n') });
    return summaries;
  }
}
