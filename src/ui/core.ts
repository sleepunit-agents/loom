/**
 * loom's own pages: what only loom knows. Home (the tape, top of mind, the
 * people who need a look), Mind (every memory's heat and why), one memory,
 * People and one person, plus the actions on them (archive a memory, ratify
 * or reject a proposal). Built in the same vocabulary the pieces use, so one
 * renderer draws everything. Nothing here names a piece.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { listProposals, rejectProposal, ratifyProposal, UnknownProposalError } from '../backends/proposals.js';
import { fieldState, type CardValue } from '../backends/people.js';
import { listPeople, readPerson } from '../tools/person.js';
import { archive } from '../tools/archive.js';
import { restore } from '../tools/restore.js';
import { heatList, memoriesAbout, memoryByRef, memoryHistory, tapeRows, type MemoryView } from './data.js';
import { validPath, type ActResult, type Block, type Page, type Section, type Tile, type Tone } from './vocab.js';

const TAPE_HOURS = 24;
const TAPE_MAX_HOURS = 24 * 7;
const MIND_SHOWN = 40;
const HOME_MIND = 5;

/** loom's zone (LOOM_TIMEZONE, then TZ), and one that Intl accepts: a bad value never breaks the page. */
export function uiTimeZone(): string {
  for (const z of [process.env.LOOM_TIMEZONE, process.env.TZ, 'America/Chicago']) {
    if (!z) continue;
    try { new Intl.DateTimeFormat('en-US', { timeZone: z }); return z; } catch { /* next */ }
  }
  return 'UTC';
}

