/**
 * Managed pieces: pieces loom installs itself (docs/specs/pieces-install.md).
 *
 * A piece is an npm package installed from a pinned git commit into its piece
 * home, $LOOM_HOME/pieces/<name>/. Its executables are linked into
 * $LOOM_HOME/pieces/bin, which is searched before PATH (cli/pieces.ts). When
 * loom runs a managed piece it adds the piece's own environment: its name, its
 * home, and its settings (pieceEnvFor), to that piece only.
 *
 *   pieces/bin/<bin>  -> ../<name>/current/node_modules/.bin/<bin>
 *   pieces/<name>/piece.json      what's installed (source, commit, version, bins, previous)
 *   pieces/<name>/settings.json   the owner's values, 0600
 *   pieces/<name>/versions/<sha>/ one npm prefix per commit: current and the one before
 *   pieces/<name>/current         -> versions/<sha>
 *   pieces/<name>/install.log     the last install's npm output
 */
import { spawn } from 'node:child_process';
import {
  existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, readlinkSync, renameSync, rmSync, symlinkSync, unlinkSync, writeFileSync,
} from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { resolveRepoRoot } from '../config.js';

const PIECE = /^[a-z][a-z0-9-]{0,39}$/;
const REPO = /^[A-Za-z0-9-]{1,39}\/[A-Za-z0-9._-]{1,100}$/;
const COMMIT = /^[0-9a-f]{40}$/;
const SETTING = /^[A-Z][A-Z0-9_]{0,63}$/;
const BIN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const RESERVED_SETTINGS = new Set(['PATH', 'HOME', 'USER', 'SHELL', 'NODE_OPTIONS']);

export interface Setting {
  name: string;
  label: string;
  hint?: string;
  kind: 'text' | 'choice';
  options?: { value: string; label: string }[];
  default?: string;
  required: boolean;
}

export interface Service {
  name: string;
  argv: string[];
}

export interface LoomBlock {
  role?: string;
  label?: string;
  description?: string;
  settings: Setting[];
  services: Service[];
}

export interface PieceRecord {
  v: 1;
  name: string;
  source: { repo: string; commit: string };
  package: string;
  version: string;
  installed: string;
  previous?: { commit: string; version: string };
  bins: string[];
  loom: LoomBlock;
}

export interface CatalogEntry {
  name: string;
  repo: string;
  commit: string;
  version?: string;
  label?: string;
  description?: string;
}

export class PieceError extends Error {}

/** $LOOM_HOME, else $HOME/.config/loom, from the env given; undefined with neither (tests pass bare envs). */
function loomHomeOf(env: NodeJS.ProcessEnv): string | undefined {
  if (env.LOOM_HOME) return env.LOOM_HOME;
  return env.HOME ? join(env.HOME, '.config', 'loom') : undefined;
}

export function piecesRoot(env: NodeJS.ProcessEnv): string | undefined {
  const home = loomHomeOf(env);
  return home ? join(home, 'pieces') : undefined;
}

/** Where managed pieces' executables are linked: searched before PATH. */
export function managedBinDir(env: NodeJS.ProcessEnv): string | undefined {
  const root = piecesRoot(env);
  return root ? join(root, 'bin') : undefined;
}

function rootOrThrow(env: NodeJS.ProcessEnv): string {
  const root = piecesRoot(env);
  if (!root) throw new PieceError('no LOOM_HOME or HOME: nowhere to install pieces');
  return root;
}

function readJson(path: string): unknown {
  try { return JSON.parse(readFileSync(path, 'utf-8')); } catch { return undefined; }
}

function writeJson(path: string, value: unknown, mode = 0o644): void {
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(value, null, 2) + '\n', { mode });
  renameSync(tmp, path);
}

/** Point `link` at `target`, replacing what's there in one rename. */
function swapLink(target: string, link: string): void {
  const tmp = `${link}.${process.pid}.tmp`;
  rmSync(tmp, { force: true });
  symlinkSync(target, tmp);
  renameSync(tmp, link);
}

