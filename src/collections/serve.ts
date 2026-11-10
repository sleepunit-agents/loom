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
import { managedPieces } from '../cli/pieces-managed.js';
import { runOffer } from '../offers-registry.js';
import { Pool, type ApiCaller } from '../ui/pieces.js';
import { CORE_PROVIDER, RECORD_ID, providerName, type CollectionsOffer, type TypeDecl } from './contract.js';
import { CORE_TYPES, coreAnswers } from './core-types.js';
import type { ProviderAnswer, ProviderQuery } from './memory.js';
import { checkQuery, MAX_PROVIDER_CURSOR, MAX_QUERIES, queryShape, sealerFor, typeRef, validQueryId, type Query, type QueryError, type QueryIn } from './query.js';
import { admits, classesOf, isHouseholdOwner, parseAudience, presented, providerAdmits, viewerId, type Viewer } from './viewer.js';

/** Where a batch is asked: POST /collections/query (the page) and POST /api/loom/<this> (tokens). */
export const COLLECTIONS_QUERY_ROUTE = 'collections/query';
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
}

/** Core and every installed piece publishing collections, by provider name, from their installed declarations. */
export function providers(env: NodeJS.ProcessEnv): Map<string, Provider> {
  const out = new Map<string, Provider>([[CORE_PROVIDER, { name: CORE_PROVIDER, owners2: true, types: CORE_TYPES }]]);
  for (const r of managedPieces(env)) {
    const c: CollectionsOffer | undefined = r.loom.collections;
    if (!c) continue;
    const name = providerName(r);
    // Install refuses a taken name; were two ever present (piece.json edited by hand), neither is served.
    if (out.has(name)) { out.delete(name); continue; }
    out.set(name, { name, piece: r.name, owners2: c.owners === 2, types: c.types, query: c.query, install: `${r.name}@${r.installed}` });
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
}

export type BatchResult = { status: 200; body: { answers: Array<ClientAnswer | QueryError> } } | { status: 400; body: { error: string } };

export interface ServeContext {
  env: NodeJS.ProcessEnv;
  household: Household;
  now?: number;
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

  await Promise.all([...byProvider].map(async ([name, list]) => {
    const p = all.get(name)!;
    const share = Math.floor(ANSWER_MAX_BYTES / list.length);
    const asks: ProviderQuery[] = list.map((q) => ({ id: q.id, type: q.type, version: q.major, where: q.where, order: q.order, limit: q.limit, after: q.after,
      // The agent field too: core's agent rule reads it. It's dropped again unless asked for.
      fields: [...new Set([...q.fields.filter((f) => f !== 'audience'), ...(p.types[q.type].agent ? [p.types[q.type].agent!] : [])])], aggregates: q.aggregates }));
    const broken = () => p.install !== undefined && outOfContract.has(p.install);
    const got = broken() ? 'out of contract' : await runProvider(ctx, p, viewer, asks, share, now);
    const checked = list.map((q) => {
      const a = typeof got === 'string' ? undefined : got.get(q.id);
      if (!a) return { id: q.id, error: 'unavailable' } as QueryError;
      return checkAnswer(viewer, p, q, a, share, now, (c) => sealer.seal(c, vid, queryShape({ provider: q.provider, type: q.type, major: q.major }, q.where, q.order), now));
    });
    // One row out of contract makes the whole run's answers unavailable, not just its own query's: the batch's other
    // answers came from the same provider, deciding for the same viewer.
    const bad = checked.some((a) => a === OUT_OF_CONTRACT);
    if (bad && p.install !== undefined && !broken()) {
      outOfContract.add(p.install);
      process.stderr.write(`loom: collections provider ${p.name} (${p.piece}) answered a row its viewer may not have; it answers no one until it's reinstalled or loom restarts\n`);
    }
    list.forEach((q, i) => answers.set(q.id, bad || checked[i] === OUT_OF_CONTRACT ? { id: q.id, error: 'unavailable' } : checked[i] as ClientAnswer | QueryError));
  }));
  return { status: 200, body: { answers: (qs as QueryIn[]).map((q) => answers.get(q.id)!) } };
}

/** One provider's answers to its share of the batch, by query id; a string when it failed as a whole. */
async function runProvider(ctx: ServeContext, p: Provider, viewer: Viewer, asks: ProviderQuery[], share: number, now: number): Promise<Map<string, ProviderAnswer> | string> {
  if (!p.piece) return new Map(coreAnswers(ctx.household, viewer, asks, now).map((a) => [a.id, a]));
  const piece = p.piece;
  // The scope a page's piece gets (owners.md), and never one inherited from loom's own environment.
  const { LOOM_SCOPE: _s, LOOM_OWNER_SCOPE: _o, ...env0 } = ctx.env;
  const env: NodeJS.ProcessEnv = viewer.kind === 'member' && !viewer.household ? { ...env0, LOOM_OWNER_SCOPE: viewer.agents.join(',') } : env0;
  const stdin = JSON.stringify({ viewer: presented(viewer), now: new Date(now).toISOString(), share, queries: asks });
  const r = await poolOf(p.name).run(() => runOffer(env, piece, p.query!, { kind: 'collections', stdin, caller: callerOf(viewer), parse: parseProviderAnswers }));
  if (r === null) return 'busy';
  if (!r.ok) {
    process.stderr.write(`loom: collections provider ${p.name} (${piece}) failed: ${r.error}\n`);
    return r.error;
  }
  return new Map(r.value.map((a) => [a.id, a]));
}

const PROVIDER_ERRORS = ['too-big', 'bad-query', 'unsupported-version', 'unavailable'];

/** A provider's answer, in shape only (core checks every row of it against the viewer after). */
export function parseProviderAnswers(v: unknown): ProviderAnswer[] | string {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return 'not a JSON object';
  const answers = (v as { answers?: unknown }).answers;
  if (!Array.isArray(answers)) return 'answers is a list';
  const out: ProviderAnswer[] = [];
  for (const a of answers) {
    if (!a || typeof a !== 'object' || Array.isArray(a) || typeof a.id !== 'string') return 'an answer is {id, rows, next, …}';
    if (a.error !== undefined) {
      if (!PROVIDER_ERRORS.includes(a.error)) return `an answer's error is one of ${PROVIDER_ERRORS.join(', ')}`;
      out.push({ id: a.id, rows: [], next: null, error: a.error });
      continue;
    }
    if (!Array.isArray(a.rows)) return 'an answer\'s rows is a list';
    if (a.next !== null && (typeof a.next !== 'string' || !a.next.length || a.next.length > MAX_PROVIDER_CURSOR)) return `an answer's next is null or a cursor of at most ${MAX_PROVIDER_CURSOR} characters`;
    out.push({ id: a.id, rows: a.rows, next: a.next, ...(a.total !== undefined ? { total: a.total } : {}), ...(a.aggregates !== undefined ? { aggregates: a.aggregates } : {}) });
  }
  return out;
}

const count = (v: unknown): v is { n: number; exact: boolean } => !!v && typeof v === 'object' && Number.isInteger((v as { n: unknown }).n) && (v as { n: number }).n >= 0 && typeof (v as { exact: unknown }).exact === 'boolean';

/** Expiry as the provider says it: ms since the epoch, or an ISO time. NaN when it's neither. */
function expiresAt(v: unknown): number {
  const t = typeof v === 'number' ? v : typeof v === 'string' && v.length <= 40 ? Date.parse(v) : Number.NaN;
  // A Date's own range: past it, a time can't be said (toISOString throws), so it's no time.
  return Number.isFinite(t) && Math.abs(t) <= 8.64e15 ? t : Number.NaN;
}

/** What checkAnswer answers when the provider answered a row it shouldn't have (see outOfContract). */
export const OUT_OF_CONTRACT = Symbol('out of contract');

/**
 * One provider answer checked for this viewer: every row admitted again, trimmed, and its counts gated. A row the
 * viewer may not have, or one that isn't a row, makes the answer OUT_OF_CONTRACT; a row that expired since the
 * provider read it (it was the viewer's) is only left out.
 */
export function checkAnswer(viewer: Viewer, p: Provider, q: Query, a: ProviderAnswer, share: number, now: number, seal: (cursor: string) => string): ClientAnswer | QueryError | typeof OUT_OF_CONTRACT {
  if (a.error) return { id: q.id, error: a.error as QueryError['error'] } as QueryError;
  const decl = p.types[q.type];
  // A provider that ignores the page size broke the contract: how many it sent may count rows the viewer can't have.
  if (a.rows.length > q.limit) return OUT_OF_CONTRACT;
  const seen = new Set<string>();
  const rows: Record<string, unknown>[] = [];
  // A row left out (it expired since the provider read it) isn't in the provider's numbers' view of things: its
  // counts go too.
  let dropped = false;
  for (const raw of a.rows as unknown[]) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return OUT_OF_CONTRACT;
    const r = raw as Record<string, unknown>;
    if (typeof r.id !== 'string' || !RECORD_ID.test(r.id) || seen.has(r.id)) return OUT_OF_CONTRACT;
    const audience = parseAudience(r.audience);
    if (!audience) return OUT_OF_CONTRACT;
    let agent: string | undefined;
    if (decl.agent !== undefined) {
      const v = Object.hasOwn(r, decl.agent) ? r[decl.agent] : undefined;
      if (v !== undefined && v !== null && typeof v !== 'string') return OUT_OF_CONTRACT;
      agent = typeof v === 'string' ? v : undefined;
    }
    if (!admits(viewer, audience, agent, decl)) return OUT_OF_CONTRACT;
    let expires: number | undefined;
    if (r.expires !== undefined) {
      expires = expiresAt(r.expires);
      if (!Number.isFinite(expires)) return OUT_OF_CONTRACT;
      // Expired since the provider read it: the viewer's own row, so leaving it out tells them nothing hidden.
      if (expires <= now) { dropped = true; continue; }
    }
    const out: Record<string, unknown> = { key: `${p.name}/${q.type}/${r.id}` };
    for (const f of q.fields) {
      if (f === 'audience') out.audience = audience;
      else if (Object.hasOwn(r, f)) out[f] = r[f];
    }
    if (expires !== undefined) out.expires = new Date(expires).toISOString();
    if (Buffer.byteLength(JSON.stringify(out)) > RECORD_MAX_BYTES) return { id: q.id, error: 'too-big' };
    seen.add(r.id);
    rows.push(out);
  }
  const complete = a.next === null && q.after === null;
  // A provider's numbers can't be rechecked, so only household owners get them unless the type passed the per-viewer
  // count fixtures. A complete answer core counts itself: every row in it passed core's checks.
  // `scoped_counts` isn't honoured yet, whatever an installed record says: install refuses it until the conformance run
  // exists (t-2026), and a record from before that, or edited by hand, mustn't widen who gets numbers.
  const counts = isHouseholdOwner(viewer) && !dropped;
  const coverage: ClientAnswer['coverage'] = { complete };
  if (complete) coverage.total = { n: rows.length, exact: true };
  else if (counts && count(a.total)) coverage.total = { n: a.total.n, exact: a.total.exact };
  let aggregates: ClientAnswer['aggregates'];
  for (const name of q.aggregates) {
    const given = a.aggregates && typeof a.aggregates === 'object' ? (a.aggregates as Record<string, unknown>)[name] : undefined;
    const by = decl.aggregates?.[name]?.by;
    let v: NonNullable<ClientAnswer['aggregates']>[string] | undefined;
    if (counts && count(given)) {
      const b = (given as { by?: unknown }).by;
      const byOk = b === undefined || (!!b && typeof b === 'object' && !Array.isArray(b) && Object.keys(b).length <= 1000 && Object.values(b).every((n) => Number.isInteger(n) && (n as number) >= 0));
      if (byOk) v = { n: (given as { n: number }).n, exact: (given as { exact: boolean }).exact, ...(by && b ? { by: { ...(b as Record<string, number>) } } : {}) };
    } else if (complete && !by) v = { n: rows.length, exact: true };
    if (v) (aggregates ??= {})[name] = v;
  }
  let next: string | null = null;
  if (a.next !== null) next = seal(a.next);
  const answer: ClientAnswer = { id: q.id, rows, next, coverage, ...(aggregates ? { aggregates } : {}), withheld: q.withheld };
  if (Buffer.byteLength(JSON.stringify(answer)) > share) return { id: q.id, error: 'too-big' };
  return answer;
}
