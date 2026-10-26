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
  addAgent, AGENT_NAME, agentDir, commonsKnowledgePath, createToken, HouseholdError, loadTokens, parseRole, revokeToken,
  type Household,
} from '../household.js';
import { commonsPeoplePath } from '../backends/people-household.js';
import { fieldState, PeopleStore, type CardValue } from '../backends/people.js';
import { resolveSqliteDbPath } from '../config.js';
import { bootstrap } from '../tools/bootstrap.js';
import { ago, agentName, uiTimeZone, when, type CoreOptions } from './core.js';
import { tapeRows } from './data.js';
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
              meta: last ? `${ago(last.created, tz, nowMs)} · ${last.where} · ${last.title}` : 'quiet for a day',
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
              meta: `${e.name} · ${ago(e.created, tz, nowMs)} · ${e.where}`,
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

export function knowledgePage(h: Household, query: Record<string, string>, opts: CoreOptions = {}): Page {
  const tz = opts.timeZone ?? uiTimeZone();
  const nowMs = opts.nowMs ?? Date.now();
  const path = commonsKnowledgePath(h);
  if (!existsSync(path)) return { title: 'Knowledge', intro: 'The commons has no knowledge yet.', sections: [] };
  const db = new BetterSqlite3(path, { readonly: true, fileMustExist: true });
  try {
    const domains = (db.prepare("SELECT substr(domain, 1, instr(domain || '/', '/') - 1) AS top, COUNT(*) AS n FROM pages WHERE status = 'active' GROUP BY top ORDER BY n DESC LIMIT 12").all() as Array<{ top: string; n: number }>);
    const pick = domains.some((d) => d.top === query.domain) ? query.domain : '';
    const rows = db.prepare(
      `SELECT slug, title, domain, updated, sourcing FROM pages WHERE status = 'active' ${pick ? "AND (domain = ? OR domain LIKE ? || '/%')" : ''} ORDER BY updated DESC LIMIT 60`,
    ).all(...(pick ? [pick, pick] : [])) as PageRow[];
    const total = count(path, "SELECT COUNT(*) AS n FROM pages WHERE status = 'active'");
    return {
      title: 'Knowledge',
      intro: 'Facts about the world, shared by every agent in the household. Newest first.',
      sections: [
        { id: 'filter', blocks: [
          { type: 'filters', param: 'domain', options: [{ value: '', label: 'Everything' }, ...domains.map((d) => ({ value: d.top, label: `${d.top} (${d.n})` }))] },
          { type: 'text', text: `${total.toLocaleString('en-US')} pages${pick ? `, ${rows.length} shown in ${pick}` : ''}`, tone: 'muted' },
        ] },
        { id: 'pages', blocks: [{
          type: 'list',
          items: rows.map((r) => ({
            text: r.title,
            meta: `${r.domain} · ${ago(r.updated, tz, nowMs)}${r.sourcing ? ` · ${r.sourcing}` : ''}`,
            page: validPath(`knowledge/${r.slug}`) ? `loom:knowledge/${r.slug}` : undefined,
          })),
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
    const chunks = body.match(/[\s\S]{1,1900}/g) ?? [''];
    return {
      title: r.title,
      sections: [
        { id: 'body', blocks: chunks.slice(0, 18).map((c) => ({ type: 'text' as const, text: c })) },
        ...(cites.length ? [{ id: 'citations', title: 'Sources', blocks: [{ type: 'list' as const, items: cites.map((c) => ({ text: c.claim, meta: `${c.source_kind}${c.source_locator ? ` · ${c.source_locator}` : ''}`, ...(c.source_locator && /^https?:\/\//.test(c.source_locator) ? { href: c.source_locator } : {}) })) }] }] : []),
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

export function householdPeople(h: Household): Page {
  const dir = directory(h);
  if (!dir) return { title: 'People', intro: 'Nobody in the directory yet.', sections: [] };
  try {
    const list = dir.list();
    return {
      title: 'People',
      intro: 'One entry per person, shared by every agent: who they are and where to reach them. Each agent keeps its own relationship with them.',
      sections: [{ id: 'everyone', blocks: [{
        type: 'list',
        items: list.map((p) => {
          const rel = relationships(h, p.slug).map((r) => r.name);
          const flag = [p.stale ? `${p.stale} stale` : '', p.unverified ? `${p.unverified} unverified` : ''].filter(Boolean).join(' · ');
          return {
            text: p.name,
            meta: rel.length ? `known to ${rel.join(', ')}` : 'no agent has a relationship yet',
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

export function householdPerson(h: Household, slug: string, opts: CoreOptions = {}): Page {
  const tz = opts.timeZone ?? uiTimeZone();
  const nowMs = opts.nowMs ?? Date.now();
  const dir = directory(h);
  if (!dir) return { title: 'Not found', sections: [] };
  try {
    const d = dir.getRow(slug);
    if (!d) return { title: 'Not found', sections: [] };
    const where = Object.entries(d.card.where ?? {}).sort(([a], [b]) => a.localeCompare(b));
    const facts = Object.entries(d.card.how ?? {});
    const history = dir.history(slug).slice(0, 12);
    const sections: Section[] = [];
    if (where.length) {
      sections.push({ id: 'where', title: 'Where to reach them', blocks: [{
        type: 'table', columns: ['where', 'value', 'from', 'checked'],
        rows: where.map(([k, env]) => {
          const s = fieldState(env, nowMs);
          return [k, value(env.value), env.source ?? '', s.kind === 'ok' ? `ok, ${ago(env.verified_at ?? null, tz, nowMs)}` : s.kind === 'stale' ? `stale ${s.days}d` : 'unverified'];
        }),
      }] });
    }
    for (const r of relationships(h, slug)) {
      const how = Object.entries(r.row.card.how ?? {});
      const blocks: Block[] = [];
      if (r.row.card.summary) blocks.push({ type: 'text', text: r.row.card.summary });
      if (how.length) blocks.push({ type: 'kv', items: how.map(([k, v]) => ({ label: k, value: value(v) })) });
      if (r.row.card.may?.length) blocks.push({ type: 'list', items: r.row.card.may.map((m) => ({ text: m.text, meta: `said by ${m.source}` })) });
      blocks.push({ type: 'text', text: `${r.memories} memor${r.memories === 1 ? 'y' : 'ies'} newer than this view · updated ${ago(r.row.updated, tz, nowMs)}`, tone: r.memories ? 'warn' : 'muted' });
      if (!r.row.card.summary && !how.length && !r.row.card.may?.length) blocks.unshift({ type: 'text', text: 'Knows of them; nothing more yet.', tone: 'muted' });
      blocks.push({ type: 'link', text: `${r.name}'s view`, page: agentLink(r.agent, `people/${slug}`) });
      sections.push({ id: `rel-${r.agent}`, title: `${r.name}`, blocks });
    }
    if (facts.length) sections.push({ id: 'facts', title: 'Facts', side: true, blocks: [{ type: 'kv', items: facts.map(([k, v]) => ({ label: k, value: value(v) })) }] });
    if (history.length) {
      sections.push({ id: 'changes', title: 'Changes to the shared entry', side: true, blocks: [{
        type: 'list', items: history.map((r) => ({ text: `${r.actor ?? 'someone'} ${r.op === 'write' ? 'changed it' : r.op}`, meta: ago(r.replaced_at, tz, nowMs) })),
      }] });
    }
    return { title: d.card.name, intro: 'The shared entry, then how each agent sees them.', sections };
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

export function agentSetup(h: Household, agent: string, opts: CoreOptions = {}): Page {
  const tz = opts.timeZone ?? uiTimeZone();
  const dir = agentDir(h, agent);
  let identity = '';
  try { identity = readFileSync(join(dir, 'IDENTITY.md'), 'utf-8'); } catch { /* none */ }
  const harnesses = (() => { try { return readdirSync(join(dir, 'harnesses')).filter((f) => f.endsWith('.md')).map((f) => f.slice(0, -3)); } catch { return []; } })();
  const tokens = loadTokens(h.home).filter((t) => t.role === `agent:${agent}` || (agent === h.default && t.role === 'owner'));
  const dbSize = (() => { try { return statSync(resolveSqliteDbPath(dir)).size; } catch { return 0; } })();
  const memories = count(resolveSqliteDbPath(dir), "SELECT COUNT(*) AS n FROM memories WHERE archived = 0 AND category != 'episode'");
  return {
    title: `${agentName(dir)} · Setup`,
    sections: [
      { id: 'identity', title: 'Identity', blocks: [
        { type: 'text', text: 'Read-only here: an agent\'s creed is changed by the agent (update_identity) or by hand, never from a web page.', tone: 'muted' },
        ...identitySections(identity),
      ] },
      { id: 'tokens', title: 'Tokens', blocks: [
        tokens.length
          ? { type: 'details', summary: `${tokens.filter((t) => !t.revoked).length} live, ${tokens.filter((t) => t.revoked).length} revoked`, blocks: tokens.map((t): Block => (t.revoked
              ? { type: 'text', text: `${t.label} (${t.role}) · revoked ${when(t.revoked, tz)}`, tone: 'muted' }
              : { type: 'callout', title: `${t.label} · ${t.role}`, text: `created ${when(t.created, tz)} · ${t.last_used ? `last used ${when(t.last_used, tz)}` : 'never used'}` })) }
          : { type: 'text', text: 'No tokens yet.', tone: 'muted' },
        ...tokens.filter((t) => !t.revoked).map((t): Block => ({ type: 'buttons', items: [{ action: 'revoke-token', label: `Revoke "${t.label}"`, tone: 'danger', fields: { label: t.label } }] })),
        { type: 'form', action: 'create-token', title: 'New token', submit: 'Create token', hidden: { agent },
          note: 'Shown once, on the next page. Give it to the harness or house that will be this agent; loom keeps only its fingerprint.',
          fields: [{ name: 'label', label: 'Label', kind: 'text', hint: 'Where it goes, e.g. "Art · laptop".', required: true }] },
      ] },
      { id: 'health', side: true, title: 'Health', blocks: [{ type: 'kv', items: [
        { label: 'memories', value: memories.toLocaleString('en-US') },
        { label: 'memory store', value: `${(dbSize / 1048576).toFixed(1)} MB` },
        { label: 'harnesses', value: harnesses.join(', ') || 'none' },
        { label: 'directory', value: `agents/${agent}` },
        { label: 'default agent', value: agent === h.default ? 'yes' : 'no' },
      ] }] },
    ],
  };
}

// ─── Adding an agent ─────────────────────────────────────────────────────────

export function newAgentPage(): Page {
  return {
    title: 'Add an agent',
    intro: 'A new stack in this household: its own identity, memory and relationships, sharing the commons. You get its first token on the next page.',
    sections: [{ id: 'form', blocks: [{
      type: 'form', action: 'add-agent', submit: 'Create the agent',
      fields: [
        { name: 'agent', label: 'Short name', kind: 'text', hint: 'Lowercase letters, digits and dashes, e.g. "mark". It names the directory and the token role.', required: true },
        { name: 'name', label: 'Name', kind: 'text', hint: 'What it\'s called, e.g. "Visual Mark".', required: true },
        { name: 'purpose', label: 'What it\'s for', kind: 'textarea', required: true },
        { name: 'voice', label: 'How it talks', kind: 'textarea', hint: 'A line or two. It can change this itself later.', required: true },
      ],
    }] }],
  };
}

/** The owner's household actions: tokens and agents. */
export async function householdAct(h: Household, action: string, fields: Record<string, string>): Promise<ActResult> {
  try {
    if (action === 'create-token') {
      const agent = fields.agent ?? '';
      const role = agent === '' ? null : parseRole(`agent:${agent}`);
      if (!role) return { ok: false, message: 'Name an agent for the token.' };
      const { token } = createToken(h, { role, label: fields.label ?? '' });
      return { ok: true, message: `Token for ${agent}, shown this once: ${token}`, page: `loom:a/${agent}/setup` };
    }
    if (action === 'revoke-token') {
      const t = revokeToken(h, fields.label ?? '');
      const agent = t.role.startsWith('agent:') ? t.role.slice('agent:'.length) : h.default;
      return { ok: true, message: `Revoked "${t.label}". It stops working on its next request.`, page: `loom:a/${agent}/setup` };
    }
    if (action === 'add-agent') {
      const agent = (fields.agent ?? '').trim();
      if (!AGENT_NAME.test(agent)) return { ok: false, message: 'The short name must be lowercase letters, digits and dashes, starting with a letter.' };
      if (h.agents.includes(agent)) return { ok: false, message: `${agent} is already in the household.` };
      if (!fields.name?.trim() || !fields.purpose?.trim() || !fields.voice?.trim()) return { ok: false, message: 'A name, what it\'s for, and how it talks are all needed.' };
      const dir = agentDir(h, agent);
      if (existsSync(dir)) return { ok: false, message: `agents/${agent} already exists on disk; add it with loom household add.` };
      mkdirSync(dir, { recursive: true, mode: 0o700 });
      await bootstrap(dir, { name: fields.name.trim(), purpose: fields.purpose.trim(), voice: fields.voice.trim(), user: h.owner });
      const next = addAgent(h, agent);
      const { token } = createToken(next, { role: { kind: 'agent', agent }, label: `${fields.name.trim()} · first token` });
      return { ok: true, message: `${fields.name.trim()} is in the household. Its first token, shown this once: ${token}`, page: `loom:a/${agent}/setup` };
    }
    return { ok: false, message: `loom has no action "${action}".` };
  } catch (err) {
    if (err instanceof HouseholdError) return { ok: false, message: err.message };
    return { ok: false, message: (err as Error).message };
  }
}
