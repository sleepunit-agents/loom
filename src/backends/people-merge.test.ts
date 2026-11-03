/**
 * Merge two person cards into one (docs/specs/person-cards.md, "Merge"): the card, every
 * agent's copy, the re-tags, the redirect, the refusals and the dry run.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import BetterSqlite3 from 'better-sqlite3';
import { PeopleStore, roomBlock, type PersonCard } from './people.js';
import { checkMergeInput, mergeCardInto, mergeLine, mergePeople, PersonMergeError, relinkCard } from './people-merge.js';
import { checkEnsureInput, ensurePerson } from './people-ensure.js';
import { commonsPeoplePath, openHouseholdPeople } from './people-household.js';
import { recordTurn, listConversations } from './conversations.js';
import { agentDir, loadHousehold, type Household } from '../household.js';
import { resolveSqliteDbPath } from '../config.js';

const NOW = Date.parse('2026-11-02T20:00:00Z');
const now = () => NOW;

/** The memories and proposals tables, as much of them as a merge and person_list read. */
function seedMemoryTables(dbPath: string): void {
  const db = new BetterSqlite3(dbPath);
  db.exec(`CREATE TABLE IF NOT EXISTS memories (id INTEGER PRIMARY KEY AUTOINCREMENT, ref TEXT, category TEXT NOT NULL,
             metadata TEXT NOT NULL DEFAULT '{}', created TEXT NOT NULL, archived INTEGER NOT NULL DEFAULT 0, expires_at TEXT);
           CREATE TABLE IF NOT EXISTS proposals (id INTEGER PRIMARY KEY AUTOINCREMENT, metadata TEXT DEFAULT '{}', status TEXT NOT NULL DEFAULT 'pending');`);
  db.close();
}

function remember(dbPath: string, ref: string, metadata: Record<string, unknown>, opts: { archived?: boolean; created?: string } = {}): void {
  const db = new BetterSqlite3(dbPath);
  db.prepare('INSERT INTO memories (ref, category, metadata, created, archived) VALUES (?, ?, ?, ?, ?)')
    .run(ref, 'user', JSON.stringify(metadata), opts.created ?? '2026-10-01T00:00:00Z', opts.archived ? 1 : 0);
  db.close();
}

function propose(dbPath: string, metadata: Record<string, unknown>): void {
  const db = new BetterSqlite3(dbPath);
  db.prepare('INSERT INTO proposals (metadata) VALUES (?)').run(JSON.stringify(metadata));
  db.close();
}

function metadataOf(dbPath: string, table: 'memories' | 'proposals'): Array<Record<string, unknown>> {
  const db = new BetterSqlite3(dbPath, { readonly: true });
  try { return (db.prepare(`SELECT metadata FROM ${table} ORDER BY id`).all() as Array<{ metadata: string }>).map((r) => JSON.parse(r.metadata)); } finally { db.close(); }
}

function turn(contextDir: string, agent: string, place: string, slug: string): void {
  recordTurn(contextDir, agent, { venue: 'slack', place, at: '2026-11-01T10:00:00Z', from: { kind: 'person', slug }, kind: 'message' }, 'test');
}

function turnsFrom(dbPath: string): string[] {
  const db = new BetterSqlite3(dbPath, { readonly: true });
  try { return (db.prepare('SELECT from_json FROM conversation_turns ORDER BY conversation, seq').all() as Array<{ from_json: string }>).map((r) => JSON.parse(r.from_json).slug); } finally { db.close(); }
}

const card = (c: Partial<PersonCard> & { slug: string; name: string }): PersonCard => ({ where: {}, how: {}, may: [], ...c });

