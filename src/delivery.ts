/**
 * Delivery, core's half (docs/specs/agent-runtime.md, "5. Delivery" and "Seams this needs
 * from core", 2): `POST /api/loom/deliver`. A source (a venue adapter, the clock, the runtime
 * relaying) calls it with its own piece token; core checks who may deliver what, then
 * forwards the body to the one piece offering `delivery` (the runtime), through the offers
 * runner under the long offers' limits (120 s, an answer of at most 64 KB), and passes the
 * runtime's answer back.
 *
 *  - Every refusal (403, 503, 400) happens before anything runs, so it writes nothing.
 *  - Idempotent on (calling credential, id) for 24 hours: the first good answer is kept in the
 *    household store (`$LOOM_HOME/household.db`, table `deliveries`, with a hash of the body)
 *    and a repeat gets it back verbatim without the runtime being called; the same id with
 *    another body is a 409. A forward that failed (the runtime's error, a timeout, a busy
 *    pool) isn't kept, so the source may retry it.
 *  - Fair: one piece runs at most 2 forwards with 4 waiting, and keeps at most 10,000
 *    answers a day; past either, that piece alone is refused.
 *
 * Core never names the runtime: it finds it as the piece whose block offers `delivery`
 * (offers-registry.ts, deliveryPiece).
 */
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { ConversationError, parseTurn, type From } from './backends/conversations.js';
import { readRecord } from './cli/pieces-managed.js';
import type { Household } from './household.js';
import { HOUSEHOLD_DB, openHouseholdDb } from './household-store.js';
import { RUNTIME_VENUE, offersIn, ownEntry } from './offers.js';
import { deliveryPiece, grantsAuthority, OFFER_LIMITS, runOffer, type OfferResult } from './offers-registry.js';

export const MAX_DELIVERY_ID = 200;
export const MAX_DELIVERY_TEXT = 40_000;
/** How long a (calling piece, id) answer is kept and replayed. */
export const DELIVERY_REPLAY_MS = 24 * 60 * 60 * 1000;
/** The deliver body's cap: 40,000 characters of text can be 160 KB of UTF-8, plus the rest. */
export const DELIVER_MAX_BYTES = 256 * 1024;

/**
 * A source delivers a `message` or a `wake`. Not a `note`: in core's record that's the agent's
 * own mid-turn turn (conversations.md), which a source can't write.
 */
export type DeliverKind = 'message' | 'wake';
const DELIVER_KINDS: readonly DeliverKind[] = ['message', 'wake'];
const DELIVER_KEYS = ['id', 'agent', 'venue', 'place', 'label', 'from', 'kind', 'at', 'text'] as const;

/** A checked deliver body (agent-runtime.md, "The deliver contract"). */
export interface DeliverBody {
  id: string;
  agent: string;
  venue: string;
  place: string;
  label?: string;
  from: From;
  kind: DeliverKind;
  at: string;
  text: string;
}

export type BodyState = 'fed' | 'resumed' | 'started' | 'queued' | 'failed';
const BODY_STATES: readonly BodyState[] = ['fed', 'resumed', 'started', 'queued', 'failed'];

/** The runtime's answer, passed back as it gave it. */
export interface DeliverAnswer {
  conversation: string;
  seq: number;
  body: BodyState;
  reason?: string;
}

/** What the route answers: a status and a JSON body. */
export interface DeliverResult {
  status: number;
  body: DeliverAnswer | { error: string };
}

/** Who is delivering: the calling piece, as its piece token or its runtime token resolved. */
export interface DeliverCaller {
  piece: string;
  /** The whole credential (`piece:<piece>/<subject>`, `runtime:<piece>`): what a replay is keyed on. */
  credential: string;
}

/**
 * The delivery limits, mutable so a test can lower them (they're read on each call):
 *  - `timeoutMs`: the `delivery` offer's (OFFER_LIMITS, the mcp_tools limit, 120 s);
 *  - `perPieceRunning`, `perPieceWaiting`: one calling piece's share of the long pool;
 *  - `keptPerPiece`: the answers one piece may have kept in 24 hours; past it, a 429.
 */
