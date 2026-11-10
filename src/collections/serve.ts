/**
 * Serving a batch of collection queries for one viewer (docs/specs/collections.md, "Asking: queries" and "Who may
 * see what"). The order of the checks is the contract's:
 *
 *  1. Each query's type is looked up in its provider's installed declaration (never a cached manifest).
 *  2. The provider must answer this viewer at all (`owners: 2`, else household owners only).
 *  3. An agent's or a house's token must be granted the type (the grants authority, path
 *     `collections/<provider>/<type>`; none installed: denied), and a house's must be allowed by the type.
 *  4. The query is checked against the type and the viewer's field classes (query.ts).
 *  Only then is the provider run: one process per provider per batch, never mixing viewers, in a pool of its own.
 *  5. Every row it answers is checked again by core: its audience and the agent rule admit the viewer, it hasn't
 *     expired, and it carries only the fields the viewer may see and asked for. A provider that ignores the viewer
 *     leaks nothing: it's out of contract, and answers no one until it's reinstalled (outOfContract).
 *  6. Counts a provider makes go to household owners only, unless the type declares scoped counts. Where an answer
 *     is complete, core counts the rows it checked itself.
 *
 * One provider's failure never fails another's queries in the batch: its own answer `unavailable`.
 */
import type { Household } from '../household.js';
import { askGrant } from '../grants.js';
import { isLocal, managedPieces, readCatalog } from '../cli/pieces-managed.js';
import { runOffer } from '../offers-registry.js';
import { Pool, type ApiCaller } from '../ui/pieces.js';
import { CORE_PROVIDER, RECORD_ID, providerName, type CollectionsOffer, type TypeDecl } from './contract.js';
import { CORE_TYPES, coreAnswers } from './core-types.js';
import type { ProviderAnswer, ProviderQuery } from './memory.js';
import { checkQuery, MAX_PROVIDER_CURSOR, MAX_QUERIES, queryShape, sealerFor, typeRef, validQueryId, type Query, type QueryError, type QueryIn, type Sealer } from './query.js';
import { domainOfType } from './pull.js';
import { atOf, attach, prepare, streamFor, unsubscribe } from './subs.js';
import { admits, classesOf, isHouseholdOwner, parseAudience, presented, providerAdmits, viewerId, type Audience, type Viewer } from './viewer.js';

/** Where a batch is asked: POST /collections/query (the page) and POST /api/loom/<this> (tokens). */
export const COLLECTIONS_QUERY_ROUTE = 'collections/query';
/** Where anyone who wrote says a domain moved (pull.ts, nudge). */
export const COLLECTIONS_NUDGE_ROUTE = 'collections/nudge';
/** A batch of queries' body. */
export const COLLECTIONS_MAX_BYTES = 64 * 1024;
/** An answer's byte budget, shared among the queries a provider is asked in one batch. */
export const ANSWER_MAX_BYTES = 1024 * 1024;
/** A record's cap (collections.md, exceptions: "the 256 KB record cap"). */
export const RECORD_MAX_BYTES = 256 * 1024;
export const MAX_RUNNING = 4;
export const MAX_WAITING = 16;

export interface Provider {
  name: string;
  /** The installed piece serving it; none for core. */
  piece?: string;
  owners2: boolean;
  types: Readonly<Record<string, TypeDecl>>;
  query?: string[];
  /** Which install this is (the piece and when it was installed): a reinstall is a new chance (outOfContract). */
  install?: string;
  /** The provider's `changes` argv; none: core bridges it (pull.ts). */
  changes?: string[];
}

/**
 * Core and every installed first-party piece publishing collections, by provider name, from their installed
 * declarations.
 *
 * First-party only, until the conformance run (t-2026) can vouch for a provider. Core checks every row, but against a
 * provider that ignores its viewer it can only take it out of contract at the first hidden row, and every answer
 * before that said no hidden record matched its query: a viewer choosing the queries can learn from that. So, as a
 * piece's pages already are (owners.md: a piece with `owners: 2` scopes what it shows), a provider is trusted code:
 * one installed from a repo in loom's catalog (assets/pieces.json), never a local or unlisted one.
 */
