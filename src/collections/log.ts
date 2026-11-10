/**
 * Core's change log and index for shared collections (docs/specs/collections.md, "Core's change log and index").
 *
 * loom runs several HTTP listeners over one $LOOM_HOME, so the log is a database every listener shares:
 * `$LOOM_HOME/collections/live.db`. It's a cache, derived from providers and rebuilt by snapshot, so it lives apart
 * from household.db, outside the household bundle (a restore can't bring back an old log), next to the cursor key.
 *
 *  - `domains`: one row per domain (`tasks/task`, or `tasks/*` for a provider counting all its types together): its
 *    epoch (random, minted only here, compare-and-set), the provider revision and transaction core has pulled to,
 *    and the pull lease (one listener at a time pulls a domain).
 *  - `log`: every change core pulled, in core's own row order (`seq`). A provider's rows are unique on
 *    (domain, epoch, rev) and written insert-or-ignore, so an overlapping pull writes nothing twice; core's own rows
 *    (expiry deletes, bridge diffs) have no revision. A transaction's rows are consecutive, its last marked `end`.
 *  - `idx`: current state per key, written only from whole records and only forward (a higher revision in the same
 *    epoch, or a new epoch), never from an answer trimmed for one viewer.
 *
 * No `kept: false` field ever reaches either: callers strip them before writing (pull.ts).
 */
