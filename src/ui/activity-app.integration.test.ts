/**
 * Activity (t-1972, Jonathan's approved design 2026-11-08): filters (Who, Where, What) | the timeline with its day strip |
 * the open entry's story, on split.tsx. Titles are a conversation's label, never a body's prompt; a Comms run shows its
 * steps to its own member only; nobody sees more than the household page already lets them. Real Chrome, at 1280, 1440,
 * 1920 and a phone, in all three looks.
 *
 * Runs where the app is built (npm run build), a Chrome is installed, and age is there (Comms seals its words with it).
 * LOOM_SHOTS=<dir> keeps a screenshot of each.
 */
import { describe, it, expect as vexpect, beforeAll, afterAll, vi } from 'vitest';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import BetterSqlite3 from 'better-sqlite3';
import { chromium, type Browser, type Page } from 'playwright-core';
import { startHttpServer, type HttpServeHandle } from '../transport/http-server.js';
import { agentDir, createToken, loadHousehold, type Household } from '../household.js';
import { createConversationTables, recordTurn, writeDigest } from '../backends/conversations.js';
import { adapterCall, openThread, postActivity, setTitle } from '../comms.js';
import { remember } from '../tools/remember.js';
import { closeAllBackends } from '../backends/index.js';
import { clearPieceCache } from './pieces.js';
import { stopCommsWatch } from './comms-live.js';

vi.setConfig({ testTimeout: 90_000 });
const root = new URL('../../', import.meta.url).pathname;
const chrome = [process.env.LOOM_TEST_CHROME, '/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser'].find((p) => p && existsSync(p));
const built = existsSync(`${root}dist/web/index.html`);
const hasAge = spawnSync('sh', ['-c', 'command -v age && command -v age-keygen'], { encoding: 'utf-8' }).status === 0;
const expect = Object.assign(((v: unknown, m?: string) => vexpect(v, m)) as typeof vexpect, vexpect,
  { poll: (f: () => unknown, o?: { timeout?: number }) => vexpect.poll(f, { timeout: 10_000, ...o }) }) as typeof vexpect;
const ago = (min: number) => new Date(Date.now() - min * 60_000).toISOString().replace(/\.\d{3}Z$/, 'Z');

