import { periodicContext } from '../transport/periodic-context.js';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { invalidateManifest, manifestDelivery, manifestToken, saveManifest, sharedManifest } from './manifest-shared.js';
import { backgroundJob } from '../transport/stall-watch.js';
/**
 * Talking to installed pieces for the page: each `loom-<piece>` on PATH is
 * asked `ui --json` for its manifest, `ui page --json` for a page and
 * `ui act --json` to run an action (docs/extensions.md, "The page"). A piece
 * that answers shows up with no configuration; one that doesn't (no `ui`
 * verb, a timeout, bad JSON) simply isn't there. Composes without requiring.
 *
 * Bounded on every axis: one manifest run per piece per cache window however
 * many pages load at once (the in-flight promise is what's cached), a time
 * limit and 512KB per answer, and on a timeout the piece's whole process group
 * is killed (after every run, not just a timeout), and at most MAX_RUNNING
 * pieces run at once. Requests travel on stdin, never argv, so an action's
 * field values (a secret typed into a form) stay out of `ps`.
 *
 * A piece is trusted code running as the same user as the daemon. It gets the
 * daemon's env minus loom's own bearer tokens, but that's hygiene, not a
 * boundary: a same-user process can read the daemon's environment from /proc.
 * Install only pieces you'd trust with the daemon itself.
 */
import { pieceOfPath } from '../cli/pieces-managed.js';
import { serveCall } from './piece-server.js';
import { socketManifest } from './piece-socket.js';
import { householdHome } from '../household.js';
import { mintGrant } from '../stores.js';
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, realpathSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { listPieces, resolvePieceName } from '../cli/pieces.js';
import { pieceEnvFor } from '../cli/pieces-managed.js';
import { parseActResult, parseManifest, parsePage, type ActResult, type Manifest, type Page } from './vocab.js';

export const PIECE_TIMEOUT_MS = 3_000;
/**
 * A page you opened waits longer than a manifest: you're looking at it, and a piece that reads the machine (systemctl,
 * the journal) can take seconds while every other piece answers its manifest at the same moment (Jonathan,
 * 2026-10-29: "machine couldn't show this page, timed out, when it didn't wait very long"; loom-machine's page took
 * 0.3-1.5s alone, so 3s ran out under load).
 */
export const PAGE_TIMEOUT_MS = 15_000;
export const ACT_TIMEOUT_MS = 15_000;
export const PIECE_MAX_BYTES = 512 * 1024;
/**
 * Longer than the page's 30s refresh, so an open tab doesn't re-run every piece each time; as long as the open apps'
 * round waits on a piece that hasn't moved (ROUND_MAX_MS), so a page load never runs what the round would have.
 */
export const CACHE_MS = 60_000;
/**
 * The open apps' round (live.ts) asks each piece every ROUND_MS, and one that answered the same as before less often:
 * with at least CACHE_MS between process-backed asks, and up to ROUND_MAX_MS (t-2110: every piece every 15 s per open
 * scope kept loom's machine at load 10-12). Its own word that it moved, an action on it, or its records moving asks it
 * at the next round again. Served manifests retain their short window for idle observations. An answer younger than SHARE_MS is everyone's: a round over four scopes, a page load
 * just after a piece's word, and the next scope's round all get the one run.
 */
export const ROUND_MS = 15_000;
export const ROUND_MAX_MS = 60_000;
export const SHARE_MS = 5_000;
/**
 * A manifest run nobody is waiting on may take this long (t-2064: under load, the runtime's took 3.3-10.7 s, so at 3 s
 * it timed out and dropped off the page). A page load waits at most PIECE_TIMEOUT_MS for it, then shows the last good
 * answer (or, with none, skips the piece); the run goes on and keeps its answer for the next look.
 */
export const MANIFEST_RUN_MS = 12_000;
/**
 * Past CACHE_MS a page still gets the last answer at once while a fresh one runs behind it (stale while
 * revalidating): a page never waits on every piece because a window ran out (Jonathan, 2026-10-29: "this site is
 * sloooow"; an agent's Today took 2.3s on the load after expiry, 40ms otherwise). Past STALE_MAX_MS it waits.
 */
export const STALE_MAX_MS = 10 * 60_000;
/** After the piece exits, how long to wait for its stdout to close (a background helper may hold it). */
const DRAIN_MS = 200;
/** Env loom never hands to a piece. */
const WITHHELD = ['LOOM_BEARER_TOKEN', 'LOOM_KNOWLEDGE_BEARER_TOKENS'];

/**
 * What a piece's process may write in its loom store, for this one call (docs/specs/piece-storage.md):
 * a household owner's action writes its owner collections; an agent's call, that agent's keys. Anything
 * else gets no grant, and writes as the piece itself (LOOM_PIECE_NAME). Only for a managed piece.
 */
function withGrant(env0: NodeJS.ProcessEnv, path: string, caller: ApiCaller | undefined): NodeJS.ProcessEnv {
  // Never one inherited from loom's own environment: a grant is minted for this call or there's none.
  const { LOOM_STORE_GRANT: _inherited, ...env } = env0;
  const rec = caller ? pieceOfPath(env, path) : undefined;
  if (!caller || !rec) return env;
  const piece = rec.name;
  const home = householdHome(env);
  if (caller.kind === 'owner' && (caller.agents === undefined || caller.agents === '*')) {
    return { ...env, LOOM_STORE_GRANT: mintGrant(home, { piece, owner: true, ...(caller.who ? { who: caller.who } : {}) }) };
  }
  if (caller.kind === 'agent') return { ...env, LOOM_STORE_GRANT: mintGrant(home, { piece, agent: caller.agent }) };
  return env;
}

export interface PieceInfo {
  piece: string;
  path: string;
  manifest: Manifest;
}

/** Why a piece contributed nothing, for the page footer (never shown as an error). */
export interface PieceSkip {
  piece: string;
  reason: string;
}

