import { waitForLocks, WRITE_WAIT_MS } from './lock-gate.js';
/**
 * Work in a Comms thread (docs/specs/comms.md, "Work in this thread"): the refs a thread's messages name, kept as refs
 * only; the pieces' thread feeds, merged into the panel's list; and the `from` block a piece's page carries, drawn per
 * viewer so only a thread's own member sees its title.
 *
 * The refs index lives in household.db beside the thread rows, `comms_refs (thread, ref, seq, at)`. It never holds a
 * message's words, which is why the 14-day sweep leaves it alone: a pointer the member or the agent wrote isn't the
 * conversation.
 */
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import type { Database } from 'better-sqlite3';
import { HOUSEHOLD_DB, withHouseholdDb } from './household-store.js';
import { loadHousehold, type Household, type Member } from './household.js';
import { COMMS_DB, SINCE_MAX, messagesOf, owns, threadOfConversation, threadPath, threadsOf, type Thread } from './comms.js';
import { piecesOffering, runOffer } from './offers-registry.js';
import { splitPage, type Block, type Page } from './ui/vocab.js';
import { ownersAwarePieces, type ApiCaller } from './ui/pieces.js';

/** A thread keeps at most this many refs; past it, the one named longest ago goes. */
export const MAX_REFS = 200;
/** A piece's thread feed answers at most this many items. */
export const FEED_ITEMS = 50;

// ─── The refs a text names ─────────────────────────────────────────────────────

/**
 * The work a message names, by section 6's link rules (web/src/plain.ts `bits`): t-N; owner/repo#N, and a bare repo#N
 * only under household.json's `github`, kept as github:owner/repo#N; note:<path>. Each once, in the order named.
 */
export function refsIn(text: string, github?: string): string[] {
  const out: string[] = [];
  const add = (r: string) => { if (!out.includes(r)) out.push(r); };
  const re = /\b(t-\d{1,9})\b|(?<![\w./-])([\w.-]+\/)?([\w.-]+)#(\d{1,10})\b|(?:^|\s)note:([\w./-]+)/g;
  for (let m; (m = re.exec(text));) {
    if (m[1]) add(m[1]);
    else if (m[4]) {
      const owner = m[2] ? m[2].slice(0, -1) : github;
      if (owner && /^[\w.-]+$/.test(owner)) add(`github:${owner}/${m[3]}#${m[4]}`);
    } else if (m[5]) {
      const p = m[5].replace(/[./]+$/, '');
      if (p && !p.split('/').includes('..')) add(`note:${p}`);
    }
  }
  return out;
}

// ─── The index ─────────────────────────────────────────────────────────────────

const REFS_SCHEMA = `CREATE TABLE IF NOT EXISTS comms_refs (
    thread TEXT NOT NULL,
    ref    TEXT NOT NULL,
    seq    INTEGER NOT NULL,
    pos    INTEGER NOT NULL,
    at     TEXT NOT NULL,
    PRIMARY KEY (thread, ref)
  );
  CREATE INDEX IF NOT EXISTS comms_refs_newest ON comms_refs (thread, seq, pos);
  CREATE TABLE IF NOT EXISTS comms_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);`;

const ready = new Set<string>();
function withRefs<T>(home: string, f: (db: Database) => T): T {
  return withHouseholdDb(home, (db) => {
    if (!ready.has(home)) { db.exec(REFS_SCHEMA); ready.add(home); }
    return f(db);
  });
}

/**
 * Note the refs one message names, in the order named: each row takes the newest message (seq) and place in it (pos)
 * naming it. Past MAX_REFS, the one named longest ago goes: the oldest message's, and within one message the earliest
 * named. A ref over 200 characters isn't kept (a feed's ref is at most 200).
 */
export function indexRefs(home: string, thread: string, seq: number, at: string, refs: string[]): void {
  const kept = refs.filter((r) => r.length <= 200);
  if (!kept.length) return;
  withRefs(home, (db) => db.transaction(() => {
    const up = db.prepare(`INSERT INTO comms_refs (thread, ref, seq, pos, at) VALUES (?, ?, ?, ?, ?)
      ON CONFLICT (thread, ref) DO UPDATE SET pos = CASE WHEN excluded.seq >= seq THEN excluded.pos ELSE pos END,
        at = CASE WHEN excluded.seq >= seq THEN excluded.at ELSE at END, seq = MAX(seq, excluded.seq)`);
    kept.forEach((r, i) => up.run(thread, r, seq, i, at));
    db.prepare(`DELETE FROM comms_refs WHERE thread = ? AND ref NOT IN
      (SELECT ref FROM comms_refs WHERE thread = ? ORDER BY seq DESC, pos DESC LIMIT ?)`).run(thread, thread, MAX_REFS);
  }).immediate());
}

