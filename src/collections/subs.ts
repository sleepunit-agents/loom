/**
 * Subscriptions: core to window (docs/specs/collections.md, "Core to window").
 *
 * A window's one stream (GET /events) says `hello` with its id; a query naming that stream and `subscribe: true`
 * becomes a subscription on it. From then on, core sends that subscription the changes in its domain's log that
 * concern it, as `rows` frames, each with the stream's next `seq`, never a provider revision:
 *
 *  - **Handover without a gap.** The provider's answer says the {rev, txn} it read at. Core pulls until its log has
 *    reached that revision and checks the log holds that transaction there (else the store's history changed: a new
 *    epoch, and the query is asked again). The subscription then reads the log from exactly there, and the answer's
 *    `at` is the stream seq its frames follow.
 *  - **Delivered keys.** Core keeps, per subscription, the keys it has sent. A change sends a leave only where the key
 *    was delivered, and an upsert only where the record now belongs (its audience and the agent rule admit the
 *    viewer, it matches the filter, it's inside the window). Nobody else learns the key.
 *  - **The window**: what matches the filter and sorts no later than the last row loaded (the boundary), at most
 *    MAX_WINDOW records; past that the tail leaves and the subscription is partial.
 *  - **The viewer is checked again before every pass**: a session gone closes the stream; anything the viewer's
 *    authority rests on changed (their agents) bumps the stream's scope epoch and resets every subscription on it.
 *  - **Resets**: `gap` (the log no longer holds what the subscription needs, or the window is too far behind),
 *    `epoch` (the provider's history changed), `provider-gone`, `scope`.
 *
 * Subscriptions live in one listener's memory: a reconnect is a new snapshot.
 */
import { watch, type FSWatcher } from 'node:fs';
import { join } from 'node:path';
import type { Household } from '../household.js';
import { onBump } from '../comms.js';
import type { TypeDecl } from './contract.js';
import { compare, matches, type ProviderAnswer } from './memory.js';
import { domainHead, domainOf, domainRow, nudgedSince, prunedThrough, resetEpoch, rowsAfter, txnAt, withLog, type LogRow } from './log.js';
import { domainOfType, domainsOf, Puller, sourceOf } from './pull.js';
import type { Query } from './query.js';
import { admits, isHouseholdOwner, parseAudience, providerAdmits, viewerId, type Viewer } from './viewer.js';
import { providers, type Provider } from './serve.js';

export const MAX_SUBS = 64;
export const MAX_WINDOW = 1000;
/** Frames a window may fall behind before its biggest subscriptions are reset rather than sent more. */
export const MAX_BEHIND = 256;
const PASS_MS = 2_000;
const AGG_GAP_MS = 1_500;

/** What a subscription's stream is to this module: live.ts's stream, seen through what it needs. */
export interface StreamPort {
  id: string;
  session: string;
  /** The viewer now, read again (null: the session is gone). */
  viewer: () => Viewer | null;
  /** Send a frame (its seq assigned here, next on the stream); answers the seq. */
  frame: (event: string, data: Record<string, unknown>) => number;
  /** The seq last sent. */
  seq: () => number;
  /** Frames written and not yet drained. */
  behind: () => number;
  close: () => void;
}

type Aggs = Record<string, { n: number; exact: boolean; by?: Record<string, number> }>;

interface Sub {
  id: string;
  provider: string;
  type: string;
  domain: string;
  decl: TypeDecl;
  query: Query;
  epoch: string;
  /** The last log row this subscription has taken in. */
  cursor: number;
  /** key → its order key, for every record delivered. */
  delivered: Map<string, unknown[]>;
  /** key → its by-values, per aggregate core counts itself. */
  byVals: Map<string, Record<string, string>>;
  boundary: unknown[] | null;
  partial: boolean;
  /** Who counts: core (a complete subscription), the provider (asked again; household owners only), or nobody. */
  aggMode: 'core' | 'provider' | 'none';
  aggs?: Aggs;
  /** A provider count being asked again: the frame waits for it, so rows and counts arrive together. */
  waiting?: boolean;
  frame: Frame;
  /** Asking its provider again, as it was asked (serve.ts): its own, never another request's. */
  reask: Reask;
}

interface Frame { upserts: Map<string, Record<string, unknown>>; leaves: Set<string>; deletes: Set<string>; moved: boolean }
const emptyFrame = (): Frame => ({ upserts: new Map(), leaves: new Set(), deletes: new Set(), moved: false });

