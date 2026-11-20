/**
 * Activity (t-1972, Jonathan's approved design 2026-11-08): what happened in the household, a few days at a time, as
 * entries a person can read. One entry is one run of a conversation (its digest: the agent's own summary of what it
 * did), a conversation that moved without a digest, or an episode an agent wrote that no conversation covers.
 *
 * Who sees what is what the household page already allows, never more:
 *  - only the viewer's agents (an agent owner's household is narrowed to theirs before this is called, handler.ts);
 *  - a Comms thread (venue `loom`) only to its own member, as every Comms route has it (comms.md: "Only the thread's
 *    member reads them"); an episode about one, likewise. Every other conversation follows the household's visibility
 *    (conversations.md, "Who sees what"), as Projects and the Inbox do.
 *
 * Titles are plain: a conversation's label (a Comms thread's own title), never a body's prompt (episode-title.ts).
 */
import { existsSync } from 'node:fs';
import type { Database } from 'better-sqlite3';
import { agentDir, type Household, type Member } from '../household.js';
import { openConversationsReadonly } from '../backends/conversations.js';
import { COMMS_VENUE, messagesOf, owns, threadOfConversation, threadPath, type Thread } from '../comms.js';
import { venueLabel } from '../household-store.js';
import { agentName, tapeRows, whereLabel } from './data.js';
import { fallbackParts, whereOfConversation } from './episode-title.js';

export type ActivityWhat = 'conversation' | 'work' | 'system';
/** The Where filter's keys: the venues people know. */
export type ActivityVenue = string;

export interface ActivityEntry {
  /** `d~<agent>~<digest>`, `c~<agent>~<conversation>` or `e~<agent>~<memory ref>`. */
  id: string;
  agent: string;
  at: string;
  /** YYYY-MM-DD and 0-23 in the household's zone. */
  day: string;
  hour: number;
  title: string;
  /** One line on what happened. */
  line?: string;
  /** The Where filter's key (comms, discord, slack, terminal, wakes, relay…) and the tag's words. */
  venue: ActivityVenue;
  where: string;
  what: ActivityWhat;
  /** The owner was in it (a Comms thread, a conversation with them). */
  owner?: true;
}

export interface ActivityLink { label: string; href?: string; page?: string }

export interface ActivityOpen extends ActivityEntry {
  /** What was asked of the agent, what it decided, the tasks it touched. */
  asked: string[];
  decided: string[];
  /** What it said happened, whole. */
  story?: string;
  tasks: ActivityLink[];
  prs: ActivityLink[];
  /** Where to read more: the thread, the conversation, the memory. */
  links: ActivityLink[];
  /** What it still needs from the owner, when the run asked. */
  needs?: string;
  /** A Comms run's steps, as its thread shows them (comms.tsx Steps): the viewer's own thread only. */
  steps?: Array<{ label: string; state: string; tool: string }>;
  /** The conversation's other runs in the window, newest first. */
  more: Array<{ id: string; at: string; title: string }>;
}

export interface ActivityView {
  /** The last day shown, and the days shown (newest first). */
  to: string;
  days: string[];
  /** The day before the window, for "Earlier" (none past MAX_BACK days). */
  earlier?: string;
  entries: ActivityEntry[];
  /** The owner as Who says it. */
  owner: { key: 'owner'; label: string };
  venues: Record<string, string>;
  /** Filters asked for by address (?who=, ?where=, ?what=), and the entry (?e=) and day (?day=). */
  filters: { who: string[]; where: string[]; what: ActivityWhat[] };
  day?: string;
  open?: ActivityOpen;
  /** The entry asked for isn't one this viewer has (gone, or never theirs: the same answer). */
  missing?: true;
}

export const WINDOW_DAYS = 3;
export const MAX_BACK = 30;
const MAX_ENTRIES = 600;
const DAY_MS = 86_400_000;

const VENUES: Record<string, string> = { comms: 'Comms', discord: 'Discord', slack: 'Slack', terminal: 'Terminal', wakes: 'Wakes', relay: 'Relay', web: 'Web', mcp: 'MCP', voice: 'Voice' };

