import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import BetterSqlite3 from 'better-sqlite3';
import { PeopleStore, openPeopleStore, renderCard, validateCard, MAX_RENDER, type PersonCard } from './people.js';
import { remember } from '../tools/remember.js';
import { closeAllBackends } from './index.js';
import { resolveSqliteDbPath } from '../config.js';

// Acceptance criteria 1–3, 6, 7, 9 and 11 of docs/specs/person-cards.md, on
// the store itself. Criteria 4, 5 and 8 (identity) are in tools/identity-room.test.ts,
// 10 in people-write-race.test.ts, 12 in tools/dossier.test.ts.

const DAY = 86_400_000;
const T0 = Date.parse('2026-10-19T12:00:00.000Z');

describe('PeopleStore', () => {
  let dir: string;
  let now: number;
  let store: PeopleStore;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'loom-people-'));
    now = T0;
    store = new PeopleStore({ dbPath: join(dir, 'memories.db'), now: () => now });
  });

  afterEach(() => {
    store.close();
    closeAllBackends();
    rmSync(dir, { recursive: true, force: true });
  });

  const seed = () =>
    store.write({
      slug: 'patrick-kells',
      name: 'Patrick Kells',
      summary: 'Field lead.',
      where: { pond: { value: 'field / et-livonia', verified_at: new Date(T0).toISOString() } },
      how: { tz: 'America/New_York', mode: 'terse' },
      may: [{ text: 'may draft field-setup changes', source: 'Jonathan, Discord #pond 2026-10-08' }],
    });

  const card = (slug = 'patrick-kells') => store.getRow(slug)!.card;

  describe('1. overwrite, not accumulate', () => {
    it('holds only the newest value; history has the one displaced', () => {
      store.write({ slug: 'p', name: 'P', how: { mode: 'terse' } });
      store.write({ slug: 'p', how: { mode: 'shakespearean' } });
      expect(card('p').how).toEqual({ mode: 'shakespearean' });
      const history = store.history('p');
      expect(history.map((h) => h.op)).toEqual(['write']);
      expect(store.revisionSnapshot(history[0].id)!.card.how).toEqual({ mode: 'terse' });
    });
  });

  describe('2. merge', () => {
    it('a write passing only how.tz leaves everything else alone', () => {
      seed();
      const before = card();
      store.write({ slug: 'patrick-kells', how: { tz: 'America/Chicago' } });
      expect(card()).toEqual({ ...before, how: { ...before.how, tz: 'America/Chicago' } });
    });

    it('a null field removes it', () => {
      seed();
      store.write({ slug: 'patrick-kells', how: { tz: null } });
      expect(card().how).toEqual({ mode: 'terse' });
    });

    it('merge: false with only name empties every section', () => {
      seed();
      store.write({ slug: 'patrick-kells', name: 'Patrick Kells', merge: false });
      expect(card()).toEqual({ slug: 'patrick-kells', name: 'Patrick Kells', where: {}, how: {}, may: [] });
    });

    it('an identical write that omits summary is a no-op with no revision', () => {
      seed();
      const r = store.write({ slug: 'patrick-kells', how: { mode: 'terse' } });
      expect(r.unchanged).toBe(true);
      expect(r.revision_id).toBeNull();
      expect(store.history('patrick-kells')).toEqual([]);
    });

    it('passing an unchanged summary still stores and moves synthesized_at', () => {
      seed();
      now = T0 + 1000;
      const r = store.write({ slug: 'patrick-kells', summary: 'Field lead.' });
      expect(r.unchanged).toBe(false);
      expect(r.synthesized_at).toBe(new Date(T0 + 1000).toISOString());
      expect(store.history('patrick-kells')).toHaveLength(1);
    });

    it.each([
      [{ summary: null }, /summary: null/],
      [{ how: null }, /how: null/],
      [{ where: { pond: { value: 'x', verified_at: null } } }, /where\.pond\.verified_at: null/],
      [{ how: { loop_in: ['a', null] } }, /how\.loop_in\[1\]: null/],
      [{ name: 'P', merge: false, how: { tz: null } }, /how\.tz: null/],
    ])('rejects null in %j, naming the path', (extra, msg) => {
      seed();
      expect(() => store.write({ slug: 'patrick-kells', ...(extra as object) } as never)).toThrow(msg);
    });

    it('merge: false without summary removes it and resets synthesized_at; every tagged memory counts', async () => {
      const ctx = mkdtempSync(join(tmpdir(), 'loom-people-ctx-'));
      try {
        await remember(ctx, { category: 'user', title: 'pk tz', content: 'Eastern', metadata: { person: 'patrick-kells' } });
        await remember(ctx, { category: 'user', title: 'pk terse', content: 'Concise', metadata: { person: 'patrick-kells' } });
        await remember(ctx, { category: 'user', title: 'other', content: 'x', metadata: { person: 'someone-else' } });
        const s = openPeopleStore(ctx)!;
        try {
          s.write({ slug: 'patrick-kells', name: 'Patrick Kells', summary: 'Field lead.' });
          expect(s.list()[0].memories_since_synthesis).toBe(0);
          const r = s.write({ slug: 'patrick-kells', name: 'Patrick Kells', merge: false });
          expect(r.card.summary).toBeUndefined();
          expect(r.synthesized_at).toBeNull();
          expect(s.list()[0]).toMatchObject({ synthesized_at: null, memories_since_synthesis: 2 });
        } finally {
          s.close();
        }
      } finally {
        closeAllBackends();
        rmSync(ctx, { recursive: true, force: true });
      }
    });

    it('memories_since_synthesis counts only memories created after the summary', async () => {
      const ctx = mkdtempSync(join(tmpdir(), 'loom-people-ctx-'));
      try {
        await remember(ctx, { category: 'user', title: 'old', content: 'a', metadata: { person: 'pk' } });
        await remember(ctx, { category: 'user', title: 'new', content: 'b', metadata: { person: 'pk' } });
        await remember(ctx, { category: 'user', title: 'gone', content: 'c', metadata: { person: 'pk' }, ttl: '1h' });
        const db = new BetterSqlite3(resolveSqliteDbPath(ctx));
        db.prepare("UPDATE memories SET created = ? WHERE title = 'old'").run(new Date(T0 - DAY).toISOString());
        db.prepare("UPDATE memories SET created = ? WHERE title = 'new'").run(new Date(T0 + 1000).toISOString());
        db.prepare("UPDATE memories SET expires_at = ? WHERE title = 'gone'").run(new Date(T0 - 1).toISOString());
        db.close();
        const s = openPeopleStore(ctx, { now: () => T0 })!;
        try {
          s.write({ slug: 'pk', name: 'PK', summary: 'S' });
          expect(s.list()[0].memories_since_synthesis).toBe(1);
        } finally {
          s.close();
        }
      } finally {
        closeAllBackends();
        rmSync(ctx, { recursive: true, force: true });
      }
    });
  });

  describe('3. staleness', () => {
    const at = (ms: number) => new Date(ms).toISOString();
    it('renders [STALE], [ok] and [unverified] at the boundary', () => {
      store.write({
        slug: 'p',
        name: 'P',
        where: {
          a: { value: 'over', verified_at: at(T0 - 14 * DAY - 1000) },
          b: { value: 'exact', verified_at: at(T0 - 14 * DAY) },
          c: { value: 'never' },
          d: { value: 'short', verified_at: at(T0 - 8 * DAY), stale_after_days: 7 },
        },
      });
      const rendered = store.read('p') as { rendered: string };
      expect(rendered.rendered).toContain('**Where:** a: over [STALE 14d] · b: exact [ok] · c: never [unverified] · d: short [STALE 8d]');
      expect(store.list()[0]).toMatchObject({ stale: 2, unverified: 1 });
    });

    it('person_verify makes the field [ok] without changing its value', () => {
      store.write({ slug: 'p', name: 'P', where: { a: { value: 'x', verified_at: at(T0 - 30 * DAY) } } });
      store.verify({ slug: 'p', fields: ['a'], source: 'checked' });
      expect(card('p').where.a).toEqual({ value: 'x', verified_at: at(T0), source: 'checked' });
      expect((store.read('p') as { rendered: string }).rendered).toContain('a: x [ok]');
      expect(store.history('p').map((h) => h.op)).toEqual(['verify']);
    });

    it('person_verify is all-or-nothing and rejects a future stamp', () => {
      store.write({ slug: 'p', name: 'P', where: { a: { value: 'x' } } });
      expect(() => store.verify({ slug: 'p', fields: [] })).toThrow(/fields/);
      expect(() => store.verify({ slug: 'p', fields: ['a', 'nope'] })).toThrow(/"nope"/);
      expect(card('p').where.a.verified_at).toBeUndefined();
      expect(() => store.verify({ slug: 'p', fields: ['a'], verified_at: at(T0 + 2 * 60_000) })).toThrow(/future/);
      expect(() => store.verify({ slug: 'missing', fields: ['a'] })).toThrow(/no card/);
    });

    it('rejects an inherited name like __proto__ without touching Object.prototype (PR143 review)', () => {
      store.write({ slug: 'p', name: 'P', where: { pond: { value: 'unverified access' } } });
      try {
        for (const f of ['__proto__', 'constructor', 'toString']) {
          expect(() => store.verify({ slug: 'p', fields: [f], source: 'review' })).toThrow(/not a where field/);
        }
        expect(Object.prototype).not.toHaveProperty('verified_at');
        expect(Object.prototype).not.toHaveProperty('source');
        expect(({} as Record<string, unknown>).verified_at).toBeUndefined();
        expect((store.read('p') as { rendered: string }).rendered).toContain('pond: unverified access [unverified]');
        expect(store.history('p')).toEqual([]);
      } finally {
        delete (Object.prototype as Record<string, unknown>).verified_at;
        delete (Object.prototype as Record<string, unknown>).source;
      }
    });

    it('a verify that changes nothing is a no-op', () => {
      store.write({ slug: 'p', name: 'P', where: { a: { value: 'x', verified_at: at(T0) } } });
      expect(store.verify({ slug: 'p', fields: ['a'], verified_at: at(T0) }).unchanged).toBe(true);
      expect(store.history('p')).toEqual([]);
    });
  });

  describe('6. not a gate', () => {
    it.each([
      [{ where: { tier: { value: '2' } } }, /"tier" is a reserved key/],
      [{ how: { projects: ['pond'] } }, /"projects" is a reserved key/],
      [{ how: { x: { tier: 3 } } }, /"tier" is a reserved key/],
      [{ where: { pond: { value: 'x', scope: 'all' } } }, /"scope" is a reserved key/],
    ])('rejects %j naming the reserved key', (extra, msg) => {
      expect(() => store.write({ slug: 'p', name: 'P', ...(extra as object) } as never)).toThrow(msg);
    });

    it('rejects a may entry without source, and an unknown top-level key', () => {
      expect(() => store.write({ slug: 'p', name: 'P', may: [{ text: 'approve purchases' } as never] })).toThrow(/may\[0\]\.source/);
      expect(() => store.write({ slug: 'p', name: 'P', tier: 3 } as never)).toThrow(/tier/);
      expect(() => store.write({ slug: 'p', name: 'P', live: {} } as never)).toThrow(/live: unknown top-level key/);
      expect(store.getRow('p')).toBeNull();
    });

    it('treats slug-looking values as inert strings', () => {
      store.write({ slug: 'p', name: 'P', how: { loop_in: ['phil-baker', 'nobody-at-all'] } });
      expect(card('p').how.loop_in).toEqual(['phil-baker', 'nobody-at-all']);
    });
  });

  describe('7. size caps', () => {
    it('rejects a summary over 1,200 chars', () => {
      expect(() => store.write({ slug: 'p', name: 'P', summary: 'x'.repeat(1201) })).toThrow(/summary: longer than 1200/);
    });

    /** A card whose worst-case render is exactly `target` chars: a full summary, then 200-char how fields. */
    function cardAt(target: number): PersonCard {
      const c: PersonCard = { slug: 'p', name: 'P', summary: 's'.repeat(1200), where: { a: { value: '' } }, how: {}, may: [] };
      const len = () => renderCard(c, 0, { worstCase: true }).length;
      for (let i = 0; len() < target; i++) {
        c.how[`f${i}`] = 'y'.repeat(200);
        if (len() > target) c.how[`f${i}`] = 'y'.repeat(200 - (len() - target));
      }
      return c;
    }

    it('rejects a card whose worst-case render is over 2,000', () => {
      const big = cardAt(MAX_RENDER + 1);
      expect(renderCard(big, 0, { worstCase: true }).length).toBe(MAX_RENDER + 1);
      expect(() => store.write({ ...big })).toThrow(/worst-case render is 2001/);
    });

    it('a card accepted at 1,990 worst-case chars renders ≤ 2,000 after 1,000 days', () => {
      const c = cardAt(1990);
      expect(renderCard(c, 0, { worstCase: true }).length).toBe(1990);
      store.write({ ...c, where: { a: { value: '', verified_at: new Date(T0).toISOString() } } });
      now = T0 + 1000 * DAY;
      const r = store.read('p') as { rendered: string };
      expect(r.rendered).toContain('[STALE 999+d]');
      expect(r.rendered.length).toBeLessThanOrEqual(MAX_RENDER);
    });
  });

  describe('8. archive (store side)', () => {
    it('hides, rejects mutations, and restores with fields intact', () => {
      seed();
      const before = card();
      store.archive({ slug: 'patrick-kells', reason: 'left the project', actor: 'art' });
      expect(store.list()).toEqual([]);
      expect(store.list(true)).toHaveLength(1);
      expect(store.read('patrick-kells')).toEqual({ found: true, archived: true });
      expect(store.read('patrick-kells', true)).toMatchObject({ found: true, archived: true, card: before });
      expect(() => store.write({ slug: 'patrick-kells', how: { mode: 'x' } })).toThrow(/archived/);
      expect(() => store.verify({ slug: 'patrick-kells', fields: ['pond'] })).toThrow(/archived/);
      const rev = store.history('patrick-kells')[0].id;
      expect(() => store.revisionRestore({ slug: 'patrick-kells', revision_id: rev })).toThrow(/archived/);
      expect(store.archive({ slug: 'patrick-kells', reason: 'again', actor: 'art' }).unchanged).toBe(true);
      store.restore({ slug: 'patrick-kells' });
      expect(card()).toEqual(before);
      expect(store.restore({ slug: 'patrick-kells' }).unchanged).toBe(true);
      expect(store.history('patrick-kells').map((h) => h.op)).toEqual(['restore', 'archive']);
      expect(() => store.archive({ slug: 'nobody', reason: 'r', actor: 'art' })).toThrow(/no card/);
      expect(() => store.archive({ slug: 'patrick-kells', reason: '', actor: 'art' })).toThrow(/reason/);
    });
  });

  describe('9. revisions', () => {
    it('rejects another slug\'s revision', () => {
      store.write({ slug: 'a', name: 'A', how: { m: '1' } });
      store.write({ slug: 'a', how: { m: '2' } });
      store.write({ slug: 'b', name: 'B' });
      const aRev = store.history('a')[0].id;
      expect(() => store.revisionRestore({ slug: 'b', revision_id: aRev })).toThrow(/belongs to another card/);
    });

    it('restores summary and synthesized_at across a summary-removing merge: false write', () => {
      store.write({ slug: 'p', name: 'P', summary: 'Kept.' });
      const synthesized = store.getRow('p')!.synthesized_at;
      now += 1000;
      store.write({ slug: 'p', name: 'P', merge: false }); // snapshots the summarized card
      const beforeRemoval = store.history('p')[0].id;
      now += 1000;
      store.write({ slug: 'p', how: { mode: 'x' } }); // snapshots the summary-less card
      const afterRemoval = store.history('p')[0].id;

      now += 1000;
      const r = store.revisionRestore({ slug: 'p', revision_id: beforeRemoval });
      expect(r.card.summary).toBe('Kept.');
      expect(r.synthesized_at).toBe(synthesized);
      expect(store.history('p')[0].op).toBe('revision_restore');

      now += 1000;
      const r2 = store.revisionRestore({ slug: 'p', revision_id: afterRemoval });
      expect(r2.card.summary).toBeUndefined();
      expect(r2.synthesized_at).toBeNull();
    });

    it('keeps at most 10 revisions per slug', () => {
      store.write({ slug: 'p', name: 'P', how: { n: 0 } });
      for (let i = 1; i <= 15; i++) store.write({ slug: 'p', how: { n: i } });
      const history = store.history('p');
      expect(history).toHaveLength(10);
      expect(store.revisionSnapshot(history[0].id)!.card.how).toEqual({ n: 14 });
    });

    it('snapshots the whole previous row, including archive state and timestamps', () => {
      store.write({ slug: 'p', name: 'P', summary: 'S' });
      store.archive({ slug: 'p', reason: 'r', actor: 'art' });
      store.restore({ slug: 'p' });
      const snap = store.revisionSnapshot(store.history('p')[0].id)!;
      expect(snap).toMatchObject({ slug: 'p', archived_at: new Date(T0).toISOString(), synthesized_at: new Date(T0).toISOString() });
    });
  });

  describe('11. path safety', () => {
    it.each(['../x', 'Patrick', 'a/b', '', 'a--b', '-a', 'x'.repeat(65)])('rejects slug %j at every surface', (slug) => {
      expect(() => store.write({ slug, name: 'N' })).toThrow(/slug/);
      expect(() => store.read(slug)).toThrow(/slug/);
      expect(() => store.history(slug)).toThrow(/slug/);
      expect(() => store.verify({ slug, fields: ['a'] })).toThrow(/slug/);
      expect(() => store.archive({ slug, reason: 'r', actor: 'a' })).toThrow(/slug/);
      expect(() => store.restore({ slug })).toThrow(/slug/);
      expect(() => store.revisionRestore({ slug, revision_id: 1 })).toThrow(/slug/);
    });

    it('never echoes an over-long slug', () => {
      const long = 'x'.repeat(65);
      expect(() => store.write({ slug: long, name: 'N' })).toThrow(/longer than 64/);
      try { store.write({ slug: long, name: 'N' }); } catch (e) { expect((e as Error).message).not.toContain(long); }
    });
  });

  describe('shape', () => {
    it('requires name on create', () => {
      expect(() => store.write({ slug: 'p', how: { tz: 'x' } })).toThrow(/name: is required/);
    });

    it('rejects a future verified_at on write, with a minute of grace', () => {
      expect(() => store.write({ slug: 'p', name: 'P', where: { a: { value: 'x', verified_at: new Date(T0 + 120_000).toISOString() } } })).toThrow(/future/);
      store.write({ slug: 'p', name: 'P', where: { a: { value: 'x', verified_at: new Date(T0 + 30_000).toISOString() } } });
    });

    it.each([
      [{ how: { 'Bad-Name': 'x' } }, /field name/],
      [{ how: { x: 'y'.repeat(201) } }, /how\.x: longer than 200/],
      [{ how: { x: Array(9).fill('a') } }, /more than 8 items/],
      [{ how: Object.fromEntries(Array.from({ length: 13 }, (_, i) => [`f${i}`, 1])) }, /more than 12 fields/],
      [{ where: { a: { value: 'x', stale_after_days: 0 } } }, /stale_after_days/],
      [{ where: { a: { value: 'x', verified_at: '2026-10-19' } } }, /ISO-8601/],
      [{ where: { a: 'bare' } }, /where\.a: must be an object/],
      [{ may: Array(9).fill({ text: 't', source: 's' }) }, /more than 8 entries/],
    ])('rejects %j', (extra, msg) => {
      expect(() => store.write({ slug: 'p', name: 'P', ...(extra as object) } as never)).toThrow(msg);
    });

    it('validates incoming field names before a null-delete applies, on update and create (PR143 review)', () => {
      store.write({ slug: 'p', name: 'P' });
      expect(() => store.write({ slug: 'p', how: { 'Bad Field': null } })).toThrow(/how\.Bad Field: field name/);
      expect(() => store.write({ slug: 'p', where: { 'Bad Field': null } })).toThrow(/where\.Bad Field: field name/);
      expect(() => store.write({ slug: 'q', name: 'Q', how: { 'Bad Field': null } })).toThrow(/field name/);
      expect(store.getRow('q')).toBeNull();
    });

    it.each(['__proto__', 'constructor', 'prototype'])('rejects %s as a field name', (n) => {
      const how = JSON.parse(`{"${n}": "x"}`);
      expect(() => store.write({ slug: 'p', name: 'P', how })).toThrow(new RegExp(`"${n}" is not allowed`));
      expect(Object.prototype).not.toHaveProperty('x');
      expect(store.getRow('p')).toBeNull();
    });

    it('renders the fixed grammar, fields in name order', () => {
      seed();
      store.write({ slug: 'patrick-kells', how: { loop_in: ['phil-baker', 'dana'] } });
      const r = store.read('patrick-kells') as { rendered: string };
      expect(r.rendered).toBe(
        '## Patrick Kells (patrick-kells)\n' +
        'Field lead.\n' +
        '**Where:** pond: field / et-livonia [ok]\n' +
        '**How:** loop_in: phil-baker, dana · mode: terse · tz: America/New_York\n' +
        '**May (descriptive, not a grant):** may draft field-setup changes — Jonathan, Discord #pond 2026-10-08',
      );
    });

    it('leaves empty sections out and marks a missing summary', () => {
      store.write({ slug: 'p', name: 'P\nQ', how: { note: 'two\nlines' } });
      expect((store.read('p') as { rendered: string }).rendered).toBe('## P Q (p)\n_(no summary)_\n**How:** note: two lines');
    });

    it('validateCard accepts what write stores', () => {
      seed();
      expect(() => validateCard(card(), T0)).not.toThrow();
    });
  });

  it('a read-only open of an unmigrated store sees no cards', () => {
    const path = join(dir, 'bare.db');
    new BetterSqlite3(path).close();
    const ro = new PeopleStore({ dbPath: path, readonly: true });
    try {
      expect(ro.migrated).toBe(false);
      expect(ro.getRow('p')).toBeNull();
      expect(ro.list()).toEqual([]);
    } finally {
      ro.close();
    }
  });
});
