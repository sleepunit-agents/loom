/**
 * A person's look follows them in a real browser (Jonathan, 2026-11-04: "if every device I login I have to go and change
 * the theme, that sucks"). Two devices, each its own browser and sign-in: one picks Daylight in Appearance; the other,
 * which has nothing kept yet, paints Neon first, wears Daylight (light) once its page lands, and paints it straight away
 * after. Each look keeps one structure: the same bars and dock, no sideways scroll at 390 px.
 *
 * Runs where the app is built (npm run build) and a Chrome is installed (GitHub's runners have one).
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { existsSync } from 'node:fs';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium, type Browser, type Page } from 'playwright-core';
import { startHttpServer, type HttpServeHandle } from '../transport/http-server.js';
import { LOOKS } from '../../web/src/look';

const root = new URL('../../', import.meta.url).pathname;
const chrome = [process.env.LOOM_TEST_CHROME, '/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser'].find((p) => p && existsSync(p));
const built = existsSync(`${root}dist/web/index.html`);
const TOKEN = 'look-sync-token';

describe.runIf(built && chrome)('a look chosen on one device is the look on another', () => {
  let tmp: string;
  let handle: HttpServeHandle;
  let browser: Browser;
  let base: string;
  const saved: Record<string, string | undefined> = {};

  beforeAll(async () => {
    tmp = await mkdtemp(join(tmpdir(), 'loom-look-sync-'));
    for (const k of ['LOOM_HOME', 'XDG_CONFIG_HOME']) saved[k] = process.env[k];
    process.env.LOOM_HOME = join(tmp, 'home');
    process.env.XDG_CONFIG_HOME = join(tmp, 'xdg');
    const stack = join(tmp, 'stack');
    await mkdir(stack);
    await writeFile(join(stack, 'IDENTITY.md'), '# Art E Fish\n\nCreed.');
    handle = await startHttpServer({ contextDir: stack, host: '127.0.0.1', port: 0, token: TOKEN });
    base = `http://127.0.0.1:${handle.port}`;
    browser = await chromium.launch({ executablePath: chrome, args: ['--no-sandbox'] });
  }, 60_000);
  afterAll(async () => {
    await browser?.close();
    await handle?.close();
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    await rm(tmp, { recursive: true, force: true });
  });

  async function device(motion: 'reduce' | 'no-preference' = 'reduce', kept?: Record<string, string>): Promise<Page> {
    const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, reducedMotion: motion, isMobile: true, hasTouch: true, serviceWorkers: 'block' });
    if (kept) await ctx.addInitScript((k) => { for (const [a, b] of Object.entries(k)) localStorage.setItem(a, b); }, kept);
    await ctx.request.post(`${base}/login`, { form: { token: TOKEN }, maxRedirects: 0 });
    return ctx.newPage();
  }
  const look = (p: Page) => p.evaluate(() => [document.documentElement.dataset.look, document.documentElement.dataset.mode]);

  it('saved from one, worn by the other: Neon until its page lands, then Daylight, and Daylight from its first paint after', async () => {
    const phone = await device();
    const laptop = await device();
    await phone.goto(`${base}/appearance`);
    await phone.getByRole('radio', { name: 'Daylight' }).waitFor();
    expect(await look(phone)).toEqual(['neon', 'dark']);
    const saving = phone.waitForResponse((r) => r.url().endsWith('/appearance/prefs') && r.request().method() === 'POST');
    await phone.getByRole('radio', { name: 'Daylight' }).click();
    expect((await saving).status()).toBe(200);
    expect(await look(phone)).toEqual(['daylight', 'light']);

    // Nothing kept on the laptop yet: its first paint is Neon (the boot script), then loom's answer says Daylight. Its
    // page's answer is held until the first paint is seen, so the order is the test's, not the network's.
    let land!: () => void;
    const held = new Promise<void>((r) => { land = r; });
    await laptop.route('**/*', async (route) => {
      if (route.request().resourceType() === 'fetch' && (route.request().headers().accept ?? '').includes('json')) await held;
      return route.continue();
    });
    await laptop.goto(`${base}/`);
    expect((await look(laptop))[0]).toBe('neon');
    land();
    await laptop.waitForFunction(() => document.documentElement.dataset.look === 'daylight', null, { timeout: 15_000 });
    expect(await look(laptop)).toEqual(['daylight', 'light']);
    expect(await laptop.evaluate(() => localStorage.getItem('loom-look'))).toBe('daylight');
    await laptop.waitForFunction(() => getComputedStyle(document.documentElement).getPropertyValue('--v-canvas').trim().toUpperCase() === '#F5F3EE');
    // And from now on it paints Daylight before anything else runs.
    await laptop.reload({ waitUntil: 'commit' });
    await laptop.waitForFunction(() => document.documentElement.dataset.look !== undefined);
    expect(await look(laptop)).toEqual(['daylight', 'light']);

    // And back: Neon chosen on the phone reaches the laptop, which kept Daylight.
    await laptop.unroute('**/*');
    const back = phone.waitForResponse((r) => r.url().endsWith('/appearance/prefs') && r.request().method() === 'POST');
    await phone.getByRole('radio', { name: 'Neon Noir' }).click();
    expect((await back).status()).toBe(200);
    await laptop.reload();
    await laptop.waitForFunction(() => document.documentElement.dataset.look === 'neon', null, { timeout: 15_000 });
    await laptop.waitForFunction(() => getComputedStyle(document.documentElement).getPropertyValue('--v-canvas').trim().toUpperCase() === '#07070C', null, { timeout: 15_000 });
    expect(await look(laptop)).toEqual(['neon', 'dark']);
  }, 60_000);

  // Oxanium is wider than Figtree: at 390 px, the built-in titles stay on one line.
  it('Neon\'s titles fit at 390 px', async () => {
    const page = await device('reduce', { 'loom-look': 'neon' });
    for (const path of ['/appearance', '/places', '/inbox', '/']) {
      await page.goto(`${base}${path}`);
      const h1 = page.locator('.loom-top h1');
      await h1.waitFor();
      await page.waitForFunction(() => document.fonts.status === 'loaded');
      const m = await h1.evaluate((e) => ({ h: e.getBoundingClientRect().height, lh: parseFloat(getComputedStyle(e).lineHeight), w: e.scrollWidth, cw: e.clientWidth, font: getComputedStyle(e).fontFamily }));
      expect(m.font, path).toContain('Oxanium');
      expect(m.h, path).toBeLessThan(m.lh * 1.5);
      expect(m.w, path).toBeLessThanOrEqual(m.cw);
    }
  }, 60_000);

  // The phone bar (phone-bar.tsx, t-1849) at every width, in every look; wider than a phone, loom's system bar over it.
  it('every look\'s chrome: the phone bar, no sideways scroll at 390 px, none with reduced motion, no sound unless on', async () => {
    const sounds: string[] = [];
    for (const { look: l, name } of LOOKS) {
      const page = await device('reduce', { 'loom-look': l });
      page.on('request', (r) => { if (/\/assets\/sound-/.test(r.url())) sounds.push(r.url()); });
      // Chosen, not only kept: loom's copy of the person's choice wins over a device's.
      await page.goto(`${base}/appearance`);
      // Appearance's one choice: the looks, and no light or dark beside them.
      const choice = page.getByRole('radiogroup', { name: 'Look' });
      await choice.getByRole('radio').first().waitFor();
      expect(await choice.getByRole('radio').allInnerTexts()).toEqual(LOOKS.map((x) => x.name));
      expect(await page.getByRole('radio', { name: /^(Light|Dark|Auto)$/ }).count()).toBe(0);
      await choice.getByRole('radio', { name }).click();
      await page.waitForFunction((x) => document.documentElement.dataset.look === x, l);
      for (const path of ['/', '/places', '/setup', '/inbox', '/appearance']) {
        await page.goto(`${base}${path}`);
        await page.locator('.loom-top h1').waitFor();
        const m = await page.evaluate(() => ({ look: document.documentElement.dataset.look, sw: document.documentElement.scrollWidth, cw: document.documentElement.clientWidth, bar: !!document.querySelector('.loom-pbar'), dock: !!document.querySelector('.loom-dock-bar .v-dock'), arrive: 'arrive' in document.documentElement.dataset }));
        const at = `${l} ${path}`;
        expect(m.look, at).toBe(l);
        expect(m.sw, at).toBeLessThanOrEqual(m.cw);
        expect([m.bar, m.dock], at).toEqual([true, true]);
        expect(m.arrive, `${at}: no power-on with reduced motion`).toBe(false);
      }
    }
    expect(sounds).toEqual([]);

    // The power-on and its tap: look-neon-chrome.integration.test.ts.

  }, 90_000);
});