interface Stream { port: StreamPort; viewer: Viewer; vid: string; scope: number; subs: Map<string, Sub> }

/**
 * Asking a provider again for a subscription, as its viewer, through serve.ts's checks: for a count it can't keep
 * itself, or a type whose audience the provider decides per viewer. Undefined when the provider didn't answer.
 */
export type Reask = (viewer: Viewer, p: Provider, q: Query) => Promise<{ rows: Record<string, unknown>[]; admitted: Record<string, unknown>[]; aggregates?: Aggs } | undefined>;

interface HomeState {
  household: () => Household;
  env: () => NodeJS.ProcessEnv;
  streams: Map<string, Stream>;
  puller: Puller;
  watcher?: FSWatcher;
  poll?: NodeJS.Timeout;
  nudgeSeen: number;
  passing: Promise<void> | undefined;
  again: boolean;
  offBump?: () => void;
}

const homes = new Map<string, HomeState>();

const orderKey = (record: Record<string, unknown>, id: string, q: Query): unknown[] => [...q.order.map(([f]) => record[f] ?? null), id];
function cmpKeys(a: unknown[], b: unknown[], q: Query): number {
  for (let i = 0; i < a.length; i++) {
    const c = compare(a[i], b[i]);
    if (c) return i < q.order.length && q.order[i][1] === 'desc' ? -c : c;
  }
  return 0;
}

function homeOf(household: () => Household, env: () => NodeJS.ProcessEnv): HomeState {
  const home = household().home;
  let h = homes.get(home);
  if (h) return h;
  const state: HomeState = {
    household, env, streams: new Map(), nudgeSeen: Date.now(), passing: undefined, again: false,
    puller: new Puller(() => ({ env: env(), household: household() }), () => wantedOf(state)),
  };
  h = state;
  homes.set(home, h);
  return h;
}

function wantedOf(h: HomeState): Set<string> {
  const out = new Set<string>();
  for (const s of h.streams.values()) for (const sub of s.subs.values()) out.add(sub.domain);
  return out;
}

function ensureRunning(h: HomeState): void {
  const home = h.household().home;
  h.puller.start();
  if (!h.watcher) {
    try {
      h.watcher = watch(join(home, 'collections'), (_e, f) => { if (String(f) === 'collections.tick') pass(h); });
      h.watcher.unref?.();
    } catch { /* the poll still runs */ }
  }
  h.poll ??= setInterval(() => pass(h), PASS_MS);
  h.poll.unref?.();
  // Core's own threads move through comms.ts: their domain is pulled when they do.
  h.offBump ??= onBump(() => h.puller.soon('loom/thread'));
}

function stopIfIdle(h: HomeState): void {
  if (h.streams.size) return;
  h.puller.stop();
  h.watcher?.close(); h.watcher = undefined;
  clearInterval(h.poll); h.poll = undefined;
  h.offBump?.(); h.offBump = undefined;
  homes.delete(h.household().home);
}

/** A stream opened (live.ts): known here from its hello on. */
export function openStream(household: () => Household, env: () => NodeJS.ProcessEnv, port: StreamPort, viewer: Viewer): void {
  const h = homeOf(household, env);
  h.streams.set(port.id, { port, viewer, vid: viewerId(viewer), scope: 1, subs: new Map() });
}

/** A stream closed: its subscriptions go with it. */
export function closeStream(home: string, id: string): void {
  const h = homes.get(home);
  if (!h) return;
  h.streams.delete(id);
  stopIfIdle(h);
}

/** A stream's scope epoch (for an answer), or undefined when it isn't this session's open stream here. */
export function streamFor(home: string, id: unknown, session: string): { scope: number; seq: number } | undefined {
  if (typeof id !== 'string') return undefined;
  const s = homes.get(home)?.streams.get(id);
  return s && s.port.session === session ? { scope: s.scope, seq: s.port.seq() } : undefined;
}

/** Drop subscriptions by id (a window that no longer shows them). */
export function unsubscribe(home: string, stream: string, session: string, ids: readonly string[]): void {
  const s = homes.get(home)?.streams.get(stream);
  if (!s || s.port.session !== session) return;
  for (const id of ids) s.subs.delete(id);
}