export const DELIVERY_LIMITS = {
  timeoutMs: OFFER_LIMITS.delivery.timeoutMs,
  perPieceRunning: 2,
  perPieceWaiting: 4,
  keptPerPiece: 10_000,
};

const isObject = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const refuse = (status: number, error: string): DeliverResult => ({ status, body: { error } });

/** The deliver body checked against the contract's table; a string says what's wrong (a 400). */
export function parseDeliver(raw: unknown): DeliverBody | string {
  if (!isObject(raw)) return 'a delivery is a JSON object';
  const bad = Object.keys(raw).find((k) => !(DELIVER_KEYS as readonly string[]).includes(k));
  if (bad !== undefined) return `a delivery has no key ${JSON.stringify(bad)} (it has ${DELIVER_KEYS.join(', ')})`;
  if (typeof raw.id !== 'string' || !raw.id.length || raw.id.length > MAX_DELIVERY_ID) return `id is required: the source's own id for the message, 1-${MAX_DELIVERY_ID} characters`;
  if (typeof raw.agent !== 'string' || !raw.agent.length) return 'agent is required: one of the household\'s agents';
  if (typeof raw.text !== 'string' || !raw.text.length || raw.text.length > MAX_DELIVERY_TEXT) return `text is required: the message, 1-${MAX_DELIVERY_TEXT} characters`;
  if (raw.kind === 'note') return 'kind is message or wake: a note is the agent\'s own turn, which a source doesn\'t write';
  if (!DELIVER_KINDS.includes(raw.kind as DeliverKind)) return `kind is one of ${DELIVER_KINDS.join(', ')}`;
  // The key and turn fields are conversations.md's: the turn parser checks them the same way.
  let turn;
  try {
    turn = parseTurn({ venue: raw.venue, place: raw.place, at: raw.at, from: raw.from, kind: raw.kind, ...(raw.label !== undefined ? { label: raw.label } : {}) }, raw.agent);
  } catch (e) {
    if (e instanceof ConversationError) return e.message;
    throw e;
  }
  return {
    id: raw.id, agent: raw.agent, venue: turn.venue, place: turn.place, ...(turn.label !== undefined ? { label: turn.label } : {}),
    from: turn.from, kind: raw.kind as DeliverKind, at: turn.at, text: raw.text,
  };
}

/** The runtime's answer checked: `{conversation, seq, body, reason?}`, `reason` required when `body` is failed. */
export function parseDeliverAnswer(v: unknown): DeliverAnswer | string {
  if (!isObject(v)) return 'not a JSON object';
  const bad = Object.keys(v).find((k) => !['conversation', 'seq', 'body', 'reason'].includes(k));
  if (bad !== undefined) return `unknown key ${JSON.stringify(bad)}`;
  if (typeof v.conversation !== 'string' || !/^cv-[0-9a-f]{12}$/.test(v.conversation)) return 'conversation is a conversation id (cv-…)';
  if (typeof v.seq !== 'number' || !Number.isInteger(v.seq) || v.seq < 1) return 'seq is a positive integer';
  if (!BODY_STATES.includes(v.body as BodyState)) return `body is one of ${BODY_STATES.join(', ')}`;
  if (v.reason !== undefined && (typeof v.reason !== 'string' || !v.reason.length || v.reason.length > 500)) return 'reason is 1-500 characters';
  if (v.body === 'failed' && v.reason === undefined) return 'a failed body says why (reason)';
  return { conversation: v.conversation, seq: v.seq, body: v.body as BodyState, ...(v.reason !== undefined ? { reason: v.reason as string } : {}) };
}

/**
 * Whether `piece` may act for `agent` (agent-runtime.md, "6. Permissions", Agent grants).
 * With no grants authority installed, each piece decides by its own agent list, which core
 * can't read: the source applied it when it chose to deliver, so core checks only that the
 * agent is the household's. With an authority, core asks it; the `grants` offer doesn't yet
 * say how to (it's `true`, with no argv), so core fails closed, as the spec says it must when
 * the authority can't answer, unless the caller is the authority itself.
 */
