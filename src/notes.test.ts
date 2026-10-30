import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import BetterSqlite3 from 'better-sqlite3';
import { citedPaths, expiresAt, LIFESPAN_DAYS, noteFilesDir, Notes } from './notes.js';

const DAY = 86_400_000;

describe('notes', () => {
  let dir: string;
  let now: number;
  let n: Notes;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'loom-notes-'));
    now = Date.parse('2026-10-30T12:00:00Z');
    n = new Notes(dir, () => now);
  });
  afterEach(() => { n.close(); rmSync(dir, { recursive: true, force: true }); });

  it('a note is written whole, with a lifespan when new, and keeps its old text as revisions', () => {
    expect(() => n.write('planning/2026-10-30', 'x', { by: 'art' })).toThrow(/needs its lifespan/);
    const a = n.write('planning/2026-10-30', '# Plan', { lifespan: 'while', by: 'art' });
    expect(a).toMatchObject({ path: 'planning/2026-10-30', lifespan: 'while', pinned: false, files: 0, expires: '2026-12-29T12:00:00.000Z' });
    now += DAY;
    // A rewrite keeps the lifespan and moves the clock.
    const b = n.write('planning/2026-10-30', '# Plan, revised', { by: 'art' });
    expect(b.lifespan).toBe('while');
    expect(b.expires).toBe(new Date(now + LIFESPAN_DAYS.while * DAY).toISOString());
    expect(n.read('planning/2026-10-30')!.body).toBe('# Plan, revised');
    expect(n.list({ prefix: 'planning/' }).map((r) => r.path)).toEqual(['planning/2026-10-30']);
    expect(expiresAt('keep', a.updated)).toBeNull();
  });

  it('paths are a few plain segments: no dot segments, no climbing out', () => {
    for (const bad of ['../x', 'a/../b', '.hidden', 'a/.b', '/abs', 'a//b', '']) {
      expect(() => n.write(bad, 'x', { lifespan: 'short', by: 'art' }), bad).toThrow(/a note path/);
    }
  });

  it("a file is stored once by its bytes, and goes when no note's file names it", () => {
    n.write('making/session-1', 'frames', { lifespan: 'short', by: 'art' });
    n.write('making/session-2', 'same frame', { lifespan: 'short', by: 'art' });
    const src = join(dir, 'frame.png');
    writeFileSync(src, 'PNGBYTES');
    const f1 = n.attach('making/session-1', 'frame.png', src, { type: 'image/png' });
    n.attach('making/session-2', 'cover.png', src);
    expect(f1).toMatchObject({ name: 'frame.png', bytes: 8, type: 'image/png' });
    const blobs = () => readdirSync(noteFilesDir(dir)).flatMap((d) => readdirSync(join(noteFilesDir(dir), d)));
    expect(blobs()).toEqual([f1.sha256]);
    expect(readFileSync(n.filePath('making/session-1', 'frame.png')!, 'utf-8')).toBe('PNGBYTES');
    expect(() => n.attach('nope', 'x.png', src)).toThrow(/no note nope/);
    n.delete('making/session-1');
    expect(blobs()).toEqual([f1.sha256]);
    n.delete('making/session-2');
    expect(blobs()).toEqual([]);
  });

  it('a sweep lets expired notes go, but keeps the ones a memory or page cites, the pinned, and keep', () => {
    n.write('decisions/2026-10-30-x', 'ruling', { lifespan: 'keep', by: 'art' });
    n.write('planning/2026-10-01', 'old plan', { lifespan: 'while', by: 'art' });
    n.write('r0210/run', 'stdout', { lifespan: 'short', by: 'art' });
    n.write('making/after-sunday', 'frames', { lifespan: 'short', by: 'art' });
    n.write('evals/old', 'scratch', { lifespan: 'short', by: 'art' });
    n.write('teardowns/thing', 'judgment', { lifespan: 'short', by: 'art' });
    n.pin('teardowns/thing', true);
    now += 15 * DAY;
    // Cited three ways: the old notes/ prefix with .md, a file inside the note, note: with a folder.
    const cited = ['notes/r0210/run.md', 'notes/making/after-sunday/frame-12.png', 'note:planning/'];
    const dry = n.sweep(cited, { dryRun: true });
    expect(dry).toEqual({ gone: ['evals/old'], keptCited: ['r0210/run', 'making/after-sunday'] });
    expect(n.read('evals/old')).not.toBeNull();
    // The plan isn't due yet (60 days); a short note nobody cites goes.
    expect(n.sweep(cited).gone).toEqual(['evals/old']);
    expect(n.read('evals/old')).toBeNull();
    now += 60 * DAY;
    expect(n.sweep([]).gone.sort()).toEqual(['making/after-sunday', 'planning/2026-10-01', 'r0210/run']);
    expect(n.list().map((r) => r.path).sort()).toEqual(['decisions/2026-10-30-x', 'teardowns/thing']);
  });

  it("citedPaths reads live memories and active knowledge pages, not archived ones", () => {
    const mem = new BetterSqlite3(join(dir, 'memories.db'));
    mem.exec('CREATE TABLE memories (title TEXT, content TEXT, archived INTEGER)');
    mem.prepare('INSERT INTO memories VALUES (?, ?, 0)').run('DNS', 'see notes/homelab/2026-10-30-dns-health.md for the numbers');
    mem.prepare('INSERT INTO memories VALUES (?, ?, 1)').run('old', 'notes/gone/x.md');
    mem.close();
    const kn = new BetterSqlite3(join(dir, 'knowledge.db'));
    kn.exec('CREATE TABLE pages (title TEXT, body TEXT, status TEXT)');
    kn.prepare("INSERT INTO pages VALUES (?, ?, 'active')").run('wunder', 'bench: note:homelab/2026-10-30-household-lock');
    kn.close();
    const c = citedPaths(dir);
    expect([...c].sort()).toEqual(['note:homelab/2026-10-30-household-lock', 'notes/homelab/2026-10-30-dns-health.md']);
    expect(existsSync(join(dir, 'memories.db'))).toBe(true);
  });
});