let firstPartyRepos: Set<string> | undefined;
const firstParty = (): Set<string> => (firstPartyRepos ??= new Set(readCatalog().map((e) => e.repo)));

export function providers(env: NodeJS.ProcessEnv): Map<string, Provider> {
  const out = new Map<string, Provider>([[CORE_PROVIDER, { name: CORE_PROVIDER, owners2: true, types: CORE_TYPES }]]);
  const taken = new Set<string>([CORE_PROVIDER]);
  for (const r of managedPieces(env)) {
    const c: CollectionsOffer | undefined = r.loom.collections;
    if (!c) continue;
    if (isLocal(r.source) || !firstParty().has(r.source.repo)) continue;
    const name = providerName(r);
    // Install refuses a taken name; were two ever present (piece.json edited by hand), none of them is served, and
    // core's own name is never a piece's.
    if (taken.has(name)) { if (name !== CORE_PROVIDER) out.delete(name); continue; }
    taken.add(name);
    out.set(name, { name, piece: r.name, owners2: c.owners === 2, types: c.types, query: c.query, install: `${r.name}@${r.installed ?? ''}@${r.version ?? ''}`, ...(c.changes ? { changes: c.changes } : {}) });
  }
  return out;
}

/**
 * Providers that answered a row their viewer may not have, by install. Whatever core then does differently (a shorter
 * page, no next cursor, an error) would tell the viewer a hidden record matched their query, and a viewer choosing the
 * queries could read hidden values that way. So such a provider is out of contract: it answers `unavailable` to
 * everyone until it's reinstalled or loom restarts, and the asking viewer learns one bit, once.
 */
const outOfContract = new Set<string>();
export const clearOutOfContract = (): void => outOfContract.clear();
/** Whether a provider is out of contract now (subs.ts resets its live subscriptions). */
export const isOutOfContract = (p: Provider): boolean => p.install !== undefined && outOfContract.has(p.install);

const pools = new Map<string, Pool>();
const poolOf = (provider: string): Pool => {
  let p = pools.get(provider);
  if (!p) { p = new Pool(MAX_RUNNING, MAX_WAITING); pools.set(provider, p); }
  return p;
};

export interface ClientAnswer {
  id: string;
  rows: Record<string, unknown>[];
  next: string | null;
  coverage: { complete: boolean; total?: { n: number; exact: boolean } };
  aggregates?: Record<string, { n: number; exact: boolean; by?: Record<string, number> }>;
  withheld: string[];
  /** A live query's: the stream seq its frames follow, and the viewer's scope epoch. */
  at?: number;
  scope?: number;
}

export type BatchResult = { status: 200; body: { answers: Array<ClientAnswer | QueryError> } } | { status: 400; body: { error: string } };

export interface ServeContext {
  env: NodeJS.ProcessEnv;
  household: Household;
  /** The household read fresh, for a subscription that outlives this request (default: `household`). */
  live?: () => Household;
  now?: number;
  /** The page's own request (its session, by streamOwner): only it may subscribe, on its own streams. */
  page?: { session: string };
}

/** The caller a piece's provider runs as, for its store grant (src/ui/pieces.ts, withGrant). */
function callerOf(viewer: Viewer): ApiCaller {
  switch (viewer.kind) {
    case 'core': return { kind: 'owner' };
    case 'member': return viewer.household ? { kind: 'owner', who: viewer.person, agents: '*' } : { kind: 'owner', who: viewer.person, agents: [...viewer.agents] };
    case 'agent': return { kind: 'agent', agent: viewer.agent, ...(viewer.house ? { house: viewer.house } : {}), ...(viewer.service ? { service: viewer.service } : {}) };
  }
}

