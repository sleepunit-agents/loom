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
 *
 * A local piece (--from path:/abs/dir) is a package in a directory on this
 * machine. Its install is an `npm pack` of the directory (a snapshot: editing
 * the directory doesn't change what's installed), and its version is the
 * snapshot's sha256, so versions/<hash>/ holds it the way versions/<sha> holds
 * a commit, and update and rollback work the same.
 */
import { parseStoreDecl, type StoreDecl } from '../stores.js';
import { offerConflicts, parseOffers, type Offers } from '../offers.js';
import { syncVenuesQuietly } from '../household-store.js';
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  accessSync, constants as fsConstants, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, readlinkSync, renameSync, rmSync, symlinkSync, unlinkSync, writeFileSync,
} from 'node:fs';
import { basename, delimiter, dirname, isAbsolute, join, resolve } from 'node:path';
import { resolveRepoRoot } from '../config.js';
import { syncServices, type ServicesResult } from './pieces-services.js';
export { syncServices };

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
  /** Stopping it stops only its main process; what it started keeps running (KillMode=process). */
  keepChildren?: boolean;
}

/**
 * The checked `loom` block. Its offer keys (sections, venues, mcp_tools, grants: src/offers.ts) are
 * part of it, so piece.json keeps a copy of what the piece declared.
 */
export interface LoomBlock extends Offers {
  /** Which loom-<name> bin is the piece, when the package has several. */
  name?: string;
  role?: string;
  label?: string;
  description?: string;
  settings: Setting[];
  services: Service[];
  /**
   * API paths a caller with no token may reach (POST /api/<piece>/<path>), as
   * {kind:'stranger', address}: a box asking to join, and nothing else. Fixed at
   * install, so a piece can't open its door at run time.
   */
  strangers?: string[];
  /**
   * API paths the piece answers from a long-lived `<bin> api --serve` (src/ui/piece-server.ts, t-2065): one request
   * per line, each with its own store grant. Only paths whose handling keeps nothing of one caller for the next.
   */
  api_serve?: string[];
  /**
   * The piece's collections in loom's store and who may write each
   * (docs/specs/piece-storage.md). Fixed at install, so a running piece can't
   * widen who writes an owner's collection.
   */
  store?: StoreDecl;
}

/** A piece from a public GitHub repo, pinned to a commit. */
export interface GithubSource { repo: string; commit: string }
/**
 * A local piece: the package in a directory on this machine. `hash` is the
 * sha256 of its `npm pack` tarball, and is its version; `commit` is the git
 * commit the directory was at, only when it was a clean work tree (where it
 * came from, not what it is).
 */
export interface LocalSource { path: string; hash: string; commit?: string }
export type PieceSource = GithubSource | LocalSource;

export const isLocal = <T extends PieceSource | { path: string }>(s: T): s is Extract<T, { path: string }> => 'path' in s;
/** What names an installed version (its versions/ directory): the commit, or a local piece's hash. */
export const versionKey = (s: PieceSource): string => isLocal(s) ? s.hash : s.commit;
/** Where a version came from, for people: `owner/repo@<sha12>`, or `local <dir>@<hash12>`. */
export const describeSource = (s: PieceSource): string =>
  isLocal(s) ? `local ${s.path}@${s.hash.slice(0, 12)}` : `${s.repo}@${s.commit.slice(0, 12)}`;

