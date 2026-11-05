/**
 * Where the dock and the toasts land on a phone, measured in a real browser (Jonathan, 2026-11-03: on his iPhone's
 * home screen the dock was locked too high, and a toast covered the whole screen).
 *
 * Chrome with an iPhone 15's screen, its safe areas (59 top, 34 bottom), and for the home-screen app
 * navigator.standalone and display-mode: standalone. Chrome can't reproduce iOS 26's short viewport itself (WebKit bug
 * 301108: a home-screen app's viewport loses the status bar's height while the document is no taller than it), so this
 * checks what loom controls: the document there is never shorter than the screen and still scrolls, the dock's bottom
 * edge is the screen's with its safe area counted once, and a toast is a strip under the status bar, not the screen.
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
const TOKEN = 'phone-geometry-token';
const INSETS = { top: 59, bottom: 34, left: 0, right: 0 };
const IPHONE = 'Mozilla/5.0 (iPhone; CPU iPhone OS 26_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.0 Mobile/15E148 Safari/604.1';

type Box = { top: number; bottom: number; left: number; right: number; width: number; height: number };
type Measured = { vw: number; vh: number; htmlH: number; overflow: string; dock: Box | null; dockPad: number; viewport: Box; toast: Box; scrolled: number; dockAfterScroll: number };

describe.runIf(built && chrome)('a phone: the dock and the toasts', () => {
  let tmp: string;
  let handle: HttpServeHandle;
  let browser: Browser;
  let base: string;
  const saved: Record<string, string | undefined> = {};

  beforeAll(async () => {
    tmp = await mkdtemp(join(tmpdir(), 'loom-phone-'));
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

  async function measure(how: 'app' | 'tab' | 'desktop'): Promise<Measured> {
    const phone = how !== 'desktop';
    // No service worker: 127.0.0.1 is a secure context, so loom's worker can install and answer the page's JSON itself,
    // where this test's route (the flash below) never sees it, and then no toast comes (CI, now and then).
    const ctx = await browser.newContext(phone
      ? { viewport: { width: 393, height: how === 'app' ? 852 : 659 }, deviceScaleFactor: 3, isMobile: true, hasTouch: true, userAgent: IPHONE, serviceWorkers: 'block' }
      : { viewport: { width: 1440, height: 900 }, serviceWorkers: 'block' });
    const page: Page = await ctx.newPage();
    const cdp = await ctx.newCDPSession(page);
    if (phone) await cdp.send('Emulation.setSafeAreaInsetsOverride' as never, { insets: INSETS } as never);
    if (how === 'app') {
      await page.addInitScript(() => Object.defineProperty(Navigator.prototype, 'standalone', { get: () => true }));
      await cdp.send('Emulation.setEmulatedMedia', { features: [{ name: 'display-mode', value: 'standalone' }] });
    }
    await ctx.request.post(`${base}/login`, { form: { token: TOKEN }, maxRedirects: 0 });
    // A page's answer carries a flash, so the app shows a toast.
    await page.route('**/*', async (route) => {
      const r = route.request();
      if (r.resourceType() !== 'fetch' || !(r.headers().accept ?? '').includes('json')) return route.continue();
      const res = await route.fetch();
      const json = await res.json().catch(() => null);
      if (json?.chrome) json.chrome.flash = { ok: true, message: 'Saved the note.' };
      return route.fulfill({ response: res, json });
    });
    await page.goto(`${base}/`);
    await page.waitForSelector('[data-slot="toast"][data-state="open"]', { timeout: 20_000 });
    await page.waitForTimeout(800); // the toast's and the dock's entrances
    const m = await page.evaluate(() => {
      const box = (s: string) => { const e = document.querySelector(s); if (!e) return null; const b = e.getBoundingClientRect(); return { top: b.top, bottom: b.bottom, left: b.left, right: b.right, width: b.width, height: b.height }; };
      const dock = document.querySelector('.loom-dock-bar');
      return { vw: innerWidth, vh: innerHeight, htmlH: document.documentElement.getBoundingClientRect().height, overflow: getComputedStyle(document.documentElement).overflowY,
        dock: box('.loom-dock-bar'), dockPad: dock ? parseFloat(getComputedStyle(dock).paddingBottom) : 0,
        viewport: box('[data-slot="toast-viewport"]')!, toast: box('[data-slot="toast"]')! };
    });
    await page.evaluate(() => window.scrollTo(0, 400));
    await page.waitForTimeout(200);
    const after = await page.evaluate(() => ({ scrolled: scrollY, dockAfterScroll: document.querySelector('.loom-dock-bar')?.getBoundingClientRect().bottom ?? -1 }));
    await ctx.close();
    return { ...m, ...after } as Measured;
  }

  const toastIsAStrip = (m: Measured) => {
    // Its natural size: one toast, a line or two, never the screen.
    expect(m.toast.height).toBeLessThan(140);
    expect(m.viewport.height).toBeLessThan(m.vh / 4);
    expect(m.viewport.width).toBeLessThanOrEqual(380);
  };

  it('the home-screen app: the document is the screen\'s height and scrolls; the dock is at the bottom; a toast is a strip at the top', async () => {
    const m = await measure('app');
    // Never shorter than the screen (the condition WebKit 301108 needs), and the document, not #root, scrolls.
    expect(m.htmlH).toBeGreaterThanOrEqual(m.vh);
    expect(m.overflow).toBe('visible');
    expect(m.scrolled).toBeGreaterThan(0);
    // The dock's bottom edge is the screen's, before and after a scroll; the home indicator's inset is counted once.
    expect(m.dock!.bottom).toBe(m.vh);
    expect(m.dockAfterScroll).toBe(m.vh);
    expect(m.dockPad).toBe(INSETS.bottom);   // Neon, the default: the bar pads by the inset alone, its keys 8 px over it (phone-bar test)
    // Under the status bar, centred.
    expect(m.viewport.top).toBe(INSETS.top + 12);
    expect(Math.abs(m.viewport.left - (m.vw - m.viewport.right))).toBeLessThanOrEqual(1);
    toastIsAStrip(m);
  }, 60_000);

  it('Safari\'s tab: the same dock and toast', async () => {
    const m = await measure('tab');
    expect(m.dock!.bottom).toBe(m.vh);
    expect(m.dockAfterScroll).toBe(m.vh);
    expect(m.dockPad).toBe(INSETS.bottom);   // Neon, the default: the bar pads by the inset alone, its keys 8 px over it (phone-bar test)
    expect(m.viewport.top).toBe(INSETS.top + 12);
    toastIsAStrip(m);
  }, 60_000);

  it('a desktop: no dock, and toasts bottom right', async () => {
    const m = await measure('desktop');
    expect(m.dock).toBeNull();
    expect(m.vh - m.viewport.bottom).toBe(24);
    expect(m.vw - m.viewport.right).toBe(24);
    toastIsAStrip(m);
  }, 60_000);
});