export function grantRefusal(env: NodeJS.ProcessEnv, h: Household, agent: string, piece: string): DeliverResult | undefined {
  if (!h.agents.includes(agent)) return refuse(403, `forbidden: ${agent} isn't one of this household's agents`);
  const auth = grantsAuthority(env);
  if (auth.piece === undefined) {
    if (auth.conflict) return refuse(503, `unavailable: more than one piece offers grants (${auth.conflict.join(', ')}); there's no authority to ask`);
    return undefined;
  }
  if (auth.piece === piece) return undefined;
  return refuse(503, `unavailable: the grants authority (${auth.piece}) can't be asked yet (its grants offer has no argv), so ${piece}'s call for ${agent} is refused`);
}

/** Who may deliver what: the reason a delivery is refused before it's forwarded, or undefined. */
export function deliveryRefusal(env: NodeJS.ProcessEnv, h: Household, caller: DeliverCaller, d: DeliverBody): DeliverResult | undefined {
  const rec = readRecord(env, caller.piece);
  if (!rec) return refuse(403, `forbidden: ${caller.piece} isn't an installed managed piece`);
  const isRuntime = rec.loom.role === 'runtime';
  // Own keys only: a venue named `constructor` must not find Object's.
  const declared = ownEntry(offersIn(rec.loom).venues, d.venue);
  // The venue. `session` is the harness's own; `wake` is core's, delivered on only by a piece that
  // says so (`"wake": {}` in its venues, the clock) and only as a schedule's knock; any other
  // venue, only by the piece that declares it.
  if (d.venue === 'session') return refuse(403, 'forbidden: venue session is a harness\'s own session; nothing is delivered into it');
  if (d.venue === 'wake') {
    if (rec.loom.delivers_wake !== true) return refuse(403, `forbidden: ${caller.piece} doesn't declare that it delivers on core's wake (venues: {"wake": {}})`);
    if (d.from.kind !== 'schedule') return refuse(403, 'forbidden: on venue wake, from is {kind: schedule}');
  } else if (!declared) {
    return refuse(403, `forbidden: ${caller.piece} doesn't declare venue ${d.venue} (its loom block's venues)`);
  }
  const grant = grantRefusal(env, h, d.agent, caller.piece);
  if (grant) return grant;
  // A person comes only through a venue adapter: a piece delivering on a venue it adapts (not relay).
  if (d.from.kind === 'person' && (!declared || d.venue === RUNTIME_VENUE)) {
    return refuse(403, `forbidden: from {kind: person} comes only from a venue adapter on its own venue, not ${caller.piece} on ${d.venue}`);
  }
  if (d.from.kind === 'agent' && !isRuntime) return refuse(403, 'forbidden: from {kind: agent} comes only from the runtime (a relay)');
  return undefined;
}

// ─── The replay table ───────────────────────────────────────────────────────

/**
 * A delivery's body as a hash: the checked fields in a fixed order, so the same message hashes
 * the same however its JSON was written. The table keeps this, never the text.
 */
export function deliveryHash(d: DeliverBody): string {
  const fields = [d.id, d.agent, d.venue, d.place, d.label ?? null, d.from, d.kind, d.at, d.text];
  return createHash('sha256').update(JSON.stringify(fields)).digest('hex');
}

/** What a kept answer is keyed by: the calling credential (its whole role) and the id. */
export interface ReplayKey {
  /** `piece:<piece>/<subject>`, or `runtime:<piece>`. */
  caller: string;
  piece: string;
  id: string;
  hash: string;
}

/** The kept answer for (caller, id), with its body's hash, if one is younger than 24 hours. */
export function replayOf(home: string, caller: string, id: string, nowMs = Date.now()): { hash: string; answer: DeliverAnswer } | undefined {
  if (!existsSync(join(home, HOUSEHOLD_DB))) return undefined;
  const db = openHouseholdDb(home);
  try {
    const r = db.prepare('SELECT body_sha256, answer_json FROM deliveries WHERE caller = ? AND id = ? AND at > ?').get(caller, id, nowMs - DELIVERY_REPLAY_MS) as { body_sha256: string; answer_json: string } | undefined;
    return r ? { hash: r.body_sha256, answer: JSON.parse(r.answer_json) as DeliverAnswer } : undefined;
  } finally {
    db.close();
  }
}