/** Before a subscribed query's provider runs: the domain exists in the log, and pulled once (a first pull's start). */
export async function prepare(household: () => Household, env: () => NodeJS.ProcessEnv, p: Provider, type: string): Promise<{ startSeq: number }> {
  const h = homeOf(household, env);
  const domain = domainOfType(p, type);
  const home = h.household().home;
  const row = withLog(home, (db) => domainOf(db, domain, sourceOf(h.env(), p)).row);
  if (p.piece && p.changes && row.mode === 'log' && row.rev === null) await h.puller.now(domain);
  return { startSeq: withLog(home, (db) => domainHead(db, domain)) };
}

export type Attach = { at: number; scope: number } | { retry: true } | { error: 'unavailable' | 'bad-query'; why?: string };

/**
 * A subscribed query answered: hand it over to the log and start its subscription. `admitted` are the provider's
 * rows core let through (whole, with the order and by fields), `last` the provider's last row (where its page ended),
 * `at` the {rev, txn} it read at. A log-less domain (core's, a bridged one) starts at `startSeq`, taken before the
 * provider ran.
 */
export async function attach(household: () => Household, env: () => NodeJS.ProcessEnv, port: { stream: string; session: string }, viewer: Viewer, p: Provider, q: Query,
  answer: { next: string | null; aggregates?: Aggs; complete: boolean }, admitted: Record<string, unknown>[], last: Record<string, unknown> | undefined,
  at: { rev: number; txn: string } | undefined, startSeq: number, reask: Reask): Promise<Attach> {
  const h = homeOf(household, env);
  const s = h.streams.get(port.stream);
  if (!s || s.port.session !== port.session) return { error: 'bad-query', why: 'stream isn\'t one of this session\'s open streams' };
  if (viewerId(viewer) !== s.vid) return { error: 'bad-query', why: 'stream is another viewer\'s' };
  const home = h.household().home;
  const domain = domainOfType(p, q.type);
  let row = withLog(home, (db) => domainRow(db, domain));
  if (!row) return { error: 'unavailable' };
  let cursor = startSeq;
  if (p.piece && p.changes && row.mode === 'log') {
    if (!at) return { error: 'unavailable', why: 'the provider didn\'t say what it read at' };
    for (let tries = 0; ; tries++) {
      row = withLog(home, (db) => domainRow(db, domain));
      if (!row) return { error: 'unavailable' };
      if (row.rev === null || row.rev < at.rev) {
        if (tries >= 3) return { error: 'unavailable', why: 'the log couldn\'t reach the provider\'s answer' };
        await h.puller.now(domain);
        continue;
      }
      if (row.rev === at.rev) {
        if (row.txn !== at.txn) { withLog(home, (db) => resetEpoch(db, domain, row!.epoch)); return { retry: true }; }
        cursor = withLog(home, (db) => domainHead(db, domain));
        break;
      }
      const t = withLog(home, (db) => txnAt(db, domain, row!.epoch, at.rev));
      if (!t) return { retry: true };
      if (t.txn !== at.txn) { withLog(home, (db) => resetEpoch(db, domain, row!.epoch)); return { retry: true }; }
      cursor = t.seq;
      break;
    }
  }
  const existing = s.subs.get(q.id);
  const id = (r: Record<string, unknown>) => r.id as string;
  const byOf = (r: Record<string, unknown>): Record<string, string> => {
    const out: Record<string, string> = {};
    for (const a of q.aggregates) out[a] = (p.types[q.type].aggregates?.[a]?.by ?? []).map((f) => String(r[f] ?? '')).join('/');
    return out;
  };
  // The same id with `after` extends the subscription's window: its keys join, its boundary moves on.
  if (existing && q.after !== null) {
    for (const r of admitted) { existing.delivered.set(`${p.name}/${q.type}/${id(r)}`, orderKey(r, id(r), q)); existing.byVals.set(`${p.name}/${q.type}/${id(r)}`, byOf(r)); }
    existing.boundary = answer.next === null ? null : last ? orderKey(last, id(last), q) : existing.boundary;
    trim(existing);
    return { at: s.port.seq(), scope: s.scope };
  }
  if (!existing && s.subs.size >= MAX_SUBS) return { error: 'bad-query', why: `a stream holds at most ${MAX_SUBS} subscriptions` };
  const decl = p.types[q.type];
  const anyBy = q.aggregates.some((a) => decl.aggregates?.[a]?.by);
  const sub: Sub = {
    id: q.id, provider: p.name, type: q.type, domain, decl, query: q, epoch: row.epoch, cursor,
    delivered: new Map(admitted.map((r) => [`${p.name}/${q.type}/${id(r)}`, orderKey(r, id(r), q)])),
    byVals: new Map(admitted.map((r) => [`${p.name}/${q.type}/${id(r)}`, byOf(r)])),
    boundary: answer.next === null ? null : last ? orderKey(last, id(last), q) : null,
    partial: !answer.complete,
    aggMode: !q.aggregates.length ? 'none' : answer.complete && (!anyBy || q.aggregates.every((a) => !decl.aggregates?.[a]?.by || decl.aggregates[a].by!.every((f) => classesVisible(viewer, decl, f))))
      ? 'core' : answer.aggregates && isHouseholdOwner(viewer) ? 'provider' : 'none',
    aggs: answer.aggregates, frame: emptyFrame(), reask,
  };
  if (sub.aggMode === 'core') sub.aggs = coreAggs(sub);
  s.subs.set(q.id, sub);
  ensureRunning(h);
  const result = { at: s.port.seq(), scope: s.scope };
  // Anything already in the log past the handover is this subscription's first frames, after `at`.
  queueMicrotask(() => pass(h));
  return result;
}

