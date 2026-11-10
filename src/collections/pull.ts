/**
 * Core pulls; anyone may nudge (docs/specs/collections.md, "Changes: from provider to window").
 *
 * A provider never pushes records. Core runs its `changes` verb with each domain's cursor (the revision and the
 * transaction it holds there) and writes what it answers to the log (log.ts), whole transactions at a time:
 *
 *  - `{reset: true}`, or a head below the cursor: the provider's history isn't the one core holds (a restore, a
 *    rewrite). Core mints a new epoch (compare-and-set: two listeners mint one) and every subscription resets.
 *  - `{invalidate: true}`: the provider can't say what changed. Core takes a snapshot as the core viewer and logs the
 *    differences itself (the bridge); a record is deleted only when the snapshot was complete.
 *  - changes, in commit order, each `{op, id, rev, txn, audience, record}`, ending on a transaction boundary unless a
 *    transaction is bigger than a page (`more: true`), which core holds until its last change arrives.
 *
 * Core's own types have no log yet, so they always take the bridge. Pulls happen when nudged (coalesced to one per
 * domain per GAP_MS), and every POLL_MS for a domain with an open subscription. One listener at a time holds a
 * domain's lease.
 */
import { randomBytes } from 'node:crypto';
import { readRecord } from '../cli/pieces-managed.js';
import type { Household } from '../household.js';
import { runOffer } from '../offers-registry.js';
import { Pool } from '../ui/pieces.js';
import { CORE_PROVIDER, RECORD_ID, type TypeDecl } from './contract.js';
import { coreAnswers } from './core-types.js';
import type { ProviderQuery } from './memory.js';
import { domainOf, expire, indexOf, markNudged, prune, resetEpoch, seedIndex, setCursor, setMode, takeLease, tick, withLog, writeTxn, type Change } from './log.js';
import { providers, readAnswers, type Provider } from './serve.js';
import { parseAudience } from './viewer.js';

export const GAP_MS = 1_500;
export const POLL_MS = 15_000;
/** A change page: at most this many changes, and the offer's byte limit. */
export const PAGE_MAX = 1000;
/** Pages read in one pull before core lets others have the provider. */
const MAX_PAGES = 16;
/** Pages a bridge snapshot reads per type; past it, the snapshot is partial and deletes nothing. */
const BRIDGE_PAGES = 20;

/** This listener, for the pull lease. */
export const LISTENER = randomBytes(8).toString('hex');

/** The domains of a provider's types: `<provider>/<type>`, or `<provider>/*` for those counting together. */
export function domainsOf(p: Provider): Map<string, string[]> {
  const out = new Map<string, string[]>();
  for (const [t, d] of Object.entries(p.types)) {
    const domain = d.domain === 'provider' ? `${p.name}/*` : `${p.name}/${t}`;
    out.set(domain, [...(out.get(domain) ?? []), t]);
  }
  return out;
}

/** The domain a type is in. */
export const domainOfType = (p: Provider, type: string): string => (p.types[type].domain === 'provider' ? `${p.name}/*` : `${p.name}/${type}`);

/** What serves a domain: the piece and its installed version (a change of either is another history). */
export function sourceOf(env: NodeJS.ProcessEnv, p: Provider): string {
  if (!p.piece) return CORE_PROVIDER;
  const rec = readRecord(env, p.piece);
  return rec ? `${p.piece}@${rec.installed}@${rec.version}` : p.piece;
}

/** Only what core may keep of a record: declared, not heavy, not `kept: false`. */
export function keptOf(decl: TypeDecl, record: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [f, d] of Object.entries(decl.fields)) {
    if (d.heavy || d.kept === false || !Object.hasOwn(record, f)) continue;
    out[f] = record[f];
  }
  return out;
}

const expiresOf = (v: unknown): number | undefined => {
  const t = typeof v === 'number' ? v : typeof v === 'string' && v.length <= 40 ? Date.parse(v) : Number.NaN;
  return Number.isFinite(t) && Math.abs(t) <= 8.64e15 ? t : undefined;
};

export type PullOutcome = 'pulled' | 'busy' | 'reset' | 'bridged' | 'failed' | 'gone';

const pools = new Map<string, Pool>();
const poolOf = (provider: string): Pool => {
  let p = pools.get(provider);
  if (!p) { p = new Pool(1, 4); pools.set(provider, p); }
  return p;
};

