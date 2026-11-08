/**
 * The Projects app (docs/specs/projects.md, "loom's page: the Projects app"): an index of every live project as a card
 * each (Jonathan's approved redesign, t-1925), and each project's hub as a page, computed live. The hub is drawn with
 * loom's existing blocks; the index's cards ride beside its page (`projects` in the view's data) and are drawn by their
 * own lazily loaded chunk (web/src/projects.tsx), so the web app's first page gains nothing.
 *
 * The index counts what waits on the owner per project: open `needs_owner` asks in its conversations, and items in
 * feed groups marked `waiting`. To count, it runs each project's feeds (through the same runner and pool as the hub),
 * keeps each project's result 60 s, and waits at most 5 s; the hub page always runs its feeds fresh and never touches
 * that cache.
 */
import { listProjects, projectHubOf, type HubSection, type ProjectHubResult, type ProjectListEntry } from '../tools/project.js';
import { managedPieceSections } from '../project-feeds.js';
import { fieldState } from '../backends/cards.js';
import type { FeedGroup } from '../offers.js';
import { age, agoText } from './render.js';
import { agentName } from './core.js';
import { needsAskKey, needsAskText } from './push.js';
import { openProjectsStore } from '../backends/projects.js';
import type { CardPerson, ProjectCards, ProjectCardView } from './project-cards.js';

export type { CardPerson, ProjectCards, ProjectCardView };
import { splitPage, validPath, type Block, type Page, type Section } from './vocab.js';

export interface ProjectsOwner {
  /** The agent's id in a household, or undefined in a loom without one. */
  agent?: string;
  label?: string;
  dir: string;
}

/** What a card shows from a project's hub, kept with its count (60 s): raw times, so ages are drawn at render. */
interface Gist {
  waitingItems: string[];
  /** Dated things that happened: feed items with a `when`, conversations, memories, notes. Newest first. */
  dated: Array<{ text: string; when: string; status?: string; waiting?: true }>;
  changes?: { open: number; failing: number; running: number };
  people: CardPerson[];
}
interface Count { at: number; waiting: number; error?: string; gist?: Gist }

/** The sparkline's window: the index's `since`, a day a point. */
export const SPARK_DAYS = 7;

const CACHE_MS = 60_000;
/** The index waits this long for counts, however many projects there are (docs/specs/projects.md). */
export const INDEX_WAIT_MS = 5_000;
const counts = new Map<string, Count>();

/** For tests: forget the index's cached counts. */
export function forgetProjectCounts(): void {
  counts.clear();
}

type PieceSection = { key: string; label?: string; groups?: FeedGroup[]; error?: string };

function waitingIn(sections: HubSection[]): { waiting: number; error?: string } {
  let waiting = 0;
  const errors: string[] = [];
  for (const s of sections as PieceSection[]) {
    if (s.key === 'conversations') {
      if (s.error) errors.push('conversations');
      else if ('items' in s) waiting += ((s as unknown as { items: Array<{ needs_owner: string | null }> }).items).filter((c) => c.needs_owner).length;
    } else if (s.key.startsWith('piece:')) {
      if (s.error) errors.push(s.key.slice('piece:'.length));
      for (const g of s.groups ?? []) if (g.waiting) waiting += g.items.length;
    }
  }
  return { waiting, ...(errors.length ? { error: `${errors.join(', ')} couldn't answer` } : {}) };
}

type Hub = (dir: string, slug: string, since?: string) => Promise<ProjectHubResult>;

const defaultHub = (env: NodeJS.ProcessEnv): Hub => (dir, slug, since) =>
  projectHubOf(dir, { slug, ...(since ? { since } : {}) }, { pieceSections: managedPieceSections(env) });

const CHANGES = 'piece:changes';
const DONE_WORDS = /^(merged|closed)$/i;

