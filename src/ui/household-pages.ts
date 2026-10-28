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
import { listProposals } from '../backends/proposals.js';
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import BetterSqlite3 from 'better-sqlite3';
import {
  addAgent, AGENT_NAME, agentDir, commonsKnowledgePath, createToken, HouseholdError, loadTokens, MARKS, parseRole, removeMember, revokeToken, setMark,
  setMember, type Household, type Member,
  relayOf, setRelay, markIndexOf,
} from '../household.js';
import { commonsPeoplePath, kindOf } from '../backends/people-household.js';
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
      side: true,
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
const CHECK = 'needs-check';

export function knowledgePage(h: Household, query: Record<string, string>, opts: CoreOptions = {}): Page {
  const tz = opts.timeZone ?? uiTimeZone();
  const nowMs = opts.nowMs ?? Date.now();
  const path = commonsKnowledgePath(h);
  if (!existsSync(path)) return { title: 'Knowledge', intro: 'The commons has no knowledge yet.', sections: [], add: NEW_FACT };
  const db = new BetterSqlite3(path, { readonly: true, fileMustExist: true });
  try {
    const domains = (db.prepare("SELECT substr(domain, 1, instr(domain || '/', '/') - 1) AS top, COUNT(*) AS n FROM pages WHERE status = 'active' GROUP BY top ORDER BY n DESC LIMIT 11").all() as Array<{ top: string; n: number }>);
    // "Needs a check": last verified (or, never verified, last written) more than CHECK_DAYS ago.
    const cutoff = new Date(nowMs - CHECK_DAYS * 86_400_000).toISOString();
    const STALE = 'COALESCE(verified_at, updated) < ?';
    const stale = (db.prepare(`SELECT COUNT(*) AS n FROM pages WHERE status = 'active' AND ${STALE}`).get(cutoff) as { n: number }).n;
    const pick = query.domain === CHECK || domains.some((d) => d.top === query.domain) ? query.domain : '';
    const q = (query.q ?? '').trim().toLowerCase().slice(0, 100);
    const like = `%${q.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
    const where = ["status = 'active'"];
    const args: unknown[] = [];
    if (pick === CHECK) { where.push(STALE); args.push(cutoff); }
    else if (pick) { where.push("(domain = ? OR domain LIKE ? || '/%')"); args.push(pick, pick); }
    if (q) { where.push("(lower(title) LIKE ? ESCAPE '\\' OR lower(domain) LIKE ? ESCAPE '\\')"); args.push(like, like); }
    const rows = db.prepare(
      `SELECT slug, title, domain, updated, sourcing, verified_at FROM pages WHERE ${where.join(' AND ')} ORDER BY ${pick === CHECK ? 'COALESCE(verified_at, updated) ASC' : 'updated DESC'} LIMIT 60`,
    ).all(...args) as PageRow[];
    const total = count(path, "SELECT COUNT(*) AS n FROM pages WHERE status = 'active'");
    const freshness = (r: PageRow): { meta: string; tone?: 'warn' } => {
      const at = r.verified_at ?? r.updated;
      const days = Math.floor((nowMs - Date.parse(at)) / 86_400_000);
      if (at < cutoff) return { meta: `unchecked for ${days} days`, tone: 'warn' };
      return { meta: r.verified_at ? `verified ${ago(r.verified_at, tz, nowMs)}` : `written ${ago(r.updated, tz, nowMs)}` };
    };
    return {
      title: 'Knowledge',
      add: NEW_FACT,
      intro: 'Facts about the world, shared by every agent in the household. Newest first.',
      sections: [
        { id: 'filter', blocks: [
          { type: 'filters', param: 'domain', search: `Search ${total.toLocaleString('en-US')} facts`, options: [{ value: '', label: 'All' },
            ...(stale ? [{ value: CHECK, label: `Needs a check · ${stale}` }] : []), ...domains.map((d) => ({ value: d.top, label: `${d.top} · ${d.n}` }))] },
          ...(q || pick ? [{ type: 'text' as const, text: `${rows.length}${rows.length === 60 ? '+' : ''} of ${total.toLocaleString('en-US')} pages${q ? ` matching “${query.q!.trim()}”` : ''}`, tone: 'muted' as const }] : []),
        ] },
        { id: 'pages', blocks: [{
          type: 'list',
          items: rows.map((r) => {
            const f = freshness(r);
            return { text: r.title, meta: `${f.meta} · ${r.domain}`, tone: f.tone, page: validPath(`knowledge/${r.slug}`) ? `loom:knowledge/${r.slug}` : undefined };
          }),
        }] },
      ],
    };
  } finally {
    db.close();
  }
}

export function knowledgeEntry(h: Household, slug: string, opts: CoreOptions = {}): Page {
  const tz = opts.timeZone ?? uiTimeZone();
  const path = commonsKnowledgePath(h);
  if (!existsSync(path)) return { title: 'Not found', sections: [] };
  const db = new BetterSqlite3(path, { readonly: true, fileMustExist: true });
  try {
    const r = db.prepare("SELECT slug, title, domain, body, updated, sourcing, created_by, author, verified_at FROM pages WHERE slug = ? AND status = 'active'").get(slug) as PageRow | undefined;
    if (!r) return { title: 'Not found', sections: [] };
    const cites = (() => {
      try {
        return db.prepare('SELECT claim, source_kind, source_locator FROM citations c JOIN pages p ON p.id = c.page_id WHERE p.slug = ? LIMIT 40').all(slug) as Array<{ claim: string; source_kind: string; source_locator: string | null }>;
      } catch { return []; }
    })();
    const body = r.body ?? '';
    const by = r.created_by ?? r.author;
    return {
      title: r.title,
      // The board's line under the title: when it was last confirmed, and by whom.
      intro: r.verified_at ? `Verified ${ago(r.verified_at, tz, opts.nowMs ?? Date.now())}${by ? ` · written by ${by}` : ''}` : `Not verified yet${by ? ` · written by ${by}` : ''}`,
      sections: [
        { id: 'body', blocks: [{ type: 'prose' as const, text: body.slice(0, 20000) }] },
        ...(cites.length ? [{ id: 'citations', title: 'Sources', blocks: [{ type: 'list' as const, items: cites.map((c) => ({ text: c.claim, meta: `${c.source_kind}${c.source_locator ? ` · ${c.source_locator}` : ''}`, ...(c.source_locator && /^https?:\/\//.test(c.source_locator) ? { href: c.source_locator } : {}) })) }] }] : []),
        // The board's "Still true", after the sources: a verification (the clock the nightly freshness pass reads), as the owner.
        { id: 'verify', blocks: [{ type: 'buttons' as const, items: [{ action: 'knowledge-verify', label: 'Still true', tone: 'primary' as const, fields: { slug: r.slug } }] }] },
        { id: 'record', side: true, blocks: [{ type: 'kv', items: [
          { label: 'domain', value: r.domain },
          { label: 'sourcing', value: r.sourcing ?? 'unknown' },
          { label: 'updated', value: when(r.updated, tz) },
          { label: 'verified', value: when(r.verified_at ?? null, tz) },
          { label: 'written by', value: r.created_by ?? r.author ?? 'unknown' },
          { label: 'slug', value: r.slug },
        ] }] },
      ],
    };
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

/** The start of a text, cut at a sentence (or a word) near n characters. */
function gist(text: string, n: number): string {
  const one = text.replace(/\s+/g, ' ').trim();
  if (one.length <= n) return one;
  const cut = one.slice(0, n);
  const end = Math.max(cut.lastIndexOf('. '), cut.lastIndexOf('; '));
  return end > n / 2 ? cut.slice(0, end + 1) : `${cut.slice(0, cut.lastIndexOf(' '))}…`;
}

export function householdPerson(h: Household, slug: string, opts: CoreOptions = {}): Page {
  const tz = opts.timeZone ?? uiTimeZone();
  const nowMs = opts.nowMs ?? Date.now();
  const dir = directory(h);
  if (!dir) return { title: 'Not found', sections: [] };
  try {
    const d = dir.getRow(slug);
    if (!d) return { title: 'Not found', sections: [] };
    const where = Object.entries(d.card.where ?? {}).sort(([a], [b]) => a.localeCompare(b));
    // kind: person is the default, so a person's entry doesn't say it.
    const facts = Object.entries(d.card.how ?? {}).filter(([k, v]) => !(k === 'kind' && v === 'person'));
    const history = dir.history(slug).slice(0, 12);
    const sections: Section[] = [];
    // The board's order: how each agent knows them (every agent, met or not), then how to reach them.
    const rels = new Map(relationships(h, slug).map((r) => [r.agent, r]));
    // An agent's own entry: its pages are a tap away, and it isn't listed as knowing itself.
    const own = h.agents.includes(slug);
    if (own) sections.push({ id: 'agent', blocks: [{ type: 'list', items: [{ agent: slug, text: `${d.card.name}'s pages`, meta: 'Today, Mind and Setup', page: agentLink(slug) }] }] });
    // A member's entry says what they own (docs/specs/owners.md).
    const member = h.members.find((m) => m.person === slug);
    if (member) {
      sections.push({ id: 'owns', title: 'Owns', blocks: [{ type: 'list', items: member.agents === '*'
        ? [{ text: 'The household, and every agent in it', meta: 'household owner', page: 'loom:members' }]
        : member.agents.map((a) => ({ agent: a, text: agentName(agentDir(h, a)), meta: 'agent owner', page: agentLink(a) })) }] });
    }
    sections.push({ id: 'agents', title: own || kindOf(d.card) === 'agent' ? 'How each agent knows it' : 'How each agent knows them', blocks: [{
      type: 'list',
      items: h.agents.filter((a) => a !== slug).map((a) => {
        const r = rels.get(a);
        if (!r) return { agent: a, text: 'Hasn\'t met them' };
        const how = Object.entries(r.row.card.how ?? {}).map(([k, v]) => `${k}: ${value(v)}`).join(' · ');
        // A line or two here, as the board has it; all of it is on that agent's own card.
        const known = gist(r.row.card.summary || how || 'Knows of them; nothing more yet.', 180);
        const newer = r.memories ? `${r.memories} newer memor${r.memories === 1 ? 'y' : 'ies'} · ` : '';
        return { agent: a, text: known, meta: `${newer}updated ${ago(r.row.updated, tz, nowMs)}`, tone: r.memories ? 'warn' as const : undefined, page: agentLink(a, `people/${slug}`) };
      }),
    }] });
    if (where.length) {
      sections.push({ id: 'reach', title: 'Reach', blocks: [
        { type: 'kv', items: where.map(([k, env]) => {
          const st = fieldState(env, nowMs);
          return { label: k, value: `${value(env.value)}${st.kind === 'stale' ? ` · stale ${st.days}d` : st.kind === 'ok' ? '' : ' · unverified'}` };
        }) },
        { type: 'details', summary: 'Where this came from', blocks: [{
          type: 'table', columns: ['where', 'from', 'checked'],
          rows: where.map(([k, env]) => {
            const st = fieldState(env, nowMs);
            return [k, env.source ?? '', st.kind === 'ok' ? `ok, ${ago(env.verified_at ?? null, tz, nowMs)}` : st.kind === 'stale' ? `stale ${st.days}d` : 'unverified'];
          }),
        }] },
      ] });
    }
    if (facts.length) sections.push({ id: 'facts', title: 'Facts', side: true, blocks: [{ type: 'kv', items: facts.map(([k, v]) => ({ label: k, value: value(v) })) }] });
    if (history.length) {
      sections.push({ id: 'changes', side: true, blocks: [{ type: 'details', summary: 'Changes to the shared entry', meta: `${history.length}`, blocks: [{
        type: 'list', items: history.map((r) => ({ text: `${r.actor ?? 'someone'} ${r.op === 'write' ? 'changed it' : r.op}`, meta: ago(r.replaced_at, tz, nowMs) })),
      }] }] });
    }
    const role = d.card.how?.role;
    return { title: d.card.name, intro: d.card.summary ? gist(d.card.summary, 220) : (role ? value(role) : undefined), sections };
  } finally {
    dir.close();
  }
}