/** A non-zero exit keeps what the piece printed (`stdout`): an offer may say why it failed there. */
type Answer = { ok: true; stdout: string } | { ok: false; reason: string; code?: number | null; stdout?: string };
type ManifestResult = PieceInfo | PieceSkip;
/**
 * `expired`: the piece said it moved, so the next look asks it again, keeping this answer for a run that fails or is
 * slow (t-2064). `print` is the answer as the round compares it, `same` how many rounds in a row it came back the same.
 */
interface CacheEntry { settled?: ManifestResult; at: number; result: Promise<ManifestResult>; refreshing?: number; expired?: boolean; print?: string; same?: number; recordsMoved?: boolean }
const cache = new Map<string, CacheEntry>();
/** Failed/unsupported UI offers get the same freshness window as a manifest, rather than a process per live round. */
const failedManifests = new Map<string, { at: number; result: ManifestResult }>();
function forgetFailures(path?: string): void {
  for (const key of failedManifests.keys()) if (path === undefined || key.startsWith(`${path}\0`)) failedManifests.delete(key);
}
let manifestGeneration = 0;
/**
 * When an action last ran on a piece (by path), or on every piece (''): a served manifest must be made since then
 * (piece-socket.ts), so the look after an action never shows the manifest from before it. A piece's own word that it
 * moved isn't one: a service says so after it made the answer that moved (the runtime's ui-socket.mjs).
 */
const movedAt = new Map<string, number>();
const sinceFor = (path: string): number => {
  const t = Math.max(movedAt.get(path) ?? 0, movedAt.get('') ?? 0);
  // A clock stepped back: no answer could be made "since", so ask for none rather than refuse every one.
  return t > Date.now() ? 0 : t;
};
/** The runs under way, by cache key: whoever asks while one runs shares it (unless a piece's word came since). */
const running = new Map<string, { generation: number; result: Promise<ManifestResult> }>();
/**
 * What a piece's answer turns on, from its last good answer, by path and version: LOOM_SCOPE only with `scope`, the
 * owner scope only with `owners: 2` (vocab.ts). A piece that declares neither answers one manifest for every window,
 * so one run is everyone's (t-2110: the runtime's ran once per open agent window, every round and every word).
 */
const turnsOn = new Map<string, { scope: boolean; owners: boolean }>();

/**
 * Forget every scope's manifests, not their pages (live.ts, on a piece's own word that it moved): an agent's window
 * asks with its own scope, which no open stream may be refreshing, and its next look must not be a minute old. The
 * answer stays as the one to show if the next run fails or runs long. `path`: that piece's alone, in every scope (t-2065).
 */
export function expirePieceManifests(path?: string): void {
  forgetFailures(path);
  manifestGeneration++;
  // Every piece at once (no word from one of them in particular): any served answer from before is suspect.
  if (path === undefined) movedAt.set('', Date.now());
  for (const [k, e] of cache) if (path === undefined || k.startsWith(`${path}\0`)) e.expired = true;
}

export function clearPieceCache(path?: string): void {
  for (const home of sharedHomes.keys()) invalidateManifest(home, path);
  forgetFailures(path);
  manifestGeneration++;
  movedAt.set(path ?? '', Date.now());
  if (path === undefined) { cache.clear(); pages.clear(); return; }
  // Every scope's answer for that piece, and every page of it.
  for (const m of [cache, pages] as Map<string, unknown>[]) for (const k of [...m.keys()]) if (k.startsWith(`${path}\0`)) m.delete(k);
}

/**
 * A piece's shared records moved (collections/pull.ts logged a change, or its API said it wrote): its kept pages go, so
 * the next look runs it, not the last copy (t-2029: an open Tasks page is asked again when its tasks move, and a copy kept
 * for up to 5 s, then shown while revalidating, would answer with the old one). Its manifests stay.
 */
export function forgetPiecePages(path: string): void {
  for (const home of sharedHomes.keys()) invalidateManifest(home, path);
  // A run started before this write cannot consume the hint or restore a
  // failure cooldown when it lands. Invalidate it as a producer change.
  expirePieceManifests(path);
  for (const k of [...pages.keys()]) if (k.startsWith(`${path}\0`)) pages.delete(k);
  // Its manifest likely moved with them (a count on its tile): the next round asks it, however long it was quiet.
  for (const [k, e] of cache) if (k.startsWith(`${path}\0`)) { e.same = 0; e.recordsMoved = true; }
}

/**
 * A piece's pages, kept briefly the same way (stale while revalidating): opening one again shows the last copy
 * at once and asks the piece behind it, instead of starting its process on every visit (0.3-0.8s each). Keyed
 * by who's looking, the scope, the version, the path and the query; an action on the piece drops them all.
 */
export const PAGE_FRESH_MS = 5_000;
export const PAGE_STALE_MS = 5 * 60_000;
/**
 * A page that set `refresh` is waiting on something that's changing (a sign-in being checked): it's kept only this
 * long, to share one run between tabs, and never shown stale, so each of its reloads sees the piece's state now.
 */
export const PAGE_LIVE_MS = 1_000;
const PAGES_MAX = 500;
interface PageEntry { at: number; result: Promise<Page | string>; refreshing?: boolean; live?: boolean }
const pages = new Map<string, PageEntry>();

export function pieceEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const out = { ...env };
  for (const k of WITHHELD) delete out[k];
  return out;
}

function killGroup(pid: number | undefined): void {
  if (pid === undefined) return;
  try { process.kill(-pid, 'SIGKILL'); } catch { /* already gone */ }
}

/**
 * At most this many piece processes at once, across every page load: a burst
 * of requests queues instead of forking a process each. The time limit starts
 * when a piece actually runs.
 */
export const MAX_RUNNING = 6;

/**
 * A pool of piece processes. The page's and the API's are separate, so callers
 * of /api (a box, which may be compromised) can never starve the owner's page.
 * The API's queue is bounded too: past it, a call is refused, not parked.
 */
export class Pool {
  private running = 0;
  private readonly waiting: Array<() => void> = [];
  constructor(private readonly max: number, private readonly maxWaiting = Infinity) {}

