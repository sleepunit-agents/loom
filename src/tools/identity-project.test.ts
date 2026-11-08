import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import BetterSqlite3 from 'better-sqlite3';
import { loadIdentity } from './identity.js';
import { remember } from './remember.js';
import { openPeopleStore } from '../backends/people.js';
import { openProjectsStore, projectBlock } from '../backends/projects.js';
import { recomputeSalienceForContext } from '../backends/salience.js';
import { closeAllBackends } from '../backends/index.js';
import { resolveSqliteDbPath } from '../config.js';

// Criterion 13 of docs/specs/projects.md: identity({project}) adds a
// `# This project` block after the tape, before `# In the room` and Top of
// Mind, within its cap, and never fails identity.

const DEFAULT = '/nonexistent-default';

describe('identity project param — # This project', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'loom-identity-project-'));
    writeFileSync(join(dir, 'IDENTITY.md'), 'Creed');
  });

  afterEach(() => {
    closeAllBackends();
    rmSync(dir, { recursive: true, force: true });
  });

  const projects = (fn: (s: NonNullable<ReturnType<typeof openProjectsStore>>) => void) => {
    const s = openProjectsStore(dir)!;
    try {
      fn(s);
    } finally {
      s.close();
    }
  };
  const load = (project?: string, people?: string[]) => loadIdentity(dir, project, undefined, undefined, undefined, people, DEFAULT);

  it('13. after the tape, before # In the room and Top of Mind', async () => {
    await remember(dir, { category: 'episode', title: 'ep', content: 'x', metadata: { where: 'voice' } });
    await remember(dir, { category: 'project', title: 'durable', content: 'y' });
    recomputeSalienceForContext(dir, Date.now());
    projects((s) => s.write({ slug: 'pond', name: 'Pond Rebuild', summary: 'Tadpoles.', goal: 'All sites.', links: { aliases: ['on-pond'] } }));
    const people = openPeopleStore(dir)!;
    people.write({ slug: 'loren-smith', name: 'Loren' });
    people.close();

    const id = await load('pond', ['loren-smith']);
    const block = id.indexOf('# This project');
    expect(block).toBeGreaterThan(id.indexOf('# Last 24h across bodies'));
    expect(block).toBeLessThan(id.indexOf('# In the room'));
    expect(id.indexOf('# In the room')).toBeLessThan(id.indexOf('# Top of Mind'));
    expect(id).toContain('# This project\n## Pond Rebuild (pond · active)\nTadpoles.\n**Goal:** All sites.');

    const alone = await load('pond');
    expect(alone.indexOf('# This project')).toBeLessThan(alone.indexOf('# Top of Mind'));
    expect(alone).not.toContain('# In the room');
  });

  it('13. an alias resolves to its project', async () => {
    projects((s) => s.write({ slug: 'pond', name: 'Pond', links: { aliases: ['on-pond'] } }));
    expect(await load('on-pond')).toContain('# This project\n## Pond (pond · active)');
  });

  it('13. the block is within its cap: heading, newline and a card the write capped at 2,000', () => {
    const where = Object.fromEntries(Array.from({ length: 4 }, (_, i) => [`field_${i}`, { value: 'v'.repeat(80) }]));
    projects((s) => s.write({ slug: 'pond', name: 'n'.repeat(80), summary: 's'.repeat(1200), goal: 'g'.repeat(100), where }));
    const block = projectBlock(dir, 'pond', { nowMs: Date.now() + 5000 * 86_400_000 })!;
    expect(block.startsWith('# This project\n## ')).toBe(true);
    expect(block.length).toBeGreaterThan(1500);
    expect(block.length).toBeLessThanOrEqual(2015);
  });

  it('13. a missing, archived or unreadable card gives its line, never a failure', async () => {
    expect(await load('pond')).toContain('# This project\n_(no project pond)_');
    projects((s) => {
      s.write({ slug: 'pond', name: 'Pond' });
      s.write({ slug: 'gone', name: 'Gone' });
      s.archive({ slug: 'gone', reason: 'x', actor: 'art' });
      s.write({ slug: 'bad', name: 'Bad' });
    });
    expect(await load('nope')).toContain('# This project\n_(no project nope)_');
    expect(await load('gone')).toContain('# This project\n_(project gone is archived)_');
    const db = new BetterSqlite3(resolveSqliteDbPath(dir));
    db.prepare("UPDATE projects SET card_json = '{not json' WHERE slug = 'bad'").run();
    db.close();
    const id = await load('bad');
    expect(id).toContain('# This project\n_(project bad is unreadable)_');
    expect(id).toContain('# Identity');
  });

  it('13. an unmigrated store or a name no project can have still returns identity', async () => {
    await remember(dir, { category: 'project', title: 'durable', content: 'y' });
    closeAllBackends();
    const db = new BetterSqlite3(resolveSqliteDbPath(dir));
    for (const t of ['projects', 'project_revisions', 'project_names']) db.prepare(`DROP TABLE ${t}`).run();
    db.close();
    expect(await load('pond')).toContain('_(no project pond)_');
    const long = await load('a'.repeat(60));
    expect(long).toContain(`_(no project ${'a'.repeat(32)}…)_`);
    expect(long).not.toContain('a'.repeat(33));
  });

  it('no project gives no block', async () => {
    projects((s) => s.write({ slug: 'pond', name: 'Pond' }));
    expect(await load()).not.toContain('# This project');
  });
});
