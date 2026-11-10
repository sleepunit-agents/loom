import { requestTrace } from './request-trace.fixture.js';
import { beforeAll, afterAll, describe, it, expect } from 'vitest';
import { existsSync, mkdirSync } from 'node:fs';
import { chromium, type Browser } from 'playwright-core';
import { deskHome, type DeskHome } from './agent-desk.fixture.js';
import { clearPieceCache } from './pieces.js';
import type { Job } from './vocab.js';
const chrome = process.env.LOOM_TEST_CHROME ?? '/usr/bin/google-chrome';
const root = new URL('../../', import.meta.url).pathname;
const rows: Job[] = [
  { id: 'run-one', status: 'running', text: 'First active session', tasks: ['t-1'] },
  { id: 'run-two', status: 'running', text: 'Second active session' },
  { id: 'wait', status: 'waiting', text: 'Waiting for an answer' },
  { id: 'later', status: 'scheduled', text: 'Tomorrow follow-up', at: '2026-11-10T10:13:00Z' },
  { id: 't-1', status: 'backlog', text: 'Task already represented', tasks: ['t-1'] },
  ...Array.from({ length: 12 }, (_, n): Job => ({ id: `task-${n}`, status: 'backlog', text: `Backlog job ${n}` })),
];
describe.runIf(existsSync(chrome) && existsSync(`${root}dist/web/index.html`))('complete agent jobs', () => {
  let d: DeskHome, browser: Browser;
  beforeAll(async () => { d = await deskHome({ art: 'Art' }, [{ person: 'jonathan', agents: '*' }, { person: 'sam', agents: ['art'] }]); browser = await chromium.launch({ executablePath: chrome, args: ['--no-sandbox'] }); }, 60000);
  afterAll(async () => { await browser?.close(); await d?.close(); });
  it('filters another member’s thread and its task labels before returning cards', async () => {
    const thread = d.thread('sam', 'art', 'Secret subject', 'Secret title');
    d.report({ art: { jobs: [...rows, { id: 'private', status: 'running', conversation: thread.conversation, text: 'Secret task label' }] } }); clearPieceCache(); await d.changed();
    const card = async (person: string) => (await (await fetch(d.base + '/', { headers: { accept: 'application/json', authorization: `Bearer ${d.tok[person]}` } })).json()).home.cards[0];
    const jonathan = await card('jonathan'), sam = await card('sam');
    expect(JSON.stringify(jonathan)).not.toContain('Secret');
    const pieces = await (await fetch(d.base + '/pieces.json', { headers: { authorization: `Bearer ${d.tok.jonathan}` } })).text();
    expect(pieces).not.toContain('Secret task label');
    expect(sam.jobs.some((j: Job) => j.id === 'private')).toBe(true);
    expect(jonathan.jobs).toHaveLength(16);
    expect(jonathan.state).toBe('working');
  }, 30000);
  for (const width of [1600, 390]) it(`shows every job and removes completed work at ${width}`, async () => {
    const trace = requestTrace();
    trace.mark('publish jobs start');
    d.report({ art: { jobs: rows } }); clearPieceCache(); await d.changed();
    trace.mark('publish jobs complete');
    const ctx = await browser.newContext({ viewport: { width, height: 1000 }, reducedMotion: 'reduce' });
    await ctx.addInitScript(() => { sessionStorage.setItem('loom-booted', '1'); sessionStorage.setItem('loom-arrived', '1'); });
    // A decoration can remain in flight while the app is ready. Navigation must wait for
    // the DOM and the actual jobs heading, not the window's unrelated resource load.
    await ctx.route('**/__ci_slow_decoration.svg', () => {});
    await ctx.addInitScript(() => {
      window.addEventListener('DOMContentLoaded', () => {
        const image = document.createElement('img');
        image.hidden = true; image.src = '/__ci_slow_decoration.svg'; document.body.append(image);
      }, { once: true });
    });
    const p = await ctx.newPage(); p.setDefaultTimeout(5000); trace.page(p);
    try {
      trace.mark('sign-in start');
      await ctx.request.post(d.base + '/login', { form: { token: d.tok.jonathan }, maxRedirects: 0 }); trace.mark('sign-in complete'); await p.goto(d.base + '/', { waitUntil: 'domcontentloaded' });
      const card = p.locator('.loom-bigcard[data-agent="art"]');
      await card.getByRole('heading', { name: 'All jobs · 16' }).waitFor();
      expect(await card.locator('.loom-jobs li').count()).toBe(16);
      expect(await card.locator('[data-job-status="running"]').count()).toBe(2);
      expect(await card.locator('[data-job-status="waiting"]').count()).toBe(1);
      expect(await card.getByText('Task already represented').count()).toBe(0);
      expect(await p.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
      if (process.env.LOOM_JOB_SHOTS) { mkdirSync(process.env.LOOM_JOB_SHOTS, { recursive: true }); await p.screenshot({ path: `${process.env.LOOM_JOB_SHOTS}/jobs-${width}.png`, fullPage: true }); }
      d.report({ art: { jobs: rows.filter((j) => j.status !== 'running' && j.id !== 't-1') } }); clearPieceCache(); await d.changed();
      await p.reload({ waitUntil: 'domcontentloaded' }); await card.getByRole('heading', { name: 'All jobs · 14' }).waitFor();
      expect(await card.getByText('First active session').count()).toBe(0);
      if (width === 1600) {
        await p.goto(d.base + '/people', { waitUntil: 'domcontentloaded' });
        const compact = p.locator('.loom-rcard-wrap').filter({ has: p.locator('[data-agent="art"]') });
        await compact.locator('summary').click();
        expect(await compact.locator('.loom-jobs li').count()).toBe(14);
        await compact.getByText('Backlog job 11', { exact: true }).waitFor();
      }
    } finally { await ctx.close(); }
  }, 30000);
});
