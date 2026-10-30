/**
 * Notes (Jonathan, 2026-10-30): what an agent holds on to for a while — a plan, a brief, a write-up, a run's
 * evidence, a making session's frames — and some words about it. "loom on its own should effectively bring art back
 * anywhere. the house is a convenience thing ... 99.99% of what really matters should live in loom." Before this,
 * notes were files in a git checkout on loom's machine (~/Art/notes), which was neither loom nor safe to write in.
 *
 * Each agent has its own: `<agent dir>/notes.db`, and the attachments, stored once by content, in
 * `<agent dir>/note-files/`. Both travel in the bundle with the rest of the agent's directory.
 *
 * A note isn't an archive. It has a lifespan, set when it's written:
 *
 *   keep    a ruling, a write-up: never expires
 *   while   a lane's journal (a plan, a brief, a triage): LIFESPAN_DAYS.while after its last change
 *   short   a run's evidence, logs, scratch worth a look: LIFESPAN_DAYS.short after its last change
 *
 * and `sweep` lets the expired ones go, except what's still cited: a note a live memory or a knowledge page points
 * at stays (Jonathan: "I'm assuming a lot of this is basically scratch stuff. none of it is keep forever"). A pinned
 * note stays too. A citation is the note's path after `note:` or after the old `notes/` prefix, with or without
 * `.md`, or a path inside it (one of its files); one ending in `/` keeps everything under it.
 */