/** The answers to a batch of queries (a POST body `{queries: [...]}`) for one viewer. */
export async function answerBatch(ctx: ServeContext, viewer: Viewer, body: unknown): Promise<BatchResult> {
  const now = ctx.now ?? Date.now();
  // A window done with some live queries (`close: {stream, ids}`): its own stream's only.
  const close = (body as { close?: { stream?: unknown; ids?: unknown } } | null)?.close;
  if (close !== undefined) {
    if (!ctx.page || !close || typeof close.stream !== 'string' || !Array.isArray(close.ids) || close.ids.length > 64 || !close.ids.every(validQueryId)) {
      return { status: 400, body: { error: 'close is {stream, ids}: this page\'s stream and up to 64 of its live queries' } };
    }
    unsubscribe(ctx.household.home, close.stream, ctx.page.session, close.ids as string[]);
    if ((body as { queries?: unknown }).queries === undefined) return { status: 200, body: { answers: [] } };
  }
  const qs = (body as { queries?: unknown } | null)?.queries;
  if (!Array.isArray(qs) || !qs.length || qs.length > MAX_QUERIES) return { status: 400, body: { error: `queries is a list of 1-${MAX_QUERIES} queries` } };
  const ids = new Set<string>();
  for (const q of qs as QueryIn[]) {
    if (!q || typeof q !== 'object' || Array.isArray(q) || !validQueryId(q.id)) return { status: 400, body: { error: 'every query has an id: 1-64 letters, digits, - or _' } };
    if (ids.has(q.id)) return { status: 400, body: { error: `two queries are named ${q.id}` } };
    ids.add(q.id);
  }
  const all = providers(ctx.env);
  const sealer = sealerFor(ctx.household.home);
  const vid = viewerId(viewer);
  const classes = classesOf(viewer);
  const owner = isHouseholdOwner(viewer);
  const answers = new Map<string, ClientAnswer | QueryError>();
  const asked = new Map<string, Promise<'denied' | 'unavailable' | undefined>>();
  const byProvider = new Map<string, Query[]>();

  for (const q of qs as QueryIn[]) {
    const ref = typeRef(q.type);
    if (!ref) { answers.set(q.id, { id: q.id, error: 'bad-query', why: 'type is <provider>/<type>@^<major>' }); continue; }
    // An agent's or a house's token: granted first, so its answers don't say what's installed.
    if (viewer.kind === 'agent') {
      const k = `${ref.provider}/${ref.type}`;
      if (!asked.has(k)) {
        asked.set(k, askGrant(ctx.env, { agent: viewer.agent, piece: CORE_PROVIDER, path: `collections/${k}`, ...(viewer.house ? { house: viewer.house } : {}), ...(viewer.service ? { service: viewer.service } : {}) }, { required: true })
          .then((no) => (no ? (no.status === 403 ? 'denied' as const : 'unavailable' as const) : undefined)));
      }
      const no = await asked.get(k)!;
      if (no) { answers.set(q.id, { id: q.id, error: no }); continue; }
    }
    const p = all.get(ref.provider);
    const decl = p && Object.hasOwn(p.types, ref.type) ? p.types[ref.type] : undefined;
    // Only a household owner may learn what's installed (as /pieces.json): anyone else gets one answer for a provider
    // that isn't there and one that doesn't answer them.
    if (!p || !decl) { answers.set(q.id, owner ? { id: q.id, error: 'unsupported-version', why: `nothing installed serves ${ref.provider}/${ref.type}` } : { id: q.id, error: 'denied' }); continue; }
    if (!providerAdmits(viewer, p.owners2)) { answers.set(q.id, { id: q.id, error: 'denied' }); continue; }
    if (viewer.kind === 'agent' && ((viewer.service !== undefined && !(decl.houses && decl.services)) || (viewer.house !== undefined && !decl.houses))) {
      answers.set(q.id, { id: q.id, error: 'denied' });
      continue;
    }
    const checked = checkQuery(q, decl, classes, owner, (sealed, shape) => sealer.unseal(sealed, vid, shape, now));
    if ('error' in checked) { answers.set(q.id, checked); continue; }
    const list = byProvider.get(p.name) ?? [];
    list.push(checked);
    byProvider.set(p.name, list);
  }

  const householdNow = ctx.live ?? (() => ctx.household);
  const envNow = () => ctx.env;
  await Promise.all([...byProvider].map(async ([name, list]) => {
    const p = all.get(name)!;
    // A live query: its stream must be this page's own, open here; its domain is in the log before the provider runs.
    const starts = new Map<string, number>();
    for (const q of list.filter((x) => x.subscribe)) {
      if (!ctx.page) { answers.set(q.id, { id: q.id, error: 'bad-query', why: 'subscribing is the page\'s: there\'s no stream on /api' }); continue; }
      if (!streamFor(ctx.household.home, q.stream, ctx.page.session)) { answers.set(q.id, { id: q.id, error: 'bad-query', why: 'stream isn\'t one of this session\'s open streams' }); continue; }
      if (p.types[q.type].audience === 'ask' && q.after !== null) { answers.set(q.id, { id: q.id, error: 'bad-query', why: 'a live query of this type is one page' }); continue; }
      if (!starts.has(q.type)) starts.set(q.type, (await prepare(householdNow, envNow, p, q.type)).startSeq);
    }
    const runnable = list.filter((q) => !answers.has(q.id));
    if (!runnable.length) return;
    const ran = await runChecked(ctx, p, viewer, runnable, now, sealer, vid);
    for (const q of runnable) {
      let r = ran.get(q.id)!;
      if (q.subscribe && 'rows' in r.answer) {
        for (let tries = 0; ; tries++) {
          if (!('rows' in r.answer)) break;
          const a = r.answer;
          const att = await attach(householdNow, envNow, { stream: q.stream!, session: ctx.page!.session }, viewer, p, q,
            { next: a.next, aggregates: a.aggregates, complete: a.coverage.complete }, r.admitted, r.last, r.at, starts.get(q.type) ?? 0,
            // Asked again later, for as long as the subscription lives: the household and env as they are then.
            (v, pp, qq) => reask({ ...ctx, household: householdNow(), env: envNow() }, pp, v, qq, sealer));
          if ('at' in att) { r = { ...r, answer: { ...a, at: att.at, scope: att.scope } }; break; }
          if ('error' in att) { r = { ...r, answer: { id: q.id, error: att.error, ...(att.why ? { why: att.why } : {}) } as QueryError }; break; }
          // The store's history moved under the answer: ask again (a new epoch, or a revision the log no longer holds).
          if (tries >= 2) { r = { ...r, answer: { id: q.id, error: 'unavailable' } }; break; }
          r = (await runChecked(ctx, p, viewer, [q], now, sealer, vid)).get(q.id)!;
        }
      }
      answers.set(q.id, r.answer);
    }
  }));
  return { status: 200, body: { answers: (qs as QueryIn[]).map((q) => answers.get(q.id)!) } };
}