const classesVisible = (viewer: Viewer, decl: TypeDecl, f: string): boolean => isHouseholdOwner(viewer) || decl.fields[f]?.class !== 'owner';

/** Counts core makes itself over a complete subscription: every key in it passed core's checks. */
function coreAggs(sub: Sub): Aggs {
  const out: Aggs = {};
  for (const a of sub.query.aggregates) {
    const by = sub.decl.aggregates?.[a]?.by;
    if (!by) { out[a] = { n: sub.delivered.size, exact: true }; continue; }
    const counted: Record<string, number> = {};
    for (const key of sub.delivered.keys()) { const v = sub.byVals.get(key)?.[a] ?? ''; counted[v] = (counted[v] ?? 0) + 1; }
    out[a] = { n: sub.delivered.size, exact: true, by: counted };
  }
  return out;
}

/** The window over MAX_WINDOW records: the tail past the first MAX_WINDOW leaves, and the subscription is partial. */
function trim(sub: Sub): void {
  if (sub.delivered.size <= MAX_WINDOW) return;
  const sorted = [...sub.delivered].sort((a, b) => cmpKeys(a[1], b[1], sub.query));
  for (const [key] of sorted.slice(MAX_WINDOW)) { sub.delivered.delete(key); sub.byVals.delete(key); sub.frame.upserts.delete(key); sub.frame.leaves.add(key); sub.frame.moved = true; }
  sub.boundary = sorted[MAX_WINDOW - 1][1];
  sub.partial = true;
  if (sub.aggMode === 'core') sub.aggMode = 'none', sub.aggs = undefined;
}

/** A record trimmed for one subscription: its fields as asked, as the viewer's class allows (query.ts decided which). */
function trimmed(sub: Sub, key: string, record: Record<string, unknown>, audience: unknown, expires: number | null): Record<string, unknown> {
  const out: Record<string, unknown> = { key };
  for (const f of sub.query.fields) {
    if (f === 'audience') out.audience = audience;
    else if (Object.hasOwn(record, f)) out[f] = record[f];
  }
  if (expires !== null) out.expires = new Date(expires).toISOString();
  return out;
}

