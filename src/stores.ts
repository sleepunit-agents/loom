/**
 * Piece storage (docs/specs/piece-storage.md): an extension's data lives in
 * loom, not in files it invents beside its code.
 *
 * Each piece has a store of its own, `commons/stores/<piece>.db`: collections of
 * JSON documents by key, every write a revision naming its writer, and a put
 * that names the revision it read fails if someone wrote in between. A piece
 * declares its collections in its package's `loom.store` (fixed at install, so a
 * running piece can't widen who may write), each with who may write it:
 *
 *   owner   only while the piece handles a household owner's page action:
 *           loom hands that call a grant, signed and short-lived
 *   piece   the piece's own code, whoever it's serving
 *   agent   an agent's calls through the piece, each agent its own keys (`<agent>/…`)
 *
 * A collection declared `"history": false` keeps no revisions: what's deleted
 * is gone (secure_delete overwrites it on disk too). For data in flight that
 * mustn't outlive its use, like the text of a message on its way to a body.
 *
 * The grant is what makes `owner` enforced rather than a convention for
 * anything outside loom's own machine (a house, another box): only loom holds
 * the key that signs it. A process running as loom's own user on loom's machine
 * can read that key, as it can read every other file of loom's; on that
 * machine this is the 2026-10-21 ruling's "security theater", said plainly.
 */
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import BetterSqlite3, { type Database } from 'better-sqlite3';

export const COLLECTION = /^[a-z][a-z0-9-]{0,39}$/;
export const KEY = /^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,199}$/;
export const PIECE = /^[a-z][a-z0-9-]{0,39}$/;
export const MAX_DOC_BYTES = 256 * 1024;
export const MAX_STORE_BYTES = 64 * 1024 * 1024;
const KEEP_REVISIONS = 20;
const GRANT_TTL_S = 300;

export type Writers = 'owner' | 'piece' | 'agent';
/** `history: false`: a collection that keeps no revisions, so a delete is gone (message text in flight). */
export type StoreDecl = Record<string, { writers: Writers; history?: false }>;

/** Who's acting: a household owner's page action, the piece itself, or the piece serving an agent. */
export interface Grant {
  piece: string;
  /** A household owner's action: may write `owner` collections. */
  owner?: boolean;
  /** The member who acted, recorded as the writer. */
  who?: string;
  /** The agent the piece is serving: may write its own keys of `agent` collections. */
  agent?: string;
  /** Seconds since the epoch. */
  exp: number;
}

export class StoreError extends Error {
  constructor(message: string, readonly status = 400) { super(message); }
}

export const storesDir = (home: string) => join(home, 'commons', 'stores');

// ─── grants ──────────────────────────────────────────────────────────────────

function key(home: string): Buffer {
  const p = join(home, 'store.key');
  if (!existsSync(p)) {
    mkdirSync(home, { recursive: true, mode: 0o700 });
    writeFileSync(p, randomBytes(32).toString('hex'), { mode: 0o600, flag: 'wx' });
  }
  return Buffer.from(readFileSync(p, 'utf-8').trim(), 'hex');
}

/** A grant for one call: given to the piece's process, good for GRANT_TTL_S. */
export function mintGrant(home: string, g: Omit<Grant, 'exp'>, nowS = Math.floor(Date.now() / 1000)): string {
  const body = Buffer.from(JSON.stringify({ ...g, exp: nowS + GRANT_TTL_S })).toString('base64url');
  return `${body}.${createHmac('sha256', key(home)).update(body).digest('base64url')}`;
}

/** The grant a token carries, if loom signed it and it hasn't expired; else null. */
export function readGrant(home: string, token: string | undefined, nowS = Math.floor(Date.now() / 1000)): Grant | null {
  if (!token || !/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(token)) return null;
  const [body, mac] = token.split('.');
  const want = createHmac('sha256', key(home)).update(body).digest();
  const got = Buffer.from(mac, 'base64url');
  if (got.length !== want.length || !timingSafeEqual(got, want)) return null;
  try {
    const g = JSON.parse(Buffer.from(body, 'base64url').toString('utf-8')) as Grant;
    return typeof g.piece === 'string' && PIECE.test(g.piece) && typeof g.exp === 'number' && g.exp > nowS ? g : null;
  } catch { return null; }
}

// ─── who may write ───────────────────────────────────────────────────────────