import BetterSqlite3, { type Database } from 'better-sqlite3';
import { randomBytes } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export const LOG_KEEP = 1000;
export const LOG_KEEP_MS = 10 * 60 * 1000;
export const LOG_MAX = 5000;
export const LEASE_MS = 30_000;
/** The file whose change tells every listener that new rows are in the log (a time only). */
export const TICK = 'collections.tick';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS domains (
  domain     TEXT PRIMARY KEY,
  epoch      TEXT NOT NULL,
  rev        INTEGER,
  txn        TEXT,
  source     TEXT NOT NULL DEFAULT '',
  mode       TEXT NOT NULL DEFAULT 'log',
  lease      TEXT,
  lease_until INTEGER NOT NULL DEFAULT 0,
  nudged     INTEGER NOT NULL DEFAULT 0,
  pruned     INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS log (
  seq      INTEGER PRIMARY KEY AUTOINCREMENT,
  domain   TEXT NOT NULL,
  epoch    TEXT NOT NULL,
  rev      INTEGER,
  txn      TEXT,
  key      TEXT NOT NULL,
  op       TEXT NOT NULL,
  audience TEXT,
  agent    TEXT,
  record   TEXT,
  expires  INTEGER,
  at       INTEGER NOT NULL,
  end      INTEGER NOT NULL DEFAULT 1
);
CREATE UNIQUE INDEX IF NOT EXISTS log_rev ON log (domain, epoch, rev) WHERE rev IS NOT NULL;
CREATE INDEX IF NOT EXISTS log_domain ON log (domain, seq);
CREATE TABLE IF NOT EXISTS idx (
  key      TEXT PRIMARY KEY,
  domain   TEXT NOT NULL,
  epoch    TEXT NOT NULL,
  rev      INTEGER,
  audience TEXT NOT NULL,
  agent    TEXT,
  expires  INTEGER,
  record   TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_domain ON idx (domain);
CREATE TABLE IF NOT EXISTS receipts (
  op       TEXT PRIMARY KEY,
  session  TEXT NOT NULL,
  at       INTEGER NOT NULL,
  state    TEXT NOT NULL,
  answer   TEXT
);
CREATE INDEX IF NOT EXISTS idx_expires ON idx (expires) WHERE expires IS NOT NULL;
`;

const ready = new Set<string>();
export const liveDbPath = (home: string): string => join(home, 'collections', 'live.db');

export function withLog<T>(home: string, f: (db: Database) => T): T {
  const path = liveDbPath(home);
  mkdirSync(join(home, 'collections'), { recursive: true, mode: 0o700 });
  const fresh = !existsSync(path);
  const db = new BetterSqlite3(path);
  try {
    if (fresh) chmodSync(path, 0o600);
    db.pragma('busy_timeout = 5000');
    db.pragma('journal_mode = WAL');
    if (fresh || !ready.has(path)) { db.exec(SCHEMA); ready.add(path); }
    return f(db);
  } finally { db.close(); }
}

export const newEpoch = (): string => randomBytes(8).toString('hex');

export interface DomainRow { domain: string; epoch: string; rev: number | null; txn: string | null; source: string; mode: 'log' | 'bridge' }

/**
 * A domain's row, made with a fresh epoch the first time; `source` names what serves it (a piece and its version).
 * A different source (the piece replaced, reinstalled, rolled back) is a new epoch: its revisions are another history.
 */
export function domainOf(db: Database, domain: string, source: string): { row: DomainRow; minted: boolean } {
  return db.transaction(() => {
    const row = db.prepare('SELECT domain, epoch, rev, txn, source, mode FROM domains WHERE domain = ?').get(domain) as DomainRow | undefined;
    if (row && row.source === source) return { row, minted: false };
    const epoch = newEpoch();
    db.prepare(`INSERT INTO domains (domain, epoch, rev, txn, source, mode) VALUES (?, ?, NULL, NULL, ?, 'log')
                ON CONFLICT (domain) DO UPDATE SET epoch = excluded.epoch, rev = NULL, txn = NULL, source = excluded.source, mode = 'log'`).run(domain, epoch, source);
    db.prepare('DELETE FROM idx WHERE domain = ?').run(domain);
    return { row: { domain, epoch, rev: null, txn: null, source, mode: 'log' as const }, minted: true };
  }).immediate();
}

/**
 * A new epoch for `domain`, only if it's still at `from` (compare-and-set): two listeners that both find a reset mint
 * one epoch between them. Its index rows go (they belong to the old history); the log keeps the old rows, which no
 * subscription will read again.
 */
export function resetEpoch(db: Database, domain: string, from: string, mode: 'log' | 'bridge' = 'log'): string {
  return db.transaction(() => {
    const row = db.prepare('SELECT epoch FROM domains WHERE domain = ?').get(domain) as { epoch: string } | undefined;
    if (!row || row.epoch !== from) return row?.epoch ?? from;
    const epoch = newEpoch();
    db.prepare('UPDATE domains SET epoch = ?, rev = NULL, txn = NULL, mode = ? WHERE domain = ?').run(epoch, mode, domain);
    db.prepare('DELETE FROM idx WHERE domain = ?').run(domain);
    return epoch;
  }).immediate();
}

/** Take or renew the pull lease for `domain` as `holder`: true when it's ours until LEASE_MS from now. */
export function takeLease(db: Database, domain: string, holder: string, now = Date.now()): boolean {
  const r = db.prepare('UPDATE domains SET lease = ?, lease_until = ? WHERE domain = ? AND (lease IS NULL OR lease = ? OR lease_until < ?)')
    .run(holder, now + LEASE_MS, domain, holder, now);
  return r.changes === 1;
}

export interface Change {
  op: 'upsert' | 'delete';
  id: string;
  rev: number | null;
  txn: string | null;
  audience?: Record<string, unknown>;
  agent?: string;
  record?: Record<string, unknown>;
  expires?: number;
}

/**
 * Write one transaction's changes (in order) to the log and the index, under `epoch`, if the domain is still there.
 * Answers the log rows written (an overlapping pull's repeats write nothing). Each change's key is
 * `<domain's provider>/<type>/<id>`, passed in by `keyOf`.
 */
export function writeTxn(db: Database, domain: string, epoch: string, changes: readonly Change[], keyOf: (c: Change) => { key: string; type: string }, now = Date.now(),
  cursor?: { rev: number; txn: string }): number {
  return db.transaction(() => {
    const d = db.prepare('SELECT epoch FROM domains WHERE domain = ?').get(domain) as { epoch: string } | undefined;
    if (!d || d.epoch !== epoch) return 0;
    let wrote = 0;
    const ins = db.prepare(`INSERT OR IGNORE INTO log (domain, epoch, rev, txn, key, op, audience, agent, record, expires, at, end) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
    changes.forEach((c, i) => {
      const { key } = keyOf(c);
      const r = ins.run(domain, epoch, c.rev, c.txn, key, c.op, c.audience ? JSON.stringify(c.audience) : null, c.agent ?? null,
        c.record ? JSON.stringify(c.record) : null, c.expires ?? null, now, i === changes.length - 1 ? 1 : 0);
      if (!r.changes) return;
      wrote++;
      const cur = db.prepare('SELECT epoch, rev FROM idx WHERE key = ?').get(key) as { epoch: string; rev: number | null } | undefined;
      // Only forward: a lower revision in the same epoch never replaces a higher one.
      if (cur && cur.epoch === epoch && cur.rev !== null && c.rev !== null && c.rev <= cur.rev) return;
      if (c.op === 'delete') db.prepare('DELETE FROM idx WHERE key = ?').run(key);
      else db.prepare(`INSERT INTO idx (key, domain, epoch, rev, audience, agent, expires, record) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
                       ON CONFLICT (key) DO UPDATE SET domain = excluded.domain, epoch = excluded.epoch, rev = excluded.rev, audience = excluded.audience,
                       agent = excluded.agent, expires = excluded.expires, record = excluded.record`)
        .run(key, domain, epoch, c.rev, JSON.stringify(c.audience ?? {}), c.agent ?? null, c.expires ?? null, JSON.stringify(c.record ?? {}));
    });
    if (cursor) db.prepare('UPDATE domains SET rev = ?, txn = ? WHERE domain = ? AND epoch = ?').run(cursor.rev, cursor.txn, domain, epoch);
    return wrote;
  }).immediate();
}

/**
 * Seed the index from a snapshot core took as the core viewer (a domain's first pull starts at the provider's head, so
 * what's already there is known only this way): whole records, never over a row a change has written since.
 */
export function seedIndex(db: Database, domain: string, epoch: string, rows: ReadonlyArray<{ key: string; audience: Record<string, unknown>; agent?: string; expires?: number; record: Record<string, unknown> }>): void {
  db.transaction(() => {
    const d = db.prepare('SELECT epoch FROM domains WHERE domain = ?').get(domain) as { epoch: string } | undefined;
    if (!d || d.epoch !== epoch) return;
    const ins = db.prepare(`INSERT INTO idx (key, domain, epoch, rev, audience, agent, expires, record) VALUES (?, ?, ?, NULL, ?, ?, ?, ?) ON CONFLICT (key) DO NOTHING`);
    for (const r of rows) ins.run(r.key, domain, epoch, JSON.stringify(r.audience), r.agent ?? null, r.expires ?? null, JSON.stringify(r.record));
  }).immediate();
}

/** Move a domain's cursor without changes (a provider's head with nothing new, or a first pull's starting point). */
export function setCursor(db: Database, domain: string, epoch: string, rev: number, txn: string): void {
  db.prepare('UPDATE domains SET rev = ?, txn = ? WHERE domain = ? AND epoch = ?').run(rev, txn, domain, epoch);
}

export function setMode(db: Database, domain: string, epoch: string, mode: 'log' | 'bridge'): void {
  db.prepare('UPDATE domains SET mode = ? WHERE domain = ? AND epoch = ?').run(mode, domain, epoch);
}

/** The transaction the log holds at `rev` in this epoch, if it still holds that revision. */
export function txnAt(db: Database, domain: string, epoch: string, rev: number): { txn: string | null; seq: number } | undefined {
  return db.prepare('SELECT txn, seq FROM log WHERE domain = ? AND epoch = ? AND rev = ?').get(domain, epoch, rev) as { txn: string | null; seq: number } | undefined;
}

/** The oldest provider revision the log still holds for this epoch (undefined: none). */
export function oldestRev(db: Database, domain: string, epoch: string): number | undefined {
  return (db.prepare('SELECT MIN(rev) AS r FROM log WHERE domain = ? AND epoch = ? AND rev IS NOT NULL').get(domain, epoch) as { r: number | null }).r ?? undefined;
}

export const headSeq = (db: Database): number => (db.prepare('SELECT MAX(seq) AS s FROM log').get() as { s: number | null }).s ?? 0;

export interface LogRow { seq: number; domain: string; epoch: string; rev: number | null; txn: string | null; key: string; op: 'upsert' | 'delete'; audience: string | null; agent: string | null; record: string | null; expires: number | null; end: number }

/** Log rows after `seq`, in order, at most `limit`; a transaction that would be cut is left whole for the next read. */
export function rowsAfter(db: Database, seq: number, limit = 2000): LogRow[] {
  const rows = db.prepare('SELECT * FROM log WHERE seq > ? ORDER BY seq LIMIT ?').all(seq, limit) as LogRow[];
  if (rows.length === limit) {
    let cut = rows.length;
    while (cut > 0 && rows[cut - 1].end !== 1) cut--;
    if (cut > 0) return rows.slice(0, cut);
  }
  return rows;
}

/** The oldest row seq the log still holds for a domain (0: none). A subscription behind it has a gap. */
export function oldestSeq(db: Database, domain: string): number {
  return (db.prepare('SELECT MIN(seq) AS s FROM log WHERE domain = ?').get(domain) as { s: number | null }).s ?? 0;
}

/** Keep each domain's last LOG_KEEP changes or LOG_KEEP_MS, whichever is more, and never more than LOG_MAX. */
export function prune(db: Database, now = Date.now()): void {
  const domains = db.prepare('SELECT DISTINCT domain FROM log').all() as Array<{ domain: string }>;
  for (const { domain } of domains) {
    const nth = (n: number) => (db.prepare('SELECT seq FROM log WHERE domain = ? ORDER BY seq DESC LIMIT 1 OFFSET ?').get(domain, n - 1) as { seq: number } | undefined)?.seq;
    const keepFrom = nth(LOG_KEEP);
    if (keepFrom === undefined) continue;
    const recent = (db.prepare('SELECT MIN(seq) AS s FROM log WHERE domain = ? AND at >= ?').get(domain, now - LOG_KEEP_MS) as { s: number | null }).s;
    let from = recent !== null ? Math.min(keepFrom, recent) : keepFrom;
    const cap = nth(LOG_MAX);
    if (cap !== undefined) from = Math.max(from, cap);
    const gone = db.prepare('DELETE FROM log WHERE domain = ? AND seq < ?').run(domain, from);
    // A subscription whose cursor is below this has a gap (live.ts): it's reset rather than given a partial history.
    if (gone.changes) db.prepare('UPDATE domains SET pruned = MAX(pruned, ?) WHERE domain = ?').run(from - 1, domain);
  }
}

/** The highest row seq pruned from a domain's log (0: none): a subscription at or below it has a gap. */
export function prunedThrough(db: Database, domain: string): number {
  return (db.prepare('SELECT pruned FROM domains WHERE domain = ?').get(domain) as { pruned: number } | undefined)?.pruned ?? 0;
}

/** Someone said `domain` moved (a nudge): every listener pulling it sees the time. Unknown domains change nothing. */
export function markNudged(db: Database, domain: string, now = Date.now()): void {
  db.prepare('UPDATE domains SET nudged = ? WHERE domain = ?').run(now, domain);
}

/** Domains nudged after `since`. */
export function nudgedSince(db: Database, since: number): Array<{ domain: string; nudged: number }> {
  return db.prepare('SELECT domain, nudged FROM domains WHERE nudged > ?').all(since) as Array<{ domain: string; nudged: number }>;
}

/** The max row seq of a domain (0: none). */
export function domainHead(db: Database, domain: string): number {
  return (db.prepare('SELECT MAX(seq) AS s FROM log WHERE domain = ?').get(domain) as { s: number | null }).s ?? 0;
}

export function domainRow(db: Database, domain: string): DomainRow | undefined {
  return db.prepare('SELECT domain, epoch, rev, txn, source, mode FROM domains WHERE domain = ?').get(domain) as DomainRow | undefined;
}

/** The index's current rows of a domain (whole records as core last pulled them). */
export function indexOf(db: Database, domain: string): Array<{ key: string; epoch: string; rev: number | null; audience: string; agent: string | null; expires: number | null; record: string }> {
  return db.prepare('SELECT key, epoch, rev, audience, agent, expires, record FROM idx WHERE domain = ?').all(domain) as Array<{ key: string; epoch: string; rev: number | null; audience: string; agent: string | null; expires: number | null; record: string }>;
}

/**
 * Expired records (collections.md, "Expiry"): each one past its `expires` is logged as a delete of core's own (next in
 * the row order, no provider revision), only if the index still holds the revision that carried that `expires`: a
 * renewal since wins because it's newer. Answers the rows written.
 */
export function expire(db: Database, now = Date.now()): number {
  return db.transaction(() => {
    const due = db.prepare('SELECT key, domain, epoch, rev, expires FROM idx WHERE expires IS NOT NULL AND expires <= ?').all(now) as Array<{ key: string; domain: string; epoch: string; rev: number | null; expires: number }>;
    let n = 0;
    for (const d of due) {
      const gone = db.prepare('DELETE FROM idx WHERE key = ? AND epoch = ? AND rev IS ? AND expires = ?').run(d.key, d.epoch, d.rev, d.expires);
      if (!gone.changes) continue;
      db.prepare(`INSERT INTO log (domain, epoch, rev, txn, key, op, at, end) VALUES (?, ?, NULL, NULL, ?, 'delete', ?, 1)`).run(d.domain, d.epoch, d.key, now);
      n++;
    }
    return n;
  }).immediate();
}

/** Tell every listener there are new rows. */
export function tick(home: string): void {
  try { writeFileSync(join(home, 'collections', TICK), String(Date.now())); } catch { /* the listeners' poll finds them */ }
}

// ─── Operation receipts (docs/specs/collections.md, "Commands"; t-2024) ─────

export const RECEIPT_KEEP_MS = 24 * 60 * 60 * 1000;
/** An operation still `accepted` this long after it began never finished: it's `unknown`, and never run again. */
export const RECEIPT_STUCK_MS = 2 * 60 * 1000;

export type OpBegin = { fresh: true } | { state: 'accepted' | 'unknown' } | { answer: string } | { other: true };

/**
 * An action's operation id, as it begins: fresh (run it), already running or done (its stored answer: a retry never runs
 * an action twice), or another session's id (refused). Shared by every listener, so a retry that lands on another
 * one is the same operation.
 */
export function beginOp(db: Database, op: string, session: string, now = Date.now()): OpBegin {
  return db.transaction((): OpBegin => {
    db.prepare('DELETE FROM receipts WHERE at < ?').run(now - RECEIPT_KEEP_MS);
    const r = db.prepare('SELECT session, at, state, answer FROM receipts WHERE op = ?').get(op) as { session: string; at: number; state: string; answer: string | null } | undefined;
    if (!r) { db.prepare("INSERT INTO receipts (op, session, at, state) VALUES (?, ?, ?, 'accepted')").run(op, session, now); return { fresh: true }; }
    if (r.session !== session) return { other: true };
    if (r.answer !== null) return { answer: r.answer };
    return { state: now - r.at > RECEIPT_STUCK_MS ? 'unknown' : 'accepted' };
  }).immediate();
}

/** An operation's outcome and the answer a retry gets. */
export function finishOp(db: Database, op: string, session: string, state: 'done' | 'failed', answer: string): void {
  db.prepare('UPDATE receipts SET state = ?, answer = ? WHERE op = ? AND session = ?').run(state, answer, op, session);
}
