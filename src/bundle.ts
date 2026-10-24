/**
 * The bundle (docs/specs/household.md, "Export and restore"): the whole
 * household in one file, encrypted to a key the owner holds. A USB stick
 * with the latest bundle and that key brings the household back anywhere.
 *
 *   loom export --to <file> --recipient <age1…>    write one
 *   loom restore <file> --identity <key>           lay it down in an empty $LOOM_HOME
 *   loom restore <file> --identity <key> --drill   restore into a throwaway dir and
 *                                                  compare with the live household
 *
 * Inside (a tar, then age-encrypted): manifest.json, household.json, the token
 * files, the commons, every agent's directory (SQLite through the backup API,
 * never a raw copy of a live file), and each installed piece's own part, which
 * the piece encrypts itself (`loom-<piece> bundle export`): core never sees inside
 * it. A plain context dir exports as a household of one.
 *
 * Encryption and archiving use the `age` and `tar` programs. Plaintext only
 * ever sits in a fresh 0700 temp directory that's removed on the way out.
 */
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  chmodSync, copyFileSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, readlinkSync,
  renameSync, rmSync, statSync, symlinkSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, delimiter, join, resolve } from 'node:path';
import BetterSqlite3 from 'better-sqlite3';
import { resolveRepoRoot, resolveSqliteDbPath } from './config.js';
import {
  AGENT_NAME, agentDir, commonsKnowledgePath, householdOf, loadHousehold, type Household,
} from './household.js';
import { commonsPeoplePath, splitPeopleIntoCommons } from './backends/people-household.js';
import { listPieces } from './cli/pieces.js';

export class BundleError extends Error {}

const PIECE_TIMEOUT_MS = 120_000;
const PIECE_MAX_BYTES = 256 * 1024 * 1024;
/** Left out of an agent's directory: SQLite sidecars (the backup API covers them) and old hand-made backups. */
const SKIP_FILE = /(\.db-(wal|shm)$)|(\.bak($|[.-]))|(\.loom\.tmp$)/;
const SKIP_DIR = /^backup-/;

export interface PiecePart { name: string; included: boolean; reason?: string; bytes?: number; sha256?: string }
export interface Manifest {
  v: 1;
  loom: string;
  created: string;
  household: { agents: string[]; default: string; owner?: string };
  pieces: PiecePart[];
}

function loomVersion(): string {
  try { return (JSON.parse(readFileSync(join(resolveRepoRoot(), 'package.json'), 'utf-8')) as { version: string }).version; } catch { return 'unknown'; }
}

/**
 * The `age` or `tar` program: LOOM_AGE / LOOM_TAR when set (an absolute path
 * to a file), else the first on PATH. Always run without a shell, with
 * absolute paths as arguments (so nothing can be read as an option).
 */
function findProgram(name: string, env: NodeJS.ProcessEnv): string {
  const override = env[`LOOM_${name.toUpperCase()}`];
  if (override) {
    if (!override.startsWith('/') || !existsSync(override) || !statSync(override).isFile()) {
      throw new BundleError(`LOOM_${name.toUpperCase()} must be the absolute path of the ${name} program`);
    }
    return override;
  }
  for (const dir of (env.PATH ?? '').split(delimiter)) {
    if (dir && existsSync(join(dir, name))) return join(dir, name);
  }
  throw new BundleError(`${name} isn't installed (or on PATH); the bundle needs it. Set LOOM_${name.toUpperCase()} to its path if it lives elsewhere.`);
}

function run(cmd: string, args: string[], what: string): void {
  const r = spawnSync(cmd, args, { stdio: ['ignore', 'ignore', 'pipe'], encoding: 'utf-8' });
  if (r.status !== 0) throw new BundleError(`${what} failed: ${(r.stderr || r.error?.message || `exit ${r.status}`).trim()}`);
}

async function backupDb(from: string, to: string): Promise<void> {
  const db = new BetterSqlite3(from, { readonly: true, fileMustExist: true });
  try { await db.backup(to); } finally { db.close(); }
}

/** Copy an agent's directory: databases through the backup API, everything else as is. */
async function copyAgent(from: string, to: string): Promise<void> {
  mkdirSync(to, { recursive: true, mode: 0o700 });
  for (const name of readdirSync(from)) {
    const src = join(from, name);
    const dst = join(to, name);
    const st = lstatSync(src);
    if (st.isSymbolicLink()) { symlinkSync(readlinkSync(src), dst); continue; }
    if (st.isDirectory()) { if (!SKIP_DIR.test(name)) await copyAgent(src, dst); continue; }
    if (!st.isFile() || SKIP_FILE.test(name)) continue;
    if (name.endsWith('.db')) await backupDb(src, dst);
    else copyFileSync(src, dst);
  }
}

