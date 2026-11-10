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
import { PIECE_TIMEOUT_MS, type OfferPool } from './ui/pieces.js';
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
export function grantsAuthority(env: NodeJS.ProcessEnv): { piece: string; argv: string[] } | { piece: undefined; conflict?: string[] } {
  const all = piecesOffering(env, 'grants');
  if (all.length === 1) return { piece: all[0].piece, argv: [...all[0].offers.grants!] };
  return all.length ? { piece: undefined, conflict: all.map((p) => p.piece) } : { piece: undefined };
}

/**
 * The piece offering `delivery`, if one is installed (agent-runtime.md, "Delivery"). Install
 * refuses a second; were two ever present, there's none to forward to, and that's said.
 */
export function deliveryPiece(env: NodeJS.ProcessEnv): { piece: string; argv: string[] } | { piece: undefined; conflict?: string[] } {
  // Install lets only the runtime declare it; checked again, since piece.json may be edited by hand.
  const all = managedPieces(env).filter((r) => r.loom.delivery !== undefined && r.loom.role === 'runtime');
  if (all.length === 1) return { piece: all[0].name, argv: [...all[0].loom.delivery!] };
  return all.length ? { piece: undefined, conflict: all.map((r) => r.name) } : { piece: undefined };
}

/**
 * Each offer kind's limits (docs/extensions.md, "Offers"): the section feed's 3 s for a feed or
 * a venue's render, and the mcp_tools limits (agent-runtime.md, "Seams", 2: 120 s, an answer of
 * at most 64 KB) for `delivery` and `mcp_tools`, each in a pool of its own (src/ui/pieces.ts).
 * `grants` has 10 s.
 */
export interface OfferLimits { timeoutMs: number; maxBytes: number; pool: OfferPool }
export const OFFER_LIMITS: Readonly<Record<OfferKind, OfferLimits>> = {
  sections: { timeoutMs: PIECE_TIMEOUT_MS, maxBytes: 64 * 1024, pool: 'page' },
  venues: { timeoutMs: PIECE_TIMEOUT_MS, maxBytes: 64 * 1024, pool: 'page' },
  grants: { timeoutMs: 10_000, maxBytes: 4 * 1024, pool: 'grants' },
  mcp_tools: { timeoutMs: 120_000, maxBytes: 64 * 1024, pool: 'tools' },
  delivery: { timeoutMs: 120_000, maxBytes: 64 * 1024, pool: 'delivery' },
};

/**
 * A failed run says why (`error`). A piece that exited non-zero has its `exit` code and what it
 * printed (`stdout`), parsed as JSON when it is (`answer`), so an offer can say why it failed.
 */
export type OfferResult<T> = { ok: true; value: T } | { ok: false; error: string; exit?: number; answer?: unknown };

export interface RunOfferOptions<T> {
  /** Appended to the declared argv, in order. */
  args?: string[];
  /** Written to the piece's stdin (stdin is closed when absent). */
  stdin?: string;
  /** Checks the parsed JSON answer: the value, or a string saying what's wrong. */
  parse: (v: unknown) => T | string;
  /** Which kind of offer this is: its limits (OFFER_LIMITS). The section feed's, unless said. */
  kind?: OfferKind;
  /** Overrides of the kind's limits, for one call (delivery's DELIVERY_LIMITS). */
  limits?: Partial<OfferLimits>;
  /** Who the call is for: the process gets that caller's store grant (as for a piece's API). */
  caller?: ApiCaller;
}

/**
 * Run an offer: `argv` (one the piece declared) plus `args`, with `stdin`,
 * in the piece's environment, under its kind's limits (OFFER_LIMITS: 3 s for a
 * feed, 120 s for delivery and tools; the process group killed afterwards; at
 * most 6 at once, or the kind's own pool). The answer is
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
  const limits = { ...OFFER_LIMITS[opts.kind ?? 'sections'], ...opts.limits };
  const r = await runPieceBin(join(dir, bin), [...rest, ...(opts.args ?? [])], env, {
    stdin: opts.stdin, maxBytes: limits.maxBytes, timeoutMs: limits.timeoutMs, pool: limits.pool, caller: opts.caller,
  });
  if (!r.ok) {
    if (r.exit === undefined) return { ok: false, error: r.reason };
    let answer: unknown;
    try { answer = r.stdout ? JSON.parse(r.stdout) : undefined; } catch { answer = undefined; }
    return { ok: false, error: r.reason, exit: r.exit, ...(answer !== undefined ? { answer } : {}) };
  }
  let parsed: unknown;
  try { parsed = JSON.parse(r.stdout); } catch { return { ok: false, error: 'invalid: not JSON' }; }
  const v = opts.parse(parsed);
  return typeof v === 'string' ? { ok: false, error: `invalid: ${v}` } : { ok: true, value: v };
}
