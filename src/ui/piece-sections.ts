/**
 * Sections from installed pieces: each `loom-<piece>` on PATH is asked
 * `ui --json`. A piece that answers with valid sections shows up on loom's
 * page with no configuration; one that doesn't (no `ui` verb, a timeout, bad
 * JSON) simply isn't there. Composes without requiring (docs/extensions.md).
 *
 * Answers are cached briefly so a page refresh doesn't fork every piece, and
 * each call is bounded in time and output size.
 */
import { spawn } from 'node:child_process';
import { listPieces } from '../cli/pieces.js';
import { parseSections, type Section } from './sections.js';

export const PIECE_TIMEOUT_MS = 3_000;
export const PIECE_MAX_BYTES = 512 * 1024;
export const CACHE_MS = 30_000;

export interface PieceSections {
  piece: string;
  sections: Section[];
}

/** Why a piece contributed nothing, for the page footer (never shown as an error). */
export interface PieceSkip {
  piece: string;
  reason: string;
}

interface CacheEntry { at: number; result: PieceSections | PieceSkip }
const cache = new Map<string, CacheEntry>();

export function clearPieceCache(): void { cache.clear(); }

function ask(path: string, env: NodeJS.ProcessEnv): Promise<{ ok: true; stdout: string } | { ok: false; reason: string }> {
  return new Promise((resolve) => {
    const child = spawn(path, ['ui', '--json'], { env, stdio: ['ignore', 'pipe', 'ignore'] });
    let out = '';
    let bytes = 0;
    let settled = false;
    const finish = (r: { ok: true; stdout: string } | { ok: false; reason: string }) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(r);
    };
    const timer = setTimeout(() => { child.kill('SIGKILL'); finish({ ok: false, reason: 'timed out' }); }, PIECE_TIMEOUT_MS);
    child.stdout.on('data', (d: Buffer) => {
      bytes += d.length;
      if (bytes > PIECE_MAX_BYTES) { child.kill('SIGKILL'); finish({ ok: false, reason: 'answer too large' }); return; }
      out += d.toString('utf-8');
    });
    child.on('error', (e) => finish({ ok: false, reason: e.message }));
    child.on('close', (code) => finish(code === 0 ? { ok: true, stdout: out } : { ok: false, reason: 'no ui' }));
  });
}

async function sectionsFor(name: string, path: string, env: NodeJS.ProcessEnv, nowMs: number): Promise<PieceSections | PieceSkip> {
  const hit = cache.get(path);
  if (hit && nowMs - hit.at < CACHE_MS) return hit.result;
  const r = await ask(path, env);
  let result: PieceSections | PieceSkip;
  if (!r.ok) result = { piece: name, reason: r.reason };
  else {
    let parsed: unknown;
    try { parsed = JSON.parse(r.stdout); } catch { parsed = undefined; }
    const sections = parsed === undefined ? 'not JSON' : parseSections(parsed);
    result = typeof sections === 'string' ? { piece: name, reason: `invalid: ${sections}` } : { piece: name, sections };
  }
  cache.set(path, { at: nowMs, result });
  return result;
}

export async function pieceSections(
  env: NodeJS.ProcessEnv,
  nowMs = Date.now(),
): Promise<{ contributed: PieceSections[]; skipped: PieceSkip[] }> {
  const results = await Promise.all(listPieces(env).map((p) => sectionsFor(p.name, p.path, env, nowMs)));
  return {
    contributed: results.filter((r): r is PieceSections => 'sections' in r && r.sections.length > 0),
    skipped: results.filter((r): r is PieceSkip => 'reason' in r),
  };
}
