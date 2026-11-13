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
import { deskHome } from './agent-desk.fixture.js';
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
  const old = await deskHome({art:'art'},[{person:'owner',agents:'*'}]);
  old.ask('art','OK to run the backup now?');
  const raised=app.operations.call('direct',{kind:'member',id:'owner'},'attention.raise',{id:'desk-ask',agent:'art',ask:'OK to run the backup now?',why:'Because it matters.',if_yes:'I do it.',if_no:'I leave it.',source:{kind:'piece',id:'desk-fixture'}},'desk-ask');
  expect(raised.ok).toBe(true);
  const browser = await chromium.launch({executablePath:chrome,args:['--no-sandbox']});
  try {
    const context = await browser.newContext({viewport:{width:1280,height:900}});
    const a = await context.newPage(), b = await context.newPage();
    const errors:string[]=[];a.on('pageerror',e=>errors.push(e.message));b.on('pageerror',e=>errors.push(e.message));
    const oldContext=await browser.newContext({viewport:{width:1280,height:900},reducedMotion:'reduce',serviceWorkers:'block'});
    await oldContext.addInitScript(()=>{sessionStorage.setItem('loom-arrived','1');sessionStorage.setItem('loom-booted','1');});
    await oldContext.request.post(old.base+'/login',{form:{token:old.tok.owner},maxRedirects:0});
    const reference=await oldContext.newPage();
    const board=await browser.newPage();
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
    // Ground is the member's live choice, shared across windows like the look.
    for (const ground of ['wash', 'contours', 'depth']) {
      set({ground}, 'ground-'+ground);
      for (const page of [a,b]) {
        await expect.poll(() => page.locator('html').getAttribute('data-ground')).toBe(ground);
        await expect.poll(() => page.locator('.loom-ground').count()).toBe(ground==='wash'?0:1);
      }
    }
    expect((await context.request.get(app.url+'/manifest.webmanifest')).headers()['content-type']).toBe('application/manifest+json');
    await expect.poll(() => a.evaluate(async () => (await navigator.serviceWorker.ready).active?.scriptURL)).toBe(app.url+'/sw.js');
    const shots = resolve('artifacts/desk-shell'); mkdirSync(shots,{recursive:true});
    for (const look of ['neon','lowlight','daylight']) {
      set({look,contrast:'off',motion:'on',sound:false},'look-'+look);
      await expect.poll(() => a.locator('html').getAttribute('data-look')).toBe(look);
      for (const width of [390,1280,1920]) {
        const page = width===390?b:a;
        await page.setViewportSize({width,height:900}); await page.reload();
        await expect.poll(() => page.locator('.next-shell').count()).toBe(1);
        await expect.poll(() => page.locator('html').getAttribute('data-look')).toBe(look);
        await expect.poll(() => page.getByRole('heading',{name:'Needs you · 1',exact:true}).count()).toBe(1);
        await reference.setViewportSize({width,height:900});
        await reference.addInitScript(look=>localStorage.setItem('loom-look',look),look);
        for (const surface of ['home','work','launcher']) {
          if(surface==='home') { if(reference.url()!=='about:blank')await reference.evaluate(()=>localStorage.removeItem('loom-tiles')); await reference.goto(old.base+'/?t='); await expect.poll(()=>reference.locator(width<1024?'.loom-phome .loom-bigcard':'.loom-bigcard').count()).toBeGreaterThan(0); }
          if(surface==='work') {
            await page.getByRole('button',{name:'Open Inbox',exact:true}).click();
            await expect.poll(()=>page.locator('[data-tile=inbox]').count()).toBe(1);
            await expect.poll(()=>page.locator('[data-tile=inbox]').getByText('OK to run the backup now?',{exact:true}).count()).toBe(1);
            await reference.goto(old.base+(width<1024?'/inbox':'/inbox?t=*inbox'));
            if(width>=1024) {
              await expect.poll(()=>page.locator('.desk-rail-card').count()).toBe(1);
              await expect.poll(()=>reference.locator('.loom-arail').count()).toBe(1);
              const rail=await page.locator('.next-rail').boundingBox(),tile=await page.locator('[data-tile=inbox]').boundingBox();
              expect(Math.round(rail!.width)).toBe(width>=1440?320:296);expect(tile!.x+tile!.width).toBeLessThanOrEqual(rail!.x-9);
              expect(await page.locator('.next-rail button').allTextContents()).toContain('Asks youOK to run the backup now? ›');
            }
          }
          if(surface==='launcher') {
            await page.getByRole('button',{name:'All apps',exact:true}).first().click();
            await expect.poll(()=>page.getByRole('textbox',{name:'Find an app',exact:true}).evaluate(el=>el===document.activeElement)).toBe(true);
            await page.getByRole('textbox',{name:'Find an app',exact:true}).fill('inbox');
            expect(await page.locator('.loom-lapp').count()).toBe(1);
            await page.keyboard.press('Escape');
            await expect.poll(()=>page.getByRole('dialog').count()).toBe(0);
            await page.getByRole('button',{name:'All apps',exact:true}).first().click();
            if(width<1024) { await reference.goto(old.base+'/setup'); await expect.poll(()=>reference.getByText('More',{exact:true}).count()).toBeGreaterThan(0); }
            else { await reference.keyboard.press('Control+Shift+Space'); await expect.poll(()=>reference.getByRole('textbox',{name:'Find an app',exact:true}).count()).toBe(1); }
          }
          await page.evaluate(()=>document.fonts.ready);await reference.evaluate(()=>document.fonts.ready);
          const before=await reference.screenshot({path:join(shots,`old-${surface}-${look}-${width}.png`),animations:'disabled'});
          const after=await page.screenshot({path:join(shots,`new-${surface}-${look}-${width}.png`),animations:'disabled'});
          await board.setViewportSize({width:width*2,height:932});
          await board.setContent(`<body style="margin:0;background:#17151e;color:#fff;font:14px monospace"><div style="display:flex"><section><p style="height:16px;margin:8px">OLD · ${surface} · ${look} · ${width}px</p><img width="${width}" src="data:image/png;base64,${before.toString('base64')}"></section><section><p style="height:16px;margin:8px">NEW · ${surface} · ${look} · ${width}px</p><img width="${width}" src="data:image/png;base64,${after.toString('base64')}"></section></div></body>`);
          await board.locator('img').evaluateAll(imgs=>Promise.all(imgs.map(i=>(i as HTMLImageElement).decode())));
          await board.screenshot({path:join(shots,`compare-${surface}-${look}-${width}.png`)});
        }
        await page.keyboard.press('Escape');await page.goto(app.url);

      }
    }
    expect(errors).toEqual([]);
  } finally { await browser.close(); await old.close(); await app.close(); rmSync(home,{recursive:true,force:true}); }
},180000);