  /** null when the queue is full, or when `gone` fired before a slot came up. */
  async run<T>(f: () => Promise<T>, gone?: AbortSignal): Promise<T | null> {
    if (this.running >= this.max) {
      if (this.waiting.length >= this.maxWaiting) return null;
      const got = await new Promise<boolean>((resolve) => {
        const go = () => { gone?.removeEventListener('abort', drop); resolve(true); };
        const drop = () => { const i = this.waiting.indexOf(go); if (i >= 0) this.waiting.splice(i, 1); resolve(false); };
        this.waiting.push(go);
        gone?.addEventListener('abort', drop, { once: true });
      });
      if (!got) return null;
    }
    if (gone?.aborted) { this.waiting.shift()?.(); return null; }
    this.running++;
    try { return await f(); } finally {
      this.running--;
      this.waiting.shift()?.();
    }
  }

  /** Nothing running and nothing waiting: a caller keeping pools per key may drop this one. */
  get idle(): boolean { return this.running === 0 && this.waiting.length === 0; }
}

const pagePool = new Pool(MAX_RUNNING);
/** /api: at most four at once, eight more waiting. */
export const MAX_API_RUNNING = 4;
export const MAX_API_WAITING = 8;
const apiPool = new Pool(MAX_API_RUNNING, MAX_API_WAITING);
/**
 * The offers that may run long (agent-runtime.md: 120 s each) each have a pool of their own, so
 * neither holds the page's pieces nor the other: an agent's MCP tools can't starve delivery, and
 * a flood of deliveries can't starve the tools. Past a pool's queue, a call is refused as busy.
 *  - `mcp_tools`: four at once, sixteen waiting;
 *  - `delivery`: eight at once, thirty-two waiting, larger than one calling piece's share
 *    (src/delivery.ts: 2 running, 4 waiting), so one piece at its cap leaves room for others.
 *  - `grants`: eight at once, thirty-two waiting. Every agent call to a piece asks the authority
 *    first (src/grants.ts), so the ask never queues behind a page's pieces or a long tool.
 */
export const MAX_TOOLS_RUNNING = 4;
export const MAX_TOOLS_WAITING = 16;
export const MAX_DELIVERY_RUNNING = 8;
export const MAX_DELIVERY_WAITING = 32;
export const MAX_GRANTS_RUNNING = 8;
export const MAX_GRANTS_WAITING = 32;
export type OfferPool = 'page' | 'tools' | 'delivery' | 'grants' | 'collections';
const offerPools: Record<Exclude<OfferPool, 'page'>, Pool> = {
  tools: new Pool(MAX_TOOLS_RUNNING, MAX_TOOLS_WAITING),
  grants: new Pool(MAX_GRANTS_RUNNING, MAX_GRANTS_WAITING),
  delivery: new Pool(MAX_DELIVERY_RUNNING, MAX_DELIVERY_WAITING),
  // Bounded per provider by its caller (src/collections/providers.ts: four running, sixteen waiting each).
  collections: new Pool(Infinity),
};

async function ask(path: string, args: string[], env: NodeJS.ProcessEnv, opts: { stdin?: string; timeoutMs?: number; maxBytes?: number } = {}): Promise<Answer> {
  return (await pagePool.run(() => run(path, args, env, opts)))!;
}

/**
 * `onLine`: the answer read as it comes, a line at a time (collections, src/collections/serve.ts): nothing is kept, and
 * `stop` ends the piece there (`stopped`).
 */
function run(path: string, args: string[], env: NodeJS.ProcessEnv, opts: { stdin?: string; timeoutMs?: number; maxBytes?: number; onLine?: (line: string) => 'go' | 'stop' }): Promise<Answer> {
  return new Promise((resolve) => {
    const background = periodicContext.getStore();
    let command = path, argv = args;
    if (background) {
      const dir = join(background.home, 'periodic-jobs');
      mkdirSync(dir, { recursive: true, mode: 0o700 });
      const key = createHash('sha256').update(JSON.stringify([path, args, scopeKey(env)])).digest('hex');
      const built = fileURLToPath(new URL('../transport/periodic-child.js', import.meta.url));
      const source = fileURLToPath(new URL('../transport/periodic-child.ts', import.meta.url));
      argv = existsSync(built) ? [built] : ['--import', createRequire(import.meta.url).resolve('tsx'), source];
      argv.push(join(dir, `${key}.db`));
      command = process.execPath;
    }
    // A background guardian holds its command lock until its independently bounded child exits.
    const child = spawn(command, argv, {
      env: pieceEnvFor(path, pieceEnv(env)),
      stdio: [background || opts.stdin !== undefined ? 'pipe' : 'ignore', 'pipe', 'ignore'],
      detached: true,
    });
    let out = '';
    let bytes = 0;
    let settled = false;
    let exited = false;
    let cancelled: Answer | undefined;
    let drain: NodeJS.Timeout | undefined;
    const finish = (r: Answer) => {
      if (settled) return;
      if (background && !exited && !r.ok) {
        cancelled ??= r;
        clearTimeout(timer);
        child.stdout?.destroy();
        child.kill('SIGTERM');
        return; // The admitted promise retains ownership until the guardian drains and exits.
      }
      r = cancelled ?? r;
      settled = true;
      clearTimeout(timer);
      if (drain) clearTimeout(drain);
      child.stdout?.destroy();
      // Every time, not only on a timeout: whatever the piece left running in
      // its group goes with it. (A piece that calls setsid on purpose escapes.)
      if (background) { if (!r.ok) child.kill('SIGTERM'); } else killGroup(child.pid);
      resolve(r);
    };
    const timer = setTimeout(() => { finish({ ok: false, reason: 'timed out' }); }, opts.timeoutMs ?? PIECE_TIMEOUT_MS);
    // Decoded as a stream, so a character split across two chunks stays whole.
    child.stdout?.setEncoding('utf-8');
    child.stdout?.on('data', (d: string) => {
      bytes += Buffer.byteLength(d);
      // Read a line at a time, only the line still coming is held, and the cap is on it: every line before it was
      // already read (and checked) by the caller, so no limit here turns on what an unread line held.
      if (!opts.onLine && bytes > (opts.maxBytes ?? PIECE_MAX_BYTES)) { finish({ ok: false, reason: 'answer too large' }); return; }
      out += d;
      if (!opts.onLine) return;
      if (out.length > (opts.maxBytes ?? PIECE_MAX_BYTES) && out.indexOf('\n') < 0) { finish({ ok: false, reason: 'line too long' }); return; }
      let i;
      while ((i = out.indexOf('\n')) >= 0) {
        const line = out.slice(0, i);
        out = out.slice(i + 1);
        if (line.trim() && opts.onLine(line) === 'stop') { finish({ ok: false, reason: 'stopped' }); return; }
      }
    });
    child.on('error', (e) => { exited = true; finish({ ok: false, reason: e.message }); });
    if ((background || opts.stdin !== undefined) && child.stdin) {
      child.stdin.on('error', () => { /* the piece closed stdin early; its answer decides */ });
      child.stdin.end(background ? JSON.stringify({ path, args, stdin: opts.stdin, timeout: opts.timeoutMs ?? PIECE_TIMEOUT_MS }) : opts.stdin);
    }
    // Resolve on the piece's own exit (plus a short drain), not on 'close':
    // 'close' waits for every holder of the pipe, and a helper the piece left
    // running would hold it open past the timeout.
    child.on('exit', (code) => {
      exited = true;
      const done = () => {
        // The last line, unterminated.
        if (opts.onLine && out.trim() && !settled) { const line = out; out = ''; if (opts.onLine(line) === 'stop') return finish({ ok: false, reason: 'stopped' }); }
        finish(code === 0 ? { ok: true, stdout: out } : background && code === 75 ? { ok: false, reason: 'busy' } : { ok: false, reason: 'no ui', code, stdout: out });
      };
      if (child.stdout?.readableEnded) return done();
      child.stdout?.once('end', done);
      drain = setTimeout(done, DRAIN_MS);
    });
  });
}

