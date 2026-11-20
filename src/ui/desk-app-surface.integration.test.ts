/**
 * Every app in a tile is one surface, its scrollbar on the tile's right edge (t-1960; Jonathan, 2026-11-07: "Inbox and
 * Knowledge feel like one thing: the app is the window"; Knowledge's scrollbar sat a gutter in from the edge). For every
 * app a test household has, one tile at 1440×900:
 *
 * - the main scroller's right edge is the tile body's right edge (within 1 px): the rightmost box that scrolls, the
 *   body itself or a pane that fills it, has nothing (no padding, no margin, no reserved gutter) outside it;
 * - nothing between the tile's body and the app's root carries a border, a background, a ring or a shadow of its own,
 *   nor stands inset from the body: the app fills it;
 * - and no page-wide box inside the app does either (a section is a band divided by a line, not a card): the boxes a
 *   page has that are as wide as most of the tile, past its controls (a field, a button, a row that's picked).
 *
 * Runs where the app is built (npm run build) and a Chrome is installed (GitHub's runners have one).
 */
import { describe, it, expect as vexpect, beforeAll, afterAll, vi } from 'vitest';

vi.setConfig({ testTimeout: 120_000 });
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import BetterSqlite3 from 'better-sqlite3';
import { chromium, type Browser, type Page } from 'playwright-core';
import { startHttpServer, type HttpServeHandle } from '../transport/http-server.js';
import { agentDir, createToken, loadHousehold, type Household } from '../household.js';
import { createConversationTables, recordTurn, writeDigest } from '../backends/conversations.js';
import { closeAllBackends } from '../backends/index.js';
import { adapterCall, openThread } from '../comms.js';
import { remember } from '../tools/remember.js';
import { knowledgeWrite } from '../tools/knowledge-write.js';
import { clearPieceCache } from './pieces.js';
import { stopCommsWatch } from './comms-live.js';

const root = new URL('../../', import.meta.url).pathname;
const chrome = [process.env.LOOM_TEST_CHROME, '/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser'].find((p) => p && existsSync(p));
const built = existsSync(`${root}dist/web/index.html`);
const expect = Object.assign(((v: unknown, m?: string) => vexpect(v, m)) as typeof vexpect, vexpect,
  { poll: (f: () => unknown, o?: { timeout?: number }) => vexpect.poll(f, { timeout: 15_000, ...o }) }) as typeof vexpect;

const rows = (n: number, f: (i: number) => object) => Array.from({ length: n }, (_, i) => f(i));
/** A piece's page with each kind of section a piece writes: a long panel, a list, a folded one, a side column with a chart
 * (in a tile beside the agents' rail it folds over the page, the chart as a line). */
const PAGE = { title: 'Lots', sections: [
  { id: 'panel', title: 'A long panel', blocks: [{ type: 'panel', rows: rows(14, (i) => ({ label: `Row ${i + 1}`, value: `value ${i}` })) }] },
  { id: 'list', title: 'A long list', blocks: [{ type: 'list', items: rows(20, (i) => ({ text: `Item ${i + 1}`, meta: 'an item' })) }] },
  { id: 'fold', title: 'A folded one', fold: 'open', blocks: [{ type: 'text', text: 'What it holds.' }] },
  { id: 'side', title: 'On the side', place: 'side', blocks: [{ type: 'list', items: rows(4, (i) => ({ text: `Side ${i + 1}` })) }] },
  { id: 'weeks', title: 'Opened and done', place: 'side', blocks: [{ type: 'chart', kind: 'bar', caption: 'Opened and done, by week',
    series: [{ key: 'opened', label: 'Opened', color: 'pink' }, { key: 'done', label: 'Done', color: 'olive' }],
    data: [{ label: 'Oct 20', opened: 4, done: 2 }, { label: 'Oct 27', opened: 3, done: 5 }, { label: 'This week', opened: 6, done: 4 }] }] },
] };