/**
 * The hook comms.ts calls as it appends a member's message or the agent's reply: the refs only, read from the text
 * it's about to encrypt. A failure here never stops the message (the index is a convenience; the words are kept).
 */
export function noteRefs(home: string, thread: string, seq: number, at: string, kind: string, text: string | undefined): void {
  if ((kind !== 'message' && kind !== 'reply') || !text) return;
  try {
    indexRefs(home, thread, seq, at, refsIn(text, loadHousehold(home)?.github));
  } catch (e) {
    process.stderr.write(`loom: a Comms message's refs weren't indexed: ${(e as Error).name}\n`);
  }
}

/**
 * The one-time backfill (comms.md, "Older threads"), at daemon start: every thread's messages and replies whose words
 * are still kept, decrypted once each, indexed; then `refs_backfilled` in comms_meta, so no later start reads any.
 * Answers how many messages it read.
 */
export async function backfillRefs(h: Household, env: NodeJS.ProcessEnv, now: Date = new Date(), active: () => boolean = () => true): Promise<number> {
  if (!active()) return 0;
  await waitForLocks({ write: [join(h.home, HOUSEHOLD_DB)], budgetMs: WRITE_WAIT_MS });
  if (!active() || backfilled(h.home)) return 0;
  let read = 0;
  if (existsSync(join(h.home, COMMS_DB))) {
    const seen = new Set<string>();
    for (const m of h.members) {
      await waitForLocks({ read: [join(h.home, COMMS_DB)], write: [join(h.home, HOUSEHOLD_DB)], budgetMs: WRITE_WAIT_MS });
      if (!active()) return read;
      for (const t of [...threadsOf(h, m, { background: 'include' }), ...threadsOf(h, m, { archived: true, background: 'include' })]) {
        if (seen.has(t.id)) continue;
        seen.add(t.id);
        for (let after = 0; ;) {
          await waitForLocks({ read: [join(h.home, COMMS_DB)], write: [join(h.home, HOUSEHOLD_DB)], budgetMs: WRITE_WAIT_MS });
          if (!active()) return read;
          const msgs = await messagesOf(h, env, t, { after });
          await waitForLocks({ write: [join(h.home, HOUSEHOLD_DB)], budgetMs: WRITE_WAIT_MS });
          if (!active()) return read;
          for (const x of msgs) {
            if ((x.kind === 'message' || x.kind === 'reply') && x.text) {
              read++;
              indexRefs(h.home, t.id, x.seq, x.at, refsIn(x.text, h.github));
            }
          }
          if (msgs.length < SINCE_MAX) break;
          after = msgs[msgs.length - 1].seq;
        }
      }
    }
  }
  await waitForLocks({ write: [join(h.home, HOUSEHOLD_DB)], budgetMs: WRITE_WAIT_MS });
  if (!active()) return read;
  markBackfilled(h.home, now.toISOString());
  return read;
}

/** A thread's refs, newest first. */
export function refsOf(home: string, thread: string): Array<{ ref: string; seq: number; at: string }> {
  return withRefs(home, (db) => db.prepare('SELECT ref, seq, at FROM comms_refs WHERE thread = ? ORDER BY seq DESC, pos DESC').all(thread) as Array<{ ref: string; seq: number; at: string }>);
}

/** A deleted thread's refs go with it. */
export function dropRefs(home: string, thread: string): void {
  withRefs(home, (db) => db.prepare('DELETE FROM comms_refs WHERE thread = ?').run(thread));
}

/** Whether the one-time backfill (threads from before the index) has run here. */
export function backfilled(home: string): boolean {
  return withRefs(home, (db) => !!db.prepare("SELECT 1 FROM comms_meta WHERE key = 'refs_backfilled'").get());
}
export function markBackfilled(home: string, at: string): void {
  withRefs(home, (db) => db.prepare("INSERT OR REPLACE INTO comms_meta (key, value) VALUES ('refs_backfilled', ?)").run(at));
}

// ─── The thread feeds ──────────────────────────────────────────────────────────

export type Tone = 'bad' | 'warn' | 'ok';
export interface ThreadItem { title: string; ref: string; status: string; tone?: Tone; when?: string; page?: string; href?: string; made?: true }
/** An item as the panel gets it: its page made a URL, and the piece (or core) it came from. */
export interface WorkItem { title: string; ref: string; status: string; tone?: Tone; when?: string; url?: string; made?: true; from: string }