export function readRecord(env: NodeJS.ProcessEnv, name: string): PieceRecord | undefined {
  const root = piecesRoot(env);
  if (!root || !PIECE.test(name)) return undefined;
  const r = readJson(join(root, name, 'piece.json')) as PieceRecord | undefined;
  return r && r.v === 1 && r.name === name ? r : undefined;
}

export function managedPieces(env: NodeJS.ProcessEnv): PieceRecord[] {
  const root = piecesRoot(env);
  if (!root) return [];
  let names: string[];
  try { names = readdirSync(root); } catch { return []; }
  return names.filter((n) => PIECE.test(n)).map((n) => readRecord(env, n)).filter((r): r is PieceRecord => !!r)
    .sort((a, b) => a.name.localeCompare(b.name));
}

export function readSettings(env: NodeJS.ProcessEnv, name: string): Record<string, string> {
  const root = piecesRoot(env);
  const s = root ? readJson(join(root, name, 'settings.json')) : undefined;
  if (!s || typeof s !== 'object' || Array.isArray(s)) return {};
  return Object.fromEntries(Object.entries(s).filter(([, v]) => typeof v === 'string')) as Record<string, string>;
}

/** Required settings with no value anywhere: what the owner still has to set. */
export function missingSettings(env: NodeJS.ProcessEnv, rec: PieceRecord): string[] {
  const values = readSettings(env, rec.name);
  return rec.loom.settings.filter((s) => s.required && !values[s.name] && s.default === undefined && !env[s.name]).map((s) => s.name);
}

/**
 * The environment a piece runs with: env, plus for a managed piece its name,
 * its home and its settings. A setting's default gives way to a value the
 * daemon already has (loom-http.env), and the owner's setting beats both.
 */
export function pieceEnvFor(path: string, env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const bin = managedBinDir(env);
  if (!bin || dirname(path) !== bin) return env;
  const owner = ownerOfBin(env, basename(path));
  if (!owner) return env;
  const root = rootOrThrow(env);
  const home = join(root, owner.name);
  const out: NodeJS.ProcessEnv = { ...env, LOOM_PIECE_NAME: owner.name, LOOM_PIECE_HOME: home };
  const values = readSettings(env, owner.name);
  for (const s of owner.loom.settings) {
    if (values[s.name] !== undefined) out[s.name] = values[s.name];
    else if (env[s.name] === undefined && s.default !== undefined) out[s.name] = s.default.split('${LOOM_PIECE_HOME}').join(home);
  }
  return out;
}

function ownerOfBin(env: NodeJS.ProcessEnv, bin: string): PieceRecord | undefined {
  return managedPieces(env).find((r) => r.bins.includes(bin));
}

/** The catalog of first-party pieces that ships with loom (assets/pieces.json). */
export function readCatalog(path = join(resolveRepoRoot(), 'assets', 'pieces.json')): CatalogEntry[] {
  const c = readJson(path) as { v?: number; pieces?: unknown } | undefined;
  if (!c || c.v !== 1 || !Array.isArray(c.pieces)) return [];
  return c.pieces.filter((p): p is CatalogEntry =>
    !!p && typeof p === 'object' && PIECE.test((p as CatalogEntry).name) && REPO.test((p as CatalogEntry).repo) && COMMIT.test((p as CatalogEntry).commit));
}

