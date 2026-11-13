import { createHash } from 'node:crypto';
import { closeSync, existsSync, fchmodSync, lstatSync, mkdirSync, openSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { parseArgs } from 'node:util';
import Database from 'better-sqlite3';
import type { IOStreams } from './io.js';

export interface SnapshotManifest {
  version: 1;
  consistency: 'per-database';
  files: { path: string; sha256: string; bytes: number; kind: 'sqlite' | 'file' }[];
}
const hash = (bytes: Buffer): string => createHash('sha256').update(bytes).digest('hex');
const excluded = new Set(['node_modules', '.git', 'dist', 'http.sock', 'http.lock']);
function canonical(path: string): string {
  if (existsSync(path)) return realpathSync(path);
  return join(canonical(dirname(path)), path.slice(dirname(path).length + 1));
}
function within(child: string, parent: string): boolean {
  return child === parent || child.startsWith(parent + sep);
}
/** SQLite's backup API gives each database a committed view while writers run.
 * Cross-store consistency requires stopping the old services for the final move. */
export async function createSnapshot(from: string, to: string, tasks?: string): Promise<SnapshotManifest> {
  const source = realpathSync(from), target = canonical(resolve(to));
  if (within(target, source) || within(source, target)) throw new Error('Snapshot and source must be separate directories');
  if (existsSync(target)) throw new Error('Snapshot destination already exists');
  mkdirSync(dirname(target), { recursive: true });
  const staging = target + `.partial-${process.pid}`;
  mkdirSync(staging, { mode: 0o700 });
  const manifest: SnapshotManifest = { version: 1, consistency: 'per-database', files: [] };
  async function copy(input: string, path: string): Promise<void> {
    const stat = lstatSync(input);
    if (stat.isSymbolicLink()) throw new Error('Snapshot source contains a symbolic link');
    if (stat.isDirectory()) {
      for (const name of readdirSync(input).sort()) {
        if (excluded.has(name) || /(?:-wal|-shm|-journal)$/.test(name)) continue;
        await copy(join(input, name), join(path, name));
      }
      return;
    }
    if (!stat.isFile()) return; // Unix sockets and other live handles are not data.
    const output = join(staging, path);
    mkdirSync(dirname(output), { recursive: true, mode: 0o700 });
    const fd = openSync(input, 'r');
    let sqlite: boolean;
    try {
      // Reading a header never changes the source, including files without .db suffixes.
      const { readSync } = await import('node:fs');
      const header = Buffer.alloc(16);
      readSync(fd, header, 0, 16, 0);
      sqlite = header.toString() === 'SQLite format 3\0';
    } finally { closeSync(fd); }
    if (sqlite) {
      const db = new Database(input, { readonly: true, fileMustExist: true });
      try { await db.backup(output); } finally { db.close(); }
      const out = openSync(output, 'r');
      try { fchmodSync(out, 0o600); } finally { closeSync(out); }
    } else {
      writeFileSync(output, readFileSync(input), { mode: 0o600, flag: 'wx' });
    }
    const bytes = readFileSync(output);
    manifest.files.push({ path: path.split(sep).join('/'), sha256: hash(bytes), bytes: bytes.length, kind: sqlite ? 'sqlite' : 'file' });
  }
  try {
    await copy(source, 'home');
    if (tasks) await copy(realpathSync(tasks), 'tasks/store.db');
    writeFileSync(join(staging, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n', { mode: 0o600 });
    renameSync(staging, target);
    return manifest;
  } catch {
    rmSync(staging, { recursive: true, force: true });
    // Source errors can contain credential-bearing file names or values: don't forward them.
    throw new Error('Snapshot failed; incomplete destination removed; source unchanged');
  }
}
export function readSnapshot(dir: string): SnapshotManifest {
  const root = realpathSync(dir);
  const manifest = JSON.parse(readFileSync(join(root, 'manifest.json'), 'utf8')) as SnapshotManifest;
  if (manifest.version !== 1 || !Array.isArray(manifest.files)) throw new Error('Invalid snapshot manifest');
  const seen = new Set<string>();
  for (const file of manifest.files) {
    if (typeof file.path !== 'string' || seen.has(file.path)) throw new Error('Invalid snapshot entry');
    seen.add(file.path);
    const path = resolve(root, file.path);
    if (!within(path, root) || path === root || relative(root, path).startsWith('..')) throw new Error('Invalid snapshot path');
    if (!within(realpathSync(path), root)) throw new Error('Invalid snapshot link');
    const bytes = readFileSync(path);
    if (bytes.length !== file.bytes || hash(bytes) !== file.sha256) throw new Error('Snapshot integrity check failed');
  }
  return manifest;
}
export async function migrateSnapshot(argv: string[], io: IOStreams): Promise<number> {
  let values;
  try { ({ values } = parseArgs({ args: argv, options: { from: { type: 'string' }, to: { type: 'string' }, tasks: { type: 'string' } }, strict: true, allowPositionals: false })); }
  catch { io.stderr('usage: loom migrate snapshot --from <old-home> [--tasks <store.db>] --to <new-directory>\n'); return 2; }
  if (!values.from || !values.to) { io.stderr('usage: loom migrate snapshot --from <old-home> [--tasks <store.db>] --to <new-directory>\n'); return 2; }
  try {
    const manifest = await createSnapshot(values.from, values.to, values.tasks);
    io.stdout(JSON.stringify({ status: 'ok', files: manifest.files.length, consistency: manifest.consistency }) + '\n');
    return 0;
  } catch { io.stderr('Snapshot refused or failed; no source data changed.\n'); return 1; }
}
