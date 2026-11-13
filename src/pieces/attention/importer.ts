import { attentionMigrations } from './schema/index.js';
/** Offline only. No operation or daemon path imports this module. */
import Database from 'better-sqlite3';
import { createHash } from 'node:crypto';
import { z } from 'zod';
import { statSync } from 'node:fs';
import { migrate, type Db } from '../../core/index.js';
import { conversationId, recordTurnInput, type Conversation } from './conversations.js';
import { digestId } from './digests.js';
import { findingId } from './retention.js';
import { answersOf, refsIn, type NeedsOwner } from './needs.js';
import type { Ask } from './role.js';

const slug = z.string().max(80).regex(/^[a-z0-9]+(-[a-z0-9]+)*$/);
const audience = z.object({ project: slug.optional(), member: slug.optional() }).strict();
const scopesSchema = z.record(z.string().regex(/^cv-[0-9a-f]{12}$/), audience);
export type ImportScopes = z.infer<typeof scopesSchema>;
const iso = z.string().regex(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,3})?Z$/).refine(s => Number.isFinite(Date.parse(s)) && new Date(s).toISOString().slice(0,19) === s.slice(0,19));
const integer = z.number().int().nonnegative();
const day = z.string().regex(/^\d{4}-\d\d-\d\d$/).refine(s => !Number.isNaN(Date.parse(s)) && new Date(s).toISOString().slice(0,10) === s);
const canonical = (v: unknown): string => Array.isArray(v) ? `[${v.map(canonical).join(',')}]` : v && typeof v === 'object' ? `{${Object.entries(v).sort(([a],[b]) => a.localeCompare(b)).map(([k,v]) => `${JSON.stringify(k)}:${canonical(v)}`).join(',')}}` : JSON.stringify(v);
type Row = Record<string, unknown>;
const tables = ['conversations','conversation_turns','conversation_days','conversation_digests','conversation_needs_answers','findings'] as const;
const destinations = ['attention_conversations','attention_turns','attention_days','attention_digests','attention_asks','attention_findings'] as const;
const json = (r: Row, k: string): unknown => JSON.parse(z.string().parse(r[k]));
const time = (v: unknown) => new Date(iso.parse(v)).toISOString();
const strings = (v: unknown) => z.array(z.string()).parse(v);
const check = (ok: unknown, message: string): void => { if (!ok) throw Error(`Invalid attention source: ${message}`); };
const storedNeeds = z.object({ ask: z.string().min(1), why: z.string().optional(), if_yes: z.string().optional(), if_no: z.string().optional(), href: z.string().optional(), refs: z.array(z.string()), answers: z.enum(['yes-no','words']).optional(), legacy: z.literal(true).optional(), waits_on: z.union([z.object({approval:z.string()}).strict(),z.object({task:z.string()}).strict()]).optional() }).strict();
const legacyAnswer = z.object({ digest: z.string(), conversation: z.string(), verdict: z.enum(['done','dismissed','replied','yes','no','resolved']), by: z.string().min(1), at: iso, reason: z.string().nullable().optional() }).strict();

/** Run before any writable destination open, including createFoundation. */
export function assertSeparateAttentionSources(from: string[], destination: string): void {
  let target;
  try { target = statSync(destination); }
  catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e; }
  for (const path of from) {
    const source = statSync(path);
    check(!target || source.dev !== target.dev || source.ino !== target.ino, 'source and destination must differ');
  }
}

