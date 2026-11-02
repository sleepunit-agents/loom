/**
 * Delivery, core's half (docs/specs/agent-runtime.md, "5. Delivery" and "Seams this needs
 * from core", 2): `POST /api/loom/deliver`. A source (a venue adapter, the clock, the runtime
 * relaying) calls it with its own piece token; core checks who may deliver what, then
 * forwards the body to the one piece offering `delivery` (the runtime), through the offers
 * runner under the long offers' limits (120 s, an answer of at most 64 KB), and passes the
 * runtime's answer back.
 *
 *  - Every refusal (403, 503, 400) happens before anything runs, so it writes nothing.
 *  - Idempotent on (calling piece, id) for 24 hours: the first good answer is kept in the
 *    household store (`$LOOM_HOME/household.db`, table `deliveries`) and a repeat gets it
 *    back verbatim without the runtime being called. A forward that failed (the runtime's
 *    error, a timeout, a busy pool) isn't kept, so the source may retry it.
 *
 * Core never names the runtime: it finds it as the piece whose block offers `delivery`
 * (offers-registry.ts, deliveryPiece).
 */
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import type { Database } from 'better-sqlite3';
import { ConversationError, parseTurn, type From } from './backends/conversations.js';
import { readRecord } from './cli/pieces-managed.js';
import type { Household } from './household.js';
import { HOUSEHOLD_DB, openHouseholdDb } from './household-store.js';
import { RUNTIME_VENUE, offersIn } from './offers.js';
import { deliveryPiece, grantsAuthority, runOffer } from './offers-registry.js';

export const MAX_DELIVERY_ID = 200;
export const MAX_DELIVERY_TEXT = 40_000;
/** How long a (calling piece, id) answer is kept and replayed. */
export const DELIVERY_REPLAY_MS = 24 * 60 * 60 * 1000;
/** The deliver body's cap: 40,000 characters of text can be 160 KB of UTF-8, plus the rest. */
export const DELIVER_MAX_BYTES = 256 * 1024;
/** The runtime's answer's cap (the mcp_tools limit). */
export const DELIVERY_ANSWER_MAX_BYTES = 64 * 1024;

export type DeliverKind = 'message' | 'wake' | 'note';
const DELIVER_KINDS: readonly DeliverKind[] = ['message', 'wake', 'note'];
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
}

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
  if (!DELIVER_KINDS.includes(raw.kind as DeliverKind)) return `kind is one of ${DELIVER_KINDS.join(', ')}`;
  // The key and turn fields are conversations.md's: the turn parser checks them the same way.
  // It reads a `note` as the agent's own turn (with a run and an outcome); a delivered note is
  // someone's mid-turn word to the body, so its other fields are checked as a message's.
  let turn;
  try {
    turn = parseTurn({ venue: raw.venue, place: raw.place, at: raw.at, from: raw.from, kind: raw.kind === 'note' ? 'message' : raw.kind, ...(raw.label !== undefined ? { label: raw.label } : {}) }, raw.agent);
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
  const declared = offersIn(rec.loom).venues?.[d.venue];
  // The venue. `session` is the harness's own; `wake` is core's (conversations.md: it may not be
  // declared), so any piece may deliver a schedule's knock on it; any other, only its declarer.
  if (d.venue === 'session') return refuse(403, 'forbidden: venue session is a harness\'s own session; nothing is delivered into it');
  if (d.venue === 'wake') {
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

function deliveriesDb(home: string): Database {
  const db = openHouseholdDb(home);
  db.exec(`CREATE TABLE IF NOT EXISTS deliveries (
    piece       TEXT NOT NULL,
    id          TEXT NOT NULL,
    at          INTEGER NOT NULL,
    answer_json TEXT NOT NULL,
    PRIMARY KEY (piece, id)
  )`);
  return db;
}

/** The kept answer for (piece, id), if one is younger than 24 hours. */
export function replayOf(home: string, piece: string, id: string, nowMs = Date.now()): DeliverAnswer | undefined {
  if (!existsSync(join(home, HOUSEHOLD_DB))) return undefined;
  const db = deliveriesDb(home);
  try {
    const r = db.prepare('SELECT answer_json FROM deliveries WHERE piece = ? AND id = ? AND at > ?').get(piece, id, nowMs - DELIVERY_REPLAY_MS) as { answer_json: string } | undefined;
    return r ? JSON.parse(r.answer_json) as DeliverAnswer : undefined;
  } finally {
    db.close();
  }
}

/** Keep an answer for (piece, id), and sweep the entries over 24 hours old. */
export function keepAnswer(home: string, piece: string, id: string, answer: DeliverAnswer, nowMs = Date.now()): void {
  const db = deliveriesDb(home);
  try {
    db.transaction(() => {
      db.prepare('DELETE FROM deliveries WHERE at <= ?').run(nowMs - DELIVERY_REPLAY_MS);
      db.prepare('INSERT OR REPLACE INTO deliveries (piece, id, at, answer_json) VALUES (?, ?, ?, ?)').run(piece, id, nowMs, JSON.stringify(answer));
    })();
  } finally {
    db.close();
  }
}

/** Drop every kept answer over 24 hours old (also done on each write); answers how many went. */
export function sweepDeliveries(home: string, nowMs = Date.now()): number {
  if (!existsSync(join(home, HOUSEHOLD_DB))) return 0;
  const db = deliveriesDb(home);
  try { return db.prepare('DELETE FROM deliveries WHERE at <= ?').run(nowMs - DELIVERY_REPLAY_MS).changes; } finally { db.close(); }
}

// ─── The route ──────────────────────────────────────────────────────────────

/** Deliveries in flight, by piece and id: a repeat that arrives meanwhile waits for the first. */
const inFlight = new Map<string, Promise<DeliverResult>>();

/**
 * POST /api/loom/deliver as `caller` (the route already resolved its token to a piece).
 * 400 for a body that isn't the contract's; 403 for a delivery the caller may not make; 503
 * with no delivery piece; then the kept answer for a repeat, or the runtime's answer. A
 * runtime that fails, times out or is busy is a 5xx (502, 504, 503), never kept.
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
  const key = `${caller.piece}\0${d.id}`;
  const pending = inFlight.get(key);
  if (pending) return pending;
  const run = (async (): Promise<DeliverResult> => {
    const kept = replayOf(h.home, caller.piece, d.id, nowMs());
    if (kept) return { status: 200, body: kept };
    const r = await runOffer(env, target.piece, target.argv, {
      stdin: JSON.stringify({ source: caller.piece, ...d }),
      parse: parseDeliverAnswer,
      maxBytes: DELIVERY_ANSWER_MAX_BYTES,
      long: true,
    });
    if (!r.ok) {
      if (r.error === 'busy') return refuse(503, `unavailable: the delivery piece (${target.piece}) is busy; try again shortly`);
      if (r.error === 'timed out') return refuse(504, `timeout: the delivery piece (${target.piece}) didn't answer within 120 s`);
      return refuse(502, `bad-gateway: the delivery piece (${target.piece}) failed (${r.error})`);
    }
    keepAnswer(h.home, caller.piece, d.id, r.value, nowMs());
    return { status: 200, body: r.value };
  })();
  inFlight.set(key, run);
  try { return await run; } finally { inFlight.delete(key); }
}