/** `github:owner/repo#<40-char commit>` → its parts; anything that could move is refused. */
export function parseSource(spec: string): { repo: string; commit: string } {
  const m = /^github:([^#]+)#(.+)$/.exec(spec);
  if (!m || !REPO.test(m[1])) throw new PieceError(`a source is github:<owner>/<repo>#<commit>, not ${JSON.stringify(spec)}`);
  if (!COMMIT.test(m[2])) throw new PieceError('a source names a full 40-character commit: a branch, tag or short commit can move');
  return { repo: m[1], commit: m[2] };
}

const str = (v: unknown, max: number): v is string => typeof v === 'string' && v.length > 0 && v.length <= max;

/** The package's `loom` block, checked; a string says what's wrong. */
export function parseLoomBlock(raw: unknown): LoomBlock | string {
  if (raw === undefined) return { settings: [], services: [] };
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return 'the loom block is not an object';
  const b = raw as Record<string, unknown>;
  const out: LoomBlock = { settings: [], services: [] };
  for (const k of ['role', 'label'] as const) {
    if (b[k] !== undefined) {
      if (!str(b[k], 40)) return `loom.${k} is not a short string`;
      out[k] = b[k] as string;
    }
  }
  if (b.description !== undefined) {
    if (!str(b.description, 300)) return 'loom.description is not a string of at most 300 characters';
    out.description = b.description;
  }
  const settings = b.settings ?? [];
  if (!Array.isArray(settings) || settings.length > 20) return 'loom.settings is not a list of at most 20';
  for (const s of settings as Record<string, unknown>[]) {
    const name = s?.name;
    if (typeof name !== 'string' || !SETTING.test(name) || name.startsWith('LOOM_') || RESERVED_SETTINGS.has(name)) {
      return `a setting's name must be an UPPERCASE variable that isn't LOOM_* or ${[...RESERVED_SETTINGS].join('/')}: ${JSON.stringify(name)}`;
    }
    if (out.settings.some((x) => x.name === name)) return `setting ${name} is declared twice`;
    if (!str(s.label, 100)) return `setting ${name} has no label`;
    const kind = s.kind ?? 'text';
    if (kind !== 'text' && kind !== 'choice') return `setting ${name}: kind is text or choice (there's no secret kind: a piece keeps its own secrets)`;
    const setting: Setting = { name, label: s.label, kind, required: s.required === true };
    if (s.hint !== undefined) {
      if (!str(s.hint, 200)) return `setting ${name}: hint is not a string`;
      setting.hint = s.hint;
    }
    if (s.default !== undefined) {
      if (typeof s.default !== 'string' || s.default.length > 500) return `setting ${name}: default is not a string`;
      setting.default = s.default;
    }
    if (kind === 'choice') {
      const opts = s.options;
      if (!Array.isArray(opts) || !opts.length || opts.length > 20 || !opts.every((o) => str(o?.value, 200) && str(o?.label, 100))) {
        return `setting ${name}: a choice needs options, each {value, label}`;
      }
      setting.options = opts.map((o) => ({ value: o.value, label: o.label }));
    }
    out.settings.push(setting);
  }
  const services = b.services ?? [];
  if (!Array.isArray(services) || services.length > 5) return 'loom.services is not a list of at most 5';
  for (const v of services as Record<string, unknown>[]) {
    if (!str(v?.name, 40) || !PIECE.test(v.name as string)) return `a service's name is lowercase letters, digits and dashes: ${JSON.stringify(v?.name)}`;
    const argv = v.argv;
    if (!Array.isArray(argv) || !argv.length || argv.length > 30 || !argv.every((a) => typeof a === 'string' && a.length <= 500)) {
      return `service ${v.name}: argv is a list of strings`;
    }
    out.services.push({ name: v.name as string, argv: argv as string[] });
  }
  return out;
}

/** npm from PATH (a test puts a stand-in first on it). */
function runNpm(env: NodeJS.ProcessEnv, args: string[], log: string): Promise<number> {
  const npm = 'npm';
  return new Promise((resolve) => {
    const out: Buffer[] = [];
    const child = spawn(npm, args, { env, stdio: ['ignore', 'pipe', 'pipe'] });
    child.stdout.on('data', (d: Buffer) => out.push(d));
    child.stderr.on('data', (d: Buffer) => out.push(d));
    child.on('error', (err) => { out.push(Buffer.from(`couldn't run ${npm}: ${err.message}\n`)); });
    child.on('close', (code) => {
      writeFileSync(log, `$ ${npm} ${args.join(' ')}\n${Buffer.concat(out).toString()}`);
      resolve(code ?? 1);
    });
  });
}

/** The package an npm prefix installed, and its package.json. */
function installedPackage(prefix: string): { name: string; dir: string; pkg: Record<string, unknown> } {
  const top = readJson(join(prefix, 'package.json')) as { dependencies?: Record<string, string> } | undefined;
  const deps = Object.keys(top?.dependencies ?? {});
  if (deps.length !== 1) throw new PieceError(`npm installed ${deps.length} packages at the top, not 1`);
  const dir = join(prefix, 'node_modules', deps[0]);
  const pkg = readJson(join(dir, 'package.json')) as Record<string, unknown> | undefined;
  if (!pkg) throw new PieceError(`${deps[0]} has no package.json`);
  return { name: deps[0], dir, pkg };
}

function binsOf(pkg: Record<string, unknown>, pkgName: string): string[] {
  const bin = pkg.bin;
  if (typeof bin === 'string') return [pkgName.replace(/^@[^/]+\//, '')];
  if (!bin || typeof bin !== 'object') return [];
  return Object.keys(bin as Record<string, string>);
}

export interface InstallResult {
  record: PieceRecord;
  updated: boolean;
  missing: string[];
}

/**
 * Install `source` as piece `name` (from the catalog), or as whatever its one
 * loom-<name> bin names (from GitHub). A failed install leaves what was
 * current untouched.
 */
export async function installPiece(
  env: NodeJS.ProcessEnv,
  source: { repo: string; commit: string },
  name?: string,
): Promise<InstallResult> {
  const root = rootOrThrow(env);
  mkdirSync(join(root, 'bin'), { recursive: true });
  const staging = join(root, `.staging-${source.commit.slice(0, 12)}-${process.pid}`);
  rmSync(staging, { recursive: true, force: true });
  mkdirSync(staging, { recursive: true });
  const log = join(root, `.install-${process.pid}.log`);
  try {
    const code = await runNpm(env, ['install', '--prefix', staging, '--no-audit', '--no-fund', '--omit=dev',
      `github:${source.repo}#${source.commit}`], log);
    if (code !== 0) {
      renameSync(log, join(root, 'install.log'));
      throw new PieceError(`npm install failed (exit ${code}); its output is in ${join(root, 'install.log')}`);
    }
    const { name: pkgName, pkg } = installedPackage(staging);
    const bins = binsOf(pkg, pkgName);
    const loomBins = bins.filter((b) => b.startsWith('loom-'));
    if (loomBins.length !== 1) throw new PieceError(`a piece has exactly one loom-<name> bin; ${pkgName} has ${loomBins.length}`);
    const pieceName = loomBins[0].slice('loom-'.length);
    if (!PIECE.test(pieceName) || pieceName === 'loom') throw new PieceError(`loom-${pieceName} isn't a piece name`);
    if (name && pieceName !== name) throw new PieceError(`the catalog's ${name} installs loom-${pieceName}, not loom-${name}`);
    const bad = bins.find((b) => !BIN.test(b));
    if (bad) throw new PieceError(`bin name ${JSON.stringify(bad)} isn't allowed`);
    const loom = parseLoomBlock(pkg.loom);
    if (typeof loom === 'string') throw new PieceError(`${pkgName}: ${loom}`);
    for (const other of managedPieces(env)) {
      if (other.name === pieceName) continue;
      const clash = bins.find((b) => other.bins.includes(b));
      if (clash) throw new PieceError(`${clash} is already the ${other.name} piece's`);
    }

    const home = join(root, pieceName);
    mkdirSync(join(home, 'versions'), { recursive: true });
    const version = join(home, 'versions', source.commit);
    if (existsSync(version)) rmSync(staging, { recursive: true, force: true });
    else renameSync(staging, version);
    renameSync(log, join(home, 'install.log'));

    const old = readRecord(env, pieceName);
    const record: PieceRecord = {
      v: 1, name: pieceName, source, package: pkgName, version: typeof pkg.version === 'string' ? pkg.version : '',
      installed: new Date().toISOString(), bins, loom,
      ...(old && old.source.commit !== source.commit ? { previous: { commit: old.source.commit, version: old.version } } : old?.previous ? { previous: old.previous } : {}),
    };
    swapLink(join('versions', source.commit), join(home, 'current'));
    relink(root, record, old);
    writeJson(join(home, 'piece.json'), record);
    prune(home, record);
    return { record, updated: !!old, missing: missingSettings(env, record) };
  } finally {
    rmSync(staging, { recursive: true, force: true });
    rmSync(log, { force: true });
  }
}

/** bin/ links for a piece: its bins now, none of the ones it dropped. */
function relink(root: string, record: PieceRecord, old?: PieceRecord): void {
  for (const b of old?.bins ?? []) {
    if (!record.bins.includes(b)) rmSync(join(root, 'bin', b), { force: true });
  }
  for (const b of record.bins) swapLink(join('..', record.name, 'current', 'node_modules', '.bin', b), join(root, 'bin', b));
}

/** Keep the current version and the previous one; the rest go. */
function prune(home: string, record: PieceRecord): void {
  const keep = new Set([record.source.commit, record.previous?.commit].filter(Boolean));
  for (const v of readdirSync(join(home, 'versions'))) {
    if (!keep.has(v)) rmSync(join(home, 'versions', v), { recursive: true, force: true });
  }
}

export function rollbackPiece(env: NodeJS.ProcessEnv, name: string): PieceRecord {
  const root = rootOrThrow(env);
  const rec = readRecord(env, name);
  if (!rec) throw new PieceError(`${name} isn't a managed piece`);
  if (!rec.previous || !existsSync(join(root, name, 'versions', rec.previous.commit))) throw new PieceError(`${name} has no previous version to roll back to`);
  const back: PieceRecord = {
    ...rec, source: { repo: rec.source.repo, commit: rec.previous.commit }, version: rec.previous.version,
    installed: new Date().toISOString(), previous: { commit: rec.source.commit, version: rec.version },
  };
  // The previous version's own bins are read from its package.json.
  const { name: pkgName, pkg } = installedPackage(join(root, name, 'versions', back.source.commit));
  back.bins = binsOf(pkg, pkgName);
  const loom = parseLoomBlock(pkg.loom);
  if (typeof loom !== 'string') back.loom = loom;
  swapLink(join('versions', back.source.commit), join(root, name, 'current'));
  relink(root, back, rec);
  writeJson(join(root, name, 'piece.json'), back);
  return back;
}

export function removePiece(env: NodeJS.ProcessEnv, name: string, purge = false): void {
  const root = rootOrThrow(env);
  const rec = readRecord(env, name);
  if (!rec) throw new PieceError(`${name} isn't a managed piece`);
  for (const b of rec.bins) {
    const link = join(root, 'bin', b);
    try {
      if (lstatSync(link).isSymbolicLink() && readlinkSync(link).startsWith(join('..', name) + '/')) unlinkSync(link);
    } catch { /* already gone */ }
  }
  const home = join(root, name);
  if (purge) {
    rmSync(home, { recursive: true, force: true });
    return;
  }
  // Settings and data stay, so installing it again picks up where it was.
  for (const f of ['versions', 'current', 'piece.json', 'install.log']) rmSync(join(home, f), { recursive: true, force: true });
}

/** Set (or with an empty value, clear) declared settings. */
export function setSettings(env: NodeJS.ProcessEnv, name: string, values: Record<string, string>): Record<string, string> {
  const root = rootOrThrow(env);
  const rec = readRecord(env, name);
  if (!rec) throw new PieceError(`${name} isn't a managed piece`);
  const now = readSettings(env, name);
  for (const [k, v] of Object.entries(values)) {
    const s = rec.loom.settings.find((x) => x.name === k);
    if (!s) throw new PieceError(`${name} has no setting ${k}${rec.loom.settings.length ? ` (it has ${rec.loom.settings.map((x) => x.name).join(', ')})` : ''}`);
    if (v.length > 500 || /[\n\r\0]/.test(v)) throw new PieceError(`${k}: a value is one line of at most 500 characters`);
    if (s.kind === 'choice' && v && !s.options?.some((o) => o.value === v)) throw new PieceError(`${k} is one of ${s.options?.map((o) => o.value).join(', ')}`);
    if (v) now[k] = v;
    else delete now[k];
  }
  writeJson(join(root, name, 'settings.json'), now, 0o600);
  return now;
}
