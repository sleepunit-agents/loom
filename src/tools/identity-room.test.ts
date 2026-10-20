import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import BetterSqlite3 from 'better-sqlite3';
import { loadIdentity } from './identity.js';
import { remember } from './remember.js';
import { openPeopleStore, roomBlock } from '../backends/people.js';
import { recomputeSalienceForContext } from '../backends/salience.js';
import { closeAllBackends } from '../backends/index.js';
import { resolveSqliteDbPath } from '../config.js';
import { readHealth } from '../backends/recorder-health.js';

// Criteria 4, 5 and 8 (identity side) of docs/specs/person-cards.md.

const DEFAULT = '/nonexistent-default';

describe('identity people param — # In the room', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'loom-room-'));
    writeFileSync(join(dir, 'IDENTITY.md'), 'Creed');
    writeFileSync(join(dir, 'preferences.md'), 'Prefs');
  });

  afterEach(() => {
    closeAllBackends();
    rmSync(dir, { recursive: true, force: true });
  });

  const write = (slug: string, name: string, extra: object = {}) => {
    const s = openPeopleStore(dir)!;
    try {
      s.write({ slug, name, ...extra });
    } finally {
      s.close();
    }
  };

  const load = (people?: string[]) => loadIdentity(dir, undefined, undefined, undefined, undefined, people, DEFAULT);

  describe('4. identity splice', () => {
    it('puts the rendered card between the tape and Top of Mind', async () => {
      await remember(dir, { category: 'episode', title: 'ep', content: 'x', metadata: { where: 'voice' } });
      await remember(dir, { category: 'project', title: 'durable', content: 'y' });
      recomputeSalienceForContext(dir, Date.now());
      write('patrick-kells', 'Patrick Kells', { how: { tz: 'America/New_York', mode: 'terse' } });

      const id = await load(['patrick-kells']);
      const room = id.indexOf('# In the room');
      expect(room).toBeGreaterThan(id.indexOf('# Last 24h across bodies'));
      expect(room).toBeLessThan(id.indexOf('# Top of Mind'));
      expect(id).toContain('## Patrick Kells (patrick-kells)\n_(no summary)_\n**How:** mode: terse · tz: America/New_York');
    });

    it('gives placeholders for a missing card and an invalid slug', async () => {
      write('someone', 'Someone');
      const id = await load(['nobody', '../x', 'Patrick', 'x'.repeat(65)]);
      expect(id).toContain('_(no card for nobody)_');
      expect(id).toContain('_(invalid slug: ../x)_');
      expect(id).toContain('_(invalid slug: Patrick)_');
      expect(id).toContain('_(invalid slug)_');
      expect(id).not.toContain('x'.repeat(65));
    });

    it('no people, or an empty list, gives no block', async () => {
      write('patrick-kells', 'Patrick Kells');
      expect(await load()).not.toContain('# In the room');
      expect(await load([])).not.toContain('# In the room');
    });

    it('an unmigrated store still returns identity, with no block', async () => {
      await remember(dir, { category: 'project', title: 'durable', content: 'y' });
      closeAllBackends();
      const db = new BetterSqlite3(resolveSqliteDbPath(dir));
      db.prepare('DROP TABLE people').run();
      db.prepare('DROP TABLE person_revisions').run();
      db.close();
      const id = await load(['patrick-kells']);
      expect(id).toContain('# Identity');
      expect(id).not.toContain('# In the room');
    });

    it('no store at all gives no block', async () => {
      const id = await load(['patrick-kells']);
      expect(id).toContain('# Identity');
      expect(id).not.toContain('# In the room');
    });

    it('one unreadable card only affects its own slug, and is recorded', async () => {
      await remember(dir, { category: 'project', title: 'durable', content: 'y' });
      write('good', 'Good');
      write('bad', 'Bad');
      const db = new BetterSqlite3(resolveSqliteDbPath(dir));
      db.prepare("UPDATE people SET card_json = '{not json' WHERE slug = 'bad'").run();
      db.close();
      const err = vi.spyOn(console, 'error').mockImplementation(() => {});
      try {
        const id = await load(['bad', 'good']);
        expect(id).toContain('_(card for bad is unreadable)_');
        expect(id).toContain('## Good (good)');
        expect(err).toHaveBeenCalledTimes(1);
        expect(readHealth(dir).consecutiveFailures).toBe(1);
      } finally {
        err.mockRestore();
      }
    });
  });

  describe('5. room budget', () => {
    it('six valid slugs with duplicates: ≤ 4 cards, ≤ 6,000 chars of cards, the rest named', () => {
      const long = 'w'.repeat(1200);
      for (const s of ['a', 'b', 'c', 'd', 'e', 'f']) {
        write(s, s.toUpperCase(), { summary: long, how: { note: 'n'.repeat(200), more: 'm'.repeat(200) } });
      }
      const block = roomBlock(dir, ['a', 'b', 'a', 'c', 'd', 'b', 'e', 'f'])!;
      const cards = block.match(/^## /gm) ?? [];
      expect(cards.length).toBeLessThanOrEqual(4);
      expect(block.length).toBeLessThanOrEqual(6500);
      const cardText = block.split('\n\n').filter((e) => e.startsWith('## ')).reduce((n, e) => n + e.length, 0);
      expect(cardText).toBeLessThanOrEqual(6000);
      // Duplicates collapsed: each card appears once.
      expect(block.match(/## A \(a\)/g)).toHaveLength(1);
      const omitted = block.match(/_\((\d+) cards omitted for budget: ([^)]*)\)_$/)!;
      expect(omitted).not.toBeNull();
      const shown = ['a', 'b', 'c', 'd', 'e', 'f'].filter((s) => block.includes(`(${s})\n`));
      expect(Number(omitted[1])).toBe(6 - shown.length);
      for (const s of ['a', 'b', 'c', 'd', 'e', 'f'].filter((x) => !shown.includes(x))) {
        expect(omitted[2].split(', ')).toContain(s);
      }
    });

    it('a smaller card later in the list can still fit after a big one is skipped', () => {
      for (const s of ['a', 'b', 'c']) write(s, s, { summary: 'x'.repeat(1200), how: { f: 'y'.repeat(200), g: 'z'.repeat(200) } });
      write('big', 'Big', { summary: 'x'.repeat(1200), how: { f: 'y'.repeat(200), g: 'z'.repeat(200) } });
      write('small', 'Small');
      const block = roomBlock(dir, ['a', 'b', 'c', 'big', 'small'])!;
      expect(block).toContain('## Small (small)');
      expect(block).toContain('omitted for budget: big)_');
    });

    it('truncates to the first 8 distinct slugs and counts the rest as omitted', () => {
      const slugs = Array.from({ length: 11 }, (_, i) => `p${i}`);
      const block = roomBlock(dir, slugs);
      // No store yet → no block; seed one so the block renders.
      expect(block).toBeNull();
      write('p0', 'P0');
      const b2 = roomBlock(dir, slugs)!;
      expect(b2).toContain('_(no card for p7)_');
      expect(b2).not.toContain('no card for p8');
      expect(b2).toContain('_(3 cards omitted for budget: p8, p9, p10)_');
    });

    it('a long omitted list ends in … and keeps the full count', () => {
      write('a', 'A');
      const slugs = ['a', ...Array.from({ length: 7 }, (_, i) => `z${i}`), ...Array.from({ length: 40 }, (_, i) => `omitted-person-${i}`)];
      const block = roomBlock(dir, slugs)!;
      const last = block.split('\n\n').at(-1)!;
      expect(last).toMatch(/^_\(40 cards omitted for budget: omitted-person-0, .*, …\)_$/);
      expect(last.length).toBeLessThanOrEqual(400);
      expect(block.length).toBeLessThanOrEqual(6500);
    });
  });

  describe('8. archive (identity side)', () => {
    it('replaces an archived card with the archived line', async () => {
      write('patrick-kells', 'Patrick Kells');
      const s = openPeopleStore(dir)!;
      s.archive({ slug: 'patrick-kells', reason: 'r', actor: 'art' });
      s.close();
      const id = await load(['patrick-kells']);
      expect(id).toContain('_(card for patrick-kells is archived)_');
      expect(id).not.toContain('## Patrick Kells');
    });
  });
});
