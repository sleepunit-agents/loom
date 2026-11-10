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
import { householdHome } from '../household.js';
import { mintGrant } from '../stores.js';
import { spawn } from 'node:child_process';
import { realpathSync, statSync } from 'node:fs';
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
/** Longer than the page's 30s refresh, so an open tab doesn't re-run every piece each time. */
export const CACHE_MS = 45_000;
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
interface CacheEntry { at: number; result: Promise<ManifestResult>; refreshing?: boolean }
const cache = new Map<string, CacheEntry>();
let manifestGeneration = 0;

/**
 * Forget every scope's manifests, not their pages (live.ts, on a piece's own word that it moved): an agent's window
 * asks with its own scope, which no open stream may be refreshing, and its next look must not be a minute old.
 * `path`: that piece's alone, in every scope (t-2065).
 */
export function expirePieceManifests(path?: string): void {
  manifestGeneration++;
  if (path === undefined) { cache.clear(); return; }
  for (const k of [...cache.keys()]) if (k.startsWith(`${path}\0`)) cache.delete(k);
}

export function clearPieceCache(path?: string): void {
  manifestGeneration++;
  if (path === undefined) { cache.clear(); pages.clear(); return; }
  // Every scope's answer for that piece, and every page of it.
  for (const m of [cache, pages] as Map<string, unknown>[]) for (const k of [...m.keys()]) if (k.startsWith(`${path}\0`)) m.delete(k);
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
    // Its own process group, so a timeout takes the piece's children with it.
    const child = spawn(path, args, {
      env: pieceEnvFor(path, pieceEnv(env)),
      stdio: [opts.stdin === undefined ? 'ignore' : 'pipe', 'pipe', 'ignore'],
      detached: true,
    });
    let out = '';
    let bytes = 0;
    let settled = false;
    let drain: NodeJS.Timeout | undefined;
    const finish = (r: Answer) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (drain) clearTimeout(drain);
      child.stdout?.destroy();
      // Every time, not only on a timeout: whatever the piece left running in
      // its group goes with it. (A piece that calls setsid on purpose escapes.)
      killGroup(child.pid);
      resolve(r);
    };
    const timer = setTimeout(() => { killGroup(child.pid); finish({ ok: false, reason: 'timed out' }); }, opts.timeoutMs ?? PIECE_TIMEOUT_MS);
    // Decoded as a stream, so a character split across two chunks stays whole.
    child.stdout?.setEncoding('utf-8');
    child.stdout?.on('data', (d: string) => {
      bytes += Buffer.byteLength(d);
      // Read a line at a time, only the line still coming is held, and the cap is on it: every line before it was
      // already read (and checked) by the caller, so no limit here turns on what an unread line held.
      if (!opts.onLine && bytes > (opts.maxBytes ?? PIECE_MAX_BYTES)) { killGroup(child.pid); finish({ ok: false, reason: 'answer too large' }); return; }
      out += d;
      if (!opts.onLine) return;
      if (out.length > (opts.maxBytes ?? PIECE_MAX_BYTES) && out.indexOf('\n') < 0) { killGroup(child.pid); finish({ ok: false, reason: 'line too long' }); return; }
      let i;
      while ((i = out.indexOf('\n')) >= 0) {
        const line = out.slice(0, i);
        out = out.slice(i + 1);
        if (line.trim() && opts.onLine(line) === 'stop') { killGroup(child.pid); finish({ ok: false, reason: 'stopped' }); return; }
      }
    });
    child.on('error', (e) => finish({ ok: false, reason: e.message }));
    if (opts.stdin !== undefined && child.stdin) {
      child.stdin.on('error', () => { /* the piece closed stdin early; its answer decides */ });
      child.stdin.end(opts.stdin);
    }
    // Resolve on the piece's own exit (plus a short drain), not on 'close':
    // 'close' waits for every holder of the pipe, and a helper the piece left
    // running would hold it open past the timeout.
    child.on('exit', (code) => {
      const done = () => {
        // The last line, unterminated.
        if (opts.onLine && out.trim() && !settled) { const line = out; out = ''; if (opts.onLine(line) === 'stop') return finish({ ok: false, reason: 'stopped' }); }
        finish(code === 0 ? { ok: true, stdout: out } : { ok: false, reason: 'no ui', code, stdout: out });
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
  opts: { stdin?: string; maxBytes?: number; caller?: ApiCaller; pool?: OfferPool; timeoutMs?: number; onLine?: (line: string) => 'go' | 'stop' } = {},
): Promise<{ ok: true; stdout: string } | { ok: false; reason: string; exit?: number; stdout?: string }> {
  const env1 = withGrant(env, path, opts.caller);
  const r = opts.pool && opts.pool !== 'page'
    ? await offerPools[opts.pool].run(() => run(path, args, env1, { stdin: opts.stdin, maxBytes: opts.maxBytes, timeoutMs: opts.timeoutMs, onLine: opts.onLine }))
    : await ask(path, args, env1, { stdin: opts.stdin, maxBytes: opts.maxBytes, timeoutMs: opts.timeoutMs });
  if (r === null) return { ok: false, reason: 'busy' };
  if (r.ok) return r;
  if (r.reason !== 'no ui') return { ok: false, reason: r.reason };
  return { ok: false, reason: `exit ${r.code ?? 'by signal'}`, ...(typeof r.code === 'number' ? { exit: r.code } : {}), ...(r.stdout !== undefined ? { stdout: r.stdout } : {}) };
}

function json(stdout: string): unknown {
  try { return JSON.parse(stdout); } catch { return undefined; }
}

async function fetchManifest(piece: string, path: string, env: NodeJS.ProcessEnv): Promise<ManifestResult> {
  const r = await ask(path, ['ui', '--json'], env);
  if (!r.ok) return { piece, reason: r.reason };
  const parsed = json(r.stdout);
  if (parsed === undefined) return { piece, reason: 'invalid: not JSON' };
  const m = parseManifest(parsed);
  return typeof m === 'string' ? { piece, reason: `invalid: ${m}` } : { piece, path, manifest: m };
}

/** Where a piece's path leads, and when that file last changed: what makes its answer a new one. */
function resolved(path: string): string {
  try {
    const real = realpathSync(path);
    return `${real}\0${statSync(real).mtimeMs}`;
  } catch {
    return '';
  }
}

function manifestFor(piece: string, path: string, env: NodeJS.ProcessEnv, nowMs: number): Promise<ManifestResult> {
  // A piece narrowed to an agent (LOOM_SCOPE) answers per scope: cache each separately. And per the file
  // the path resolves to now: an install points pieces/bin/loom-<name> at a new version, which is a new
  // answer at once, not 45s later (t-1584).
  const key = `${path}\0${env.LOOM_SCOPE ?? ''}\0${resolved(path)}`;
  const hit = cache.get(key);
  if (hit && nowMs - hit.at < CACHE_MS) return hit.result;
  if (hit && nowMs - hit.at < STALE_MAX_MS) {
    if (!hit.refreshing) {
      hit.refreshing = true;
      const next = fetchManifest(piece, path, env);
      void Promise.all([next, hit.result]).then(([fresh, last]) => {
        // A piece that fails this once keeps its last good answer (until that's too old); it's asked again next time.
        if ('manifest' in fresh || !('manifest' in last)) { if (cache.get(key) === hit) cache.set(key, { at: Date.now(), result: next }); }
        else hit.refreshing = false;
      });
    }
    return hit.result;
  }
  // Cache the promise itself: concurrent page loads share one run.
  const result = fetchManifest(piece, path, env);
  cache.set(key, { at: nowMs, result });
  return result;
}

/**
 * The pieces the page shows: every loom-<piece> on PATH, less loom's own name (a piece can't take it) and an old name
 * that is another piece now (PIECE_ALIASES: the runtime's loom-box bin is the runtime, whose pages /p/box/… already
 * redirect to, not a second "Boxes" in Places beside the runtime's in Setup).
 */
function shownPieces(env: NodeJS.ProcessEnv): Array<{ name: string; path: string }> {
  return listPieces(env).filter((p) => p.name !== 'loom' && resolvePieceName(env, p.name) === p.name);
}

/**
 * Ask every piece for its manifest now, whatever the cache holds, and keep the answers (src/ui/live.ts runs
 * this while an app is open). Returns each piece's answer as a fingerprint, so a caller can tell which changed;
 * a piece that changed has its kept pages dropped, so the next look at them is fresh.
 */
export async function refreshPieceManifests(env: NodeJS.ProcessEnv, only?: ReadonlySet<string>): Promise<Map<string, string>> {
  // `only`: just these pieces' paths (the one that said it moved, t-2065); the others keep their last answers.
  const installed = shownPieces(env).filter((p) => !only || only.has(p.path));
  const out = new Map<string, string>();
  await Promise.all(installed.map(async (p) => {
    const key = `${p.path}\0${env.LOOM_SCOPE ?? ''}\0${resolved(p.path)}`;
    const generation = manifestGeneration;
    const before = cache.get(key);
    const result = fetchManifest(p.name, p.path, env);
    const r = await result;
    // A piece that failed this once keeps its last good answer, as a page load would.
    // Invalidation or a newer page load wins over a refresh started before it.
    if (generation === manifestGeneration && cache.get(key) === before && ('manifest' in r || !before))
      cache.set(key, { at: Date.now(), result });
    out.set(p.path, 'manifest' in r ? JSON.stringify(r.manifest) : '');
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
  const key = `${info.path}\0${env.LOOM_SCOPE ?? ''}\0${resolved(info.path)}\0${path}\0${JSON.stringify(query)}\0${JSON.stringify(caller ?? null)}`;
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
): Promise<{ status: number; body: unknown }> {
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
  return { status, body: parsed.body };
}