/**
 * Run a piece's bin with `args` (and `stdin`, when given) under the manifest
 * runner's limits: 3 s, the process group killed afterwards, at most
 * MAX_RUNNING at once, in the page's pool. In the piece's own environment, and
 * with a store grant when there's a caller. The runner for offers
 * (src/offers-registry.ts, runOffer): a failure says why, an exit says its code.
 * `pool` runs it in a long offer's own pool instead (`tools`, `delivery`), for
 * `timeoutMs` (a full pool answers `busy`). A non-zero exit says its code and
 * keeps the stdout.
 */
export async function runPieceBin(
  path: string, args: string[], env: NodeJS.ProcessEnv,
  opts: { serve?: string[]; stdin?: string; maxBytes?: number; caller?: ApiCaller; pool?: OfferPool; timeoutMs?: number; onLine?: (line: string) => 'go' | 'stop' } = {},
): Promise<{ ok: true; stdout: string } | { ok: false; reason: string; exit?: number; stdout?: string }> {
  const env1 = withGrant(env, path, opts.caller);
  const execute = async (): Promise<Answer> => {
    if (opts.serve && opts.stdin !== undefined && !periodicContext.getStore()) {
      const { LOOM_STORE_GRANT: grant, ...rest } = env1;
      let request: unknown;
      try { request = JSON.parse(opts.stdin); } catch { return { ok: false, reason: 'invalid request' }; }
      const pending = serveCall(path, resolved(path), pieceEnvFor(path, pieceEnv(rest)), grant, request,
        { argv: opts.serve, timeoutMs: opts.timeoutMs ?? PIECE_TIMEOUT_MS, maxBytes: opts.maxBytes ?? PIECE_MAX_BYTES });
      if (pending) {
        const answer = await pending;
        if (!answer.ok || !opts.onLine) return answer;
        // The same row parser and admission checks as the one-shot path. Answers are never reused between calls.
        for (const line of answer.stdout.split('\n')) {
          if (!line.trim()) continue;
          if (Buffer.byteLength(line) > (opts.maxBytes ?? PIECE_MAX_BYTES)) return { ok: false, reason: 'line too long' };
          if (opts.onLine(line) === 'stop') return { ok: false, reason: 'stopped' };
        }
        return { ok: true, stdout: '' };
      }
    }
    return run(path, args, env1, { stdin: opts.stdin, maxBytes: opts.maxBytes, timeoutMs: opts.timeoutMs, onLine: opts.onLine });
  };
  const r = await (opts.pool && opts.pool !== 'page' ? offerPools[opts.pool] : pagePool).run(execute);
  if (r === null) return { ok: false, reason: 'busy' };
  if (r.ok) return r;
  if (r.reason !== 'no ui') return { ok: false, reason: r.reason };
  return { ok: false, reason: `exit ${r.code ?? 'by signal'}`, ...(typeof r.code === 'number' ? { exit: r.code } : {}), ...(r.stdout !== undefined ? { stdout: r.stdout } : {}) };
}

function json(stdout: string): unknown {
  try { return JSON.parse(stdout); } catch { return undefined; }
}

async function fetchManifest(piece: string, path: string, env: NodeJS.ProcessEnv): Promise<ManifestResult> {
  // From the piece's own service when it has one (piece-socket.ts, t-2114): no process, an answer from memory.
  // Not for an agent owner's window: a piece that understands owners (owners: 2) may narrow its answer by
  // LOOM_OWNER_SCOPE, which a socket never hears. Their windows run it the one-shot way, with the scope.
  const fromSocket = env.LOOM_OWNER_SCOPE ? undefined : await socketManifest(path, env, { maxBytes: PIECE_MAX_BYTES, since: sinceFor(path) });
  let served: Manifest | undefined;
  if (fromSocket?.ok) {
    const parsed = json(fromSocket.stdout);
    const m = parsed === undefined ? 'not JSON' : parseManifest(parsed);
    // One answer for every viewer is all a socket can give (it hears nothing of the viewer): a manifest that says it
    // reads the viewer's scope is never taken from one, nor a broken one. The one-shot way, with the scope in its env.
    if (typeof m !== 'string' && m.scope !== true) served = m;
  }
  if (served) { servedPaths.add(path); return { piece, path, manifest: served }; }
  servedPaths.delete(path);
  const r = await ask(path, ['ui', '--json'], env, { timeoutMs: MANIFEST_RUN_MS });
  if (!r.ok) return { piece, reason: r.reason };
  const parsed = json(r.stdout);
  if (parsed === undefined) return { piece, reason: 'invalid: not JSON' };
  const m = parseManifest(parsed);
  return typeof m === 'string' ? { piece, reason: `invalid: ${m}` } : { piece, path, manifest: m };
}