/**
 * `loom-<piece> bundle export|import`: namespaced under `bundle`, so they can't
 * collide with a piece's own export/import commands (taskstore has both).
 */
function pieceRun(path: string, verb: 'export' | 'import', env: NodeJS.ProcessEnv, stdin?: Buffer): Promise<{ ok: true; out: Buffer } | { ok: false; reason: string }> {
  return new Promise((resolveP) => {
    const child = spawn(path, ['bundle', verb], { env, stdio: [stdin ? 'pipe' : 'ignore', 'pipe', 'pipe'] });
    const chunks: Buffer[] = [];
    let bytes = 0;
    let err = '';
    let done = false;
    const finish = (r: { ok: true; out: Buffer } | { ok: false; reason: string }) => { if (!done) { done = true; clearTimeout(timer); resolveP(r); } };
    const timer = setTimeout(() => { child.kill('SIGKILL'); finish({ ok: false, reason: 'timed out' }); }, PIECE_TIMEOUT_MS);
    child.stdout!.on('data', (d: Buffer) => {
      bytes += d.length;
      if (bytes > PIECE_MAX_BYTES) { child.kill('SIGKILL'); finish({ ok: false, reason: 'part too large' }); return; }
      chunks.push(d);
    });
    child.stderr!.on('data', (d: Buffer) => { if (err.length < 2000) err += d.toString('utf-8'); });
    child.on('error', (e) => finish({ ok: false, reason: e.message }));
    child.on('close', (code) => finish(code === 0 ? { ok: true, out: Buffer.concat(chunks) } : { ok: false, reason: (err.trim().split('\n').pop() || `exit ${code}`).slice(0, 300) }));
    if (stdin && child.stdin) { child.stdin.on('error', () => {}); child.stdin.end(stdin); }
  });
}

/** Where to export from: the household a context dir belongs to, or a plain context dir as a household of one. */
export function exportSource(contextDir: string): { household: Household; plain: boolean; contextDir: string } {
  const hh = householdOf(contextDir);
  if (hh) return { household: hh.household, plain: false, contextDir };
  const name = basename(resolve(contextDir)).toLowerCase().replace(/[^a-z0-9-]/g, '-').replace(/^[^a-z]+/, '') || 'agent';
  const agent = AGENT_NAME.test(name) ? name : 'agent';
  return { household: { home: resolve(contextDir, '..'), agents: [agent], default: agent }, plain: true, contextDir };
}

