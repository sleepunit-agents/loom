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
 * `.md`, or a path inside it (one of its files). A folder named in passing ("lanes write to notes/planning/") cites
 * nothing under it: that would keep a whole folder of scratch for one mention.
 */
import { DAY_MS } from './core/day.js';
import { createHash } from 'node:crypto';
import { chmodSync, closeSync, constants, fstatSync, existsSync, mkdirSync, openSync, readdirSync, readSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { SHA256_HEX } from './core/sha256-hex.js';
import BetterSqlite3, { type Database } from 'better-sqlite3';

/** How long a note is kept, once: the store, the `memory.noteWrite` command and the terminal's `note_write` read this. */
export const LIFESPAN_NAMES = ['keep', 'while', 'short'] as const;
export type Lifespan = (typeof LIFESPAN_NAMES)[number];
export const LIFESPANS: ReadonlySet<string> = new Set(LIFESPAN_NAMES);
export const LIFESPAN_DAYS: Record<Exclude<Lifespan, 'keep'>, number> = { while: 60, short: 14 };
/** Up to six segments of letters, digits and . _ - (no segment starting with a dot): `homelab/2026-10-30-dns-health`. */
export const NOTE_PATH = /^(?!.*(^|\/)\.)[A-Za-z0-9][A-Za-z0-9._-]{0,99}(\/[A-Za-z0-9][A-Za-z0-9._-]{0,99}){0,5}$/;
/** A file's name inside its note: one segment, the same letters. */
export const FILE_NAME = /^(?!\.)[A-Za-z0-9][A-Za-z0-9._ -]{0,149}$/;
/** And no longer than this in all. */
export const NOTE_PATH_MAX = 300;
export const MAX_NOTE_BYTES = 1024 * 1024;
/**
 * Notes travel in the household bundle, which is pushed nightly to a git host that refuses a file over 100 MB
 * (art's art-loom-bundle: 97.8 MB on 2026-10-30). So a note's file is small: a screenshot, a bench script, a log.
 * Audio, video and big renders live outside loom, and a note links to them.
 */
export const MAX_FILE_BYTES = 10 * 1024 * 1024;
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
  return new Date(Date.parse(updated) + LIFESPAN_DAYS[lifespan] * DAY_MS).toISOString();
}

/** The notes store's version, kept in the file header (PRAGMA user_version). A change to its tables raises it. */
const NOTES_VERSION = 1;

export class Notes {
  private readonly db: Database;

  constructor(readonly dir: string, private readonly now: () => number = Date.now, options: {prepared?:boolean;readonly?:boolean} = {}) {
    if(!options.prepared && !options.readonly)mkdirSync(dir, { recursive: true, mode: 0o700 });
    const path = notesDbPath(dir);
    this.db = new BetterSqlite3(path, {readonly:!!options.readonly,fileMustExist:!!(options.prepared || options.readonly),timeout:options.prepared?0:5000});
    // Before anything is created or written: a store a newer program has changed is left as it is.
    const at = this.db.pragma('user_version', { simple: true }) as number;
    if (at > NOTES_VERSION) { this.db.close(); throw new Error(`This notes store is from a newer program (version ${at}; this program knows ${NOTES_VERSION})`); }
    if(options.prepared || options.readonly)return;
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
    if (at !== NOTES_VERSION) this.db.pragma(`user_version = ${NOTES_VERSION}`);
  }

  private collectAfterWrite = false;

  close(): void { this.db.close(); }

  /** A native command owns this connection and commits its receipt with its note. */
  atomicWrite<T>(run:(db:Database)=>T):T {
    try {
      return this.db.transaction(()=>run(this.db)).immediate();
    } finally {
      // Files do not roll back with SQLite. Collect against the committed references only,
      // after the outermost write (including a failed receipt) releases its transaction.
      if (!this.db.inTransaction && this.collectAfterWrite) {
        try {
          this.db.transaction(()=>this.collect()).immediate();
          this.collectAfterWrite = false;
        } catch (error) {
          // A competing writer can win the lock after commit. Its references are still safe;
          // leave collection pending for the next write rather than reporting a failed save.
          if (!(error instanceof BetterSqlite3.SqliteError && error.code.startsWith('SQLITE_BUSY'))) throw error;
        }
      }
    }
  }