/** Sharing is enabled only for full HTTP listeners, never scoped/test-only servers. */
const sharedHomes = new Map<string, number>();
export function sharePieceManifests(home: string): () => void {
  sharedHomes.set(home, (sharedHomes.get(home) ?? 0) + 1);
  let stopped = false;
  return () => { if (stopped) return; stopped = true; const n = (sharedHomes.get(home) ?? 1) - 1; if (n) sharedHomes.set(home, n); else sharedHomes.delete(home); };
}
const observedTokens = new Map<string, string>();
function sharedKey(path: string, env: NodeJS.ProcessEnv): { home: string; key: string; token: string } | undefined {
  const home = householdHome(env);
  if (!sharedHomes.has(home)) return;
  const token = manifestToken(home, path);
  return { home, token, key: JSON.stringify([path, resolved(path), scopeKey(env), token]) };
}
function hydrateManifest(piece: string, path: string, env: NodeJS.ProcessEnv): void {
  const shared = sharedKey(path, env);
  if (!shared) return;
  const identity = JSON.stringify([shared.home, path, scopeKey(env)]);
  const previous = observedTokens.get(identity);
  observedTokens.set(identity, shared.token);
  if (previous !== undefined && previous !== shared.token) expirePieceManifests(path);
  const hit = sharedManifest(shared.home, shared.key);
  if (!hit || Date.now() - hit.at >= STALE_MAX_MS) return;
  // This store holds core's already parsed Manifest, rather than the piece's wire format (which has v:2).
  let manifest: Manifest;
  try { manifest = JSON.parse(hit.value) as Manifest; } catch { return; }
  if (!manifest || !Array.isArray(manifest.asks)) return;
  turnsOn.set(`${path}\0${resolved(path)}`, { scope: manifest.scope === true, owners: manifest.owners === 2 });
  const key = keyOf(path, env).key;
  const old = cache.get(key);
  if (old && old.at >= hit.at) return;
  const result: ManifestResult = { piece, path, manifest };
  cache.set(key, { at: hit.at, result: Promise.resolve(result), settled: result, print: printOf(result) });
}
/** A follower reads fingerprints and warms its request cache without invoking providers. */
export function sharedPiecePrints(env: NodeJS.ProcessEnv, only?: ReadonlySet<string>): Map<string, string> {
  const out = new Map<string, string>();
  for (const p of shownPieces(env)) {
    if (only && !only.has(p.path)) continue;
    hydrateManifest(p.name, p.path, env);
    const entry = cache.get(keyOf(p.path, env).key);
    out.set(p.path, entry && Date.now() - entry.at < STALE_MAX_MS ? entry.print ?? '' : '');
  }
  return out;
}

/**
 * The pieces whose last manifest came from their service: an answer costs a few milliseconds, so it's asked again
 * after SERVED_CACHE_MS rather than CACHE_MS, and every round (the service says itself when it moved, and its agents'
 * idle observations last 30 s: t-2010).
 */
const servedPaths = new Set<string>();
export const SERVED_CACHE_MS = 5_000;

/** Where a piece's path leads, and when that file last changed: what makes its answer a new one. */
function resolved(path: string): string {
  try {
    const real = realpathSync(path);
    return `${real}\0${statSync(real).mtimeMs}`;
  } catch {
    return '';
  }
}

/** The scope a piece's page answers for, as part of its key: both scopes, always (a page is a viewer's). */
const scopeKey = (env: NodeJS.ProcessEnv): string => `${env.LOOM_SCOPE ?? ''}\0${env.LOOM_OWNER_SCOPE ?? ''}`;

/**
 * The cache key for a piece's answer to `env`: its path, the scope it answers for, and the file the path resolves to
 * now (an install points pieces/bin/loom-<name> at a new version, which is a new answer at once, not a minute later,
 * t-1584). The scope is the agent it's narrowed to (LOOM_SCOPE) and the agents an agent owner owns (LOOM_OWNER_SCOPE,
 * owners.md), each only when the piece's manifest says it reads it; a piece not heard from yet is keyed by both, so
 * one viewer's answer is never another's (collections.md, "Before any domain moves", 5).
 */
interface Keyed { key: string; version: string; on?: { scope: boolean; owners: boolean } }
function keyOf(path: string, env: NodeJS.ProcessEnv): Keyed {
  const version = resolved(path);
  const on = turnsOn.get(`${path}\0${version}`);
  const scope = !on || on.scope ? env.LOOM_SCOPE ?? '' : '';
  const owners = !on || on.owners ? env.LOOM_OWNER_SCOPE ?? '' : '';
  return { key: `${path}\0${scope}\0${owners}\0${version}`, version, ...(on ? { on } : {}) };
}

/**
 * One run of a piece's manifest for `k.key`, shared by everyone who asks while it runs. A run under a shared key whose
 * answer now says it reads a scope it didn't (a piece edited in place) is nobody's: it was made for one viewer and
 * may be shared with others, so it counts as failed, and the next look is keyed by what the piece says now.
 */