/** A card's gist from a project's hub sections (what's waiting, what happened, the Changes piece's counts, who). */
export function gistOf(sections: HubSection[], agent?: string): Gist {
  const waitingItems: string[] = [];
  const dated: Gist['dated'] = [];
  // Who, in the card's order: the people section's cards, then feed items' `who`, then conversations' `people`.
  const byKind: [CardPerson[], CardPerson[], CardPerson[]] = [[], [], []];
  let changes: Gist['changes'];
  for (const s of sections as Array<PieceSection & { items?: unknown[] }>) {
    if (s.key === 'conversations' && !s.error) {
      for (const c of (s.items ?? []) as Array<{ needs_owner: string | null; summary: string | null; label: string | null; venue: string; last: string; people: string[] }>) {
        if (c.needs_owner) waitingItems.push(c.needs_owner);
        dated.push({ text: c.summary ?? c.label ?? c.venue, when: c.last, ...(c.needs_owner ? { waiting: true as const } : {}) });
        for (const n of c.people ?? []) byKind[2].push({ name: n });
      }
    } else if (s.key === 'memories' && !s.error) {
      for (const m of (s.items ?? []) as Array<{ snippet: string; created: string }>) dated.push({ text: m.snippet, when: m.created });
    } else if (s.key === 'notes' && !s.error) {
      for (const n of (s.items ?? []) as Array<{ path: string; updated: string }>) dated.push({ text: `Note ${n.path}`, when: n.updated });
    } else if (s.key === 'people' && !s.error) {
      for (const p of (s.items ?? []) as Array<{ slug: string; name: string }>) byKind[0].push({ name: p.name, person: p.slug });
    } else if (s.key.startsWith('piece:') && !s.error) {
      const isChanges = s.key === CHANGES;
      if (isChanges) changes = { open: 0, failing: 0, running: 0 };
      for (const g of s.groups ?? []) {
        for (const it of g.items) {
          if (g.waiting) waitingItems.push(it.title);
          if (it.when) dated.push({ text: it.title, when: it.when, ...(it.status ? { status: it.status } : {}), ...(g.waiting ? { waiting: true as const } : {}) });
          for (const n of it.who ?? []) byKind[1].push({ name: n });
          if (isChanges && changes && !DONE_WORDS.test(it.status ?? '')) {
            changes.open++;
            if (/^CI red/i.test(it.status ?? '')) changes.failing++;
            else if (/^CI running/i.test(it.status ?? '')) changes.running++;
          }
        }
      }
    }
  }
  dated.sort((a, b) => Date.parse(b.when) - Date.parse(a.when));
  const people = new Map<string, CardPerson>();
  for (const p of [...(agent ? [{ name: agent, agent }] : []), ...byKind.flat()]) {
    const k = p.name.trim().toLowerCase();
    if (k && !people.has(k)) people.set(k, p);
  }
  // Every dated thing is kept (the sections' own caps bound them): the activity line counts all of them in its window.
  return { waitingItems, dated: dated.filter((d) => !Number.isNaN(Date.parse(d.when))), ...(changes ? { changes } : {}), people: [...people.values()] };
}

async function countOf(o: ProjectsOwner, p: ProjectListEntry, hub: Hub, nowMs: number): Promise<Count> {
  const key = `${o.dir}\0${p.slug}`;
  const hit = counts.get(key);
  if (hit && nowMs - hit.at < CACHE_MS) return hit;
  let result: Count;
  try {
    const h = await hub(o.dir, p.slug, new Date(nowMs - 7 * 86_400_000).toISOString());
    result = h.found && 'sections' in h ? { at: nowMs, ...waitingIn(h.sections), gist: gistOf(h.sections, o.agent) } : { at: nowMs, waiting: 0 };
  } catch (e) {
    result = { at: nowMs, waiting: 0, error: (e as Error).message ?? 'failed' };
  }
  counts.set(key, result);
  return result;
}

export function hubHref(o: ProjectsOwner, slug: string): string {
  return o.agent ? `projects/${o.agent}/${slug}` : `projects/${slug}`;
}

/** The summary's first sentence (what it is), ≤ 200 chars. */
export function whatOf(summary: string | undefined): string | undefined {
  const t = (summary ?? '').trim().split(/\n\s*\n/)[0].replace(/\s+/g, ' ').trim();
  if (!t) return undefined;
  const m = /^.+?[.!?](?=\s|$)/.exec(t);
  const first = (m ? m[0] : t);
  return first.length > 200 ? `${first.slice(0, 199).replace(/\s+\S*$/, '')}…` : first;
}

function summariesOf(dir: string): Map<string, string | undefined> {
  const out = new Map<string, string | undefined>();
  try {
    const s = openProjectsStore(dir, { readonly: true });
    if (!s) return out;
    try { for (const r of s.rows(false)) out.set(r.raw.slug, r.row?.card?.summary); } finally { s.close(); }
  } catch {
    // A card store that can't be read only leaves the cards' lines out.
  }
  return out;
}