/** A venue or an episode's surface as the Where filter's key. */
export function venueKey(surface: string): string {
  const s = surface.toLowerCase();
  if (s === COMMS_VENUE || s === 'comms') return 'comms';
  if (s === 'wake' || s === 'lane' || s === 'local-lane' || s === 'alert' || s === 'schedule') return 'wakes';
  if (s === 'cli' || s === 'terminal' || s === 'session' || s === '?' || !s) return 'terminal';
  return s;
}

/** What an entry is about: the system's own upkeep, work that landed, or else a conversation. */
export function whatOf(e: { place?: string; title: string; line?: string; tasks?: string[] }): ActivityWhat {
  const text = `${e.title} ${e.line ?? ''}`;
  if (/^alert:/.test(e.place ?? '') || /\b(backups?|alerts?|disk|nearly full|box[- ]health|boxes|offsite|restic|service failed|unit [\w-]+ failed)\b/i.test(e.title)) return 'system';
  if (/\b(merged|deployed|shipped|released|closed t-\d+|PR (?:#?\d+ )?(?:is )?merged)\b/i.test(text)) return 'work';
  return 'conversation';
}

const isoDay = (ms: number, tz: string) => new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(ms));
const hourOf = (ms: number, tz: string) => Number(new Intl.DateTimeFormat('en-US', { timeZone: tz, hour: 'numeric', hourCycle: 'h23' }).format(new Date(ms))) % 24;
/** The day `n` days before YYYY-MM-DD (calendar arithmetic, zone-free). */
export function dayBefore(day: string, n = 1): string {
  const [y, m, d] = day.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d - n)).toISOString().slice(0, 10);
}
const DAY = /^\d{4}-\d{2}-\d{2}$/;

/** The first sentence (or the first 200 characters) of a summary: an entry's one line. */
export function oneLine(s: string): string {
  const t = s.replace(/\s+/g, ' ').trim();
  const m = /^(.{20,200}?[.!?])(?:\s|$)/.exec(t);
  const out = m ? m[1] : t;
  return out.length > 200 ? `${out.slice(0, 199).trimEnd()}…` : out;
}