interface Ran {
  answer: ClientAnswer | QueryError;
  /** The provider's own answer (for its next), the rows core admitted (whole, as the provider sent them), its last row. */
  provider?: ProviderAnswer;
  admitted: Record<string, unknown>[];
  last?: Record<string, unknown>;
  at?: { rev: number; txn: string };
}

/**
 * Run a provider for some of a batch's queries and check every answer (checkAnswer), taking the provider out of
 * contract when any row in the run is one its viewer may not have. A live query asks for its order and by fields too,
 * so core can keep its window and counts; they're dropped from what the viewer gets unless asked for.
 */
async function runChecked(ctx: ServeContext, p: Provider, viewer: Viewer, list: readonly Query[], now: number, sealer: Sealer, vid: string): Promise<Map<string, Ran>> {
  const share = Math.floor(ANSWER_MAX_BYTES / list.length);
  const asks: ProviderQuery[] = list.map((q) => {
    const decl = p.types[q.type];
    // One row more than the page: core says there's more only when it has seen (and admitted) a row past the page, so
    // `next` never says a hidden record matched. The order's fields and the agent field too: core makes the cursor from
    // the one and reads the other for its agent rule; a live query's by fields, for the counts core keeps. All are
    // dropped again unless asked for.
    const extra = [...q.order.map(([f]) => f), ...(q.subscribe ? q.aggregates.flatMap((a) => decl.aggregates?.[a]?.by ?? []) : [])];
    return { id: q.id, type: q.type, version: q.major, where: q.where, order: q.order, limit: q.limit + 1, after: q.after,
      fields: [...new Set([...q.fields.filter((f) => f !== 'audience'), ...(decl.agent ? [decl.agent] : []), ...extra])], aggregates: q.aggregates };
  });
  const broken = () => p.install !== undefined && outOfContract.has(p.install);
  const got = broken() ? 'out of contract' : await runProvider(ctx, p, viewer, list, asks, share, now);
  const out = new Map<string, Ran>();
  const checked = list.map((q) => {
    const collect: Collected = { admitted: [] };
    if (got === OUT_OF_CONTRACT) return { q, a: undefined, collect, c: OUT_OF_CONTRACT as typeof OUT_OF_CONTRACT };
    const a = typeof got === 'string' ? undefined : got.answers.get(q.id);
    if (!a) return { q, a, collect, c: { id: q.id, error: 'unavailable' } as QueryError };
    return { q, a, collect, c: checkAnswer(viewer, p, q, a, share, now, (c) => sealer.seal(c, vid, queryShape({ provider: q.provider, type: q.type, major: q.major }, q.where, q.order), now), collect) };
  });
  // One row out of contract makes the whole run's answers unavailable, not just its own query's: the batch's other
  // answers came from the same provider, deciding for the same viewer. Marked out of contract while this run was out
  // (another run's row): this one answers as the provider now does.
  const bad = checked.some((x) => x.c === OUT_OF_CONTRACT) || broken();
  if (bad && p.install !== undefined && !broken()) {
    outOfContract.add(p.install);
    process.stderr.write(`loom: collections provider ${p.name} (${p.piece}) answered a row its viewer may not have; it answers no one until it's reinstalled or loom restarts\n`);
  }
  for (const { q, a, collect, c } of checked) {
    const answer = bad || c === OUT_OF_CONTRACT ? { id: q.id, error: 'unavailable' } as QueryError : c as ClientAnswer | QueryError;
    const at = typeof got === 'string' || got === OUT_OF_CONTRACT ? undefined : atOf(got.at, domainOfType(p, q.type));
    out.set(q.id, { answer, ...(a ? { provider: a } : {}), admitted: collect.admitted, ...(collect.last ? { last: collect.last } : {}), ...(at ? { at } : {}) });
  }
  return out;
}