describe.runIf(built && chrome && hasAge)('Activity: filters, a timeline and a reader', () => {
  let h: Household;
  let handle: HttpServeHandle;
  let browser: Browser;
  let base: string;
  const tokens: Record<string, string> = {};
  const saved: Record<string, string | undefined> = {};

  beforeAll(async () => {
    const home = mkdtempSync(join(tmpdir(), 'loom-activity-app-'));
    for (const [a, name] of [['art', 'Art E Fish'], ['mark', 'Visual Mark']]) {
      mkdirSync(join(home, 'agents', a), { recursive: true });
      writeFileSync(join(home, 'agents', a, 'IDENTITY.md'), `# ${name}\n\nCreed.\n`);
      const db = new BetterSqlite3(join(home, 'agents', a, 'memories.db')); createConversationTables(db); db.close();
    }
    writeFileSync(join(home, 'household.json'), JSON.stringify({ v: 1, agents: ['art', 'mark'], default: 'art', owner: 'jonathan', github: 'sleepunit-agents', members: [
      { person: 'jonathan', role: 'owner', agents: '*' }, { person: 'sam', role: 'owner', agents: ['art'] }, { person: 'loren', role: 'owner', agents: ['mark'] }] }));
    for (const k of ['LOOM_HOME', 'XDG_CONFIG_HOME']) saved[k] = process.env[k];
    process.env.LOOM_HOME = home;
    process.env.XDG_CONFIG_HOME = join(home, 'xdg');
    clearPieceCache();
    h = loadHousehold(home)!;
    for (const p of ['jonathan', 'sam', 'loren']) tokens[p] = createToken(h, { role: { kind: 'owner', member: p }, label: p }).token;
    const art = agentDir(h, 'art'), mark = agentDir(h, 'mark');

    // Jonathan's Comms thread with Art: a run with steps and a digest.
    const o = openThread(h, process.env, h.members[0], { agent: 'art', id: 'aaaaaaaaaaaaaaaa', text: 'Make the comm screen frame thinner.' });
    setTitle(h, o.thread, 'Comm screen polish', 'agent');
    adapterCall(h, process.env, { op: 'status', place: o.thread.id, agent: 'art', status: 'working' });
    postActivity(h, process.env, { conversation: o.thread.conversation, run: 'run-c1', cards: [
      { id: 's1', at: ago(9), tool: 'Read', summary: 'Read web/src/comms.css', state: 'done' },
      { id: 's2', at: ago(9), tool: 'Bash', summary: 'Ran the comms tests', state: 'done' },
      { id: 's3', at: ago(8), tool: 'Edit', summary: 'Edited web/src/comms.css', state: 'done' }] });
    adapterCall(h, process.env, { op: 'post', place: o.thread.id, agent: 'art', text: 'Done: the frame is thinner (loom#545).' });
    recordTurn(art, 'art', { venue: 'loom', place: o.thread.id, at: ago(10), from: { kind: 'person', slug: 'jonathan' }, kind: 'message' } as never, 'runtime:runtime');
    writeDigest(art, { conversation: o.thread.conversation, run: 'run-c1' }, { summary: 'Made the comm screen frame thinner and opened loom#545. Filed t-1881.', decisions: ['Kept the portrait where it is'], tasks: ['t-1881'] });

    // A wake run the runtime started (its digest), and the harness's fallback episode of it (the preamble as its title).
    const wake = recordTurn(art, 'art', { venue: 'wake', place: 'review', at: ago(30), from: { kind: 'schedule' }, kind: 'wake', label: 'Daily review' } as never, 'runtime:runtime');
    writeDigest(art, { conversation: wake.conversation, run: 'run-w1' }, { summary: 'Took one lesson from today\'s review. Filed t-1967.', tasks: ['t-1967'] });
    await remember(art, { category: 'episode', title: 'You are art, in a conversation on wake: Daily review. (bridge spawn tok…', metadata: { where: 'terminal:Art', source: 'fallback' },
      content: `Ask: You are art, in a conversation on wake: Daily review. (bridge spawn token ad8f1eae: ignore this line) Its conversation is ${wake.conversation} and this run is run-w1.\nLast said: done\n(fallback episode, auto-extracted; 1 turn)` });
    // Work that landed, the system's upkeep, a Slack DM with Jonathan, and Mark's lane.
    const pr = recordTurn(art, 'art', { venue: 'wake', place: 'wake:w-1', at: ago(120), from: { kind: 'schedule' }, kind: 'wake', label: 't-1960 one surface per app' } as never, 'runtime:runtime');
    writeDigest(art, { conversation: pr.conversation, run: 'run-p1' }, { summary: 'Merged loom#626 and deployed it. Closed t-1960.', tasks: ['t-1960'] });
    const alert = recordTurn(art, 'art', { venue: 'wake', place: 'alert:box-health', at: ago(200), from: { kind: 'schedule' }, kind: 'wake', label: 'alert box-health: wunder disk nearly full' } as never, 'runtime:runtime');
    writeDigest(art, { conversation: alert.conversation, run: 'run-a1' }, { summary: 'Pruned old snapshots; the disk is at 71%.' });
    const dm = recordTurn(art, 'art', { venue: 'slack', place: 'dm:U1', at: ago(60), from: { kind: 'person', slug: 'jonathan' }, kind: 'message', label: 'DM with Jonathan' } as never, 'runtime:runtime');
    writeDigest(art, { conversation: dm.conversation, run: 'run-s1' }, { summary: 'Jonathan asked for a Slack relay test; it landed.' });
    await remember(mark, { category: 'episode', title: 'Morning plan prepared', content: 'Read the tape and the reports.', metadata: { where: 'lane:planning' } });

    handle = await startHttpServer({ contextDir: art, host: '127.0.0.1', port: 0, household: h });
    base = `http://127.0.0.1:${handle.port}`;
    browser = await chromium.launch({ executablePath: chrome, args: ['--no-sandbox'] });
  }, 90_000);
  afterAll(async () => {
    await browser?.close();
    stopCommsWatch();
    await handle?.close();
    await closeAllBackends();
    for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
    if (h) rmSync(h.home, { recursive: true, force: true });
  });

  type Data = Record<string, any>;   // eslint-disable-line @typescript-eslint/no-explicit-any
  async function data(person: string, path: string): Promise<Data> {
    const ctx = await browser.newContext();
    await ctx.request.post(`${base}/login`, { form: { token: tokens[person] }, maxRedirects: 0 });
    const r = await ctx.request.get(`${base}${path}`, { headers: { accept: 'application/json', 'x-loom-fetch': '1' } });
    const out = await r.json() as Data;
    await ctx.close();
    return out;
  }

  it('each entry is titled plainly, says who, where and what, and a run is told once', async () => {
    const a = (await data('jonathan', '/activity')).activity;
    const by = (t: string) => (a.entries as Data[]).filter((e) => e.title === t);
    expect(JSON.stringify(a.entries)).not.toMatch(/You are art|bridge spawn/);
    expect(by('Daily review')).toHaveLength(1);
    expect(by('Comm screen polish')[0]).toMatchObject({ agent: 'art', venue: 'comms', where: 'Comms', what: 'conversation', owner: true });
    expect(by('t-1960 one surface per app')[0]).toMatchObject({ what: 'work', venue: 'wakes' });
    expect(by('Wunder disk nearly full')[0]).toMatchObject({ what: 'system', where: 'Alert' });
    expect(by('DM with Jonathan')[0]).toMatchObject({ venue: 'slack', owner: true });
    expect(by('Morning plan prepared')[0]).toMatchObject({ agent: 'mark', venue: 'wakes', where: 'Lane planning' });
    // The Comms run opens with its steps (the labels its thread shows), its tasks and pull request, and the way back to the thread.
    const id = by('Comm screen polish')[0].id;
    const o = (await data('jonathan', `/activity?e=${encodeURIComponent(id)}`)).activity.open;
    expect(o.steps.map((s: Data) => s.label)).toEqual(['Read web/src/comms.css', 'Ran the comms tests', 'Edited web/src/comms.css']);
    expect(o.tasks).toEqual([{ label: 't-1881', page: 'loom:p/tasks/task/t-1881' }]);
    expect(o.prs).toEqual([{ label: 'loom#545', href: 'https://github.com/sleepunit-agents/loom/pull/545' }]);
    expect(o.links).toContainEqual({ label: 'The thread in Comms', href: expect.stringMatching(/^\/comms\/[a-z2-7]{10}$/) });
  });

  it('nobody sees more than they did: a Comms thread is its member\'s, an agent owner sees their agents\' alone', async () => {
    // Sam owns Art too, but the Comms thread is Jonathan's: not its entry, not its steps, not by its id.
    const sam = (await data('sam', '/activity')).activity;
    const titles = (sam.entries as Data[]).map((e) => e.title);
    expect(titles).toEqual(expect.arrayContaining(['Daily review', 'DM with Jonathan']));
    expect(titles).not.toContain('Comm screen polish');
    expect(JSON.stringify(sam)).not.toMatch(/comm screen|comms\.css/i);
    const jid = ((await data('jonathan', '/activity')).activity.entries as Data[]).find((e) => e.title === 'Comm screen polish')!.id;
    const peek = (await data('sam', `/activity?e=${encodeURIComponent(jid)}`)).activity;
    expect(peek.open).toBeUndefined();
    expect(peek.missing).toBe(true);
    // Loren owns Mark alone: none of Art's.
    const loren = (await data('loren', '/activity')).activity;
    expect((loren.entries as Data[]).map((e) => e.agent)).toEqual(['mark']);
    expect((await data('loren', `/activity?e=${encodeURIComponent(jid)}`)).activity.missing).toBe(true);
  });

  const LOOKS = ['neon', 'lowlight', 'daylight'] as const;
  async function screen(width: number, height: number, path: string, look: string, phone = false): Promise<Page> {
    const ctx = await browser.newContext({ viewport: { width, height }, reducedMotion: 'reduce', serviceWorkers: 'block', ...(phone ? { hasTouch: true, isMobile: true, deviceScaleFactor: 2 } : {}) });
    await ctx.addInitScript(`if (!sessionStorage.getItem('t')) { sessionStorage.setItem('t', '1'); localStorage.setItem('loom-look', '${look}'); } sessionStorage.setItem('loom-arrived', '1'); sessionStorage.setItem('loom-booted', '1');`);
    await ctx.request.post(`${base}/login`, { form: { token: tokens.jonathan }, maxRedirects: 0 });
    const p = await ctx.newPage();
    await p.goto(`${base}${path}`);
    await p.locator('.loom-act').waitFor();
    await p.waitForTimeout(300);
    await p.evaluate(() => { (window as unknown as { kept: number }).kept = 1; });
    return p;
  }
  const shot = async (p: Page, name: string) => { if (process.env.LOOM_SHOTS) await p.screenshot({ path: join(process.env.LOOM_SHOTS, `${name}.png`) }); };
  const row = (p: Page, words: string) => p.locator('.loom-act [data-split-row]', { hasText: words });
  const reader = '.loom-split__reader';
  const noOverflow = (p: Page) => p.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);

  for (const look of LOOKS) {
    for (const [w, hgt] of [[1280, 800], [1440, 900], [1920, 1080]] as const) {
      it(`a desktop tile, ${look} at ${w}: filters, the day strip, the timeline and the reader; no status tiles`, async () => {
        const p = await screen(w, hgt, '/activity?t=*activity', look);
        await expect.poll(() => p.locator('.loom-act').getAttribute('data-mode')).toBe('three');
        expect(await p.locator('.loom-split__nav .loom-split__heading').allTextContents()).toEqual(['Who', 'Where', 'What']);
        // Alphabetical in each group, each with the day's count.
        const who = await p.locator('.loom-split__nav li').evaluateAll((lis) => {
          const out: string[] = []; let on = false;
          for (const li of lis) { if (li.classList.contains('loom-split__heading')) { on = li.textContent === 'Who'; continue; } if (on) out.push(li.querySelector('.loom-split__folder-name')!.textContent!); }
          return out;
        });
        expect(who).toEqual(['Art E Fish', 'Jonathan', 'Visual Mark']);
        expect(await p.locator('.loom-split__nav .loom-split__folder-name').allTextContents()).toEqual(expect.arrayContaining(['Comms', 'Slack', 'Wakes', 'Conversations', 'System', 'Work done']));
        expect(await p.locator('.loom-tile').count()).toBeGreaterThan(0);
        expect(await p.getByText('3 boxes').count()).toBe(0);
        expect(await p.locator('.loom-act__bars .loom-act__bar').count()).toBe(24);
        expect(await p.locator('.loom-act').textContent()).not.toMatch(/You are art/);
        await shot(p, `activity-${look}-${w}`);
        expect(await noOverflow(p)).toBeLessThanOrEqual(0);
        await p.context().close();
      });
    }
    it(`a phone, ${look}: a filter menu and the timeline; an entry opens over it`, async () => {
      const p = await screen(390, 844, '/activity', look, true);
      await expect.poll(() => p.locator('.loom-act').getAttribute('data-mode')).toBe('one');
      expect(await p.locator('.loom-split__nav').count()).toBe(0);
      await p.locator('.loom-act__menu > summary').click();
      await shot(p, `activity-${look}-phone-menu`);
      await p.locator('.loom-act__menu-panel button', { hasText: 'Work done' }).click();
      await expect.poll(() => p.evaluate(() => location.search)).toMatch(/what=work/);
      await expect.poll(() => p.locator('.loom-act [data-split-row]').count()).toBe(1);
      await p.locator('.loom-act__menu > summary').click();
      await row(p, 'one surface per app').click();
      await expect.poll(() => p.locator(`${reader} h2`).textContent()).toMatch(/One surface per app/i);
      expect(await p.locator('.loom-split__list').isVisible()).toBe(false);
      await shot(p, `activity-${look}-phone-open`);
      expect(await noOverflow(p)).toBeLessThanOrEqual(0);
      await p.locator('.loom-split__back').click();
      await expect.poll(() => p.locator(reader).count()).toBe(0);
      await p.context().close();
    });
  }

  it('filters combine and live in the address; an entry opens beside the list and its address keeps it', async () => {
    const p = await screen(1440, 900, '/activity?t=*activity', 'neon');
    await p.locator('.loom-split__folder', { hasText: 'Art E Fish' }).click();
    await p.locator('.loom-split__folder', { hasText: /^Slack/ }).click();
    await expect.poll(() => p.locator('.loom-act [data-split-row]').count()).toBe(1);
    expect(await p.locator('.loom-split__folder', { hasText: 'Art E Fish' }).getAttribute('aria-pressed')).toBe('true');
    // Within a group, any: Comms too.
    await p.locator('.loom-split__folder', { hasText: /^Comms/ }).click();
    await expect.poll(() => p.locator('.loom-act [data-split-row]').count()).toBe(2);
    await row(p, 'Comm screen polish').click();
    await expect.poll(() => p.locator(`${reader} h2`).textContent()).toBe('Comm screen polish');
    expect(await p.locator(`${reader} [aria-label="Steps"] li`).allTextContents()).toEqual(['Read web/src/comms.css', 'Ran the comms tests', 'Edited web/src/comms.css']);
    expect(await p.locator(`${reader} [aria-label="Tasks and pull requests"]`).textContent()).toMatch(/t-1881.*loom#545/);
    await shot(p, 'activity-neon-1440-open');
    // The address carries it all: a reload opens the same.
    const search = await p.evaluate(() => location.href);
    expect(decodeURIComponent(search)).toMatch(/activity.*who=art.*where=comms,slack.*e=d~art~dg-/);
    await p.reload();
    await p.locator('.loom-act').waitFor();
    await expect.poll(() => p.locator(`${reader} h2`).textContent()).toBe('Comm screen polish');
    expect(await p.locator('.loom-act [data-split-row]').count()).toBe(2);
    // Show everything again.
    await p.locator('.loom-split__folder', { hasText: 'All activity' }).click();
    await expect.poll(() => p.locator('.loom-act [data-split-row]').count()).toBeGreaterThan(4);
    await p.context().close();
  });

  it('the day strip: an hour with activity takes the list to it', async () => {
    const p = await screen(1440, 900, '/activity?t=*activity', 'neon');
    const lit = p.locator('.loom-act__bar:not([disabled])');
    expect(await lit.count()).toBeGreaterThan(0);
    const label = await lit.first().getAttribute('aria-label');
    expect(label).toMatch(/: \d+ entr(y|ies)$/);
    await lit.first().click();
    await expect.poll(() => p.evaluate(() => document.activeElement?.hasAttribute('data-split-row'))).toBe(true);
    await p.context().close();
  });
});