  private iso(): string { return new Date(this.now()).toISOString(); }

  private check(path: string): void {
    if (!NOTE_PATH.test(path) || path.length > NOTE_PATH_MAX) throw new NoteError('a note path is up to six segments of letters, digits and . _ - (homelab/2026-10-30-dns-health)');
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
    const columns = `SELECT path, lifespan, pinned, created, updated, by, length(CAST(body AS BLOB)) AS bytes,
      (SELECT COUNT(*) FROM note_files f WHERE f.path = notes.path) AS files FROM notes`;
    const rows = (prefix
      ? this.db.prepare(`${columns} WHERE path = ? OR path LIKE ? ESCAPE '\\' ORDER BY updated DESC LIMIT ?`).all(prefix, `${prefix.replace(/[\\%_]/g, '\\$&')}/%`, opts.limit ?? 500)
      : this.db.prepare(`${columns} ORDER BY updated DESC LIMIT ?`).all(opts.limit ?? 500)) as Array<Omit<NoteRow, 'pinned' | 'expires'> & { pinned: number }>;
    return rows.map((r) => ({ ...r, pinned: !!r.pinned, expires: r.pinned ? null : expiresAt(r.lifespan, r.updated) }));
  }

  /** Attach a file to a note (the note must exist). The bytes are stored once, by their sha256; a name is replaced. */
  attach(path: string, name: string, from: string | Buffer, opts: { type?: string } = {}): NoteFile {
    this.check(path);
    if (!FILE_NAME.test(name)) throw new NoteError("a file's name is one segment of letters, digits and . _ - and spaces");
    return this.atomicWrite(() => {
      if (!this.row(path)) throw new NoteError(`there's no note ${path} to attach to`, 404);
      if (typeof from !== 'string' && from.length > MAX_FILE_BYTES) throw new NoteError(`a file is at most ${MAX_FILE_BYTES / 1024 / 1024} MB`);
      const bytes = typeof from === 'string' ? readAttachment(from) : Buffer.from(from);
      const sha = createHash('sha256').update(bytes).digest('hex');
      const to = blobPath(this.dir, sha);
      this.collectAfterWrite = true;
      if (!existsSync(to)) {
        mkdirSync(dirname(to), { recursive: true, mode: 0o700 });
        const tmp = `${to}.loom.tmp`;
        try {
          writeFileSync(tmp, bytes, {mode:0o600});
          renameSync(tmp, to);
        } finally { rmSync(tmp, {force:true}); }
      }
      const f: NoteFile = { name, sha256: sha, bytes: bytes.length, ...(opts.type ? { type: opts.type } : {}), added: this.iso() };
      this.db.prepare('INSERT INTO note_files (path, name, sha256, bytes, type, added) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT (path, name) DO UPDATE SET sha256 = excluded.sha256, bytes = excluded.bytes, type = excluded.type, added = excluded.added')
        .run(path, name, sha, bytes.length, opts.type ?? null, f.added);
      return f;
    });
  }

  /** Where a note's file's bytes are on disk (read it there; never write it). */
  filePath(path: string, name: string): string | null {
    const r = this.db.prepare('SELECT sha256 FROM note_files WHERE path = ? AND name = ?').get(path, name) as { sha256: string } | undefined;
    return r ? blobPath(this.dir, r.sha256) : null;
  }

  /** Return only bytes verified against this name's stored attachment manifest. */
  fileContents(path: string, name: string): {sha256:string;bytes:Buffer}|null {
    this.check(path);
    if(!FILE_NAME.test(name))throw new NoteError('Invalid attachment name');
    const file=this.db.prepare('SELECT sha256, bytes FROM note_files WHERE path = ? AND name = ?').get(path,name) as {sha256:string;bytes:number}|undefined;
    if(!file)return null;
    if(!SHA256_HEX.test(file.sha256)||!Number.isInteger(file.bytes)||file.bytes<0||file.bytes>MAX_FILE_BYTES)throw new NoteError('Invalid attachment manifest');
    const bytes=readAttachment(blobPath(this.dir,file.sha256),constants.O_NOFOLLOW);
    if(bytes.length!==file.bytes||createHash('sha256').update(bytes).digest('hex')!==file.sha256){
      bytes.fill(0);
      throw new NoteError('Attachment differs from its manifest');
    }
    return {sha256:file.sha256,bytes};
  }