/** How many answers `piece` has kept in the last 24 hours (all its credentials together). */
export function keptCount(home: string, piece: string, nowMs = Date.now()): number {
  if (!existsSync(join(home, HOUSEHOLD_DB))) return 0;
  const db = openHouseholdDb(home);
  try {
    return (db.prepare('SELECT COUNT(*) AS n FROM deliveries WHERE piece = ? AND at > ?').get(piece, nowMs - DELIVERY_REPLAY_MS) as { n: number }).n;
  } finally {
    db.close();
  }
}

/** Keep an answer, and sweep the entries over 24 hours old. */
export function keepAnswer(home: string, k: ReplayKey, answer: DeliverAnswer, nowMs = Date.now()): void {
  const db = openHouseholdDb(home);
  try {
    db.transaction(() => {
      db.prepare('DELETE FROM deliveries WHERE at <= ?').run(nowMs - DELIVERY_REPLAY_MS);
      db.prepare('INSERT OR REPLACE INTO deliveries (caller, id, piece, at, body_sha256, answer_json) VALUES (?, ?, ?, ?, ?, ?)')
        .run(k.caller, k.id, k.piece, nowMs, k.hash, JSON.stringify(answer));
    })();
  } finally {
    db.close();
  }
}

/** Drop every kept answer over 24 hours old (also done on each write); answers how many went. */
export function sweepDeliveries(home: string, nowMs = Date.now()): number {
  if (!existsSync(join(home, HOUSEHOLD_DB))) return 0;
  const db = openHouseholdDb(home);
  try { return db.prepare('DELETE FROM deliveries WHERE at <= ?').run(nowMs - DELIVERY_REPLAY_MS).changes; } finally { db.close(); }
}

// ─── Fairness ───────────────────────────────────────────────────────────────

/**
 * Each calling piece's own gate in front of the delivery pool (8 running, 32 waiting): at most `perPieceRunning`
 * of its forwards running and `perPieceWaiting` waiting; past that, that piece alone is refused.
 * The limits are read on each call, so a test can lower them.
 */
class PieceGate {
  private running = 0;
  private readonly waiting: Array<() => void> = [];
  async run<T>(f: () => Promise<T>): Promise<T | null> {
    if (this.running >= DELIVERY_LIMITS.perPieceRunning) {
      if (this.waiting.length >= DELIVERY_LIMITS.perPieceWaiting) return null;
      await new Promise<void>((resolve) => this.waiting.push(resolve));
    }
    this.running++;
    try { return await f(); } finally {
      this.running--;
      this.waiting.shift()?.();
    }
  }
  get idle(): boolean { return this.running === 0 && this.waiting.length === 0; }
}
const gates = new Map<string, PieceGate>();

// ─── The route ──────────────────────────────────────────────────────────────

/**
 * The runtime saying it failed (loom-box's side of the contract): exit 1 with
 * `{status: 500-599, error}` on stdout. Anything else from a failed run is core's 502.
 */
export function runtimeFailure(exit: number | undefined, answer: unknown): { status: number; error: string } | undefined {
  if (exit !== 1 || !isObject(answer)) return undefined;
  const { status, error } = answer;
  if (typeof status !== 'number' || !Number.isInteger(status) || status < 500 || status > 599) return undefined;
  if (typeof error !== 'string' || !error.length) return undefined;
  return { status, error: error.slice(0, 500) };
}

/**
 * Run the delivery piece's argv with `d` on stdin, and core's `source` (the calling piece) on top:
 * core's value is written last, so nothing in `d` can name another piece as the source.
 */
export function forwardDelivery(env: NodeJS.ProcessEnv, target: { piece: string; argv: string[] }, caller: DeliverCaller, d: DeliverBody): Promise<OfferResult<DeliverAnswer>> {
  return runOffer(env, target.piece, target.argv, {
    stdin: JSON.stringify({ ...d, source: caller.piece }),
    parse: parseDeliverAnswer,
    kind: 'delivery',
    limits: { timeoutMs: DELIVERY_LIMITS.timeoutMs },
  });
}

