/** One browser proof: real operations/live feed, two windows, six looks/widths. */
import { it, expect } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, rmSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, extname, resolve } from 'node:path';
import { chromium } from 'playwright-core';
import { startLoom } from '../foundation.js';
import { FakeClock } from '../core/clock.js';
import { fixture, installFixture, fixtureSharing } from '../fixture.js';
import { installClock } from '../pieces/clock/index.js';
const root = resolve(import.meta.dirname, '../../dist/web');
const chrome = [process.env.LOOM_TEST_CHROME, '/usr/bin/google-chrome', '/usr/bin/chromium', chromium.executablePath()].find(p => p && existsSync(p));
it.runIf(chrome && existsSync(join(root, 'index.html')))('Clock shares changes across two windows, holds dispatch, and covers phone and desktop looks', async () => {
  const home = mkdtempSync(join(tmpdir(), 'loom-clock-browser-')); fixture(home);
  const clock = new FakeClock(Date.parse('2026-11-13T12:00:00Z'));
  const loom = await startLoom({home,clock,install(app) {
    installFixture(app);
    const jobs = installClock(app.db,app.operations,app.live,fixtureSharing, {approvals:{check:()=>({state:'pending'}),subscribe:()=>()=>{}}}); app.onClose(jobs.close);
  },authenticate: req => ({viewer:{kind:'member',id:req.headers.cookie?.includes('fixture=pollock') ? 'pollock' : 'jonathan'},valid:()=>true})});
  let seq=0;
  const call = (op:string,input:object,who='jonathan') => { const r=loom.operations.call('direct',{kind:'member',id:who},`clock.${op}`,input,`fixture:clock:${++seq}`);expect(r.ok).toBe(true);return r; };
  call('in',{agent:'art',prompt:'Review today’s work',note:'Morning review',when:'2h'});
  call('park',{agent:'art',prompt:'Continue after the answer',note:'Waiting for the owner',on:'a-fixture'});
  call('in',{agent:'art',member:'jonathan',prompt:'Private words',note:'Private clock work',when:'3h'});
  call('in',{agent:'pond-bot',project:'pond',prompt:'Check pond',note:'Pond check',when:'1h'},'pollock');
  call('laneSet',{name:'morning',agent:'art',text:'Look at the queue and choose useful work.',note:'Daily planning',at:'08:31',days:'Mon-Fri'});
  const browser=await chromium.launch({executablePath:chrome,args:['--no-sandbox']});
  try {
    const context=await browser.newContext({serviceWorkers:'block',viewport:{width:1280,height:900}});
    await context.grantPermissions(['local-network-access'],{origin:loom.url});
    const staticFiles=async(route:import('playwright-core').Route)=>{
      const url=new URL(route.request().url());if(url.pathname==='/live'||url.pathname.startsWith('/api/'))return route.continue();
      const path=url.pathname.startsWith('/app/')?resolve(root,url.pathname.slice(5)):join(root,'index.html');
      if(!path.startsWith(`${root}/`)||!existsSync(path))return route.fulfill({status:404,body:''});
      return route.fulfill({body:readFileSync(path),contentType:({'.js':'text/javascript','.css':'text/css','.html':'text/html','.woff2':'font/woff2'} as Record<string,string>)[extname(path)]??'application/octet-stream'});
    };
    await context.route('**/*',staticFiles);
    const a=await context.newPage(),b=await context.newPage();
    await Promise.all([a.goto(`${loom.url}/p/clock-preview`),b.goto(`${loom.url}/p/clock-preview`)]);
    const row=(p:typeof a,text:string)=>p.locator('[data-split-row]').filter({hasText:text});
    await expect.poll(()=>row(b,'Morning review').count()).toBe(1);
    await a.getByRole('button',{name:'Create wake',exact:true}).click();
    await a.getByRole('textbox',{name:'Note',exact:true}).fill('Shared follow-up');
    await a.getByRole('textbox',{name:'In',exact:true}).fill('4h');
    await a.getByRole('textbox',{name:'Words or file path',exact:true}).fill('Finish the useful work');
    await a.getByRole('button',{name:'Save wake',exact:true}).click();
    await expect.poll(()=>row(b,'Shared follow-up').count()).toBe(1);
    await a.getByRole('button',{name:'Back to clock',exact:true}).click();
    await a.getByRole('button',{name:'Pause art',exact:true}).click();
    await a.getByRole('region',{name:'Confirm clock action'}).getByRole('button',{name:'Pause art',exact:true}).click();
    await expect.poll(()=>b.getByRole('button',{name:'Resume art',exact:true}).count()).toBe(1);
    await row(b,'Waiting for the owner').click();
    await expect.poll(()=>b.getByText('Parked · awaiting answer',{exact:false}).count()).toBeGreaterThan(0);
    expect(await b.getByText('Waiting on a-fixture until',{exact:false}).count()).toBe(1);
    await row(a,'Shared follow-up').click();
    await a.getByRole('button',{name:'Cancel wake',exact:true}).click();
    await a.getByRole('region',{name:'Confirm clock action'}).getByRole('button',{name:'Cancel wake',exact:true}).click();
    await expect.poll(()=>row(b,'Shared follow-up').count()).toBe(0);
    await b.getByRole('button',{name:/Household lanes/}).click();
    await row(b,'morning').click();
    await b.getByRole('button',{name:'Edit lane',exact:true}).click();
    await b.getByRole('textbox',{name:'Lane text',exact:true}).fill('The edited lane text reaches every window.');
    await b.getByRole('button',{name:'Save lane',exact:true}).click();
    await a.getByRole('button',{name:/Household lanes/}).click();await row(a,'morning').click();
    await expect.poll(()=>a.getByText('The edited lane text reaches every window.',{exact:true}).count()).toBe(1);
    await b.getByRole('button',{name:'Back to clock',exact:true}).click();
    await row(b,'morning').click();
    await b.getByRole('textbox',{name:'Assign to',exact:true}).fill('mark');await b.getByRole('button',{name:'Reassign lane',exact:true}).click();
    await b.getByRole('button',{name:'Confirm reassignment',exact:true}).click();
    await expect.poll(()=>a.getByText('mark · Enabled',{exact:true}).count()).toBe(1);
    await b.reload();await expect.poll(()=>b.getByText('mark · Enabled',{exact:true}).count()).toBe(1);
    const shots=process.env.LOOM_TEST_SHOTS??resolve('artifacts/clock-app');mkdirSync(shots,{recursive:true});
    for(const look of ['neon','daylight'])for(const width of [390,1280,1920]){
      await b.setViewportSize({width,height:900});await b.evaluate(look=>{document.documentElement.dataset.look=look;document.documentElement.dataset.mode=look==='daylight'?'light':'dark';document.documentElement.dataset.motion='reduce';},look);
      await expect.poll(()=>b.locator('.loom-split').getAttribute('data-mode')).toBe(width<640?'one':'three');
      await b.screenshot({path:join(shots,`clock-${look}-${width}.png`),fullPage:true,animations:'disabled'});
    }
    // Confirmations remain usable while the phone reader covers its list.
    await b.setViewportSize({width:390,height:900});await b.getByRole('button',{name:'Run once',exact:true}).click();
    await b.getByRole('region',{name:'Confirm clock action'}).getByRole('button',{name:'Run once',exact:true}).click();
    await expect.poll(()=>b.getByText('Saved',{exact:true}).count()).toBe(1);
    clock.advance(0);
    await expect.poll(()=>{const r=loom.operations.call('direct',{kind:'member',id:'jonathan'},'clock.list',{});return r.ok&&(r.value as Array<{hold?:string}>).some(w=>w.hold==='staging');}).toBe(true);
    const guest=await browser.newContext({serviceWorkers:'block',viewport:{width:1280,height:900}});await guest.grantPermissions(['local-network-access'],{origin:loom.url});await guest.addCookies([{name:'fixture',value:'pollock',url:loom.url}]);await guest.route('**/*',staticFiles);
    const p=await guest.newPage();await p.goto(`${loom.url}/p/clock-preview`);await expect.poll(()=>row(p,'Pond check').count()).toBe(1);
    expect(await row(p,'Private clock work').count()).toBe(0);expect(await row(p,'Morning review').count()).toBe(0);
    await guest.close();
  }finally{await browser.close();await loom.close();rmSync(home,{recursive:true,force:true});}
},60_000);