/** What's wrong with a tile's surface, measured in the page: `[]` when its app is one surface, flush to the edge. */
function surface(): string[] {
  const bad: string[] = [];
  const body = document.querySelector<HTMLElement>('.loom-tile__body')!;
  const page = body.querySelector<HTMLElement>(':scope > .loom-tile__page')!;
  const B = body.getBoundingClientRect();
  const name = (e: Element) => `${e.tagName.toLowerCase()}${[...e.classList].filter((c) => !c.includes('[')).slice(0, 2).map((c) => `.${c}`).join('')}`;
  // A box that scrolls up and down (overflow-x: hidden alone computes overflow-y to auto: a clip, not a scroller).
  const scrolls = (e: Element) => { const s = getComputedStyle(e); return /(auto|scroll)/.test(s.overflowY) && !(s.overflowX === 'hidden' && s.overflowY === 'auto'); };
  // 1. The scrollers. A body whose page is longer than it is scrolls it: its scrollbar is the body's own, on the edge. One
  // that isn't hands the scrolling to the panes that fill it (a split app's list and reader, Comms' threads and chat):
  // then the body keeps no gutter for a scrollbar it never shows (Knowledge's reader sat 15 px in: t-1960), and nothing
  // pads or spaces a pane from the edge it ends at, so each pane's scrollbar is at its own right edge.
  const panes = [...body.querySelectorAll<HTMLElement>('*')].filter((e) => scrolls(e) && e.getBoundingClientRect().height >= B.height * 0.3);
  if (body.scrollHeight <= body.clientHeight + 1 && panes.length) {
    const gutter = body.offsetWidth - body.clientWidth;
    if (gutter > 1) bad.push(`the body keeps a ${gutter} px gutter while its panes scroll`);
    for (const pane of panes) {
      const px = (e: Element, k: string) => parseFloat(getComputedStyle(e).getPropertyValue(k)) || 0;
      if (px(pane, 'margin-right') > 1) bad.push(`its pane ${name(pane)} has a ${px(pane, 'margin-right')} px margin on its right`);
      for (let a = pane.parentElement; a && a !== body; a = a.parentElement) {
        // only where the pane ends at its box's right edge: a pane in a left column isn't held to its box's right
        if (Math.abs(a.getBoundingClientRect().right - px(a, 'padding-right') - px(a, 'border-right-width') - pane.getBoundingClientRect().right) > 1) continue;
        if (px(a, 'padding-right') + px(a, 'border-right-width') > 1) bad.push(`its pane ${name(pane)} is ${px(a, 'padding-right') + px(a, 'border-right-width')} px in from ${name(a)}'s right edge`);
      }
    }
    const right = Math.max(...panes.map((e) => e.getBoundingClientRect().right));
    const app = page.firstElementChild?.getBoundingClientRect();
    if (app && Math.abs(Math.max(right, app.right) - B.right) > 1) bad.push(`the app ends ${Math.round(B.right - Math.max(right, app.right))} px in from the body's right edge`);
  }
  const cs = (e: Element) => getComputedStyle(e);
  const ring = (s: CSSStyleDeclaration) => s.boxShadow !== 'none' && s.boxShadow.split(/,(?![^(]*\))/).some((part) => {
    // A ring (no offset, a spread) or a shadow cast outside; a bar down one edge (an inset with an offset) is a mark, not a box.
    const n = (part.match(/-?[\d.]+px/g) ?? []).map(parseFloat);
    const [x = 0, y = 0, blur = 0, spread = 0] = n;
    const inset = part.includes('inset');
    return (x === 0 && y === 0 && (spread > 0 || (!inset && blur > 0)) && !/rgba\(0, 0, 0, 0\)|transparent/.test(part)) || (!inset && blur > 0 && !/rgba\(0, 0, 0, 0\)/.test(part));
  });
  const boxed = (e: Element) => {
    const s = cs(e);
    const bg = (s.backgroundColor !== 'rgba(0, 0, 0, 0)' && s.backgroundColor !== 'transparent') || s.backgroundImage !== 'none';
    const sides = ['Top', 'Right', 'Bottom', 'Left'].filter((k) => parseFloat(s.getPropertyValue(`border-${k.toLowerCase()}-width`)) > 0 && s.getPropertyValue(`border-${k.toLowerCase()}-style`) !== 'none');
    const what = [bg && `a background (${s.backgroundColor})`, sides.length >= 3 && 'a border', ring(s) && 'a ring or a shadow'].filter(Boolean);
    return what.join(', ');
  };
  // 2. Between the body and the app's root (the page, the app's own root): nothing boxed, nothing inset.
  const app = page.firstElementChild;
  for (const e of [page, ...(app ? [app] : [])]) {
    const r = e.getBoundingClientRect(); const w = boxed(e);
    if (w) bad.push(`${name(e)} has ${w}`);
    if (r.left - B.left > 1 || B.right - (body.offsetWidth - body.clientWidth) - r.right > 1 || r.top - B.top > 1) bad.push(`${name(e)} is inset from the body (${Math.round(r.left - B.left)}/${Math.round(r.top - B.top)} px)`);
  }
  // 3. No page-wide box in the app: a card, a framed page, a box of rows in a section.
  const control = 'button, a, label, input, textarea, select, [role="option"], [role="dialog"], [aria-current="true"], [aria-selected="true"], [data-selected]';
  for (const e of page.querySelectorAll('*')) {
    const r = e.getBoundingClientRect();
    if (r.width < B.width * 0.6 || r.height < 36 || e.closest(control)) continue;
    // a field (a box around an input: its ring is the field's)
    if (r.height < 160 && e.querySelector(':scope > :is(input, textarea), :scope > * > :is(input, textarea)')) continue;
    const w = boxed(e);
    if (w) bad.push(`${name(e)} (${Math.round(r.width)}×${Math.round(r.height)}) has ${w}`);
    if (bad.length > 8) break;
  }
  return bad;
}

