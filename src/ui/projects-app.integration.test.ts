/**
 * The Projects app (docs/specs/projects.md, "loom's page: the Projects app", criteria 19-23): a Places tile after
 * People, an index (waiting on you first, then errors, then activity; feeds counted through a 60 s cache), and each
 * project's hub as a page (its sections in order, a `waiting` group's items once, feeds run fresh every load).
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { startHttpServer, type HttpServeHandle } from '../transport/http-server.js';
import { loadHousehold } from '../household.js';
import { closeAllBackends } from '../backends/index.js';
import { openProjectsStore, type ProjectWriteInput } from '../backends/projects.js';
import { clearPieceCache } from './pieces.js';
import { feedLink, forgetProjectCounts, projectHubPage, projectsIndex } from './projects-pages.js';
import type { ProjectHubResult } from '../tools/project.js';

const TOKEN = 'projects-owner-token';
const NOW = Date.parse('2026-11-05T12:00:00Z');

const write = (dir: string, input: ProjectWriteInput) => {
  const s = openProjectsStore(dir, { now: () => NOW })!;
  try { s.write(input); } finally { s.close(); }
};

/** A managed piece offering a feed: its answer, and a file it counts its runs in. */
function feedPiece(home: string, name: string, answer: object, runs: string) {
  const root = join(home, 'managed', 'pieces');
  mkdirSync(join(root, name), { recursive: true });
  mkdirSync(join(root, 'bin'), { recursive: true });
  writeFileSync(join(root, 'bin', `loom-${name}`), `#!/bin/sh\n[ "$1" = project-feed ] || exit 2\necho run >> ${runs}\necho '${JSON.stringify(answer)}'\n`);
  chmodSync(join(root, 'bin', `loom-${name}`), 0o755);
  writeFileSync(join(root, name, 'piece.json'), JSON.stringify({
    v: 1, name, source: { repo: 'o/r', commit: '1'.repeat(40) }, package: name, version: '1.0.0', installed: '', bins: [`loom-${name}`],
    loom: { settings: [], services: [], sections: { project: { label: 'Changes', argv: [`loom-${name}`, 'project-feed', '--json'] } } },
  }));
}

const FEED = { groups: [
  { title: 'Waiting on you', waiting: true, items: [{ title: 'app#1 Ship it', status: 'Waiting on you', page: 'c/github/acme/app/1' }] },
  { title: 'Waiting on CI', items: [{ title: 'app#2 Later', status: 'CI running', href: 'https://example.com/2', when: '2026-11-05T11:00:00Z', who: ['Ada'] }] },
] };