// ─── An agent's Setup ────────────────────────────────────────────────────────

/**
 * The creed, folded by its own headings: one fold per `#`/`##` section,
 * each split at paragraph breaks to fit a block, never mid-word.
 */
function identitySections(md: string): Block[] {
  if (!md.trim()) return [{ type: 'text', text: '(no IDENTITY.md)', tone: 'muted' }];
  const sections: Array<{ title: string; body: string }> = [];
  for (const line of md.split('\n')) {
    const m = /^#{1,2}\s+(.+)$/.exec(line);
    if (m || sections.length === 0) sections.push({ title: m ? m[1].trim() : 'Identity', body: '' });
    if (!m) sections[sections.length - 1].body += `${line}\n`;
  }
  return sections.filter((x) => x.body.trim()).slice(0, 16).map((x): Block => {
    const chunks: string[] = [];
    let cur = '';
    for (const para of x.body.trim().split(/\n\s*\n/)) {
      if (cur && cur.length + para.length + 2 > 1900) { chunks.push(cur); cur = ''; }
      cur = cur ? `${cur}\n\n${para}` : para.slice(0, 1900);
    }
    if (cur) chunks.push(cur);
    return { type: 'details', summary: x.title.slice(0, 200), blocks: chunks.slice(0, 19).map((c) => ({ type: 'text' as const, text: c })) };
  });
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
  return m < 60 ? `${m}m ago` : m < 2880 ? `${Math.round(m / 60)}h ago` : `${Math.round(m / 1440)} days ago`;
}