/** One log row, for one subscription and its viewer. */
function apply(sub: Sub, viewer: Viewer, r: LogRow, now: number): void {
  const prefix = `${sub.provider}/${sub.type}/`;
  if (!r.key.startsWith(prefix)) return;
  const id = r.key.slice(prefix.length);
  sub.frame.moved = true;
  if (r.op === 'delete') {
    if (sub.delivered.has(r.key)) { sub.delivered.delete(r.key); sub.byVals.delete(r.key); sub.frame.upserts.delete(r.key); sub.frame.leaves.delete(r.key); sub.frame.deletes.add(r.key); }
    return;
  }
  let record: Record<string, unknown> = {};
  let audience;
  try { record = JSON.parse(r.record ?? '{}'); audience = parseAudience(JSON.parse(r.audience ?? 'null')); } catch { audience = undefined; }
  const expired = r.expires !== null && r.expires <= now;
  const okey = orderKey(record, id, sub.query);
  const belongs = !!audience && !expired && admits(viewer, audience, r.agent ?? undefined, sub.decl) && matches(record, sub.query.where)
    && (sub.boundary === null || cmpKeys(okey, sub.boundary, sub.query) <= 0);
  if (belongs) {
    sub.delivered.set(r.key, okey);
    const by: Record<string, string> = {};
    for (const a of sub.query.aggregates) by[a] = (sub.decl.aggregates?.[a]?.by ?? []).map((f) => String(record[f] ?? '')).join('/');
    sub.byVals.set(r.key, by);
    sub.frame.leaves.delete(r.key);
    sub.frame.upserts.set(r.key, trimmed(sub, r.key, record, isHouseholdOwner(viewer) ? audience : undefined, r.expires));
  } else if (sub.delivered.has(r.key)) {
    sub.delivered.delete(r.key); sub.byVals.delete(r.key);
    sub.frame.upserts.delete(r.key);
    sub.frame.leaves.add(r.key);
  }
}

function reset(s: Stream, sub: Sub, reason: 'gap' | 'scope' | 'provider-gone' | 'epoch' | 'version'): void {
  s.subs.delete(sub.id);
  s.port.frame('reset', { sub: sub.id, reason });
}

function send(s: Stream, sub: Sub): void {
  const f = sub.frame;
  if (!f.upserts.size && !f.leaves.size && !f.deletes.size && !(f.moved && sub.aggMode !== 'none')) { sub.frame = emptyFrame(); return; }
  if (sub.aggMode === 'core') sub.aggs = coreAggs(sub);
  s.port.frame('rows', {
    sub: sub.id, scope: s.scope,
    ...(f.upserts.size ? { upserts: [...f.upserts.values()] } : {}),
    ...(f.leaves.size ? { leaves: [...f.leaves] } : {}),
    ...(f.deletes.size ? { deletes: [...f.deletes] } : {}),
    ...(sub.aggMode !== 'none' && sub.aggs ? { aggregates: sub.aggs } : {}),
  });
  sub.frame = emptyFrame();
}

/** One delivery pass over this listener's streams: new log rows, the viewer checked again, frames out. */
function pass(h: HomeState): void {
  if (h.passing) { h.again = true; return; }
  h.passing = (async () => {
    try { await passOnce(h); } catch (e) { process.stderr.write(`loom: collections delivery failed: ${(e as Error).message}\n`); }
  })().finally(() => { h.passing = undefined; if (h.again) { h.again = false; pass(h); } });
}

async function passOnce(h: HomeState): Promise<void> {
  const home = h.household().home;
  const now = Date.now();
  // A nudge said a domain moved: pull it soon, if a subscription here reads it.
  const nudged = withLog(home, (db) => nudgedSince(db, h.nudgeSeen));
  if (nudged.length) {
    h.nudgeSeen = Math.max(h.nudgeSeen, ...nudged.map((n) => n.nudged));
    const wanted = wantedOf(h);
    for (const n of nudged) if (wanted.has(n.domain)) h.puller.soon(n.domain);
  }
  const installed = providers(h.env());
  for (const s of [...h.streams.values()]) {
    // The viewer, again, before anything is sent: gone is closed; changed is a new scope and every subscription resets.
    const v = s.port.viewer();
    if (!v) { s.port.close(); h.streams.delete(s.port.id); continue; }
    const vid = viewerId(v);
    if (vid !== s.vid) {
      s.scope++;
      s.viewer = v; s.vid = vid;
      for (const sub of [...s.subs.values()]) reset(s, sub, 'scope');
      continue;
    }
    for (const sub of [...s.subs.values()]) {
      const p = installed.get(sub.provider);
      if (!p || !Object.hasOwn(p.types, sub.type) || !domainsOf(p).has(sub.domain)) { reset(s, sub, 'provider-gone'); continue; }
      // The gates its answer passed, again: the provider still answers this viewer, and its declaration (field classes,
      // filters, audience mode) is the one the query was checked against. Only members' sessions subscribe, so there's
      // no grant to ask again.
      if (!providerAdmits(v, p.owners2)) { reset(s, sub, 'scope'); continue; }
      if (JSON.stringify(p.types[sub.type]) !== JSON.stringify(sub.decl)) { reset(s, sub, 'version'); continue; }
      const row = withLog(home, (db) => domainRow(db, sub.domain));
      if (!row || row.epoch !== sub.epoch) { reset(s, sub, 'epoch'); continue; }
      if (withLog(home, (db) => prunedThrough(db, sub.domain)) > sub.cursor) { reset(s, sub, 'gap'); continue; }
      const ask = sub.decl.audience === 'ask';
      let gone = false;
      for (let reads = 0; reads < 16 && !gone; reads++) {
        const rows = withLog(home, (db) => rowsAfter(db, sub.cursor));
        if (!rows.length) break;
        for (const r of rows) {
          sub.cursor = r.seq;
          if (r.domain !== sub.domain) continue;
          if (r.epoch !== sub.epoch) { reset(s, sub, 'epoch'); gone = true; break; }
          // A type whose audience the provider decides per viewer is never routed by audience: it's asked again.
          if (ask) sub.frame.moved = true;
          else apply(sub, v, r, now);
        }
      }
      if (gone || !s.subs.has(sub.id)) continue;
      trim(sub);
      if ((ask || sub.aggMode === 'provider') && sub.frame.moved) {
        if (!sub.waiting) reaskSoon(sub.reask, s, sub, v, p);
        continue;
      }
      send(s, sub);
    }
    // A window too far behind: its biggest subscriptions are reset rather than sent more.
    while (s.port.behind() > MAX_BEHIND && s.subs.size) {
      const biggest = [...s.subs.values()].sort((a, b) => b.delivered.size - a.delivered.size)[0];
      reset(s, biggest, 'gap');
    }
  }
}