import { createHash } from 'node:crypto';
import { chmodSync, closeSync, copyFileSync, existsSync, mkdirSync, openSync, readdirSync, readSync, renameSync, rmSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import BetterSqlite3, { type Database } from 'better-sqlite3';
import { resolveKnowledgeDbPath } from './config.js';

export type Lifespan = 'keep' | 'while' | 'short';
export const LIFESPANS: ReadonlySet<string> = new Set(['keep', 'while', 'short']);
export const LIFESPAN_DAYS: Record<Exclude<Lifespan, 'keep'>, number> = { while: 60, short: 14 };
/** Up to six segments of letters, digits and . _ - (no segment starting with a dot): `homelab/2026-10-30-dns-health`. */
export const NOTE_PATH = /^(?!.*(^|\/)\.)[A-Za-z0-9][A-Za-z0-9._-]{0,99}(\/[A-Za-z0-9][A-Za-z0-9._-]{0,99}){0,5}$/;
/** A file's name inside its note: one segment, the same letters. */
export const FILE_NAME = /^(?!\.)[A-Za-z0-9][A-Za-z0-9._ -]{0,149}$/;
export const MAX_NOTE_BYTES = 1024 * 1024;
export const MAX_FILE_BYTES = 512 * 1024 * 1024;
const KEEP_REVISIONS = 20;

export class NoteError extends Error {
  constructor(message: string, readonly status = 400) { super(message); }
}

export interface NoteFile { name: string; sha256: string; bytes: number; type?: string; added: string }
export interface NoteRow { path: string; lifespan: Lifespan; pinned: boolean; created: string; updated: string; by: string; bytes: number; files: number; expires: string | null }
export interface Note extends NoteRow { body: string; fileList: NoteFile[] }

export const notesDbPath = (dir: string) => join(dir, 'notes.db');
export const noteFilesDir = (dir: string) => join(dir, 'note-files');
const blobPath = (dir: string, sha: string) => join(noteFilesDir(dir), sha.slice(0, 2), sha);

/** When a note lets go: never for keep, else its lifespan after its last change. */
export function expiresAt(lifespan: Lifespan, updated: string): string | null {
  if (lifespan === 'keep') return null;
  return new Date(Date.parse(updated) + LIFESPAN_DAYS[lifespan] * 86_400_000).toISOString();
}

export class Notes {
  private readonly db: Database;

  constructor(readonly dir: string, private readonly now: () => number = Date.now) {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const path = notesDbPath(dir);
    this.db = new BetterSqlite3(path);
    chmodSync(path, 0o600);
    this.db.pragma('journal_mode = WAL');
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS notes (path TEXT PRIMARY KEY, body TEXT NOT NULL, lifespan TEXT NOT NULL,
        pinned INTEGER NOT NULL DEFAULT 0, created TEXT NOT NULL, updated TEXT NOT NULL, by TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS note_revisions (id INTEGER PRIMARY KEY AUTOINCREMENT, path TEXT NOT NULL,
        body TEXT, lifespan TEXT NOT NULL, at TEXT NOT NULL, by TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS note_revisions_path ON note_revisions (path, id);
      CREATE TABLE IF NOT EXISTS note_files (path TEXT NOT NULL, name TEXT NOT NULL, sha256 TEXT NOT NULL,
        bytes INTEGER NOT NULL, type TEXT, added TEXT NOT NULL, PRIMARY KEY (path, name));
    `);
  }

  close(): void { this.db.close(); }

  private iso(): string { return new Date(this.now()).toISOString(); }

  private check(path: string): void {
    if (!NOTE_PATH.test(path) || path.length > 300) throw new NoteError('a note path is up to six segments of letters, digits and . _ - (homelab/2026-10-30-dns-health)');
  }

  /**
   * Write a note, whole. A new note needs its lifespan; an existing one keeps its own unless given another. Every
   * write keeps the old text as a revision (the last KEEP_REVISIONS).
   */
  write(path: string, body: string, opts: { lifespan?: Lifespan; by: string }): NoteRow {
    this.check(path);
    if (Buffer.byteLength(body) > MAX_NOTE_BYTES) throw new NoteError(`a note's text is at most ${MAX_NOTE_BYTES / 1024} KB; put more in a file`);
    if (opts.lifespan !== undefined && !LIFESPANS.has(opts.lifespan)) throw new NoteError('a lifespan is keep, while or short');
    const at = this.iso();
    const tx = this.db.transaction(() => {
      const was = this.db.prepare('SELECT body, lifespan FROM notes WHERE path = ?').get(path) as { body: string; lifespan: Lifespan } | undefined;
      if (!was && !opts.lifespan) throw new NoteError('a new note needs its lifespan: keep, while or short');
      const lifespan = opts.lifespan ?? was!.lifespan;
      if (was) {
        this.db.prepare('INSERT INTO note_revisions (path, body, lifespan, at, by) VALUES (?, ?, ?, ?, ?)').run(path, was.body, was.lifespan, at, opts.by);
        this.db.prepare('DELETE FROM note_revisions WHERE path = ? AND id NOT IN (SELECT id FROM note_revisions WHERE path = ? ORDER BY id DESC LIMIT ?)').run(path, path, KEEP_REVISIONS);
        this.db.prepare('UPDATE notes SET body = ?, lifespan = ?, updated = ?, by = ? WHERE path = ?').run(body, lifespan, at, opts.by, path);
      } else {
        this.db.prepare('INSERT INTO notes (path, body, lifespan, created, updated, by) VALUES (?, ?, ?, ?, ?, ?)').run(path, body, lifespan, at, at, opts.by);
      }
    });
    tx();
    return this.row(path)!;
  }

  private row(path: string): NoteRow | null {
    const r = this.db.prepare(`SELECT path, lifespan, pinned, created, updated, by, length(CAST(body AS BLOB)) AS bytes,
      (SELECT COUNT(*) FROM note_files f WHERE f.path = notes.path) AS files FROM notes WHERE path = ?`).get(path) as
      (Omit<NoteRow, 'pinned' | 'expires'> & { pinned: number }) | undefined;
    return r ? { ...r, pinned: !!r.pinned, expires: r.pinned ? null : expiresAt(r.lifespan, r.updated) } : null;
  }

  read(path: string): Note | null {
    this.check(path);
    const r = this.row(path);
    if (!r) return null;
    const { body } = this.db.prepare('SELECT body FROM notes WHERE path = ?').get(path) as { body: string };
    const fileList = this.db.prepare('SELECT name, sha256, bytes, type, added FROM note_files WHERE path = ? ORDER BY name').all(path) as NoteFile[];
    return { ...r, body, fileList: fileList.map((f) => (f.type ? f : { name: f.name, sha256: f.sha256, bytes: f.bytes, added: f.added })) };
  }

  /** The notes under a prefix (a folder, `planning/`), newest first; no text. */
  list(opts: { prefix?: string; limit?: number } = {}): NoteRow[] {
    const prefix = (opts.prefix ?? '').replace(/\/+$/, '');
    if (prefix && !NOTE_PATH.test(prefix)) throw new NoteError('a prefix is a note path or a folder of them');
    const paths = (prefix
      ? this.db.prepare("SELECT path FROM notes WHERE path = ? OR path LIKE ? ESCAPE '\\' ORDER BY updated DESC LIMIT ?").all(prefix, `${prefix.replace(/[\\%_]/g, '\\$&')}/%`, opts.limit ?? 500)
      : this.db.prepare('SELECT path FROM notes ORDER BY updated DESC LIMIT ?').all(opts.limit ?? 500)) as Array<{ path: string }>;
    return paths.map((p) => this.row(p.path)!);
  }

  /** Attach a file to a note (the note must exist). The bytes are stored once, by their sha256; a name is replaced. */
  attach(path: string, name: string, from: string, opts: { type?: string } = {}): NoteFile {
    this.check(path);
    if (!FILE_NAME.test(name)) throw new NoteError("a file's name is one segment of letters, digits and . _ - and spaces");
    if (!this.row(path)) throw new NoteError(`there's no note ${path} to attach to`, 404);
    const st = statSync(from);
    if (!st.isFile()) throw new NoteError(`${from} isn't a file`);
    if (st.size > MAX_FILE_BYTES) throw new NoteError(`a file is at most ${MAX_FILE_BYTES / 1024 / 1024} MB`);
    const sha = sha256File(from);
    const to = blobPath(this.dir, sha);
    if (!existsSync(to)) {
      mkdirSync(dirname(to), { recursive: true, mode: 0o700 });
      const tmp = `${to}.loom.tmp`;
      copyFileSync(from, tmp);
      chmodSync(tmp, 0o600);
      renameSync(tmp, to);
    }
    const f: NoteFile = { name, sha256: sha, bytes: st.size, ...(opts.type ? { type: opts.type } : {}), added: this.iso() };
    this.db.prepare('INSERT INTO note_files (path, name, sha256, bytes, type, added) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT (path, name) DO UPDATE SET sha256 = excluded.sha256, bytes = excluded.bytes, type = excluded.type, added = excluded.added')
      .run(path, name, sha, st.size, opts.type ?? null, f.added);
    this.collect();
    return f;
  }

  /** Where a note's file's bytes are on disk (read it there; never write it). */
  filePath(path: string, name: string): string | null {
    const r = this.db.prepare('SELECT sha256 FROM note_files WHERE path = ? AND name = ?').get(path, name) as { sha256: string } | undefined;
    return r ? blobPath(this.dir, r.sha256) : null;
  }

  pin(path: string, pinned: boolean): NoteRow {
    this.check(path);
    if (!this.db.prepare('UPDATE notes SET pinned = ? WHERE path = ?').run(pinned ? 1 : 0, path).changes) throw new NoteError(`no note ${path}`, 404);
    return this.row(path)!;
  }

  delete(path: string): boolean {
    this.check(path);
    const gone = this.db.transaction(() => {
      this.db.prepare('DELETE FROM note_files WHERE path = ?').run(path);
      this.db.prepare('DELETE FROM note_revisions WHERE path = ?').run(path);
      return this.db.prepare('DELETE FROM notes WHERE path = ?').run(path).changes > 0;
    })();
    this.collect();
    return gone;
  }

  /**
   * Let the expired notes go: past their lifespan, not pinned, and not cited (`cited`: what memories, knowledge pages
   * and anything else the caller knows of point at; see citedPaths). Returns what went, and what was kept for being
   * cited. With `dryRun`, nothing goes.
   */
  sweep(cited: Iterable<string>, opts: { dryRun?: boolean } = {}): { gone: string[]; keptCited: string[] } {
    const refs = normaliseRefs(cited);
    const now = this.now();
    const due = (this.db.prepare("SELECT path, lifespan, updated FROM notes WHERE pinned = 0 AND lifespan != 'keep'").all() as Array<{ path: string; lifespan: Lifespan; updated: string }>)
      .filter((n) => Date.parse(expiresAt(n.lifespan, n.updated)!) <= now);
    const gone: string[] = [];
    const keptCited: string[] = [];
    for (const n of due) {
      if (isCited(n.path, refs)) keptCited.push(n.path);
      else gone.push(n.path);
    }
    if (!opts.dryRun) {
      const tx = this.db.transaction(() => {
        for (const p of gone) {
          this.db.prepare('DELETE FROM note_files WHERE path = ?').run(p);
          this.db.prepare('DELETE FROM note_revisions WHERE path = ?').run(p);
          this.db.prepare('DELETE FROM notes WHERE path = ?').run(p);
        }
      });
      tx();
      this.collect();
    }
    return { gone, keptCited };
  }

  /** Remove the stored bytes no note's file names any more. */
  private collect(): void {
    const live = new Set((this.db.prepare('SELECT DISTINCT sha256 FROM note_files').all() as Array<{ sha256: string }>).map((r) => r.sha256));
    const root = noteFilesDir(this.dir);
    if (!existsSync(root)) return;
    for (const d of readdirSync(root)) {
      const sub = join(root, d);
      for (const f of readdirSync(sub)) if (!live.has(f) && !f.endsWith('.loom.tmp')) rmSync(join(sub, f), { force: true });
    }
  }
}

function sha256File(path: string): string {
  const h = createHash('sha256');
  const fd = openSync(path, 'r');
  try {
    const buf = Buffer.allocUnsafe(1 << 20);
    for (;;) {
      const n = readSync(fd, buf, 0, buf.length, null);
      if (!n) break;
      h.update(buf.subarray(0, n));
    }
  } finally { closeSync(fd); }
  return h.digest('hex');
}

/** `notes/homelab/x.md`, `note:homelab/x`, `homelab/x/` → the paths and folders they name. */
function normaliseRefs(cited: Iterable<string>): { exact: Set<string>; folders: string[] } {
  const exact = new Set<string>();
  const folders: string[] = [];
  for (const raw of cited) {
    let r = raw.trim().replace(/^note:/, '').replace(/^notes\//, '').replace(/[)\].,;:`'"*>]+$/, '');
    if (!r) continue;
    if (r.endsWith('/')) { folders.push(r); continue; }
    r = r.replace(/\.md$/, '');
    exact.add(r);
  }
  return { exact, folders };
}

/** A note is cited by its own path, by a path inside it (one of its files), or by a folder it's under. */
function isCited(path: string, refs: { exact: Set<string>; folders: string[] }): boolean {
  if (refs.exact.has(path)) return true;
  for (const r of refs.exact) if (r.startsWith(`${path}/`)) return true;
  return refs.folders.some((f) => path.startsWith(f));
}

const CITE = /(?:\bnote:|\bnotes\/)[A-Za-z0-9][A-Za-z0-9._\/-]*/g;

/**
 * Every note path an agent's live memories and the knowledge pages cite: what sweep must keep. Read straight from
 * the databases (read-only), so a sweep needs no running server.
 */
export function citedPaths(contextDir: string): Set<string> {
  const out = new Set<string>();
  const scan = (db: string, sql: string) => {
    if (!existsSync(db)) return;
    const d = new BetterSqlite3(db, { readonly: true, fileMustExist: true });
    try {
      for (const row of d.prepare(sql).raw().iterate() as Iterable<unknown[]>) {
        for (const v of row) if (typeof v === 'string') for (const m of v.match(CITE) ?? []) out.add(m);
      }
    } catch { /* a stack without that table: nothing it cites */ } finally { d.close(); }
  };
  scan(join(contextDir, 'memories.db'), 'SELECT title, content FROM memories WHERE archived = 0');
  scan(resolveKnowledgeDbPath(contextDir), "SELECT title, body FROM pages WHERE status = 'active'");
  return out;
}