  pin(path: string, pinned: boolean): NoteRow {
    this.check(path);
    if (!this.db.prepare('UPDATE notes SET pinned = ? WHERE path = ?').run(pinned ? 1 : 0, path).changes) throw new NoteError(`no note ${path}`, 404);
    return this.row(path)!;
  }

  delete(path: string): boolean {
    this.check(path);
    return this.atomicWrite(() => {
      this.collectAfterWrite = true;
      this.db.prepare('DELETE FROM note_files WHERE path = ?').run(path);
      this.db.prepare('DELETE FROM note_revisions WHERE path = ?').run(path);
      return this.db.prepare('DELETE FROM notes WHERE path = ?').run(path).changes > 0;
    });
  }

  /**
   * Let the expired notes go: past their lifespan, not pinned, and not cited (`cited`: what memories, knowledge pages
   * and anything else the caller knows of point at; see citedPaths). Returns what went, and what was kept for being
   * cited. With `dryRun`, nothing goes.
   */
  sweep(cited: Iterable<string>, opts: { dryRun?: boolean } = {}): { gone: string[]; keptCited: string[] } {
    const refs = normaliseRefs(cited);
    const plan = () => {
      const now = this.now();
      const due = this.db.prepare("SELECT path, lifespan, updated FROM notes WHERE pinned = 0 AND lifespan != 'keep'")
        .all() as Array<{ path: string; lifespan: Lifespan; updated: string }>;
      const gone: string[] = [], keptCited: string[] = [];
      for (const note of due) {
        const expiry = Date.parse(expiresAt(note.lifespan, note.updated)!);
        if (!(expiry <= now)) continue;
        (isCited(note.path, refs) ? keptCited : gone).push(note.path);
      }
      return { gone, keptCited };
    };
    if (opts.dryRun) return plan();
    return this.atomicWrite(() => {
      this.collectAfterWrite = true;
      const result = plan();
      for (const path of result.gone) {
        this.db.prepare('DELETE FROM note_files WHERE path = ?').run(path);
        this.db.prepare('DELETE FROM note_revisions WHERE path = ?').run(path);
        this.db.prepare('DELETE FROM notes WHERE path = ?').run(path);
      }
      return result;
    });
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

/** The metadata and blob must describe the same bytes even if a local producer changes its file. */
function readAttachment(path: string, flags=0): Buffer {
  const fd = openSync(path, constants.O_RDONLY | constants.O_NONBLOCK | flags);
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile()) throw new NoteError(`${path} isn't a file`);
    if (stat.size > MAX_FILE_BYTES) throw new NoteError(`a file is at most ${MAX_FILE_BYTES / 1024 / 1024} MB`);
    const bytes = Buffer.alloc(stat.size);
    let offset = 0;
    while (offset < bytes.length) {
      const count = readSync(fd, bytes, offset, bytes.length-offset, null);
      if (!count) throw new NoteError('attachment changed while reading');
      offset += count;
    }
    if (readSync(fd, Buffer.alloc(1), 0, 1, null)) throw new NoteError('attachment changed while reading');
    return bytes;
  } finally { closeSync(fd); }
}

/** `notes/homelab/x.md`, `note:homelab/x` → the paths they name; a folder (ending in `/`) names none. */
function normaliseRefs(cited: Iterable<string>): Set<string> {
  const exact = new Set<string>();
  for (const raw of cited) {
    const literal = raw.trim().replace(/^(?:note:|notes\/)/, '');
    const r = literal.replace(/[)\].,;:`'"*>]+$/, '');
    if (r && !r.endsWith('/')) {
      exact.add(literal);
      exact.add(r);
      exact.add(r.replace(/\.md$/, ''));
    }
  }
  return exact;
}

/** A note is cited by its own path, or by a path inside it (one of its files). */
function isCited(path: string, refs: Set<string>): boolean {
  if (refs.has(path)) return true;
  for (const r of refs) if (r.startsWith(`${path}/`)) return true;
  return false;
}
