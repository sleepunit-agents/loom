import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runCliCaptured } from './test-helpers.js';
import { openProjectsStore } from '../backends/projects.js';
import { remember } from '../tools/remember.js';
import { closeAllBackends } from '../backends/index.js';

// Criterion 15 of docs/specs/projects.md: the CLI's four verbs with --json
// and the exit codes (0 found, 3 no such project, 4 archived).

describe('loom project', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'loom-cli-project-'));
    writeFileSync(join(dir, 'IDENTITY.md'), '# Creed');
  });
  afterEach(() => {
    closeAllBackends();
    rmSync(dir, { recursive: true, force: true });
  });

  const seed = async () => {
    await remember(dir, { category: 'project', title: 'waf', content: 'the waf', project: 'on-pond' });
    await remember(dir, { category: 'project', title: 'mud', content: 'mud thing', project: 'mud' });
    const s = openProjectsStore(dir)!;
    s.write({ slug: 'pond', name: 'Pond', summary: 'Tadpoles.', links: { aliases: ['on-pond'] } });
    s.write({ slug: 'gone', name: 'Gone' });
    s.archive({ slug: 'gone', reason: 'shut', actor: 'art' });
    s.close();
  };
  const cli = (...args: string[]) => runCliCaptured(['project', ...args, '--context-dir', dir]);

  it('15. show prints the rendered card, resolves an alias, and exits 0', async () => {
    await seed();
    const r = await cli('show', 'pond');
    expect(r.code).toBe(0);
    expect(r.stdout).toBe('## Pond (pond · active)\nTadpoles.\n');
    const j = await cli('show', 'on-pond', '--json');
    expect(j.code).toBe(0);
    expect(JSON.parse(j.stdout)).toMatchObject({ found: true, resolved_from: 'on-pond', card: { slug: 'pond' } });
  });

  it('15. show and hub exit 3 for no such project, even with no store at all', async () => {
    expect((await cli('show', 'nope')).code).toBe(3);
    expect((await cli('hub', 'nope')).code).toBe(3);
    await seed();
    const r = await cli('hub', 'nope', '--json');
    expect(r.code).toBe(3);
    expect(JSON.parse(r.stdout)).toEqual({ found: false });
  });

  it('15. show and hub exit 4 for an archived project without --include-archived', async () => {
    await seed();
    expect((await cli('show', 'gone')).code).toBe(4);
    const hub = await cli('hub', 'gone', '--json');
    expect(hub.code).toBe(4);
    expect(JSON.parse(hub.stdout)).toEqual({ found: true, archived: true });
    expect((await cli('show', 'gone', '--include-archived')).code).toBe(0);
    expect((await cli('hub', 'gone', '--include-archived')).code).toBe(0);
  });

  it('15. hub --json gives the card and its sections; exit 0 even when a section failed', async () => {
    await seed();
    writeFileSync(join(dir, 'notes.db'), 'not a database');
    const r = await cli('hub', 'pond', '--json');
    expect(r.code).toBe(0);
    const hub = JSON.parse(r.stdout);
    expect(hub.card.slug).toBe('pond');
    expect(hub.sections.map((s: { key: string }) => s.key)).toEqual(['memories', 'notes', 'people']);
    expect(hub.sections[1]).toMatchObject({ key: 'notes', error: expect.any(String) });
    expect(hub.sections[0].items.map((i: { snippet: string }) => i.snippet)).toEqual(['waf — the waf']);
    const text = await cli('hub', 'pond');
    expect(text.code).toBe(0);
    expect(text.stdout).toContain('### memories (1: project 1)');
    expect(text.stdout).toContain('### notes\n_(error:');
  });

  it('15. list --json and orphans --json', async () => {
    await seed();
    const list = await cli('list', '--json');
    expect(list.code).toBe(0);
    expect(JSON.parse(list.stdout).map((e: { slug: string }) => e.slug)).toEqual(['pond']);
    const all = await cli('list', '--include-archived', '--json');
    expect(JSON.parse(all.stdout).map((e: { slug: string }) => e.slug).sort()).toEqual(['gone', 'pond']);
    expect((await cli('list', '--status', 'done', '--json')).stdout.trim()).toBe('[]');
    const orphans = await cli('orphans', '--json');
    expect(orphans.code).toBe(0);
    expect(JSON.parse(orphans.stdout)).toEqual([{ tag: 'mud', count: 1 }]);
    expect((await cli('orphans')).stdout).toBe('mud\t1\n');
  });

  it('15. an invalid name exits 1; a bad --status exits 1; usage errors exit 2', async () => {
    expect((await cli('show', '../x')).code).toBe(1);
    expect((await cli('list', '--status', 'stalled')).code).toBe(1);
    expect((await cli('show')).code).toBe(2);
    expect((await cli('frobnicate')).code).toBe(2);
  });
});