/** A change as a provider answers it, checked; undefined when it isn't one (the whole page is then refused). */
function parseChange(v: unknown, p: Provider, types: readonly string[]): (Change & { type: string }) | undefined {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return undefined;
  const c = v as Record<string, unknown>;
  const type = types.length === 1 ? types[0] : c.type;
  if (typeof type !== 'string' || !types.includes(type)) return undefined;
  if ((c.op !== 'upsert' && c.op !== 'delete') || typeof c.id !== 'string' || !RECORD_ID.test(c.id)) return undefined;
  if (!Number.isSafeInteger(c.rev) || (c.rev as number) < 0 || typeof c.txn !== 'string' || !/^[A-Za-z0-9_-]{8,64}$/.test(c.txn)) return undefined;
  if (c.op === 'delete') return { type, op: 'delete', id: c.id, rev: c.rev as number, txn: c.txn };
  const audience = parseAudience(c.audience);
  if (!audience || !c.record || typeof c.record !== 'object' || Array.isArray(c.record)) return undefined;
  const decl = p.types[type];
  const record = keptOf(decl, c.record as Record<string, unknown>);
  const agentV = decl.agent ? record[decl.agent] : undefined;
  if (agentV !== undefined && agentV !== null && typeof agentV !== 'string') return undefined;
  const expires = expiresOf(c.expires ?? (c.record as Record<string, unknown>).expires);
  return { type, op: 'upsert', id: c.id, rev: c.rev as number, txn: c.txn, audience: audience as Record<string, unknown>, ...(typeof agentV === 'string' ? { agent: agentV } : {}), record, ...(expires !== undefined ? { expires } : {}) };
}

interface PullContext { env: NodeJS.ProcessEnv; household: Household; now?: () => number }

/**
 * Pull one domain until its provider has nothing more (or MAX_PAGES), if this listener holds its lease. Writes the
 * log and the index, and ticks every listener when anything was written.
 */
export async function pullDomain(ctx: PullContext, p: Provider, domain: string): Promise<PullOutcome> {
  const home = ctx.household.home;
  const now = ctx.now ?? Date.now;
  const types = domainsOf(p).get(domain);
  if (!types) return 'gone';
  const source = sourceOf(ctx.env, p);
  const { row, minted } = withLog(home, (db) => domainOf(db, domain, source));
  if (!withLog(home, (db) => takeLease(db, domain, LISTENER, now()))) return 'busy';
  if (minted) tick(home);
  if (!p.piece || !p.changes || row.mode === 'bridge') return bridge(ctx, p, domain, types, row.epoch);
  let cursor = { rev: row.rev, txn: row.txn };
  let held: Array<Change & { type: string }> = [];
  let wrote = 0;
  for (let page = 0; page < MAX_PAGES; page++) {
    const stdin = JSON.stringify({ [domain]: { rev: cursor.rev, txn: cursor.txn }, limit: PAGE_MAX });
    const r = await poolOf(p.name).run(() => runOffer(ctx.env, p.piece!, p.changes!, { kind: 'collections', stdin, caller: { kind: 'owner' }, parse: (v) => v }));
    if (r === null) return 'busy';
    if (!r.ok) { process.stderr.write(`loom: collections changes from ${p.name} (${domain}) failed: ${r.error}\n`); return 'failed'; }
    const a = (r.value && typeof r.value === 'object' && !Array.isArray(r.value) ? (r.value as Record<string, unknown>)[domain] : undefined) as Record<string, unknown> | undefined;
    if (!a || typeof a !== 'object') { process.stderr.write(`loom: collections changes from ${p.name} said nothing of ${domain}\n`); return 'failed'; }
    if (a.reset === true || (cursor.rev !== null && Number.isSafeInteger(a.head) && (a.head as number) < cursor.rev)) {
      withLog(home, (db) => resetEpoch(db, domain, row.epoch));
      tick(home);
      return 'reset';
    }
    if (a.invalidate === true) {
      withLog(home, (db) => setMode(db, domain, row.epoch, 'bridge'));
      return bridge(ctx, p, domain, types, row.epoch);
    }
    if (!Number.isSafeInteger(a.head) || (a.head as number) < 0) return 'failed';
    // A first pull starts at the provider's head: windows get what's there now by snapshot, and changes from here.
    if (cursor.rev === null) {
      if (typeof a.txn !== 'string' || !/^[A-Za-z0-9_-]{8,64}$/.test(a.txn)) return 'failed';
      withLog(home, (db) => setCursor(db, domain, row.epoch, a.head as number, a.txn as string));
      // What's there already reaches the index by snapshot (its expiry is kept from it); changes from the head on.
      const snap = await snapshot(ctx, p, types);
      if (typeof snap !== 'string') withLog(home, (db) => seedIndex(db, domain, row.epoch, [...snap.seen].map(([key, c]) => ({ key, audience: c.audience!, ...(c.agent ? { agent: c.agent } : {}), ...(c.expires !== undefined ? { expires: c.expires } : {}), record: c.record! }))));
      break;
    }
    if (!Array.isArray(a.changes) || a.changes.length > PAGE_MAX) return 'failed';
    const changes: Array<Change & { type: string }> = [];
    let last = cursor.rev;
    for (const raw of a.changes) {
      const c = parseChange(raw, p, types);
      // Out of order, or not a change: the page is refused whole, and the next pull asks again from the cursor.
      if (!c || (c.rev as number) <= last) { process.stderr.write(`loom: collections changes from ${p.name} (${domain}) out of contract\n`); return 'failed'; }
      last = c.rev as number;
      changes.push(c);
    }
    const all = [...held, ...changes];
    // Whole transactions only: a transaction still open at the page's end waits for the next page.
    let cut = all.length;
    if (a.more === true && cut) { const tail = all[cut - 1].txn; while (cut > 0 && all[cut - 1].txn === tail) cut--; }
    held = all.slice(cut);
    const complete = all.slice(0, cut);
    let i = 0;
    while (i < complete.length) {
      let j = i;
      while (j < complete.length && complete[j].txn === complete[i].txn) j++;
      const txn = complete.slice(i, j);
      const end = txn[txn.length - 1];
      wrote += withLog(home, (db) => writeTxn(db, domain, row.epoch, txn, (c) => ({ key: `${p.name}/${(c as Change & { type: string }).type}/${c.id}`, type: (c as Change & { type: string }).type }), now(), { rev: end.rev as number, txn: end.txn as string }));
      cursor = { rev: end.rev, txn: end.txn };
      i = j;
    }
    if (a.more !== true) {
      if (!complete.length && Number.isSafeInteger(a.head) && typeof a.txn === 'string' && (a.head as number) === cursor.rev) break;
      break;
    }
  }
  withLog(home, (db) => prune(db, now()));
  if (wrote) tick(home);
  return 'pulled';
}

