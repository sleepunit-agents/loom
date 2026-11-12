import type { Db } from '../db/index.js';

const concerns = ['settings', 'agents', 'members', 'projects', 'tokens', 'token_use', 'sessions', 'links', 'challenges', 'passkeys', 'push', 'readers', 'piece_settings', 'imports'] as const;
export type HouseholdConcern = typeof concerns[number];

/**
 * One row per entity, preserving credential and legacy optional fields exactly.
 * JSON is a row encoding, never a second store. Callers own validation and policy.
 * Reads by key decode one row, including sessions on a request's hot path.
 * The connection belongs to the daemon (or the stopped-daemon importer).
 */
export class HouseholdRows<T> {
  private readonly table: string;
  constructor(private readonly db: Db, concern: HouseholdConcern) {
    // Also check at runtime: the table name is the only interpolated SQL.
    if (!concerns.includes(concern)) throw new Error('unknown household concern');
    this.table = `household_${concern}`;
  }
  get(id: string): T | undefined {
    const row = this.db.prepare(`SELECT body FROM ${this.table} WHERE id = ?`).get(id) as { body: string } | undefined;
    return row ? JSON.parse(row.body) as T : undefined;
  }
  entries(): Array<[string, T]> {
    return (this.db.prepare(`SELECT id, body FROM ${this.table} ORDER BY id`).all() as Array<{ id: string; body: string }>).map(r => [r.id, JSON.parse(r.body) as T]);
  }
  put(id: string, value: T): void {
    const body = JSON.stringify(value);
    if (body === undefined) throw new Error('a household row must be JSON');
    this.db.prepare(`INSERT INTO ${this.table} (id, body) VALUES (?, ?) ON CONFLICT(id) DO UPDATE SET body = excluded.body`).run(id, body);
  }
  remove(id: string): boolean {
    return this.db.prepare(`DELETE FROM ${this.table} WHERE id = ?`).run(id).changes !== 0;
  }
  /** An exception rolls back all concerns sharing this connection, even inside an outer transaction. */
  transaction<R>(fn: () => R): R { return this.db.transaction(fn)(); }
}