const repoChip = (r: string) => r.replace(/^github:/, '');

/** A card: the project's list entry, its summary, and what its hub said (active projects only). */
function cardOf(o: ProjectsOwner, p: ProjectListEntry, summary: string | undefined, c: Count | 'late' | undefined, nowMs: number): ProjectCardView {
  const gist = c && c !== 'late' ? c.gist : undefined;
  const what = whatOf(summary);
  const card: ProjectCardView = {
    slug: p.slug, name: p.name, page: hubHref(o, p.slug), ...(o.agent ? { agent: o.agent } : {}), status: p.status,
    ...(what ? { what } : {}),
    // What's waiting is said once, above; lately is the rest (the sparkline still counts it).
    lately: (gist?.dated ?? []).filter((d) => !d.waiting).slice(0, 3).map((d) => ({ text: d.text.slice(0, 200), ago: age(d.when, nowMs), ...(d.status ? { status: d.status } : {}) })),
    repos: (p.links.repos ?? []).map(repoChip),
    people: (gist?.people ?? (o.agent ? [{ name: o.agent, agent: o.agent }] : [])).slice(0, 12),
    activity: p.activity,
  };
  if (c !== undefined) {
    card.waiting = c === 'late' ? { unknown: "Couldn't count what's waiting: its sections are slow to answer." }
      : c.error ? { unknown: `Couldn't count what's waiting: ${c.error}.` }
        // The count and the words come from the same walk of the same sections (waitingIn, gistOf).
        : { count: c.waiting, items: (gist?.waitingItems ?? []).slice(0, Math.min(4, c.waiting)).map((t) => t.slice(0, 200)) };
  }
  if (gist?.changes) {
    const ch = gist.changes;
    const state = ch.failing ? `${ch.failing} failing` : ch.running ? `${ch.running} checking` : '';
    card.changes = { ...ch, line: [`${ch.open} open`, state].filter(Boolean).join(' · ') };
  }
  if (gist) {
    const day = 86_400_000;
    const days = Array.from({ length: SPARK_DAYS }, () => 0);
    for (const d of gist.dated) {
      const back = Math.floor((nowMs - Date.parse(d.when)) / day);
      if (back >= 0 && back < SPARK_DAYS) days[SPARK_DAYS - 1 - back]++;
    }
    const total = days.reduce((a, b) => a + b, 0);
    if (total) card.spark = { days, label: `${total} dated things in this project's sections in the last ${SPARK_DAYS} days (its pieces' items, conversations, notes and memories), from ${days[0]} a week ago to ${days[SPARK_DAYS - 1]} today` };
  }
  return card;
}

/**
 * The index: a card per live project, what's waiting on you first, then errors, then by activity. `page` is the same
 * index in loom's blocks (one row per project), for an app too old to draw the cards; `cards` is what the Projects app
 * draws. Without projects there are no cards, and the page says what a project is.
 */