/** Refs a summary names: tasks (t-123) and pull requests (owner/repo#12, repo#12, a GitHub URL). */
export function refsIn(text: string, github?: string): { tasks: string[]; prs: ActivityLink[] } {
  const tasks = [...new Set([...text.matchAll(/\bt-\d{1,6}\b/g)].map((m) => m[0]))];
  const prs = new Map<string, ActivityLink>();
  for (const m of text.matchAll(/https:\/\/github\.com\/([\w.-]+)\/([\w.-]+)\/pull\/(\d+)/g)) prs.set(`${m[1]}/${m[2]}#${m[3]}`, { label: `${m[2]}#${m[3]}`, href: m[0] });
  for (const m of text.matchAll(/(?<![\w/.-])(?:([\w.-]+)\/)?([a-z][\w.-]*)#(\d{1,6})\b/g)) {
    const owner = m[1] ?? github;
    if (!owner) continue;
    const key = `${owner}/${m[2]}#${m[3]}`;
    if (!prs.has(key)) prs.set(key, { label: `${m[2]}#${m[3]}`, href: `https://github.com/${owner}/${m[2]}/pull/${m[3]}` });
  }
  return { tasks, prs: [...prs.values()] };
}

const taskLink = (id: string): ActivityLink => ({ label: id, page: `loom:p/tasks/task/${id}` });
const parse = <T,>(s: string | null | undefined, empty: T): T => { try { return s ? JSON.parse(s) as T : empty; } catch { return empty; } };

interface DigestRow { id: string; conversation: string; run: string; at: string; summary: string; asks_json: string; decisions_json: string; tasks_json: string; needs_owner: string | null; needs_owner_href: string | null }
interface ConvRow { id: string; venue: string; place: string; label: string | null; people_json: string; last: string; started: string; last_seq: number }

interface Ctx {
  h: Household; tz: string; member?: Member; ownerPerson?: string;
  /** Whether a conversation's asks are the viewer's (handler.ts seesConversation; t-2084): none, none are. */
  seesAsk?: (cv: string, agent: string) => boolean;
  /** Comms threads by conversation, looked up once. */
  threads: Map<string, Thread | null>;
}

/** The thread of a Comms conversation, when the viewer may read it; null when they may not (or it's gone). */
function commsThread(c: Ctx, agent: string, conversation: string): Thread | null {
  if (!c.threads.has(conversation)) {
    let t: Thread | null = null;
    try { t = threadOfConversation(c.h.home, conversation) ?? null; } catch { t = null; }
    c.threads.set(conversation, t);
  }
  const t = c.threads.get(conversation) ?? null;
  return t && c.member && t.member === c.member.person && t.agent === agent && owns(c.member, agent) ? t : null;
}

/** A conversation's title: a Comms thread's own, else its label, else "<venue> conversation". */
function convTitle(c: Ctx, agent: string, cv: ConvRow): string {
  if (cv.venue === COMMS_VENUE) return commsThread(c, agent, cv.id)?.title || cv.label || 'A Comms thread';
  // A lane's or an alert's label leads with the runtime's bookkeeping ("schedule plan-afternoon: daily afternoon plan").
  const raw = (cv.label ?? '').trim();
  const bare = raw.replace(/^(?:schedule|alert) [\w.-]+:\s+(?=\S)/, '');
  const label = bare === raw ? raw : bare.replace(/^\p{Ll}/u, (x) => x.toUpperCase());
  return label || `A ${venueLabel(c.h.home, cv.venue)} conversation`;
}

function convWhere(c: Ctx, cv: ConvRow): { venue: string; where: string } {
  const venue = venueKey(cv.venue);
  if (venue === 'comms') return { venue, where: 'Comms' };
  if (venue === 'wakes') return { venue, where: /^lane:|^schedule /.test(cv.place) || /^schedule /.test(cv.label ?? '') ? 'Lane' : /^alert:/.test(cv.place) ? 'Alert' : 'Wake' };
  const label = venueLabel(c.h.home, cv.venue);
  return { venue, where: whereLabel(whereOfConversation({ venue: cv.venue, place: cv.place, label: cv.label })) || label };
}

/** Everything this viewer may see in [from, until), newest first. */
function collect(c: Ctx, fromMs: number, untilMs: number): ActivityEntry[] {
  const out: ActivityEntry[] = [];
  const covered = new Map<string, Set<string>>();   // agent → conversations with an entry here
  const runsAt: Array<{ agent: string; venue: string; at: number }> = [];
  const from = new Date(fromMs).toISOString(), until = new Date(untilMs).toISOString();
  const at = (iso: string) => { const ms = Date.parse(iso); return { day: isoDay(ms, c.tz), hour: hourOf(ms, c.tz) }; };
  for (const agent of c.h.agents) {
    const dir = agentDir(c.h, agent);
    if (!existsSync(dir)) continue;
    const mine = new Set<string>();
    covered.set(agent, mine);
    const db: Database | null = openConversationsReadonly(dir);
    if (db) {
      try {
        const convs = new Map<string, ConvRow>();
        const conv = (id: string) => {
          if (!convs.has(id)) convs.set(id, db.prepare('SELECT id, venue, place, label, people_json, last, started, last_seq FROM conversations WHERE id = ?').get(id) as ConvRow);
          return convs.get(id);
        };
        const digests = db.prepare('SELECT id, conversation, run, at, summary, asks_json, decisions_json, tasks_json, needs_owner, needs_owner_href FROM conversation_digests WHERE at >= ? AND at < ? ORDER BY at DESC LIMIT ?').all(from, until, MAX_ENTRIES) as DigestRow[];
        for (const d of digests) {
          const cv = conv(d.conversation);
          if (!cv) continue;
          if (cv.venue === COMMS_VENUE && !commsThread(c, agent, cv.id)) continue;
          const title = convTitle(c, agent, cv);
          const line = oneLine(d.summary);
          const { venue, where } = convWhere(c, cv);
          mine.add(cv.id);
          runsAt.push({ agent, venue, at: Date.parse(d.at) });
          const people = parse<string[]>(cv.people_json, []);
          out.push({ id: `d~${agent}~${d.id}`, agent, at: d.at, ...at(d.at), title, line, venue, where,
            what: whatOf({ place: cv.place, title, line: d.summary, tasks: parse<string[]>(d.tasks_json, []) }),
            ...(cv.venue === COMMS_VENUE || (c.ownerPerson && people.includes(c.ownerPerson)) ? { owner: true as const } : {}) });
        }
        // A conversation that moved in the window with no digest in it: one entry, at its last turn.
        const moved = db.prepare('SELECT id, venue, place, label, people_json, last, started, last_seq FROM conversations c WHERE last >= ? AND last < ? AND NOT EXISTS (SELECT 1 FROM conversation_digests d WHERE d.conversation = c.id AND d.at >= ? AND d.at < ?) ORDER BY last DESC LIMIT ?')
          .all(from, until, from, until, MAX_ENTRIES) as ConvRow[];
        for (const cv of moved) {
          if (cv.venue === COMMS_VENUE && !commsThread(c, agent, cv.id)) continue;
          const kinds = db.prepare('SELECT kind, COUNT(*) AS n FROM conversation_turns WHERE conversation = ? AND at >= ? AND at < ? GROUP BY kind').all(cv.id, from, until) as Array<{ kind: string; n: number }>;
          const n = kinds.reduce((s, k) => s + k.n, 0);
          if (!n) continue;
          const replies = kinds.find((k) => k.kind === 'reply')?.n ?? 0;
          const title = convTitle(c, agent, cv);
          const { venue, where } = convWhere(c, cv);
          mine.add(cv.id);
          const people = parse<string[]>(cv.people_json, []);
          const line = replies ? `${n} turn${n === 1 ? '' : 's'}, ${replies} repl${replies === 1 ? 'y' : 'ies'}, no summary yet` : `${n} turn${n === 1 ? '' : 's'}, no summary yet`;
          out.push({ id: `c~${agent}~${cv.id}`, agent, at: cv.last, ...at(cv.last), title, line, venue, where, what: whatOf({ place: cv.place, title }),
            ...(cv.venue === COMMS_VENUE || (c.ownerPerson && people.includes(c.ownerPerson)) ? { owner: true as const } : {}) });
        }
      } catch { /* an older store: its episodes still show */ } finally { db.close(); }
    }
    // Episodes no conversation here covers: one an agent wrote of its own, a lane's, an older body's.
    const label = agentName(dir);
    for (const e of tapeRows(dir, Math.ceil((Date.now() - fromMs) / 3_600_000) + 1, Date.now(), { until: untilMs })) {
      const ms = Date.parse(e.created);
      if (ms < fromMs || ms >= untilMs) continue;
      if (e.conversation && mine.has(e.conversation)) continue;
      const surface = e.where.split(/[:/]/)[0];
      const venue = venueKey(surface);
      // A Comms thread's words are its member's: an episode about one, too.
      if (venue === 'comms') {
        const t = e.conversation ? commsThread(c, agent, e.conversation) : null;
        if (!t) continue;
      }
      // The same run told twice: a body's episode beside its run's digest, in the same venue, minutes apart.
      if (runsAt.some((r) => r.agent === agent && r.venue === venue && Math.abs(r.at - ms) < 20 * 60_000)) continue;
      const p = splitTitle(e.title);
      out.push({ id: `e~${agent}~${e.ref}`, agent, at: e.created, ...at(e.created), title: p.title || label, ...(p.line ? { line: p.line } : {}), venue,
        where: whereLabel(e.where) || VENUES[venue] || venue, what: whatOf({ place: e.where, title: e.title }),
        ...(c.ownerPerson && e.where.includes(c.ownerPerson) ? { owner: true as const } : {}) });
    }
  }
  return out.sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : a.id.localeCompare(b.id))).slice(0, MAX_ENTRIES);
}

