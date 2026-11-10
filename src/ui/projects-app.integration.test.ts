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
import { feedLink, forgetProjectCounts, INDEX_WAIT_MS, projectHubPage, projectsApp, projectsIndex, whatOf } from './projects-pages.js';
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
    // Drawn on loom's own page (its links are loom's: p/changes/… is the piece's page, through /p/).
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
    expect((hub.sections[0].blocks[0] as any).items).toEqual([{ label: 'Goal', value: 'G' }, { label: 'now', value: 'soaking (checked 24h ago)' }]);
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

  it('orders waiting first, then errors and couldn\'t count, then activity; waits 5 s by default', async () => {
    expect(INDEX_WAIT_MS).toBe(5000);
    write(dir, { slug: 'newest', name: 'Newest' });                     // newest activity, nothing waiting
    write(dir, { slug: 'broken', name: 'Broken' });
    write(dir, { slug: 'waits', name: 'Waits' });
    const s = openProjectsStore(dir, { now: () => NOW + 60_000 })!;
    try { s.write({ slug: 'newest', summary: 'touched later' }); } finally { s.close(); }
    const per: Record<string, unknown[]> = {
      newest: [],
      broken: [{ key: 'conversations', error: 'unreadable' }],
      waits: [{ key: 'piece:changes', label: 'Changes', groups: [{ title: 'Waiting on you', waiting: true, items: [{ title: 'x' }] }] }],
    };
    const hub = async (d: string, slug: string) => hubWith(per[slug], { n: 0 })(d, slug);
    const page = await projectsIndex([{ dir }], { hub, nowMs: NOW + 120_000 });
    const items = (page.sections.find((x) => x.id === 'active')!.blocks[0] as any).items;
    expect(items.map((i: any) => i.text)).toEqual(['Waits', 'Broken', 'Newest']);
    expect(items[1].meta).toContain("couldn't count");
  });

  it('a feed item\'s body shows under its row; a loom: link stays loom\'s; sections beyond ten are named, not lost', async () => {
    write(dir, { slug: 'p', name: 'P', goal: 'G' });
    const pieces = Array.from({ length: 12 }, (_, i) => ({ key: `piece:p${String(i).padStart(2, '0')}`, label: `P${i}`,
      groups: [{ title: 'Things', items: [{ title: `t${i}`, body: 'the detail', page: 'loom:p/tasks/task/t-1' }] }] }));
    const hub = (await projectHubPage({ dir }, 'p', { hub: hubWith(pieces, { n: 0 }), nowMs: NOW }))!;
    expect(hub.sections.length).toBe(10);
    const first = hub.sections[1].blocks[1] as any;
    expect(first.items[0]).toMatchObject({ text: 't0', page: 'loom:p/tasks/task/t-1' });
    expect(first.items[0].meta).toContain('the detail');
    expect(JSON.stringify(hub.sections[9])).toContain('More sections than fit here: P9, P10, P11.');
  });

  it('the cards: a slow project says it couldn\'t count, a quiet one has no waiting row, the Changes piece is counted, the sparkline counts dated items', async () => {
    write(dir, { slug: 'slow', name: 'Slow' });
    write(dir, { slug: 'busy', name: 'Busy', summary: 'First line. Second line.', links: { repos: ['github:acme/busy'] } });
    write(dir, { slug: 'old', name: 'Old', status: 'paused' });
    const sections = [{ key: 'piece:changes', label: 'Changes', groups: [
      { title: 'Waiting on you', waiting: true, items: [{ title: 'busy#3 Yes?', status: 'Waiting on you', when: new Date(NOW - 3_600_000).toISOString() }] },
      { title: 'Waiting on CI', items: [{ title: 'busy#2', status: 'CI running', when: new Date(NOW - 2 * 86_400_000).toISOString() }] },
      { title: 'Lately', items: [{ title: 'busy#1', status: 'Merged', when: new Date(NOW - 20 * 86_400_000).toISOString() }] }] },
      // A piece after changes (sections come sorted by key): its items are never counted as changes.
      { key: 'piece:tasks', label: 'Tasks', groups: [{ title: 'Ready', items: [{ title: 't-1', status: 'CI red' }, { title: 't-2', who: ['Ada'] }] }] },
      { key: 'conversations', items: [{ id: 'cv-000000000001', venue: 'Slack', label: 'chat', people: ['Bo'], last: new Date(NOW - 7_200_000).toISOString(), summary: 'talked', needs_owner: 'Pick a date', new: true }] }];
    const hub = async (d: string, slug: string) => (slug === 'slow' ? new Promise<ProjectHubResult>(() => {}) : hubWith(sections, { n: 0 })(d, slug));
    const { cards } = await projectsApp([{ dir }], { hub, waitMs: 200, nowMs: NOW });
    const busy = cards!.active.find((c) => c.slug === 'busy')!;
    expect(busy).toMatchObject({ what: 'First line.', waiting: { count: 2, items: ['busy#3 Yes?', 'Pick a date'] }, repos: ['acme/busy'],
      changes: { open: 2, failing: 0, running: 1, line: '2 open · 1 checking' } });
    // What's waiting (a feed's waiting item, a conversation's ask) is said once, above: never again under Lately.
    expect(busy.lately.map((l) => l.text)).toEqual(['busy#2', 'busy#1']);
    expect(busy.spark!.days).toEqual([0, 0, 0, 0, 1, 0, 2]);                // two days ago, and today's two; within 7 days only
    expect(busy.people.map((p) => p.name)).toEqual(['Ada', 'Bo']);          // feed names before conversations'
    expect(cards!.active.find((c) => c.slug === 'slow')!.waiting).toEqual({ unknown: expect.stringMatching(/^Couldn't count/) });
    expect(cards!.quiet.map((c) => [c.slug, c.waiting])).toEqual([['old', undefined]]);
    expect(whatOf('A sentence with v1.2 in it. And more.')).toBe('A sentence with v1.2 in it.');
    expect(whatOf('A first sentence\nwrapped over two lines. Then more.')).toBe('A first sentence wrapped over two lines.');
    expect((await projectsApp([{ dir: join(dir, 'none') }])).cards).toEqual({ active: [], quiet: [], waiting: 0 });
  });

  it('cached feed details keep the directory stamp they were counted for after a card edit', async () => {
    write(dir, { slug: 'stamped', name: 'Before' });
    const calls = { n: 0 };
    const hub = hubWith([], calls);
    const first = await projectsApp([{ dir }], { hub, nowMs: NOW });
    const store = openProjectsStore(dir, { now: () => NOW + 1000 })!;
    try { store.write({ slug: 'stamped', name: 'After' }); } finally { store.close(); }
    const after = await projectsApp([{ dir }], { hub, nowMs: NOW + 2000 });
    expect(after.cards!.active[0].name).toBe('After');
    expect(after.cards!.active[0].directoryUpdated).toBe(first.cards!.active[0].directoryUpdated);
    expect(after.cards!.active[0].directoryUpdated).toBe(new Date(NOW).toISOString());
    expect(calls.n).toBe(1);
    forgetProjectCounts();
    const fresh = await projectsApp([{ dir }], { hub, nowMs: NOW + 3000 });
    expect(fresh.cards!.active[0].directoryUpdated).toBe(new Date(NOW + 1000).toISOString());
  });

  it('an archived project\'s page says so', async () => {
    write(dir, { slug: 'gone', name: 'Gone' });
    const s = openProjectsStore(dir, { now: () => NOW })!;
    try { s.archive({ slug: 'gone', reason: 'done with it', actor: 'art' }); } finally { s.close(); }
    const page = await projectHubPage({ dir }, 'gone', { hub: async () => ({ found: true, archived: true }) });
    expect(JSON.stringify(page)).toContain('This project is archived.');
  });

  it('with no projects, one line says what a project is', async () => {
    const page = await projectsIndex([{ dir }], { hub: hubWith([], { n: 0 }) });
    expect((page.sections[0].blocks[0] as any).text).toMatch(/^No projects yet/);
  });
});