describe.runIf(built && chrome)('an app in a tile is one surface, its scrollbar on the edge', () => {
  let h: Household;
  let handle: HttpServeHandle;
  let browser: Browser;
  let base: string;
  let token: string;
  let thread = '';
  const saved: Record<string, string | undefined> = {};
  const errors: string[] = [];

  beforeAll(async () => {
    clearPieceCache();
    const home = mkdtempSync(join(tmpdir(), 'loom-app-surface-'));
    for (const a of ['art', 'mark']) {
      mkdirSync(join(home, 'agents', a), { recursive: true });
      writeFileSync(join(home, 'agents', a, 'IDENTITY.md'), `# ${a}\n`);
      const db = new BetterSqlite3(join(home, 'agents', a, 'memories.db')); createConversationTables(db); db.close();
    }
    writeFileSync(join(home, 'household.json'), JSON.stringify({ v: 1, agents: ['art', 'mark'], default: 'art', owner: 'jonathan',
      members: [{ person: 'jonathan', role: 'owner', agents: '*' }] }));
    mkdirSync(join(home, 'path'));
    writeFileSync(join(home, 'page.json'), JSON.stringify(PAGE));
    writeFileSync(join(home, 'path', 'loom-lots'), `#!/bin/sh\ncase "$1 $2" in\n  "ui --json") echo '${JSON.stringify({ v: 2, tab: { label: 'Lots' }, asks: [] })}' ;;\n  "ui page") cat "${join(home, 'page.json')}" ;;\n  *) exit 1 ;;\nesac\n`);
    chmodSync(join(home, 'path', 'loom-lots'), 0o755);
    for (const k of ['LOOM_HOME', 'XDG_CONFIG_HOME', 'PATH']) saved[k] = process.env[k];
    process.env.PATH = `${join(home, 'path')}${delimiter}${process.env.PATH}`;
    process.env.LOOM_HOME = home;
    process.env.XDG_CONFIG_HOME = join(home, 'xdg');
    h = loadHousehold(home)!;
    const art = agentDir(h, 'art');
    for (let i = 0; i < 20; i++) {
      await remember(art, { category: 'episode', title: `art finished step ${i} of the long list of things done today`, content: 'body', metadata: { where: 'terminal' } });
    }
    for (let i = 0; i < 14; i++) {
      await knowledgeWrite(art, { slug: `page-${i}`, title: `A page about thing ${i}`, domain: i % 2 ? 'ours/homelab' : 'music/norns',
        body: 'A body that runs on.\n\n'.repeat(40), citations: [{ claim: 'x', source_kind: 'docs', source_locator: 'https://example.com', excerpt: 'x' }] } as never, 'art');
    }
    // Asks: the Inbox's rows and the agent's Today.
    for (let n = 1; n <= 10; n++) {
      const text = `Should I rotate backup key ${n} tonight?`;
      const conv = recordTurn(art, 'art', { venue: 'wake', place: `lane:t${n}`, label: text, at: new Date().toISOString(), from: { kind: 'schedule' }, kind: 'wake' }, 'runtime:clock').conversation;
      writeDigest(art, { conversation: conv, run: `r${n}` }, { summary: 'Checked.', needs_owner: { ask: text, why: 'Because it matters.', if_yes: 'I do it tonight.', if_no: 'I leave it.' } } as never);
    }
    // A Comms thread long enough to scroll.
    const o = openThread(h, process.env, h.members[0], { agent: 'art', id: 'surfacesurfacezz', text: 'Can we go over the screens?' });
    thread = o.thread.id;
    for (let i = 0; i < 16; i++) adapterCall(h, process.env, { op: 'post', place: thread, agent: 'art', text: `Line ${i + 1} of a long answer, long enough to wrap and to scroll the thread.`, run: 'run-1' });
    token = createToken(h, { role: { kind: 'owner', member: 'jonathan' }, label: 'jonathan' }).token;
    handle = await startHttpServer({ contextDir: art, host: '127.0.0.1', port: 0, household: h });
    base = `http://127.0.0.1:${handle.port}`;
    browser = await chromium.launch({ executablePath: chrome, args: ['--no-sandbox'] });
  }, 120_000);
  afterAll(async () => {
    await browser?.close();
    stopCommsWatch();
    await handle?.close();
    await closeAllBackends();
    for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
    if (h) rmSync(h.home, { recursive: true, force: true });
    clearPieceCache();
  });

  async function open(path: string, look: string): Promise<Page> {
    const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, reducedMotion: 'reduce', serviceWorkers: 'block' });
    await ctx.addInitScript(`localStorage.setItem('loom-look', '${look}'); sessionStorage.setItem('loom-arrived', '1'); sessionStorage.setItem('loom-booted', '1');`);
    await ctx.request.post(`${base}/login`, { form: { token }, maxRedirects: 0 });
    const p = await ctx.newPage();
    p.on('pageerror', (e) => errors.push(`${path}: ${e.message}`));
    await p.goto(`${base}${path}`);
    await p.locator('.loom-tile').first().waitFor();
    await expect.poll(() => p.locator('.loom-tile .loom-tile__page:not([aria-busy])').count()).toBe(1);
    // the app itself, past its chunk's spinner
    await expect.poll(() => p.locator('.loom-tile__page [data-slot="spinner"][data-size="lg"], .loom-tile__page .loom-skel-wait').count()).toBe(0);
    await p.evaluate(() => document.fonts.ready);
    await p.waitForTimeout(400);
    return p;
  }

  /** Every app the household has, by its address: [label, path, the tile's name]. */
  const APPS = (): Array<[string, string, string]> => [
    ['Inbox', '/inbox', 'inbox'], ['Activity', '/activity', 'activity'], ['Knowledge', '/knowledge', 'knowledge'],
    ['Knowledge, a page open', '/knowledge/page-3', 'knowledge'], ['People', '/people', 'people'], ['Projects', '/projects', 'projects'],
    ['Comms', '/comms', 'comms'], ['Comms, a thread open', `/comms/${thread}`, 'comms'], ['Art’s window', '/a/art', 'art'],
    ['Members', '/members', 'members'], ['Pieces', '/pieces', 'pieces'], ['Appearance', '/appearance', 'appearance'],
    ['Accessibility', '/accessibility', 'accessibility'], ['Profile', '/account', 'account'], ['Find', '/find', 'find'],
    ['A piece’s page', '/p/lots', 'lots'],
  ];

  it('every app, one tile at 1440 in Neon Noir: flush scrollbar, one surface', async () => {
    const found: Record<string, string[]> = {};
    for (const [label, path, name] of APPS()) {
      const p = await open(`${path}?t=*${name}`, 'neon');
      const bad = await p.evaluate(surface);
      if (bad.length) found[label] = bad;
      await p.context().close();
    }
    expect(found).toEqual({});
  });

  it('the same in Low Light and Daylight (a page of sections, a split app, an agent)', async () => {
    const found: Record<string, string[]> = {};
    for (const look of ['lowlight', 'daylight']) {
      for (const [label, path, name] of APPS().filter(([, , n]) => ['lots', 'knowledge', 'art', 'activity'].includes(n))) {
        const p = await open(`${path}?t=*${name}`, look);
        const bad = await p.evaluate(surface);
        if (bad.length) found[`${label} (${look})`] = bad;
        await p.context().close();
      }
    }
    expect(found).toEqual({});
  });

  it('no page threw', () => { expect(errors).toEqual([]); });
});
