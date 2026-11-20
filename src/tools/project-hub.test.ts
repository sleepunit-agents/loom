import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import BetterSqlite3 from 'better-sqlite3';
import { remember } from './remember.js';
import { closeAllBackends } from '../backends/index.js';
import { resolveSqliteDbPath } from '../config.js';
import { openProjectsStore } from '../backends/projects.js';
import { openPeopleStore } from '../backends/people.js';
import { Notes, notesDbPath } from '../notes.js';
import { projectHubOf, listProjects, projectOrphans, type HubSection, type PieceSectionSource } from './project.js';

// Acceptance criteria 6, 7, 8 and 12 of docs/specs/projects.md, and the
// project_list / project_orphans half of 14.

const DAY = 86_400_000;
const T0 = Date.parse('2026-11-02T15:00:00.000Z');
const iso = (ms: number) => new Date(ms).toISOString();

describe('project_hub', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'loom-project-hub-'));
  });

  afterEach(() => {
    closeAllBackends();
    rmSync(dir, { recursive: true, force: true });
  });

  const projects = (fn: (s: NonNullable<ReturnType<typeof openProjectsStore>>) => void) => {
    const s = openProjectsStore(dir, { now: () => T0 })!;
    try {
      fn(s);
    } finally {
      s.close();
    }
  };
  const seedPond = () =>
    projects((s) => s.write({ slug: 'pond', name: 'Pond', summary: 'Tadpoles.', links: { aliases: ['on-pond'] } }));
  /** The memory and people stores exist (a section whose store doesn't is absent). */
  const stores = async () => {
    await remember(dir, { category: 'project', title: 'unrelated', content: 'x', project: 'elsewhere' });
    openPeopleStore(dir)!.close();
  };

  /** A memory, then its row set by hand: created, updated, salience, archived, expires_at. */
  async function mem(title: string, project: string | undefined, set: { created: number; salience?: number; category?: string; archived?: boolean; expired?: boolean; updated?: number }) {
    const ref = await remember(dir, { category: set.category ?? 'project', title, content: `about ${title}`, ...(project ? { project } : {}) });
    const db = new BetterSqlite3(resolveSqliteDbPath(dir));
    try {
      db.prepare('UPDATE memories SET created = ?, updated = ?, salience = ?, archived = ?, expires_at = ? WHERE ref = ?').run(
        iso(set.created), iso(set.updated ?? set.created), set.salience ?? 0.1, set.archived ? 1 : 0,
        set.expired ? '2020-01-01T00:00:00.000Z' : null, ref.ref,
      );
    } finally {
      db.close();
    }
    return ref.ref;
  }

  const hub = async (slug = 'pond', extra: { since?: string; include_archived?: boolean } = {}, opts: { pieceSections?: PieceSectionSource } = {}) =>
    projectHubOf(dir, { slug, ...extra }, { nowMs: T0, ...opts });
  const sectionOf = <K extends string>(r: Awaited<ReturnType<typeof hub>>, key: K) => {
    if (!('sections' in r)) throw new Error('no sections');
    return r.sections.find((s) => s.key === key) as Extract<HubSection, { key: K }> | undefined;
  };

  describe('6. memories', () => {
    it('the 20 newest plus the 10 most salient (ties: newer first), deduplicated, newest first; archived and expired excluded', async () => {
      seedPond();
      // m0 oldest … m24 newest. The 20 newest are m5..m24. Salience: m10..m17 at
      // 0.9, m0..m4 tied at 0.5, the rest 0.1 — so the 10 most salient are
      // m10..m17 plus the two newest of the tie, m4 and m3.
      const refs: string[] = [];
      for (let i = 0; i < 25; i++) {
        const salience = i >= 10 && i <= 17 ? 0.9 : i <= 4 ? 0.5 : 0.1;
        refs.push(await mem(`m${i}`, i === 7 ? 'on-pond' : 'pond', { created: T0 - (25 - i) * DAY, salience, category: i % 2 ? 'self' : 'project' }));
      }
      await mem('archived one', 'pond', { created: T0 - DAY / 2, salience: 1, archived: true });
      await mem('expired one', 'pond', { created: T0 - DAY / 2, salience: 1, expired: true });
      await mem('elsewhere', 'hockey', { created: T0 - DAY / 2, salience: 1 });

      const since = iso(T0 - 3 * DAY - 1000);
      const m = sectionOf(await hub('pond', { since }), 'memories')!;
      const expected = refs.slice(3).reverse();
      expect(m.items.map((i) => i.ref)).toEqual(expected);
      // `new` is "changed after since": m22 (3 days old) onward.
      expect(m.items.filter((i) => i.new).map((i) => i.ref)).toEqual(refs.slice(22).reverse());
      expect(m.total).toBe(25);
      expect(m.counts).toEqual({ project: 13, self: 12 });
      expect(m.items[0]).toEqual({
        ref: refs[24], category: 'project', snippet: 'm24 — about m24', created: iso(T0 - DAY), updated: iso(T0 - DAY), new: true,
      });
    });

    it('matches the slug or any alias, and a hub read through an alias says so', async () => {
      seedPond();
      const a = await mem('by alias', 'on-pond', { created: T0 - DAY });
      const b = await mem('by slug', 'pond', { created: T0 - 2 * DAY });
      const r = await hub('on-pond');
      expect(r).toMatchObject({ found: true, resolved_from: 'on-pond' });
      expect(sectionOf(r, 'memories')!.items.map((i) => i.ref)).toEqual([a, b]);
    });
  });

  describe('7. notes', () => {
    it('notes under the slug by default; an expired but unswept note is excluded; new against since', async () => {
      seedPond();
      let clock = T0 - 20 * DAY;
      const notes = new Notes(dir, () => clock);
      notes.write('pond/old-short', 'x', { by: 't', lifespan: 'short' }); // expires 14 days on: gone by T0
      notes.write('pond/pinned-short', 'x', { by: 't', lifespan: 'short' });
      notes.pin('pond/pinned-short', true);
      clock = T0 - 5 * DAY;
      notes.write('pond/plan', 'x', { by: 't', lifespan: 'keep' });
      clock = T0 - DAY;
      notes.write('pond', 'x', { by: 't', lifespan: 'while' });
      notes.write('pondering/x', 'x', { by: 't', lifespan: 'keep' });
      notes.write('hockey/x', 'x', { by: 't', lifespan: 'keep' });
      notes.close();

      const n = sectionOf(await hub('pond', { since: iso(T0 - 2 * DAY) }), 'notes')!;
      const paths = n.items.map((i) => i.path);
      expect(paths.slice(0, 2)).toEqual(['pond', 'pond/plan']);
      expect(paths).not.toContain('pond/old-short');
      expect(paths).toContain('pond/pinned-short');
      expect(paths).not.toContain('pondering/x');
      expect(paths).not.toContain('hockey/x');
      expect(n.items.find((i) => i.path === 'pond')!.new).toBe(true);
      expect(n.items.find((i) => i.path === 'pond/plan')!.new).toBe(false);
      expect(n.total).toBe(paths.length);
    });

    it('reads each links.notes prefix instead of the slug', async () => {
      projects((s) => s.write({ slug: 'pond', name: 'Pond', links: { notes: ['hocket/research', 'ops'] } }));
      const notes = new Notes(dir, () => T0 - DAY);
      for (const p of ['hocket/research/a', 'ops/b', 'pond/c', 'hocket/other']) notes.write(p, 'x', { by: 't', lifespan: 'keep' });
      notes.close();
      const n = sectionOf(await hub(), 'notes')!;
      expect(n.items.map((i) => i.path).sort()).toEqual(['hocket/research/a', 'ops/b']);
    });

    it('a missing notes store means the section is absent, not an error', async () => {
      seedPond();
      await stores();
      const r = await hub();
      expect('sections' in r && r.sections.map((s) => s.key)).toEqual(['memories', 'people', 'conversations']);
    });

    it('a notes store that throws becomes {key, error} and the other sections still return', async () => {
      seedPond();
      await stores();
      writeFileSync(notesDbPath(dir), 'not a database');
      const r = await hub();
      expect('sections' in r && r.sections.map((s) => s.key)).toEqual(['memories', 'notes', 'people', 'conversations']);
      expect(sectionOf(r, 'notes')).toMatchObject({ key: 'notes', error: expect.any(String) });
      expect(sectionOf(r, 'memories')).toHaveProperty('items');
    });
  });

  describe('8. people', () => {
    it('where.on_pond appears in the hub of a project aliased on-pond, where.pond in pond\'s; an archived card does not', async () => {
      seedPond();
      const people = openPeopleStore(dir, { now: () => T0 })!;
      people.write({ slug: 'matt-k', name: 'Matt', where: { pond: { value: 'field lead', verified_at: iso(T0 - DAY) } } });
      people.write({ slug: 'loren-smith', name: 'Loren', where: { on_pond: { value: 'reviewer' }, hockey: { value: 'goalie' } } });
      people.write({ slug: 'gone', name: 'Gone', where: { pond: { value: 'left' } } });
      people.archive({ slug: 'gone', reason: 'left', actor: 'art' });
      people.write({ slug: 'other', name: 'Other', where: { hockey: { value: 'coach' } } });
      people.close();

      const p = sectionOf(await hub(), 'people')!;
      expect(p.items).toEqual([
        { slug: 'loren-smith', name: 'Loren', field: 'on_pond', value: 'reviewer', marker: '[unverified]' },
        { slug: 'matt-k', name: 'Matt', field: 'pond', value: 'field lead', marker: '[ok]' },
      ]);
    });
  });

  describe('12. missing and archived', () => {
    it('a missing project gives {found: false}', async () => {
      expect(await hub('nope')).toEqual({ found: false });
      seedPond();
      expect(await hub('nope')).toEqual({ found: false });
    });

    it('an archived project without include_archived gives {found: true, archived: true} and runs no feed', async () => {
      seedPond();
      await mem('by alias', 'on-pond', { created: T0 - DAY });
      projects((s) => s.archive({ slug: 'pond', reason: 'shut', actor: 'art' }));
      const feeds = vi.fn<PieceSectionSource>(async () => []);
      expect(await hub('pond', {}, { pieceSections: feeds })).toEqual({ found: true, archived: true });
      expect(feeds).not.toHaveBeenCalled();
      // The freed alias doesn't reach it.
      expect(await hub('on-pond', {}, { pieceSections: feeds })).toEqual({ found: false });

      // With include_archived, sections are computed as a live project's, names from the card; feeds run.
      const r = await hub('pond', { include_archived: true }, { pieceSections: feeds });
      expect(r).toMatchObject({ found: true, archived: true });
      expect(sectionOf(r, 'memories')!.items.map((i) => i.snippet)).toEqual(['by alias — about by alias']);
      expect(feeds).toHaveBeenCalledOnce();
    });

    it('piece sections come after the core ones, by key', async () => {
      seedPond();
      await stores();
      const feeds: PieceSectionSource = async () => [{ key: 'piece:tasks', groups: [] }, { key: 'piece:shuttle', error: 'timed out' }];
      const r = await hub('pond', {}, { pieceSections: feeds });
      expect('sections' in r && r.sections.map((s) => s.key)).toEqual(['memories', 'people', 'conversations', 'piece:shuttle', 'piece:tasks']);
    });

    it('activity is the latest of updated, the newest memory and the newest note; since defaults to 7 days ago', async () => {
      seedPond();
      await mem('later', 'pond', { created: T0 - DAY, updated: T0 + DAY });
      const r = await hub();
      expect(r).toMatchObject({ activity: iso(T0 + DAY), since: iso(T0 - 7 * DAY) });
    });

    it('rejects a since that is not a time', async () => {
      seedPond();
      await expect(hub('pond', { since: 'last tuesday' })).rejects.toThrow(/since: must be an ISO-8601 time/);
    });
  });

  describe('14. project_list and project_orphans', () => {
    it('project_list returns links, sorts by activity, and memories_since_synthesis excludes archived, expired and older memories', async () => {
      projects((s) => {
        s.write({ slug: 'pond', name: 'Pond', summary: 'Tadpoles.', links: { aliases: ['on-pond'], epic: 't-210' } });
        s.write({ slug: 'hockey', name: 'Hockey', status: 'paused' });
      });
      // synthesized_at is T0 (the write's clock).
      await mem('before', 'pond', { created: T0 - DAY });
      await mem('after', 'pond', { created: T0 + DAY });
      await mem('after alias', 'on-pond', { created: T0 + DAY });
      await mem('after archived', 'pond', { created: T0 + DAY, archived: true });
      await mem('after expired', 'pond', { created: T0 + DAY, expired: true });
      await mem('hockey later', 'hockey', { created: T0 + 3 * DAY });

      const list = listProjects(dir, { nowMs: T0 });
      expect(list.map((e) => e.slug)).toEqual(['hockey', 'pond']);
      const pond = list.find((e) => e.slug === 'pond')!;
      expect(pond).toMatchObject({ name: 'Pond', status: 'active', links: { aliases: ['on-pond'], epic: 't-210' }, memories_since_synthesis: 2 });
      expect(list.find((e) => e.slug === 'hockey')!.memories_since_synthesis).toBe(1);
      expect(listProjects(dir, { nowMs: T0, status: 'paused' }).map((e) => e.slug)).toEqual(['hockey']);
      expect(() => listProjects(dir, { status: 'stalled' })).toThrow(/status: must be one of/);
    });

    it('project_list leaves archived projects out unless include_archived', async () => {
      projects((s) => {
        s.write({ slug: 'pond', name: 'Pond' });
        s.archive({ slug: 'pond', reason: 'x', actor: 'art' });
      });
      expect(listProjects(dir)).toEqual([]);
      expect(listProjects(dir, { include_archived: true }).map((e) => [e.slug, e.archived])).toEqual([['pond', true]]);
    });

    it('project_orphans counts only non-archived, non-expired memories, lists an archived project\'s former names, and leaves out a live project\'s', async () => {
      projects((s) => {
        s.write({ slug: 'pond', name: 'Pond', links: { aliases: ['on-pond'] } });
        s.write({ slug: 'mud', name: 'Mud', links: { aliases: ['mud-game'] } });
        s.archive({ slug: 'mud', reason: 'shelved', actor: 'art' });
      });
      await mem('a', 'pond', { created: T0 });
      await mem('b', 'on-pond', { created: T0 });
      await mem('c', 'mud', { created: T0 });
      await mem('d', 'mud-game', { created: T0 });
      await mem('e', 'mud-game', { created: T0 });
      await mem('f', 'zebra', { created: T0 });
      await mem('g', 'zebra', { created: T0, archived: true });
      await mem('h', 'zebra', { created: T0, expired: true });
      await mem('i', 'alpha', { created: T0 });
      await mem('j', undefined, { created: T0 });
      expect(projectOrphans(dir)).toEqual([
        { tag: 'mud-game', count: 2 },
        { tag: 'alpha', count: 1 },
        { tag: 'mud', count: 1 },
        { tag: 'zebra', count: 1 },
      ]);
    });
  });
});