/**
 * Every record of a domain's types as the core viewer sees it, in keyset pages (at most BRIDGE_PAGES a type): whole
 * records, kept fields only. `complete` is false when a type had more than that.
 */
async function snapshot(ctx: PullContext, p: Provider, types: readonly string[]): Promise<{ seen: Map<string, Change & { type: string }>; complete: boolean } | 'busy' | 'failed'> {
  const now = ctx.now ?? Date.now;
  const seen = new Map<string, Change & { type: string }>();
  let complete = true;
  for (const type of types) {
    const decl = p.types[type];
    const fields = Object.entries(decl.fields).filter(([, d]) => !d.heavy && d.kept !== false).map(([f]) => f);
    let after: unknown[] | null = null;
    let pages = 0;
    for (;;) {
      const q: ProviderQuery = { id: 'bridge', type, version: Number(decl.version.split('.')[0]), where: [], order: [], limit: decl.max_page, after, fields, aggregates: [] };
      let answer;
      if (!p.piece) answer = (await coreAnswers(ctx.household, { kind: 'core' }, [q], now()))[0];
      else {
        const stdin = JSON.stringify({ viewer: { kind: 'core' }, now: new Date(now()).toISOString(), queries: [q] });
        // As the core viewer every row is admitted; it's read the same way as anyone's answer.
        const reading = readAnswers([q], 64 * 1024 * 1024, () => 0);
        const r = await poolOf(p.name).run(() => runOffer(ctx.env, p.piece!, p.query!, { kind: 'collections', stdin, caller: { kind: 'owner' }, parse: (v) => v, onLine: reading.onLine }));
        if (r === null) return 'busy';
        if (!r.ok) { process.stderr.write(`loom: collections snapshot of ${p.name}/${type} failed: ${r.error}\n`); return 'failed'; }
        answer = reading.answers().get('bridge');
      }
      if (!answer || answer.error) return 'failed';
      for (const raw of answer.rows) {
        const c = parseChange({ ...raw, op: 'upsert', rev: 0, txn: 'bridge000', type, record: raw }, p, types);
        if (c) seen.set(`${p.name}/${type}/${c.id}`, { ...c, rev: null, txn: null });
      }
      // Keyset pages by id, as core asks any provider, until it says there's no more.
      const last = answer.rows[answer.rows.length - 1] as { id?: unknown } | undefined;
      if (!answer.more || typeof last?.id !== 'string') break;
      if (++pages >= BRIDGE_PAGES) { complete = false; break; }
      after = [last.id];
    }
  }
  return { seen, complete };
}

/**
 * The bridge: a provider (or core's own type) that can't say what changed. Core takes a snapshot of each type as the
 * core viewer, in pages, and logs the differences from its index as its own rows. A record missing from a complete
 * snapshot is a delete; from a partial one, nothing is said about it.
 */
