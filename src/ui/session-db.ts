import type { Db } from '../core/db/index.js';
import { HouseholdRows } from '../core/household/rows.js';
import { SEEN_EVERY_S, type SessionFile, type SessionPersistence } from './sessions.js';

const keyed = ['sessions', 'links', 'challenges', 'passkeys'] as const;
type Keyed = typeof keyed[number];

/**
 * The database is owned by the daemon/importer. No schema changes or JSON reads
 * happen here. Activation is supplied by the caller after a verified import.
 * Each credential has its own row; session verification decodes only that row.
 */
export class SessionDatabase implements SessionPersistence {
  constructor(private readonly db: Db) {}

  get<K extends Keyed>(concern: K, id: string): NonNullable<SessionFile[K]>[string] | undefined {
    return new HouseholdRows<NonNullable<SessionFile[K]>[string]>(this.db, concern).get(id);
  }

  /** Reconstruct the legacy shape for bounded administrative multi-row changes. */
  read(): SessionFile {
    return this.db.transaction(() => {
      const f = new HouseholdRows<Partial<SessionFile>>(this.db, 'settings').get('session-envelope') ?? {};
      const out: SessionFile = { ...f, v: 1, sessions: {} };
      for (const concern of keyed) {
        const entries = new HouseholdRows(this.db, concern).entries();
        // Optional empty maps may have been omitted in the source. The envelope
        // retains their presence, as well as unknown fields for lossless import.
        if (entries.length || Object.hasOwn(f, concern) || concern === 'sessions') {
          Object.defineProperty(out, concern, { value: Object.fromEntries(entries), enumerable: true, writable: true, configurable: true });
        }
      }
      const push = new HouseholdRows<NonNullable<SessionFile['push']>>(this.db, 'push').get('state');
      const subs = new HouseholdRows(this.db, 'push').entries().filter(([id]) => id.startsWith('sub:'));
      if (push !== undefined || subs.length) {
        out.push = { ...push };
        if (subs.length || (push && Object.hasOwn(push, 'subs'))) out.push.subs = Object.fromEntries(subs.map(([id, value]) => [id.slice(4), value])) as NonNullable<SessionFile['push']>['subs'];
      }
      const readers = new HouseholdRows<NonNullable<SessionFile['members']>[string]>(this.db, 'readers').entries();
      if (readers.length || Object.hasOwn(f, 'members')) out.members = Object.fromEntries(readers);
      return out;
    })();
  }

  /** Called inside the import/change transaction, preserving omitted and unknown fields. */
  replace(f: SessionFile): void {
    if (!this.db.inTransaction) throw new Error('session replacement requires a transaction');
    const envelope: Partial<SessionFile> = { ...f };
    for (const concern of keyed) {
      this.sync(new HouseholdRows(this.db, concern), f[concern] ?? {});
      if (Object.hasOwn(f, concern)) Object.defineProperty(envelope, concern, { value: {}, enumerable: true, writable: true, configurable: true });
    }
    this.sync(new HouseholdRows(this.db, 'readers'), f.members ?? {});
    if (Object.hasOwn(f, 'members')) envelope.members = {};
    const push: Record<string, unknown> = {};
    if (f.push !== undefined) {
      const meta = { ...f.push };
      if (Object.hasOwn(f.push, 'subs')) meta.subs = {};
      push.state = meta;
      for (const [ep, sub] of Object.entries(f.push.subs ?? {})) Object.defineProperty(push, `sub:${ep}`, { value: sub, enumerable: true });
    }
    this.sync(new HouseholdRows(this.db, 'push'), push);
    delete envelope.push;
    new HouseholdRows(this.db, 'settings').put('session-envelope', envelope);
  }

  change<T>(fn: (file: SessionFile) => T): T {
    return this.db.transaction(() => {
      const f = this.read();
      const out = fn(f);
      this.replace(f);
      return out;
    }).immediate();
  }

  touch(id: string, nowS: number): boolean {
    const rows = new HouseholdRows<SessionFile['sessions'][string]>(this.db, 'sessions');
    return this.db.transaction(() => {
      const s = rows.get(id);
      if (!s || (s.seenAt !== undefined && nowS - s.seenAt < SEEN_EVERY_S)) return false;
      rows.put(id, { ...s, seenAt: nowS });
      return true;
    }).immediate();
  }

  private sync(rows: HouseholdRows<unknown>, next: Record<string, unknown>): void {
    const before = new Map(rows.entries());
    for (const [id, value] of Object.entries(next)) {
      if (!before.has(id) || JSON.stringify(before.get(id)) !== JSON.stringify(value)) rows.put(id, value);
      before.delete(id);
    }
    for (const id of before.keys()) rows.remove(id);
  }
}
