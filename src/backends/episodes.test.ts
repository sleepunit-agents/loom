/**
 * t-142: the episode tape — short-term cross-body tier.
 * Time-ordered, budgeted newest-kept, excluded from the salience digest,
 * defaulted to a 48h TTL on write, injected at identity load.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import BetterSqlite3 from 'better-sqlite3';
import { assembleTape, tapeForContext, episodeRows, type EpisodeRow } from './episodes.js';
import { digestForContext, recomputeSalienceForContext } from './salience.js';
import { remember } from '../tools/remember.js';
import { loadIdentity } from '../tools/identity.js';
import { resolveSqliteDbPath } from '../config.js';
import { MEMORY_CATEGORIES, isMemoryCategory } from '../categories.js';

const NOW = Date.parse('2026-08-25T22:00:00Z'); // 17:00 CT
const hoursAgo = (h: number) => new Date(NOW - h * 3_600_000).toISOString();
const row = (title: string, created: string, where?: string, content = 'body'): EpisodeRow => ({
  title, content, created, project: null, metadata: JSON.stringify(where ? { where } : {}),
});

describe('categories', () => {
  it('episode is a writable category', () => {
    expect(MEMORY_CATEGORIES).toContain('episode');
    expect(isMemoryCategory('episode')).toBe(true);
  });
});

describe('assembleTape (time-ordered, budget drops oldest)', () => {
  it('orders oldest first regardless of input order and shows CT clock + where', () => {
    const t = assembleTape(
      [row('later', hoursAgo(1), 'discord:#m4l'), row('earlier', hoursAgo(5), 'discord:#general')],
      { timeZone: 'America/Chicago', nowMs: NOW },
    )!;
    const lines = t.split('\n');
    expect(lines[0]).toContain('earlier');
    expect(lines[1]).toContain('later');
    expect(lines[0]).toContain('[discord:#general]');
    expect(lines[0]).toMatch(/\*\*Tue 12:00\*\*/); // 22:00Z − 5h = 17:00Z = 12:00 CDT
  });

  it('keeps the NEWEST when over budget and says how many were omitted', () => {
    const rows = Array.from({ length: 10 }, (_, i) => row(`ep${i}`, hoursAgo(10 - i), 'x', 'y'.repeat(100)));
    const t = assembleTape(rows, { tokenBudget: 100, charsPerToken: 4, nowMs: NOW })!; // 400 chars
    expect(t).toContain('ep9');
    expect(t).not.toContain('ep0 ');
    expect(t).toMatch(/older episodes omitted/);
  });

  it('falls back to project for where, then ?', () => {
    const t = assembleTape([{ ...row('a', hoursAgo(1)), project: 'loom' }, row('b', hoursAgo(0))], { nowMs: NOW })!;
    expect(t).toContain('[loom] a');
    expect(t).toContain('[?] b');
  });

  it('returns null for nothing', () => {
    expect(assembleTape([])).toBeNull();
  });
});

describe('through the real store', () => {
  let dir: string;
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'loom-episodes-')); });
  afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

  it('an episode defaults to a 48h TTL, shows on the tape, and stays OUT of the digest', async () => {
    await remember(dir, { category: 'episode', title: 'shipped t-141', content: 'planetoids live', metadata: { where: 'discord:#general' } });
    await remember(dir, { category: 'project', title: 'durable thing', content: 'stays' });

    const db = new BetterSqlite3(resolveSqliteDbPath(dir), { readonly: true });
    const ep = db.prepare("SELECT ttl, expires_at FROM memories WHERE category = 'episode'").get() as { ttl: string; expires_at: string };
    db.close();
    expect(ep.ttl).toBe('48h');
    expect(ep.expires_at).toBeTruthy();

    const tape = tapeForContext(dir)!;
    expect(tape).toContain('[discord:#general] shipped t-141 — planetoids live');
    expect(tape).not.toContain('durable thing');

    recomputeSalienceForContext(dir, Date.now());
    const digest = digestForContext(dir)!;
    expect(digest).toContain('durable thing');
    expect(digest).not.toContain('shipped t-141');
  });

  it('respects the window and skips expired episodes', async () => {
    await remember(dir, { category: 'episode', title: 'fresh', content: 'x' });
    await remember(dir, { category: 'episode', title: 'old', content: 'x' });
    await remember(dir, { category: 'episode', title: 'dead', content: 'x', ttl: '1h' });
    const db = new BetterSqlite3(resolveSqliteDbPath(dir));
    db.prepare("UPDATE memories SET created = ? WHERE title = 'old'").run(new Date(Date.now() - 30 * 3_600_000).toISOString());
    db.prepare("UPDATE memories SET expires_at = ? WHERE title = 'dead'").run(new Date(Date.now() - 1000).toISOString());
    db.close();
    const titles = episodeRows(dir).map((r) => r.title);
    expect(titles).toEqual(['fresh']);
    expect(episodeRows(dir, { hours: 48 }).map((r) => r.title)).toEqual(['old', 'fresh']);
  });

  it('identity load injects the tape after preferences and before Top of Mind', async () => {
    writeFileSync(join(dir, 'IDENTITY.md'), 'Creed');
    writeFileSync(join(dir, 'preferences.md'), 'Prefs');
    await remember(dir, { category: 'episode', title: 'ep-one', content: 'what happened', metadata: { where: 'voice' } });
    await remember(dir, { category: 'project', title: 'proj-one', content: 'durable' });
    recomputeSalienceForContext(dir, Date.now());
    const id = await loadIdentity(dir, undefined, undefined, undefined, undefined, undefined, '/nonexistent-default');
    const tapeAt = id.indexOf('# Last 24h across bodies');
    expect(tapeAt).toBeGreaterThan(id.indexOf('# Preferences'));
    expect(tapeAt).toBeLessThan(id.indexOf('# Top of Mind'));
    expect(id).toContain('[voice] ep-one — what happened');
  });

  it('no episodes → no block', async () => {
    writeFileSync(join(dir, 'IDENTITY.md'), 'Creed');
    const id = await loadIdentity(dir, undefined, undefined, undefined, undefined, undefined, '/nonexistent-default');
    expect(id).not.toContain('Last 24h across bodies');
  });
});