describe('the Projects app', () => {
  let home: string;
  let handle: HttpServeHandle;
  let base: string;
  let runs: string;
  const saved: Record<string, string | undefined> = {};

  beforeEach(async () => {
    clearPieceCache();
    forgetProjectCounts();
    home = mkdtempSync(join(tmpdir(), 'loom-projects-'));
    for (const agent of ['art', 'mark']) {
      mkdirSync(join(home, 'agents', agent), { recursive: true });
      writeFileSync(join(home, 'agents', agent, 'IDENTITY.md'), `# ${agent}\n\nCreed.\n`);
    }
    writeFileSync(join(home, 'household.json'), JSON.stringify({ v: 1, agents: ['art', 'mark'], default: 'art', owner: 'jonathan' }));
    runs = join(home, 'runs');
    feedPiece(home, 'changes', FEED, runs);
    for (const k of ['PATH', 'LOOM_HOME', 'XDG_CONFIG_HOME']) saved[k] = process.env[k];
    process.env.PATH = ['/usr/bin', '/bin'].join(delimiter);
    process.env.LOOM_HOME = join(home, 'managed');
    process.env.XDG_CONFIG_HOME = join(home, 'xdg');
    write(join(home, 'agents', 'art'), { slug: 'app', name: 'The App', goal: 'Ship it', links: { repos: ['acme/app'] } });
    write(join(home, 'agents', 'art'), { slug: 'quiet', name: 'Quiet one' });
    write(join(home, 'agents', 'art'), { slug: 'old', name: 'Old thing', status: 'done' });
    write(join(home, 'agents', 'mark'), { slug: 'app', name: 'Mark\'s App' });
    handle = await startHttpServer({ contextDir: join(home, 'agents', 'art'), host: '127.0.0.1', port: 0, household: loadHousehold(home)!, token: TOKEN });
    base = `http://127.0.0.1:${handle.port}`;
  });
  afterEach(async () => {
    await handle.close();
    closeAllBackends();
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    rmSync(home, { recursive: true, force: true });
  });

  async function login(): Promise<string> {
    const res = await fetch(`${base}/login`, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: `token=${TOKEN}`, redirect: 'manual' });
    return (res.headers.get('set-cookie') ?? '').split(';')[0];
  }
  const view = async (path: string, cookie: string) => {
    const r = await fetch(`${base}${path}`, { headers: { cookie, accept: 'application/json' }, redirect: 'manual' });
    return { status: r.status, body: await r.json() as any };
  };
  const runCount = () => { try { return readFileSync(runs, 'utf-8').split('\n').filter(Boolean).length; } catch { return 0; } };

  it('19. a tile in Places, after People', async () => {
    const owner = await login();
    const core = (await view('/places', owner)).body.chrome.shell.core.map((p: { label: string }) => p.label);
    expect(core.slice(core.indexOf('People'), core.indexOf('People') + 2)).toEqual(['People', 'Projects']);
  });

  it('20. the index: waiting first, every agent\'s, paused and done folded, feeds counted once a minute', async () => {
    const owner = await login();
    const { status, body } = await view('/projects', owner);
    expect(status).toBe(200);
    const page = body.page;
    const active = page.sections.find((s: { id: string }) => s.id === 'active').blocks[0].items;
    expect(active[0]).toMatchObject({ text: 'The App', page: 'projects/art/app', agent: 'art', tone: 'warn' });
    expect(active[0].meta).toContain('1 waiting on you');
    expect(active.map((i: { text: string }) => i.text)).toContain("Mark's App");
    const quiet = page.sections.find((s: { id: string }) => s.id === 'quiet');
    expect(quiet.fold).toBe('closed');
    expect(quiet.blocks[0].items.map((i: { text: string }) => i.text)).toEqual(['Old thing']);
    const first = runCount();
    expect(first).toBe(3);   // one feed run per active project
    await view('/projects', owner);
    expect(runCount()).toBe(first);   // within 60 s: from the cache
  });

  it('21. the hub: sections in order, waiting items once, feeds run fresh every load', async () => {
    const owner = await login();
    await view('/projects', owner);
    const before = runCount();
    const { body } = await view('/projects/art/app', owner);
    expect(runCount()).toBe(before + 1);
    await view('/projects/art/app', owner);
    expect(runCount()).toBe(before + 2);
    const page = body.page;
    expect(page.title).toBe('The App');
    expect(page.sections.map((s: { id: string }) => s.id)).toEqual(['card', 'waiting', 'piece-changes']);
    expect(page.sections[1].blocks[0].items).toEqual([expect.objectContaining({ text: 'app#1 Ship it', page: 'p/changes/c/github/acme/app/1' })]);
    const changes = page.sections[2].blocks;
    expect(JSON.stringify(changes)).not.toContain('Ship it');
    expect(changes[1].items[0]).toMatchObject({ text: 'app#2 Later', href: 'https://example.com/2', badge: 'CI running' });
    expect(changes[1].items[0].meta).toContain('Ada');
    // The page's links resolve: a piece page under /p/, loom's own as loom's.
    expect(body.ctx.source.base).not.toMatch(/^\/p\//);
  });

  it('22. /projects/<agent>/<slug>, and /projects/<slug> only when one agent has it', async () => {
    const owner = await login();
    expect((await view('/projects/mark/app', owner)).body.page.title).toBe("Mark's App");
    expect((await view('/projects/quiet', owner)).body.page.title).toBe('Quiet one');
    expect((await view('/projects/app', owner)).status).toBe(404);     // art's and mark's
    expect((await view('/projects/nope', owner)).status).toBe(404);
    expect((await view('/projects/art/nope', owner)).status).toBe(404);
  });
});

