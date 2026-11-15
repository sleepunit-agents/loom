import { and, asc, eq, ne } from 'drizzle-orm';
import type { DataDatabase } from '../data/database.js';
import { inbox } from '../data/schema.js';
import type { Clock } from '../clock.js';
import { InboxVolume, type Recipient } from './volume.js';

export type WaitingItem = typeof inbox.$inferSelect;
/** In-process admission boundary. Runtime owns jobs, claiming and acknowledgement.
 * Return false when capacity is unavailable; call changed() when it becomes free.
 * No model is started by a trigger; only this settled inbox admission can do so. */
export type AdmitInbox = (who: Recipient, items: readonly WaitingItem[]) => boolean;

export class SettledInbox {
  private cancel?: () => void;
  private closed = false;
  private scanning = false;
  private again = false;
  private offered = new Map<string, string>();
  private pending = new Map<string, { signature: string; due: number }>();
  readonly volume: InboxVolume;
  constructor(private db: DataDatabase, private clock: Clock, private admit: AdmitInbox, private volumeExpired?: () => void) {
    this.volume = new InboxVolume(db, clock);
  }

  /** Composition calls after committed inbox/volume/settings changes and on
   * runtime capacity changes. Recovery scans persisted waiting items at startup. */
  changed(): void {
    if (this.closed) return;
    if (this.scanning) { this.again = true; return; }
    this.scanning = true;
    try {
      const attempted = new Set<string>();
      do { this.again = false; this.scan(attempted); } while (this.again && !this.closed);
    } finally { this.scanning = false; }
  }

  close(): void { this.closed = true; this.cancel?.(); this.pending.clear(); this.offered.clear(); }

  private scan(attempted: Set<string>): void {
    this.cancel?.(); this.cancel = undefined;
    let next = this.volume.expire(this.volumeExpired);
    const groups = new Map<string, { who: Recipient; items: WaitingItem[] }>();
    for (const item of this.db.select().from(inbox).where(and(eq(inbox.state, 'waiting'), ne(inbox.volume, 'mute'))).orderBy(asc(inbox.at), asc(inbox.seq), asc(inbox.id)).all()) {
      const key = JSON.stringify([item.toKind, item.to]);
      let group = groups.get(key);
      if (!group) { group = { who: { kind: item.toKind, id: item.to }, items: [] }; groups.set(key, group); }
      group.items.push(item);
    }
    for (const key of this.pending.keys()) if (!groups.has(key)) this.pending.delete(key);
    for (const key of this.offered.keys()) if (!groups.has(key)) this.offered.delete(key);
    for (const [key, { who, items }] of groups) {
      // Words/state metadata belong to Inbox. Volume expiry can make an old item
      // eligible again, so include volume without changing content changed_at.
      const settleSeconds = this.volume.timings(who).settleSeconds;
      const signature = JSON.stringify([settleSeconds, items]);
      if (this.offered.get(key) === signature) continue;
      let pending = this.pending.get(key);
      if (!pending || pending.signature !== signature) {
        pending = { signature, due: this.clock.now() + settleSeconds * 1000 };
        this.pending.set(key, pending);
      }
      if (pending.due <= this.clock.now()) {
        const attempt = JSON.stringify([key, signature]);
        if (attempted.has(attempt)) continue;
        attempted.add(attempt);
        // Mark before calling out: admission may synchronously commit a claim
        // and call changed(). A failure stays pending until capacity changes.
        this.offered.set(key, signature);
        try {
          if (!this.admit(who, items)) this.offered.delete(key);
        } catch { this.offered.delete(key); }
      } else next = Math.min(next ?? Infinity, pending.due);
    }
    if (!this.closed && next !== undefined) this.cancel = this.clock.at(next, () => this.changed());
  }
}
