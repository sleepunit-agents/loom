/**
 * Agent grants: whether an agent may make a call to a piece (docs/specs/agent-runtime.md,
 * "6. Permissions", Agent grants; "Seams this needs from core", 2, `grants`).
 *
 * With one installed piece offering `grants` (the runtime), core asks it before an agent's call
 * to any piece (`/api/<piece>/…`, `/api/<piece>/run`, an offered MCP tool: src/offered-tools.ts) and
 * before forwarding a delivery for an agent (src/delivery.ts). The ask is the offer's argv with
 * `{agent, piece, path}` on stdin, in a pool of its own, with 10 s to answer `{allow: true}` or
 * `{allow: false, reason}`.
 *
 *  - **Fail closed:** a timeout, an error, an answer that isn't the contract's, or the authority
 *    uninstalled while the call was in flight: the call is refused with 503 and the reason.
 *  - **Refused:** `{allow: false, reason}` is a 403 with the authority's reason. The piece never runs.
 *  - **Fallback:** with no authority installed, there's nothing to ask: each piece decides by its
 *    own agent list, as before. A shared collection has no such list (docs/specs/collections.md, "2. Consumer
 *    capability"): asked with `required`, no authority is a refusal.
 *  - Owner calls never ask (the callers here are agents' only), nor does the authority's own piece
 *    asking about itself for a delivery (src/delivery.ts).
 *  - **Answers reused, never stale** (t-2065): running the authority for every call was two node
 *    processes a call, a few a second, and pinned loom's machine. An authority that declares
 *    `grants_store` (the collection of its own store its answer rests on) is asked with `basis: true`
 *    and says, beside its answer, which document of it it decided on and that document's sha256
 *    (null: there was none), and whose store and which collection that was. Core reads the collection itself, from the authority's store file, before
 *    and after asking. It keeps the answer only when the collection was the same both times and the
 *    document the authority named is, in it, exactly what the authority read: so the answer is the
 *    one for that state, whatever store the authority actually read. It then reuses it only while
 *    the collection is still in that state, read again before every call: any write to it (a grant
 *    given or taken, a seed, a revert) is a new ask at once. A failure is never kept, nor is anything
 *    when the collection can't be read or the authority said no basis, and a kept answer is at most
 *    ANSWER_MAX_AGE_MS old. That bound is also how long a kept answer outlives the authority breaking
 *    in a way its state doesn't show (its `loom` CLI, its node, the machine too busy to answer): the
 *    answer is still the right one for the grants as they are, but where it was a 503, for up to a
 *    minute it isn't. The store file is read where every loom finds it (docs/specs/piece-storage.md:
 *    <LOOM_HOME>/commons/stores/<piece>.db), and the authority is run with that LOOM_HOME.
 */
import { createHash } from 'node:crypto';
import { existsSync, realpathSync, statSync } from 'node:fs';
import { join } from 'node:path';
import BetterSqlite3 from 'better-sqlite3';
import { managedBinDir, readRecord, versionKey } from './cli/pieces-managed.js';
import { householdHome } from './household.js';
import { grantsAuthority, runOffer } from './offers-registry.js';
import { COLLECTION, KEY as STORE_KEY, PIECE as STORE_PIECE, storesDir } from './stores.js';

export interface GrantAsk {
  agent: string;
  piece: string;
  path: string;
  /** A house's token (its id), a service house's (its service): said to the authority when there is one. */
  house?: string;
  service?: string;
}

/** Undefined when the call may go on; else the status (403 refused, 503 couldn't ask) and why. */
export type GrantRefusal = { status: 403 | 503; error: string } | undefined;

/**
 * What an authority asked with `basis: true` says it decided on: whose store it read (`piece`), a document of its
 * grants_store there, and the sha256 of that document's text (null: none).
 */
export interface GrantBasis { piece: string; collection: string; key: string; sha256: string | null }
type GrantAnswer = { allow: true } | { allow: false; reason: string };

/**
 * The authority's answer checked: `{allow: true}`, or `{allow: false, reason}` (1-500 characters).
 * Asked with `basis: true`, it may say `basis` too ({key, sha256}): `withBasis` lets it.
 */