describe('mergeCardInto: the card', () => {
  it("unions where by id, keeps a field only from has whole, and keeps into's name and summary plus the merge line", () => {
    const into = card({
      slug: 'patrick-kells', name: 'Patrick Kells', summary: 'Field lead at Livonia.',
      where: { slack: { value: 'U0B1N54JLMD (Onterris)', verified_at: '2026-10-29T22:09:32Z', source: 'bridge', label: 'Patrick Kells' } },
      how: { tz: 'America/New_York', mode: 'terse' },
      may: [{ text: 'may draft field changes', source: 'Jonathan' }],
    });
    const from = card({
      slug: 'pat-k', name: 'Pat K', summary: "Mark's notes on Pat.",
      where: {
        slack: { value: ['U0B1N54JLMD', 'U0SECOND'], verified_at: '2026-10-01T00:00:00Z', source: 'shuttle gates', label: '@pat' },
        discord: { value: '42', verified_at: '2026-10-20T00:00:00Z', source: 'discord bridge' },
      },
      how: { tz: 'America/Chicago', loop_in: ['phil-baker'] },
      may: [{ text: 'may draft field changes', source: 'Jonathan' }, { text: 'may file tickets', source: 'Phil' }],
    });
    const out = mergeCardInto(into, from, mergeLine('pat-k', 'Pat K', '2026-11-02T20:00:00Z'));
    expect(out.card.name).toBe('Patrick Kells');
    expect(out.card.summary).toBe('Field lead at Livonia.\nMerged pat-k (Pat K) 2026-11-02');
    // A value whose id is already there counts as there; the new one joins it.
    expect(out.where_added).toEqual({ slack: ['U0SECOND'], discord: ['42'] });
    expect(out.card.where.slack).toEqual({
      value: ['U0B1N54JLMD (Onterris)', 'U0SECOND'], verified_at: '2026-10-01T00:00:00Z',
      source: 'bridge; shuttle gates', label: 'Patrick Kells / @pat',
    });
    // A field only from has comes whole: its own verification and source.
    expect(out.card.where.discord).toEqual({ value: '42', verified_at: '2026-10-20T00:00:00Z', source: 'discord bridge' });
    // how: the union, into winning a key.
    expect(out.card.how).toEqual({ tz: 'America/New_York', mode: 'terse', loop_in: ['phil-baker'] });
    expect(out.how_added).toEqual(['loop_in']);
    expect(out.card.may).toEqual([{ text: 'may draft field changes', source: 'Jonathan' }, { text: 'may file tickets', source: 'Phil' }]);
    expect(out.may_added).toBe(1);
  });

  it("a shared field with an unverified side is unverified; from's summary stands in when into's copy has none", () => {
    const out = mergeCardInto(card({ slug: 'a', name: 'A', where: { slack: { value: 'U1', verified_at: '2026-10-29T00:00:00Z' } } }),
      card({ slug: 'b', name: 'B', summary: 'From B.', where: { slack: { value: 'U2' } } }), 'Merged b (B) 2026-11-02');
    expect(out.card.where.slack).toEqual({ value: ['U1', 'U2'] });
    expect(out.card.summary).toBe('From B.\nMerged b (B) 2026-11-02');
  });

  it('relinks how.via and how.loop_in, and nothing else', () => {
    expect(relinkCard(card({ slug: 'x', name: 'X', how: { via: 'pat-k', loop_in: ['pat-k', 'patrick-kells', 'phil'] } }), 'pat-k', 'patrick-kells')!.how)
      .toEqual({ via: 'patrick-kells', loop_in: ['patrick-kells', 'phil'] });
    expect(relinkCard(card({ slug: 'x', name: 'X', how: { mode: 'pat-k' } }), 'pat-k', 'patrick-kells')).toBeNull();
  });

  it('checks its input: two valid, different slugs', () => {
    expect(() => checkMergeInput({ from: 'a', into: 'a' })).toThrow(/a card isn't merged into itself/);
    expect(() => checkMergeInput({ from: '../x', into: 'a' })).toThrow(/^from: /);
    expect(() => checkMergeInput({ from: 'a', into: 'B' })).toThrow(/^into: /);
    expect(() => checkMergeInput({ from: 'a', into: 'b', force: true })).toThrow(/force: unknown key/);
    expect(() => checkMergeInput({ from: 'a', into: 'b', dry_run: 'yes' })).toThrow(/dry_run/);
  });
});

describe('mergePeople, one store (no household)', () => {
  let ctx: string;
  let db: string;
  beforeEach(() => {
    ctx = mkdtempSync(join(tmpdir(), 'loom-merge-'));
    db = resolveSqliteDbPath(ctx);
    seedMemoryTables(db);
    const st = new PeopleStore({ dbPath: db, actor: 'art', now });
    st.write({ slug: 'patrick-kells', name: 'Patrick Kells', summary: 'Field lead.', where: { slack: { value: 'U0B1N54JLMD' } }, how: { tz: 'America/New_York' } });
    st.write({ slug: 'pat-k', name: 'Pat K', summary: 'Met in #studio.', where: { discord: { value: '42' } }, how: { mode: 'terse' } });
    st.write({ slug: 'phil-baker', name: 'Phil Baker', how: { loop_in: ['pat-k'] } });
    st.close();
    remember(db, 'user/a', { person: 'pat-k', where: 'discord' });
    remember(db, 'user/b', { person: 'pat-k' }, { archived: true });
    remember(db, 'user/c', { people: ['pat-k', 'patrick-kells', 'allison'] });
    remember(db, 'user/d', { person: 'patrick-kells' });
    remember(db, 'user/e', { person: 'pat-kells' });
    propose(db, { person: 'pat-k' });
    turn(ctx, 'art', 'C1', 'pat-k');
    turn(ctx, 'art', 'C1', 'patrick-kells');
    turn(ctx, 'art', 'C2', 'pat-k');
  });
  afterEach(() => rmSync(ctx, { recursive: true, force: true }));

  const merge = (input: Record<string, unknown>) => mergePeople({ contextDir: ctx, agentName: 'art', actor: 'art', now }, input as never);
  const open = () => new PeopleStore({ dbPath: db, readonly: true, now });

  it('a dry run reports what would change and writes nothing', () => {
    const out = merge({ from: 'pat-k', into: 'patrick-kells', dry_run: true });
    expect(out).toMatchObject({
      dry_run: true, resumed: false, where_added: { discord: ['42'] }, how_added: ['mode'],
      agents: { art: { card: 'merged', memories: 3, proposals: 1, conversations: 2, turns: 2, relinked: ['phil-baker'] } },
    });
    expect(out.card.summary).toBe('Field lead.\nMerged pat-k (Pat K) 2026-11-02');
    expect(out.not_done.join('\n')).toMatch(/gates: rename pat-k to patrick-kells in every agent's gates/);
    const st = open();
    try {
      expect(st.getRow('pat-k')!.archived_at).toBeNull();
      expect(st.mergeOf('pat-k')).toBeNull();
      expect(st.getRow('patrick-kells')!.card.where.discord).toBeUndefined();
    } finally { st.close(); }
    expect(metadataOf(db, 'memories')[0].person).toBe('pat-k');
  });

  it('merges the card, re-tags every memory, proposal, conversation and turn, and leaves a redirect', () => {
    const out = merge({ from: 'pat-k', into: 'patrick-kells' });
    expect(out.agents.art).toEqual({ card: 'merged', memories: 3, proposals: 1, conversations: 2, turns: 2, relinked: ['phil-baker'] });
    const st = open();
    try {
      const into = st.getRow('patrick-kells')!;
      expect(into.card).toMatchObject({ name: 'Patrick Kells', summary: 'Field lead.\nMerged pat-k (Pat K) 2026-11-02',
        where: { slack: { value: 'U0B1N54JLMD' }, discord: { value: '42' } }, how: { tz: 'America/New_York', mode: 'terse' } });
      // Its summary no longer condenses everything tagged to it: the consolidation lane picks it up.
      expect(into.synthesized_at).toBeNull();
      expect(st.getRow('pat-k')).toMatchObject({ archived_at: '2026-11-02T20:00:00.000Z', archived_by: 'art', archive_reason: 'merged into patrick-kells' });
      expect(st.mergeOf('pat-k')).toMatchObject({ from: 'pat-k', into: 'patrick-kells', by: 'art', counts: { agents: { art: { memories: 3, turns: 2 } } } });
      expect(st.getRow('phil-baker')!.card.how.loop_in).toEqual(['patrick-kells']);
      // History: who merged, and from's card kept under into's slug (its summary with it).
      const hist = st.history('patrick-kells');
      expect(hist.map((r) => r.op).slice(0, 2).sort()).toEqual(['merge', 'merged_from']);
      expect(hist.every((r) => r.actor === 'art')).toBe(true);
      const kept = hist.find((r) => r.op === 'merged_from')!;
      expect(st.revisionSnapshot(kept.id)!.card.summary).toBe('Met in #studio.');
    } finally { st.close(); }
    const meta = metadataOf(db, 'memories');
    expect(meta.map((m) => m.person ?? null)).toEqual(['patrick-kells', 'patrick-kells', null, 'patrick-kells', 'pat-kells']);
    expect(meta[0].where).toBe('discord');
    expect(meta[2].people).toEqual(['patrick-kells', 'allison']);
    expect(metadataOf(db, 'proposals')[0].person).toBe('patrick-kells');
    expect(listConversations(ctx, {}).map((c) => c.people).sort()).toEqual([['patrick-kells'], ['patrick-kells']]);
    expect(turnsFrom(db)).toEqual(['patrick-kells', 'patrick-kells', 'patrick-kells']);
  });

  it('reading from answers into with a note; writes, verify and ensure to from land on into; restore is refused', () => {
    merge({ from: 'pat-k', into: 'patrick-kells' });
    const st = new PeopleStore({ dbPath: db, actor: 'art', now });
    try {
      const read = st.read('pat-k');
      expect(read).toMatchObject({ found: true, card: { slug: 'patrick-kells' }, merged: { from: 'pat-k', into: 'patrick-kells' } });
      expect('rendered' in read && read.rendered).toMatch(/_\(pat-k was merged into patrick-kells 2026-11-02: this is patrick-kells's card\)_$/);
      const w = st.write({ slug: 'pat-k', how: { pronouns: 'he/him' } });
      expect(w).toMatchObject({ redirected_from: 'pat-k', card: { slug: 'patrick-kells', how: { pronouns: 'he/him' } } });
      expect(st.verify({ slug: 'pat-k', fields: ['discord'] })).toMatchObject({ redirected_from: 'pat-k', card: { slug: 'patrick-kells' } });
      expect(ensurePerson(st, checkEnsureInput({ slug: 'pat-k', name: 'Pat', source: 'test', where: { github: { value: 'patk' } } })))
        .toMatchObject({ slug: 'patrick-kells', redirected_from: 'pat-k', added: { github: ['patk'] } });
      // from's own (archived) values are into's now: an ensure of into with one of them isn't "another card's".
      expect(ensurePerson(st, checkEnsureInput({ slug: 'patrick-kells', name: 'P', source: 'test', where: { discord: { value: '42' } } }))).toMatchObject({ unchanged: true });
      expect(st.getRow('pat-k')!.archived_at).not.toBeNull();
      expect(() => st.restore({ slug: 'pat-k' })).toThrow(/merged into patrick-kells: a merged card stays a redirect/);
      expect(st.list(true).find((e) => e.slug === 'pat-k')).toMatchObject({ archived: true, merged_into: 'patrick-kells' });
      expect(st.list().map((e) => e.slug)).not.toContain('pat-k');
    } finally { st.close(); }
    // The room: from reads as into, once however it's named.
    const room = roomBlock(ctx, ['pat-k', 'patrick-kells'], { nowMs: NOW })!;
    expect(room.match(/## Patrick Kells \(patrick-kells\)/g)).toHaveLength(1);
    expect(room).not.toMatch(/archived/);
  });

  it('refuses a missing or archived card, from equal to into, and a second merge elsewhere; a repeat finishes, changing nothing', () => {
    expect(() => merge({ from: 'nobody', into: 'patrick-kells' })).toThrow(PersonMergeError);
    expect(() => merge({ from: 'nobody', into: 'patrick-kells' })).toThrow(/no card for nobody/);
    expect(() => merge({ from: 'pat-k', into: 'nobody' })).toThrow(/no card for nobody/);
    expect(() => merge({ from: 'pat-k', into: 'pat-k' })).toThrow(/isn't merged into itself/);
    const st = new PeopleStore({ dbPath: db, actor: 'art', now });
    try { st.archive({ slug: 'phil-baker', reason: 'left', actor: 'art' }); } finally { st.close(); }
    expect(() => merge({ from: 'phil-baker', into: 'patrick-kells' })).toThrow(/card for phil-baker is archived/);
    expect(() => merge({ from: 'pat-k', into: 'phil-baker' })).toThrow(/card for phil-baker is archived/);
    merge({ from: 'pat-k', into: 'patrick-kells' });
    expect(() => merge({ from: 'pat-k', into: 'phil-baker' })).toThrow(/pat-k was already merged into patrick-kells/);
    expect(() => merge({ from: 'patrick-kells', into: 'pat-k' })).toThrow(/pat-k was merged into patrick-kells: merge into patrick-kells/);
    const again = merge({ from: 'pat-k', into: 'patrick-kells' });
    expect(again).toMatchObject({ resumed: true, agents: { art: { card: 'none', memories: 0, conversations: 0, turns: 0 } } });
  });

  it('a cardless from: its tags move to into and it redirects; into\'s summary is due a re-read', () => {
    remember(db, 'user/f', { person: 'patrick' });
    const out = merge({ from: 'patrick', into: 'patrick-kells' });
    expect(out).toMatchObject({ cardless: true, agents: { art: { card: 'none', memories: 1 } } });
    const st = open();
    try {
      expect(st.getRow('patrick')).toBeNull();
      expect(st.resolve('patrick')).toBe('patrick-kells');
      expect(st.getRow('patrick-kells')!.synthesized_at).toBeNull();
    } finally { st.close(); }
    expect(metadataOf(db, 'memories').at(-1)!.person).toBe('patrick-kells');
  });

  it('refuses a merge whose card would break the schema, naming why, and writes nothing', () => {
    const st = new PeopleStore({ dbPath: db, actor: 'art', now });
    try { st.write({ slug: 'patrick-kells', summary: 'x'.repeat(1195) }); } finally { st.close(); }
    expect(() => merge({ from: 'pat-k', into: 'patrick-kells' })).toThrow(/the merged card .* would be refused: summary: longer than 1200/);
    expect(metadataOf(db, 'memories')[0].person).toBe('pat-k');
  });
});

describe('mergePeople, in a household with two agents each holding a copy', () => {
  let h: Household;
  const dbOf = (a: string) => resolveSqliteDbPath(agentDir(h, a));
  beforeEach(() => {
    const home = mkdtempSync(join(tmpdir(), 'loom-merge-hh-'));
    for (const a of ['art', 'mark']) {
      mkdirSync(join(home, 'agents', a), { recursive: true });
      writeFileSync(join(home, 'agents', a, 'IDENTITY.md'), `# ${a}\n`);
    }
    writeFileSync(join(home, 'household.json'), JSON.stringify({ v: 1, agents: ['art', 'mark'], default: 'art', members: [{ person: 'jonathan', role: 'owner', agents: '*' }] }));
    h = loadHousehold(home)!;
    // Art met Grace on Slack and made grace-aquino; Mark met her on Discord and made grace. Both know grace-aquino too? Art does.
    const art = openHouseholdPeople(h, 'art', agentDir(h, 'art'), { now })!;
    try {
      art.write({ slug: 'grace-aquino', name: 'Grace Aquino', summary: 'Toxicologist at Onterris.', where: { slack: { value: 'U08C330F8AG (Onterris)', verified_at: '2026-11-02T19:00:00Z' } }, how: { tz: 'America/Detroit', mode: 'warm' } });
      art.write({ slug: 'grace', name: 'Grace', summary: 'Asked about the pond rig once.', how: { mode: 'brief' } });
    } finally { art.close(); }
    const mark = openHouseholdPeople(h, 'mark', agentDir(h, 'mark'), { now })!;
    try {
      mark.write({ slug: 'grace', name: 'Grace', summary: 'Plays bass in #studio.', where: { discord: { value: '1559', label: '@grace' } }, how: { pronouns: 'she/her', loop_in: 'jonathan' }, may: [{ text: 'may book studio time', source: 'Jonathan' }] });
      mark.write({ slug: 'fez', name: 'Fez', how: { kind: 'agent', via: 'grace' } });
    } finally { mark.close(); }
    for (const a of ['art', 'mark']) seedMemoryTables(dbOf(a));
    remember(dbOf('art'), 'user/a1', { person: 'grace' });
    remember(dbOf('art'), 'user/a2', { person: 'grace-aquino' });
    remember(dbOf('mark'), 'user/m1', { person: 'grace' });
    remember(dbOf('mark'), 'user/m2', { person: 'grace' });
    turn(agentDir(h, 'mark'), 'mark', 'D1', 'grace');
    // A project hub in mark's store lists whoever has a `studio` where field.
    const pdb = new BetterSqlite3(dbOf('mark'));
    pdb.exec(`CREATE TABLE IF NOT EXISTS projects (slug TEXT PRIMARY KEY, name TEXT, status TEXT, card_json TEXT, archived_at TEXT, archived_by TEXT, archive_reason TEXT, updated TEXT, synthesized_at TEXT)`);
    pdb.prepare('INSERT INTO projects (slug, name, status, card_json, updated) VALUES (?, ?, ?, ?, ?)').run('discord', 'Discord', 'active', JSON.stringify({ slug: 'discord', name: 'Discord', status: 'active', where: {}, links: {} }), '2026-11-01T00:00:00Z');
    pdb.close();
  });
  afterEach(() => rmSync(h.home, { recursive: true, force: true }));

  const merge = (input: Record<string, unknown>, hh = h) => mergePeople({ household: hh, viewer: 'art', actor: 'owner', now }, input as never);
  const store = (path: string) => new PeopleStore({ dbPath: path, readonly: true, now });

  it("a dry run counts each agent's re-tags and the project hubs, and writes nothing", () => {
    const out = merge({ from: 'grace', into: 'grace-aquino', dry_run: true });
    expect(out).toMatchObject({
      where_added: { discord: ['1559'] },
      agents: {
        art: { card: 'merged', memories: 1, proposals: 0, conversations: 0, turns: 0 },
        mark: { card: 'moved', memories: 2, conversations: 1, turns: 1, relinked: [] },
      },
      directory: { relinked: ['fez'] },
      projects: [{ agent: 'mark', project: 'discord', field: 'discord' }],
    });
    const dir = store(commonsPeoplePath(h));
    try { expect(dir.getRow('grace')!.archived_at).toBeNull(); expect(dir.mergeOf('grace')).toBeNull(); } finally { dir.close(); }
    expect(metadataOf(dbOf('mark'), 'memories').map((m) => m.person)).toEqual(['grace', 'grace']);
  });

  it("merges the directory entry and every agent's copy, re-tags both stores, and redirects for every agent", () => {
    const out = merge({ from: 'grace', into: 'grace-aquino' });
    expect(out.agents).toMatchObject({ art: { card: 'merged', memories: 1 }, mark: { card: 'moved', memories: 2, conversations: 1, turns: 1 } });
    const dir = store(commonsPeoplePath(h));
    try {
      expect(dir.getRow('grace-aquino')!.card).toMatchObject({
        name: 'Grace Aquino', where: { slack: { value: 'U08C330F8AG (Onterris)' }, discord: { value: '1559', label: '@grace' } },
        how: { tz: 'America/Detroit', pronouns: 'she/her' },
      });
      expect(dir.getRow('grace-aquino')!.card.summary).toBeUndefined();
      expect(dir.getRow('grace')!.archive_reason).toBe('merged into grace-aquino');
      expect(dir.mergeOf('grace')).toMatchObject({ into: 'grace-aquino', by: 'owner', counts: { agents: { art: { memories: 1 }, mark: { memories: 2, turns: 1 } }, directory: { relinked: ['fez'] } } });
      expect(dir.getRow('fez')!.card.how.via).toBe('grace-aquino');
    } finally { dir.close(); }
    const art = store(dbOf('art'));
    try {
      // Art had both: its words for grace-aquino win, plus the line; how's union, into winning `mode`.
      expect(art.getRow('grace-aquino')!.card).toMatchObject({ summary: 'Toxicologist at Onterris.\nMerged grace (Grace) 2026-11-02', how: { mode: 'warm' } });
      expect(art.getRow('grace')!.archived_at).not.toBeNull();
      expect(art.mergeOf('grace')?.into).toBe('grace-aquino');
    } finally { art.close(); }
    const mark = store(dbOf('mark'));
    try {
      // Mark only knew grace: its copy is grace-aquino's now, with its own summary, how and may.
      expect(mark.getRow('grace-aquino')!.card).toMatchObject({
        name: 'Grace Aquino', summary: 'Plays bass in #studio.\nMerged grace (Grace) 2026-11-02',
        how: { loop_in: 'jonathan' }, may: [{ text: 'may book studio time', source: 'Jonathan' }],
      });
      expect(mark.getRow('grace')!.archive_reason).toBe('merged into grace-aquino');
    } finally { mark.close(); }
    expect(metadataOf(dbOf('art'), 'memories').map((m) => m.person)).toEqual(['grace-aquino', 'grace-aquino']);
    expect(metadataOf(dbOf('mark'), 'memories').map((m) => m.person)).toEqual(['grace-aquino', 'grace-aquino']);
    expect(turnsFrom(dbOf('mark'))).toEqual(['grace-aquino']);
    expect(listConversations(agentDir(h, 'mark'), {})[0].people).toEqual(['grace-aquino']);

    // Each agent reads grace as the merged card, its own copy with it; a write to grace lands on grace-aquino.
    const m = openHouseholdPeople(h, 'mark', agentDir(h, 'mark'), { now })!;
    try {
      const read = m.read('grace');
      expect(read).toMatchObject({ found: true, merged: { from: 'grace', into: 'grace-aquino' }, card: { slug: 'grace-aquino', summary: expect.stringMatching(/^Plays bass/), where: { slack: {}, discord: {} } } });
      expect(m.write({ slug: 'grace', how: { mode: 'chatty' } })).toMatchObject({ redirected_from: 'grace', card: { slug: 'grace-aquino', how: { mode: 'chatty' } } });
      expect(ensurePerson(m, checkEnsureInput({ slug: 'grace', name: 'Grace', source: 'shuttle gates', where: { discord: { value: '1559' } } }))).toMatchObject({ slug: 'grace-aquino', unchanged: true });
      expect(() => m.restore({ slug: 'grace' })).toThrow(/stays a redirect/);
      expect(m.list().map((e) => e.slug)).toEqual(['fez', 'grace-aquino']);
    } finally { m.close(); }
  });

  it('a merge that stopped part-way finishes when run again: the redirect is there, the rest is re-tagged', () => {
    // As if loom stopped after Art's store: Mark's store wasn't reached.
    merge({ from: 'grace', into: 'grace-aquino' }, { ...h, agents: ['art'] });
    expect(metadataOf(dbOf('mark'), 'memories').map((m) => m.person)).toEqual(['grace', 'grace']);
    // Reading grace already answers grace-aquino for everyone.
    const m = openHouseholdPeople(h, 'mark', agentDir(h, 'mark'), { now })!;
    try { expect(m.read('grace')).toMatchObject({ card: { slug: 'grace-aquino' } }); } finally { m.close(); }
    const out = merge({ from: 'grace', into: 'grace-aquino' });
    expect(out).toMatchObject({ resumed: true, agents: { art: { card: 'none', memories: 0 }, mark: { card: 'moved', memories: 2, turns: 1 } } });
    expect(metadataOf(dbOf('mark'), 'memories').map((m2) => m2.person)).toEqual(['grace-aquino', 'grace-aquino']);
    const dir = store(commonsPeoplePath(h));
    try { expect(dir.mergeOf('grace')!.counts).toMatchObject({ agents: { art: { memories: 1 }, mark: { memories: 2 } } }); } finally { dir.close(); }
  });

  it("an agent merges only its own: Art's call leaves Mark's store untouched and unread, and names Mark for the owner", () => {
    const own = mergePeople({ household: h, viewer: 'art', onlyAgent: 'art', actor: 'art', now }, { from: 'grace', into: 'grace-aquino' });
    expect(Object.keys(own.agents)).toEqual(['art']);
    expect(own.agents.art).toMatchObject({ card: 'merged', memories: 1 });
    expect(JSON.stringify(own)).not.toMatch(/"mark"/);
    expect(own.projects).toEqual([]);
    expect(own.not_done[0]).toMatch(/^mark: its own copy, memories and conversations weren't touched or read .*ask the owner to run `loom person merge grace grace-aquino`/);
    // Mark's store as it was: its memories, its turn, its copy of grace.
    expect(metadataOf(dbOf('mark'), 'memories').map((m) => m.person)).toEqual(['grace', 'grace']);
    expect(turnsFrom(dbOf('mark'))).toEqual(['grace']);
    const mark = store(dbOf('mark'));
    try { expect(mark.getRow('grace')!.archived_at).toBeNull(); expect(mark.mergeOf('grace')).toBeNull(); } finally { mark.close(); }
    const dir = store(commonsPeoplePath(h));
    try { expect(dir.mergeOf('grace')!.counts).toEqual({ agents: { art: expect.anything() }, directory: { relinked: ['fez'] } }); } finally { dir.close(); }
    // The owner finishes it, Mark included.
    expect(merge({ from: 'grace', into: 'grace-aquino' })).toMatchObject({ resumed: true, agents: { art: { card: 'none' }, mark: { card: 'moved', memories: 2 } } });
    expect(metadataOf(dbOf('mark'), 'memories').map((m) => m.person)).toEqual(['grace-aquino', 'grace-aquino']);
  });

  it("a cardless from (a member's bare tag) merges into the card: re-tags and a redirect, nothing archived", () => {
    const dir = new PeopleStore({ dbPath: commonsPeoplePath(h), actor: 'owner', now });
    try { dir.write({ slug: 'jonathan-barket', name: 'Jonathan Barket' }); } finally { dir.close(); }
    remember(dbOf('art'), 'user/j1', { person: 'jonathan' });
    remember(dbOf('art'), 'user/j2', { person: 'jonathan' });
    remember(dbOf('art'), 'user/j3', { person: 'jonathan' });
    const dry = merge({ from: 'jonathan', into: 'jonathan-barket', dry_run: true });
    expect(dry).toMatchObject({ cardless: true, where_added: {}, agents: { art: { card: 'none', memories: 3 }, mark: { card: 'none', memories: 0 } } });
    expect(metadataOf(dbOf('art'), 'memories').filter((m) => m.person === 'jonathan')).toHaveLength(3);
    const out = merge({ from: 'jonathan', into: 'jonathan-barket' });
    expect(out).toMatchObject({ cardless: true, agents: { art: { memories: 3 } } });
    expect(metadataOf(dbOf('art'), 'memories').filter((m) => m.person === 'jonathan')).toHaveLength(0);
    const d = store(commonsPeoplePath(h));
    try {
      expect(d.getRow('jonathan')).toBeNull();
      expect(d.mergeOf('jonathan')).toMatchObject({ into: 'jonathan-barket' });
      expect(d.read('jonathan')).toMatchObject({ card: { slug: 'jonathan-barket' }, merged: { from: 'jonathan' } });
      expect(d.getRow('jonathan-barket')!.card.summary).toBeUndefined();
    } finally { d.close(); }
    // A bare tag nothing carries is a typo.
    expect(() => merge({ from: 'jonathon', into: 'jonathan-barket' })).toThrow(/no card for jonathon, and nothing in reach is tagged jonathon/);
  });

  it("refuses a household agent's entry, a member, and an agent merged with a person", () => {
    const dir = new PeopleStore({ dbPath: commonsPeoplePath(h), actor: 'owner', now });
    try {
      dir.write({ slug: 'art', name: 'Art', how: { kind: 'agent' } });
      dir.write({ slug: 'jonathan', name: 'Jonathan' });
    } finally { dir.close(); }
    expect(() => merge({ from: 'art', into: 'grace-aquino' })).toThrow(/one of this household's agents/);
    expect(() => merge({ from: 'jonathan', into: 'grace-aquino' })).toThrow(/a member of this household .* merge grace-aquino into jonathan instead/);
    expect(() => merge({ from: 'fez', into: 'grace-aquino' })).toThrow(/fez is an agent and grace-aquino isn't/);
    expect(() => merge({ from: 'grace', into: 'nobody' })).toThrow(/no card for nobody/);
  });
});
