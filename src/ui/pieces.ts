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
import { spawn } from 'node:child_process';
import { listPieces } from '../cli/pieces.js';
import { pieceEnvFor } from '../cli/pieces-managed.js';
import { parseActResult, parseManifest, parsePage, type ActResult, type Manifest, type Page } from './vocab.js';

export const PIECE_TIMEOUT_MS = 3_000;
export const ACT_TIMEOUT_MS = 15_000;
export const PIECE_MAX_BYTES = 512 * 1024;
/** Longer than the page's 30s refresh, so an open tab doesn't re-run every piece each time. */
export const CACHE_MS = 45_000;
/** After the piece exits, how long to wait for its stdout to close (a background helper may hold it). */
const DRAIN_MS = 200;
/** Env loom never hands to a piece. */
const WITHHELD = ['LOOM_BEARER_TOKEN', 'LOOM_KNOWLEDGE_BEARER_TOKENS'];

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

type Answer = { ok: true; stdout: string } | { ok: false; reason: string };
type ManifestResult = PieceInfo | PieceSkip;
interface CacheEntry { at: number; result: Promise<ManifestResult> }
const cache = new Map<string, CacheEntry>();

export function clearPieceCache(path?: string): void {
  if (path === undefined) cache.clear();
  // Every scope's answer for that piece.
  else for (const k of [...cache.keys()]) if (k.startsWith(`${path}\0`)) cache.delete(k);
}

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
class Pool {
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
}

const pagePool = new Pool(MAX_RUNNING);
/** /api: at most four at once, eight more waiting. */
export const MAX_API_RUNNING = 4;
export const MAX_API_WAITING = 8;
const apiPool = new Pool(MAX_API_RUNNING, MAX_API_WAITING);

async function ask(path: string, args: string[], env: NodeJS.ProcessEnv, opts: { stdin?: string; timeoutMs?: number } = {}): Promise<Answer> {
  return (await pagePool.run(() => run(path, args, env, opts)))!;
}

function run(path: string, args: string[], env: NodeJS.ProcessEnv, opts: { stdin?: string; timeoutMs?: number; maxBytes?: number }): Promise<Answer> {
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
    child.stdout?.on('data', (d: Buffer) => {
      bytes += d.length;
      if (bytes > (opts.maxBytes ?? PIECE_MAX_BYTES)) { killGroup(child.pid); finish({ ok: false, reason: 'answer too large' }); return; }
      out += d.toString('utf-8');
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
      const done = () => finish(code === 0 ? { ok: true, stdout: out } : { ok: false, reason: 'no ui' });
      if (child.stdout?.readableEnded) return done();
      child.stdout?.once('end', done);
      drain = setTimeout(done, DRAIN_MS);
    });
  });
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

function manifestFor(piece: string, path: string, env: NodeJS.ProcessEnv, nowMs: number): Promise<ManifestResult> {
  // A piece narrowed to an agent (LOOM_SCOPE) answers per scope: cache each separately.
  const key = `${path}\0${env.LOOM_SCOPE ?? ''}`;
  const hit = cache.get(key);
  if (hit && nowMs - hit.at < CACHE_MS) return hit.result;
  // Cache the promise itself: concurrent page loads share one run.
  const result = fetchManifest(piece, path, env);
  cache.set(key, { at: nowMs, result });
  return result;
}

/** Every installed piece's manifest, plus the ones that had nothing to show and why. */
export async function pieceManifests(
  env: NodeJS.ProcessEnv,
  nowMs = Date.now(),
): Promise<{ pieces: PieceInfo[]; skipped: PieceSkip[] }> {
  // "loom" is loom's own name on the page; a piece can't take it.
  const installed = listPieces(env).filter((p) => p.name !== 'loom');
  const results = await Promise.all(installed.map((p) => manifestFor(p.name, p.path, env, nowMs)));
  const pieces = results.filter((r): r is PieceInfo => 'manifest' in r);
  const empty = pieces.filter((p) => !p.manifest.tab && !p.manifest.tile && !p.manifest.asks.length && !p.manifest.legacy?.length);
  return {
    pieces: pieces.filter((p) => !empty.includes(p)),
    skipped: [...results.filter((r): r is PieceSkip => 'reason' in r), ...empty.map((p) => ({ piece: p.piece, reason: 'nothing to show' }))],
  };
}

/** One page from a piece, or why it couldn't be had. */
export async function piecePage(
  info: PieceInfo,
  path: string,
  query: Record<string, string>,
  env: NodeJS.ProcessEnv,
): Promise<Page | string> {
  // A first-version piece has one page: its sections.
  if (info.manifest.legacy) {
    return path === '' ? { title: info.piece, sections: info.manifest.legacy } : { title: 'Not found', sections: [] };
  }
  const r = await ask(info.path, ['ui', 'page', '--json'], env, { stdin: JSON.stringify({ path, query }) });
  if (!r.ok) return r.reason;
  const parsed = json(r.stdout);
  if (parsed === undefined) return 'not JSON';
  return parsePage(parsed);
}

/** Run an action on a piece. Field values go on stdin only. */
export async function pieceAct(
  info: PieceInfo,
  request: { action: string; path: string; fields: Record<string, string> },
  env: NodeJS.ProcessEnv,
): Promise<ActResult> {
  const r = await ask(info.path, ['ui', 'act', '--json'], env, { stdin: JSON.stringify(request), timeoutMs: ACT_TIMEOUT_MS });
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
export type ApiCaller = { kind: 'owner' } | { kind: 'agent'; agent: string; service?: string } | { kind: 'piece'; subject: string };

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
  const r = await apiPool.run(() => run(path, ['api', '--json'], env, { stdin: JSON.stringify(request), timeoutMs: API_TIMEOUT_MS, maxBytes: API_MAX_BYTES }), gone);
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