export function agentSetup(h: Household, agent: string, opts: CoreOptions & { ownerTokens?: boolean } = {}): Page {
  const tz = opts.timeZone ?? uiTimeZone();
  const nowMs = opts.nowMs ?? Date.now();
  const dir = agentDir(h, agent);
  let identity = '';
  try { identity = readFileSync(join(dir, 'IDENTITY.md'), 'utf-8'); } catch { /* none */ }
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
  const facts = identityFacts(identity);
  return {
    title: `${agentName(dir)} · Setup`,
    sections: [
      { id: 'health', title: 'Health', blocks: [{ type: 'status', items: [
        { label: 'Memory', tone: memories ? 'ok' : 'warn', text: memories ? 'OK' : 'empty', meta: `${memories.toLocaleString('en-US')} · ${(dbSize / 1048576).toFixed(0)} MB` },
        { label: 'Last active', tone: Number.isNaN(lastMs) ? 'warn' : nowMs - lastMs < 86_400_000 ? 'ok' : 'warn',
          text: Number.isNaN(lastMs) ? 'nothing in 3 days' : since(last.created, nowMs), ...(last ? { meta: whereLabel(last.where) } : {}) },
        { label: 'Tokens', tone: live.length ? 'ok' : 'warn', text: `${live.length} live`, meta: live.length ? `used ${since(live[0].last_used, nowMs)}` : 'none' },
      ] }] },
      { id: 'identity', title: 'Identity', blocks: [
        { type: 'kv', items: [
          ...(facts.voice ? [{ label: 'Voice', value: facts.voice.slice(0, 300) }] : []),
          ...(born ? [{ label: 'Born', value: new Intl.DateTimeFormat('en-US', { month: 'short', year: 'numeric', timeZone: tz }).format(new Date(born)) }] : []),
          { label: 'Harnesses', value: harnesses.join(', ') || 'none' },
        ] },
        // Its entry in People: where to reach it, and how every other agent knows it.
        { type: 'list', items: [{ text: 'Its entry in People', meta: 'where to reach it, and how the other agents know it', page: validPath(`people/${agent}`) ? `loom:people/${agent}` : undefined }] },
        ...(facts.bio ? [{ type: 'text' as const, text: facts.bio.slice(0, 1900) }] : []),
        // Its mark's color: its own, chosen here (it was only chosen when the agent was made).
        ...(opts.ownerTokens === false ? [] : [{ type: 'form' as const, action: 'mark-set', submit: 'Save', hidden: { agent }, fields: [
          { name: 'mark', label: 'Color', kind: 'choice' as const, value: String(markIndexOf(h, agent)), options: MARKS.map((m, i) => ({ value: String(i), label: m.name, swatch: m.bg })) }] }]),
        identity.trim()
          ? { type: 'details', summary: 'The whole creed', meta: 'read-only: the agent changes it (update_identity), or it\'s changed by hand', blocks: identitySections(identity) }
          : { type: 'text', text: '(no IDENTITY.md)', tone: 'muted' },
      ] },
      // Who it may relay to without asking: the household owner's to set (an agent owner's Setup shows it read-only).
      { id: 'relay', title: 'Who it may write to', side: true, blocks: (() => {
        const others = h.agents.filter((a) => a !== agent);
        const to = relayOf(h, agent);
        const say = { type: 'text' as const, tone: 'muted' as const, text: others.length
          ? `It relays to these without asking (wake relay); to any other, it asks you first. ${to.length ? `Now: ${to.join(', ')}.` : 'Now: nobody.'}`
          : 'There\'s no other agent to write to.' };
        if (!others.length || opts.ownerTokens === false) return [say];
        return [say, { type: 'form' as const, action: 'relay-set', submit: 'Save', hidden: { agent }, fields: [
          { name: 'to', label: 'Agents', kind: 'text' as const, ...(to.length ? { value: to.join(', ') } : {}), hint: `comma separated: ${others.join(', ')}` }] }];
      })() },
      { id: 'tokens', title: 'Tokens', blocks: [
        live.length
          ? { type: 'list', items: live.slice(0, 50).map((t) => ({
              text: t.label, meta: `${t.role === 'owner' ? 'owner · ' : ''}used ${since(t.last_used, nowMs)}`,
              act: { action: 'revoke-token', label: 'Revoke', tone: 'danger' as const, confirm: 'Anything still using it is signed out at once. You can make a new one.', fields: { label: t.label } },
            })) }
          : { type: 'text', text: 'No tokens yet.', tone: 'muted' },
        ...(tokens.length > live.length ? [{ type: 'details' as const, summary: `${tokens.length - live.length} revoked`, blocks: [{ type: 'list' as const, items: tokens.filter((t) => t.revoked).slice(0, 200).map((t) => ({
          text: t.label, meta: `revoked ${when(t.revoked!, tz)}`, tone: 'muted' as const })) }] }] : []),
        { type: 'details', summary: 'Create token', blocks: [{ type: 'form', action: 'create-token', submit: 'Create token', hidden: { agent },
          note: 'Shown once. Give it to the harness or house that will be this agent; loom keeps only its fingerprint.',
          fields: [{ name: 'label', label: 'Label', kind: 'text', hint: 'Where it goes, e.g. "Art · laptop".', required: true }] }] },
      ] },
    ],
  };
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
const NEW_FACT = { page: 'loom:new-fact', label: 'Add a fact' };
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
        { id: 'members', blocks: [{ type: 'list', items: h.members.map((m) => ({
          text: nameOf(m.person), avatar: initials(nameOf(m.person)), meta: owns(m), page: validPath(`people/${m.person}`) ? `loom:people/${m.person}` : undefined,
          // The last household owner stays: someone owns the shared things.
          ...(m.agents === '*' && all === 1 ? {} : { act: { action: 'member-remove', label: 'Remove', tone: 'danger' as const, fields: { person: m.person },
            confirm: `${nameOf(m.person)} is signed out everywhere, and their tokens stop working.` } }),
        })) }] },
        { id: 'links', title: 'Sign-in links', blocks: [
          { type: 'buttons', items: h.members.map((m) => ({ action: 'member-link', label: `For ${nameOf(m.person)}`, fields: { person: m.person } })) },
          { type: 'text', tone: 'muted', text: 'One sign-in within 10 minutes, as that member. Send it to them; they can add a passkey once they\'re in.' },
        ] },
        { id: 'add', title: 'Add or change a member', blocks: [{
          type: 'form', action: 'member-set', submit: 'Save',
          fields: [
            { name: 'person', label: 'Who', kind: 'choice', required: true, value: '',
              options: [{ value: '', label: '(pick from People)' }, ...people.map((p) => ({ value: p.slug, label: p.name }))],
              hint: 'Someone in People. Not there yet? Add them in People first.' },
            { name: 'agents', label: 'What they own', kind: 'text', required: true, value: '*',
              hint: `* for every agent and the household, or agents by id, comma-separated: ${h.agents.join(', ')}` },
          ],
        }] },
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
        { name: 'voice_more', label: 'More about how it talks', kind: 'textarea', hint: 'Optional. It can change this itself later.' },
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
      return /verified_at stamped/.test(out) ? { ok: true, message: 'Marked as still true.', page: `loom:knowledge/${slug}` } : { ok: false, message: out };
    }
    if (action === 'create-token') {
      const agent = fields.agent ?? '';
      const role = agent === '' ? null : parseRole(`agent:${agent}`);
      if (!role) return { ok: false, message: 'Name an agent for the token.' };
      const { token } = createToken(h, { role, label: fields.label ?? '' });
      return { ok: true, message: `Token for ${agent}, shown this once: ${token}`, page: `loom:a/${agent}/setup`, keep: true };
    }
    if (action === 'revoke-token') {
      const t = revokeToken(h, fields.label ?? '');
      const r = parseRole(t.role);
      const agent = r?.kind === 'agent' ? r.agent : h.default;
      return { ok: true, message: `Revoked "${t.label}". It stops working on its next request.`, page: `loom:a/${agent}/setup` };
    }
    if (action === 'mark-set') {
      const agent = fields.agent ?? '';
      const mark = /^\d$/.test(fields.mark ?? '') ? MARKS[Number(fields.mark)] : undefined;
      if (!h.agents.includes(agent) || !mark) return { ok: false, message: 'Pick an agent and one of the colors.' };
      setMark(h, agent, mark);
      return { ok: true, message: `${agent} wears ${mark.name}.`, page: `loom:a/${agent}/setup` };
    }
    if (action === 'relay-set') {
      const agent = fields.agent ?? '';
      const to = (fields.to ?? '').split(',').map((a) => a.trim()).filter(Boolean);
      const now = setRelay(h, agent, to);
      return { ok: true, message: now.length ? `${agent} writes to ${now.join(', ')} without asking.` : `${agent} asks you before writing to any agent.`, page: `loom:a/${agent}/setup` };
    }
    if (action === 'member-set') {
      const person = fields.person ?? '';
      const raw = (fields.agents ?? '').trim();
      if (!directory(h)?.getRow(person)) return { ok: false, message: 'Pick someone from People.' };
      const agents = raw === '*' ? '*' as const : raw.split(',').map((a) => a.trim()).filter(Boolean);
      if (agents !== '*' && !agents.length) return { ok: false, message: 'Say what they own: * or agent ids.' };
      setMember(h, person, agents);
      return { ok: true, message: `${person} owns ${agents === '*' ? 'every agent' : agents.join(', ')}.`, page: 'loom:members' };
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
      const next = addAgent(h, agent);
      if (mark && /^\d$/.test(fields.mark ?? '')) setMark(next, agent, mark);
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