export interface PieceRecord {
  v: 1;
  name: string;
  source: PieceSource;
  package: string;
  version: string;
  installed: string;
  /** `commit` is the previous version's key (versionKey: a local piece's is its hash); `source` is where it came from. */
  previous?: { commit: string; version: string; source?: PieceSource };
  bins: string[];
  loom: LoomBlock;
  /** The node npm ran on: the piece runs with it first on PATH, since its native modules were built for it. */
  node?: string;
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

/**
 * The managed pieces whose loom block says `"role": "runtime"`. A runtime token is minted
 * for, and reaches as, only the one such piece (docs/specs/conversations.md, "Who writes
 * what"); with none or several, there's no runtime to be.
 */
export function runtimePieces(env: NodeJS.ProcessEnv): string[] {
  return managedPieces(env).filter((r) => r.loom.role === 'runtime').map((r) => r.name);
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
  // The node it was installed with goes first: whatever node the daemon's PATH finds may not
  // load the native modules npm built for that one (taskstore's better-sqlite3).
  if (owner.node && isAbsolute(owner.node) && existsSync(owner.node)) out.PATH = [dirname(owner.node), ...(env.PATH ?? '').split(delimiter).filter(Boolean)].join(delimiter);
  const values = readSettings(env, owner.name);
  for (const s of owner.loom.settings) {
    if (values[s.name] !== undefined) out[s.name] = values[s.name];
    else if (env[s.name] === undefined && s.default !== undefined) out[s.name] = s.default.split('${LOOM_PIECE_HOME}').join(home);
  }
  return out;
}

export function ownerOfBin(env: NodeJS.ProcessEnv, bin: string): PieceRecord | undefined {
  return managedPieces(env).find((r) => r.bins.includes(bin));
}

/** The managed piece a bin at `path` belongs to (one package may ship several bins), if it's a managed one. */
export function pieceOfPath(env: NodeJS.ProcessEnv, path: string): PieceRecord | undefined {
  const bin = managedBinDir(env);
  return bin && dirname(path) === bin ? ownerOfBin(env, basename(path)) : undefined;
}

/**
 * Old piece names that callers outside loom still use, and the piece each now is: a house's
 * `loom box …`, a `/p/box/…` link, a joined box's `piece:box/<id>` credential. Applied where a
 * name comes in from outside (cli/pieces.ts, resolvePieceName), and only while no installed
 * piece has the old name itself. A piece can't be installed under an old name while the piece
 * it now names is installed.
 */
export const PIECE_ALIASES: Readonly<Record<string, string>> = Object.freeze({ box: 'runtime' });

/** The piece `name` is an old name for, if it is one. */
export const aliasTarget = (name: string): string | undefined => (Object.hasOwn(PIECE_ALIASES, name) ? PIECE_ALIASES[name] : undefined);

/**
 * Why an installed piece under an old name doesn't update in place: the catalog now has its repo
 * under the new name. The swap isn't done for you: the new piece has its own settings (their
 * names carry the piece's, LOOM_BOX_* becoming LOOM_RUNTIME_*) and its own store, and its install
 * is refused while the old one holds the runtime role and the bins. So: remove, install, set.
 * Undefined when `rec` isn't a renamed piece.
 */
export function renamedAdvice(rec: PieceRecord, catalog: readonly CatalogEntry[] = readCatalog()): string | undefined {
  const now = aliasTarget(rec.name);
  if (!now || isLocal(rec.source)) return undefined;
  const repo = rec.source.repo;
  if (!catalog.some((c) => c.name === now && c.repo === repo)) return undefined;
  return `${rec.name} is now the ${now} piece (the same repo, renamed), so it doesn't update in place. To switch: `
    + `loom pieces remove ${rec.name} (its settings and data are kept), then loom pieces install ${now}, then set its settings `
    + `under their new names (loom pieces set ${now} …; the old values stay in pieces/${rec.name}/settings.json). `
    + `Until then, ${rec.name} keeps working as it is.`;
}

/** The catalog of first-party pieces that ships with loom (assets/pieces.json). */
export function readCatalog(path = join(resolveRepoRoot(), 'assets', 'pieces.json')): CatalogEntry[] {
  const c = readJson(path) as { v?: number; pieces?: unknown } | undefined;
  if (!c || c.v !== 1 || !Array.isArray(c.pieces)) return [];
  return c.pieces.filter((p): p is CatalogEntry =>
    !!p && typeof p === 'object' && PIECE.test((p as CatalogEntry).name) && REPO.test((p as CatalogEntry).repo) && COMMIT.test((p as CatalogEntry).commit));
}

/** A tab's kind for pieces whose manifest doesn't say: the catalog's `kinds` (assets/pieces.json). */
export function catalogKinds(path = join(resolveRepoRoot(), 'assets', 'pieces.json')): Record<string, 'place' | 'setting'> {
  const c = readJson(path) as { kinds?: Record<string, unknown> } | undefined;
  return Object.fromEntries(Object.entries(c?.kinds ?? {}).filter(([k, v]) => PIECE.test(k) && (v === 'place' || v === 'setting'))) as Record<string, 'place' | 'setting'>;
}

/** `github:owner/repo#<40-char commit>` → its parts; anything that could move is refused. */
export function parseSource(spec: string): { repo: string; commit: string } {
  const m = /^github:([^#]+)#(.+)$/.exec(spec);
  if (!m || !REPO.test(m[1])) throw new PieceError(`a source is github:<owner>/<repo>#<commit>, not ${JSON.stringify(spec)}`);
  if (!COMMIT.test(m[2])) throw new PieceError('a source names a full 40-character commit: a branch, tag or short commit can move');
  return { repo: m[1], commit: m[2] };
}

/**
 * `path:/abs/dir` → the directory, normalized. Relative paths are refused: they
 * would mean something else from wherever loom (or its daemon) runs.
 */
export function parseLocalSource(spec: string): { path: string } {
  const m = /^path:(.*)$/.exec(spec);
  if (!m) throw new PieceError(`a local source is path:/absolute/dir, not ${JSON.stringify(spec)}`);
  if (!isAbsolute(m[1])) throw new PieceError(`a local source is an absolute path (path:/absolute/dir), not ${JSON.stringify(m[1])}`);
  return { path: resolve(m[1]) };
}

/** What `--from` takes: `github:<owner>/<repo>#<commit>` or `path:/abs/dir`. */
export function parseFrom(spec: string): GithubSource | { path: string } {
  return spec.startsWith('path:') ? parseLocalSource(spec) : parseSource(spec);
}

const str = (v: unknown, max: number): v is string => typeof v === 'string' && v.length > 0 && v.length <= max;

/**
 * The package's `loom` block, checked; a string says what's wrong. A setting
 * may not be one of loom's own variables (LOOM_*), except under the piece's
 * own prefix: the box piece may have LOOM_BOX_PUBLIC_URL. An offer's argv
 * must start with one of the package's `bins` (none given: no argv passes).
 */
export function parseLoomBlock(raw: unknown, piece?: string, bins?: readonly string[]): LoomBlock | string {
  const own = piece ? `LOOM_${piece.toUpperCase().replace(/-/g, '_')}_` : undefined;
  if (raw === undefined) return { settings: [], services: [] };
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return 'the loom block is not an object';
  const b = raw as Record<string, unknown>;
  const out: LoomBlock = { settings: [], services: [] };
  if (b.name !== undefined) {
    if (typeof b.name !== 'string' || !PIECE.test(b.name)) return 'loom.name is not a piece name';
    out.name = b.name;
  }
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
    if (typeof name !== 'string' || !SETTING.test(name) || (name.startsWith('LOOM_') && !(own && name.startsWith(own))) || RESERVED_SETTINGS.has(name)) {
      return `a setting's name must be an UPPERCASE variable that isn't loom's own (LOOM_*${own ? `, apart from ${own}*` : ''}) or ${[...RESERVED_SETTINGS].join('/')}: ${JSON.stringify(name)}`;
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
    if (v.keepChildren !== undefined && typeof v.keepChildren !== 'boolean') return `service ${v.name}: keepChildren is true or false`;
    out.services.push({ name: v.name as string, argv: argv as string[], ...(v.keepChildren ? { keepChildren: true } : {}) });
  }
  if (b.strangers !== undefined) {
    const st = b.strangers;
    if (!Array.isArray(st) || st.length > 4 || !st.every((x) => typeof x === 'string' && PIECE.test(x))) {
      return 'loom.strangers is a list of at most 4 API path names (lowercase letters, digits and dashes)';
    }
    out.strangers = st as string[];
  }
  if (b.api_serve !== undefined) {
    const sv = b.api_serve;
    if (!Array.isArray(sv) || sv.length > 8 || !sv.every((x) => typeof x === 'string' && PIECE.test(x)) || new Set(sv).size !== sv.length) {
      return 'loom.api_serve is a list of at most 8 API path names (lowercase letters, digits and dashes), each once';
    }
    // Never a path a caller with no token reaches: a long-lived server is for known callers' calls.
    if (out.strangers?.some((x) => sv.includes(x))) return 'loom.api_serve can\'t name a path loom.strangers opens';
    out.api_serve = sv as string[];
  }
  if (b.store !== undefined) {
    const d = parseStoreDecl(b.store);
    if (typeof d === 'string') return d;
    out.store = d;
  }
  const offers = parseOffers(b, { bins, role: out.role });
  if (typeof offers === 'string') return offers;
  if (offers.grants_store !== undefined) {
    const c = out.store && Object.hasOwn(out.store, offers.grants_store) ? out.store[offers.grants_store] : undefined;
    if (!c || c.history === false) return `loom.grants_store names a collection the piece declares in loom.store, one that keeps its revisions: not ${offers.grants_store}`;
  }
  return { ...out, ...offers };
}

/** Why `loom` can't be piece `name`'s beside the other installed pieces (offers.ts, offerConflicts). */
export function loomConflicts(env: NodeJS.ProcessEnv, name: string, loom: LoomBlock): string | undefined {
  return offerConflicts(name, loom, managedPieces(env));
}

/** npm from PATH (a test puts a stand-in first on it). */
/** The first executable `node` in an absolute PATH dir: the one npm (a node program) runs on. */
function nodeOnPath(env: NodeJS.ProcessEnv): string | undefined {
  // A relative entry (`.`) would make the piece's PATH depend on where it's run from.
  for (const dir of (env.PATH ?? '').split(delimiter).filter((d) => isAbsolute(d))) {
    const p = join(dir, 'node');
    try { accessSync(p, fsConstants.X_OK); return p; } catch { /* next */ }
  }
  return undefined;
}

function runNpm(env: NodeJS.ProcessEnv, args: string[], log: string, append = false): Promise<number> {
  const npm = 'npm';
  return new Promise((done) => {
    const out: Buffer[] = [];
    const child = spawn(npm, args, { env, stdio: ['ignore', 'pipe', 'pipe'] });
    child.stdout.on('data', (d: Buffer) => out.push(d));
    child.stderr.on('data', (d: Buffer) => out.push(d));
    child.on('error', (err) => { out.push(Buffer.from(`couldn't run ${npm}: ${err.message}\n`)); });
    child.on('close', (code) => {
      writeFileSync(log, `$ ${npm} ${args.join(' ')}\n${Buffer.concat(out).toString()}`, append ? { flag: 'a' } : {});
      done(code ?? 1);
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

/** The git commit `dir` is at, if it's a clean git work tree; else nothing. */
function cleanCommit(env: NodeJS.ProcessEnv, dir: string): string | undefined {
  const git = (...args: string[]) => spawnSync('git', ['-C', dir, ...args], { env, encoding: 'utf-8', timeout: 10_000 });
  const head = git('rev-parse', 'HEAD');
  if (head.status !== 0 || !COMMIT.test(head.stdout.trim())) return undefined;
  const status = git('status', '--porcelain', '--', '.');
  return status.status === 0 && status.stdout.trim() === '' ? head.stdout.trim() : undefined;
}

/**
 * Snapshot a local piece's directory: `npm pack` it (which runs its `prepare`,
 * in the directory, as `npm pack` always does) into `staging/package.tgz`.
 * The tarball is what gets installed, and its sha256 is the version.
 */
async function packLocal(
  env: NodeJS.ProcessEnv, dir: string, staging: string, log: string, failed: (what: string, code: number) => PieceError,
): Promise<LocalSource> {
  let st;
  try { st = lstatSync(dir); } catch { throw new PieceError(`${dir} doesn't exist`); }
  if (!st.isDirectory()) throw new PieceError(`${dir} isn't a directory`);
  if (!existsSync(join(dir, 'package.json'))) throw new PieceError(`${dir} has no package.json, so it isn't a package`);
  const commit = cleanCommit(env, dir);
  const dest = join(staging, '.pack');
  mkdirSync(dest, { recursive: true });
  const code = await runNpm(env, ['pack', dir, '--pack-destination', dest], log);
  if (code !== 0) throw failed('npm pack', code);
  const tgz = readdirSync(dest).filter((f) => f.endsWith('.tgz'));
  if (tgz.length !== 1) throw new PieceError(`npm pack made ${tgz.length} tarballs, not 1`);
  const tarball = join(staging, 'package.tgz');
  renameSync(join(dest, tgz[0]), tarball);
  rmSync(dest, { recursive: true, force: true });
  const hash = createHash('sha256').update(readFileSync(tarball)).digest('hex');
  return { path: dir, hash, ...(commit ? { commit } : {}) };
}

export interface InstallResult {
  record: PieceRecord;
  updated: boolean;
  /** A local piece whose directory hasn't changed since it was installed: nothing was done. */
  unchanged?: boolean;
  missing: string[];
  services: ServicesResult;
}

/**
 * Install `source` as piece `name` (from the catalog, or a local piece's
 * update), or as whatever its one loom-<name> bin names (from GitHub or a
 * local directory). A failed install leaves what was current untouched.
 */
export async function installPiece(
  env: NodeJS.ProcessEnv,
  from: GithubSource | { path: string },
  name?: string,
  /** `services: false` installs without starting the piece's services (a restore starts them after its part is in). */
  opts: { services?: boolean } = {},
): Promise<InstallResult> {
  const root = rootOrThrow(env);
  mkdirSync(join(root, 'bin'), { recursive: true });
  const staging = join(root, `.staging-${isLocal(from) ? 'local' : from.commit.slice(0, 12)}-${process.pid}`);
  rmSync(staging, { recursive: true, force: true });
  mkdirSync(staging, { recursive: true });
  const log = join(root, `.install-${process.pid}.log`);
  const failed = (what: string, code: number) => {
    renameSync(log, join(root, 'install.log'));
    return new PieceError(`${what} failed (exit ${code}); its output is in ${join(root, 'install.log')}`);
  };
  try {
    let source: PieceSource;
    let spec: string;
    if (isLocal(from)) {
      source = await packLocal(env, from.path, staging, log, failed);
      // The same snapshot as what's current: there's nothing to do.
      const same = managedPieces(env).find((r) => isLocal(r.source) && r.source.path === from.path && r.source.hash === (source as LocalSource).hash
        && (!name || r.name === name) && existsSync(join(root, r.name, 'versions', r.source.hash)));
      if (same) return { record: same, updated: false, unchanged: true, missing: missingSettings(env, same), services: { started: [], notes: [] } };
      spec = join(staging, 'package.tgz');
    } else {
      source = from;
      spec = `github:${from.repo}#${from.commit}`;
    }
    const key = versionKey(source);
    const code = await runNpm(env, ['install', '--prefix', staging, '--no-audit', '--no-fund', '--omit=dev', spec], log, isLocal(source));
    if (code !== 0) throw failed('npm install', code);
    const { name: pkgName, pkg } = installedPackage(staging);
    const bins = binsOf(pkg, pkgName);
    // The piece is its one loom-<name> bin, or, with several, the one loom.name names;
    // the others are part of it (they run with its environment).
    const loomBins = bins.filter((b) => b.startsWith('loom-'));
    const declared = (pkg.loom as { name?: unknown } | undefined)?.name;
    if (!loomBins.length) throw new PieceError(`${pkgName} has no loom-<name> bin, so it isn't a piece`);
    if (loomBins.length > 1 && declared === undefined) {
      throw new PieceError(`${pkgName} has ${loomBins.length} loom-<name> bins (${loomBins.join(', ')}): its loom block names which one is the piece (loom.name)`);
    }
    if (declared !== undefined && !loomBins.includes(`loom-${declared}`)) {
      throw new PieceError(`${pkgName}'s loom.name is ${String(declared)}, which isn't one of its bins (${loomBins.join(', ')})`);
    }
    const pieceName = declared !== undefined ? String(declared) : loomBins[0].slice('loom-'.length);
    if (!PIECE.test(pieceName) || pieceName === 'loom') throw new PieceError(`loom-${pieceName} isn't a piece name`);
    // An old name (PIECE_ALIASES) can't be installed beside the piece it now names.
    const renamedTo = aliasTarget(pieceName);
    if (renamedTo && readRecord(env, renamedTo)) {
      throw new PieceError(`${pieceName} is an old name for ${renamedTo}, which is installed: a piece can't be installed as ${pieceName} while ${renamedTo} is`);
    }
    if (name && pieceName !== name) throw new PieceError(`${isLocal(source) ? source.path : `the catalog's ${name}`} installs loom-${pieceName}, not loom-${name}`);
    const bad = bins.find((b) => !BIN.test(b));
    if (bad) throw new PieceError(`bin name ${JSON.stringify(bad)} isn't allowed`);
    const loom = parseLoomBlock(pkg.loom, pieceName, bins);
    if (typeof loom === 'string') throw new PieceError(`${pkgName}: ${loom}`);
    const conflict = loomConflicts(env, pieceName, loom);
    if (conflict) throw new PieceError(`${pkgName}: ${conflict}`);
    for (const other of managedPieces(env)) {
      if (other.name === pieceName) continue;
      const clash = bins.find((b) => other.bins.includes(b));
      if (clash) throw new PieceError(`${clash} is already the ${other.name} piece's`);
    }

    const home = join(root, pieceName);
    mkdirSync(join(home, 'versions'), { recursive: true });
    const version = join(home, 'versions', key);
    if (existsSync(version)) rmSync(staging, { recursive: true, force: true });
    else renameSync(staging, version);
    renameSync(log, join(home, 'install.log'));

    const old = readRecord(env, pieceName);
    const record: PieceRecord = {
      v: 1, name: pieceName, source, package: pkgName, version: typeof pkg.version === 'string' ? pkg.version : '',
      installed: new Date().toISOString(), bins, loom, ...(nodeOnPath(env) ? { node: nodeOnPath(env) } : {}),
      ...(old && versionKey(old.source) !== key ? { previous: { commit: versionKey(old.source), version: old.version, source: old.source } } : old?.previous ? { previous: old.previous } : {}),
    };
    swapLink(join('versions', key), join(home, 'current'));
    relink(root, record, old);
    writeJson(join(home, 'piece.json'), record);
    prune(home, record);
    // Its venues, in core's registry (docs/specs/conversations.md, "Venues"): update replaces its rows.
    syncVenuesQuietly(env);
    const services = opts.services === false ? { started: [], notes: ['services not started yet'] } : syncServices(env, pieceName, record);
    return { record, updated: !!old, missing: missingSettings(env, record), services };
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
  const keep = new Set([versionKey(record.source), record.previous?.commit].filter(Boolean));
  for (const v of readdirSync(join(home, 'versions'))) {
    if (!keep.has(v)) rmSync(join(home, 'versions', v), { recursive: true, force: true });
  }
}

export function rollbackPiece(env: NodeJS.ProcessEnv, name: string): PieceRecord {
  const root = rootOrThrow(env);
  const rec = readRecord(env, name);
  if (!rec) throw new PieceError(`${name} isn't a managed piece`);
  if (!rec.previous || !existsSync(join(root, name, 'versions', rec.previous.commit))) throw new PieceError(`${name} has no previous version to roll back to`);
  // Where the previous version came from; a record written before that was kept had the same source, at another key.
  const source: PieceSource = rec.previous.source && versionKey(rec.previous.source) === rec.previous.commit ? rec.previous.source
    : isLocal(rec.source) ? { path: rec.source.path, hash: rec.previous.commit } : { repo: rec.source.repo, commit: rec.previous.commit };
  const back: PieceRecord = {
    ...rec, source, version: rec.previous.version,
    installed: new Date().toISOString(), previous: { commit: versionKey(rec.source), version: rec.version, source: rec.source },
  };
  // The previous version's own bins are read from its package.json.
  const { name: pkgName, pkg } = installedPackage(join(root, name, 'versions', versionKey(back.source)));
  back.bins = binsOf(pkg, pkgName);
  const loom = parseLoomBlock(pkg.loom, name, back.bins);
  if (typeof loom !== 'string') {
    const conflict = loomConflicts(env, name, loom);
    if (conflict) throw new PieceError(`${name}'s previous version can't come back: ${conflict}`);
    back.loom = loom;
  }
  swapLink(join('versions', versionKey(back.source)), join(root, name, 'current'));
  relink(root, back, rec);
  writeJson(join(root, name, 'piece.json'), back);
  syncVenuesQuietly(env);
  syncServices(env, name, back);
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
  syncServices(env, name, undefined);
  const home = join(root, name);
  if (purge) rmSync(home, { recursive: true, force: true });
  // Settings and data stay, so installing it again picks up where it was.
  else for (const f of ['versions', 'current', 'piece.json', 'install.log']) rmSync(join(home, f), { recursive: true, force: true });
  // Its venues stay in core's registry, orphaned, even with --purge: the conversations had there are the agent's.
  syncVenuesQuietly(env);
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
  // A service reads its settings when it starts.
  syncServices(env, name, rec);
  return now;
}
