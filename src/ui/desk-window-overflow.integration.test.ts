/**
 * A tile's page stays inside its frame (t-1925; Jonathan, 2026-11-06: "we need to double check that windows don't extend
 * past their chrome. activity right now the bottom of the body panel crosses over the bottom pink border"). For every
 * app a test household has, at a single big window (1280×800, 1920×1080), a short one (1280×600) and a narrow tile in
 * a three-tile layout: nothing in a tile's page, nor in a sheet opened in it, is drawn past the frame's inner edge
 * (what's scrolled away is clipped, so each box is measured as it's seen); the page scrolls inside its body, never the
 * frame and never the page. Home's agent cards, the agents' rail and the launcher are held to their own boxes the same way.
 *
 * What it holds, plainly: a tile's body clips what's in it, so a page's own boxes are measured as the body shows them;
 * what fails is the body (or the sheet layer) reaching past the ring, something that escapes the body's clip (a fixed
 * box, a sheet), or a frame or page that scrolls. Take the body's clip away and every app's own boxes are measured
 * against the ring too. The ring itself (drawn over the page, in the tint, the frame's width) has its own check.
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
import { createConversationTables } from '../backends/conversations.js';
import { closeAllBackends } from '../backends/index.js';
import { remember } from '../tools/remember.js';
import { knowledgeWrite } from '../tools/knowledge-write.js';
import { clearPieceCache } from './pieces.js';

const root = new URL('../../', import.meta.url).pathname;
const chrome = [process.env.LOOM_TEST_CHROME, '/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser'].find((p) => p && existsSync(p));
const built = existsSync(`${root}dist/web/index.html`);
const expect = Object.assign(((v: unknown, m?: string) => vexpect(v, m)) as typeof vexpect, vexpect,
  { poll: (f: () => unknown, o?: { timeout?: number }) => vexpect.poll(f, { timeout: 15_000, ...o }) }) as typeof vexpect;

/** Every app a test household has, by its address in the tiled desktop (`name` is its key's last part). A piece's page
 * is `lots`, a piece on PATH with a long panel and a long list. */
const APPS: Array<[label: string, path: string, name: string]> = [
  ['Inbox', '/inbox', 'inbox'], ['Activity', '/activity', 'activity'], ['Knowledge', '/knowledge', 'knowledge'],
  ['People', '/people', 'people'], ['Projects', '/projects', 'projects'], ['Comms', '/comms', 'comms'],
  ['Art’s window', '/a/art', 'art'], ['Members', '/members', 'members'], ['Pieces', '/pieces', 'pieces'],
  ['Appearance', '/appearance', 'appearance'], ['Accessibility', '/accessibility', 'accessibility'], ['A piece’s page', '/p/lots', 'lots'],
];
const rows = (n: number, f: (i: number) => object) => Array.from({ length: n }, (_, i) => f(i));
const PAGE = { title: 'Lots', sections: [
  { kind: 'panel', title: 'A long panel', rows: rows(14, (i) => ({ title: `Row ${i + 1} of a panel that is longer than any window is tall`, meta: `meta ${i}` })) },
  { kind: 'list', title: 'A long list', items: rows(30, (i) => ({ title: `Item ${i + 1}`, meta: 'an item' })) },
] };

/** What's drawn past its box, in the page: each element's box as it's seen (clipped by every scrolling or clipping box
 * it's in, up to the frame) against the frame's inner edge. `[]` when everything is inside. */
