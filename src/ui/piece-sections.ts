/**
 * Sections from installed pieces: each `loom-<piece>` on PATH is asked
 * `ui --json`. A piece that answers with valid sections shows up on loom's
 * page with no configuration; one that doesn't (no `ui` verb, a timeout, bad
 * JSON) simply isn't there. Composes without requiring (docs/extensions.md).
 *
 * Bounded on every axis: one run per piece per cache window however many
 * pages load at once (the in-flight promise is what's cached), 3s and 512KB
 * per answer, and on a timeout the piece's whole process group is killed, not
 * just its first process. A piece gets the daemon's env minus loom's own
 * bearer tokens.
 */
import { spawn } from 'node:child_process';
import { listPieces } from '../cli/pieces.js';
import { parseSections, type Section } from './sections.js';

export const PIECE_TIMEOUT_MS = 3_000;
export const PIECE_MAX_BYTES = 512 * 1024;
/** Longer than the page's 30s refresh, so an open tab doesn't re-run every piece each time. */
export const CACHE_MS = 45_000;
/** After the piece exits, how long to wait for its stdout to close (a background helper may hold it). */
const DRAIN_MS = 200;
/** Env loom never hands to a piece. */
const WITHHELD = ['LOOM_BEARER_TOKEN', 'LOOM_KNOWLEDGE_BEARER_TOKENS'];

export interface PieceSections {
  piece: string;
  sections: Section[];
}

/** Why a piece contributed nothing, for the page footer (never shown as an error). */
export interface PieceSkip {
  piece: string;
  reason: string;
}

type Result = PieceSections | PieceSkip;
interface CacheEntry { at: number; result: Promise<Result> }
const cache = new Map<string, CacheEntry>();

export function clearPieceCache(): void { cache.clear(); }

export function pieceEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const out = { ...env };
  for (const k of WITHHELD) delete out[k];
  return out;
}

function killGroup(pid: number | undefined): void {
  if (pid === undefined) return;
  try { process.kill(-pid, 'SIGKILL'); } catch { /* already gone */ }
}

function ask(path: string, env: NodeJS.ProcessEnv): Promise<{ ok: true; stdout: string } | { ok: false; reason: string }> {
  return new Promise((resolve) => {
    // Its own process group, so a timeout takes the piece's children with it.
    const child = spawn(path, ['ui', '--json'], { env: pieceEnv(env), stdio: ['ignore', 'pipe', 'ignore'], detached: true });
    let out = '';
    let bytes = 0;
    let settled = false;
    let drain: NodeJS.Timeout | undefined;
    const finish = (r: { ok: true; stdout: string } | { ok: false; reason: string }) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (drain) clearTimeout(drain);
      child.stdout?.destroy();
      resolve(r);
    };
    const timer = setTimeout(() => { killGroup(child.pid); finish({ ok: false, reason: 'timed out' }); }, PIECE_TIMEOUT_MS);
    child.stdout?.on('data', (d: Buffer) => {
      bytes += d.length;
      if (bytes > PIECE_MAX_BYTES) { killGroup(child.pid); finish({ ok: false, reason: 'answer too large' }); return; }
      out += d.toString('utf-8');
    });
    child.on('error', (e) => finish({ ok: false, reason: e.message }));
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

async function run(name: string, path: string, env: NodeJS.ProcessEnv): Promise<Result> {
  const r = await ask(path, env);
  if (!r.ok) return { piece: name, reason: r.reason };
  let parsed: unknown;
  try { parsed = JSON.parse(r.stdout); } catch { return { piece: name, reason: 'invalid: not JSON' }; }
  const sections = parseSections(parsed);
  return typeof sections === 'string' ? { piece: name, reason: `invalid: ${sections}` } : { piece: name, sections };
}

function sectionsFor(name: string, path: string, env: NodeJS.ProcessEnv, nowMs: number): Promise<Result> {
  const hit = cache.get(path);
  if (hit && nowMs - hit.at < CACHE_MS) return hit.result;
  // Cache the promise itself: concurrent page loads share one run.
  const result = run(name, path, env);
  cache.set(path, { at: nowMs, result });
  return result;
}

export async function pieceSections(
  env: NodeJS.ProcessEnv,
  nowMs = Date.now(),
): Promise<{ contributed: PieceSections[]; skipped: PieceSkip[] }> {
  // "loom" is the core group's name on the page; a piece can't take it.
  const pieces = listPieces(env).filter((p) => p.name !== 'loom');
  const results = await Promise.all(pieces.map((p) => sectionsFor(p.name, p.path, env, nowMs)));
  return {
    contributed: results.filter((r): r is PieceSections => 'sections' in r && r.sections.length > 0),
    skipped: results.filter((r): r is PieceSkip => 'reason' in r),
  };
}