export async function projectsApp(owners: ProjectsOwner[], opts: { env?: NodeJS.ProcessEnv; nowMs?: number; hub?: Hub; waitMs?: number } = {}): Promise<{ page: Page; cards?: ProjectCards }> {
  const nowMs = opts.nowMs ?? Date.now();
  const hub = opts.hub ?? defaultHub(opts.env ?? process.env);
  const rows: Array<{ o: ProjectsOwner; p: ProjectListEntry; summary?: string }> = [];
  for (const o of owners) {
    try {
      const summaries = summariesOf(o.dir);
      for (const p of listProjects(o.dir, { nowMs })) rows.push({ o, p, summary: summaries.get(p.slug) });
    } catch {
      // An agent whose store can't be read just lists nothing.
    }
  }
  if (!rows.length) {
    return { page: { title: 'Projects', sections: [{ id: 'none', blocks: [{ type: 'text', tone: 'muted',
      text: 'No projects yet. A project is an ongoing body of work with a goal (a product, a client, a season); an agent makes one with project_write, and its page here collects everything filed under it.' }] }] } };
  }
  const live = rows.filter((r) => r.p.status === 'active');
  const quiet = rows.filter((r) => r.p.status !== 'active');
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<'late'>((res) => { timer = setTimeout(() => res('late'), opts.waitMs ?? INDEX_WAIT_MS); timer.unref?.(); });
  const counted = await Promise.all(live.map(async (r) => ({ ...r, c: await Promise.race([countOf(r.o, r.p, hub, nowMs), timeout]) })));
  clearTimeout(timer);
  const many = owners.filter((o) => o.agent).length > 1;
  const rank = (c: Count | 'late') => (c !== 'late' && c.waiting > 0 ? 0 : c === 'late' || c.error ? 1 : 2);
  counted.sort((a, b) => rank(a.c) - rank(b.c) || Date.parse(b.p.activity) - Date.parse(a.p.activity));
  const item = (o: ProjectsOwner, p: ProjectListEntry, c?: Count | 'late') => {
    const waiting = c === 'late' ? "couldn't count" : c && c.waiting ? `${c.waiting} waiting on you` : c?.error ? "couldn't count" : undefined;
    const meta = [p.status !== 'active' ? p.status : undefined, waiting, `last activity ${agoText(p.activity, nowMs) || 'a while ago'}`].filter(Boolean).join(' · ');
    return { text: p.name, meta, page: hubHref(o, p.slug), ...(many && o.agent ? { agent: o.agent } : {}),
      ...(c && c !== 'late' && c.waiting ? { tone: 'warn' as const } : {}) };
  };
  const waitingTotal = counted.reduce((n, r) => n + (r.c !== 'late' ? r.c.waiting : 0), 0);
  const sections: Section[] = [
    { id: 'summary', blocks: [{ type: 'stats', items: [
      { label: 'Waiting on you', value: String(waitingTotal), ...(waitingTotal ? { tone: 'warn' as const } : {}) },
      { label: 'Active', value: String(live.length) }] }] },
    { id: 'active', blocks: [{ type: 'list', wrap: true, items: counted.map((r) => item(r.o, r.p, r.c)) }] },
  ];
  if (!live.length) sections.pop();
  if (quiet.length) {
    sections.push({ id: 'quiet', title: 'Paused and done', fold: 'closed', blocks: [{ type: 'list', items: quiet.map((r) => item(r.o, r.p)) }] });
  }
  const cards: ProjectCards = {
    active: counted.map((r) => cardOf(r.o, r.p, r.summary, r.c, nowMs)),
    quiet: quiet.map((r) => cardOf(r.o, r.p, r.summary, undefined, nowMs)),
    waiting: waitingTotal,
  };
  return { page: { title: 'Projects', intro: "Each ongoing body of work, and what it's waiting on.", sections }, cards };
}

/** The index as loom's blocks only (projectsApp's `page`). */
export async function projectsIndex(owners: ProjectsOwner[], opts: { env?: NodeJS.ProcessEnv; nowMs?: number; hub?: Hub; waitMs?: number } = {}): Promise<Page> {
  return (await projectsApp(owners, opts)).page;
}

/** Find which owner has a project by name: an agent's id given, that agent's; else the only one that has it. */
export function ownerOf(owners: ProjectsOwner[], slug: string, agent?: string): ProjectsOwner | null {
  if (agent) return owners.find((o) => o.agent === agent) ?? null;
  const has = owners.filter((o) => {
    try {
      // Archived ones too (by slug), so an archived project's page can say it's archived.
      return listProjects(o.dir, { include_archived: true }).some((p) => p.slug === slug) || projectAlias(o.dir, slug);
    } catch {
      return false;
    }
  });
  return has.length === 1 ? has[0] : null;
}

function projectAlias(dir: string, name: string): boolean {
  try {
    return listProjects(dir).some((p) => (p.links.aliases ?? []).includes(name));
  } catch {
    return false;
  }
}

const stateWords = (st: { kind: string; days?: number }, verified: string | undefined, nowMs: number): string =>
  st.kind === 'ok' ? `checked ${agoText(verified, nowMs) || 'just now'}` : st.kind === 'stale' ? `stale for ${st.days} days` : 'not checked';

function memoryHref(o: ProjectsOwner, ref: string): string | undefined {
  const p = o.agent ? `a/${o.agent}/memory/${ref}` : `memory/${ref}`;
  return validPath(p) ? p : undefined;
}

/**
 * A feed item's link, as the hub page draws it. Every link goes through splitPage, as every other piece link does: a
 * `loom:` one keeps its prefix and is drawn only when splitPage says it's one of loom's pages (CORE_PAGES); a piece's
 * own becomes `p/<piece>/<path>` only when the path is valid. An https href stays an href. Anything else is dropped.
 */