/** A live query asked again for its subscription (subs.ts): its first page, as its viewer, through the same checks. */
async function reask(ctx: ServeContext, p: Provider, viewer: Viewer, q: Query, sealer: Sealer): Promise<{ rows: Record<string, unknown>[]; admitted: Record<string, unknown>[]; aggregates?: ClientAnswer['aggregates'] } | undefined> {
  const again: Query = { ...q, after: null, subscribe: false, ...(p.types[q.type].audience === 'ask' ? {} : { limit: 1 }) };
  const r = (await runChecked(ctx, p, viewer, [again], Date.now(), sealer, viewerId(viewer))).get(q.id);
  if (!r || !('rows' in r.answer)) return undefined;
  return { rows: r.answer.rows, admitted: r.admitted, ...(r.answer.aggregates ? { aggregates: r.answer.aggregates } : {}) };
}

/**
 * One provider's answers to its share of the batch, by query id; a string when it failed as a whole, OUT_OF_CONTRACT
 * when a row it sent was one its viewer may not have.
 *
 * A provider answers in JSON lines, read as they come (readAnswers), and every row is checked for its viewer the moment
 * it arrives. A row the viewer may not have stops the run there. Only the rows core admits count against each query's
 * share of the answer's bytes, and only core says a query is `too-big`: a provider's own size, error or count over rows
 * it didn't filter would tell a viewer choosing the queries that hidden records matched.
 */