/** "Weekly Intro Skipper check: no Jellyfin 12.1 build yet" → the check, and what came of it. */
function splitTitle(t: string): { title: string; line?: string } {
  const m = /^(.{6,90}?):\s+(.{4,})$/.exec(t);
  return m && !/^t-\d+$/.test(m[1]) ? { title: m[1], line: m[2] } : { title: t };
}

/** The whole story of one entry, for its reader. */
async function openEntry(c: Ctx, env: NodeJS.ProcessEnv, id: string, shown: ActivityEntry[], github?: string): Promise<ActivityOpen | undefined> {
  const m = /^([dce])~([a-z][a-z0-9-]{0,39})~(.{1,300})$/.exec(id);
  if (!m || !c.h.agents.includes(m[2])) return undefined;
  const [, kind, agent, key] = m;
  const dir = agentDir(c.h, agent);
  const base = shown.find((e) => e.id === id);
  if (kind === 'e') {
    const e = tapeRows(dir, MAX_BACK * 24 + 48, Date.now(), { withContent: true }).find((x) => x.ref === key);
    if (!e) return undefined;
    const venue = venueKey(e.where.split(/[:/]/)[0]);
    // A Comms thread's words are its member's (as collect has it), whatever window the entry was found in.
    if (venue === 'comms' && !(e.conversation && commsThread(c, agent, e.conversation))) return undefined;
    const ms = Date.parse(e.created);
    const entry: ActivityEntry = base ?? { id, agent, at: e.created, day: isoDay(ms, c.tz), hour: hourOf(ms, c.tz), ...splitTitle(e.title), venue,
      where: whereLabel(e.where) || VENUES[venue] || venue, what: whatOf({ place: e.where, title: e.title }) };
    const fb = fallbackParts(e.content ?? '');
    const story = fb ? fb.said : (e.content ?? '').trim();
    const refs = refsIn(`${e.title}\n${e.content ?? ''}`, github);
    return { ...entry, asked: fb?.asked ? [fb.asked] : [], decided: fb?.shipped ?? [], ...(story ? { story } : {}), tasks: refs.tasks.map(taskLink), prs: refs.prs,
      links: [{ label: 'The memory', page: `loom:a/${agent}/memory/${e.ref}` }], more: [] };
  }
  const db = openConversationsReadonly(dir);
  if (!db) return undefined;
  try {
    let d: DigestRow | undefined;
    let cvId = key;
    if (kind === 'd') {
      d = db.prepare('SELECT id, conversation, run, at, summary, asks_json, decisions_json, tasks_json, needs_owner, needs_owner_href FROM conversation_digests WHERE id = ?').get(key) as DigestRow | undefined;
      if (!d) return undefined;
      cvId = d.conversation;
    }
    const cv = db.prepare('SELECT id, venue, place, label, people_json, last, started, last_seq FROM conversations WHERE id = ?').get(cvId) as ConvRow | undefined;
    if (!cv) return undefined;
    const thread = cv.venue === COMMS_VENUE ? commsThread(c, agent, cv.id) : null;
    if (cv.venue === COMMS_VENUE && !thread) return undefined;
    // The newest digest stands for a conversation with none in the window.
    d ??= db.prepare('SELECT id, conversation, run, at, summary, asks_json, decisions_json, tasks_json, needs_owner, needs_owner_href FROM conversation_digests WHERE conversation = ? ORDER BY at DESC LIMIT 1').get(cv.id) as DigestRow | undefined;
    const title = convTitle(c, agent, cv);
    const { venue, where } = convWhere(c, cv);
    const fallback: ActivityEntry = base ?? { id, agent, at: d?.at ?? cv.last, day: isoDay(Date.parse(d?.at ?? cv.last), c.tz), hour: hourOf(Date.parse(d?.at ?? cv.last), c.tz), title, ...(d ? { line: oneLine(d.summary) } : {}), venue, where, what: whatOf({ place: cv.place, title }) };
    const decided = d ? parse<string[]>(d.decisions_json, []) : [];
    const asked = d ? parse<string[]>(d.asks_json, []) : [];
    const tasks = d ? parse<string[]>(d.tasks_json, []) : [];
    const refs = refsIn([d?.summary ?? '', ...decided].join('\n'), github);
    const links: ActivityLink[] = [];
    if (thread) links.push({ label: 'The thread in Comms', href: threadPath(thread.id) });
    // An ask is only whom it's for (a Comms thread's, a spawned job's: its member's; comms.md rule 2; t-2084): anyone
    // else sees what it did, not what it asks. No rule given, no one's.
    const theirs = !!c.seesAsk?.(cv.id, agent);
    if (d?.needs_owner_href && theirs) links.push({ label: 'What it needs you for', href: d.needs_owner_href });
    // The steps of a Comms run (its tool cards), the labels its thread shows: its own member only (commsThread).
    let steps: ActivityOpen['steps'];
    if (thread && d?.run) {
      try {
        // Its steps, not the body's own words between them (`text` cards, t-2109).
        steps = (await messagesOf(c.h, env, thread)).filter((x) => x.kind === 'card' && x.run === d!.run && x.text && String(x.card?.tool ?? '') !== 'text')
          .map((x) => ({ label: x.text!, state: String(x.card?.state ?? ''), tool: String(x.card?.tool ?? '') }));
      } catch { steps = undefined; }
    }
    const more = (db.prepare('SELECT id, at FROM conversation_digests WHERE conversation = ? AND id != ? ORDER BY at DESC LIMIT 8').all(cv.id, d?.id ?? '') as Array<{ id: string; at: string }>)
      .map((x) => ({ id: `d~${agent}~${x.id}`, at: x.at, title }));
    return { ...fallback, asked, decided, ...(d ? { story: d.summary } : {}), tasks: [...new Set([...tasks, ...refs.tasks])].map(taskLink), prs: refs.prs, links,
      ...(d?.needs_owner && theirs ? { needs: d.needs_owner } : {}), ...(steps?.length ? { steps } : {}), more };
  } finally { db.close(); }
}