function runManifest(piece: string, path: string, env: NodeJS.ProcessEnv, k: Keyed): Promise<ManifestResult> {
  const { key, version, on } = k;
  const shared = sharedKey(path, env);
  const failed = failedManifests.get(key);
  if (failed && Date.now() - failed.at < CACHE_MS) return Promise.resolve(failed.result);
  failedManifests.delete(key);
  const generation = manifestGeneration;
  const under = running.get(key);
  if (under && under.generation === manifestGeneration) return under.result;
  const result = backgroundJob(`piece manifest ${piece}`, () => fetchManifest(piece, path, env).then((r): ManifestResult => {
    if (!('manifest' in r)) {
      if (r.reason !== 'busy' && generation === manifestGeneration) failedManifests.set(key, { at: Date.now(), result: r });
      return r;
    }
    const now = { scope: r.manifest.scope === true, owners: r.manifest.owners === 2 };
    turnsOn.set(`${path}\0${version}`, now);
    if (on && ((now.scope && !on.scope) || (now.owners && !on.owners))) return { piece, reason: 'reads a new scope' };
    if (shared && generation === manifestGeneration && manifestToken(shared.home, path) === shared.token) {
      saveManifest(shared.home, shared.key, Date.now(), JSON.stringify(r.manifest));
    }
    return r;
  }).finally(() => { if (running.get(key)?.result === result) running.delete(key); }));
  running.set(key, { generation: manifestGeneration, result });
  return result;
}

/** `fresh`, or `last` once `ms` has passed (the run goes on, and its answer is kept for the next look). */
function within(fresh: Promise<ManifestResult>, last: ManifestResult, ms: number): Promise<ManifestResult> {
  let timer: NodeJS.Timeout | undefined;
  const late = new Promise<ManifestResult>((resolve) => { timer = setTimeout(() => resolve(last), ms); });
  return Promise.race([fresh, late]).finally(() => clearTimeout(timer));
}

const printOf = (r: ManifestResult) => ('manifest' in r ? JSON.stringify(r.manifest) : '');

/**
 * Keep a run's answer as `key`'s, if nothing newer came first: a piece's word or an action since it started (the
 * generation), or another answer. One that fails keeps the last good answer (until that's too old) and is asked again
 * next time. A round counts the answers in a row that came back the same.
 */
function keep(key: string, before: CacheEntry | undefined, generation: number, result: Promise<ManifestResult>, r: ManifestResult): void {
  if (generation !== manifestGeneration || cache.get(key) !== before) return;
  if (!('manifest' in r)) {
    // A failure is no answer to compare: no print, so the round asks it again. The last good answer keeps its age, so
    // a piece that keeps failing still ages out (STALE_MAX_MS).
    if (!before) { if (r.reason !== 'busy') cache.set(key, { at: Date.now(), result, settled: r }); return; }
    void before.result.then((last) => {
      if (cache.get(key) !== before || generation !== manifestGeneration) return;
      if ('manifest' in last) { before.refreshing = undefined; before.expired = false; before.same = 0; }
      else cache.set(key, { at: Date.now(), result, settled: r });
    });
    return;
  }
  const print = printOf(r);
  cache.set(key, { at: Date.now(), result, settled: r, print, same: before?.print === print ? (before.same ?? 0) + 1 : 0 });
}

function manifestFor(piece: string, path: string, env: NodeJS.ProcessEnv, nowMs: number): Promise<ManifestResult> {
  hydrateManifest(piece, path, env);
  const k = keyOf(path, env);
  const { key } = k;
  const hit = cache.get(key);
  const timeout: ManifestResult = { piece, reason: 'timed out' };
  const last = hit?.settled;
  // A stream's automatic re-ask must never become another manifest producer. The owner
  // refreshes shared results; explicit requests and admitted snapshot jobs can still ask.
  if (sharedHomes.has(householdHome(env)) && manifestDelivery(householdHome(env)) && !periodicContext.getStore()) {
    return Promise.resolve(hit && nowMs - hit.at < STALE_MAX_MS && last && 'manifest' in last
      ? last : { piece, reason: 'waiting for shared manifest' });
  }
  if (hit && !hit.expired && nowMs - hit.at < (servedPaths.has(path) ? SERVED_CACHE_MS : CACHE_MS)) return within(hit.result, last ?? timeout, PIECE_TIMEOUT_MS);
  const generation = manifestGeneration;
  if (hit && nowMs - hit.at < STALE_MAX_MS) {
    // Past its window, the last answer at once while a fresh one runs behind it. Said to have moved, the fresh one,
    // unless it's slower than a manifest's limit: then the last one, and the fresh one is there for the next look.
    const next = runManifest(piece, path, env, k);
    // One keeper per generation: a word that came since the last one started makes a new run, and it's this one's.
    if (hit.refreshing !== generation) {
      hit.refreshing = generation;
      void next.then((r) => keep(key, hit, generation, next, r));
    }
    if (!hit.expired && last) return Promise.resolve(last);
    return within(next, last ?? timeout, PIECE_TIMEOUT_MS).then((r) => ('manifest' in r ? r : last ?? r));
  }
  // Cache the run itself: concurrent page loads share it, and one that outlasts the page's wait is the next look's.
  const result = runManifest(piece, path, env, k);
  const entry: CacheEntry = { at: nowMs, result };
  cache.set(key, entry);
  void result.then((r) => {
    entry.settled = r;
    if ('manifest' in r) entry.print = printOf(r);
    else if (r.reason === 'busy' && cache.get(key) === entry) cache.delete(key);
  });
  return within(result, { piece, reason: 'timed out' }, PIECE_TIMEOUT_MS);
}

/**
 * The pieces the page shows: every loom-<piece> on PATH, less loom's own name (a piece can't take it) and an old name
 * that is another piece now (PIECE_ALIASES: the runtime's loom-box bin is the runtime, whose pages /p/box/… already
 * redirect to, not a second "Boxes" in Places beside the runtime's in Setup).
 */
function shownPieces(env: NodeJS.ProcessEnv): Array<{ name: string; path: string }> {
  return listPieces(env).filter((p) => p.name !== 'loom' && resolvePieceName(env, p.name) === p.name);
}

