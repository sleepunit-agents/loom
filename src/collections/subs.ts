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
import { isOwnTick, onBump } from '../comms.js';
import type { TypeDecl } from './contract.js';
import { compare, matches, type ProviderAnswer } from './memory.js';
import { domainHead, domainOf, domainRow, nudgedSince, prunedThrough, resetEpoch, rowsAfter, txnAt, withLog, type LogRow } from './log.js';
import { domainOfType, domainsOf, nudge, Puller, sourceOf } from './pull.js';
import type { Query } from './query.js';
import { admits, isHouseholdOwner, parseAudience, providerAdmits, viewerId, type Viewer } from './viewer.js';
import { isOutOfContract as outOfContract, providers, type Provider } from './serve.js';

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
  aggMode: 'core' | 'none';
  aggs?: Aggs;
  /** A provider count being asked again: the frame waits for it, so rows and counts arrive together. */
  waiting?: boolean;
  frame: Frame;
  /** Asking its provider again, as it was asked (serve.ts): its own, never another request's. */
  reask: Reask;
  /**
   * Each delivered row as this subscription last sent it (trimmed): an upsert that changes nothing the viewer sees (a
   * hidden field moved, one they didn't ask for) isn't sent, so no frame says that something hidden changed.
   */
  sent: Map<string, string>;
  /** An `ask` type's re-ask that went unanswered: asked again on the next pass. */
  retry?: boolean;
  /** When it was last asked again (reaskSoon): the next waits out AGG_GAP_MS from then, never from the change. */
  askedAt?: number;
}

/**
 * A subscription's next frame. Only what changed for it is in it: a change in its domain that changed nothing it holds
 * or would show sends nothing at all, so no frame's timing says that something hidden moved.
 */
interface Frame { upserts: Map<string, Record<string, unknown>>; leaves: Set<string>; deletes: Set<string> }
const emptyFrame = (): Frame => ({ upserts: new Map(), leaves: new Set(), deletes: new Set() });

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
  /** comms.tick: a thread moved by another process (a reply the runtime posted to another listener, a CLI). */
  commsWatcher?: FSWatcher;
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

function homeOf(household: () => Household, env0: () => NodeJS.ProcessEnv): HomeState {
  const home = household().home;
  // Pulls and snapshots are core's, for every viewer: never in the scope a page's env carries for its member.
  const env = () => { const { LOOM_SCOPE: _s, LOOM_OWNER_SCOPE: _o, ...rest } = env0(); return rest; };
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
  // Core's own threads move through comms.ts: their domain is pulled when they do, here (onBump) and in any other
  // process (a reply the runtime posts through another listener, a CLI), by the tick file every write leaves (comms.ts
  // bump). A tick that still holds this process's own stamp is that bump's echo: one write, one pull.
  h.offBump ??= onBump(() => { void h.puller.soon('loom/thread'); });
  if (!h.commsWatcher) {
    try {
      h.commsWatcher = watch(home, (_e, f) => { if (String(f) === 'comms.tick' && !isOwnTick(home)) void h.puller.soon('loom/thread'); });
      h.commsWatcher.on('error', () => { h.commsWatcher?.close(); h.commsWatcher = undefined; });
      h.commsWatcher.unref?.();
    } catch { /* the poll still runs */ }
  }
}

function stopIfIdle(h: HomeState): void {
  if (h.streams.size) return;
  h.puller.stop();
  h.watcher?.close(); h.watcher = undefined;
  clearInterval(h.poll); h.poll = undefined;
  h.offBump?.(); h.offBump = undefined;
  h.commsWatcher?.close(); h.commsWatcher = undefined;
  homes.delete(h.household().home);
}

/** A stream opened (live.ts): known here from its hello on. */
export function openStream(household: () => Household, env: () => NodeJS.ProcessEnv, port: StreamPort, viewer: Viewer): void {
  const h = homeOf(household, env);
  h.streams.set(port.id, { port, viewer, vid: viewerId(viewer), scope: 1, subs: new Map() });
  // Every open stream is checked each pass, subscriptions or not: a session that ends closes its streams.
  ensureRunning(h);
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
    // The same subscription, read further: the same type and shape, in the same history.
    if (existing.type !== q.type || existing.provider !== p.name || JSON.stringify([existing.query.where, existing.query.order]) !== JSON.stringify([q.where, q.order])) return { error: 'bad-query', why: 'a later page names its own subscription\'s id and query' };
    if (existing.epoch !== row.epoch) { reset(s, existing, 'epoch'); return { error: 'unavailable' }; }
    for (const r of admitted) { const k = `${p.name}/${q.type}/${id(r)}`; existing.delivered.set(k, orderKey(r, id(r), q)); existing.byVals.set(k, byOf(r)); existing.sent.set(k, sentOf(existing, viewer, k, r)); }
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
      ? 'core' : 'none',
    aggs: answer.aggregates, frame: emptyFrame(), reask, sent: new Map(),
  };
  for (const r of admitted) sub.sent.set(`${p.name}/${q.type}/${id(r)}`, sentOf(sub, viewer, `${p.name}/${q.type}/${id(r)}`, r));
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
  for (const [key] of sorted.slice(MAX_WINDOW)) { sub.delivered.delete(key); sub.byVals.delete(key); sub.sent.delete(key); sub.frame.upserts.delete(key); sub.frame.leaves.add(key); }
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