/**
 * Ask the provider again for `sub` (at most once per AGG_GAP_MS), and send its frame when the answer is in, so rows and
 * the counts they move arrive together. For an `ask` type, the answer is the subscription's rows: what's in it is
 * upserted, what was delivered and isn't leaves. A provider that doesn't answer leaves counts off (never a stale number
 * presented as current) and an `ask` subscription reset.
 */
function reaskSoon(reask: Reask, s: Stream, sub: Sub, v: Viewer, p: Provider): void {
  sub.waiting = true;
  void (async () => {
    await new Promise((r) => setTimeout(r, AGG_GAP_MS));
    const got = await reask(v, p, sub.query).catch(() => undefined);
    sub.waiting = false;
    if (s.subs.get(sub.id) !== sub) return;
    if (sub.decl.audience === 'ask') {
      if (!got) { reset(s, sub, 'gap'); return; }
      const now = new Set<string>();
      got.admitted.forEach((r, i) => {
        const key = `${sub.provider}/${sub.type}/${r.id as string}`;
        now.add(key);
        sub.delivered.set(key, orderKey(r, r.id as string, sub.query));
        sub.frame.upserts.set(key, got.rows[i]);
      });
      for (const key of [...sub.delivered.keys()]) if (!now.has(key)) { sub.delivered.delete(key); sub.byVals.delete(key); sub.frame.leaves.add(key); }
    }
    if (sub.aggMode === 'provider') { if (got?.aggregates) sub.aggs = got.aggregates; else { sub.aggMode = 'none'; sub.aggs = undefined; } }
    sub.frame.moved = true;
    send(s, sub);
  })();
}

/** Run a delivery pass now and wait for it (tests). */
export async function deliverNow(home: string): Promise<void> {
  const h = homes.get(home);
  if (!h) return;
  pass(h);
  while (h.passing) await h.passing;
}

/** Pull a domain now, as this listener (tests, and a command's answer: t-2024). */
export function pullNow(home: string, domain: string): Promise<unknown> {
  const h = homes.get(home);
  return h ? h.puller.now(domain) : Promise.resolve(undefined);
}

/** For tests: forget every stream and stop. */
export function stopAll(): void {
  for (const h of homes.values()) { h.streams.clear(); stopIfIdle(h); }
}

/** For a provider's answer: the {rev, txn} it read the domain at, if it said. */
export function atOf(at: unknown, domain: string): { rev: number; txn: string } | undefined {
  if (!at || typeof at !== 'object' || Array.isArray(at)) return undefined;
  const v = (at as Record<string, unknown>)[domain] as { rev?: unknown; txn?: unknown } | undefined;
  return v && Number.isSafeInteger(v.rev) && typeof v.txn === 'string' ? { rev: v.rev as number, txn: v.txn } : undefined;
}

export type { ProviderAnswer };