/** Process-backed manifests get their full freshness window; a records hint asks again at the next round. */
function roundWait(e: CacheEntry): number {
  if (e.recordsMoved) return SHARE_MS;
  const same = e.same ?? 0;
  // A CLI startup costs the same even when its tile's clock changed. Ordinary
  // rounds respect its freshness window; writes still ask at the next round.
  return Math.max(CACHE_MS, same === 0 ? SHARE_MS : Math.min(ROUND_MS * 2 ** same, ROUND_MAX_MS) - SHARE_MS);
}

/**
 * Ask every piece for its manifest again and keep the answers (src/ui/live.ts runs this while an app is open), except
 * one whose answer is still due no new look: younger than SHARE_MS (another scope's round, or a word just now, ran it),
 * or quiet for rounds in a row (roundWait). A piece said to have moved is always asked. Returns each piece's answer
 * as a fingerprint, so a caller can tell which changed; a piece that changed has its kept pages dropped, so the next
 * look at them is fresh.
 */
export async function refreshPieceManifests(env: NodeJS.ProcessEnv, only?: ReadonlySet<string>): Promise<Map<string, string>> {
  return backgroundJob('piece manifest round', () => refreshPieceManifestsWork(env, only));
}

async function refreshPieceManifestsWork(env: NodeJS.ProcessEnv, only?: ReadonlySet<string>): Promise<Map<string, string>> {
  // `only`: just these pieces' paths (the one that said it moved, t-2065); the others keep their last answers.
  const installed = shownPieces(env).filter((p) => !only || only.has(p.path));
  const out = new Map<string, string>();
  // Reconcile all shared invalidations before starting a generation of parallel producers.
  for (const p of installed) hydrateManifest(p.name, p.path, env);
  await Promise.all(installed.map(async (p) => {
    const k = keyOf(p.path, env);
    const { key } = k;
    const generation = manifestGeneration;
    const before = cache.get(key);
    if (before && !before.expired && before.print !== undefined && Date.now() - before.at < (servedPaths.has(p.path) ? SHARE_MS : roundWait(before))) {
      out.set(p.path, before.print);
      const shared = sharedKey(p.path, env);
      if (shared && before.settled && 'manifest' in before.settled) saveManifest(shared.home, shared.key, before.at, JSON.stringify(before.settled.manifest));
      return;
    }
    const result = runManifest(p.name, p.path, env, k);
    const r = await result;
    keep(key, before, generation, result, r);
    // What it showed before when this run failed: a piece that failed once hasn't moved.
    out.set(p.path, 'manifest' in r || !before?.print ? printOf(r) : before.print);
  }));
  return out;
}

/** Drop a piece's kept pages (not its manifest). */
export function clearPiecePages(path: string): void {
  for (const k of [...pages.keys()]) if (k.startsWith(`${path}\0`)) pages.delete(k);
}

/** Every installed piece's manifest, plus the ones that had nothing to show and why. */
/** The installed pieces whose manifest says they understand agent owners (owners: 2), whatever else they show. */
export async function ownersAwarePieces(env: NodeJS.ProcessEnv, nowMs = Date.now()): Promise<Set<string>> {
  const results = await Promise.all(shownPieces(env).map((p) => manifestFor(p.name, p.path, env, nowMs)));
  return new Set(results.filter((r): r is PieceInfo => 'manifest' in r && r.manifest.owners === 2).map((r) => r.piece));
}

export async function pieceManifests(
  env: NodeJS.ProcessEnv,
  nowMs = Date.now(),
): Promise<{ pieces: PieceInfo[]; skipped: PieceSkip[] }> {
  const installed = shownPieces(env);
  const results = await Promise.all(installed.map((p) => manifestFor(p.name, p.path, env, nowMs)));
  const pieces = results.filter((r): r is PieceInfo => 'manifest' in r);
  // A piece with only Inbox history (notices, answered) or readings for the agents' cards has something to show.
  const empty = pieces.filter((p) => !p.manifest.tab && !p.manifest.tile && !p.manifest.asks.length && !p.manifest.legacy?.length
    && !p.manifest.notices?.length && !p.manifest.answered?.length && !Object.keys(p.manifest.agents ?? {}).length);
  return {
    pieces: pieces.filter((p) => !empty.includes(p)),
    skipped: [...results.filter((r): r is PieceSkip => 'reason' in r), ...empty.map((p) => ({ piece: p.piece, reason: 'nothing to show' }))],
  };
}

/** The cuts already logged (piece, page, fields): a page asked for again doesn't say it again. */
const cutSaid = new Set<string>();