/** A provider's row as this subscription would send it, as text (sub.sent). */
function sentOf(sub: Sub, viewer: Viewer, key: string, raw: Record<string, unknown>): string {
  const t = typeof raw.expires === 'number' ? raw.expires : typeof raw.expires === 'string' ? Date.parse(raw.expires) : Number.NaN;
  return JSON.stringify(trimmed(sub, key, raw, isHouseholdOwner(viewer) ? parseAudience(raw.audience) : undefined, Number.isFinite(t) ? t : null));
}

/** One log row, for one subscription and its viewer. */
function apply(sub: Sub, viewer: Viewer, r: LogRow, now: number): void {
  const prefix = `${sub.provider}/${sub.type}/`;
  if (!r.key.startsWith(prefix)) return;
  const id = r.key.slice(prefix.length);
  if (r.op === 'delete') {
    if (sub.delivered.has(r.key)) { sub.delivered.delete(r.key); sub.byVals.delete(r.key); sub.sent.delete(r.key); sub.frame.upserts.delete(r.key); sub.frame.leaves.delete(r.key); sub.frame.deletes.add(r.key); }
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
    const out = trimmed(sub, r.key, record, isHouseholdOwner(viewer) ? audience : undefined, r.expires);
    const text = JSON.stringify(out);
    if (sub.sent.get(r.key) === text && !sub.frame.leaves.has(r.key)) return;
    sub.sent.set(r.key, text);
    sub.frame.leaves.delete(r.key);
    sub.frame.upserts.set(r.key, out);
  } else if (sub.delivered.has(r.key)) {
    sub.delivered.delete(r.key); sub.byVals.delete(r.key); sub.sent.delete(r.key);
    sub.frame.upserts.delete(r.key);
    sub.frame.leaves.add(r.key);
  }
}

function reset(s: Stream, sub: Sub, reason: 'gap' | 'scope' | 'provider-gone' | 'epoch' | 'version'): void {
  s.subs.delete(sub.id);
  s.port.frame('reset', { sub: sub.id, reason, scope: s.scope });
}