const ISO_UTC = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,3})?Z$/;
const HTTPS = /^https:\/\/[^\s<>"]+$/;
const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const str = (v: unknown, max: number): v is string => typeof v === 'string' && v.length >= 1 && v.length <= max;
const KEYS = ['title', 'ref', 'status', 'tone', 'when', 'page', 'href', 'made'];

/** A thread feed's answer (comms.md, "The thread feed"): `{items: [...]}`, ≤ 50, every key known. A string says what's wrong. */
export function parseThreadFeed(v: unknown): { items: ThreadItem[] } | string {
  if (!isObj(v)) return 'not a JSON object';
  const bad = Object.keys(v).find((k) => k !== 'items');
  if (bad !== undefined) return `unknown key ${JSON.stringify(bad)}`;
  if (!Array.isArray(v.items) || v.items.length > FEED_ITEMS) return `items is a list of at most ${FEED_ITEMS}`;
  const out: ThreadItem[] = [];
  for (const [i, it] of v.items.entries()) {
    const at = `items[${i}]`;
    if (!isObj(it)) return `${at} is not an object`;
    const bk = Object.keys(it).find((k) => !KEYS.includes(k));
    if (bk !== undefined) return `${at}: unknown key ${JSON.stringify(bk)}`;
    if (!str(it.title, 200)) return `${at}.title is required, at most 200 characters`;
    if (!str(it.ref, 200)) return `${at}.ref is required, at most 200 characters`;
    if (!str(it.status, 24)) return `${at}.status is required, at most 24 characters`;
    if (it.tone !== undefined && it.tone !== 'bad' && it.tone !== 'warn' && it.tone !== 'ok') return `${at}.tone is bad, warn or ok`;
    if (it.when !== undefined && !(typeof it.when === 'string' && ISO_UTC.test(it.when))) return `${at}.when is an ISO-8601 UTC time`;
    if (it.page !== undefined && !(str(it.page, 200) && splitPage(it.page))) return `${at}.page is a page path (or loom:<page>)`;
    if (it.href !== undefined && !(str(it.href, 500) && HTTPS.test(it.href))) return `${at}.href is an https URL`;
    if (it.page !== undefined && it.href !== undefined) return `${at} has a page or an href, not both`;
    if (it.made !== undefined && typeof it.made !== 'boolean') return `${at}.made is true or false`;
    const { made, ...rest } = it;
    out.push({ ...(rest as unknown as ThreadItem), ...(made === true ? { made: true as const } : {}) });
  }
  return { items: out };
}

/** Where a piece's item opens: its own page under /p/<piece>/, loom's for `loom:`, or the https URL. */
function urlOf(piece: string, it: ThreadItem): string | undefined {
  if (it.href) return it.href;
  if (!it.page) return undefined;
  const sp = splitPage(it.page);
  if (!sp || sp.agent || sp.household) return undefined;
  const q = new URLSearchParams(sp.query).toString();
  const path = sp.core ? `/${sp.path}` : `/p/${piece}${sp.path ? `/${sp.path}` : ''}`;
  return path + (q ? `?${q}` : '');
}

const TONE_RANK: Record<string, number> = { bad: 0, warn: 1 };

/** The panel's order: bad, then warn, then the rest; newest first within each, undated last. */
export function sortWork(items: WorkItem[]): WorkItem[] {
  return [...items].sort((a, b) => (TONE_RANK[a.tone ?? ''] ?? 2) - (TONE_RANK[b.tone ?? ''] ?? 2)
    || (b.when ?? '').localeCompare(a.when ?? ''));
}

/** The panel shows at most this many. */
export const MAX_WORK = 100;

/**
 * Merge the pieces' items (in piece-name order) and core's notes (last): one per ref. The item that survives is the
 * first answer marked `made`, else the first answer: whole, never fields mixed from two.
 */
export function mergeWork(lists: WorkItem[][]): WorkItem[] {
  const by = new Map<string, WorkItem>();
  for (const it of lists.flat()) {
    const had = by.get(it.ref);
    if (!had || (it.made && !had.made)) by.set(it.ref, it);
  }
  return sortWork([...by.values()]).slice(0, MAX_WORK);
}

/** Core's own items: each note ref, by its path (loom has no note page yet). */
export function noteItems(refs: Array<{ ref: string; at: string }>): WorkItem[] {
  return refs.filter((r) => r.ref.startsWith('note:')).map((r) => ({
    title: r.ref.slice('note:'.length), ref: r.ref, status: 'Note', ...(ISO_UTC.test(r.at) ? { when: r.at } : {}), from: 'loom',
  }));
}

/**
 * The work of a thread (GET /comms/<thread>/work): every piece offering `sections.thread`, run with the thread's
 * conversation and refs (newest first) and `{caller}` on stdin, merged with core's notes. A piece that fails is named
 * in `failed`, by its label; the rest still answer.
 */
export async function threadWork(h: Household, env: NodeJS.ProcessEnv, t: Thread, member: Member): Promise<{ items: WorkItem[]; failed: string[] }> {
  const refs = refsOf(h.home, t.id);
  const args = ['--conversation', t.conversation, ...refs.flatMap((r) => ['--ref', r.ref])];
  const caller: ApiCaller = { kind: 'owner', who: member.person, agents: member.agents };
  let pieces = piecesOffering(env, 'sections').filter((p) => p.offers.sections?.thread);
  // extensions.md's owners gate, as every other surface applies it (src/ui/handler.ts forOwner): a member who owns
  // only some agents sees only the pieces that understand agent owners (owners: 2), so only those are asked.
  if (member.agents !== '*' && pieces.length) {
    const ok = await ownersAwarePieces(env);
    pieces = pieces.filter((p) => ok.has(p.piece));
  }
  const failed: string[] = [];
  pieces.sort((a, b) => (a.piece < b.piece ? -1 : a.piece > b.piece ? 1 : 0));
  const lists = await Promise.all(pieces.map(async ({ piece, offers }): Promise<WorkItem[]> => {
    const { label, argv } = offers.sections!.thread!;
    try {
      const r = await runOffer(env, piece, argv, { args, stdin: JSON.stringify({ caller }), parse: parseThreadFeed });
      if (!r.ok) { failed.push(label); return []; }
      return r.value.items.map((it) => {
        const url = urlOf(piece, it);
        return { title: it.title, ref: it.ref, status: it.status, ...(it.tone ? { tone: it.tone } : {}), ...(it.when ? { when: it.when } : {}),
          ...(url ? { url } : {}), ...(it.made ? { made: true as const } : {}), from: piece };
      });
    } catch {
      failed.push(label);
      return [];
    }
  }));
  return { items: mergeWork([...lists, noteItems(refs)]), failed: failed.sort() };
}

// ─── From: the other direction ─────────────────────────────────────────────────

const agentWord = (agent: string) => agent ? agent[0].toUpperCase() + agent.slice(1) : agent;

/** One `from` block, as `member` may see it (comms.md, "From"). */
export function fromBlock(home: string | undefined, member: Member | undefined, conversation: string): Block {
  let t: Thread | undefined;
  try { t = home ? threadOfConversation(home, conversation) : undefined; } catch { t = undefined; }
  // Only a member who owns the agent may know the thread exists (its conversation record is theirs to see);
  // anyone else reads what an unknown conversation reads.
  if (!t || !member || !owns(member, t.agent)) return { type: 'text', text: 'From a conversation', tone: 'muted' };
  if (t.member === member.person) {
    return { type: 'link', text: `From: ${t.title ?? `New thread with ${agentWord(t.agent)}`}`, page: `loom:${threadPath(t.id).slice(1)}` };
  }
  return { type: 'text', text: 'From a Comms thread', tone: 'muted' };
}

const isFrom = (v: unknown): v is { type: 'from'; conversation: string } =>
  typeof v === 'object' && v !== null && (v as { type?: unknown }).type === 'from' && typeof (v as { conversation?: unknown }).conversation === 'string';

/**
 * A page with every `from` block drawn for `member`, wherever it sits (a section, a details, a panel row's sheet, a Changes reader): no
 * piece ever learns a thread's title or member, and none reaches the app undrawn.
 */
export function resolveFrom<P extends Pick<Page, 'sections' | 'changes'>>(page: P, home: string | undefined, member: Member | undefined): P {
  let found = false;
  const walk = (v: unknown): unknown => {
    if (Array.isArray(v)) return v.map(walk);
    if (isFrom(v)) { found = true; return fromBlock(home, member, v.conversation); }
    if (typeof v === 'object' && v !== null) return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, walk(x)]));
    return v;
  };
  const sections = walk(page.sections) as P['sections'];
  const changes = page.changes ? walk(page.changes) as P['changes'] : undefined;
  return found ? { ...page, sections, ...(changes ? { changes } : {}) } : page;
}
