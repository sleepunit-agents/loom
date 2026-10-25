import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runCliCaptured } from './test-helpers.js';
import { openPeopleStore } from '../backends/people.js';
import { remember } from '../tools/remember.js';

describe('loom person', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'loom-cli-person-'));
    writeFileSync(join(dir, 'IDENTITY.md'), '# Creed');
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  const seed = () => {
    const s = openPeopleStore(dir)!;
    s.write({ slug: 'patrick-kells', name: 'Patrick Kells', summary: 'Field lead.', how: { tz: 'America/New_York' } });
    s.write({ slug: 'gone', name: 'Gone' });
    s.archive({ slug: 'gone', reason: 'left', actor: 'art' });
    s.close();
  };

  it('show prints the rendered card and exits 0', async () => {
    seed();
    const { stdout, code } = await runCliCaptured(['person', 'show', 'patrick-kells', '--context-dir', dir]);
    expect(code).toBe(0);
    expect(stdout).toBe('## Patrick Kells (patrick-kells)\nField lead.\n**How:** tz: America/New_York\n');
  });

  it('show --json prints the person result', async () => {
    seed();
    const { stdout, code } = await runCliCaptured(['person', 'show', 'patrick-kells', '--json', '--context-dir', dir]);
    expect(code).toBe(0);
    const r = JSON.parse(stdout);
    expect(r).toMatchObject({ found: true, archived: false, card: { slug: 'patrick-kells' } });
    expect(r.rendered).toContain('## Patrick Kells');
  });

  it('exits 3 for no such card, including with no store at all', async () => {
    expect((await runCliCaptured(['person', 'show', 'nobody', '--context-dir', dir])).code).toBe(3);
    seed();
    const r = await runCliCaptured(['person', 'show', 'nobody', '--context-dir', dir]);
    expect(r.code).toBe(3);
    expect(r.stdout).toBe('');
  });

  it('exits 4 for an archived card unless --include-archived', async () => {
    seed();
    expect((await runCliCaptured(['person', 'show', 'gone', '--context-dir', dir])).code).toBe(4);
    const r = await runCliCaptured(['person', 'show', 'gone', '--include-archived', '--context-dir', dir]);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain('archived');
  });

  it('rejects an invalid slug with exit 1 even with no store (PR143 review)', async () => {
    const r = await runCliCaptured(['person', 'show', '../x', '--context-dir', dir]);
    expect(r.code).toBe(1);
    expect(r.stderr).toMatch(/slug/);
  });

  it('rejects an invalid slug (criterion 11) with exit 1', async () => {
    seed();
    const r = await runCliCaptured(['person', 'show', '../x', '--context-dir', dir]);
    expect(r.code).toBe(1);
    expect(r.stderr).toMatch(/slug/);
  });

  it('list prints active cards; --json emits entries', async () => {
    seed();
    const text = await runCliCaptured(['person', 'list', '--context-dir', dir]);
    expect(text.code).toBe(0);
    expect(text.stdout).toContain('patrick-kells\tPatrick Kells');
    expect(text.stdout).not.toContain('gone');
    const json = await runCliCaptured(['person', 'list', '--json', '--include-archived', '--context-dir', dir]);
    expect(JSON.parse(json.stdout).map((e: { slug: string }) => e.slug)).toEqual(['gone', 'patrick-kells']);
  });

  it('unknown subcommand exits 2', async () => {
    expect((await runCliCaptured(['person', 'bogus', '--context-dir', dir])).code).toBe(2);
  });
  it('evidence prints the memories a card condenses: tagged user and feedback, active, oldest first', async () => {
    seed();
    await remember(dir, { category: 'user', title: 'pk tz', content: 'Eastern', metadata: { person: 'patrick-kells' } });
    await remember(dir, { category: 'feedback', title: 'pk terse', content: 'Concise, please', metadata: { person: 'patrick-kells' } });
    await remember(dir, { category: 'project', title: 'not evidence', content: 'x', metadata: { person: 'patrick-kells' } });
    await remember(dir, { category: 'user', title: 'someone else', content: 'y', metadata: { person: 'other' } });
    const { stdout, code } = await runCliCaptured(['person', 'evidence', 'patrick-kells', '--json', '--context-dir', dir]);
    expect(code).toBe(0);
    const rows = JSON.parse(stdout) as { title: string; category: string; content: string }[];
    expect(rows.map((r) => r.title)).toEqual(['pk tz', 'pk terse']);
    expect(rows[1]).toMatchObject({ category: 'feedback', content: 'Concise, please' });
    const later = await runCliCaptured(['person', 'evidence', 'patrick-kells', '--since', '2999-01-01T00:00:00Z', '--json', '--context-dir', dir]);
    expect(JSON.parse(later.stdout)).toEqual([]);
    const text = await runCliCaptured(['person', 'evidence', 'patrick-kells', '--context-dir', dir]);
    expect(text.stdout).toContain('## pk tz\n*user — ');
    expect((await runCliCaptured(['person', 'evidence', 'patrick-kells', '--since', 'nope', '--context-dir', dir])).code).toBe(2);
  });
});