function send(s: Stream, sub: Sub): void {
  const f = sub.frame;
  if (!f.upserts.size && !f.leaves.size && !f.deletes.size) return;
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
      // Their authority changed: every subscription resets (the window drops what it held), and the stream closes, since
      // everything else it carries (its bare changes, whose agents it hears of) was fixed when it opened. The window
      // opens a new one, as who they are now.
      s.scope++;
      for (const sub of [...s.subs.values()]) reset(s, sub, 'scope');
      s.port.close();
      h.streams.delete(s.port.id);
      continue;
    }
    for (const sub of [...s.subs.values()]) {
      const p = installed.get(sub.provider);
      if (!p || !Object.hasOwn(p.types, sub.type) || !domainsOf(p).has(sub.domain)) { reset(s, sub, 'provider-gone'); continue; }
      // The gates its answer passed, again: the provider still answers this viewer, and its declaration (field classes,
      // filters, audience mode) is the one the query was checked against. Only members' sessions subscribe, so there's
      // no grant to ask again.
      // Not this viewer's any more (the stream stays: only this provider's records go).
      if (!providerAdmits(v, p.owners2)) { reset(s, sub, 'provider-gone'); continue; }
      // A provider taken out of contract answers no one, live data included.
      if (outOfContract(p)) { reset(s, sub, 'provider-gone'); continue; }
      if (JSON.stringify(p.types[sub.type]) !== JSON.stringify(sub.decl)) { reset(s, sub, 'version'); continue; }
      const row = withLog(home, (db) => domainRow(db, sub.domain));
      if (!row || row.epoch !== sub.epoch) { reset(s, sub, 'epoch'); continue; }
      if (withLog(home, (db) => prunedThrough(db, sub.domain)) > sub.cursor) { reset(s, sub, 'gap'); continue; }
      const ask = sub.decl.audience === 'ask';
      let domainMoved = false;
      let gone = false;
      for (let reads = 0; reads < 16 && !gone; reads++) {
        const rows = withLog(home, (db) => rowsAfter(db, sub.cursor));
        if (!rows.length) break;
        for (const r of rows) {
          sub.cursor = r.seq;
          if (r.domain !== sub.domain) continue;
          if (r.epoch !== sub.epoch) { reset(s, sub, 'epoch'); gone = true; break; }
          // A type whose audience the provider decides per viewer is never routed by audience: it's asked again.
          if (ask) { if (r.key.startsWith(`${sub.provider}/${sub.type}/`)) domainMoved = true; } else apply(sub, v, r, now);
        }
      }
      if (gone || !s.subs.has(sub.id)) continue;
      trim(sub);
      if (ask && (domainMoved || sub.retry)) {
        sub.retry = false;
        if (!sub.waiting) reaskSoon(h, sub.reask, s, sub, p);
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
function reaskSoon(h: HomeState, reask: Reask, s: Stream, sub: Sub, p0: Provider): void {
  sub.waiting = true;
  // The viewer and the provider as they are now, before asking and again before sending: a change to either meanwhile
  // is the next pass's reset, never rows asked or sent under what was.
  let p = p0;
  const still = (): Viewer | undefined => {
    const v = s.port.viewer();
    if (!v || viewerId(v) !== s.vid) return undefined;
    const now = providers(h.env()).get(sub.provider);
    if (!now || !providerAdmits(v, now.owners2) || outOfContract(now) || !Object.hasOwn(now.types, sub.type) || JSON.stringify(now.types[sub.type]) !== JSON.stringify(sub.decl)) return undefined;
    p = now;
    return v;
  };
  void (async () => {
    // At most once per AGG_GAP_MS, and at once when the last ask is that long ago: the first change in a while reaches
    // the window without waiting, and a burst still costs one ask per gap (t-2025's measure: 1.7 s became ~0.2 s).
    const wait = Math.max(0, (sub.askedAt ?? 0) + AGG_GAP_MS - Date.now());
    if (wait) await new Promise((r) => setTimeout(r, wait));
    sub.askedAt = Date.now();
    const v = still();
    const got = v ? await reask(v, p, sub.query).catch(() => undefined) : undefined;
    sub.waiting = false;
    if (s.subs.get(sub.id) !== sub || !v || !still()) return;
    // Not answered: what it holds stays as it was (a reset here would say the provider was busy with something), and
    // it's asked again on the next pass.
    if (!got) { sub.retry = true; return; }
    // Only what differs from what this subscription was sent.
    const now = new Set<string>();
    got.admitted.forEach((r, i) => {
      const key = `${sub.provider}/${sub.type}/${r.id as string}`;
      now.add(key);
      const text = sentOf(sub, v, key, r);
      if (sub.sent.get(key) === text) return;
      sub.sent.set(key, text);
      sub.delivered.set(key, orderKey(r, r.id as string, sub.query));
      sub.frame.upserts.set(key, got.rows[i]);
    });
    for (const key of [...sub.delivered.keys()]) if (!now.has(key)) { sub.delivered.delete(key); sub.byVals.delete(key); sub.sent.delete(key); sub.frame.leaves.add(key); }
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

/**
 * After an action (handler.ts): the acting piece's domains (core's for `loom`) are pulled before the answer, here if
 * this listener has a subscription on them, and nudged for every other listener. Bounded: an answer waits at most
 * PULL_WAIT_MS for it, and the stream catches up with the rest.
 */
export const PULL_WAIT_MS = 3_000;
/** Core's attention records are made from every piece's asks (t-2025): any action may move them. */
export const ATTENTION_DOMAIN = 'loom/attention';
export async function pullAfterAction(home: string, env: NodeJS.ProcessEnv, piece: string): Promise<void> {
  let domains: string[];
  try {
    domains = [...providers(env).values()].filter((p) => (piece === 'loom' ? !p.piece : p.piece === piece)).flatMap((p) => [...domainsOf(p).keys()]);
  } catch { return; }
  // The attention records are every member's Inbox, built again: pulled soon (coalesced, one per GAP_MS), never
  // awaited, so a run of actions can't make each one rebuild them all. The acting piece's own domains are awaited.
  pullSoon(home, [ATTENTION_DOMAIN]);
  await pullNowAll(home, domains.filter((d) => d !== ATTENTION_DOMAIN));
}

/** Pull these domains soon (puller.soon: at once if not pulled in the last GAP_MS), here if this listener has a
 * subscription on them, and nudge them for every other listener. Not awaited by anyone. */
export function pullSoon(home: string, domains: readonly string[]): void {
  for (const d of domains) nudge(home, d);
  const h = homes.get(home);
  if (!h) return;
  const wanted = wantedOf(h);
  // Delivered as soon as each lands, not on the next pass.
  for (const d of domains) if (wanted.has(d)) void h.puller.soon(d).then(() => deliverNow(home)).catch(() => undefined);
}

/** Pull these domains now, here if this listener has a subscription on them (bounded by PULL_WAIT_MS), and nudge them
 * for every other listener. */
export async function pullNowAll(home: string, domains: readonly string[]): Promise<void> {
  if (!domains.length) return;
  for (const d of domains) nudge(home, d);
  const h = homes.get(home);
  if (!h) return;
  const wanted = wantedOf(h);
  const pulls = domains.filter((d) => wanted.has(d)).map((d) => h.puller.now(d));
  if (!pulls.length) return;
  await Promise.race([Promise.all(pulls), new Promise((r) => setTimeout(r, PULL_WAIT_MS))]);
  await deliverNow(home);
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