function outside([sel, inner, inset]: readonly [string, string, number]): string[] {
  const bad: string[] = [];
  const name = (e: Element) => `${e.tagName.toLowerCase()}${e.id ? `#${e.id}` : ''}${[...e.classList].slice(0, 2).map((c) => `.${c}`).join('')}`;
  for (const frame of document.querySelectorAll(sel)) {
    const f = frame.getBoundingClientRect();
    const box = { l: f.left + inset, t: f.top + inset, r: f.right - inset, b: f.bottom - inset };
    for (const root of inner ? frame.querySelectorAll(inner) : [frame]) {
      for (const e of [root, ...root.querySelectorAll('*')]) {
        const cs = getComputedStyle(e);
        if (cs.display === 'contents' || cs.visibility === 'hidden' || cs.clip === 'rect(0px, 0px, 0px, 0px)') continue;
        const r = e.getBoundingClientRect();
        let l = r.left, t = r.top, rr = r.right, b = r.bottom;
        const fixed = cs.position === 'fixed';
        // Clipped by each box between it and the frame that clips (its padding box): what's scrolled away isn't seen.
        for (let a = e.parentElement; a && a !== frame; a = a.parentElement) {
          if (fixed) break;
          const s = getComputedStyle(a);
          if (s.overflowX === 'visible' && s.overflowY === 'visible' && !/paint|strict|content/.test(s.contain)) continue;
          const q = a.getBoundingClientRect();
          const cl = q.left + parseFloat(s.borderLeftWidth), ct = q.top + parseFloat(s.borderTopWidth);
          const cr = q.right - parseFloat(s.borderRightWidth), cb = q.bottom - parseFloat(s.borderBottomWidth);
          if (s.overflowX !== 'visible') { l = Math.max(l, cl); rr = Math.min(rr, cr); }
          if (s.overflowY !== 'visible') { t = Math.max(t, ct); b = Math.min(b, cb); }
        }
        if (rr - l < 0.5 || b - t < 0.5) continue; // not seen at all
        const over = [box.l - l, t - box.t < 0 ? box.t - t : 0, rr - box.r, b - box.b].map((x) => Math.max(0, x));
        if (over.some((x) => x > 0.5)) {
          bad.push(`${frame.getAttribute('aria-label') ?? name(frame)}: ${name(e)} past its frame by ${over.map((x) => Math.round(x)).join('/')} px (left/top/right/bottom)`);
          if (bad.length > 8) return bad;
        }
      }
    }
  }
  return bad;
}

