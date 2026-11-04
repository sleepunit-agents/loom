/**
 * A person's look follows them in a real browser (Jonathan, 2026-11-04: "if every device I login I have to go and change
 * the theme, that sucks"). Two devices, each its own browser and sign-in: one picks 000h in Appearance; the other,
 * which has nothing kept yet, paints Neon first, wears 000h once its page lands, and paints 000h straight away after.
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

  async function device(): Promise<Page> {
    const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, reducedMotion: 'reduce' });
    await ctx.request.post(`${base}/login`, { form: { token: TOKEN }, maxRedirects: 0 });
    return ctx.newPage();
  }
  const look = (p: Page) => p.evaluate(() => [document.documentElement.dataset.look, document.documentElement.dataset.mode]);

  it('saved from one, worn by the other: Neon until its page lands, then 000h, and 000h from its first paint after', async () => {
    const phone = await device();
    const laptop = await device();
    await phone.goto(`${base}/appearance`);
    await phone.getByRole('radio', { name: '000h' }).waitFor();
    expect(await look(phone)).toEqual(['neon', 'dark']);
    const saving = phone.waitForResponse((r) => r.url().endsWith('/appearance/prefs') && r.request().method() === 'POST');
    await phone.getByRole('radio', { name: '000h' }).click();
    expect((await saving).status()).toBe(200);
    expect((await look(phone))[0]).toBe('000h');

    // Nothing kept on the laptop yet: its first paint is Neon (the boot script), then loom's answer says 000h. Its
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
    await laptop.waitForFunction(() => document.documentElement.dataset.look === '000h', null, { timeout: 15_000 });
    expect(await laptop.evaluate(() => localStorage.getItem('loom-look'))).toBe('000h');
    // And from now on it paints 000h before anything else runs.
    await laptop.reload({ waitUntil: 'commit' });
    await laptop.waitForFunction(() => document.documentElement.dataset.look !== undefined);
    expect((await look(laptop))[0]).toBe('000h');
    expect(await laptop.evaluate(() => !!document.getElementById('loom-look-neon'))).toBe(false);

    // And back: Neon chosen on the phone reaches the laptop, which kept 000h, stylesheet and all.
    await laptop.unroute('**/*');
    const back = phone.waitForResponse((r) => r.url().endsWith('/appearance/prefs') && r.request().method() === 'POST');
    await phone.getByRole('radio', { name: 'Neon Noir' }).click();
    expect((await back).status()).toBe(200);
    await laptop.reload();
    await laptop.waitForFunction(() => document.documentElement.dataset.look === 'neon', null, { timeout: 15_000 });
    await laptop.waitForFunction(() => getComputedStyle(document.documentElement).getPropertyValue('--v-canvas').trim().toUpperCase() === '#07070C', null, { timeout: 15_000 });
    expect(await look(laptop)).toEqual(['neon', 'dark']);
  }, 60_000);
});