export function parseGrantAnswer(v: unknown, withBasis = false): (GrantAnswer & { basis?: GrantBasis }) | string {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return 'not a JSON object';
  const o = v as Record<string, unknown>;
  const bad = Object.keys(o).find((k) => k !== 'allow' && k !== 'reason' && !(withBasis && k === 'basis'));
  if (bad !== undefined) return `unknown key ${JSON.stringify(bad)}`;
  let basis: GrantBasis | undefined;
  if (o.basis !== undefined) {
    const b = o.basis as Record<string, unknown> | null;
    if (!b || typeof b !== 'object' || Array.isArray(b) || Object.keys(b).some((k) => k !== 'piece' && k !== 'collection' && k !== 'key' && k !== 'sha256')
      || typeof b.piece !== 'string' || !STORE_PIECE.test(b.piece) || typeof b.collection !== 'string' || !COLLECTION.test(b.collection) || typeof b.key !== 'string' || !STORE_KEY.test(b.key)
      || !(b.sha256 === null || (typeof b.sha256 === 'string' && /^[0-9a-f]{64}$/.test(b.sha256)))) {
      return 'basis is {piece, collection, key, sha256}: whose store and which collection were read, the document and its sha256, or null';
    }
    basis = { piece: b.piece, collection: b.collection, key: b.key, sha256: b.sha256 as string | null };
  }
  if (o.allow === true) return basis ? { allow: true, basis } : { allow: true };
  if (o.allow !== false) return 'allow is true or false';
  if (typeof o.reason !== 'string' || !o.reason.length || o.reason.length > 500) return 'a refusal says why (reason, 1-500 characters)';
  return basis ? { allow: false, reason: o.reason, basis } : { allow: false, reason: o.reason };
}

/**
 * Ask the grants authority, if one is installed, whether `agent` may make this call to `piece`.
 * A path is what follows /api/<piece>/ (`run` for a piece's remote CLI), or `deliver` for a
 * delivery the piece makes for the agent.
 */
export async function askGrant(env0: NodeJS.ProcessEnv, ask0: GrantAsk, opts: { required?: boolean } = {}): Promise<GrantRefusal> {
  // One home for everything here: the records and bin read, the store file read, and the authority's own
  // `loom store` reads (it runs with this env), so core and the authority look at the same file.
  const env: NodeJS.ProcessEnv = { ...env0, LOOM_HOME: householdHome(env0) };
  // Exactly what the key names is what the authority is asked.
  const ask: GrantAsk = { agent: ask0.agent, piece: ask0.piece, path: ask0.path, ...(ask0.house !== undefined ? { house: ask0.house } : {}), ...(ask0.service !== undefined ? { service: ask0.service } : {}) };
  const auth = grantsAuthority(env);
  if (auth.piece === undefined) {
    if (auth.conflict) return { status: 503, error: `unavailable: more than one piece offers grants (${auth.conflict.join(', ')}); there's no authority to ask` };
    // Where there's no piece's own list to fall back on (a shared collection: docs/specs/collections.md), no authority is a no.
    if (opts.required) return { status: 403, error: `forbidden: no grants authority is installed, so ${ask0.agent} is given nothing of ${ask0.piece}'s ${ask0.path}` };
    return undefined;
  }
  const who = `${ask.agent}'s call to ${ask.piece}`;
  const before = grantsState(env, auth.piece, auth.argv);
  const key = before && `${before.id}\0${JSON.stringify([ask.agent, ask.piece, ask.path, ask.house ?? null, ask.service ?? null])}`;
  const hit = key ? answers.get(key) : undefined;
  if (hit && performance.now() - hit.at < ANSWER_MAX_AGE_MS) return refusal(hit.answer);
  const stdin = JSON.stringify(before ? { ...ask, basis: true } : ask);
  const r = await runOffer(env, auth.piece, auth.argv, { kind: 'grants', stdin, parse: (v) => parseGrantAnswer(v, before !== undefined) });
  // Uninstalled (or replaced by another authority) while it was asked: the answer is no one's now.
  if (grantsAuthority(env).piece !== auth.piece) return { status: 503, error: `unavailable: the grants authority (${auth.piece}) was removed while it was asked, so ${who} is refused` };
  if (!r.ok) return { status: 503, error: `unavailable: the grants authority (${auth.piece}) didn't answer (${r.error}), so ${who} is refused` };
  const { basis, ...answer } = r.value;
  // Kept only for exactly the state it was decided on: the authority read its own store (the one
  // read here, so a write to it is seen), the document it read is the one in it, and the
  // collection didn't change while it was asked.
  if (key && before && basis && basis.piece === auth.piece && basis.collection === before.collection && (before.docs.get(basis.key) ?? null) === basis.sha256 && grantsState(env, auth.piece, auth.argv)?.id === before.id) {
    remember(key, answer as GrantAnswer);
  }
  return refusal(answer as GrantAnswer);
}