/** Why a write isn't allowed, or null when it is. */
export function mayWrite(decl: StoreDecl, collection: string, key: string, g: Grant): string | null {
  const c = decl[collection];
  if (!c) return `${g.piece} declares no collection ${collection}`;
  if (g.owner) return null;
  if (c.writers === 'owner') return `${collection} is written only by a household owner, on the page`;
  if (c.writers === 'agent' && g.agent !== undefined && !key.startsWith(`${g.agent}/`)) return `an agent writes only its own keys (${g.agent}/…)`;
  return null;
}

const writerOf = (g: Grant) => (g.owner ? (g.who ?? 'owner') : g.agent ? `agent:${g.agent}` : `piece:${g.piece}`);

// ─── the store ───────────────────────────────────────────────────────────────

export interface Doc { key: string; doc: unknown; rev: number; updated: string; by: string }
export interface Revision { id: number; key: string; rev: number; op: 'put' | 'del'; at: string; by: string }

export class PieceStore {
  private readonly db: Database;
  private readonly path: string;

  constructor(home: string, readonly piece: string, private readonly now: () => number = Date.now) {
    if (!PIECE.test(piece)) throw new StoreError(`no piece named ${piece}`);
    const dir = storesDir(home);
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    this.path = join(dir, `${piece}.db`);
    this.db = new BetterSqlite3(this.path);
    chmodSync(this.path, 0o600);
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('secure_delete = ON');
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS docs (collection TEXT NOT NULL, key TEXT NOT NULL, doc TEXT NOT NULL,
        rev INTEGER NOT NULL, updated TEXT NOT NULL, by TEXT NOT NULL, PRIMARY KEY (collection, key));
      CREATE TABLE IF NOT EXISTS revisions (id INTEGER PRIMARY KEY AUTOINCREMENT, collection TEXT NOT NULL,
        key TEXT NOT NULL, doc TEXT, rev INTEGER NOT NULL, op TEXT NOT NULL, at TEXT NOT NULL, by TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS revisions_doc ON revisions (collection, key, id);
    `);
  }

  close(): void { this.db.close(); }

  private check(collection: string, key?: string): void {
    if (!COLLECTION.test(collection)) throw new StoreError('a collection is lowercase letters, digits and dashes');
    if (key !== undefined && !KEY.test(key)) throw new StoreError('a key is up to 200 letters, digits and . _ : @ / -');
  }

  get(collection: string, key: string): Doc | null {
    this.check(collection, key);
    const r = this.db.prepare('SELECT key, doc, rev, updated, by FROM docs WHERE collection = ? AND key = ?').get(collection, key) as
      { key: string; doc: string; rev: number; updated: string; by: string } | undefined;
    return r ? { ...r, doc: JSON.parse(r.doc) } : null;
  }

  list(collection: string, opts: { prefix?: string; limit?: number } = {}): Doc[] {
    this.check(collection);
    const limit = Math.min(Math.max(opts.limit ?? 100, 1), 1000);
    const rows = (opts.prefix
      ? this.db.prepare('SELECT key, doc, rev, updated, by FROM docs WHERE collection = ? AND substr(key, 1, ?) = ? ORDER BY key LIMIT ?').all(collection, opts.prefix.length, opts.prefix, limit)
      : this.db.prepare('SELECT key, doc, rev, updated, by FROM docs WHERE collection = ? ORDER BY key LIMIT ?').all(collection, limit)) as
      Array<{ key: string; doc: string; rev: number; updated: string; by: string }>;
    return rows.map((r) => ({ ...r, doc: JSON.parse(r.doc) }));
  }

  /** Write a whole document. `ifRev` (0: must not exist yet) makes it compare-and-swap. Returns the new revision number. */
  put(collection: string, key: string, doc: unknown, g: Grant, decl: StoreDecl, ifRev?: number): number {
    this.check(collection, key);
    const no = mayWrite(decl, collection, key, g);
    if (no) throw new StoreError(no, 403);
    const text = JSON.stringify(doc);
    if (text === undefined) throw new StoreError('a document is JSON');
    if (Buffer.byteLength(text) > MAX_DOC_BYTES) throw new StoreError(`a document is ${MAX_DOC_BYTES / 1024} KB at most`, 413);
    return this.db.transaction(() => {
      const cur = this.db.prepare('SELECT rev FROM docs WHERE collection = ? AND key = ?').get(collection, key) as { rev: number } | undefined;
      if (ifRev !== undefined && (cur?.rev ?? 0) !== ifRev) throw new StoreError(`${collection}/${key} is at revision ${cur?.rev ?? 0}, not ${ifRev}: read it again`, 409);
      if (this.size() + Buffer.byteLength(text) > MAX_STORE_BYTES) throw new StoreError(`${this.piece}'s store is full (${MAX_STORE_BYTES / 1048576} MB)`, 413);
      const rev = (cur?.rev ?? 0) + 1;
      const at = new Date(this.now()).toISOString();
      const by = writerOf(g);
      this.db.prepare('INSERT INTO docs (collection, key, doc, rev, updated, by) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT (collection, key) DO UPDATE SET doc = excluded.doc, rev = excluded.rev, updated = excluded.updated, by = excluded.by')
        .run(collection, key, text, rev, at, by);
      this.revision(collection, key, text, rev, 'put', at, by, decl);
      return rev;
    })();
  }

  del(collection: string, key: string, g: Grant, decl: StoreDecl, ifRev?: number): boolean {
    this.check(collection, key);
    const no = mayWrite(decl, collection, key, g);
    if (no) throw new StoreError(no, 403);
    return this.db.transaction(() => {
      const cur = this.db.prepare('SELECT rev FROM docs WHERE collection = ? AND key = ?').get(collection, key) as { rev: number } | undefined;
      if (!cur) return false;
      if (ifRev !== undefined && cur.rev !== ifRev) throw new StoreError(`${collection}/${key} is at revision ${cur.rev}, not ${ifRev}: read it again`, 409);
      const at = new Date(this.now()).toISOString();
      this.db.prepare('DELETE FROM docs WHERE collection = ? AND key = ?').run(collection, key);
      this.revision(collection, key, null, cur.rev + 1, 'del', at, writerOf(g), decl);
      return true;
    })();
  }

  history(collection: string, key: string): Revision[] {
    this.check(collection, key);
    return this.db.prepare('SELECT id, key, rev, op, at, by FROM revisions WHERE collection = ? AND key = ? ORDER BY id DESC').all(collection, key) as Revision[];
  }

  /** Put a document back as it was at a revision (itself a new revision, by whoever reverts). */
  revert(collection: string, key: string, id: number, g: Grant, decl: StoreDecl): number {
    const r = this.db.prepare('SELECT doc FROM revisions WHERE id = ? AND collection = ? AND key = ?').get(id, collection, key) as { doc: string | null } | undefined;
    if (!r) throw new StoreError(`no revision ${id} of ${collection}/${key}`, 404);
    if (r.doc === null) {
      this.del(collection, key, g, decl);
      return 0;
    }
    return this.put(collection, key, JSON.parse(r.doc), g, decl);
  }

  private revision(collection: string, key: string, doc: string | null, rev: number, op: 'put' | 'del', at: string, by: string, decl: StoreDecl): void {
    if (decl[collection]?.history === false) {
      this.db.prepare('DELETE FROM revisions WHERE collection = ? AND key = ?').run(collection, key);
      return;
    }
    this.db.prepare('INSERT INTO revisions (collection, key, doc, rev, op, at, by) VALUES (?, ?, ?, ?, ?, ?, ?)').run(collection, key, doc, rev, op, at, by);
    // A document keeps its last few revisions: enough to see and undo, not a second copy of everything.
    this.db.prepare(`DELETE FROM revisions WHERE collection = ? AND key = ? AND id NOT IN
      (SELECT id FROM revisions WHERE collection = ? AND key = ? ORDER BY id DESC LIMIT ${KEEP_REVISIONS})`).run(collection, key, collection, key);
  }

  private size(): number {
    try { return statSync(this.path).size; } catch { return 0; }
  }
}

/** A piece's declared collections, from its package's `loom.store` (validated at install). */
export function parseStoreDecl(v: unknown): StoreDecl | string {
  if (v === undefined) return {};
  if (!v || typeof v !== 'object' || Array.isArray(v)) return 'loom.store maps collection names to {"writers": "owner" | "piece" | "agent"}';
  const out: StoreDecl = {};
  const entries = Object.entries(v as Record<string, unknown>);
  if (entries.length > 32) return 'loom.store declares at most 32 collections';
  for (const [name, c] of entries) {
    const w = (c as { writers?: unknown } | null)?.writers;
    const h = (c as { history?: unknown } | null)?.history;
    if (!COLLECTION.test(name) || (w !== 'owner' && w !== 'piece' && w !== 'agent')) {
      return `loom.store.${name}: a collection is lowercase letters, digits and dashes, and its writers are owner, piece or agent`;
    }
    if (h !== undefined && h !== false) return `loom.store.${name}.history: false keeps no revisions; leave it out to keep them`;
    // An owner collection's history is how a bad save is undone: it always keeps it.
    if (h === false && w === 'owner') return `loom.store.${name}: an owner collection keeps its history`;
    out[name] = h === false ? { writers: w, history: false } : { writers: w };
  }
  return out;
}