async function bridge(ctx: PullContext, p: Provider, domain: string, types: readonly string[], epoch: string): Promise<PullOutcome> {
  const home = ctx.household.home;
  const now = ctx.now ?? Date.now;
  const snap = await snapshot(ctx, p, types);
  if (typeof snap === 'string') return snap;
  const { seen, complete } = snap;
  const diffs = withLog(home, (db) => {
    const held = new Map(indexOf(db, domain).map((r) => [r.key, r]));
    const out: Array<Change & { type: string; key: string }> = [];
    for (const [key, c] of seen) {
      const h = held.get(key);
      const same = h && h.epoch === epoch && h.record === JSON.stringify(c.record) && h.audience === JSON.stringify(c.audience) && (h.agent ?? undefined) === c.agent && (h.expires ?? undefined) === c.expires;
      if (!same) out.push({ ...c, key });
    }
    if (complete) for (const [key] of held) if (!seen.has(key)) out.push({ op: 'delete', id: key.split('/')[2], rev: null, txn: null, type: key.split('/')[1], key });
    return out;
  });
  if (diffs.length) {
    withLog(home, (db) => writeTxn(db, domain, epoch, diffs, (c) => ({ key: (c as Change & { key: string }).key, type: (c as Change & { type: string }).type }), now()));
    tick(home);
  }
  withLog(home, (db) => prune(db, now()));
  return 'bridged';
}

/**
 * Pulls for one listener: a domain with an open subscription here every POLL_MS, and at once (coalesced to one per
 * GAP_MS) when it's nudged. `wanted` says which domains this listener's subscriptions read.
 */
export class Puller {
  private timers = new Map<string, NodeJS.Timeout>();
  private last = new Map<string, number>();
  private running = new Map<string, Promise<PullOutcome>>();
  private poll: NodeJS.Timeout | undefined;

  constructor(private readonly ctx: () => PullContext, private readonly wanted: () => Set<string>) {}

  start(): void {
    this.poll ??= setInterval(() => this.round(), POLL_MS);
    this.poll.unref?.();
  }

  stop(): void {
    clearInterval(this.poll); this.poll = undefined;
    for (const t of this.timers.values()) clearTimeout(t);
    this.timers.clear();
    for (const w of this.after.values()) w.resolve(undefined);
    this.after.clear();
  }

  /** Every wanted domain, and the expiry pass. */
  round(): void {
    const c = this.ctx();
    try { if (withLog(c.household.home, (db) => expire(db))) tick(c.household.home); } catch (e) { process.stderr.write(`loom: collections expiry failed: ${(e as Error).message}\n`); }
    for (const d of this.wanted()) this.soon(d);
  }

  /** Pull `domain` soon: at once if it hasn't been pulled for GAP_MS, else when that's up. One at a time per domain.
   * Answers when that pull is done (a caller may deliver right after it). */
  soon(domain: string): Promise<PullOutcome | undefined> {
    const waiting = this.after.get(domain);
    if (this.timers.has(domain) && waiting) return waiting.promise;
    let resolve!: (v: PullOutcome | undefined) => void;
    const promise = new Promise<PullOutcome | undefined>((r) => { resolve = r; });
    this.after.set(domain, { promise, resolve });
    const wait = Math.max(0, (this.last.get(domain) ?? 0) + GAP_MS - Date.now());
    const t = setTimeout(() => {
      this.timers.delete(domain);
      this.after.delete(domain);
      // A pull already under way may have read before what this one was asked for: this one runs after it, never joins it.
      const on = this.running.get(domain);
      (on ? on.catch(() => undefined).then(() => this.now(domain)) : this.now(domain)).then(resolve, () => resolve(undefined));
    }, wait);
    t.unref?.();
    this.timers.set(domain, t);
    return promise;
  }
  private after = new Map<string, { promise: Promise<PullOutcome | undefined>; resolve: (v: PullOutcome | undefined) => void }>();

  /** Pull `domain` now (or join the pull under way). */
  now(domain: string): Promise<PullOutcome> {
    const on = this.running.get(domain);
    if (on) return on;
    this.last.set(domain, Date.now());
    const c = this.ctx();
    const [prov] = domain.split('/');
    const p = providers(c.env).get(prov);
    const run = (async (): Promise<PullOutcome> => {
      if (!p || !domainsOf(p).has(domain)) return 'gone';
      try { return await pullDomain(c, p, domain); } catch (e) { process.stderr.write(`loom: collections pull of ${domain} failed: ${(e as Error).message}\n`); return 'failed'; }
    })().finally(() => this.running.delete(domain));
    this.running.set(domain, run);
    return run;
  }
}

/**
 * A nudge (POST /api/loom/collections/nudge, `loom collections nudge`): the domain is marked, and every listener that
 * pulls it hears of it from the tick file. Nothing is said back about whether it exists.
 */
export function nudge(home: string, domain: string): void {
  if (typeof domain !== 'string' || !/^[a-z][a-z0-9-]{0,39}\/([a-z][a-z0-9-]{0,31}|\*)$/.test(domain)) return;
  try { withLog(home, (db) => markNudged(db, domain)); tick(home); } catch { /* a nudge is a hint; the poll still pulls */ }
}
