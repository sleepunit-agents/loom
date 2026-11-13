/** One next-mode browser test; later desk slices extend this same scenario. */
import { it, expect } from 'vitest';
import { existsSync, mkdtempSync, rmSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import { chromium } from 'playwright-core';
import { startLoom } from '../foundation.js';
import { FakeClock } from '../core/clock.js';
import { HouseholdDatabase } from '../core/household/document.js';
import { migrateHouseholdTables } from '../core/household/schema.js';
import { TokenDatabase } from '../core/household/tokens.js';
const enabled = process.env.LOOM_DESK_EVIDENCE === '1';
const chrome = process.env.LOOM_TEST_CHROME;
const root = resolve('dist/web');
if (enabled && (!chrome || !existsSync(chrome) || !existsSync(join(root,'next.html')))) throw Error('Desk evidence needs Chrome and the built app');
it.runIf(enabled)('desk applies member appearance live across fresh windows and serves PWA assets', async () => {
  const home = mkdtempSync(join(tmpdir(),'desk-shell-'));
  const app = await startLoom({home,next:true,clock:new FakeClock(),webRoot:root,install(app) {
    migrateHouseholdTables(app.db);
    app.db.transaction(() => {
      new HouseholdDatabase(app.db).replace(home,{v:1,agents:['art'],default:'art',owner:'owner',members:[{person:'owner',role:'owner',agents:'*'}]});
      new TokenDatabase(app.db).replace({v:1,tokens:[]},{});
    })();
  }});
  const browser = await chromium.launch({executablePath:chrome,args:['--no-sandbox']});
  try {
    const context = await browser.newContext({viewport:{width:1280,height:900}});
    const a = await context.newPage(), b = await context.newPage();
    const link = app.operations.call('direct',{kind:'member',id:'owner'},'signin.link',{member:'owner'});
    if (!link.ok) throw Error('Fixture sign-in failed');
    await a.goto(app.url+(link.value as {path:string}).path);
    await a.getByRole('button',{name:'Sign in',exact:true}).click();
    await expect.poll(() => a.locator('.next-shell').count()).toBe(1);
    expect(await a.locator('html').getAttribute('data-look')).toBe('neon');
    const set = (prefs:unknown,id:string) => {
      const result = app.operations.call('direct',{kind:'member',id:'owner'},'household.setPreferences',prefs,id);
      expect(result.ok).toBe(true);
    };
    set({look:'daylight',sound:true,motion:'on',contrast:'on',zoom:true},'appearance');
    await b.goto(app.url);
    for (const page of [a,b]) {
      await expect.poll(() => page.locator('html').getAttribute('data-look')).toBe('daylight');
      expect(await page.locator('html').getAttribute('data-mode')).toBe('light');
      expect(await page.locator('html').getAttribute('data-sound')).toBe('on');
      expect(await page.locator('html').getAttribute('data-motion')).toBe('reduce');
      expect(await page.locator('html').getAttribute('data-contrast')).toBe('more');
      expect(await page.locator('meta[name=viewport]').getAttribute('content')).not.toContain('user-scalable=no');
    }
    expect((await context.request.get(app.url+'/manifest.webmanifest')).headers()['content-type']).toBe('application/manifest+json');
    await expect.poll(() => a.evaluate(async () => (await navigator.serviceWorker.ready).active?.scriptURL)).toBe(app.url+'/sw.js');
    const shots = resolve('artifacts/desk-shell'); mkdirSync(shots,{recursive:true});
    for (const look of ['neon','lowlight','daylight']) {
      set({look},'look-'+look);
      await expect.poll(() => a.locator('html').getAttribute('data-look')).toBe(look);
      for (const width of [390,1280,1920]) {
        const page = width===390?b:a;
        await page.setViewportSize({width,height:900}); await page.reload();
        await expect.poll(() => page.locator('.next-shell').count()).toBe(1);
        await expect.poll(() => page.locator('html').getAttribute('data-look')).toBe(look);
        await page.screenshot({path:join(shots,`new-${look}-${width}.png`),animations:'disabled'});
      }
    }
  } finally { await browser.close(); await app.close(); rmSync(home,{recursive:true,force:true}); }
},60000);
