/**
 * A dock key magnified under the pointer (dock.tsx, 1.65x and lifted) is drawn whole, its name over it too (Jonathan,
 * 2026-11-05: "when the icons grow on hover, the top of them is cut off"): on the desktop shell at 1280 px, on a phone's
 * width with a mouse, and to a finger (no magnifying there; a held key's name right over it). Nothing that clips (an
 * overflow or a clip-path) cuts either. Real Chrome, Neon Noir.
 *
 * Runs where the app is built (npm run build) and a Chrome is installed (GitHub's runners have one).
 */
import { describe, it, expect } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import BetterSqlite3 from 'better-sqlite3';
import { chromium } from 'playwright-core';
import { startHttpServer } from '../transport/http-server.js';
import { createToken, loadHousehold } from '../household.js';
import { createConversationTables } from '../backends/conversations.js';
import { closeAllBackends } from '../backends/index.js';
const root = new URL('../../', import.meta.url).pathname;
const chrome = [process.env.LOOM_TEST_CHROME, '/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser'].find((p) => p && existsSync(p));
const built = existsSync(`${root}dist/web/index.html`);
describe.runIf(built && chrome)('a magnified dock key', () => {
it('is never cut off, nor is its name, on the desktop, on a phone\'s width, or to a finger', async () => {
  const saved = { LOOM_HOME: process.env.LOOM_HOME, XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME };
  const home = mkdtempSync(join(tmpdir(), 'loom-dock-'));
  for (const a of ['art', 'mark']) { mkdirSync(join(home, 'agents', a), { recursive: true }); writeFileSync(join(home, 'agents', a, 'IDENTITY.md'), `# ${a}\n`); const db = new BetterSqlite3(join(home, 'agents', a, 'memories.db')); createConversationTables(db); db.close(); }
  writeFileSync(join(home, 'household.json'), JSON.stringify({ v: 1, agents: ['art', 'mark'], default: 'art', members: [{ person: 'jonathan', role: 'owner', agents: '*' }] }));
  process.env.LOOM_HOME = home; process.env.XDG_CONFIG_HOME = join(home, 'xdg');
  const h = loadHousehold(home)!; const token = createToken(h, { role: { kind: 'owner' }, label: 'jonathan' }).token;
  const handle = await startHttpServer({ contextDir: join(home, 'agents', 'art'), host: '127.0.0.1', port: 0, household: h });
  const base = `http://127.0.0.1:${handle.port}`;
  const browser = await chromium.launch({ executablePath: chrome, args: ['--no-sandbox'] });
  for (const [width, touch] of [[1280, false], [390, false], [390, true]] as const) {
    const ctx = await browser.newContext({ viewport: { width, height: 800 }, hasTouch: touch, isMobile: touch, reducedMotion: 'no-preference', serviceWorkers: 'block' });
    await ctx.addInitScript(() => { localStorage.setItem('loom-look', 'neon'); sessionStorage.setItem('loom-arrived', '1'); sessionStorage.setItem('loom-booted', '1'); });
    await ctx.request.post(`${base}/login`, { form: { token }, maxRedirects: 0 });
    const p = await ctx.newPage();
    await p.goto(`${base}/`); await p.locator('.loom-dock-bar [data-part="item"]').first().waitFor(); await p.waitForTimeout(600);
    const item = p.locator('.loom-dock-bar [data-part="item"]').nth(1);
    if (width === 1280) expect(await p.locator('.loom-desk').count(), 'the desktop shell').toBe(1);
    const b = (await item.boundingBox())!;
    await p.mouse.move(b.x + b.width / 2, b.y + b.height / 2);
    if (touch) await p.mouse.down();
    await p.waitForTimeout(900);
    const r = await item.evaluate((el) => {
      const v = el.querySelector('[data-part="visual"]')!.getBoundingClientRect();
      const lab = el.querySelector('[data-part="label"]'); const l = lab?.getBoundingClientRect();
      const cut: string[] = [];
      const inside = (r: DOMRect, c: DOMRect) => r.top >= c.top - 0.5 && r.bottom <= c.bottom + 0.5 && r.left >= c.left - 0.5 && r.right <= c.right + 0.5;
      for (let a = el.parentElement; a; a = a.parentElement) {
        const cs = getComputedStyle(a);
        // The dock bar is fixed: past it, an overflow (the page's own) doesn't clip it.
        const last = cs.position === 'fixed';
        if (cs.overflowX === 'visible' && cs.overflowY === 'visible' && cs.clipPath === 'none') { if (last) break; continue; }
        const c = a.getBoundingClientRect(), what = a.getAttribute('data-part') ?? a.className.toString().slice(0, 40);
        if (!inside(v, c)) cut.push(`the key, by ${what}`);
        if (l && !inside(l, c)) cut.push(`its name, by ${what}`);
        if (last) break;
      }
      return { h: v.height, size: (el as HTMLElement).getBoundingClientRect().height, name: lab ? +getComputedStyle(lab).opacity : 0, gap: l ? v.top - l.bottom : 0, cut };
    });
    const where = `${width} px${touch ? ', a finger' : ''}`;
    // A mouse magnifies it (1.65x); a finger doesn't.
    if (touch) expect(r.h, where).toBeLessThan(r.size * 1.1); else expect(r.h, where).toBeGreaterThan(r.size * 1.5);
    // Its name shows, clear of the key as it's drawn.
    expect(r.name, where).toBe(1);
    expect(r.gap, where).toBeGreaterThanOrEqual(4);
    expect(r.cut, where).toEqual([]);
    await ctx.close();
  }
  await browser.close(); await handle.close(); await closeAllBackends(); rmSync(home, { recursive: true, force: true });
  for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
}, 200_000);
});