/** A whole migration batch (one or more per-agent memories.db copies). Caller owns stopped-home lock. */
export function importAttention(db: Db, from: string[], scopesInput: ImportScopes, options: { interrupt?: () => void; afterSourceConversations?: () => void } = {}) {
  check(from.length > 0, 'at least one source required');
  const scopes = scopesSchema.parse(scopesInput);
  if (db.name && db.name !== ':memory:') assertSeparateAttentionSources(from,db.name);
  const snapshots = from.map(path => {
    const source = new Database(path, { readonly: true, fileMustExist: true });
    try {
      return source.transaction(() => {
        const held = new Set((source.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as { name: string }[]).map(r => r.name));
        check(tables.slice(0,4).every(t => held.has(t)), 'missing conversation tables');
        return Object.fromEntries(tables.map(table => {
          const rows = held.has(table) ? source.prepare(`SELECT rowid AS _rowid, * FROM ${table} ORDER BY rowid`).all() as Row[] : [];
          if (table === 'conversations') options.afterSourceConversations?.();
          return [table, rows];
        })) as Record<typeof tables[number], Row[]>;
      })();
    } finally { source.close(); }
  });
  // Batch ordering and source filenames are immaterial; every consumed column and rowid is covered.
  snapshots.sort((a,b) => canonical(a).localeCompare(canonical(b)));
  const checksum = createHash('sha256').update(canonical({ snapshots, scopes })).digest('hex');
  const rows = (table: typeof tables[number]) => snapshots.flatMap(s => s[table]);
  const expected: Record<typeof destinations[number], Row[]> = Object.fromEntries(destinations.map(t => [t, []])) as unknown as Record<typeof destinations[number], Row[]>;
  const conversations = new Map<string, Conversation>();
  const originalBounds = new Map<string, { started: string; last: string }>();
  for (const r of rows('conversations')) {
    const agent = z.string().regex(/^[a-z][a-z0-9-]{0,39}$/).parse(r.agent);
    const venue = z.string().regex(/^[a-z][a-z0-9-]{0,31}$/).parse(r.venue), place = z.string().min(1).max(200).parse(r.place);
    const id = conversationId(agent, venue, place);
    check(r.id === id && !conversations.has(id), 'conversation identity or duplicate source');
    check(Object.hasOwn(scopes, id), `explicit audience required for ${id}`);
    const c: Conversation = { ...scopes[id], id, agent, venue, place, label: z.string().nullable().parse(r.label), people: z.array(slug).max(32).parse(json(r,'people_json')), agents: z.array(z.string().regex(/^[a-z][a-z0-9-]{0,39}$/)).max(16).parse(json(r,'agents_json')), projects: [], started: time(r.started), last: time(r.last), turns: integer.parse(r.last_seq) };
    originalBounds.set(id,{started:String(r.started),last:String(r.last)}); conversations.set(id,c);
  }
  check(Object.keys(scopes).every(id => conversations.has(id)), 'unused audience map entry');
  const parent = (r: Row) => { const c = conversations.get(String(r.conversation)); check(c, 'orphan record'); return c!; };
  const scope = (c: Conversation) => ({ agent: c.agent, ...scopes[c.id] });
  for (const r of rows('conversation_turns')) {
    const c = parent(r), seq = integer.min(1).parse(r.seq);
    check(seq <= c.turns, 'turn exceeds sequence high-water mark');
    const raw: Row = { venue: c.venue, place: c.place, at: time(r.at), kind: r.kind, from: json(r,'from_json') };
    for (const k of ['run','model','harness','outcome']) if (r[k] !== null && r[k] !== undefined) raw[k] = r[k];
    const { turn } = recordTurnInput.parse({ agent: c.agent, turn: raw });
    const writer = z.string().min(1).parse(r.writer);
    const record = { ...turn, ...scope(c), id: `${c.id}:${seq}`, conversation: c.id, seq, writer: { kind: 'legacy', id: writer }, ...(r.latency_ms !== null ? { latency_ms: integer.parse(r.latency_ms) } : {}) };
    expected.attention_turns.push({ id: record.id, conversation: c.id, seq, record: JSON.stringify(record) });
  }
  for (const c of conversations.values()) {
    const times = [c.started,c.last,...expected.attention_turns.filter(t => t.conversation === c.id).map(t => String(JSON.parse(String(t.record)).at))].sort();
    if (times[0] !== c.started || times.at(-1) !== c.last) c.legacyBounds = originalBounds.get(c.id)!;
    c.started = times[0]; c.last = times.at(-1)!;
  }
  const folded = new Set<string>();
  for (const r of rows('conversation_days')) {
    const c = parent(r), d = day.parse(r.day), id = `${c.id}:${d}`;
    const counts = z.partialRecord(z.enum(['message','reply','action','wake','note','refused']), integer).parse(json(r,'counts_json'));
    const rawOutcomes = json(r,'outcomes_json');
    check(rawOutcomes && typeof rawOutcomes === 'object' && !Array.isArray(rawOutcomes), 'model outcomes object');
    // Model labels are arbitrary printable strings; retain prototype-like own keys too.
    const outcomes = Object.fromEntries(Object.entries(rawOutcomes as Row).map(([model,counts]) => [model,z.partialRecord(z.enum(['answered','progressed','deferred','failed','none']), integer).parse(counts)]));
    const record = { ...scope(c), id, conversation: c.id, day: d, counts, median_latency_ms: r.median_latency_ms === null ? null : integer.parse(r.median_latency_ms), outcomes };
    folded.add(id); expected.attention_days.push({ id, conversation: c.id, day: d, record: JSON.stringify(record) });
  }
  for (const row of expected.attention_turns) { const t = JSON.parse(String(row.record)); check(!folded.has(`${t.conversation}:${t.at.slice(0,10)}`), 'held turn on folded day'); }
  for (const c of conversations.values()) {
    const held = expected.attention_turns.filter(r => r.conversation === c.id).length;
    const foldedCount = expected.attention_days.filter(r => r.conversation === c.id).reduce((sum,r) => sum + Object.values(JSON.parse(String(r.record)).counts as Record<string,number>).reduce((a,b) => a+b,0),0);
    check(held + foldedCount === c.turns, 'turn counts disagree with sequence high-water mark');
  }
  const answers = new Map<string, z.infer<typeof legacyAnswer>>();
  for (const r of rows('conversation_needs_answers')) {
    const { _rowid, ...raw } = r;
    const a = legacyAnswer.parse(raw); parent(a); check(!answers.has(a.digest), 'duplicate answer'); answers.set(a.digest,a);
  }
  const digests = rows('conversation_digests').sort((a,b) => time(a.at).localeCompare(time(b.at)) || Number(a._rowid) - Number(b._rowid));
  const latest = new Map<string, string>();
  for (const r of digests) latest.set(String(r.conversation),String(r.id));
  const orders = new Map<string, number>();
  for (const r of digests) {
    const c = parent(r), run = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:@-]{0,127}$/).parse(r.run), id = digestId(c.id,run), at = time(r.at);
    check(id === r.id, 'digest identity');
    const stored = r.needs_owner_json == null ? null : storedNeeds.parse(JSON.parse(z.string().parse(r.needs_owner_json)));
    let needs: NeedsOwner | null = null;
    if (r.needs_owner !== null) {
      if (stored) needs = stored;
      else {
        const ask = z.string().min(1).parse(r.needs_owner), refs = refsIn(ask), approvals = refs.filter(s => /^a-[0-9a-f]{8}$/.test(s));
        needs = { ask, refs, legacy: true, ...(r.needs_owner_href ? { href: z.string().parse(r.needs_owner_href) } : {}), ...(approvals.length === 1 ? { waits_on: { approval: approvals[0] } } : {}) };
      }
      check(needs && typeof needs.ask === 'string' && needs.ask === r.needs_owner && Array.isArray(needs.refs), 'stored question');
    }
    const a = answers.get(id); if (a) check(a.conversation === c.id, 'answer conversation mismatch');
    const order = (orders.get(c.id) ?? 0) + 1; orders.set(c.id,order);
    const askId = needs ? `${id}:1` : null;
    const projects = z.array(slug).parse(json(r,'projects_json'));
    c.projects = [...new Set([...c.projects,...projects])].sort();
    const record = { ...scope(c), id, conversation: c.id, run, at, revision: 1, order, summary: z.string().parse(r.summary), asks: strings(json(r,'asks_json')), decisions: strings(json(r,'decisions_json')), tasks: strings(json(r,'tasks_json')), projects, needs_owner: needs, ask: askId, ...(a ? { legacyAnswer: a } : {}) };
    expected.attention_digests.push({ id, conversation: c.id, revision: 1, record: JSON.stringify(record) });
    if (needs && askId) {
      const { legacy: _legacy, ...question } = needs;
      const ask: Ask = { ...question, answers: answersOf(needs), ...scope(c), id: askId, source: { kind: 'conversation', id: c.id }, state: latest.get(c.id) === id ? 'open' : 'resolved', createdAt: Date.parse(at), changedAt: Date.parse(at) };
      if (ask.state === 'resolved') ask.resolution = 'Superseded by a later digest';
      if (a && Date.parse(a.at) >= Date.parse(at)) {
        ask.changedAt = Date.parse(a.at);
        if (a.verdict === 'resolved') { ask.state = 'resolved'; ask.resolution = a.reason ?? 'Resolved in legacy store'; }
        else { ask.state = 'answered'; delete ask.resolution; ask.answer = { kind: a.verdict === 'dismissed' ? 'dismiss' : a.verdict, by: { kind: 'member', id: a.by }, at: Date.parse(a.at) }; }
      }
      expected.attention_asks.push({ id: ask.id, record: JSON.stringify(ask) });
    }
  }
  check([...answers.keys()].every(id => digests.some(d => d.id === id)), 'orphan answer');
  for (const r of rows('findings')) {
    const c = parent(r), d = day.parse(r.day), id = findingId(c.id,d), seq = integer.min(1).parse(r.seq);
    check(r.id === id && seq <= c.turns, 'finding identity or sequence');
    const held = expected.attention_turns.find(t => t.conversation === c.id && t.seq === seq);
    check(held ? JSON.parse(String(held.record)).at.slice(0,10) === d : folded.has(`${c.id}:${d}`), 'finding day has no matching held or folded turn');
    const record = { ...scope(c), id, conversation: c.id, seq, day: d, measure: z.string().min(1).parse(r.measure), score: z.number().min(1).max(5).nullable().parse(r.score), text: z.string().min(1).max(200).regex(/^[^\x00-\x1f\x7f]+$/).parse(r.text), at: time(r.at) };
    expected.attention_findings.push({ id, conversation: c.id, day: d, record: JSON.stringify(record) });
  }
  for (const c of conversations.values()) expected.attention_conversations.push({ id: c.id, record: JSON.stringify(c) });
  const counts = Object.fromEntries(destinations.map(t => [t,expected[t].length]));
  return db.transaction(() => {
    migrate(db,'attention',attentionMigrations);
    const marker = db.prepare("SELECT checksum FROM attention_import WHERE id='source'").get() as { checksum: string } | undefined;
    if (marker) { if (marker.checksum !== checksum) throw Error('A different attention source was already imported'); return { ok: true, imported: false, checksum, counts }; }
    for (const t of [...destinations,'attention_statuses']) check(!(db.prepare(`SELECT 1 FROM ${t} LIMIT 1`).get()), 'destination must be empty');
    for (const table of destinations) for (const row of expected[table]) {
      const columns = Object.keys(row);
      db.prepare(`INSERT INTO ${table} (${columns.join(',')}) VALUES (${columns.map(() => '?').join(',')})`).run(...Object.values(row));
    }
    options.interrupt?.();
    for (const table of destinations) {
      const actual = (db.prepare(`SELECT * FROM ${table}`).all() as Row[]).sort((a,b) => String(a.id).localeCompare(String(b.id)));
      const sorted = [...expected[table]].sort((a,b) => String(a.id).localeCompare(String(b.id)));
      check(canonical(actual) === canonical(sorted), `${table} comparison failed: ids, counts or content differ`);
    }
    db.prepare("INSERT INTO attention_import VALUES ('source',?)").run(checksum);
    return { ok: true, imported: true, checksum, counts };
  })();
}