const list = (v: string | undefined, ok: (s: string) => boolean) => [...new Set((v ?? '').split(',').map((s) => s.trim()).filter((s) => s && ok(s)))].slice(0, 20);

/**
 * Activity for a viewer: the WINDOW_DAYS days ending `query.to` (today in the household's zone by default), each entry
 * they may see, and the one asked for (`query.e`) whole.
 */
export async function activityView(h: Household, query: Record<string, string | undefined>, opts: {
  member?: Member; ownerPerson?: string; ownerLabel: string; tz: string; env: NodeJS.ProcessEnv; nowMs?: number; github?: string;
  seesAsk?: (cv: string, agent: string) => boolean;
}): Promise<ActivityView> {
  const nowMs = opts.nowMs ?? Date.now();
  const today = isoDay(nowMs, opts.tz);
  const oldest = dayBefore(today, MAX_BACK);
  const to = query.to && DAY.test(query.to) && query.to <= today && query.to >= oldest ? query.to : today;
  const days = Array.from({ length: WINDOW_DAYS }, (_, i) => dayBefore(to, i)).filter((d) => d >= oldest);
  // The window's bounds in instants: a day's start in the zone, found from noon UTC that day (a zone is never ±12h off).
  const startOf = (day: string) => {
    const noon = Date.parse(`${day}T12:00:00Z`);
    for (let ms = noon - 15 * 3_600_000; ms <= noon + 15 * 3_600_000; ms += 15 * 60_000) if (isoDay(ms, opts.tz) === day) return ms;
    return noon - 12 * 3_600_000;
  };
  const fromMs = startOf(days[days.length - 1]);
  const untilMs = to === today ? nowMs + 60_000 : startOf(dayBefore(to, -1));
  const c: Ctx = { h, tz: opts.tz, member: opts.member, ownerPerson: opts.ownerPerson, threads: new Map(), seesAsk: opts.seesAsk };
  const entries = collect(c, fromMs, Math.max(untilMs, fromMs + DAY_MS / 24));
  const venues: Record<string, string> = {};
  for (const e of entries) venues[e.venue] = VENUES[e.venue] ?? venueLabel(h.home, e.venue);
  const agents = new Set(h.agents);
  const filters = {
    who: list(query.who, (s) => s === 'owner' || agents.has(s)),
    where: list(query.where, (s) => /^[a-z][a-z0-9-]{0,39}$/.test(s)),
    what: list(query.what, (s) => s === 'conversation' || s === 'work' || s === 'system') as ActivityWhat[],
  };
  const out: ActivityView = { to, days, ...(days[days.length - 1] > oldest ? { earlier: dayBefore(days[days.length - 1]) } : {}), entries,
    owner: { key: 'owner', label: opts.ownerLabel }, venues, filters, ...(query.day && DAY.test(query.day) ? { day: query.day } : {}) };
  if (query.e) {
    const open = await openEntry(c, opts.env, query.e, entries, opts.github);
    if (open) out.open = open; else out.missing = true;
  }
  return out;
}