/** The agent's name: IDENTITY.md's first heading, else the context dir's name. */
export function agentName(contextDir: string): string {
  try {
    const line = readFileSync(join(contextDir, 'IDENTITY.md'), 'utf-8').split('\n').find((l) => /^#\s+\S/.test(l));
    if (line) return line.replace(/^#\s+/, '').trim();
  } catch { /* no identity file */ }
  return contextDir.split('/').filter(Boolean).pop() ?? 'loom';
}

export interface CoreOptions { timeZone?: string; nowMs?: number }

function parts(iso: string, tz: string) {
  const d = new Date(iso);
  const f = (o: Intl.DateTimeFormatOptions) => new Intl.DateTimeFormat('en-US', { timeZone: tz, ...o }).format(d);
  return {
    day: f({ year: 'numeric', month: '2-digit', day: '2-digit' }),
    weekday: f({ weekday: 'short' }),
    date: f({ month: 'short', day: 'numeric' }),
    time: f({ hour: 'numeric', minute: '2-digit' }).toLowerCase().replace(/\s/g, ' '),
    hour: f({ hour: 'numeric' }).toLowerCase(),
  };
}

/** "Sat Oct 24, 12:09 pm" */
export function when(iso: string | null, tz: string): string {
  if (!iso || Number.isNaN(Date.parse(iso))) return 'never';
  const p = parts(iso, tz);
  return `${p.weekday} ${p.date}, ${p.time}`;
}

/** "today 12:09 pm", "yesterday", "Oct 19" */
export function ago(iso: string | null, tz: string, nowMs: number): string {
  if (!iso || Number.isNaN(Date.parse(iso))) return 'never';
  const p = parts(iso, tz);
  const today = parts(new Date(nowMs).toISOString(), tz).day;
  const yesterday = parts(new Date(nowMs - 86_400_000).toISOString(), tz).day;
  if (p.day === today) return `today ${p.time}`;
  if (p.day === yesterday) return `yesterday ${p.time}`;
  return p.date;
}

const heatTone = (h: number): Tone | undefined => (h >= 0.6 ? 'warn' : h < 0.2 ? 'muted' : undefined);

/** The plain-language reason a memory has the heat it has. */
function why(m: MemoryView, tz: string, nowMs: number, people: Map<string, string>): string {
  const written = m.updated ? `Edited ${ago(m.updated, tz, nowMs)}.` : `Written ${ago(m.created, tz, nowMs)}.`;
  const recalled = m.recallHeat >= 0.01
    ? ` Being recalled adds ${m.recallHeat.toFixed(2)} (last ${ago(m.lastAccessed, tz, nowMs)}): the top result of a recall adds the most, an incidental one little.`
    : m.lastAccessed ? '' : ' Never recalled.';
  const source = m.recallHeat > m.writtenHeat ? 'recall' : 'when it was written';
  const decay = ` ${m.category[0].toUpperCase()}${m.category.slice(1)} memories cool by half every ${m.halfLifeDays} days; it's at ${m.heat.toFixed(2)} now, from ${source}.`;
  const where = m.inDigest ? ' That puts it in what I wake up holding.' : ' That\'s below what I wake up holding.';
  const about = m.person
    ? ` It's about ${people.get(m.person) ?? m.person}, but nothing limits it to conversations with them.`
    : '';
  return `${written}${recalled}${decay}${where}${about}`;
}

function memoryDetails(m: MemoryView, tz: string, nowMs: number, people: Map<string, string>): Block {
  return {
    type: 'details',
    summary: m.title,
    meta: `${m.category} · ${m.heat.toFixed(2)}${m.inDigest ? ' · at wake' : ''}`,
    blocks: [
      { type: 'text', text: why(m, tz, nowMs, people) },
      {
        type: 'kv',
        items: [
          { label: 'heat now', value: m.heat.toFixed(2) },
          { label: 'from writing', value: m.writtenHeat.toFixed(2) },
          { label: 'from recall', value: m.recallHeat.toFixed(2) },
          ...(Math.abs(m.stored - m.heat) > 0.05 ? [{ label: 'stored (lane)', value: m.stored.toFixed(2) }] : []),
          { label: 'half-life', value: `${m.halfLifeDays} days` },
          { label: 'sourcing', value: m.sourcing ?? 'unknown' },
          ...(m.project ? [{ label: 'project', value: m.project }] : []),
          ...(m.person ? [{ label: 'about', value: people.get(m.person) ?? m.person, page: personPage(m.person) }] : []),
        ],
      },
      ...(memoryPage(m.ref) ? [{ type: 'link' as const, text: 'Open memory', page: memoryPage(m.ref)! }] : []),
    ],
  };
}

function memoryPage(ref: string): string | undefined {
  const p = `memory/${ref}`;
  return validPath(p) ? p : undefined;
}

function personPage(slug: string): string | undefined {
  const p = `people/${slug}`;
  return validPath(p) ? p : undefined;
}

function peopleNames(contextDir: string): Map<string, string> {
  return new Map(listPeople(contextDir).map((p) => [p.slug, p.name]));
}

// ─── Home ────────────────────────────────────────────────────────────────────

export interface Home {
  tile: Tile;
  page: Page;
}

function surfaceOf(where: string): string {
  return where.split(/[:/]/)[0] || '?';
}

/** Home: the tape is the page. Top of mind and people sit beside it. */
export function homePage(contextDir: string, query: Record<string, string>, opts: CoreOptions = {}): Home {
  const tz = opts.timeZone ?? uiTimeZone();
  const nowMs = opts.nowMs ?? Date.now();
  const hours = Math.min(TAPE_MAX_HOURS, Math.max(TAPE_HOURS, Number.parseInt(query.hours ?? '', 10) || TAPE_HOURS));
  const all = tapeRows(contextDir, hours, nowMs);
  const surfaces = [...new Set(all.map((e) => surfaceOf(e.where)))].sort();
  const pick = query.where && surfaces.includes(query.where) ? query.where : '';
  const tape = pick ? all.filter((e) => surfaceOf(e.where) === pick) : all;

  // Group by the hour each happened in, newest first.
  const groups: { label: string; items: typeof tape }[] = [];
  const today = parts(new Date(nowMs).toISOString(), tz).day;
  for (const e of tape) {
    const p = parts(e.created, tz);
    const label = p.day === today ? p.hour : `${p.weekday} ${p.hour}`;
    const last = groups[groups.length - 1];
    if (last && last.label === label) last.items.push(e);
    else groups.push({ label, items: [e] });
  }
  const tapeBlocks: Block[] = [];
  if (surfaces.length > 1) {
    tapeBlocks.push({ type: 'filters', param: 'where', options: [{ value: '', label: 'Everywhere' }, ...surfaces.map((s) => ({ value: s, label: s }))] });
  }
  for (const g of groups) {
    tapeBlocks.push({ type: 'text', text: g.label, tone: 'muted' });
    tapeBlocks.push({
      type: 'list',
      items: g.items.map((e) => ({ text: e.title, meta: `${parts(e.created, tz).time} · ${e.where}`, page: memoryPage(e.ref) })),
    });
  }
  if (!tape.length) tapeBlocks.push({ type: 'text', text: pick ? `Nothing from ${pick} in the last ${hours}h.` : `Nothing in the last ${hours}h.`, tone: 'muted' });
  if (hours < TAPE_MAX_HOURS) {
    tapeBlocks.push({ type: 'link', text: 'Show earlier', page: `?hours=${Math.min(TAPE_MAX_HOURS, hours * 2)}${pick ? `&where=${pick}` : ''}` });
  }

  const heat = heatList(contextDir, { limit: HOME_MIND, nowMs });
  const people = listPeople(contextDir);
  const attention = people.filter((p) => p.stale || p.unverified || p.memories_since_synthesis);
  const sources = surfaces.length;

  const sections: Section[] = [
    {
      id: 'tape',
      title: 'What\'s happening',
      blocks: [
        { type: 'text', text: `${all.length} thing${all.length === 1 ? '' : 's'} in the last ${hours === 24 ? 'day' : `${hours}h`}, from ${sources} place${sources === 1 ? '' : 's'}.`, tone: 'muted' },
        ...tapeBlocks,
      ],
    },
    {
      id: 'mind',
      title: 'On my mind',
      side: true,
      blocks: heat.rows.length
        ? [{ type: 'list', items: heat.rows.map((m) => ({ text: m.title, meta: `${m.category} · ${m.heat.toFixed(2)}`, page: memoryPage(m.ref) })) },
          { type: 'link', text: 'Why these?', page: 'mind' }]
        : [{ type: 'text', text: 'Nothing hot yet.', tone: 'muted' }],
    },
  ];
  if (people.length) {
    sections.push({
      id: 'people',
      title: 'People',
      side: true,
      blocks: attention.length
        ? [{
            type: 'list',
            items: attention.map((p) => ({
              text: p.name,
              meta: [
                p.memories_since_synthesis ? `${p.memories_since_synthesis} new memor${p.memories_since_synthesis === 1 ? 'y' : 'ies'} not on the card` : '',
                p.stale ? `${p.stale} stale` : '',
                p.unverified ? `${p.unverified} unverified` : '',
              ].filter(Boolean).join(' · '),
              tone: 'warn' as const,
              page: personPage(p.slug),
            })),
          },
          { type: 'link', text: `All ${people.length} cards`, page: 'people' }]
        : [{ type: 'text', text: `All ${people.length} cards are current.`, tone: 'muted' }, { type: 'link', text: 'Open People', page: 'people' }],
    });
  }
  return {
    tile: {
      label: 'Memory',
      value: heat.total.toLocaleString('en-US'),
      detail: `${all.length} episodes today · ${people.length} people`,
      page: 'mind',
    },
    page: { title: 'Home', sections },
  };
}

// ─── Mind ────────────────────────────────────────────────────────────────────

function mindPage(contextDir: string, query: Record<string, string>, tz: string, nowMs: number): Page {
  const categories = ['user', 'feedback', 'project', 'self', 'reference', 'pursuit'];
  const category = categories.includes(query.category ?? '') ? query.category : undefined;
  const list = heatList(contextDir, { limit: MIND_SHOWN, category, nowMs });
  const names = peopleNames(contextDir);
  const pending = listProposals(contextDir).filter((p) => p.status === 'pending');
  const atWake = list.rows.filter((m) => m.inDigest);
  const below = list.rows.filter((m) => !m.inDigest);

  const sections: Section[] = [];
  if (pending.length) {
    sections.push({
      id: 'proposals',
      title: `${pending.length} proposal${pending.length === 1 ? '' : 's'} waiting`,
      blocks: [
        { type: 'text', text: 'Drafted memories that aren\'t real until they\'re ratified. Recall can\'t see them.', tone: 'muted' },
        ...pending.map((p): Block => ({
          type: 'details',
          summary: p.title ?? '(untitled)',
          meta: `#${p.id} · ${p.category ?? '?'}${p.source ? ` · from ${p.source}` : ''} · ${ago(p.created, tz, nowMs)}`,
          blocks: [
            { type: 'text', text: p.content ?? '' },
            { type: 'buttons', items: [
              { action: 'ratify', label: 'Ratify', tone: 'primary', fields: { id: String(p.id) } },
              { action: 'reject', label: 'Reject', tone: 'danger', confirm: 'It won\'t become a memory. The agent can propose it again later.', fields: { id: String(p.id) } },
            ] },
          ],
        })),
      ],
    });
  }
  sections.push({
    id: 'filter',
    blocks: [
      { type: 'filters', param: 'category', options: [{ value: '', label: 'Everything' }, ...categories.map((c) => ({ value: c, label: c }))] },
      { type: 'text', text: `${list.total.toLocaleString('en-US')} memories · ${list.inDigest} load at wake · heat is computed from timestamps when it's read`, tone: 'muted' },
    ],
  });
  sections.push({
    id: 'wake',
    title: category ? `At wake: ${category}` : 'What I wake up holding',
    blocks: atWake.length ? atWake.map((m) => memoryDetails(m, tz, nowMs, names)) : [{ type: 'text', text: 'None of these load at wake.', tone: 'muted' }],
  });
  if (below.length) {
    sections.push({
      id: 'below',
      title: 'Just below the line',
      blocks: below.map((m) => memoryDetails(m, tz, nowMs, names)),
    });
  }
  return {
    title: 'On my mind',
    intro: 'What I wake up holding. Each memory\'s heat decays by its category\'s half-life and comes back when it\'s recalled or edited. If something here doesn\'t belong, open it and see why.',
    sections,
  };
}

// ─── One memory ──────────────────────────────────────────────────────────────

function memoryPageFor(contextDir: string, ref: string, tz: string, nowMs: number): Page {
  const m = memoryByRef(contextDir, ref, nowMs);
  if (!m) return { title: 'Not found', sections: [] };
  const names = peopleNames(contextDir);
  const episode = m.category === 'episode';
  // What the board leads with: where it came from, when, how often it's come back, and who it's about.
  const summary: Block = { type: 'kv', items: [
    { label: 'Learned from', value: m.where ?? (m.sourcing ? `${m.sourcing}` : 'not recorded') },
    { label: 'First written', value: ago(m.created, tz, nowMs) },
    { label: 'Recalled', value: m.timesSeen > 0 && m.lastAccessed ? `${m.timesSeen}× · last ${ago(m.lastAccessed, tz, nowMs)}` : 'not yet' },
    ...(m.person ? [{ label: 'About', value: names.get(m.person) ?? m.person, page: personPage(m.person) }] : []),
  ] };
  const main: Block[] = [
    { type: 'prose', text: m.content },
    summary,
    { type: 'buttons', items: [{ action: 'archive', label: 'Archive', tone: 'danger', confirm: 'It leaves recall. It stays in the archive, and it can be restored from there.', fields: { ref: m.ref } }] },
  ];
  // Its history: what it says now, then each earlier body back to the first, newest first.
  const revs = memoryHistory(contextDir, m.ref);
  const gist = (t: string) => { const one = t.replace(/[*_`#>]+/g, '').replace(/\s+/g, ' ').trim(); return one.length > 160 ? `${one.slice(0, 159)}…` : one; };
  const history: Block | null = revs.length ? { type: 'list', items: [
    { text: gist(m.content), meta: `Now · ${m.updated ? `edited ${ago(m.updated, tz, nowMs)}` : `written ${ago(m.created, tz, nowMs)}`}` },
    ...revs.map((r, i) => {
      const from = revs[i + 1]?.at ?? m.created;
      return { text: gist(r.content), meta: `${ago(from, tz, nowMs)} · ${i === revs.length - 1 ? 'first written' : r.op === 'revision-restore' ? 'rolled back to' : 'revised'}` };
    }),
  ] } : null;
  const record: Block = {
    type: 'kv',
    items: [
      { label: 'category', value: m.category },
      { label: 'written', value: when(m.created, tz) },
      { label: 'last recalled', value: when(m.lastAccessed, tz) },
      { label: 'edited', value: when(m.updated, tz) },
      { label: 'seen', value: `${m.timesSeen} time${m.timesSeen === 1 ? '' : 's'}` },
      { label: 'sourcing', value: m.sourcing ?? 'unknown' },
      { label: 'scope', value: m.scope ?? (m.project ? 'project' : 'global') },
      ...(m.project ? [{ label: 'project', value: m.project }] : []),
      { label: 'expires', value: m.expiresAt ? when(m.expiresAt, tz) : 'never' },
      { label: 'ref', value: m.ref },
    ],
  };
  const sections: Section[] = [{ id: 'memory', blocks: main }];
  if (history) sections.push({ id: 'history', title: 'History', blocks: [history] });
  if (!episode) {
    sections.push({
      id: 'heat',
      title: 'Heat',
      side: true,
      blocks: [
        { type: 'stats', items: [{ label: 'now', value: m.heat.toFixed(2), tone: heatTone(m.heat) }, { label: 'half-life', value: `${m.halfLifeDays}d` }] },
        { type: 'text', text: why(m, tz, nowMs, names), tone: 'muted' },
      ],
    });
  }
  // The rest is machine detail, a tap away (HANDOFF: machine text goes behind a details).
  sections.push({ id: 'record', side: true, blocks: [{ type: 'details', summary: 'Machine details', meta: m.ref, blocks: [record] }] });
  return { title: m.title, sections };
}

// ─── People ──────────────────────────────────────────────────────────────────

function value(v: CardValue): string {
  return Array.isArray(v) ? v.join(', ') : String(v);
}

function peoplePage(contextDir: string): Page {
  const people = listPeople(contextDir);
  const attention = people.filter((p) => p.stale || p.unverified || p.memories_since_synthesis).length;
  return {
    title: 'People',
    intro: 'Who I know, where to reach them, and how they like to be talked to. Each card is a summary of what\'s in memory, with a date on every fact.',
    sections: [
      { id: 'counts', blocks: [{ type: 'stats', items: [
        { label: 'cards', value: String(people.length) },
        { label: 'need a look', value: String(attention), tone: attention ? 'warn' : 'ok' },
      ] }] },
      {
        id: 'everyone',
        blocks: people.length
          ? [{
              type: 'list',
              items: people.map((p) => {
                const n = p.memories_since_synthesis;
                const flag = [n ? `${n} new` : '', p.stale ? `${p.stale} stale` : '', p.unverified ? `${p.unverified} unverified` : ''].filter(Boolean).join(' · ');
                return { text: p.name, meta: p.slug, badge: flag || undefined, tone: flag ? 'warn' as const : undefined, page: personPage(p.slug) };
              }),
            }]
          : [{ type: 'text', text: 'No cards yet.', tone: 'muted' }],
      },
    ],
  };
}

function personPageFor(contextDir: string, slug: string, tz: string, nowMs: number): Page {
  let read;
  try { read = readPerson(contextDir, slug); } catch { return { title: 'Not found', sections: [] }; }
  // A piece can link to someone loom has no card for (it can't know which
  // cards exist): say so, and show what memory has about them anyway.
  if (!read.found || !('card' in read)) {
    const about = memoriesAbout(contextDir, slug, { limit: 8, nowMs });
    return {
      title: slug,
      sections: [
        { id: 'none', blocks: [{ type: 'callout', text: `There's no person card for ${slug} yet.` }] },
        ...(about.length ? [{ id: 'memories', title: 'What I remember about them', blocks: [{ type: 'list' as const, items: about.map((m) => ({ text: m.title, meta: ago(m.created, tz, nowMs), page: memoryPage(m.ref) })) }] }] : []),
      ],
    };
  }
  const card = read.card;
  const newer = memoriesAbout(contextDir, slug, { since: read.synthesized_at, nowMs });
  const recent = memoriesAbout(contextDir, slug, { limit: 8, nowMs });
  const sections: Section[] = [];
  if (newer.length) {
    sections.push({
      id: 'newer',
      title: `${newer.length} memor${newer.length === 1 ? 'y is' : 'ies are'} newer than this card`,
      tone: 'warn',
      blocks: [{ type: 'list', items: newer.map((m) => ({ text: m.title, meta: ago(m.created, tz, nowMs), page: memoryPage(m.ref) })) }],
    });
  }
  if (card.summary) sections.push({ id: 'summary', blocks: [{ type: 'text', text: card.summary }] });
  const where = Object.entries(card.where).sort(([a], [b]) => a.localeCompare(b));
  if (where.length) {
    sections.push({
      id: 'where',
      title: 'Where to reach them',
      blocks: [{
        type: 'table',
        columns: ['where', 'value', 'from', 'checked'],
        rows: where.map(([k, env]) => {
          const s = fieldState(env, nowMs);
          return [k, value(env.value), env.source ?? '', s.kind === 'ok' ? `ok, ${ago(env.verified_at ?? null, tz, nowMs)}` : s.kind === 'stale' ? `stale ${s.days}d` : 'unverified'];
        }),
      }],
    });
  }
  const how = Object.entries(card.how);
  if (how.length) sections.push({ id: 'how', title: 'How to talk to them', side: true, blocks: [{ type: 'kv', items: how.map(([k, v]) => ({ label: k, value: value(v) })) }] });
  if (card.may.length) {
    sections.push({
      id: 'may',
      title: 'What they\'re cleared for',
      side: true,
      blocks: [
        { type: 'list', items: card.may.map((m) => ({ text: m.text, meta: `said by ${m.source}` })) },
        { type: 'text', text: 'A description of what was agreed. Actual access is set where it\'s enforced, not here.', tone: 'muted' },
      ],
    });
  }
  if (recent.length) {
    sections.push({ id: 'memories', title: 'What I remember about them', blocks: [{ type: 'list', items: recent.map((m) => ({ text: m.title, meta: ago(m.created, tz, nowMs), page: memoryPage(m.ref) })) }] });
  }
  sections.push({ id: 'record', side: true, blocks: [{ type: 'kv', items: [
    { label: 'slug', value: card.slug },
    { label: 'card updated', value: when(read.updated, tz) },
    { label: 'summary written', value: when(read.synthesized_at, tz) },
  ] }] });
  return { title: card.name, sections };
}

// ─── Routing and actions ─────────────────────────────────────────────────────

/** One of loom's pages by path (not Home), or null when there's no such page. */
export function corePage(contextDir: string, path: string, query: Record<string, string>, opts: CoreOptions = {}): Page | null {
  const tz = opts.timeZone ?? uiTimeZone();
  const nowMs = opts.nowMs ?? Date.now();
  if (path === 'mind') return mindPage(contextDir, query, tz, nowMs);
  if (path === 'people') return peoplePage(contextDir);
  if (path.startsWith('people/')) return personPageFor(contextDir, path.slice('people/'.length), tz, nowMs);
  if (path.startsWith('memory/')) return memoryPageFor(contextDir, path.slice('memory/'.length), tz, nowMs);
  return null;
}

/** Run one of loom's own actions from the page. */
export async function coreAct(contextDir: string, action: string, fields: Record<string, string>): Promise<ActResult> {
  if (action === 'archive') {
    const ref = fields.ref ?? '';
    if (!ref) return { ok: false, message: 'No memory named.' };
    const out = await archive(contextDir, { ref, note: 'archived from loom\'s page' });
    return out.startsWith('Memory archived')
      ? { ok: true, message: 'Archived.', page: 'mind', undo: { action: 'restore', fields: { ref } } }
      : { ok: false, message: out };
  }
  if (action === 'restore') {
    const ref = fields.ref ?? '';
    if (!ref) return { ok: false, message: 'No memory named.' };
    const out = await restore(contextDir, { ref });
    return /^Memory restored|^Restored/i.test(out) ? { ok: true, message: 'Restored.', page: memoryPage(ref) ?? 'mind' } : { ok: false, message: out };
  }
  if (action === 'ratify' || action === 'reject') {
    const id = Number.parseInt(fields.id ?? '', 10);
    if (!Number.isSafeInteger(id) || id <= 0) return { ok: false, message: 'No proposal named.' };
    try {
      if (action === 'reject') {
        return rejectProposal(contextDir, id) ? { ok: true, message: `Proposal #${id} rejected.`, page: 'mind' } : { ok: false, message: `No proposal #${id}.` };
      }
      const ref = await ratifyProposal(contextDir, id);
      return { ok: true, message: `Proposal #${id} is a memory now.`, page: memoryPage(ref.ref) ?? 'mind' };
    } catch (err) {
      if (err instanceof UnknownProposalError) return { ok: false, message: `No proposal #${id}.` };
      return { ok: false, message: (err as Error).message };
    }
  }
  return { ok: false, message: `loom has no action "${action}".` };
}