async function runProvider(ctx: ServeContext, p: Provider, viewer: Viewer, list: readonly Query[], asks: ProviderQuery[], share: number, now: number): Promise<{ answers: Map<string, ProviderAnswer>; at?: unknown } | string | typeof OUT_OF_CONTRACT> {
  if (!p.piece) return { answers: new Map((await coreAnswers(ctx.household, viewer, asks, now)).map((a) => [a.id, a])) };
  const piece = p.piece;
  // The scope a page's piece gets (owners.md), and never one inherited from loom's own environment.
  const { LOOM_SCOPE: _s, LOOM_OWNER_SCOPE: _o, ...env0 } = ctx.env;
  const env: NodeJS.ProcessEnv = viewer.kind === 'member' && !viewer.household ? { ...env0, LOOM_OWNER_SCOPE: viewer.agents.join(',') } : env0;
  const stdin = JSON.stringify({ viewer: presented(viewer), now: new Date(now).toISOString(), queries: asks });
  // A row counts against its query's share as the viewer would get it (cut to their fields), never as the provider
  // printed it: a careless provider's extra fields would otherwise show their size.
  const asked = new Map(list.map((q) => [q.id, q]));
  const reading = readAnswers(asks, share, (q, row) => {
    const placed = admission(viewer, p.types[q.type], row);
    if (!placed) return undefined;
    const r = row as Record<string, unknown>;
    const out: Record<string, unknown> = { key: `${p.name}/${q.type}/${String(r.id)}` };
    for (const f of asked.get(q.id)?.fields ?? []) { if (f === 'audience') out.audience = placed.audience; else if (Object.hasOwn(r, f)) out[f] = r[f]; }
    return Buffer.byteLength(JSON.stringify(out));
  });
  const r = await poolOf(p.name).run(() => runOffer(env, piece, p.query!, { kind: 'collections', stdin, caller: callerOf(viewer), parse: (v) => v, onLine: reading.onLine }));
  // A hidden row, a broken line, a row out of its place, or one longer than a row may be: out of contract.
  if (reading.tripped() || (r !== null && !r.ok && r.error === 'line too long')) return OUT_OF_CONTRACT;
  if (r === null) return 'busy';
  if (!r.ok) {
    process.stderr.write(`loom: collections provider ${p.name} (${piece}) failed: ${r.error}\n`);
    return r.error;
  }
  return { answers: reading.answers(), at: reading.at() };
}

/**
 * Reading a provider's answer, a line at a time: `{"id": q, "row": {...}}` for each row, `{"id": q, "more": bool}` to
 * end a query's rows, `{"id": q, "error": "unavailable" | "bad-query" | "unsupported-version"}` instead, and
 * `{"at": {...}}` once. `admit` answers a row's size as its viewer would get it, or undefined when it's not one they
 * may have; such a row, more rows than a query asked for, a `too-big` (core's to say), or a line that isn't one of
 * these stops the run as out of contract.
 */
