/**
 * The owner's view of a household (docs/specs/household.md, "The page").
 *
 *   /                      Home: every agent, what each is doing, the tape
 *                          across all of them, the commons at a glance
 *   /knowledge[/<slug>]    the commons' knowledge
 *   /people[/<slug>]       the directory, each person with every agent's relationship
 *   /a/<agent>/…           one agent's view (its tape, Mind, its people), plus Setup
 *   /new-agent             add an agent
 *
 * Only the owner sees these (the page is owner-only), which is why a person's
 * page here may show every agent's relationship: an agent's own tools never
 * can.
 */
import { listProjects } from '../tools/project.js';
import { listProposals } from '../backends/proposals.js';
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import BetterSqlite3 from 'better-sqlite3';
import {
  aboutOf, setAboutAsk, addAgent, AGENT_NAME, FACE_EYES, FACE_SHAPES, faceOf, setFace, agentDir, commonsKnowledgePath, createToken, HouseholdError, loadTokens, MARKS, parseRole, removeMember, setAbout, setMark,
  setMember, type Household, type Member,
  markIndexOf,
} from '../household.js';
import { passkeysMadeFrom, revokeTokenAndPasskeys, thePasskeys, ThePasskeys as cap } from './passkey-tokens.js';
import { relayOf } from '../relay-pairs.js';
import { commonsPeoplePath, kindOf } from '../backends/people-household.js';
import { backupRow, readSettings, setSettings, targetString, validateSettings } from '../backup.js';
import { initialsOf, profileLinks, profileTone, reachOf, SERVICE } from './reach.js';
import { BOXES, boxSection, OWN_FILES, readCreed, withPart, withSection, writeCreed, type Box, type Creed } from './identity-edit.js';
import { fieldState, PeopleStore, type CardValue } from '../backends/people.js';
import { resolveSqliteDbPath } from '../config.js';
import { bootstrap } from '../tools/bootstrap.js';
import { knowledgeVerify } from '../tools/knowledge-verify.js';
import { knowledgeWrite, slugify } from '../tools/knowledge-write.js';
import { personWrite } from '../tools/person.js';
import { ago, agentName, uiTimeZone, when, type CoreOptions } from './core.js';
import { tapeRows, whereLabel } from './data.js';
import { validPath, type ActResult, type Block, type Page, type Section, type Tile } from './vocab.js';

const HOME_TAPE = 30;

function agentLink(agent: string, path = ''): string {
  return `loom:a/${agent}${path ? `/${path}` : ''}`;
}

function count(path: string, sql: string, ...args: unknown[]): number {
  if (!existsSync(path)) return 0;
  const db = new BetterSqlite3(path, { readonly: true, fileMustExist: true });
  try { return (db.prepare(sql).get(...args) as { n: number }).n; } catch { return 0; } finally { db.close(); }
}

function value(v: CardValue): string {
  return Array.isArray(v) ? v.join(', ') : String(v);
}

// ─── Home ────────────────────────────────────────────────────────────────────

export function householdHome(h: Household, opts: CoreOptions = {}): { tiles: Tile[]; page: Page } {
  const tz = opts.timeZone ?? uiTimeZone();
  const nowMs = opts.nowMs ?? Date.now();
  const agents = h.agents.map((a) => {
    const dir = agentDir(h, a);
    const tape = tapeRows(dir, 24, nowMs);
    return {
      agent: a,
      name: agentName(dir),
      tape,
      memories: count(resolveSqliteDbPath(dir), "SELECT COUNT(*) AS n FROM memories WHERE archived = 0 AND category != 'episode'"),
    };
  });
  const tape = agents
    .flatMap((x) => x.tape.map((e) => ({ ...e, agent: x.agent, name: x.name })))
    .sort((a, b) => (a.created < b.created ? 1 : -1));
  const pages = count(commonsKnowledgePath(h), "SELECT COUNT(*) AS n FROM pages WHERE status = 'active'");
  const people = count(commonsPeoplePath(h), 'SELECT COUNT(*) AS n FROM people WHERE archived_at IS NULL');

  const sections: Section[] = [
    {
      id: 'agents',
      title: 'Agents',
      blocks: [
        {
          type: 'list',
          items: agents.map((x) => {
            const last = x.tape[0];
            return {
              text: x.name,
              meta: last ? `${ago(last.created, tz, nowMs)} · ${whereLabel(last.where)} · ${last.title}` : 'quiet for a day',
              badge: `${x.tape.length} today`,
              page: agentLink(x.agent),
            };
          }),
        },
        { type: 'link', text: 'Add an agent', page: 'loom:new-agent' },
      ],
    },
    {
      id: 'tape',
      title: 'What\'s happening, everywhere',
      blocks: tape.length
        ? [{
            type: 'list',
            items: tape.slice(0, HOME_TAPE).map((e) => ({
              text: e.title,
              meta: `${e.name} · ${ago(e.created, tz, nowMs)} · ${whereLabel(e.where)}`,
              page: validPath(`a/${e.agent}/memory/${e.ref}`) ? agentLink(e.agent, `memory/${e.ref}`) : undefined,
            })),
          },
          ...(tape.length > HOME_TAPE ? [{ type: 'text' as const, text: `and ${tape.length - HOME_TAPE} more today; each agent's page has its whole tape`, tone: 'muted' as const }] : [])]
        : [{ type: 'text', text: 'Nothing in the last day.', tone: 'muted' }],
    },
    {
      id: 'commons',
      title: 'The commons',
      place: 'side' as const,
      blocks: [
        { type: 'stats', items: [
          { label: 'knowledge pages', value: pages.toLocaleString('en-US'), page: 'loom:knowledge' },
          { label: 'people', value: String(people), page: 'loom:people' },
        ] },
        { type: 'text', text: 'Shared by every agent: facts about the world, and who people are and where to reach them.', tone: 'muted' },
      ],
    },
  ];
  return {
    tiles: [
      { label: 'Agents', value: String(h.agents.length), detail: agents.map((x) => x.name).join(', '), page: '' },
      { label: 'Commons', value: `${pages.toLocaleString('en-US')} pages`, detail: `${people} people`, page: 'knowledge' },
    ],
    page: { title: 'Home', sections },
  };
}

/** One row of the Thread: an episode of one agent's. */
export interface ThreadItem { agent: string; text: string; where: string; created: string; page?: string }

/** Every agent's episodes in the last `hours`, newest first, and the commons' counts. */
export function householdThread(h: Household, hours = 24, nowMs = Date.now()): { items: ThreadItem[]; pages: number; people: number; memories: Record<string, number>; proposals: Record<string, number> } {
  const items: ThreadItem[] = [];
  const memories: Record<string, number> = {};
  const proposals: Record<string, number> = {};
  for (const a of h.agents) {
    const dir = agentDir(h, a);
    for (const e of tapeRows(dir, hours, nowMs)) {
      items.push({ agent: a, text: e.title, where: e.where, created: e.created, page: validPath(`a/${a}/memory/${e.ref}`) ? agentLink(a, `memory/${e.ref}`) : undefined });
    }
    memories[a] = count(resolveSqliteDbPath(dir), "SELECT COUNT(*) AS n FROM memories WHERE archived = 0 AND category != 'episode'");
    try { proposals[a] = listProposals(dir).filter((p) => p.status === 'pending').length; } catch { proposals[a] = 0; }
  }
  items.sort((x, y) => (x.created < y.created ? 1 : -1));
  return {
    items,
    pages: count(commonsKnowledgePath(h), "SELECT COUNT(*) AS n FROM pages WHERE status = 'active'"),
    people: count(commonsPeoplePath(h), 'SELECT COUNT(*) AS n FROM people WHERE archived_at IS NULL'),
    memories,
    proposals,
  };
}

// ─── Knowledge ───────────────────────────────────────────────────────────────

interface PageRow { slug: string; title: string; domain: string; updated: string; sourcing: string | null; body?: string; created_by?: string | null; author?: string | null; verified_at?: string | null }

/** A knowledge page not checked (or, never checked, not written) in this many days needs a check. */
const CHECK_DAYS = 30;

// ─── Knowledge as a reader (t-1925, Jonathan's approved mock 2026-11-06) ─────────────────────────────

/** How fresh a page is: checked lately (fresh), getting on (aging, two thirds of the way to a check), or due a check
 * (unchecked for CHECK_DAYS, or its last check found it stale: Check again asks for one). */
