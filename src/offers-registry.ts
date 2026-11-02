/**
 * The offers registry and runner (docs/extensions.md, "Offers"): what the
 * installed managed pieces offer through core, and the one way core runs an
 * offer's argv.
 *
 * The registry reads each piece's piece.json, whose `loom` block the installer
 * checked (src/offers.ts) and copied there. Only a managed piece offers: a
 * piece found on PATH has no package for loom to read, so it never appears
 * here and is never run as an offer.
 */
import { join } from 'node:path';
import { managedBinDir, managedPieces, readRecord, type PieceRecord } from './cli/pieces-managed.js';
import { offersIn, type OfferKind, type Offers } from './offers.js';
import { runPieceBin, type ApiCaller } from './ui/pieces.js';

export interface PieceOffers {
  piece: string;
  offers: Offers;
}

/** A managed piece's declared offers; undefined when it isn't a managed piece. */
export function offersOf(env: NodeJS.ProcessEnv, piece: string): Offers | undefined {
  const rec = readRecord(env, piece);
  return rec ? offersIn(rec.loom) : undefined;
}

/** Every installed managed piece offering `kind`, by name, with its offers. */
export function piecesOffering(env: NodeJS.ProcessEnv, kind: OfferKind): PieceOffers[] {
  return managedPieces(env)
    .filter((r) => r.loom[kind] !== undefined)
    .map((r) => ({ piece: r.name, offers: offersIn(r.loom) }));
}

/**
 * The piece that is the grants authority, if one is installed. Install refuses
 * a second one; were two ever present (piece.json edited by hand), there is no
 * authority to ask, and that is said rather than one picked.
 */
export function grantsAuthority(env: NodeJS.ProcessEnv): { piece: string } | { piece: undefined; conflict?: string[] } {
  const all = piecesOffering(env, 'grants').map((p) => p.piece);
  if (all.length === 1) return { piece: all[0] };
  return all.length ? { piece: undefined, conflict: all } : { piece: undefined };
}

export type OfferResult<T> = { ok: true; value: T } | { ok: false; error: string };

export interface RunOfferOptions<T> {
  /** Appended to the declared argv, in order. */
  args?: string[];
  /** Written to the piece's stdin (stdin is closed when absent). */
  stdin?: string;
  /** Checks the parsed JSON answer: the value, or a string saying what's wrong. */
  parse: (v: unknown) => T | string;
  /** The answer's cap, in bytes: 64 KB unless said. */
  maxBytes?: number;
  /** Who the call is for: the process gets that caller's store grant (as for a piece's API). */
  caller?: ApiCaller;
}

/**
 * Run an offer: `argv` (one the piece declared) plus `args`, with `stdin`,
 * in the piece's environment, through the manifest runner's limits (3 s, the
 * process group killed afterwards, at most 6 pieces at once). The answer is
 * one JSON value on stdout, checked by `parse`. Every failure (not managed,
 * argv[0] not its bin, a non-zero exit, a timeout, too large, not JSON,
 * invalid) is `{ok: false, error}`, never a throw, so a caller showing many
 * pieces' offers shows the rest.
 */
export async function runOffer<T>(env: NodeJS.ProcessEnv, piece: string, argv: readonly string[], opts: RunOfferOptions<T>): Promise<OfferResult<T>> {
  const rec: PieceRecord | undefined = readRecord(env, piece);
  if (!rec) return { ok: false, error: `${piece} isn't a managed piece` };
  const [bin, ...rest] = argv;
  // Checked at install too; again here, since argv may come from anywhere.
  if (!bin || !rec.bins.includes(bin)) return { ok: false, error: `${JSON.stringify(bin)} isn't one of ${piece}'s bins` };
  const dir = managedBinDir(env);
  if (!dir) return { ok: false, error: 'no managed pieces directory' };
  const r = await runPieceBin(join(dir, bin), [...rest, ...(opts.args ?? [])], env, {
    stdin: opts.stdin, maxBytes: opts.maxBytes ?? 64 * 1024, caller: opts.caller,
  });
  if (!r.ok) return { ok: false, error: r.reason };
  let parsed: unknown;
  try { parsed = JSON.parse(r.stdout); } catch { return { ok: false, error: 'invalid: not JSON' }; }
  const v = opts.parse(parsed);
  return typeof v === 'string' ? { ok: false, error: `invalid: ${v}` } : { ok: true, value: v };
}