/** Write the bundle. Returns the manifest. */
export async function exportBundle(opts: {
  contextDir: string;
  to: string;
  recipients: string[];
  env?: NodeJS.ProcessEnv;
  now?: Date;
}): Promise<Manifest> {
  const env = opts.env ?? process.env;
  if (!opts.recipients.length) throw new BundleError('a bundle needs at least one --recipient (an age public key the owner holds)');
  for (const r of opts.recipients) if (!/^age1[0-9a-z]{20,}$/.test(r) && !r.startsWith('ssh-')) throw new BundleError(`${r} isn't an age recipient (age1…) or an ssh public key`);
  const age = findProgram('age', env);
  const tar = findProgram('tar', env);
  const src = exportSource(opts.contextDir);
  const h = src.household;
  const work = mkdtempSync(join(tmpdir(), 'loom-export-'));
  chmodSync(work, 0o700);
  try {
    const stage = join(work, 'household');
    mkdirSync(stage, { mode: 0o700 });
    // The household's own files.
    writeFileSync(join(stage, 'household.json'), JSON.stringify({ v: 1, agents: h.agents, default: h.default, ...(h.owner ? { owner: h.owner } : {}) }, null, 2) + '\n', { mode: 0o600 });
    if (!src.plain) for (const f of ['tokens.json', 'tokens.used.json']) if (existsSync(join(h.home, f))) copyFileSync(join(h.home, f), join(stage, f));
    // The commons.
    mkdirSync(join(stage, 'commons'), { mode: 0o700 });
    const knowledge = src.plain ? join(src.contextDir, 'knowledge.db') : commonsKnowledgePath(h);
    if (existsSync(knowledge)) await backupDb(knowledge, join(stage, 'commons', 'knowledge.db'));
    if (!src.plain && existsSync(commonsPeoplePath(h))) await backupDb(commonsPeoplePath(h), join(stage, 'commons', 'people.db'));
    // Each agent.
    for (const a of h.agents) {
      const from = src.plain ? src.contextDir : agentDir(h, a);
      await copyAgent(from, join(stage, 'agents', a));
      if (src.plain) rmSync(join(stage, 'agents', a, 'knowledge.db'), { force: true });
    }
    // Each piece's own part, already encrypted by the piece to the same recipients.
    const pieces: PiecePart[] = [];
    mkdirSync(join(stage, 'pieces'), { mode: 0o700 });
    for (const p of listPieces(env).filter((x) => x.name !== 'loom')) {
      const r = await pieceRun(p.path, 'export', { ...env, LOOM_EXPORT_RECIPIENTS: opts.recipients.join(',') });
      if (!r.ok) { pieces.push({ name: p.name, included: false, reason: r.reason }); continue; }
      writeFileSync(join(stage, 'pieces', `${p.name}.part`), r.out, { mode: 0o600 });
      pieces.push({ name: p.name, included: true, bytes: r.out.length, sha256: createHash('sha256').update(r.out).digest('hex') });
    }
    const manifest: Manifest = {
      v: 1, loom: loomVersion(), created: (opts.now ?? new Date()).toISOString(),
      household: { agents: h.agents, default: h.default, ...(h.owner ? { owner: h.owner } : {}) }, pieces,
    };
    writeFileSync(join(stage, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n', { mode: 0o600 });
    // tar, then encrypt; only the encrypted file leaves the temp dir.
    const plain = join(work, 'household.tar');
    run(tar, ['-C', stage, '-cf', plain, '.'], 'tar');
    const out = resolve(opts.to);
    const tmpOut = `${out}.${process.pid}.tmp`;
    run(age, ['-e', ...opts.recipients.flatMap((r) => ['-r', r]), '-o', tmpOut, plain], 'age');
    chmodSync(tmpOut, 0o600);
    renameSync(tmpOut, out);
    return manifest;
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

/** Decrypt and unpack a bundle into `dir` (must be empty). Returns its manifest. */
function unpack(fileIn: string, identityIn: string, dir: string, env: NodeJS.ProcessEnv): Manifest {
  // Absolute paths: a file named like an option can't be taken for one.
  const file = resolve(fileIn);
  const identity = resolve(identityIn);
  const age = findProgram('age', env);
  const tar = findProgram('tar', env);
  if (!existsSync(identity)) throw new BundleError(`${identity}: no such identity file`);
  const work = mkdtempSync(join(tmpdir(), 'loom-restore-'));
  chmodSync(work, 0o700);
  try {
    const plain = join(work, 'household.tar');
    run(age, ['-d', '-i', identity, '-o', plain, file], 'age (decrypt: is this the right key?)');
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    // Members are ours (we wrote them), but never let one land outside dir.
    run(tar, ['-C', dir, '--no-same-owner', '-xf', plain], 'tar');
    const m = JSON.parse(readFileSync(join(dir, 'manifest.json'), 'utf-8')) as Manifest;
    if (m.v !== 1) throw new BundleError(`this bundle is format v${String(m.v)}; this loom reads v1`);
    rmSync(join(dir, 'manifest.json'));
    chmodSync(dir, 0o700);
    for (const f of ['household.json', 'tokens.json', 'tokens.used.json']) if (existsSync(join(dir, f))) chmodSync(join(dir, f), 0o600);
    return m;
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

function emptyOrMissing(dir: string): boolean {
  return !existsSync(dir) || readdirSync(dir).length === 0;
}

export interface RestoreReport { home: string; manifest: Manifest; pieces: Array<{ name: string; restored: boolean; reason?: string }> }

/**
 * Lay a bundle down in an empty $LOOM_HOME and hand each piece its part
 * (`loom-<piece> bundle import`, with LOOM_IMPORT_IDENTITY naming the key so the
 * piece can re-encrypt for this machine). A piece that isn't installed here
 * has its part kept in pieces-pending/ for later.
 */
export async function restoreBundle(opts: { file: string; identity: string; home: string; env?: NodeJS.ProcessEnv }): Promise<RestoreReport> {
  const env = opts.env ?? process.env;
  const home = resolve(opts.home);
  if (!emptyOrMissing(home)) throw new BundleError(`${home} isn't empty; restore into a new LOOM_HOME (--to), never over a live one`);
  const manifest = unpack(opts.file, opts.identity, home, env);
  const h = loadHousehold(home);
  if (!h) throw new BundleError('the bundle has no household.json');
  // A bundle made from a plain context dir still holds whole cards: split them now.
  for (const a of h.agents) if (existsSync(resolveSqliteDbPath(agentDir(h, a)))) splitPeopleIntoCommons(h, a, agentDir(h, a));
  const installed = new Map(listPieces(env).map((p) => [p.name, p.path]));
  const pieces: RestoreReport['pieces'] = [];
  for (const part of manifest.pieces.filter((p) => p.included)) {
    const blob = join(home, 'pieces', `${part.name}.part`);
    const path = installed.get(part.name);
    const pending = () => {
      mkdirSync(join(home, 'pieces-pending'), { recursive: true, mode: 0o700 });
      renameSync(blob, join(home, 'pieces-pending', `${part.name}.part`));
    };
    if (!path) { pending(); pieces.push({ name: part.name, restored: false, reason: `loom-${part.name} isn't installed here; its part is in pieces-pending/` }); continue; }
    const r = await pieceRun(path, 'import', { ...env, LOOM_IMPORT_IDENTITY: resolve(opts.identity) }, readFileSync(blob));
    if (r.ok) { rmSync(blob); pieces.push({ name: part.name, restored: true }); } else { pending(); pieces.push({ name: part.name, restored: false, reason: r.reason }); }
  }
  rmSync(join(home, 'pieces'), { recursive: true, force: true });
  return { home, manifest, pieces };
}

// ─── The drill ───────────────────────────────────────────────────────────────

function sha256File(path: string): string | null {
  try { return createHash('sha256').update(readFileSync(path)).digest('hex'); } catch { return null; }
}

function count(path: string, sql: string): number | null {
  if (!existsSync(path)) return null;
  const db = new BetterSqlite3(path, { readonly: true, fileMustExist: true });
  try { return (db.prepare(sql).get() as { n: number }).n; } catch { return null; } finally { db.close(); }
}

/** What a household is, in terms a restore must reproduce. */
function fingerprint(h: Household): Record<string, unknown> {
  const fp: Record<string, unknown> = {
    agents: h.agents, default: h.default,
    knowledge_pages: count(commonsKnowledgePath(h), 'SELECT COUNT(*) AS n FROM pages'),
    people: count(commonsPeoplePath(h), 'SELECT COUNT(*) AS n FROM people'),
    people_cards: count(commonsPeoplePath(h), "SELECT group_concat(slug || ':' || card_json, '|') AS n FROM (SELECT slug, card_json FROM people ORDER BY slug)"),
    tokens: sha256File(join(h.home, 'tokens.json')),
  };
  for (const a of h.agents) {
    const d = agentDir(h, a);
    fp[`${a}.identity`] = sha256File(join(d, 'IDENTITY.md'));
    fp[`${a}.memories`] = count(join(d, 'memories.db'), 'SELECT COUNT(*) AS n FROM memories WHERE archived = 0');
    fp[`${a}.relationships`] = count(join(d, 'memories.db'), "SELECT group_concat(slug || ':' || card_json, '|') AS n FROM (SELECT slug, card_json FROM people ORDER BY slug)");
  }
  return fp;
}

export interface DrillReport { ok: boolean; manifest: Manifest; differences: Array<{ what: string; live: unknown; restored: unknown }> }

/**
 * Restore a bundle into a throwaway directory and compare it with the live
 * household: agents, identities, memory counts, every relationship and
 * directory card, knowledge, tokens. Pieces aren't imported (that would
 * write their live stores); their parts are only checked for presence. The
 * throwaway directory is always removed.
 */
export async function drillBundle(opts: { file: string; identity: string; contextDir: string; env?: NodeJS.ProcessEnv }): Promise<DrillReport> {
  const env = opts.env ?? process.env;
  const live = householdOf(opts.contextDir);
  if (!live) throw new BundleError('the drill compares against a live household; this context dir isn\'t in one');
  const scratch = mkdtempSync(join(tmpdir(), 'loom-drill-'));
  try {
    const home = join(scratch, 'home');
    const manifest = unpack(opts.file, opts.identity, home, env);
    const restored = loadHousehold(home);
    if (!restored) throw new BundleError('the bundle has no household.json');
    const a = fingerprint(live.household);
    const b = fingerprint(restored);
    const differences = Object.keys({ ...a, ...b })
      .filter((k) => JSON.stringify(a[k]) !== JSON.stringify(b[k]))
      .map((k) => ({ what: k, live: typeof a[k] === 'string' && (a[k] as string).length > 80 ? '(cards)' : a[k], restored: typeof b[k] === 'string' && (b[k] as string).length > 80 ? '(cards)' : b[k] }));
    for (const p of manifest.pieces.filter((x) => x.included)) {
      if (sha256File(join(home, 'pieces', `${p.name}.part`)) !== p.sha256) differences.push({ what: `piece ${p.name}`, live: p.sha256, restored: 'missing or altered' });
    }
    return { ok: differences.length === 0, manifest, differences };
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

/** How big a file is, for messages. */
export function sizeOf(path: string): number {
  try { return statSync(path).size; } catch { return 0; }
}
