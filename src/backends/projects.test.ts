import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import BetterSqlite3 from 'better-sqlite3';
import { ProjectsStore, renderProjectCard, validateProjectCard, MAX_PROJECT_RENDER, type ProjectCard } from './projects.js';

// Acceptance criteria 1–5 and the store half of 14 of docs/specs/projects.md.
// The race half of 3 is in projects-write-race.test.ts; 6–8 and 12 in
// tools/project-hub.test.ts; 9 and forget in tools/project-recall.test.ts;
// 13 in tools/identity-project.test.ts; 15 in cli/project.test.ts.

const DAY = 86_400_000;
const T0 = Date.parse('2026-11-02T15:00:00.000Z');

describe('ProjectsStore', () => {
  let dir: string;
  let now: number;
  let store: ProjectsStore;
  let dbPath: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'loom-projects-'));
    now = T0;
    dbPath = join(dir, 'memories.db');
    store = new ProjectsStore({ dbPath, now: () => now, actor: 'art' });
  });

  afterEach(() => {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });

  const card = (slug = 'pond') => store.resolve(slug)!.row.card;
  const names = () => {
    const db = new BetterSqlite3(dbPath, { readonly: true });
    try {
      return db.prepare('SELECT name, slug, kind FROM project_names ORDER BY name').all();
    } finally {
      db.close();
    }
  };
  const seed = () =>
    store.write({
      slug: 'pond',
      name: 'pond',
      summary: 'The tadpole tracker.',
      goal: 'Every site on the new stack.',
      where: { now: { value: 'dev soak', verified_at: new Date(T0).toISOString(), source: 'tasks', stale_after_days: 7 } },
      links: { aliases: ['on-pond', 'toad'], notes: ['pond/'], epic: 't-210', repos: ['acme/pond'], venues: ['slack:C0POND'] },
    });

  describe('1. project_write creates, merges and replaces', () => {
    it('creates with status active by default, notes stored without the trailing slash', () => {
      const r = seed();
      expect(r.unchanged).toBe(false);
      expect(r.card.status).toBe('active');
      expect(r.card.links.notes).toEqual(['pond']);
      expect(r.synthesized_at).toBe(new Date(T0).toISOString());
    });

    it('passing links.epic alone keeps links.aliases', () => {
      seed();
      store.write({ slug: 'pond', links: { epic: 't-999' } });
      expect(card().links).toEqual({ aliases: ['on-pond', 'toad'], notes: ['pond'], epic: 't-999', repos: ['acme/pond'], venues: ['slack:C0POND'] });
    });

    it('a links key passed as null is removed, and so is a where field', () => {
      seed();
      store.write({ slug: 'pond', links: { repos: null }, where: { now: null } });
      expect(card().links.repos).toBeUndefined();
      expect(card().links.aliases).toEqual(['on-pond', 'toad']);
      expect(card().where).toEqual({});
    });

    it('name, status, summary and goal replace when passed; where merges one level deep', () => {
      seed();
      store.write({ slug: 'pond', status: 'paused', goal: 'Half the sites.', where: { next: { value: 'the remaining sites back online' } } });
      const c = card();
      expect(c.status).toBe('paused');
      expect(c.goal).toBe('Half the sites.');
      expect(c.summary).toBe('The tadpole tracker.');
      expect(Object.keys(c.where).sort()).toEqual(['next', 'now']);
    });

    it('merge: false makes the card exactly what was passed: status active, sections empty, summary gone', () => {
      seed();
      store.write({ slug: 'pond', status: 'done' });
      const r = store.write({ slug: 'pond', name: 'Pond', merge: false });
      expect(r.card).toEqual({ slug: 'pond', name: 'Pond', status: 'active', where: {}, links: {} });
      expect(r.synthesized_at).toBeNull();
    });

    it('merge: false requires name; creating requires name', () => {
      seed();
      expect(() => store.write({ slug: 'pond', merge: false })).toThrow(/name: is required/);
      expect(() => store.write({ slug: 'new-one' })).toThrow(/name: is required to create a project/);
    });

    const violations: Array<[string, Record<string, unknown>, RegExp]> = [
      ['an unknown top-level key', { slug: 'x', name: 'X', owner: 'me' }, /^owner: unknown top-level key/],
      ['an over-long slug (> 32)', { slug: 'a'.repeat(33), name: 'X' }, /^slug: slug is longer than 32/],
      ['a slug off the rule', { slug: 'Pond', name: 'X' }, /^slug: slug "Pond" must match/],
      ['a reserved slug', { slug: 'scope', name: 'X' }, /^slug: "scope" is a reserved name/],
      ['an over-long name', { slug: 'x', name: 'n'.repeat(81) }, /^name: longer than 80/],
      ['a bad status', { slug: 'x', name: 'X', status: 'stalled' }, /^status: must be one of active, paused, done/],
      ['an over-long summary', { slug: 'x', name: 'X', summary: 's'.repeat(1201) }, /^summary: longer than 1200/],
      ['an over-long goal', { slug: 'x', name: 'X', goal: 'g'.repeat(401) }, /^goal: longer than 400/],
      ['a where value that is not a string', { slug: 'x', name: 'X', where: { now: { value: 3 } } }, /^where\.now\.value: must be a string/],
      ['a where value over 400', { slug: 'x', name: 'X', where: { now: { value: 'v'.repeat(401) } } }, /^where\.now\.value: longer than 400/],
      ['a where array value', { slug: 'x', name: 'X', where: { now: { value: ['a'] } } }, /^where\.now\.value: must be a string/],
      ['a label in a where envelope (person cards only)', { slug: 'x', name: 'X', where: { now: { value: 'v', label: 'l' } } }, /^where\.now\.label: unknown envelope key/],
      ['a where field name off the rule', { slug: 'x', name: 'X', where: { 'No-w': { value: 'v' } } }, /^where\.No-w: field name must match/],
      ['a reserved where field', { slug: 'x', name: 'X', where: { tier: { value: 'v' } } }, /^where\.tier: "tier" is a reserved name/],
      ['more than 12 where fields', { slug: 'x', name: 'X', where: Object.fromEntries(Array.from({ length: 13 }, (_, i) => [`f${i}`, { value: 'v' }])) }, /^where: more than 12 fields/],
      ['a future verified_at', { slug: 'x', name: 'X', where: { now: { value: 'v', verified_at: new Date(T0 + 2 * DAY).toISOString() } } }, /^where\.now\.verified_at: is in the future/],
      ['a bad stale_after_days', { slug: 'x', name: 'X', where: { now: { value: 'v', stale_after_days: 0 } } }, /^where\.now\.stale_after_days: must be an integer 1–365/],
      ['an unknown links key', { slug: 'x', name: 'X', links: { site: 'x' } }, /^links\.site: unknown links key/],
      ['more than 16 aliases', { slug: 'x', name: 'X', links: { aliases: Array.from({ length: 17 }, (_, i) => `a${i}`) } }, /^links\.aliases: more than 16 entries/],
      ['an alias off the slug rule', { slug: 'x', name: 'X', links: { aliases: ['On Pond'] } }, /^links\.aliases\[0\]: slug "On Pond" must match/],
      ['a reserved alias', { slug: 'x', name: 'X', links: { aliases: ['trust'] } }, /^links\.aliases\[0\]: "trust" is a reserved name/],
      ['the project\'s own slug as its alias', { slug: 'x', name: 'X', links: { aliases: ['x'] } }, /^links\.aliases\[0\]: "x" is this project's own slug/],
      ['an alias listed twice', { slug: 'x', name: 'X', links: { aliases: ['y', 'y'] } }, /^links\.aliases\[1\]: "y" is listed twice/],
      ['a notes entry that is not a note path', { slug: 'x', name: 'X', links: { notes: ['../etc'] } }, /^links\.notes\[0\]: "\.\.\/etc" is not a note path prefix/],
      ['a notes entry over 200', { slug: 'x', name: 'X', links: { notes: ['n'.repeat(201)] } }, /^links\.notes\[0\]: longer than 200/],
      ['more than 16 repos', { slug: 'x', name: 'X', links: { repos: Array.from({ length: 17 }, (_, i) => `r${i}`) } }, /^links\.repos: more than 16 entries/],
      ['a venue over 200', { slug: 'x', name: 'X', links: { venues: ['v'.repeat(201)] } }, /^links\.venues\[0\]: longer than 200/],
      ['an epic over 64', { slug: 'x', name: 'X', links: { epic: 'e'.repeat(65) } }, /^links\.epic: longer than 64/],
      ['an epic that is not a string', { slug: 'x', name: 'X', links: { epic: ['t-1'] } }, /^links\.epic: must be a string/],
    ];
    for (const [what, input, err] of violations) {
      it(`rejects ${what}, naming the field`, () => {
        expect(() => store.write(input as never)).toThrow(err);
      });
    }

    const nulls: Array<[string, Record<string, unknown>, RegExp]> = [
      ['name', { slug: 'pond', name: null }, /^name: null is not allowed/],
      ['status', { slug: 'pond', status: null }, /^status: null is not allowed/],
      ['summary', { slug: 'pond', summary: null }, /^summary: null is not allowed/],
      ['goal', { slug: 'pond', goal: null }, /^goal: null is not allowed/],
      ['where', { slug: 'pond', where: null }, /^where: null is not allowed/],
      ['links', { slug: 'pond', links: null }, /^links: null is not allowed/],
      ['inside a where envelope', { slug: 'pond', where: { now: { value: 'v', source: null } } }, /^where\.now\.source: null is not allowed/],
      ['inside a links array', { slug: 'pond', links: { aliases: [null] } }, /^links\.aliases\[0\]: null is not allowed/],
      ['any null under merge: false', { slug: 'pond', name: 'P', merge: false, links: { epic: null } }, /^input\.links\.epic: null is not allowed/],
    ];
    for (const [where, input, err] of nulls) {
      it(`rejects null for ${where}, naming the path`, () => {
        seed();
        expect(() => store.write(input as never)).toThrow(err);
      });
    }
  });

  describe('2. name uniqueness', () => {
    it('a second project claiming a slug as an alias, or an alias, is rejected naming the holder', () => {
      seed();
      expect(() => store.write({ slug: 'hockey', name: 'Hockey', links: { aliases: ['pond'] } })).toThrow(
        /^links\.aliases\[0\]: "pond" is the slug of project pond/,
      );
      expect(() => store.write({ slug: 'hockey', name: 'Hockey', links: { aliases: ['rink', 'toad'] } })).toThrow(
        /^links\.aliases\[1\]: "toad" is held by project pond/,
      );
      expect(store.resolve('hockey')).toBeNull();
    });

    it('a done or paused project keeps its names, and its aliases still resolve', () => {
      seed();
      store.write({ slug: 'pond', status: 'done' });
      expect(store.read('toad')).toMatchObject({ found: true, resolved_from: 'toad', card: { slug: 'pond', status: 'done' } });
      expect(() => store.write({ slug: 'hockey', name: 'Hockey', links: { aliases: ['toad'] } })).toThrow(/held by project pond/);
      store.write({ slug: 'pond', status: 'paused' });
      expect(store.nameSet('on-pond')).toEqual(new Set(['pond', 'on-pond', 'toad']));
    });

    it('archiving frees the aliases (never the slug)', () => {
      seed();
      store.archive({ slug: 'pond', reason: 'shut down', actor: 'art' });
      expect(names()).toEqual([]);
      expect(store.read('toad')).toEqual({ found: false });
      store.write({ slug: 'hockey', name: 'Hockey', links: { aliases: ['toad'] } });
      expect(() => store.write({ slug: 'rink', name: 'Rink', links: { aliases: ['pond'] } })).toThrow(/"pond" is the slug of project pond/);
    });

    it('a restore whose names are taken is rejected whole and changes nothing', () => {
      seed();
      store.archive({ slug: 'pond', reason: 'shut down', actor: 'art' });
      store.write({ slug: 'hockey', name: 'Hockey', links: { aliases: ['toad'] } });
      const before = { names: names(), history: store.history('pond'), row: store.resolve('pond')!.row };
      expect(() => store.restore({ slug: 'pond' })).toThrow(/project pond can't be restored, nothing was: links\.aliases\[1\]: "toad" is held by project hockey/);
      expect(names()).toEqual(before.names);
      expect(store.history('pond')).toEqual(before.history);
      expect(store.resolve('pond')!.row).toEqual(before.row);
      expect(store.resolve('pond')!.row.archived_at).not.toBeNull();
    });

    it('a restore whose names are free re-claims them', () => {
      seed();
      store.archive({ slug: 'pond', reason: 'shut down', actor: 'art' });
      store.restore({ slug: 'pond' });
      expect(names()).toEqual([
        { name: 'on-pond', slug: 'pond', kind: 'alias' },
        { name: 'pond', slug: 'pond', kind: 'slug' },
        { name: 'toad', slug: 'pond', kind: 'alias' },
      ]);
    });
  });

  describe('3. no-op detection, revisions, archive/restore and revision restore as person cards', () => {
    it('an identical write that omits summary is unchanged and adds no revision; passing summary always stores', () => {
      seed();
      const again = store.write({ slug: 'pond', status: 'active', links: { epic: 't-210' } });
      expect(again.unchanged).toBe(true);
      expect(again.revision_id).toBeNull();
      expect(store.history('pond')).toEqual([]);
      now += 1000;
      const resynth = store.write({ slug: 'pond', summary: 'The tadpole tracker.' });
      expect(resynth.unchanged).toBe(false);
      expect(resynth.synthesized_at).toBe(new Date(now).toISOString());
      expect(store.history('pond').map((h) => h.op)).toEqual(['write']);
    });

    it('validation runs before the no-op check', () => {
      seed();
      expect(() => store.write({ slug: 'pond', where: { Bad: null } })).toThrow(/where\.Bad: field name must match/);
    });

    it('verify stamps where fields, unknown fields reject the call, and a no-op verify stores nothing', () => {
      seed();
      store.write({ slug: 'pond', where: { next: { value: 'sites' } } });
      now += 3 * DAY;
      const r = store.verify({ slug: 'pond', fields: ['next'], source: 'tasks' });
      expect(r.card.where.next).toEqual({ value: 'sites', verified_at: new Date(now).toISOString(), source: 'tasks' });
      expect(() => store.verify({ slug: 'pond', fields: ['nope'] })).toThrow(/fields: "nope" is not a where field on pond/);
      expect(store.verify({ slug: 'pond', fields: ['next'], source: 'tasks' }).unchanged).toBe(true);
      expect(store.history('pond').map((h) => h.op)).toEqual(['verify', 'write']);
    });

    it('archive and restore are tombstoned, revisioned, idempotent; an archived project rejects write, verify and revision restore', () => {
      seed();
      const a = store.archive({ slug: 'pond', reason: 'shut down', actor: 'art' });
      expect(a.archived).toBe(true);
      expect(store.archive({ slug: 'pond', reason: 'again', actor: 'art' }).unchanged).toBe(true);
      expect(store.read('pond')).toEqual({ found: true, archived: true });
      expect(() => store.write({ slug: 'pond', goal: 'x' })).toThrow(/project pond is archived; project_restore it before writing/);
      expect(() => store.verify({ slug: 'pond', fields: ['now'] })).toThrow(/project pond is archived/);
      expect(() => store.revisionRestore({ slug: 'pond', revision_id: 1 })).toThrow(/project pond is archived/);
      const r = store.restore({ slug: 'pond' });
      expect(r.archived).toBe(false);
      expect(r.card.links.aliases).toEqual(['on-pond', 'toad']);
      expect(store.restore({ slug: 'pond' }).unchanged).toBe(true);
      expect(store.history('pond').map((h) => h.op)).toEqual(['restore', 'archive']);
      expect(store.history('pond')[0].actor).toBe('art');
    });

    it('archive needs a reason, and archive/restore of a missing project are rejected', () => {
      expect(() => store.archive({ slug: 'nope', reason: 'x', actor: 'art' })).toThrow(/no project nope/);
      expect(() => store.restore({ slug: 'nope' })).toThrow(/no project nope/);
      seed();
      expect(() => store.archive({ slug: 'pond', reason: ' ', actor: 'art' })).toThrow(/reason: is required/);
    });

    it('revision restore: another project\'s revision is rejected; a restore brings back card, names, status and synthesized_at', () => {
      seed();
      store.write({ slug: 'hockey', name: 'Hockey' });
      store.write({ slug: 'hockey', goal: 'A season.' });
      const hockeyRev = store.history('hockey')[0].id;
      expect(() => store.revisionRestore({ slug: 'pond', revision_id: hockeyRev })).toThrow(/revision \d+ belongs to another project, not pond/);

      const synth = store.resolve('pond')!.row.synthesized_at;
      now += 1000;
      store.write({ slug: 'pond', name: 'pond', status: 'done', merge: false });
      expect(store.read('toad')).toEqual({ found: false });
      const rev = store.history('pond')[0];
      const r = store.revisionRestore({ slug: 'pond', revision_id: rev.id });
      expect(r.card.links.aliases).toEqual(['on-pond', 'toad']);
      expect(r.card.status).toBe('active');
      expect(r.synthesized_at).toBe(synth);
      expect(store.resolve('pond')!.row.status).toBe('active');
      expect(store.read('toad')).toMatchObject({ found: true, resolved_from: 'toad' });
      expect(store.history('pond')[0].op).toBe('revision_restore');
    });

    it('revision restore is rejected whole when the revision\'s aliases are now another project\'s', () => {
      seed();
      store.write({ slug: 'pond', links: { aliases: [] } });
      const rev = store.history('pond')[0].id;
      store.write({ slug: 'hockey', name: 'Hockey', links: { aliases: ['toad'] } });
      expect(() => store.revisionRestore({ slug: 'pond', revision_id: rev })).toThrow(/"toad" is held by project hockey/);
      expect(card().links.aliases).toEqual([]);
    });

    it('keeps the newest 10 revisions', () => {
      seed();
      for (let i = 0; i < 14; i++) store.write({ slug: 'pond', goal: `goal ${i}` });
      expect(store.history('pond')).toHaveLength(10);
    });

    it('a failed write leaves projects and project_names both unchanged', () => {
      seed();
      const before = { names: names(), row: store.resolve('pond')!.row };
      // Valid by itself, but its alias is the slug of another project: rejected inside the transaction.
      store.write({ slug: 'hockey', name: 'Hockey' });
      const mid = names();
      expect(() => store.write({ slug: 'pond', links: { aliases: ['on-pond', 'hockey'] } })).toThrow(/slug of project hockey/);
      expect(store.resolve('pond')!.row).toEqual(before.row);
      expect(names()).toEqual(mid);
      expect(mid.filter((n) => (n as { slug: string }).slug === 'pond')).toEqual(before.names);
    });
  });

  describe('4. the render', () => {
    it('renders "## Pond Rebuild (pond · active)", then summary, goal and where by the grammar', () => {
      store.write({
        slug: 'pond',
        name: 'Pond Rebuild',
        summary: 'The tadpole tracker.',
        goal: 'Every site on the new stack.',
        where: {
          now: { value: 'dev soak; prod cutover blocked on the WAF', verified_at: '2026-11-02T15:00:00Z', source: 'tasks', stale_after_days: 7 },
          next: { value: 'the remaining sites back online' },
        },
        links: { aliases: ['on-pond'], epic: 't-210' },
      });
      expect(store.read('pond')).toMatchObject({
        found: true,
        rendered:
          '## Pond Rebuild (pond · active)\n' +
          'The tadpole tracker.\n' +
          '**Goal:** Every site on the new stack.\n' +
          '**Where:** next: the remaining sites back online [unverified] · now: dev soak; prod cutover blocked on the WAF [ok]',
      });
    });

    it('leaves out empty lines and never renders links', () => {
      store.write({ slug: 'pond', name: 'Pond', links: { aliases: ['on-pond'], repos: ['acme/pond'] } });
      expect((store.read('pond') as { rendered: string }).rendered).toBe('## Pond (pond · active)\n_(no summary)_');
    });

    it('the worst-case render is ≤ 2,000 chars, and a write over it is rejected', () => {
      const big = (n: number) => Object.fromEntries(Array.from({ length: n }, (_, i) => [`field_${i}`, { value: 'v'.repeat(80) }]));
      expect(() => store.write({ slug: 'pond', name: 'Pond', summary: 's'.repeat(1200), where: big(8) })).toThrow(
        /^card: worst-case render is \d+ chars, over the 2000-char cap/,
      );
      const ok = store.write({ slug: 'pond', name: 'Pond', summary: 's'.repeat(1200), where: big(4) });
      expect(renderProjectCard(ok.card, 0, { worstCase: true }).length).toBeLessThanOrEqual(MAX_PROJECT_RENDER);
      // Time passing can't push it over: the cap counted every marker at its widest.
      expect(renderProjectCard(ok.card, T0 + 1000 * DAY).length).toBeLessThanOrEqual(MAX_PROJECT_RENDER);
    });
  });

  describe('5. staleness markers on where, as person cards', () => {
    const at = (ms: number) => new Date(ms).toISOString();
    const render = (c: ProjectCard, ms: number) => renderProjectCard(c, ms);
    it('14d + 1s ago is stale by default, exactly 14d is ok, none is unverified, 7-day threshold makes 8 days stale', () => {
      store.write({
        slug: 'pond',
        name: 'Pond',
        where: {
          a: { value: 'x', verified_at: at(T0 - 14 * DAY - 1000) },
          b: { value: 'y', verified_at: at(T0 - 14 * DAY) },
          c: { value: 'z' },
          d: { value: 'w', verified_at: at(T0 - 8 * DAY), stale_after_days: 7 },
        },
      });
      expect(render(card(), T0)).toContain('**Where:** a: x [STALE 14d] · b: y [ok] · c: z [unverified] · d: w [STALE 8d]');
    });

    it('after project_verify the field renders [ok] and its value is unchanged', () => {
      store.write({ slug: 'pond', name: 'Pond', where: { now: { value: 'soak', verified_at: at(T0 - 30 * DAY) } } });
      expect(render(card(), T0)).toContain('now: soak [STALE 30d]');
      store.verify({ slug: 'pond', fields: ['now'] });
      expect(render(card(), T0)).toContain('now: soak [ok]');
    });
  });

  describe('14. names on every slug-taking surface (store half)', () => {
    it('every slug-taking surface resolves an alias with resolved_from', () => {
      seed();
      expect(store.read('on-pond')).toMatchObject({ found: true, resolved_from: 'on-pond', card: { slug: 'pond' } });
      expect(store.write({ slug: 'on-pond', goal: 'New goal.' })).toMatchObject({ resolved_from: 'on-pond', card: { slug: 'pond', goal: 'New goal.' } });
      expect(store.verify({ slug: 'toad', fields: ['now'] })).toMatchObject({ resolved_from: 'toad' });
      const rev = store.history('toad')[0].id;
      expect(store.revisionRestore({ slug: 'toad', revision_id: rev })).toMatchObject({ resolved_from: 'toad' });
      expect(store.resolvedFrom('toad')).toBe('toad');
      expect(store.archive({ slug: 'toad', reason: 'done', actor: 'art' })).toMatchObject({ resolved_from: 'toad', archived: true });
      // An archived project is reached by its slug only.
      expect(() => store.restore({ slug: 'toad' })).toThrow(/no project toad/);
      expect(store.restore({ slug: 'pond' }).resolved_from).toBeUndefined();
    });

    it('a new project can\'t take an archived project\'s slug', () => {
      seed();
      store.archive({ slug: 'pond', reason: 'shut down', actor: 'art' });
      expect(() => store.write({ slug: 'pond', name: 'Another pond', merge: false })).toThrow(/project pond is archived.*a new project can't take it/);
    });

    it('a stored card validates structurally (validateProjectCard)', () => {
      expect(() => validateProjectCard({ slug: 'p', name: 'P', status: 'active', where: {}, links: {} }, null)).not.toThrow();
      expect(() => validateProjectCard({ slug: 'p', name: 'P', where: {}, links: {} }, null)).toThrow(/^status:/);
    });
  });
});