describe('the Projects pages, directly', () => {
  let dir: string;
  beforeEach(() => {
    forgetProjectCounts();
    dir = mkdtempSync(join(tmpdir(), 'loom-projects-unit-'));
  });
  afterEach(() => {
    closeAllBackends();
    rmSync(dir, { recursive: true, force: true });
  });

  const hubWith = (sections: unknown[], calls: { n: number }) => async (_d: string, slug: string): Promise<ProjectHubResult> => {
    calls.n++;
    const s = openProjectsStore(dir, { readonly: true })!;
    try {
      const r = s.read(slug, false) as { found: boolean; card?: any };
      return r.found ? { found: true, archived: false, card: r.card, rendered: '', updated: '', synthesized_at: null, since: '', activity: '', sections: sections as never } : { found: false };
    } finally { s.close(); }
  };

  it('a slow feed is "couldn\'t count" and sorts with the errors, not a slow page', async () => {
    write(dir, { slug: 'slow', name: 'Slow' });
    write(dir, { slug: 'fast', name: 'Fast' });
    const slowHub = async (d: string, slug: string) => (slug === 'slow' ? new Promise<ProjectHubResult>(() => {}) : hubWith([], { n: 0 })(d, slug));
    const t0 = Date.now();
    const page = await projectsIndex([{ dir }], { hub: slowHub, waitMs: 200, nowMs: NOW });
    expect(Date.now() - t0).toBeLessThan(2000);
    const items = page.sections.find((s) => s.id === 'active')!.blocks[0] as any;
    expect(items.items.map((i: any) => [i.text, i.meta.includes("couldn't count")])).toEqual([['Slow', true], ['Fast', false]]);
  });

  it('counts open needs_owner asks with waiting items; a failed feed is its line on the hub', async () => {
    write(dir, { slug: 'p', name: 'P', goal: 'G', where: { now: { value: 'soaking', verified_at: '2026-11-04T12:00:00Z' } } });
    const sections = [
      { key: 'conversations', items: [{ id: 'cv-000000000001', venue: 'Slack', label: 'pond chat', people: [], last: '2026-11-05T10:00:00Z', summary: 'talked', needs_owner: 'Pick a date', new: true }] },
      { key: 'piece:changes', label: 'Changes', groups: [{ title: 'Waiting on you', waiting: true, items: [{ title: 'a' }, { title: 'b' }] }] },
      { key: 'piece:tasks', error: 'timed out' },
    ];
    const calls = { n: 0 };
    const page = await projectsIndex([{ dir }], { hub: hubWith(sections, calls), nowMs: NOW });
    expect((page.sections.find((s) => s.id === 'active')!.blocks[0] as any).items[0].meta).toContain('3 waiting on you');
    const hub = (await projectHubPage({ dir }, 'p', { hub: hubWith(sections, calls), nowMs: NOW }))!;
    expect(hub.sections.map((s) => s.id)).toEqual(['card', 'waiting', 'piece-changes', 'piece-tasks', 'conversations']);
    expect((hub.sections[0].blocks[0] as any).items).toEqual([{ label: 'Goal', value: 'G' }, { label: 'now', value: 'soaking (checked)' }]);
    expect((hub.sections[1].blocks[0] as any).items.map((i: any) => i.text)).toEqual(['a', 'b', 'Pick a date']);
    expect((hub.sections[3].blocks[0] as any).text).toBe("tasks couldn't answer: timed out");
    expect(await projectHubPage({ dir }, 'missing', { hub: hubWith([], calls) })).toBeNull();
  });

  it('a feed item\'s link is drawn only when it is one: loom\'s pages by CORE_PAGES, a piece\'s by validPath', () => {
    expect(feedLink('changes', { page: 'c/github/acme/app/1' })).toEqual({ page: 'p/changes/c/github/acme/app/1' });
    expect(feedLink('changes', { page: 'c/x?tab=ci' })).toEqual({ page: 'p/changes/c/x?tab=ci' });
    expect(feedLink('tasks', { page: 'loom:p/tasks/task/t-1' })).toEqual({ page: 'loom:p/tasks/task/t-1' });
    expect(feedLink('tasks', { page: 'loom:people/ada' })).toEqual({ page: 'loom:people/ada' });
    for (const bad of ['loom://evil.com', 'loom:/x', 'loom:../x', '//host/x', 'a/../b', '../x', 'loom:act/approvals', 'loom:login', 'agent:art/x', 'A/B']) {
      expect(feedLink('changes', { page: bad }), bad).toEqual({});
    }
    expect(feedLink('changes', { href: 'https://github.com/a/b/pull/1' })).toEqual({ href: 'https://github.com/a/b/pull/1' });
    expect(feedLink('changes', { href: 'javascript:alert(1)' })).toEqual({});
    expect(feedLink('changes', { href: 'http://x' })).toEqual({});
  });

  it('with no projects, one line says what a project is', async () => {
    const page = await projectsIndex([{ dir }], { hub: hubWith([], { n: 0 }) });
    expect((page.sections[0].blocks[0] as any).text).toMatch(/^No projects yet/);
  });
});