export function feedLink(piece: string, it: { page?: string; href?: string }): { page?: string; href?: string } {
  if (it.page !== undefined) {
    const s = splitPage(it.page);
    if (!s || !validPath(s.path)) return {};
    if (it.page.startsWith('loom:')) return s.core ? { page: it.page } : {};
    if (s.agent || s.household || !/^[a-z][a-z0-9-]{0,39}$/.test(piece)) return {};
    const q = it.page.indexOf('?');
    const link = `p/${piece}${s.path ? `/${s.path}` : ''}${q === -1 ? '' : it.page.slice(q)}`;
    return splitPage(link) ? { page: link } : {};
  }
  if (it.href && /^https:\/\/[^\s<>"]+$/.test(it.href)) return { href: it.href };
  return {};
}

function feedRow(piece: string, it: FeedGroup['items'][number], nowMs: number) {
  // body, folded: after the meta, on its own line (a row runs to two lines, and opens whole when tapped).
  const meta = [[it.when ? agoText(it.when, nowMs) : undefined, ...(it.who ?? []), it.ref].filter(Boolean).join(' · '), it.body]
    .filter(Boolean).join('\n');
  return { text: it.title, ...(meta ? { meta } : {}), ...(it.status ? { badge: it.status } : {}),
    ...(it.person?.[0] ? { person: it.person[0] } : {}), ...feedLink(piece, it) };
}

/** A project's hub as a page; null when there's no such project. */
export async function projectHubPage(o: ProjectsOwner, slug: string, opts: { env?: NodeJS.ProcessEnv; nowMs?: number; hub?: Hub } = {}): Promise<Page | null> {
  const nowMs = opts.nowMs ?? Date.now();
  const hub = opts.hub ?? defaultHub(opts.env ?? process.env);
  let h: ProjectHubResult;
  try {
    h = await hub(o.dir, slug);
  } catch {
    return null;
  }
  if (!h.found) return null;
  if (!('card' in h)) return { title: slug, sections: [{ id: 'archived', blocks: [{ type: 'callout', tone: 'muted', text: 'This project is archived.' }] }] };
  const card = h.card;
  const sections: Section[] = [];
  const facts: Array<{ label: string; value: string }> = [];
  if (card.goal) facts.push({ label: 'Goal', value: card.goal });
  if (card.status && card.status !== 'active') facts.push({ label: 'Status', value: card.status });
  for (const [k, env] of Object.entries(card.where ?? {}).sort(([a], [b]) => a.localeCompare(b))) {
    facts.push({ label: k.replace(/_/g, ' '), value: `${env.value} (${stateWords(fieldState(env, nowMs) as { kind: string; days?: number }, env.verified_at, nowMs)})` });
  }
  if (facts.length) sections.push({ id: 'card', blocks: [{ type: 'kv', items: facts }] });

  const bySection = (key: string) => h.sections.find((s) => s.key === key);
  const pieces = h.sections.filter((s) => s.key.startsWith('piece:')) as PieceSection[];
  const conv = bySection('conversations') as { items: Array<{ id: string; label: string | null; venue: string; last: string; summary: string | null; needs_owner: string | null; needs_digest?: string | null; needs_legacy?: boolean; people: string[] }> } | undefined;

  const waiting: Array<Record<string, unknown> & { text: string }> = [];
  for (const s of pieces) {
    const piece = s.key.slice('piece:'.length);
    for (const g of s.groups ?? []) if (g.waiting) for (const it of g.items) waiting.push({ ...feedRow(piece, it, nowMs), meta: [s.label, feedRow(piece, it, nowMs).meta].filter(Boolean).join(' · ') });
  }
  for (const c of conv?.items ?? []) {
    // The hub's needs_owner is the Inbox's open ask (openNeeds' own test), and it opens there, where it's answered.
    if (c.needs_owner) {
      const text = needsAskText(agentName(o.dir), c.needs_owner, !!c.needs_legacy);
      waiting.push({ text: c.needs_owner, meta: [c.label ?? c.venue, agoText(c.last, nowMs)].filter(Boolean).join(' · '),
        page: c.needs_digest ? `loom:inbox?i=${needsAskKey(text, c.id)}` : `conversation/${c.id}` });
    }
  }
  if (waiting.length) sections.push({ id: 'waiting', title: 'Waiting on you', tone: 'warn', blocks: [{ type: 'list', wrap: true, items: waiting.slice(0, 200) as never }] });

  // Ten sections a page (extensions.md): the core ones present keep their places, and the pieces get the rest; one
  // more than fits is named on the last piece's section, never dropped silently.
  const coreCount = (facts.length ? 1 : 0) + (waiting.length ? 1 : 0)
    + ['people', 'conversations', 'notes', 'memories'].filter((k) => { const x = bySection(k) as { items?: unknown[] } | undefined; return !!x?.items?.length; }).length;
  const room = Math.max(1, 10 - coreCount);
  const shown = pieces.slice(0, room);
  const over = pieces.slice(room).map((s) => s.label ?? s.key.slice('piece:'.length));
  for (const s of shown) {
    const piece = s.key.slice('piece:'.length);
    const label = s.label ?? piece;
    if (s.error) {
      sections.push({ id: s.key.replace(':', '-'), title: label, blocks: [{ type: 'text', tone: 'muted', text: `${label} couldn't answer: ${s.error}` }] });
      continue;
    }
    const blocks: Block[] = [];
    for (const g of (s.groups ?? []).filter((x) => !x.waiting)) {
      blocks.push({ type: 'text', tone: 'muted', text: g.title });
      blocks.push({ type: 'list', wrap: true, items: g.items.map((it) => feedRow(piece, it, nowMs)) });
    }
    if (!blocks.length) blocks.push({ type: 'text', tone: 'muted', text: (s.groups ?? []).length ? 'Only what waits on you, above.' : 'Nothing here.' });
    if (s === shown[shown.length - 1] && over.length) blocks.push({ type: 'text', tone: 'muted', text: `More sections than fit here: ${over.join(', ')}.` });
    sections.push({ id: s.key.replace(':', '-'), title: label, blocks: blocks.length > 20 ? [...blocks.slice(0, 19), blocks[blocks.length - 1]] : blocks });
  }

  const people = bySection('people') as { items: Array<{ slug: string; name: string; field: string; value: unknown; marker: string }> } | undefined;
  if (people?.items.length) {
    sections.push({ id: 'people', title: 'People', blocks: [{ type: 'list', items: people.items.map((p) => ({
      text: p.name, meta: `${p.field.replace(/_/g, ' ')}: ${typeof p.value === 'string' ? p.value : JSON.stringify(p.value)}`, person: p.slug, page: `people/${p.slug}` })) }] });
  }
  if (conv?.items.length) {
    sections.push({ id: 'conversations', title: 'Conversations', blocks: [{ type: 'list', wrap: true, items: conv.items.map((c) => ({
      text: c.summary ?? c.label ?? c.venue, meta: [c.label ?? c.venue, ...c.people.slice(0, 3), agoText(c.last, nowMs)].filter(Boolean).join(' · '),
      page: `conversation/${c.id}` })) }] });
  }
  const notes = bySection('notes') as { items: Array<{ path: string; lifespan: string; updated: string; new: boolean }>; total: number } | undefined;
  if (notes?.items.length) {
    sections.push({ id: 'notes', title: 'Notes', fold: 'closed', blocks: [{ type: 'list', items: notes.items.map((n) => ({
      text: n.path, meta: [n.lifespan, agoText(n.updated, nowMs)].join(' · '), ...(n.new ? { badge: 'new' } : {}) })) },
      ...(notes.total > notes.items.length ? [{ type: 'text' as const, tone: 'muted' as const, text: `${notes.total} notes in all; the newest ${notes.items.length} here.` }] : [])] });
  }
  const mem = bySection('memories') as { items: Array<{ ref: string; category: string; snippet: string; created: string; new: boolean }>; total: number } | undefined;
  if (mem?.items.length) {
    sections.push({ id: 'memories', title: 'Memories', fold: 'closed', blocks: [{ type: 'list', wrap: true, items: mem.items.map((m) => {
      const page = memoryHref(o, m.ref);
      return { text: m.snippet, meta: [m.category, agoText(m.created, nowMs)].join(' · '), ...(m.new ? { badge: 'new' } : {}), ...(page ? { page } : {}) };
    }) }] });
  }
  return { title: card.name, ...(card.summary ? { intro: card.summary.slice(0, 2000) } : {}), sections: sections.slice(0, 10) };
}
