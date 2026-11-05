/**
 * The Projects app (docs/specs/projects.md, "loom's page: the Projects app"): an index of every live project, summary
 * first, and each project's hub as a page, computed live. Drawn with loom's existing blocks only, so the web app's
 * first page gains nothing.
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
import { agoText } from './render.js';
import { validPath, type Block, type Page, type Section } from './vocab.js';

export interface ProjectsOwner {
  /** The agent's id in a household, or undefined in a loom without one. */
  agent?: string;
  label?: string;
  dir: string;
}

interface Count { at: number; waiting: number; error?: string }

const CACHE_MS = 60_000;
const INDEX_WAIT_MS = 5_000;
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
    if (s.key === 'conversations' && 'items' in s) {
      waiting += ((s as unknown as { items: Array<{ needs_owner: string | null }> }).items).filter((c) => c.needs_owner).length;
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

async function countOf(o: ProjectsOwner, p: ProjectListEntry, hub: Hub, nowMs: number): Promise<Count> {
  const key = `${o.dir}\0${p.slug}`;
  const hit = counts.get(key);
  if (hit && nowMs - hit.at < CACHE_MS) return hit;
  let result: Count;
  try {
    const h = await hub(o.dir, p.slug, new Date(nowMs - 7 * 86_400_000).toISOString());
    result = h.found && 'sections' in h ? { at: nowMs, ...waitingIn(h.sections) } : { at: nowMs, waiting: 0 };
  } catch (e) {
    result = { at: nowMs, waiting: 0, error: (e as Error).message ?? 'failed' };
  }
  counts.set(key, result);
  return result;
}

export function hubHref(o: ProjectsOwner, slug: string): string {
  return o.agent ? `projects/${o.agent}/${slug}` : `projects/${slug}`;
}

/** The index: one row per live project, what's waiting on you first, then errors, then by activity. */
export async function projectsIndex(owners: ProjectsOwner[], opts: { env?: NodeJS.ProcessEnv; nowMs?: number; hub?: Hub; waitMs?: number } = {}): Promise<Page> {
  const nowMs = opts.nowMs ?? Date.now();
  const hub = opts.hub ?? defaultHub(opts.env ?? process.env);
  const rows: Array<{ o: ProjectsOwner; p: ProjectListEntry }> = [];
  for (const o of owners) {
    try {
      for (const p of listProjects(o.dir, { nowMs })) rows.push({ o, p });
    } catch {
      // An agent whose store can't be read just lists nothing.
    }
  }
  if (!rows.length) {
    return { title: 'Projects', sections: [{ id: 'none', blocks: [{ type: 'text', tone: 'muted',
      text: 'No projects yet. A project is an ongoing body of work with a goal (a product, a client, a season); an agent makes one with project_write, and its page here collects everything filed under it.' }] }] };
  }
  const live = rows.filter((r) => r.p.status === 'active');
  const quiet = rows.filter((r) => r.p.status !== 'active');
  const timeout = new Promise<'late'>((res) => setTimeout(() => res('late'), opts.waitMs ?? INDEX_WAIT_MS).unref?.());
  const counted = await Promise.all(live.map(async (r) => ({ ...r, c: await Promise.race([countOf(r.o, r.p, hub, nowMs), timeout]) })));
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
  return { title: 'Projects', intro: "Each ongoing body of work, and what it's waiting on.", sections };
}

/** Find which owner has a project by name: an agent's id given, that agent's; else the only one that has it. */
export function ownerOf(owners: ProjectsOwner[], slug: string, agent?: string): ProjectsOwner | null {
  if (agent) return owners.find((o) => o.agent === agent) ?? null;
  const has = owners.filter((o) => {
    try {
      return listProjects(o.dir).some((p) => p.slug === slug) || projectAlias(o.dir, slug);
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

const stateWords = (st: { kind: string; days?: number }): string =>
  st.kind === 'ok' ? 'checked' : st.kind === 'stale' ? `stale for ${st.days} days` : 'not checked';

function memoryHref(o: ProjectsOwner, ref: string): string | undefined {
  const p = o.agent ? `a/${o.agent}/memory/${ref}` : `memory/${ref}`;
  return validPath(p) ? p : undefined;
}

/** A feed item's link, as the hub page draws it: its piece's page, or loom's with `loom:`; else its href. */
function feedLink(piece: string, it: { page?: string; href?: string }): { page?: string; href?: string } {
  if (it.page) return { page: it.page.startsWith('loom:') ? it.page.slice('loom:'.length) : `p/${piece}/${it.page}` };
  if (it.href) return { href: it.href };
  return {};
}

function feedRow(piece: string, it: FeedGroup['items'][number], nowMs: number) {
  const meta = [it.when ? agoText(it.when, nowMs) : undefined, ...(it.who ?? []), it.ref].filter(Boolean).join(' · ');
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
    facts.push({ label: k.replace(/_/g, ' '), value: `${env.value} (${stateWords(fieldState(env, nowMs) as { kind: string; days?: number })})` });
  }
  if (facts.length) sections.push({ id: 'card', blocks: [{ type: 'kv', items: facts }] });

  const bySection = (key: string) => h.sections.find((s) => s.key === key);
  const pieces = h.sections.filter((s) => s.key.startsWith('piece:')) as PieceSection[];
  const conv = bySection('conversations') as { items: Array<{ id: string; label: string | null; venue: string; last: string; summary: string | null; needs_owner: string | null; people: string[] }> } | undefined;

  const waiting: Array<Record<string, unknown> & { text: string }> = [];
  for (const s of pieces) {
    const piece = s.key.slice('piece:'.length);
    for (const g of s.groups ?? []) if (g.waiting) for (const it of g.items) waiting.push({ ...feedRow(piece, it, nowMs), meta: [s.label, feedRow(piece, it, nowMs).meta].filter(Boolean).join(' · ') });
  }
  for (const c of conv?.items ?? []) {
    if (c.needs_owner) waiting.push({ text: c.needs_owner, meta: [c.label ?? c.venue, agoText(c.last, nowMs)].filter(Boolean).join(' · '), page: `conversation/${c.id}` });
  }
  if (waiting.length) sections.push({ id: 'waiting', title: 'Waiting on you', tone: 'warn', blocks: [{ type: 'list', wrap: true, items: waiting.slice(0, 200) as never }] });

  for (const s of pieces.slice(0, 6)) {
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
    sections.push({ id: s.key.replace(':', '-'), title: label, blocks: blocks.slice(0, 20) });
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