function refusal(a: GrantAnswer): GrantRefusal {
  return a.allow ? undefined : { status: 403, error: `forbidden: ${a.reason}` };
}

/** Answers kept (t-2065), by basis and ask. Bounded, and never older than ANSWER_MAX_AGE_MS. */
const answers = new Map<string, { at: number; answer: GrantAnswer }>();
const ANSWER_MAX = 2_000;
export const ANSWER_MAX_AGE_MS = 60_000;

function remember(key: string, answer: GrantAnswer): void {
  if (answers.size >= ANSWER_MAX) answers.clear();
  answers.set(key, { at: performance.now(), answer });
}

/** Forget every kept answer (tests; nothing else needs it: a change is a new basis). */
export function clearGrantAnswers(): void { answers.clear(); }

/**
 * The state an answer rests on: `id` names the authority (name, argv, installed version), its store
 * file, and the state of its grants_store collection (the highest revision id, which only grows, so a
 * collection written and written back is a new state; and every document's text); `docs` is each
 * document's sha256. Undefined (ask, keep nothing) when it declared no grants_store, the collection
 * isn't one it declares with revisions kept, or anything can't be read.
 */
export function grantsState(env: NodeJS.ProcessEnv, piece: string, argv: readonly string[]): { id: string; collection: string; docs: Map<string, string> } | undefined {
  try {
    const rec = readRecord(env, piece);
    const coll = rec?.loom.grants_store;
    const decl = coll && rec.loom.store && Object.hasOwn(rec.loom.store, coll) ? rec.loom.store[coll] : undefined;
    if (!rec || !coll || !decl || decl.history === false) return undefined;
    // Where `loom store <piece> …` finds it on this machine (src/cli/store.ts).
    const file = join(storesDir(householdHome(env)), `${piece}.db`);
    // The bin as it resolves now, and when that file last changed: an authority relinked or rebuilt is a new one.
    const bin = managedBinDir(env);
    if (!bin || !argv[0]) return undefined;
    const real = realpathSync(join(bin, argv[0]));
    const version = JSON.stringify([piece, argv, versionKey(rec.source), rec.installed, real, statSync(real).mtimeMs, file, coll]);
    if (!existsSync(file)) return { id: `${version}\0none`, collection: coll, docs: new Map() };
    // Never wait on a lock: a busy store is a miss (asked, nothing kept), not a stalled event loop.
    const db = new BetterSqlite3(file, { readonly: true, fileMustExist: true, timeout: 50 });
    try {
      return db.transaction(() => {
        const rev = db.prepare('SELECT COALESCE(MAX(id), 0) AS id FROM revisions WHERE collection = ?').get(coll) as { id: number };
        const rows = db.prepare('SELECT key, rev, doc FROM docs WHERE collection = ? ORDER BY key').all(coll) as Array<{ key: string; rev: number; doc: string }>;
        const docs = new Map(rows.map((x) => [x.key, createHash('sha256').update(x.doc).digest('hex')]));
        const all = createHash('sha256').update(JSON.stringify(rows.map((x) => [x.key, x.rev, docs.get(x.key)]))).digest('hex');
        return { id: `${version}\0${rev.id}\0${all}`, collection: coll, docs };
      })();
    } finally {
      db.close();
    }
  } catch {
    return undefined;
  }
}