describe.runIf(built && chrome)('a tile\'s page stays inside its frame', () => {
  let h: Household;
  let handle: HttpServeHandle;
  let browser: Browser;
  let base: string;
  let token: string;
  const saved: Record<string, string | undefined> = {};
  const errors: string[] = [];

  beforeAll(async () => {
    clearPieceCache();
    const home = mkdtempSync(join(tmpdir(), 'loom-desk-overflow-'));
    for (const a of ['art', 'mark']) {
      mkdirSync(join(home, 'agents', a), { recursive: true });
      writeFileSync(join(home, 'agents', a, 'IDENTITY.md'), `# ${a}\n`);
      const db = new BetterSqlite3(join(home, 'agents', a, 'memories.db')); createConversationTables(db); db.close();
    }
    writeFileSync(join(home, 'household.json'), JSON.stringify({ v: 1, agents: ['art', 'mark'], default: 'art', owner: 'jonathan',
      members: [{ person: 'jonathan', role: 'owner', agents: '*' }] }));
    // A piece on PATH whose page is longer than any window.
    mkdirSync(join(home, 'path'));
    writeFileSync(join(home, 'page.json'), JSON.stringify(PAGE));
    writeFileSync(join(home, 'path', 'loom-lots'), `#!/bin/sh\ncase "$1 $2" in\n  "ui --json") echo '${JSON.stringify({ v: 2, tab: { label: 'Lots' }, asks: [] })}' ;;\n  "ui page") cat "${join(home, 'page.json')}" ;;\n  *) exit 1 ;;\nesac\n`);
    chmodSync(join(home, 'path', 'loom-lots'), 0o755);
    for (const k of ['LOOM_HOME', 'XDG_CONFIG_HOME', 'PATH']) saved[k] = process.env[k];
    process.env.PATH = `${join(home, 'path')}${delimiter}${process.env.PATH}`;
    process.env.LOOM_HOME = home;
    process.env.XDG_CONFIG_HOME = join(home, 'xdg');
    h = loadHousehold(home)!;
    // A day's activity (Activity's feed, the reported case: its panel ran over the frame's bottom edge) and some pages.
    for (const a of ['art', 'mark']) for (let i = 0; i < 20; i++) {
      await remember(agentDir(h, a), { category: 'episode', title: `${a} finished step ${i} of the long list of things done today`, content: 'body',
        metadata: { where: i % 2 ? 'terminal' : 'discord:#pond' } });
    }
    for (let i = 0; i < 12; i++) {
      await knowledgeWrite(agentDir(h, 'art'), { slug: `page-${i}`, title: `A page about thing ${i}`, domain: i % 2 ? 'ours/homelab' : 'music/norns',
        body: 'A body.\n\n'.repeat(12), citations: [{ claim: 'x', source_kind: 'docs', source_locator: 'https://example.com', excerpt: 'x' }] } as never, 'art');
    }
    token = createToken(h, { role: { kind: 'owner', member: 'jonathan' }, label: 'jonathan' }).token;
    handle = await startHttpServer({ contextDir: agentDir(h, 'art'), host: '127.0.0.1', port: 0, household: h });
    base = `http://127.0.0.1:${handle.port}`;
    browser = await chromium.launch({ executablePath: chrome, args: ['--no-sandbox'] });
  }, 120_000);
  afterAll(async () => {
    await browser?.close();
    await handle?.close();
    await closeAllBackends();
    for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
    if (h) rmSync(h.home, { recursive: true, force: true });
    clearPieceCache();
  });

  async function screen(width: number, height: number, path: string, look = 'neon'): Promise<Page> {
    const ctx = await browser.newContext({ viewport: { width, height }, reducedMotion: 'reduce', serviceWorkers: 'block' });
    await ctx.addInitScript(`localStorage.setItem('loom-look', '${look}'); sessionStorage.setItem('loom-arrived', '1'); sessionStorage.setItem('loom-booted', '1');`);
    await ctx.request.post(`${base}/login`, { form: { token }, maxRedirects: 0 });
    const p = await ctx.newPage();
    p.on('pageerror', (e) => errors.push(`${path}: ${e.message}`));
    await p.goto(`${base}${path}`);
    await p.locator('.loom-tiles').waitFor();
    return p;
  }
  /** Every tile's page drawn (not waiting), and a moment for late chunks and fonts. */
  const settled = async (p: Page, n?: number) => {
    if (n === undefined) { await p.locator('.loom-tile').first().waitFor(); await p.waitForTimeout(300); n = await p.locator('.loom-tile').count(); }
    await expect.poll(() => p.locator('.loom-tile .loom-tile__page:not([aria-busy])').count()).toBe(n);
    await p.evaluate(() => document.fonts.ready);
    await p.waitForTimeout(400);
  };
  /** The frame's ring, as the CSS says it (--frame): the inner edge is that far in. */
  const frames = async (p: Page) => {
    const inset = await p.locator('.loom-tile').first().evaluate((t) => parseFloat(getComputedStyle(t).getPropertyValue('--frame')));
    vexpect(inset).toBeGreaterThan(0);
    return p.evaluate(outside, ['.loom-tile', '.loom-tile__body, .loom-tile__layer', inset] as const) as unknown as Promise<string[]>;
  };
  /** Neither the page nor any frame scrolls; only a tile's body does. */
  const still = (p: Page) => p.evaluate(() => {
    const d = document.scrollingElement!;
    const bad = [d.scrollTop, d.scrollLeft].some((x) => x !== 0) || d.scrollHeight > innerHeight + 1 || d.scrollWidth > innerWidth + 1 ? ['the page scrolls'] : [];
    for (const t of document.querySelectorAll('.loom-tile')) if (t.scrollTop || t.scrollLeft) bad.push(`${t.getAttribute('aria-label')}: its frame scrolled`);
    return bad;
  });
  /** Each tile's body at its top, its middle and its bottom; and once a keyboard has gone to its last control (focus
   * scrolls even an overflow:hidden box into view). */
  async function audit(p: Page): Promise<string[]> {
    const out: string[] = [];
    for (const at of [0, 0.5, 1]) {
      await p.$$eval('.loom-tile__body', (bs, f) => bs.forEach((b) => { b.scrollTop = (b.scrollHeight - b.clientHeight) * f; }), at);
      await p.waitForTimeout(80);
      out.push(...(await frames(p)).map((s) => `scrolled ${at * 100}%: ${s}`), ...(await still(p)));
    }
    await p.$$eval('.loom-tile__body', (bs) => bs.forEach((b) => {
      const fs = b.querySelectorAll<HTMLElement>('a[href],button:not([disabled]),input,select,textarea,[tabindex="0"]');
      fs[fs.length - 1]?.focus();
    }));
    await p.waitForTimeout(80);
    out.push(...(await still(p)).map((s) => `focused last: ${s}`));
    return [...new Set(out)];
  }

  // ---- one big window, each app, at three sizes and in each look ----
  for (const [w, hgt] of [[1280, 800], [1920, 1080], [1280, 600]]) {
    for (const [label, path, name] of APPS) {
      it(`${label}, one window at ${w}×${hgt}: nothing past its frame, only its body scrolls`, async () => {
        const p = await screen(w, hgt, `${path}?t=*${name}`);
        await settled(p, 1);
        expect(await audit(p)).toEqual([]);
        await p.context().close();
      });
    }
  }

  it('the reported case in each look: Activity\'s feed stays inside the frame', async () => {
    for (const look of ['neon', 'lowlight', 'daylight']) {
      const p = await screen(1280, 800, '/activity?t=*activity', look);
      await settled(p, 1);
      expect(await audit(p), look).toEqual([]);
      // its frame's ring is drawn over its page and its sheets (an overlay above both), the frame's width, in the app's
      // tint while it's focused; a control inside keeps the look's own focus outline (--ring is the outline's, not the frame's)
      const ring = await p.locator('.loom-tile').evaluate((t) => {
        const tint = document.createElement('i'); tint.style.color = 'var(--t)'; t.appendChild(tint);
        const c = getComputedStyle(tint).color; tint.remove();
        const a = getComputedStyle(t, '::after');
        const ctl = t.querySelector('.loom-tile__body button, .loom-tile__body a[href]')!;
        return { z: Number(a.zIndex), shadow: a.boxShadow, tint: c, focused: t.hasAttribute('data-focused'), frame: getComputedStyle(t).getPropertyValue('--frame').trim(),
          outline: getComputedStyle(ctl).getPropertyValue('--ring').trim(), rootOutline: getComputedStyle(document.documentElement).getPropertyValue('--ring').trim() };
      });
      expect(ring.focused).toBe(true);
      expect(ring.z).toBeGreaterThan(20); // the tile's sheet layer is 20
      expect(ring.shadow).toContain(`${ring.tint} 0px 0px 0px ${ring.frame} inset`);
      expect(ring.outline).toBe(ring.rootOutline);
      await p.context().close();
    }
  });

  // ---- narrow tiles: each app beside two others and the agents' rail at 1280 ----
  for (const [label, path, name] of APPS) {
    const others = name === 'people' || name === 'knowledge' ? 'activity,pieces' : 'people,knowledge';
    it(`${label}, one of three tiles at 1280×800: the narrow tile keeps inside its frame`, async () => {
      const p = await screen(1280, 800, `${path}?t=*${name},${others}`);
      await settled(p, 3);
      const own = await p.locator('.loom-tile[data-focused]').evaluate((t) => t.getBoundingClientRect().width);
      expect(own).toBeLessThan(560);
      expect(await audit(p)).toEqual([]);
      await p.context().close();
    });
  }

  it('a sheet opened in a tile keeps inside its frame (a narrow one, a short screen)', async () => {
    const p = await screen(1280, 600, '/members?t=*members,people,knowledge');
    await settled(p);
    const t = p.locator('.loom-tile[data-tile="/members"]');
    await t.getByText('Owns every agent').first().click();
    await t.locator('.loom-tile__layer [role="dialog"][data-state="open"]').waitFor();
    await p.waitForTimeout(300);
    expect(await frames(p)).toEqual([]);
    expect(await still(p)).toEqual([]);
    await p.context().close();
  });

  // ---- Home's agent cards and the launcher: each card in its own box ----
  for (const [w, hgt] of [[1280, 800], [1920, 1080], [1280, 600]]) {
    it(`Home's agent cards at ${w}×${hgt}, and the launcher: nothing past its box, nothing scrolls the page`, async () => {
      const p = await screen(w, hgt, '/');
      await p.locator('.loom-bigcard').first().waitFor();
      await p.waitForTimeout(500);
      expect(await p.evaluate(outside, ['.loom-bigcard', '', 0] as const)).toEqual([]);
      expect(await still(p)).toEqual([]);
      await p.click('.loom-dock-bar [data-part="item"][aria-label="All apps"]');
      await p.locator('.loom-launcher').waitFor();
      await p.waitForTimeout(400);
      expect(await p.evaluate(outside, ['.loom-launcher', '', 0] as const)).toEqual([]);
      expect(await still(p)).toEqual([]);
      await p.context().close();
    });
  }

  it('no page threw', () => { expect(errors).toEqual([]); });
});