export function readAnswers(asks: readonly ProviderQuery[], share: number, admit: (q: ProviderQuery, row: unknown) => number | undefined): {
  onLine: (line: string) => 'go' | 'stop'; tripped: () => boolean; answers: () => Map<string, ProviderAnswer>; at: () => unknown;
} {
  const st = new Map(asks.map((q) => [q.id, { q, rows: [] as unknown[], bytes: 0, count: 0, big: false, more: undefined as boolean | undefined, error: undefined as string | undefined }]));
  // Any line that isn't the contract's stops the run as out of contract: what core does about a broken answer must not
  // depend on what the provider was reading when it broke.
  let tripped = false;
  let at: unknown;
  const onLine = (line: string): 'go' | 'stop' => {
    let v: Record<string, unknown>;
    try { v = JSON.parse(line); } catch { tripped = true; return 'stop'; }
    if (!v || typeof v !== 'object' || Array.isArray(v)) { tripped = true; return 'stop'; }
    if (v.id === undefined && v.at !== undefined) {
      // Exactly `{"at": …}`, once.
      if (Object.keys(v).length !== 1 || at !== undefined) { tripped = true; return 'stop'; }
      at = v.at;
      return 'go';
    }
    const q = typeof v.id === 'string' ? st.get(v.id) : undefined;
    if (!q || q.more !== undefined || q.error !== undefined) { tripped = true; return 'stop'; }
    if (Object.hasOwn(v, 'row')) {
      const size = ++q.count > q.q.limit ? undefined : admit(q.q, v.row);
      if (size === undefined) { tripped = true; return 'stop'; }
      q.bytes += size;
      // Past its share: core's own too-big, from rows it admitted. The rest are still read, and checked.
      if (q.bytes > share) q.big = true;
      else q.rows.push(v.row);
      return 'go';
    }
    if (typeof v.more === 'boolean') { q.more = v.more; return 'go'; }
    if (v.error === 'too-big') { tripped = true; return 'stop'; }
    if (v.error === 'unavailable' || v.error === 'bad-query' || v.error === 'unsupported-version') { q.error = 'unavailable'; return 'go'; }
    tripped = true;
    return 'stop';
  };
  return {
    onLine,
    tripped: () => tripped,
    at: () => at,
    answers: () => new Map<string, ProviderAnswer>([...st].map(([id, x]) => [id, x.more === undefined && x.error === undefined ? { id, rows: [], more: false, error: 'unavailable' }
      : x.error ? { id, rows: [], more: false, error: x.error } : x.big ? { id, rows: [], more: false, error: 'too-big' } : { id, rows: x.rows as Record<string, unknown>[], more: x.more! }])),
  };
}

/** Expiry as the provider says it: ms since the epoch, or an ISO time. NaN when it's neither. */
function expiresAt(v: unknown): number {
  const t = typeof v === 'number' ? v : typeof v === 'string' && v.length <= 40 ? Date.parse(v) : Number.NaN;
  // A Date's own range: past it, a time can't be said (toISOString throws), so it's no time.
  return Number.isFinite(t) && Math.abs(t) <= 8.64e15 ? t : Number.NaN;
}

/**
 * Whose a row is: its audience and agent, if this viewer may have it. Undefined when it isn't a row core can place, or
 * one the viewer may not have (either takes the provider out of contract).
 */
export function admission(viewer: Viewer, decl: TypeDecl, raw: unknown): { audience: Audience; agent: string | undefined } | undefined {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined;
  const r = raw as Record<string, unknown>;
  const audience = parseAudience(r.audience);
  if (!audience) return undefined;
  let agent: string | undefined;
  if (decl.agent !== undefined) {
    const v = Object.hasOwn(r, decl.agent) ? r[decl.agent] : undefined;
    if (v !== undefined && v !== null && typeof v !== 'string') return undefined;
    agent = typeof v === 'string' ? v : undefined;
  }
  return admits(viewer, audience, agent, decl) ? { audience, agent } : undefined;
}

/** What checkAnswer answers when the provider answered a row it shouldn't have (see outOfContract). */
export const OUT_OF_CONTRACT = Symbol('out of contract');

/**
 * One provider answer checked for this viewer: every row admitted again, trimmed, and its counts gated. A row the
 * viewer may not have, or one that isn't a row, makes the answer OUT_OF_CONTRACT; a row that expired since the
 * provider read it (it was the viewer's) is only left out.
 */
export interface Collected { admitted: Record<string, unknown>[]; last?: Record<string, unknown> }