export type Freshness = 'fresh' | 'aging' | 'due';
export interface KnowledgeRow { slug: string; title: string; domain: string; updated: string; verified_at?: string; fresh: Freshness; by?: string;
  /** Confirmed in the last RECENT_DAYS: Knowledge's Recently verified. */
  recent?: true }
export interface KnowledgeOpen extends KnowledgeRow {
  body: string; sourcing?: string;
  sources: Array<{ claim: string; kind: string; locator?: string; href?: string }>;
  /** Other pages that link to this one ([[slug]], knowledge:slug, /knowledge/slug). */
  citedBy: Array<{ slug: string; title: string }>;
  /** Its last check's outcome, when there was one. */
  checked?: { at: string; outcome: string; by?: string };
}
export interface KnowledgeView { total: number; checkDays: number; recentDays: number; pages: KnowledgeRow[]; open?: KnowledgeOpen }

/** How many days back "Recently verified" reaches. */
const RECENT_DAYS = 7;
/** The most pages the reader lists (the whole commons, today 188). */
const READER_MAX = 2000;

/** Every active page's line (title, domain, freshness), and the one asked for whole: Knowledge's own view. */
export function knowledgeView(h: Household, open?: string, opts: CoreOptions = {}): KnowledgeView {
  const nowMs = opts.nowMs ?? Date.now();
  const path = commonsKnowledgePath(h);
  const empty: KnowledgeView = { total: 0, checkDays: CHECK_DAYS, recentDays: RECENT_DAYS, pages: [] };
  if (!existsSync(path)) return empty;
  const db = new BetterSqlite3(path, { readonly: true, fileMustExist: true });
  try {
    // Each page's last check's outcome (a stale one means "check again").
    let last = new Map<number, { at: string; outcome: string; by?: string }>();
    try {
      last = new Map((db.prepare('SELECT v.page_id AS id, v.verified_at AS at, v.outcome AS outcome, v.verifier AS by FROM verifications v JOIN (SELECT page_id, MAX(id) AS m FROM verifications GROUP BY page_id) x ON x.m = v.id').all() as Array<{ id: number; at: string; outcome: string; by: string | null }>)
        .map((r) => [r.id, { at: r.at, outcome: r.outcome, ...(r.by ? { by: r.by } : {}) }]));
    } catch { /* an older store: no verifications table */ }
    const rows = db.prepare(`SELECT id, slug, title, domain, updated, verified_at, created_by, author FROM pages WHERE status = 'active' ORDER BY updated DESC LIMIT ${READER_MAX}`)
      .all() as Array<PageRow & { id: number }>;
    const day = 86_400_000;
    const fresh = (r: { id: number; updated: string; verified_at?: string | null }): Freshness => {
      const at = Date.parse(r.verified_at ?? r.updated);
      const age = (nowMs - at) / day;
      if (last.get(r.id)?.outcome === 'stale' || !(age < CHECK_DAYS)) return 'due';
      return age >= (CHECK_DAYS * 2) / 3 ? 'aging' : 'fresh';
    };
    const recent = (r: { verified_at?: string | null }) => !!r.verified_at && nowMs - Date.parse(r.verified_at) < RECENT_DAYS * day;
    const line = (r: PageRow & { id: number }): KnowledgeRow => ({ slug: r.slug, title: r.title, domain: r.domain, updated: r.updated,
      ...(r.verified_at ? { verified_at: r.verified_at } : {}), fresh: fresh(r), ...(recent(r) ? { recent: true as const } : {}), ...((r.created_by ?? r.author) ? { by: (r.created_by ?? r.author)! } : {}) });
    const out: KnowledgeView = { total: count(path, "SELECT COUNT(*) AS n FROM pages WHERE status = 'active'"), checkDays: CHECK_DAYS, recentDays: RECENT_DAYS, pages: rows.map(line) };
    if (open) {
      const r = db.prepare("SELECT id, slug, title, domain, body, updated, sourcing, created_by, author, verified_at FROM pages WHERE slug = ? AND status = 'active'").get(open) as (PageRow & { id: number }) | undefined;
      if (r) {
        let sources: KnowledgeOpen['sources'] = [];
        try {
          sources = (db.prepare('SELECT claim, source_kind, source_locator FROM citations WHERE page_id = ? LIMIT 40').all(r.id) as Array<{ claim: string; source_kind: string; source_locator: string | null }>)
            .map((c) => ({ claim: c.claim, kind: c.source_kind, ...(c.source_locator ? { locator: c.source_locator } : {}), ...(c.source_locator && /^https?:\/\//.test(c.source_locator) ? { href: c.source_locator } : {}) }));
        } catch { /* no citations table */ }
        const esc = (x: string) => x.replace(/[\\%_]/g, (c) => `\\${c}`);
        const citedBy = db.prepare("SELECT slug, title FROM pages WHERE status = 'active' AND slug != ? AND (body LIKE ? ESCAPE '\\' OR body LIKE ? ESCAPE '\\' OR body LIKE ? ESCAPE '\\') ORDER BY title LIMIT 20")
          .all(r.slug, `%[[${esc(r.slug)}]]%`, `%knowledge:${esc(r.slug)}%`, `%/knowledge/${esc(r.slug)}%`) as Array<{ slug: string; title: string }>;
        const checked = last.get(r.id);
        out.open = { ...line(r), body: (r.body ?? '').slice(0, 20000), ...(r.sourcing ? { sourcing: r.sourcing } : {}), sources, citedBy, ...(checked ? { checked } : {}) };
      }
    }
    return out;
  } finally {
    db.close();
  }
}

// ─── People ──────────────────────────────────────────────────────────────────

function directory(h: Household): PeopleStore | null {
  const path = commonsPeoplePath(h);
  return existsSync(path) ? new PeopleStore({ dbPath: path, readonly: true }) : null;
}

/** Each agent's relationship with a person, for the owner's view. */
function relationships(h: Household, slug: string) {
  return h.agents.flatMap((a) => {
    const path = resolveSqliteDbPath(agentDir(h, a));
    if (!existsSync(path)) return [];
    const st = new PeopleStore({ dbPath: path, readonly: true });
    try {
      const row = st.getRow(slug);
      return row ? [{ agent: a, name: agentName(agentDir(h, a)), row, memories: st.memoriesSince(slug, row.synthesized_at) }] : [];
    } catch { return []; } finally { st.close(); }
  });
}

/** "Robby Wilson" → "RW", "Daniel" → "D": letters only, at most two. */
function initials(name: string): string | undefined {
  const parts = name.split(/\s+/).map((w) => [...w].find((c) => /\p{L}/u.test(c))).filter(Boolean) as string[];
  const out = (parts.length > 1 ? parts[0] + parts[parts.length - 1] : parts[0] ?? '').toUpperCase();
  return out || undefined;
}

const PEOPLE_KINDS = [{ value: '', label: 'Everyone' }, { value: 'people', label: 'People' }, { value: 'agents', label: 'Agents' }];

export function householdPeople(h: Household, query: Record<string, string | undefined> = {}): Page {
  const dir = directory(h);
  if (!dir) return { title: 'People', intro: 'Nobody in the directory yet.', sections: [], add: NEW_PERSON };
  try {
    // The directory is everyone: people and agents (docs/specs/agents-in-people.md).
    const show = query.kind === 'agents' || query.kind === 'people' ? query.kind : '';
    const kinds = new Map(dir.list().map((p) => [p.slug, kindOf(dir.getRow(p.slug)?.card ?? { how: {} })]));
    const list = dir.list().filter((p) => !show || (kinds.get(p.slug) === 'agent') === (show === 'agents'));
    return {
      title: 'People',
      add: NEW_PERSON,
      intro: 'One entry for each person and agent, shared by every agent: who they are and where to reach them. Each agent keeps its own relationship with them.',
      sections: [{ id: 'everyone', blocks: [{ type: 'filters', param: 'kind', options: PEOPLE_KINDS }, {
        type: 'list',
        items: list.map((p) => {
          const rel = relationships(h, p.slug).filter((r) => r.agent !== p.slug).map((r) => r.name);
          const isAgent = kinds.get(p.slug) === 'agent';
          const flag = [p.stale ? `${p.stale} stale` : '', p.unverified ? `${p.unverified} unverified` : ''].filter(Boolean).join(' · ');
          return {
            text: p.name,
            avatar: initials(p.name),
            meta: [isAgent ? (h.agents.includes(p.slug) ? 'agent in this household' : 'agent') : '',
              rel.length ? `known to ${rel.join(', ')}` : 'no agent has a relationship yet'].filter(Boolean).join(' · '),
            badge: flag || undefined,
            tone: flag ? 'warn' as const : undefined,
            page: validPath(`people/${p.slug}`) ? `loom:people/${p.slug}` : undefined,
          };
        }),
      }] }],
    };
  } finally {
    dir.close();
  }
}

/** The contacts app shares the directory and person page with the classic view. No private agent memories are added. */
export function householdPeopleApp(h: Household, query: Record<string, string | undefined> = {}, slug?: string, opts: { projects?: boolean } = {}) {
  const page = householdPeople(h);
  const list = page.sections.flatMap((s) => s.blocks).find((b) => b.type === 'list');
  const dir = directory(h);
  try {
    const rows = list?.type === 'list' ? list.items.map((i) => {
      const slug = i.page?.replace(/^loom:people\//, '') ?? '';
      return { slug, name: i.text, meta: i.meta, badge: i.badge,
        kind: dir && kindOf(dir.getRow(slug)?.card ?? { how: {} }) === 'agent' ? 'agent' : 'person' };
    }).filter((i) => i.slug) : [];
    const selected = slug ?? query.p;
    return { rows, q: query.q ?? '', kind: query.kind ?? '',
      ...(selected && /^[a-z0-9][a-z0-9-]*$/.test(selected) ? { selected, open: householdPerson(h, selected, opts) } : {}) };
  } finally { dir?.close(); }
}

/** The start of a text, cut at a sentence (or a word) near n characters. */
function gist(text: string, n: number): string {
  const one = text.replace(/\s+/g, ' ').trim();
  if (one.length <= n) return one;
  const cut = one.slice(0, n);
  const end = Math.max(cut.lastIndexOf('. '), cut.lastIndexOf('; '));
  return end > n / 2 ? cut.slice(0, end + 1) : `${cut.slice(0, cut.lastIndexOf(' '))}…`;
}

export function householdPerson(h: Household, slug: string, opts: CoreOptions & { projects?: boolean } = {}): Page {
  const tz = opts.timeZone ?? uiTimeZone();
  const nowMs = opts.nowMs ?? Date.now();
  const dir = directory(h);
  if (!dir) return { title: 'Not found', sections: [] };
  try {
    // A merged slug's page is the card it was merged into (person_merge).
    slug = dir.resolve(slug);
    const d = dir.getRow(slug);
    if (!d) return { title: 'Not found', sections: [] };
    const facts = Object.entries(d.card.how ?? {}).filter(([k, v]) => !(k === 'kind' && v === 'person'));
    const sections: Section[] = [];
    // The board's order: how each agent knows them (every agent, met or not), then how to reach them.
    const rels = new Map(relationships(h, slug).map((r) => [r.agent, r]));
    // An agent's own entry: its pages are a tap away, and it isn't listed as knowing itself.
    const own = h.agents.includes(slug);
    // A member's entry says what they own (docs/specs/owners.md).
    const member = h.members.find((m) => m.person === slug);
    // Who they are first, as a profile (Jonathan, 2026-10-29: 000h's profile card "might be rad to do here"): their
    // colour, name and summary; what they are; how many agents know them and ways there are to reach them.
    const others = h.agents.filter((a) => a !== slug);
    const ways = Object.keys(d.card.where ?? {}).filter((k) => k in SERVICE).length;
    const role = d.card.how?.role;
    sections.push({ id: 'profile', blocks: [{
      type: 'profile', name: d.card.name,
      ...(own ? { agent: slug } : { tone: profileTone(slug), ...(initialsOf(d.card.name) ? { initials: initialsOf(d.card.name) } : {}) }),
      ...(own && agentBio(h, slug) ? { summary: agentBio(h, slug) } : d.card.summary ? { summary: gist(d.card.summary, 320) } : role ? { summary: value(role) } : {}),
      badges: [
        own ? 'Agent in this household' : kindOf(d.card) === 'agent' ? 'Agent' : 'Person',
        ...(member ? [member.agents === '*' ? 'Household owner' : 'Agent owner'] : []),
      ],
      stats: [
        ...(others.length ? [{ label: own || kindOf(d.card) === 'agent' ? 'agents know it' : 'agents know them', value: `${others.filter((a) => rels.has(a)).length} of ${others.length}` }] : []),
        { label: ways === 1 ? 'way to reach' : 'ways to reach', value: String(ways) },
      ],
      links: [...(own ? [{ text: `${d.card.name}'s pages`, page: agentLink(slug) }] : []), ...profileLinks(d.card.where)],
    }] });
    if (member) {
      sections.push({ id: 'owns', title: 'Owns', blocks: [{ type: 'list', items: member.agents === '*'
        ? [{ text: 'The household, and every agent in it', meta: 'household owner', page: 'loom:members' }]
        : member.agents.map((a) => ({ agent: a, text: agentName(agentDir(h, a)), meta: 'agent owner', page: agentLink(a) })) }] });
    }
    sections.push({ id: 'agents', title: own || kindOf(d.card) === 'agent' ? 'How each agent knows it' : 'How each agent knows them', blocks: [{
      type: 'list', wrap: true,
      items: h.agents.filter((a) => a !== slug).map((a) => {
        const r = rels.get(a);
        if (!r) return { agent: a, text: 'Hasn\'t met them' };
        const how = Object.entries(r.row.card.how ?? {}).map(([k, v]) => `${k}: ${value(v)}`).join(' · ');
        // A line or two here, as the board has it; all of it is on that agent's own card.
        const known = gist(r.row.card.summary || how || 'Knows of them; nothing more yet.', 600);
        const newer = r.memories ? `${r.memories} newer memor${r.memories === 1 ? 'y' : 'ies'} · ` : '';
        return { agent: a, text: known, meta: `${newer}updated ${ago(r.row.updated, tz, nowMs)}`, tone: r.memories ? 'warn' as const : undefined, page: agentLink(a, `people/${slug}`) };
      }),
    }] });
    const { reach, facts: placed } = reachOf(d.card.where, value, (iso) => ago(iso, tz, nowMs), nowMs);
    if (reach) sections.push(reach);
    if (facts.length || placed.length) sections.push({ id: 'facts', title: 'Facts', blocks: [{ type: 'kv', items: [
      ...placed,
      ...facts.map(([k, v]) => ({ label: k, value: value(v) })),
    ] }] });
    const projects = opts.projects === false ? [] : h.agents.flatMap((a) => {
      try { return listProjects(agentDir(h, a)).filter((p) => own && a === slug || [p.slug, ...(p.links.aliases ?? [])].some((name) => Object.hasOwn(d.card.where, name.replace(/-/g, '_')) || Object.hasOwn(rels.get(a)?.row.card.where ?? {}, name.replace(/-/g, '_'))))
        .map((p) => ({ text: p.name, meta: p.status, page: `loom:projects/${a}/${p.slug}` })); } catch { return []; }
    });
    if (opts.projects !== false) sections.push({ id: 'projects', title: 'Projects', blocks: projects.length ? [{ type: 'list', items: projects }] : [{ type: 'text', text: 'No linked projects.', tone: 'muted' }] });
    return { title: d.card.name, sections };
  } finally {
    dir.close();
  }
}

// ─── An agent's Setup ────────────────────────────────────────────────────────

/**
 * What an agent's profile says about it: its entry in People when it has a summary there (written about it, in the
 * third person: "the household's second agent…"), else another agent's card about it, else its identity's opening
 * paragraph (written to it: "You are…").
 */
export function agentBio(h: Household, agent: string): string | undefined {
  // Its owner's description on its Setup first: the household's word for it.
  const own = aboutOf(h, agent);
  if (own) return own;
  const dir = directory(h);
  let summary: string | undefined;
  try { summary = dir?.getRow(agent)?.card.summary?.trim() || undefined; } catch { /* no entry */ } finally { dir?.close(); }
  // Else another agent's word for it (how Art knows Mark): about it, as the entry would be.
  if (!summary) summary = relationships(h, agent).find((r) => r.agent !== agent && r.row.card.summary?.trim())?.row.card.summary?.trim();
  if (!summary) {
    let md = '';
    try { md = readFileSync(join(agentDir(h, agent), 'IDENTITY.md'), 'utf-8'); } catch { /* none */ }
    summary = identityFacts(md).bio;
  }
  return summary ? gist(summary, 400) : undefined;
}

/** An identity's bio (the paragraph under its title) and voice (its Voice or Communication section's first paragraph). */
export function identityFacts(md: string): { bio?: string; voice?: string } {
  const para = (body: string) => body.trim().split(/\n\s*\n/)[0]?.replace(/\s+/g, ' ').trim() || undefined;
  const bio = /^#\s+.+\n+([\s\S]*?)(?=\n#{1,2}\s|$)/.exec(md.trim());
  const voice = /^##\s+(?:Voice|Communication|How you talk)\s*\n([\s\S]*?)(?=\n#{1,2}\s|$)/m.exec(md);
  return { bio: bio ? para(bio[1]) : undefined, voice: voice ? para(voice[1]) : undefined };
}

/** "4m ago", "3 days ago": how long since, for a token's last use. */
function since(iso: string | undefined, nowMs: number): string {
  const t = iso ? Date.parse(iso) : NaN;
  if (Number.isNaN(t)) return 'never';
  const m = Math.max(0, Math.round((nowMs - t) / 60000));
  return m < 1 ? 'just now' : m < 60 ? `${m}m ago` : m < 2880 ? `${Math.round(m / 60)}h ago` : `${Math.round(m / 1440)} days ago`;
}

export function agentSetup(h: Household, agent: string, opts: CoreOptions & { ownerTokens?: boolean } = {}): Page {
  const tz = opts.timeZone ?? uiTimeZone();
  const nowMs = opts.nowMs ?? Date.now();
  const dir = agentDir(h, agent);
  const { creed } = readCreed(dir);
  const harnesses = (() => { try { return readdirSync(join(dir, 'harnesses')).filter((f) => f.endsWith('.md')).map((f) => f.slice(0, -3)); } catch { return []; } })();
  const agentOf = (role: string) => { const r = parseRole(role); return r?.kind === 'agent' ? r.agent : null; };
  // The owner's tokens show on the default agent's Setup, to a household owner only (docs/specs/owners.md).
  const tokens = loadTokens(h.home).filter((t) => agentOf(t.role) === agent || (opts.ownerTokens !== false && agent === h.default && t.role === 'owner'));
  const live = tokens.filter((t) => !t.revoked).sort((a, b) => (b.last_used ?? '').localeCompare(a.last_used ?? ''));
  const db = resolveSqliteDbPath(dir);
  const dbSize = (() => { try { return statSync(db).size; } catch { return 0; } })();
  const memories = count(db, "SELECT COUNT(*) AS n FROM memories WHERE archived = 0 AND category != 'episode'");
  const born = firstWritten(db);
  const last = tapeRows(dir, 72, nowMs)[0];
  const lastMs = last ? Date.parse(last.created) : NaN;
  return {
    title: `${agentName(dir)} · Setup`,
    sections: [
      { id: 'health', title: 'Health', blocks: [{ type: 'status', items: [
        { label: 'Memory', tone: memories ? 'ok' : 'warn', text: memories ? 'OK' : 'empty', meta: `${memories.toLocaleString('en-US')} · ${(dbSize / 1048576).toFixed(0)} MB` },
        { label: 'Last active', tone: Number.isNaN(lastMs) ? 'warn' : nowMs - lastMs < 86_400_000 ? 'ok' : 'warn',
          text: Number.isNaN(lastMs) ? 'nothing in 3 days' : since(last.created, nowMs), ...(last ? { meta: whereLabel(last.where) } : {}) },
        { label: 'Tokens', tone: live.length ? 'ok' : 'warn', text: `${live.length} live`, meta: live.length ? `used ${since(live[0].last_used, nowMs)}` : 'none' },
        // The household's nightly backup (src/backup.ts), on the default agent's Setup, to a household owner.
        ...(agent === h.default && opts.ownerTokens === true ? [backupRow(h, nowMs, (iso) => since(iso, nowMs))] : []),
      ] }] },
      // Who it is: the boxes someone filling in their own agent from scratch fills (Jonathan, 2026-10-30). The creed is
      // the owner's (the agent can't change it); a household owner edits it here, an agent owner reads it.
      ...whoItIs(h, agent, creed, opts.ownerTokens !== false, {
        ...(born ? { born: new Intl.DateTimeFormat('en-US', { month: 'short', year: 'numeric', timeZone: tz }).format(new Date(born)) } : {}),
        harnesses: harnesses.join(', ') || 'none',
      }),
      // Who it may relay to without asking: the runtime's permissions (agent-runtime.md, "Agent-to-agent relay"),
      // read here; the household owner sets them on the runtime's page.
      { id: 'relay', title: 'Who it may write to', place: 'side' as const, blocks: (() => {
        const others = h.agents.filter((a) => a !== agent);
        const { authority, to } = relayOf(h.home, h.agents, agent);
        const text = !others.length ? 'There\'s no other agent to write to.'
          : !authority ? 'No runtime is installed, so it has no relay tool.'
          : `It relays to these without asking (the relay tool); to any other, it asks you first. ${to.length ? `Now: ${to.join(', ')}.` : 'Now: nobody.'} Who may relay to whom is set on the ${authority} piece's page (Permissions).`;
        return [{ type: 'text' as const, tone: 'muted' as const, text }];
      })() },
      { id: 'tokens', title: 'Tokens', blocks: (() => {
        // A house's own token ("art · house h-123 on loom"): one per house, revoked when the house ends, so hundreds of
        // them. Folded to a line each way (Jonathan, 2026-10-30: plain words over ids); the rest are a row each.
        const HOUSE = /^(.+?) · house h-\d+ on (.+)$/;
        const isHouse = (t: { label: string }) => HOUSE.test(t.label);
        // A passkey's own token (t-1969) says what it was made from; a token passkeys were made from offers to take them too.
        const counts = passkeysMadeFrom(h);
        const madeFrom = (t: typeof live[number]) => counts.get(t.sha256) ?? 0;
        const row = (t: typeof live[number]) => {
          const n = madeFrom(t);
          return {
            text: isHouse(t) ? `A house on ${HOUSE.exec(t.label)![2]}` : t.label,
            meta: `${t.role === 'owner' ? 'owner · ' : ''}${t.from !== undefined ? `made from "${t.from}" · ` : ''}used ${since(t.last_used, nowMs)}${n ? ` · ${n} passkey${n === 1 ? '' : 's'} made from it` : ''}`,
            act: { action: 'revoke-token', label: 'Revoke', tone: 'danger' as const, confirm: n ? `Anything still using it is signed out at once. ${cap(n)} made from it ${n === 1 ? 'isn\'t' : 'aren\'t'} touched. You can make a new one.` : 'Anything still using it is signed out at once. You can make a new one.', fields: { label: t.label } },
          };
        };
        const own = live.filter((t) => !isHouse(t)), houses = live.filter(isHouse);
        const gone = tokens.filter((t) => t.revoked), goneHouses = gone.filter(isHouse).length, goneOwn = gone.filter((t) => !isHouse(t));
        return [
          own.length ? { type: 'list' as const, items: own.slice(0, 50).map(row) } : { type: 'text' as const, text: 'No tokens of its own yet.', tone: 'muted' as const },
          // Revoke leaves a token's passkeys working; this takes them too.
          ...(own.some((t) => madeFrom(t)) ? [{ type: 'details' as const, summary: 'Revoke a token with its passkeys', blocks: [{ type: 'list' as const, items: own.filter((t) => madeFrom(t)).slice(0, 50).map((t) => {
            const n = madeFrom(t);
            return { text: t.label, meta: `${n} passkey${n === 1 ? '' : 's'} made from it`,
              act: { action: 'revoke-token', label: 'Revoke with its passkeys', tone: 'danger' as const, confirm: `Anything using it is signed out, and ${thePasskeys(n)} made from it ${n === 1 ? 'is' : 'are'} removed.`, fields: { label: t.label, passkeys: 'with' } } };
          }) }] }] : []),
          ...(houses.length ? [{ type: 'details' as const, summary: `${houses.length} house${houses.length === 1 ? '' : 's'} running`, meta: 'each holds its own token, revoked when it ends',
            blocks: [{ type: 'list' as const, items: houses.slice(0, 50).map(row) }] }] : []),
          ...(gone.length ? [{ type: 'details' as const, summary: `${gone.length} revoked`, blocks: [
            ...(goneOwn.length ? [{ type: 'list' as const, items: goneOwn.slice(0, 200).map((t) => ({ text: t.label, meta: `revoked ${when(t.revoked!, tz)}`, tone: 'muted' as const })) }] : []),
            ...(goneHouses ? [{ type: 'text' as const, tone: 'muted' as const, text: `And ${goneHouses} house token${goneHouses === 1 ? '' : 's'}, revoked as their houses ended.` }] : []),
          ] }] : []),
        { type: 'details', summary: 'Create token', blocks: [{ type: 'form', action: 'create-token', submit: 'Create token', hidden: { agent },
          note: 'Shown once. Give it to the harness or house that will be this agent; loom keeps only its fingerprint.',
          fields: [{ name: 'label', label: 'Label', kind: 'text', hint: 'Where it goes, e.g. "Art · laptop".', required: true }] }] },
        ];
      })() },
      // The nightly backup's settings (src/backup.ts): the household owner's, on the default agent's Setup.
      ...(agent === h.default && opts.ownerTokens === true ? [backupSection(h)] : []),
    ],
  };
}

/** Setup's Backup section: the form loom backup set is, filled with what's set. */
function backupSection(h: Household) {
  const { settings: s } = readSettings(h);
  return { id: 'backup', title: 'Nightly backup', place: 'side' as const, blocks: [
    { type: 'text' as const, tone: 'muted' as const, text: 'Each night loom exports the household, encrypted to your keys, checks it restores, and writes it to a git repo it owns (one commit) or a directory. It pushes with this machine\'s own git login.' },
    { type: 'details' as const, summary: s ? 'Change it' : 'Set it up', blocks: [{ type: 'form' as const, action: 'backup-set', submit: 'Save', fields: [
      { name: 'target', label: 'Where', kind: 'text' as const, required: true, ...(s ? { value: targetString(s.target) } : {}), hint: 'git:https://github.com/you/backup.git, or path:/mnt/usb' },
      { name: 'recipients', label: 'Your keys', kind: 'text' as const, required: true, ...(s ? { value: s.recipients.join(' ') } : {}), hint: 'age public keys (age1…), separated by spaces' },
      { name: 'at', label: 'At', kind: 'text' as const, value: s?.at ?? '03:00', hint: 'HH:MM, 24-hour' },
      { name: 'tz', label: 'Time zone', kind: 'text' as const, value: s?.tz ?? uiTimeZone() },
      { name: 'keep', label: 'Nights kept', kind: 'text' as const, value: String(s?.keep ?? 7), hint: 'besides each month\'s first' },
      { name: 'required', label: 'Pieces it must hold', kind: 'text' as const, ...(s?.required.length ? { value: s.required.join(' ') } : {}), hint: 'optional, e.g. box secrets' },
    ] }] },
  ] };
}

/**
 * Setup's "Who it is", "Its creed" and "Its own": the boxes (a description the household sees, what it's for, its voice,
 * its rules, when it asks first) and its color; every other section of its creed, each in its own fold; and the files
 * it keeps itself (self-model, preferences), to read. `edit` false (an agent owner) shows the same, read-only.
 */
function whoItIs(h: Household, agent: string, creed: Creed, edit: boolean, facts: { born?: string; harnesses: string }): Section[] {
  const dir = agentDir(h, agent);
  const box = (b: Box) => boxSection(creed, b)?.body ?? '';
  const boxed = new Set((Object.keys(BOXES) as Box[]).map((b) => boxSection(creed, b)?.header).filter(Boolean));
  const rest = creed.sections.filter((x) => !boxed.has(x.header));
  const about = aboutOf(h, agent) ?? '';
  const known = { type: 'kv' as const, items: [...(facts.born ? [{ label: 'Born', value: facts.born }] : []), { label: 'Harnesses', value: facts.harnesses }] };
  const people = { type: 'list' as const, items: [{ text: 'Its entry in People', meta: 'where to reach it, and how the other agents know it', page: validPath(`people/${agent}`) ? `loom:people/${agent}` : undefined }] };
  // Settings as a panel (Jonathan, 2026-11-03: "app panels, not web forms"): each part says what it is now, and a tap
  // opens a sheet to change that one part. Its look (colour, shape, eyes) applies at once.
  const face = faceOf(h, agent);
  const part = (name: 'about' | 'purpose' | 'voice' | 'rules' | 'ask', label: string, value: string, hint: string) => ({
    label, value: value.trim() || 'Not written yet',
    edit: { action: 'identity-set', title: label, hidden: { agent }, note: hint, fields: [{ name, label, kind: 'textarea' as const, value, ...(name === 'purpose' ? { required: true } : {}) }] },
  });
  const who: Section = { id: 'who', title: 'Who it is', blocks: edit ? [
    { type: 'panel', title: 'Its look', rows: [
      { label: 'Colour', value: MARKS[markIndexOf(h, agent)].name, edit: { action: 'mark-set', title: 'Its colour', submit: 'Use this colour', hidden: { agent },
        fields: [{ name: 'mark', label: 'Colour', kind: 'choice', value: String(markIndexOf(h, agent)), options: MARKS.map((m, i) => ({ value: String(i), label: m.name, swatch: m.bg })) }] } },
      { label: 'Shape', choice: { action: 'face-set', name: 'shape', value: face.shape, fields: { agent }, options: FACE_SHAPES.map((x) => ({ value: x, label: x[0].toUpperCase() + x.slice(1) })) } },
      { label: 'Eyes', choice: { action: 'face-set', name: 'eyes', value: face.eyes, fields: { agent }, options: [{ value: 'dot', label: 'Round' }, { value: 'oval', label: 'Oval' }] } },
    ] },
    { type: 'panel', title: 'Its words', rows: [
      part('about', 'Description', about, 'A line or two the household sees on its profile. It doesn\'t read this; what it\'s for, below, it does.'),
      part('purpose', 'What it\'s for', creed.purpose, 'The opening of its creed: who it is and what it does, in its own words ("You are …").'),
      part('voice', 'Voice', box('voice'), 'How it talks.'),
      part('rules', 'Rules', box('rules'), 'The lines it never crosses, one per line. Empty: none written.'),
      part('ask', 'When to ask first', box('ask'), 'What needs your OK before it acts, and what it may do on its own.'),
    ] },
    known, people,
  ] : [
    { type: 'kv', items: [
      ...(about ? [{ label: 'Description', value: about }] : []),
      { label: 'What it\'s for', value: creed.purpose || '(not written)' },
      ...(box('voice') ? [{ label: 'Voice', value: box('voice') }] : []),
      ...(box('rules') ? [{ label: 'Rules', value: box('rules') }] : []),
      ...(box('ask') ? [{ label: 'When to ask first', value: box('ask') }] : []),
    ] },
    known, people,
  ] };
  const sections: Section[] = [who];
  sections.push({ id: 'creed', title: 'Its creed', blocks: [
    { type: 'text', tone: 'muted', text: edit
      ? `The rest of what ${creed.title || agent} reads first in every session. Yours to change: it can't change its creed itself.`
      : `The rest of what ${creed.title || agent} reads first in every session.` },
    ...rest.slice(0, 17).map((x): Block => ({ type: 'details', summary: x.header, blocks: edit
      ? [{ type: 'form', action: 'identity-section-set', submit: 'Save', hidden: { agent, section: x.header },
          note: 'Saving it empty removes the section.', fields: [{ name: 'body', label: x.header, kind: 'textarea', value: x.body }] }]
      : [{ type: 'prose', text: x.body.slice(0, 19_000) }] })),
    ...(edit ? [{ type: 'details' as const, summary: 'Add a section', blocks: [{ type: 'form' as const, action: 'identity-section-add', submit: 'Add', hidden: { agent }, fields: [
      { name: 'heading', label: 'Heading', kind: 'text' as const, required: true },
      { name: 'body', label: 'What it says', kind: 'textarea' as const, required: true }] }] }] : []),
  ] });
  // Its own: kept by it as it learns (update_identity edits only these), so here they're read, never edited.
  sections.push({ id: 'own', title: 'Its own', blocks: [
    { type: 'text', tone: 'muted', text: `${creed.title || agent} keeps these itself as it learns. They're here to read; it changes them.` },
    ...OWN_FILES.map(({ file, label, about: what }): Block => {
      let md = '';
      try { md = readFileSync(join(dir, file), 'utf-8'); } catch { /* not written yet */ }
      return { type: 'details', summary: label, meta: what, blocks: [md.trim() ? { type: 'prose', text: md.slice(0, 19_000) } : { type: 'text', tone: 'muted', text: 'Not written yet.' }] };
    }),
  ] });
  return sections;
}

/** When the agent's first memory was written (its birthday, as far as loom knows). */
function firstWritten(db: string): string | undefined {
  if (!existsSync(db)) return undefined;
  const d = new BetterSqlite3(db, { readonly: true, fileMustExist: true });
  try { return (d.prepare('SELECT MIN(created) AS c FROM memories').get() as { c: string | null }).c ?? undefined; } catch { return undefined; } finally { d.close(); }
}

// ─── Adding an agent ─────────────────────────────────────────────────────────

/** How a new agent talks, as the board offers it: a word, and the line its creed gets. */
const VOICES: Record<string, string> = {
  dry: 'Dry: few words, deadpan, says the useful thing and stops.',
  warm: 'Warm: friendly and encouraging, explains a little more than it has to.',
  terse: 'Terse: the shortest answer that\'s right. No preamble.',
};

// ─── The boards' "+": a person, a fact ───────────────────────────────────────

const NEW_PERSON = { page: 'loom:new-person', label: 'Add a person' };
const CHANNELS = ['slack', 'discord', 'email', 'phone', 'github'];

export function newPersonPage(): Page {
  return { title: 'Add a person', intro: 'One entry, shared by every agent: who they are and where to reach them. Each agent keeps its own relationship.', sections: [{ id: 'form', blocks: [{
    type: 'form', action: 'person-add', submit: 'Add',
    fields: [
      { name: 'name', label: 'Name', kind: 'text', required: true },
      { name: 'summary', label: 'Who they are', kind: 'textarea', hint: 'A line or two, e.g. "Runs the community-center box."' },
      { name: 'channel', label: 'Reach them on', kind: 'choice', value: '', options: [{ value: '', label: '(not yet)' }, ...CHANNELS.map((c) => ({ value: c, label: c }))] },
      { name: 'handle', label: 'Their handle or address there', kind: 'text' },
    ],
  }] }] };
}

/** The sheet that says what a member owns: every agent and the household, or some agents, by name. */
function ownsEdit(h: Household, person: string, agents: Member['agents']) {
  return {
    action: 'member-set', title: 'What they own', submit: 'Save', hidden: person ? { person } : undefined,
    fields: [
      { name: 'scope', label: 'They own', kind: 'segmented' as const, value: agents === '*' ? 'all' : 'some',
        options: [{ value: 'all', label: 'Everything' }, { value: 'some', label: 'Some agents' }] },
      { name: 'agents', label: 'Which agents (for "Some agents")', kind: 'checks' as const, value: agents === '*' ? '' : agents.join(','),
        options: h.agents.map((a) => ({ value: a, label: agentName(agentDir(h, a)) })) },
    ],
  };
}

/** Members (docs/specs/owners.md): who owns what, adding or changing one, and a sign-in link for each. A household owner's page. */
export function householdMembers(h: Household): Page {
  const dir = directory(h);
  try {
    const nameOf = (slug: string) => dir?.getRow(slug)?.card.name ?? slug;
    const all = h.members.filter((m) => m.agents === '*').length;
    const owns = (m: Member) => m.agents === '*' ? 'every agent, and the household' : m.agents.map((a) => agentName(agentDir(h, a))).join(', ');
    const people = (dir?.list() ?? []).filter((p) => kindOf(dir!.getRow(p.slug)?.card ?? { how: {} }) === 'person');
    return {
      title: 'Members',
      intro: 'The people who own this household\'s agents. A household owner owns every agent and the shared things; an agent owner, only their agents.',
      sections: [
        // Members as a panel (Jonathan, 2026-11-03): each member a row saying what they own; a tap opens what you can do
        // about them. "What they own" is a choice and the agents by name, never ids typed into a box.
        { id: 'members', blocks: [{ type: 'panel', rows: [
          ...h.members.map((m) => ({
            label: nameOf(m.person), value: `Owns ${owns(m)}`,
            sheet: { title: nameOf(m.person), blocks: [
              { type: 'panel' as const, rows: [
                { label: 'What they own', value: owns(m), edit: ownsEdit(h, m.person, m.agents) },
                { label: 'A sign-in link', value: 'One sign-in within 10 minutes, as them. Send it; they can add a passkey once they\'re in.',
                  act: { action: 'member-link', label: 'Make one', fields: { person: m.person } } },
                ...(validPath(`people/${m.person}`) ? [{ label: 'Their entry in People', page: `loom:people/${m.person}` }] : []),
                // The last household owner stays: someone owns the shared things.
                ...(m.agents === '*' && all === 1 ? [] : [{ label: 'Remove from the household', value: 'Signed out everywhere; their tokens stop working.',
                  act: { action: 'member-remove', label: 'Remove', tone: 'danger' as const, fields: { person: m.person }, confirm: `${nameOf(m.person)} is signed out everywhere, and their tokens stop working.` } }]),
              ] },
            ] },
          })),
          ...(people.some((p) => !h.members.some((m) => m.person === p.slug)) ? [{
            label: 'Add a member', value: 'Someone in People, and what they own',
            edit: { ...ownsEdit(h, '', '*'), title: 'Add a member', submit: 'Add', fields: [
              { name: 'person', label: 'Who', kind: 'choice' as const, required: true, value: people.find((p) => !h.members.some((m) => m.person === p.slug))!.slug,
                options: people.filter((p) => !h.members.some((m) => m.person === p.slug)).map((p) => ({ value: p.slug, label: p.name })),
                hint: 'Someone in People. Not there yet? Add them in People first.' },
              ...ownsEdit(h, '', '*').fields] },
          }] : []),
        ] }] },
      ],
    };
  } finally {
    dir?.close();
  }
}

export function newFactPage(): Page {
  return { title: 'Add a fact', intro: 'Knowledge is facts about the world, shared by every agent. Every one says where it came from.', sections: [{ id: 'form', blocks: [{
    type: 'form', action: 'fact-add', submit: 'Add',
    fields: [
      { name: 'title', label: 'Title', kind: 'text', required: true, hint: 'The fact in a line, e.g. "Cone 6 is about 1222 °C".' },
      { name: 'domain', label: 'Topic', kind: 'text', required: true, hint: 'Lowercase, slashes for depth, e.g. ceramics or ours/loom.' },
      { name: 'body', label: 'What it says', kind: 'textarea', required: true, hint: 'Markdown.' },
      { name: 'source', label: 'Where it came from', kind: 'text', hint: 'A link. Leave it empty if it\'s from you: it\'s kept as provisional until a source backs it.' },
    ],
  }] }] };
}

export function newAgentPage(h?: Household): Page {
  const next = h ? h.agents.length % MARKS.length : 0;
  return {
    title: 'New agent',
    sections: [{ id: 'form', blocks: [{
      type: 'form', action: 'add-agent', submit: 'Create agent',
      note: 'Its own identity, memory and relationships, sharing the household\'s knowledge and people. Its first token is shown once, next.',
      fields: [
        { name: 'name', label: 'Name', kind: 'text', hint: 'What it\'s called, e.g. "Gabe".', required: true },
        { name: 'mark', label: 'Color', kind: 'choice', value: String(next), options: MARKS.map((m, i) => ({ value: String(i), label: m.name, swatch: m.bg })) },
        { name: 'purpose', label: 'What it\'s for', kind: 'textarea', required: true },
        { name: 'voice', label: 'Voice', kind: 'choice', value: 'dry', required: true, options: [{ value: 'dry', label: 'Dry' }, { value: 'warm', label: 'Warm' }, { value: 'terse', label: 'Terse' }] },
        { name: 'voice_more', label: 'More about how it talks', kind: 'textarea', hint: 'Optional.' },
        { name: 'about', label: 'Description', kind: 'textarea', hint: 'Optional: a line or two the household sees on its profile.' },
        { name: 'rules', label: 'Rules', kind: 'textarea', hint: 'Optional: the lines it never crosses, one per line.' },
        { name: 'ask', label: 'When to ask first', kind: 'textarea', hint: 'Optional: what needs your OK before it acts.' },
        { name: 'agent', label: 'Short name', kind: 'text', hint: 'Optional: from its name. Lowercase letters, digits and dashes; it names the directory and the token role.' },
      ],
    }] }],
  };
}

/** An agent's short name from what it's called: "Visual Mark" → "visual-mark". */
export function slugOf(name: string): string {
  return name.toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').replace(/^[^a-z]+/, '').slice(0, 40);
}

/** The owner's household actions: tokens and agents. */
export async function householdAct(h: Household, action: string, fields: Record<string, string>): Promise<ActResult> {
  try {
    if (action === 'knowledge-verify') {
      const slug = fields.slug ?? '';
      if (!validPath(`knowledge/${slug}`)) return { ok: false, message: 'No page named.' };
      const out = await knowledgeVerify(agentDir(h, h.default), { slug, outcome: 'confirmed', note: 'confirmed from loom\'s page' }, h.owner ?? 'owner');
      return /verified_at stamped/.test(out) ? { ok: true, message: 'Marked as still true.', page: `loom:knowledge?p=${slug}` } : { ok: false, message: out };
    }
    // Check again (t-1925): a check that found it stale, so the page is due one (Knowledge's "Due a check"), and the
    // nightly freshness pass and any agent reading it see it needs one. Its verified date doesn't move.
    if (action === 'knowledge-recheck') {
      const slug = fields.slug ?? '';
      if (!validPath(`knowledge/${slug}`)) return { ok: false, message: 'No page named.' };
      const out = await knowledgeVerify(agentDir(h, h.default), { slug, outcome: 'stale', note: 'asked to be checked again from loom\'s page' }, h.owner ?? 'owner');
      return /outcome: stale/.test(out) ? { ok: true, message: 'Asked for a check: it’s in Due a check until an agent confirms it.', page: `loom:knowledge?p=${slug}` } : { ok: false, message: out };
    }
    if (action === 'backup-set') {
      const split = (v?: string) => (v ?? '').split(/[\s,]+/).filter(Boolean);
      const st = validateSettings({ target: fields.target, recipients: split(fields.recipients), at: fields.at, tz: fields.tz, keep: fields.keep, required: split(fields.required) }, uiTimeZone());
      setSettings(h, st, process.env);
      return { ok: true, message: `The nightly backup is set: ${targetString(st.target)}, each day at ${st.at} (${st.tz}).`, page: `loom:a/${h.default}/setup` };
    }
    if (action === 'create-token') {
      const agent = fields.agent ?? '';
      const role = agent === '' ? null : parseRole(`agent:${agent}`);
      if (!role) return { ok: false, message: 'Name an agent for the token.' };
      const { token } = createToken(h, { role, label: fields.label ?? '' });
      return { ok: true, message: `Token for ${agent}, shown this once: ${token}`, page: `loom:a/${agent}/setup`, keep: true };
    }
    if (action === 'revoke-token') {
      const withPasskeys = fields.passkeys === 'with';
      const { token: t, passkeys, devices } = revokeTokenAndPasskeys(h, fields.label ?? '', withPasskeys);
      const r = parseRole(t.role);
      const agent = r?.kind === 'agent' ? r.agent : h.default;
      const pk = (!passkeys ? '' : withPasskeys ? ` ${cap(passkeys)} made from it ${passkeys === 1 ? 'is' : 'are'} removed.`
        : ` ${cap(passkeys)} made from it keep${passkeys === 1 ? 's' : ''} working.`)
        + (devices ? ` ${devices} device${devices === 1 ? '' : 's'} signed in with ${withPasskeys ? 'them' : 'it'} no longer get${devices === 1 ? 's' : ''} notifications.` : '');
      return { ok: true, message: `Revoked "${t.label}". It stops working on its next request.${pk}`, page: `loom:a/${agent}/setup` };
    }
    if (action === 'face-set') {
      const agent = fields.agent ?? '';
      if (!h.agents.includes(agent)) return { ok: false, message: 'No such agent.' };
      const now = faceOf(h, agent);
      const shape = FACE_SHAPES.find((x) => x === fields.shape) ?? now.shape, eyes = FACE_EYES.find((x) => x === fields.eyes) ?? now.eyes;
      setFace(h, agent, { shape, eyes });
      return { ok: true, message: `${agentName(agentDir(h, agent))} looks like this now.`, page: `loom:a/${agent}/setup` };
    }
    if (action === 'mark-set') {
      const agent = fields.agent ?? '';
      const mark = /^\d$/.test(fields.mark ?? '') ? MARKS[Number(fields.mark)] : undefined;
      if (!h.agents.includes(agent) || !mark) return { ok: false, message: 'Pick an agent and one of the colors.' };
      setMark(h, agent, mark);
      return { ok: true, message: `${agentName(agentDir(h, agent))} wears ${mark.name}.`, page: `loom:a/${agent}/setup` };
    }
    // Its description (the agent window's header, t-1925 D): what the household sees, in plain words. The owner's own
    // words, or, asked for (about-ask, the window's Regenerate), the agent's (describe_self). Never its creed.
    if (action === 'about-set') {
      const agent = fields.agent ?? '';
      if (!h.agents.includes(agent)) return { ok: false, message: 'No such agent.' };
      try { setAbout(h, agent, fields.about ?? ''); } catch (e) { return { ok: false, message: e instanceof HouseholdError ? e.message : 'That didn\'t save.' }; }
      setAboutAsk(h, agent, null);
      return { ok: true, message: (fields.about ?? '').trim() ? `Saved ${agentName(agentDir(h, agent))}'s description.` : `Cleared ${agentName(agentDir(h, agent))}'s description.` };
    }
    if (action === 'about-ask') {
      const agent = fields.agent ?? '';
      if (!h.agents.includes(agent)) return { ok: false, message: 'No such agent.' };
      setAboutAsk(h, agent, new Date().toISOString());
      return { ok: true, message: `Asked ${agentName(agentDir(h, agent))} to write its description.` };
    }
    // Its creed, a part at a time (Setup's "Who it is" and "Its creed"); every write keeps a backup.
    if (action === 'identity-set' || action === 'identity-section-set' || action === 'identity-section-add') {
      const agent = fields.agent ?? '';
      if (!h.agents.includes(agent)) return { ok: false, message: 'No such agent.' };
      const dir = agentDir(h, agent);
      const { creed } = readCreed(dir);
      if (!creed.title) return { ok: false, message: `${agent} has no creed to change (no IDENTITY.md with a # title).` };
      let next = creed;
      if (action === 'identity-set') {
        if ('purpose' in fields) next = withPart(next, 'purpose', fields.purpose ?? '');
        for (const b of ['voice', 'rules', 'ask'] as const) if (b in fields) next = withPart(next, b, fields[b] ?? '');
        // The owner's own words close an open ask: the agent's describe_self can't write over them.
        if ('about' in fields) { setAbout(h, agent, fields.about ?? ''); setAboutAsk(h, agent, null); }
      } else if (action === 'identity-section-set') {
        next = withPart(next, fields.section ?? '', fields.body ?? '');
      } else {
        next = withSection(next, fields.heading ?? '', fields.body ?? '');
      }
      await writeCreed(dir, next);
      return { ok: true, message: action === 'identity-section-add' ? `Added "${(fields.heading ?? '').trim()}" to ${creed.title}'s creed. It reads it from its next session.`
        : `Saved. ${creed.title} reads it from its next session.`, page: `loom:a/${agent}/setup` };
    }
    if (action === 'member-set') {
      const person = fields.person ?? '';
      const raw = fields.scope === 'all' ? '*' : (fields.agents ?? '').trim();
      if (!directory(h)?.getRow(person)) return { ok: false, message: 'Pick someone from People.' };
      const agents = raw === '*' ? '*' as const : raw.split(',').map((a) => a.trim()).filter(Boolean);
      if (agents !== '*' && !agents.length) return { ok: false, message: 'Pick the agents they own, or Everything.' };
      setMember(h, person, agents);
      const named = directory(h)?.getRow(person)?.card.name ?? person;
      return { ok: true, message: `${named} owns ${agents === '*' ? 'every agent' : agents.map((a) => h.agents.includes(a) ? agentName(agentDir(h, a)) : a).join(', ')}.`, page: 'loom:members' };
    }
    if (action === 'member-remove') {
      removeMember(h, fields.person ?? '');
      return { ok: true, message: `${fields.person} is no longer a member; their tokens stop working at once.`, page: 'loom:members' };
    }
    if (action === 'person-add') {
      const name = (fields.name ?? '').trim();
      const slug = slugOf(name);
      if (!name || !slug) return { ok: false, message: 'A person needs a name.' };
      const channel = (fields.channel ?? '').trim(), handle = (fields.handle ?? '').trim();
      if (channel && !CHANNELS.includes(channel)) return { ok: false, message: 'Pick where to reach them from the list.' };
      if (directory(h)?.getRow(slug)) return { ok: false, message: `${name} is already in People.`, page: `loom:people/${slug}` };
      const out = await personWrite(agentDir(h, h.default), { slug, name, ...(fields.summary?.trim() ? { summary: fields.summary.trim() } : {}),
        ...(channel && handle ? { where: { [channel]: { value: handle, source: `${h.owner ?? 'owner'} on loom's page` } } } : {}) });
      return out.startsWith('Error') ? { ok: false, message: out } : { ok: true, message: `${name} is in People.`, page: `loom:people/${slug}` };
    }
    if (action === 'fact-add') {
      const title = (fields.title ?? '').trim(), domain = (fields.domain ?? '').trim().toLowerCase(), body = (fields.body ?? '').trim(), source = (fields.source ?? '').trim();
      if (!title || !domain || !body) return { ok: false, message: 'A title, a topic and what it says are all needed.' };
      if (source && !/^https?:\/\//.test(source)) return { ok: false, message: 'The source is a link (http or https), or empty.' };
      // An add never replaces: a page by that name already is one to open, not overwrite.
      const want = slugify(title);
      if (!want) return { ok: false, message: 'That title has nothing to make an address from.' };
      if (existsSync(commonsKnowledgePath(h))) {
        const db = new BetterSqlite3(commonsKnowledgePath(h), { readonly: true, fileMustExist: true });
        try { if (db.prepare('SELECT 1 FROM pages WHERE slug = ?').get(want)) return { ok: false, message: 'Knowledge already has a page by that title.', page: `loom:knowledge/${want}` }; } finally { db.close(); }
      }
      const out = await knowledgeWrite(agentDir(h, h.default), { title, domain, body, slug: want,
        citations: [source ? { claim: title, source_kind: 'web', source_locator: source, excerpt: title } : { claim: title, source_kind: 'conversation', source_locator: `${h.owner ?? 'owner'} on loom's page`, excerpt: title }] },
        h.owner ?? 'owner');
      return out.startsWith('Error') ? { ok: false, message: out } : { ok: true, message: `Added to Knowledge${source ? '' : ' (provisional until a source backs it)'}.`, page: `loom:knowledge/${want}` };
    }
    if (action === 'add-agent') {
      const agent = (fields.agent ?? '').trim() || slugOf(fields.name ?? '');
      if (!AGENT_NAME.test(agent)) return { ok: false, message: 'The short name must be lowercase letters, digits and dashes, starting with a letter.' };
      if (h.agents.includes(agent)) return { ok: false, message: `${agent} is already in the household.` };
      // The board's voice is a word (Dry, Warm, Terse); an older form posts the line itself.
      const voice = [VOICES[fields.voice ?? ''] ?? fields.voice?.trim(), fields.voice_more?.trim()].filter(Boolean).join('\n\n');
      if (!fields.name?.trim() || !fields.purpose?.trim() || !voice) return { ok: false, message: 'A name, what it\'s for, and how it talks are all needed.' };
      const mark = MARKS[Number(fields.mark)];
      const dir = agentDir(h, agent);
      if (existsSync(dir)) return { ok: false, message: `agents/${agent} already exists on disk; add it with loom household add.` };
      mkdirSync(dir, { recursive: true, mode: 0o700 });
      await bootstrap(dir, { name: fields.name.trim(), purpose: fields.purpose.trim(), voice, user: h.owner });
      // The same boxes its Setup has: rules and when to ask first go in its creed, the description on the household.
      if (fields.rules?.trim() || fields.ask?.trim()) {
        const { creed } = readCreed(dir);
        await writeCreed(dir, withPart(withPart(creed, 'rules', fields.rules ?? ''), 'ask', fields.ask ?? ''));
      }
      const next = addAgent(h, agent);
      if (mark && /^\d$/.test(fields.mark ?? '')) setMark(next, agent, mark);
      if (fields.about?.trim()) setAbout(next, agent, fields.about);
      const { token } = createToken(next, { role: { kind: 'agent', agent }, label: `${fields.name.trim()} · first token` });
      return { ok: true, message: `${fields.name.trim()} is in the household. Its first token, shown this once: ${token}`, page: `loom:a/${agent}/setup`, keep: true };
    }
    return { ok: false, message: `loom has no action "${action}".` };
  } catch (err) {
    if (err instanceof HouseholdError) return { ok: false, message: err.message };
    return { ok: false, message: (err as Error).message };
  }
}

// ─── Find ────────────────────────────────────────────────────────────────────

export interface FindMatches {
  knowledge: Array<{ title: string; slug: string; domain: string }>;
  people: Array<{ name: string; slug: string }>;
  memories: Array<{ agent: string; title: string; ref: string }>;
}

const FIND_EACH = 5;

/** Plain text matches for Find: knowledge titles, people's names, and each given agent's memories (titles first). */
/** Find's suggestions before anything is typed: the household's people (not its agents, which the app has already),
 * as the People page lists them. */
export function householdSuggestPeople(h: Household, n = 8): Array<{ name: string; slug: string }> {
  const dir = directory(h);
  if (!dir) return [];
  try {
    return dir.list().filter((p) => kindOf(dir.getRow(p.slug)?.card ?? { how: {} }) !== 'agent').slice(0, n).map((p) => ({ name: p.name, slug: p.slug }));
  } finally { dir.close(); }
}

/** A person's name as People has it (Jonathan Barket), or none when People doesn't know the slug or can't be read
 * (Profile's head: an unreadable people.db must not stop the page you sign out from). */
export function householdPersonName(h: Household, slug: string): string | undefined {
  let dir: PeopleStore | null = null;
  try { dir = directory(h); return dir?.getRow(slug)?.card.name?.trim() || undefined; } catch { return undefined; } finally { dir?.close(); }
}

export function householdFind(h: Household, q: string, agents: string[] = h.agents): FindMatches {
  const out: FindMatches = { knowledge: [], people: [], memories: [] };
  const needle = q.trim().toLowerCase();
  if (!needle) return out;
  const like = `%${needle.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
  const read = <T>(path: string, sql: string, ...args: unknown[]): T[] => {
    if (!existsSync(path)) return [];
    const db = new BetterSqlite3(path, { readonly: true, fileMustExist: true });
    try { return db.prepare(sql).all(...args) as T[]; } catch { return []; } finally { db.close(); }
  };
  out.knowledge = read<{ title: string; slug: string; domain: string }>(commonsKnowledgePath(h),
    "SELECT title, slug, domain FROM pages WHERE status = 'active' AND (lower(title) LIKE ? ESCAPE '\\' OR lower(domain) LIKE ? ESCAPE '\\') ORDER BY updated DESC LIMIT ?", like, like, FIND_EACH)
    .filter((r) => validPath(`knowledge/${r.slug}`));
  const dir = directory(h);
  if (dir) {
    try { out.people = dir.list().filter((p) => p.name.toLowerCase().includes(needle)).slice(0, FIND_EACH).map((p) => ({ name: p.name, slug: p.slug })); } finally { dir.close(); }
  }
  for (const a of agents) {
    if (out.memories.length >= FIND_EACH) break;
    out.memories.push(...read<{ title: string; ref: string }>(resolveSqliteDbPath(agentDir(h, a)),
      "SELECT title, ref FROM memories WHERE archived = 0 AND category != 'episode' AND (lower(title) LIKE ? ESCAPE '\\' OR lower(content) LIKE ? ESCAPE '\\') ORDER BY (lower(title) LIKE ? ESCAPE '\\') DESC, COALESCE(updated, created) DESC LIMIT ?", like, like, like, FIND_EACH - out.memories.length)
      .filter((r) => validPath(`memory/${r.ref}`)).map((r) => ({ agent: a, ...r })));
  }
  return out;
}