/** One page from a piece, or why it couldn't be had. */
export async function piecePage(
  info: PieceInfo,
  path: string,
  query: Record<string, string>,
  env: NodeJS.ProcessEnv,
  /** Who's looking (docs/specs/owners.md): the member, beside the path and query. */
  caller?: ApiCaller,
  now = Date.now(),
): Promise<Page | string> {
  // A first-version piece has one page: its sections.
  if (info.manifest.legacy) {
    return path === '' ? { title: info.piece, sections: info.manifest.legacy } : { title: 'Not found', sections: [] };
  }
  const run = async (): Promise<Page | string> => {
    const r = await ask(info.path, ['ui', 'page', '--json'], withGrant(env, info.path, undefined), { stdin: JSON.stringify({ path, query, ...(caller ? { caller } : {}) }), timeoutMs: PAGE_TIMEOUT_MS });
    if (!r.ok) return r.reason;
    const parsed = json(r.stdout);
    if (parsed === undefined) return 'not JSON';
    // A block's words over loom's limit are cut short, not the page refused (t-1861); the log says which piece and field.
    return parsePage(parsed, (cut) => {
      const said = `${info.piece}\0${path}\0${cut.join('; ')}`;
      if (cutSaid.has(said)) return;
      if (cutSaid.size > 200) cutSaid.clear();
      cutSaid.add(said);
      process.stderr.write(`loom: piece ${info.piece} page "${path}": cut short ${cut.join('; ')}\n`);
    });
  };
  const key = `${info.path}\0${scopeKey(env)}\0${resolved(info.path)}\0${path}\0${JSON.stringify(query)}\0${JSON.stringify(caller ?? null)}`;
  const hit = pages.get(key);
  if (hit && now - hit.at < (hit.live ? PAGE_LIVE_MS : PAGE_FRESH_MS)) return hit.result;
  if (hit && !hit.live && now - hit.at < PAGE_STALE_MS) {
    if (!hit.refreshing) {
      hit.refreshing = true;
      const next = run();
      // Only a page replaces a page: a failed refresh keeps the last one, and is tried again next time.
      void next.then((fresh) => { if (typeof fresh !== 'string') { if (pages.get(key) === hit) pages.set(key, { at: Date.now(), result: next, ...(fresh.refresh ? { live: true } : {}) }); } else hit.refreshing = false; });
    }
    return hit.result;
  }
  // Too old to show without asking: ask, but if the piece fails now, the last page it drew beats an error. That
  // fallback is kept as old (at 0), so the next look asks the piece again.
  const last = hit?.result;
  let fellBack = false;
  const result = run().then(async (r) => {
    if (typeof r !== 'string' || !last) return r;
    const was = await last;
    if (typeof was === 'string') return r;
    fellBack = true;
    return was;
  });
  pages.set(key, { at: now, result });
  // A failure isn't kept; the oldest go first past PAGES_MAX.
  void result.then((r) => {
    const entry = pages.get(key);
    if (entry?.result !== result) return;
    if (typeof r === 'string') pages.delete(key);
    else if (fellBack) pages.set(key, { at: 0, result });
    else if (r.refresh) entry.live = true;
  });
  if (pages.size > PAGES_MAX) pages.delete(pages.keys().next().value!);
  return result;
}

/** Run an action on a piece. Field values go on stdin only. */
export async function pieceAct(
  info: PieceInfo,
  request: { action: string; path: string; fields: Record<string, string> },
  env: NodeJS.ProcessEnv,
  /** Who's acting (docs/specs/owners.md): a piece records it as who decided. */
  caller?: ApiCaller,
): Promise<ActResult> {
  const r = await ask(info.path, ['ui', 'act', '--json'], withGrant(env, info.path, caller), { stdin: JSON.stringify({ ...request, ...(caller ? { caller } : {}) }), timeoutMs: ACT_TIMEOUT_MS });
  // Whatever happened, the piece's state may have changed.
  clearPieceCache(info.path);
  if (!r.ok) return { ok: false, message: `${info.piece} didn't answer (${r.reason}).` };
  const parsed = json(r.stdout);
  const result = parsed === undefined ? 'not JSON' : parseActResult(parsed);
  return typeof result === 'string' ? { ok: false, message: `${info.piece} sent an answer loom couldn't read (${result}).` } : result;
}

/** A piece's API answer is its own JSON; these bound how long one call may take. */
export const API_TIMEOUT_MS = 15_000;
/**
 * An API answer is data for a program, not a page for a person, so it may be
 * bigger than a page's 512 KB: a work store's whole export, a state's part.
 */
export const API_MAX_BYTES = 8 * 1024 * 1024;

/** Who is calling a piece's API, as core resolved the bearer. */
export type ApiCaller =
  /** `who`: the member (a People slug); `agents`: what they own, `*` for a household owner (docs/specs/owners.md). */
  | { kind: 'owner'; who?: string; agents?: '*' | string[] }
  /** `granted`: the grants authority allowed this call, so the piece doesn't consult its own agent list (agent-runtime.md section 6). */
  | { kind: 'agent'; agent: string; service?: string; house?: string; granted?: true } | { kind: 'piece'; subject: string }
  /** No token, on a path the piece declared open (loom.strangers): a box asking to join. */
  | { kind: 'stranger'; address: string };

/**
 * Call a piece's API (docs/extensions.md, "The API"): `loom-<piece> api --json`
 * with {caller, path, body} on stdin. The piece answers {status?, body}; a
 * status outside 200-499, or anything that isn't that shape, is the piece's
 * failure, which the caller sees as a 502.
 */
export async function pieceApi(
  path: string,
  request: { caller: ApiCaller; path: string; body: unknown },
  env: NodeJS.ProcessEnv,
  gone?: AbortSignal,
): Promise<{ status: number; body: unknown; changed?: true }> {
  const r = await apiPool.run(() => {
    const env1 = withGrant(env, path, request.caller);
    // A path the piece answers from its long-lived server (piece-server.ts, t-2065): the grant goes in the request.
    const served = pieceOfPath(env, path)?.loom.api_serve;
    if (Array.isArray(served) && served.includes(request.path)) {
      const { LOOM_STORE_GRANT: grant, ...rest } = env1;
      const answer = serveCall(path, resolved(path), pieceEnvFor(path, pieceEnv(rest)), grant, request, { timeoutMs: API_TIMEOUT_MS, maxBytes: API_MAX_BYTES });
      if (answer) return answer;
    }
    return run(path, ['api', '--json'], env1, { stdin: JSON.stringify(request), timeoutMs: API_TIMEOUT_MS, maxBytes: API_MAX_BYTES });
  }, gone);
  if (r === null) return { status: 503, body: { error: 'busy: too many piece API calls at once; try again shortly' } };
  if (!r.ok) return { status: 502, body: { error: `the piece didn't answer (${r.reason})` } };
  const parsed = json(r.stdout) as { status?: unknown; body?: unknown } | undefined;
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed) || !('body' in parsed)) {
    return { status: 502, body: { error: 'the piece answered with something other than {status?, body}' } };
  }
  const status = parsed.status === undefined ? 200 : parsed.status;
  if (typeof status !== 'number' || !Number.isInteger(status) || status < 200 || status > 499) {
    return { status: 502, body: { error: 'the piece answered with a status outside 200-499' } };
  }
  // `changed: true`: the call wrote, so core pulls the piece's shared collections soon (http-server.ts pieceCall). Only
  // that word is read; it never reaches the caller.
  return { status, body: parsed.body, ...((parsed as { changed?: unknown }).changed === true ? { changed: true as const } : {}) };
}