export function checkAnswer(viewer: Viewer, p: Provider, q: Query, a: ProviderAnswer, share: number, now: number, seal: (cursor: string) => string, collect?: Collected): ClientAnswer | QueryError | typeof OUT_OF_CONTRACT {
  if (a.error) return { id: q.id, error: a.error as QueryError['error'] } as QueryError;
  const decl = p.types[q.type];
  // More rows than asked (the page and one past it): how many it sent may count rows the viewer can't have. And its own
  // `more` must agree with what it sent: one that paged before it filtered says there's more beside a short page, and
  // a short page taken as the end would tell the viewer hidden records matched.
  if (a.rows.length > q.limit + 1 || (a.more && a.rows.length !== q.limit + 1)) return OUT_OF_CONTRACT;
  const seen = new Set<string>();
  const rows: Record<string, unknown>[] = [];
  // A row of the viewer's that core can't send (a bad id, a repeat, an expiry that isn't a time, too big) fails this
  // answer alone: it was theirs, so saying so tells them nothing hidden.
  let unusable: 'unavailable' | 'too-big' | undefined;
  for (const [index, raw] of (a.rows as unknown[]).entries()) {
    // Whose a row is comes first: one core can't place, or one this viewer may not have, takes the provider out of
    // contract, since anything else core did about it would show the viewer a hidden record.
    const placed = admission(viewer, decl, raw);
    if (!placed) return OUT_OF_CONTRACT;
    const r = raw as Record<string, unknown>;
    const { audience } = placed;
    // The row past the page: checked like the rest, never sent.
    if (index >= q.limit) { if (typeof r.id !== 'string' || !RECORD_ID.test(r.id)) unusable ??= 'unavailable'; continue; }
    if (typeof r.id !== 'string' || !RECORD_ID.test(r.id) || seen.has(r.id)) { unusable ??= 'unavailable'; continue; }
    seen.add(r.id);
    let expires: number | undefined;
    if (r.expires !== undefined) {
      expires = expiresAt(r.expires);
      if (!Number.isFinite(expires)) { unusable ??= 'unavailable'; continue; }
      // Expired since the provider read it: the viewer's own row, so leaving it out tells them nothing hidden.
      if (expires <= now) continue;
    }
    const out: Record<string, unknown> = { key: `${p.name}/${q.type}/${r.id}` };
    for (const f of q.fields) {
      if (f === 'audience') out.audience = audience;
      else if (Object.hasOwn(r, f)) out[f] = r[f];
    }
    if (expires !== undefined) out.expires = new Date(expires).toISOString();
    if (Buffer.byteLength(JSON.stringify(out)) > RECORD_MAX_BYTES) { unusable = 'too-big'; continue; }
    rows.push(out);
    collect?.admitted.push(r);
  }
  if (unusable) return { id: q.id, error: unusable };
  // The row past the page, if the provider had one (and it's the viewer's: checked above with the rest), says there's
  // more; it isn't sent. The cursor is core's own: the last sent row's order key, sealed.
  const more = a.rows.length > q.limit;
  const lastSent = more ? (a.rows[q.limit - 1] as Record<string, unknown>) : undefined;
  if (collect && lastSent) collect.last = lastSent;
  const complete = !more && q.after === null;
  // A provider's numbers can't be rechecked, and a careless one's would count records the viewer can't open (another
  // member's own, for a household owner too) and name their values in a `by`. So until the conformance run can vouch
  // for a provider's counts (t-2026), none are passed on, to anyone: a complete answer core counts itself (every row in
  // it passed core's checks); a partial one has no total ("20", not "20 of …").
  const coverage: ClientAnswer['coverage'] = { complete };
  if (complete) coverage.total = { n: rows.length, exact: true };
  let aggregates: ClientAnswer['aggregates'];
  for (const name of q.aggregates) {
    if (complete && !decl.aggregates?.[name]?.by) (aggregates ??= {})[name] = { n: rows.length, exact: true };
  }
  let next: string | null = null;
  if (lastSent) {
    const key = JSON.stringify([...q.order.map(([f]) => lastSent[f] ?? null), lastSent.id]);
    // An order key too long to carry: the page ends here (partial, no next), rather than a cursor it can't keep.
    if (key.length <= MAX_PROVIDER_CURSOR) next = seal(key);
  }
  const answer: ClientAnswer = { id: q.id, rows, next, coverage, ...(aggregates ? { aggregates } : {}), withheld: q.withheld };
  if (Buffer.byteLength(JSON.stringify(answer)) > share) return { id: q.id, error: 'too-big' };
  return answer;
}
