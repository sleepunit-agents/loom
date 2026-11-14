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
import { HouseholdRows } from '../core/household/rows.js';
import { manifestFromPixelLab } from '../household.js';
import { sheet } from './pixel-sheet.fixture.js';
import { TokenDatabase } from '../core/household/tokens.js';
const enabled = process.env.LOOM_DESK_EVIDENCE === '1';
const chrome = process.env.LOOM_TEST_CHROME;
const root = resolve('dist/web');
if (enabled && (!chrome || !existsSync(chrome) || !existsSync(join(root,'next.html')))) throw Error('Desk evidence needs Chrome and the built app');
it.runIf(enabled)('desk applies member appearance live across fresh windows and serves PWA assets', async () => {
  const home = mkdtempSync(join(tmpdir(),'desk-shell-'));
  const app = await startLoom({home,next:true,staging:true,clock:new FakeClock(Date.parse('2026-11-13T18:41:00Z')),webRoot:root,install(app) {
    migrateHouseholdTables(app.db);
    app.db.transaction(() => {
      new HouseholdDatabase(app.db).replace(home,{v:1,tz:'America/Chicago',agents:['art','birch','cedar','elm','fern'],default:'art',owner:'owner',members:[{person:'owner',role:'owner',agents:'*'}]});
      new TokenDatabase(app.db).replace({v:1,tokens:[]},{});
      // Existing technical test sheet, never supplied artwork or screenshot evidence.
      const sample = sheet(), manifest = manifestFromPixelLab(JSON.parse(sample.json.toString()));
      new HouseholdRows(app.db,'settings').put('agent-sprite:art',{manifest,rawManifest:Buffer.from(JSON.stringify(manifest)).toString('base64'),sheets:{'sheet.png':sample.png.toString('base64')},v:'browser-fixture'});
    })();
  }});
  const old = await deskHome({art:'art',birch:'birch',cedar:'cedar',elm:'elm',fern:'fern'},[{person:'owner',agents:'*'}]);
  old.ask('art','OK to run the backup now?');
  const oldThread=old.thread('owner','art','A Home conversation','A Home conversation');
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
    // Exercise the real renderer through the database-backed display feed on both surfaces.
    const painted = async (page: typeof a, selector: string) => page.locator(selector).evaluateAll(nodes => nodes.some(node => {
      const cv = node as HTMLCanvasElement, data = cv.getContext('2d')?.getImageData(0,0,cv.width,cv.height).data;
      return data && data.some((n,i) => i % 4 === 3 && n > 0);
    }));
    await expect.poll(()=>painted(b,'.desk-home-card .loom-pixel-face canvas')).toBe(true);
    await a.getByRole('button',{name:'Open Inbox',exact:true}).click();
    await expect.poll(()=>painted(a,'.desk-rail-card .loom-pixel-face canvas')).toBe(true);
    set({pixel:false},'pixel-off');
    await expect.poll(()=>a.locator('.desk-rail-card [data-slot=agent-face]').count()).toBe(1);
    await expect.poll(()=>b.locator('.desk-home-card [data-slot=agent-face]').count()).toBe(5);
    set({pixel:true},'pixel-on');
    await expect.poll(()=>painted(a,'.desk-rail-card .loom-pixel-face canvas')).toBe(true);
    await expect.poll(()=>painted(b,'.desk-home-card .loom-pixel-face canvas')).toBe(true);
    // A refused manifest and an undecodable sheet both recover to the drawn face.
    await a.route('**/faces/art/manifest.json*',route=>route.fulfill({status:404,body:'not found'}));
    await a.reload();
    await expect.poll(()=>a.locator('.desk-rail-card [data-slot=agent-face]').count()).toBe(1);
    await b.route('**/faces/art/sheet.png*',route=>route.fulfill({status:200,contentType:'image/png',body:'not a PNG'}));
    await b.reload();
    await expect.poll(()=>b.locator('.desk-home-card [data-slot=agent-face]').count()).toBe(5);
    await a.unroute('**/faces/art/manifest.json*'); await b.unroute('**/faces/art/sheet.png*');
    new HouseholdRows(app.db,'settings').remove('agent-sprite:art');
    await a.getByRole('button',{name:'Home',exact:true}).click();
    // Home shares Comms' durable draft and opens exactly the acknowledged thread.
    const homeComposer=b.locator('.desk-home-compose').first();
    await expect.poll(()=>homeComposer.getByRole('textbox',{name:'Message',exact:true}).count()).toBe(1);
    await homeComposer.getByRole('textbox',{name:'Message',exact:true}).fill('A Home conversation');
    await b.reload();
    await expect.poll(()=>b.locator('.desk-home-compose').first().getByRole('textbox',{name:'Message',exact:true}).inputValue()).toBe('A Home conversation');
    await b.locator('.desk-home-compose').first().getByRole('button',{name:'Send',exact:true}).click();
    await expect.poll(()=>b.locator('.comms-thread').count()).toBe(1);
    await expect.poll(()=>b.getByText('A Home conversation',{exact:true}).count()).toBe(1);
    expect(app.db.prepare('SELECT count(*) AS n FROM comms_threads').get()).toEqual({n:1});
    const commsId=(app.db.prepare('SELECT id FROM comms_threads').get() as {id:string}).id.replace(/^th:/,'');
    // A visible Comms thread is the companion even while another app has focus.
    await expect.poll(()=>b.locator('.desk-rail-card[data-companion]').getAttribute('data-agent')).toBe('art');
    expect(await b.locator('.desk-agent-rail').locator(':scope > *').first().getAttribute('data-agent')).toBe('art');
    await expect.poll(()=>b.locator('.desk-rail-screen .next-comm-screen').count()).toBe(1);
    expect(await b.locator('.comms-thread .next-comm-screen').count()).toBe(0);
    // Overlay rails never steal the portrait. Returning to Always show moves it back once.
    await b.locator('.next-rail').click({button:'right'});
    await b.getByRole('menuitem',{name:'Minimize to strip',exact:true}).click();
    await expect.poll(()=>b.locator('.comms-thread .next-comm-screen').count()).toBe(1);
    await b.getByRole('button',{name:'Show agents rail',exact:true}).click();
    expect(await b.locator('.desk-rail-screen .next-comm-screen').count()).toBe(0);
    await b.locator('.next-rail').click({button:'right'});
    await b.getByRole('menuitem',{name:'Always show',exact:true}).click();
    await expect.poll(()=>b.locator('.desk-rail-screen .next-comm-screen').count()).toBe(1);
    expect(await b.locator('.next-comm-screen').count()).toBe(1);
    await b.getByRole('button',{name:'Open Inbox',exact:true}).click();
    await expect.poll(()=>b.locator('.desk-rail-card[data-companion]').count()).toBe(1);
    // Observe real FLIP requests while exercising full and reduced motion, without racing260ms.
    set({motion:'off'},'companion-full-motion');
    await expect.poll(()=>b.locator('html').getAttribute('data-motion')).toBe('full');
    await b.evaluate(()=>{
      const state=window as Window & {deskMoves?:{agent:string;duration:number;from:string}[];deskAnimate?:HTMLElement['animate']};
      state.deskMoves=[];state.deskAnimate=HTMLElement.prototype.animate;
      HTMLElement.prototype.animate=function(frames,options){
        if(this.dataset.agent&&this.closest('.desk-agent-rail')&&Array.isArray(frames))state.deskMoves!.push({agent:this.dataset.agent,duration:typeof options==='object'?Number(options?.duration):Number(options),from:String(frames[0]?.transform)});
        return state.deskAnimate!.call(this,frames,options);
      };
    });
    await b.getByRole('button',{name:'Minimize Comms',exact:true}).click();
    await expect.poll(()=>b.locator('.desk-rail-card[data-companion]').count()).toBe(0);
    expect(await b.evaluate(()=>(window as Window & {deskMoves:{agent:string;duration:number;from:string}[]}).deskMoves.some(m=>m.agent==='art'&&m.duration===260&&m.from!=='translateY(0px)'))).toBe(true);
    set({motion:'on'},'companion-reduced-motion');
    await expect.poll(()=>b.locator('html').getAttribute('data-motion')).toBe('reduce');
    await b.evaluate(()=>{(window as Window & {deskMoves:unknown[]}).deskMoves=[];});
    await b.getByRole('button',{name:'Open Comms',exact:true}).click();
    await expect.poll(()=>b.locator('.desk-rail-card[data-companion]').count()).toBe(1);

    expect(await b.evaluate(()=>(window as Window & {deskMoves:unknown[]}).deskMoves.length)).toBe(0);
    await b.evaluate(()=>{const state=window as Window & {deskAnimate:HTMLElement['animate']};HTMLElement.prototype.animate=state.deskAnimate;});
    await b.getByRole('button',{name:'Home',exact:true}).click();
    await expect.poll(()=>b.locator('.desk-home-card').getByRole('button',{name:/Recent conversation/}).count()).toBe(1);
    await expect.poll(()=>b.locator('.desk-home-compose').first().getByRole('textbox',{name:'Message',exact:true}).inputValue()).toBe('');
    // Comparison boards intentionally retain the fixture's ordinary drawn identity.
    expect((await context.request.get(app.url+'/manifest.webmanifest')).headers()['content-type']).toBe('application/manifest+json');
    await expect.poll(() => a.evaluate(async () => (await navigator.serviceWorker.ready).active?.scriptURL)).toBe(app.url+'/sw.js');
    // iPad's home-screen app has its own status bar even in a desktop-width layout.
    await a.addInitScript(()=>Object.defineProperty(navigator,'standalone',{value:sessionStorage.getItem('desk-ios')==='1',configurable:true}));
    await a.evaluate(()=>sessionStorage.setItem('desk-ios','1'));
    await a.reload();
    await expect.poll(()=>a.locator('.next-system-clock').count()).toBe(1);
    expect(await a.locator('html').getAttribute('class')).toContain('loom-ios-app');
    expect(await a.locator('.next-system-clock').isVisible()).toBe(false);
    expect(await a.locator('.next-system-icons').isVisible()).toBe(false);
    await a.evaluate(()=>sessionStorage.removeItem('desk-ios'));
    await a.reload();
    await expect.poll(()=>a.locator('.next-system-clock').isVisible()).toBe(true);
    const shots = resolve('artifacts/desk-shell'); mkdirSync(shots,{recursive:true});
    for (const look of ['neon','lowlight','daylight']) {
      set({look,contrast:'off',motion:'on',sound:false},'look-'+look);
      await expect.poll(() => a.locator('html').getAttribute('data-look')).toBe(look);
      for (const width of [390,1280,1920]) {
        const page = width===390?b:a;
        await page.setViewportSize({width,height:900}); await page.reload();
        await expect.poll(() => page.locator('.next-shell').count()).toBe(1);
        await expect.poll(() => page.locator('html').getAttribute('data-look')).toBe(look);
        await expect.poll(()=>page.locator('.next-status-bar .loom-pbar__needs').getAttribute('aria-label')).toBe('1 needs you');
        expect(await page.locator('.next-status-bar h1').innerText()).toBe('Home');
        await expect.poll(()=>page.locator('.next-system-clock').getAttribute('title')).toBe('12:41 PM, America/Chicago time');
        expect(await page.locator('.next-system-clock').isVisible()).toBe(width!==390);
        expect(await page.locator('.next-system-icons').isVisible()).toBe(width!==390);
        expect(await page.locator('.next-status-bar .loom-tick__line').first().innerText()).toContain('5 agents');
        await expect.poll(()=>page.locator('.next-status-bar .loom-tick__line').first().innerText()).toContain('Tasks · 0 in progress · 0 ready');
        await expect.poll(()=>page.locator('.next-status-bar .loom-tick__line').first().innerText()).toContain('0 enrolled boxes · health unavailable');
        expect(await page.locator('.next-system-icons [aria-label="0 enrolled boxes; health unavailable"]').count()).toBe(1);
        expect(await page.evaluate(()=>document.documentElement.scrollWidth)).toBeLessThanOrEqual(width);
        await expect.poll(() => page.getByRole('heading',{name:'Needs you · 1',exact:true}).count()).toBe(1);
        await expect.poll(()=>page.locator('.desk-home-card [data-slot=agent-face]').count()).toBe(width<1024?1:5);
        expect(await page.locator('.desk-home-compact').count()).toBe(width<1024?4:0);
        expect(await page.locator('.desk-home-compose').count()).toBe(width<1024?1:5);
        if(width<1024)expect(await page.locator('.desk-home-card').getAttribute('data-agent')).toBe('art');
        await reference.setViewportSize({width,height:900});
        await reference.addInitScript(look=>localStorage.setItem('loom-look',look),look);
        for (const surface of ['home','work','companion','launcher']) {
          if(surface==='home') {
            await page.getByRole('button',{name:'Check again',exact:true}).click();
            await expect.poll(()=>page.getByRole('button',{name:'Yes',exact:true}).isEnabled()).toBe(true);
            // Checking may scroll its button into view; capture Home from its identity/header.
            await page.locator('.desk-home').evaluate(el=>{let node:HTMLElement|null=el as HTMLElement;while(node){node.scrollTop=0;node=node.parentElement;}});
            if(reference.url()!=='about:blank')await reference.evaluate(()=>localStorage.removeItem('loom-tiles')); await reference.goto(old.base+'/?t='); await expect.poll(()=>reference.locator(width<1024?'.loom-phome .loom-bigcard':'.loom-bigcard').count()).toBeGreaterThan(0);
          }
          if(surface==='work') {
            await page.getByRole('button',{name:'Open Inbox',exact:true}).click();
            await expect.poll(()=>page.locator('[data-tile=inbox]').count()).toBe(1);
            await expect.poll(()=>page.locator('.next-status-bar h1').innerText()).toBe('Inbox');
            if(width===390) {
              await page.getByRole('button',{name:'All apps',exact:true}).click({button:'right'});
              expect(await page.getByRole('menu').count()).toBe(0);
              const needs=page.locator('.next-status-bar .loom-pbar__needs');
              await needs.click();
              expect(new URL(page.url()).pathname).toBe('/p/inbox-preview');
              const bar=await page.locator('.next-status-bar').boundingBox();
              expect(bar!.height).toBeLessThan(40);
              expect(await page.locator('.next-status-bar .loom-tick__track').evaluate(el=>getComputedStyle(el).animationName)).toBe('none');
              await page.locator('.next-status-bar summary').click();
              await expect.poll(()=>page.getByRole('combobox',{name:'Look',exact:true}).isVisible()).toBe(true);
              await page.locator('.next-status-bar summary').click();
            }
            await expect.poll(()=>page.locator('[data-tile=inbox]').getByText('OK to run the backup now?',{exact:true}).count()).toBe(1);
            await reference.goto(old.base+(width<1024?'/inbox':'/inbox?t=*inbox'));
            if(width>=1024) {
              await expect.poll(()=>page.locator('.desk-rail-card').count()).toBe(1);
              await expect.poll(()=>reference.locator('.loom-arail').count()).toBe(1);
              const rail=await page.locator('.next-rail').boundingBox(),tile=await page.locator('[data-tile=inbox]').boundingBox();
              expect(Math.round(rail!.width)).toBe(width>=1440?320:296);expect(tile!.x+tile!.width).toBeLessThanOrEqual(rail!.x-9);
              expect(await page.locator('.next-rail button').allTextContents()).toContain('Asks youOK to run the backup now? ›');
              if(look==='neon'&&width===1280) {
              // Device hide choices: strips, overlays, persistence and no peek reflow.
              const choose=async(part:'rail'|'dock',label:string)=>{
                const target=part==='rail'?page.locator('.next-rail-edge').count().then(n=>n?page.locator('.next-rail-edge'):page.locator('.next-rail')):Promise.resolve(page.getByRole('button',{name:'All apps',exact:true}));
                await (await target).click({button:'right',force:true});
                await page.getByRole('menuitem',{name:label,exact:true}).click();
              };
              const tileBox=()=>page.locator('[data-tile=inbox]').boundingBox();
              await choose('rail','Minimize to strip');
              await expect.poll(()=>page.locator('.next-rail').isVisible()).toBe(false);
              expect(await page.locator('.next-rail-edge').getAttribute('data-attention')).toBe('true');
              const stripped=await tileBox();expect(stripped!.width).toBeGreaterThan(tile!.width);
              await page.getByRole('button',{name:'Show agents rail',exact:true}).click();
              await expect.poll(()=>page.locator('.next-rail').isVisible()).toBe(true);
              expect(await tileBox()).toEqual(stripped);
              await page.keyboard.press('Escape');
              await expect.poll(()=>page.locator('.next-rail').isVisible()).toBe(false);
              await choose('rail','Auto-hide');
              const automatic=await tileBox();
              await page.locator('.next-rail-edge').hover();
              await expect.poll(()=>page.locator('.next-rail').isVisible()).toBe(true);
              expect(await tileBox()).toEqual(automatic);
              await page.locator('[data-tile=inbox] .next-strip-title').click();
              await expect.poll(()=>page.locator('.next-rail').isVisible()).toBe(false);
              await page.reload();
              await expect.poll(()=>page.locator('.next-rail').getAttribute('data-mode')).toBe('auto');
              expect(await page.locator('.next-rail').isVisible()).toBe(false);
              await choose('rail','Always show');
              await expect.poll(()=>page.locator('.next-rail').isVisible()).toBe(true);
              await choose('dock','Minimize to strip');
              await expect.poll(()=>page.locator('.next-dock-bar').isVisible()).toBe(false);
              await expect.poll(async()=>(await tileBox())!.height).toBeGreaterThan(tile!.height);
              const hiddenDock=await tileBox();
              await page.getByRole('button',{name:'Show dock',exact:true}).click();
              await expect.poll(()=>page.locator('.next-dock-bar').isVisible()).toBe(true);
              expect(await tileBox()).toEqual(hiddenDock);
              await choose('dock','Auto-hide');
              await page.locator('.next-dock-edge').hover();
              await expect.poll(()=>page.locator('.next-dock-bar').isVisible()).toBe(true);
              await page.keyboard.press('Escape');
              await expect.poll(()=>page.locator('.next-dock-bar').isVisible()).toBe(false);
              await page.locator('.next-dock-edge').click({button:'right',force:true});
              await page.getByRole('menuitem',{name:'Always show',exact:true}).click();
              await expect.poll(()=>page.locator('.next-dock-bar').isVisible()).toBe(true);
              }
              // The real rail measures overflow and retries full cards when its room returns.
              await page.locator('.next-rail').evaluate(el=>(el as HTMLElement).style.height='120px');
              await expect.poll(()=>page.locator('.desk-agent-rail').getAttribute('data-fold')).toBe('true');
              expect(await page.locator('.desk-rail-compact').count()).toBe(4);
              await page.locator('.next-rail').evaluate(el=>(el as HTMLElement).style.height='3000px');
              await expect.poll(()=>page.locator('.desk-agent-rail').getAttribute('data-fold')).toBe(null);
              expect(await page.locator('.desk-rail-card').count()).toBe(5);
              await page.locator('.next-rail').evaluate(el=>(el as HTMLElement).style.removeProperty('height'));
              await expect.poll(()=>page.locator('.desk-agent-rail').getAttribute('data-fold')).toBe('true');
            }
          }
          if(surface==='companion') {
            await page.goto(app.url+'/p/comms-preview/thread/'+encodeURIComponent(commsId));
            await expect.poll(()=>page.locator('.comms-thread').count()).toBe(1);
            await reference.goto(old.base+'/comms/'+oldThread.id.slice(3)+(width<1024?'':'?t=*comms'));
            await expect.poll(()=>reference.locator('.comms-thread').count()).toBe(1);
            await expect.poll(()=>reference.locator('.comms-screen').isVisible()).toBe(true);
            await expect.poll(()=>page.locator('.next-comm-screen').count()).toBe(1);
            if(width>=1280){
              await expect.poll(()=>page.locator('.desk-rail-screen .next-comm-screen').count()).toBe(1);
              expect(await page.locator('.comms-thread .next-comm-screen').count()).toBe(0);
            }else{
              expect(await page.locator('.comms-thread .next-comm-screen').count()).toBe(1);
            }
            if(width>=1024){
              await expect.poll(()=>page.locator('.desk-rail-card[data-companion]').getAttribute('data-agent')).toBe('art');
              expect(await page.locator('.desk-agent-rail').locator(':scope > *').first().getAttribute('data-agent')).toBe('art');
            }else expect(await page.locator('.desk-rail-card[data-companion]').count()).toBe(0);
          }
          if(surface==='launcher') {
            if(look==='neon'&&width===1280){
              await page.getByRole('button',{name:'All apps',exact:true}).first().click();
              await expect.poll(()=>page.getByRole('dialog').getByRole('region',{name:'Work',exact:true}).count()).toBe(1);
              await page.getByRole('textbox',{name:'Find an app',exact:true}).fill('system');
              await expect.poll(()=>page.locator('.loom-lsec').count()).toBe(1);
              await expect.poll(()=>page.locator('.loom-lsec__name').textContent()).toBe('System');
              await page.getByRole('textbox',{name:'Find an app',exact:true}).fill('passkey');
              await expect.poll(()=>page.locator('.loom-lapp').count()).toBe(1);
              // Enter on the account shortcut must activate it, never the search's first result.
              await page.getByRole('textbox',{name:'Find an app',exact:true}).fill('inbox');
              await page.getByRole('button',{name:'Open your account',exact:true}).focus();
              await page.keyboard.press('Enter');
              await expect.poll(()=>page.locator('[data-tile=account]').count()).toBe(1);
              await expect.poll(()=>page.getByRole('dialog').count()).toBe(0);
              await page.getByRole('button',{name:'All apps',exact:true}).first().click();
              await page.getByRole('textbox',{name:'Find an app',exact:true}).fill('profile');
              await page.keyboard.press('Enter');
              expect(await page.locator('[data-tile=account]').count()).toBe(1);
              await page.getByRole('button',{name:'All apps',exact:true}).first().click();
              await page.getByRole('button',{name:'Close app launcher',exact:true}).focus();
              await page.keyboard.press('Enter');
              await expect.poll(()=>page.getByRole('dialog').count()).toBe(0);
              await page.getByRole('button',{name:'Close Your account',exact:true}).click();
              await expect.poll(()=>page.locator('[data-tile=account]').count()).toBe(0);
            }
            await page.getByRole('button',{name:'All apps',exact:true}).first().click();
            await expect.poll(()=>page.getByRole('textbox',{name:'Find an app',exact:true}).evaluate(el=>el===document.activeElement)).toBe(true);
            await page.getByRole('textbox',{name:'Find an app',exact:true}).fill('inbox');
            await expect.poll(()=>page.locator('.loom-lapp').count()).toBe(1);
            await page.keyboard.press('Escape');
            await expect.poll(()=>page.getByRole('dialog').count()).toBe(0);
            await page.getByRole('button',{name:'All apps',exact:true}).first().click();
            if(width<1024) { await reference.goto(old.base+'/setup'); await expect.poll(()=>reference.getByText('More',{exact:true}).count()).toBeGreaterThan(0); }
            else { await reference.keyboard.press('Control+Shift+Space'); await expect.poll(()=>reference.getByRole('textbox',{name:'Find an app',exact:true}).count()).toBe(1); }
          }
          await page.evaluate(()=>document.fonts.ready);await reference.evaluate(()=>document.fonts.ready);
          if(surface==='home'&&width===390) {
            // The long full question stays intact. Also show the rows below it, not just a top-of-page claim.
            await page.locator('.desk-home-compact').last().scrollIntoViewIfNeeded();
            await reference.locator('.loom-phome .loom-rrow').last().scrollIntoViewIfNeeded();
            const oldRows=await reference.screenshot({path:join(shots,`old-home-agents-${look}-${width}.png`),animations:'disabled'});
            const newRows=await page.screenshot({path:join(shots,`new-home-agents-${look}-${width}.png`),animations:'disabled'});
            await board.setViewportSize({width:width*2,height:932});
            await board.setContent(`<body style="margin:0;background:#17151e;color:#fff;font:14px monospace"><div style="display:flex"><section><p style="height:16px;margin:8px">OLD · Home agents · ${look} · ${width}px</p><img width="${width}" src="data:image/png;base64,${oldRows.toString('base64')}"></section><section><p style="height:16px;margin:8px">NEW · Home agents · ${look} · ${width}px</p><img width="${width}" src="data:image/png;base64,${newRows.toString('base64')}"></section></div></body>`);
            await board.screenshot({path:join(shots,`compare-home-agents-${look}-${width}.png`)});
            for(const [p,selector] of [[page,'.desk-home'],[reference,'.loom-phome']] as const)await p.locator(selector).evaluate(el=>{let node:HTMLElement|null=el as HTMLElement;while(node){node.scrollTop=0;node=node.parentElement;}});
          }
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