/** Deliveries in flight, by caller and id: a repeat that arrives meanwhile waits for the first. */
const inFlight = new Map<string, { hash: string; result: Promise<DeliverResult> }>();

const conflict = (id: string): DeliverResult =>
  refuse(409, `conflict: ${id} was already delivered with a different body; a new message takes a new id`);

/**
 * POST /api/loom/deliver as `caller` (the route already resolved its token to a piece).
 * 400 for a body that isn't the contract's; 403 for a delivery the caller may not make; 503
 * with no delivery piece; then the kept answer for a repeat (409 when the same id came with
 * another body), or the runtime's answer. A piece over its share is a 503 (in flight) or 429
 * (kept in a day). A runtime that says it failed is its own 5xx; one that fails otherwise or
 * answers something else is a 502, a timeout a 504, a full pool a 503. None of those is kept.
 */
export async function deliver(env: NodeJS.ProcessEnv, h: Household, caller: DeliverCaller, raw: unknown, nowMs: () => number = Date.now): Promise<DeliverResult> {
  const d = parseDeliver(raw);
  if (typeof d === 'string') return refuse(400, `bad-input: ${d}`);
  const refused = deliveryRefusal(env, h, caller, d);
  if (refused) return refused;
  const target = deliveryPiece(env);
  if (target.piece === undefined) {
    return refuse(503, target.conflict
      ? `unavailable: more than one piece offers delivery (${target.conflict.join(', ')}); there's none to forward to`
      : 'unavailable: no installed piece offers delivery (the runtime), so nothing can reach a body');
  }
  const k: ReplayKey = { caller: caller.credential, piece: caller.piece, id: d.id, hash: deliveryHash(d) };
  const key = `${k.caller}\0${k.id}`;
  const pending = inFlight.get(key);
  if (pending) return pending.hash === k.hash ? pending.result : conflict(d.id);
  const result = (async (): Promise<DeliverResult> => {
    const kept = replayOf(h.home, k.caller, k.id, nowMs());
    if (kept) return kept.hash === k.hash ? { status: 200, body: kept.answer } : conflict(d.id);
    if (keptCount(h.home, k.piece, nowMs()) >= DELIVERY_LIMITS.keptPerPiece) {
      return refuse(429, `too-many: ${k.piece} has delivered ${DELIVERY_LIMITS.keptPerPiece} messages in 24 hours, as many as core keeps for one piece`);
    }
    let gate = gates.get(k.piece);
    if (!gate) { gate = new PieceGate(); gates.set(k.piece, gate); }
    const r = await gate.run(() => forwardDelivery(env, { piece: target.piece!, argv: target.argv }, caller, d));
    if (gate.idle) gates.delete(k.piece);
    if (r === null) return refuse(503, `unavailable: ${k.piece} has too many deliveries in flight (${DELIVERY_LIMITS.perPieceRunning} running, ${DELIVERY_LIMITS.perPieceWaiting} waiting); try again shortly`);
    if (!r.ok) {
      // The runtime's own failure: exit 1 with {status: 5xx, error} on stdout, passed through as that status.
      const said = runtimeFailure(r.exit, r.answer);
      if (said) return refuse(said.status, said.error);
      if (r.error === 'busy') return refuse(503, `unavailable: the delivery piece (${target.piece}) is busy; try again shortly`);
      if (r.error === 'timed out') return refuse(504, `timeout: the delivery piece (${target.piece}) didn't answer within ${DELIVERY_LIMITS.timeoutMs / 1000} s`);
      return refuse(502, `bad-gateway: the delivery piece (${target.piece}) failed (${r.error})`);
    }
    keepAnswer(h.home, k, r.value, nowMs());
    return { status: 200, body: r.value };
  })();
  inFlight.set(key, { hash: k.hash, result });
  try { return await result; } finally { inFlight.delete(key); }
}
