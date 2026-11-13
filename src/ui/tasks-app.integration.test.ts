/** One browser proof, against a disposable in-process fixture and fake clock. */
import { it, expect } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, rmSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, extname, resolve } from 'node:path';
import { chromium } from 'playwright-core';
import { startLoom } from '../foundation.js';
import { FakeClock } from '../core/clock.js';
import { fixture, installFixture } from '../fixture.js';
const root = resolve(import.meta.dirname, '../../dist/web');
const chrome = [process.env.LOOM_TEST_CHROME, '/usr/bin/google-chrome', '/usr/bin/chromium', chromium.executablePath()].find(p => p && existsSync(p));
it.runIf(chrome && existsSync(join(root, 'index.html')))('Tasks updates two windows, evicts closed Ready work, and shows Pollock only his projects', async () => {
  const home = mkdtempSync(join(tmpdir(), 'loom-tasks-browser-'));
  fixture(home);
  const clock = new FakeClock(Date.parse('2026-11-12T12:00:00Z'));
  const loom = await startLoom({ home, clock, install: installFixture,
    authenticate: req => {
      const id = req.headers.cookie?.includes('fixture=pollock') ? 'pollock' : req.headers.cookie?.includes('fixture=jonathan') ? 'jonathan' : undefined;
      return id ? { viewer: { kind:'member',id },valid:()=>true } : undefined;
    } });
  loom.operations.call('direct',{kind:'member',id:'jonathan'},'tasks.update',{id:'t-1',cli:true,set:{goal:'Pond work reaches every window as it changes.',why:'Shared work needs one current picture.',doneWhen:'Comments and status arrive without a reload.',description:'Build the first Tasks app on the live data path.\nLinked work: sleepunit-agents/loom#837'}},'fixture:detail');
  const browser = await chromium.launch({ executablePath:chrome,args:['--no-sandbox'] });
  try {
    const context = await browser.newContext({ serviceWorkers:'block',viewport:{width:1280,height:900} });
    await context.grantPermissions(['local-network-access'],{origin:loom.url});
    await context.addCookies([{name:'fixture',value:'jonathan',url:loom.url}]);
    const staticFiles = async (route: import('playwright-core').Route) => {
      const url=new URL(route.request().url());
      if(url.pathname==='/live'||url.pathname.startsWith('/api/')) return route.continue();
      const path=url.pathname.startsWith('/app/')?resolve(root,url.pathname.slice(5)):join(root,'index.html');
      if(!path.startsWith(`${root}/`)||!existsSync(path)) return route.fulfill({status:404,body:''});
      await route.fulfill({body:readFileSync(path),contentType:({'.js':'text/javascript','.css':'text/css','.html':'text/html','.woff2':'font/woff2'} as Record<string,string>)[extname(path)]??'application/octet-stream'});
    };
    await context.route('**/*',staticFiles);
    const a=await context.newPage(),b=await context.newPage();
    await Promise.all([a.goto(`${loom.url}/_dev/tasks`),b.goto(`${loom.url}/_dev/tasks`)]);
    const row=(page:typeof a,title:string)=>page.locator('[data-split-row]').filter({hasText:title});
    await expect.poll(()=>row(b,'Pond work').count()).toBe(1);
    await row(a,'Pond work').click(); await row(b,'Pond work').click();
    await a.getByRole('button',{name:'Comment',exact:true}).first().click();
    await a.getByRole('textbox',{name:'Comment',exact:true}).fill('A comment shared between windows');
    await a.getByRole('button',{name:'Comment',exact:true}).last().click();
    await expect.poll(()=>b.getByText('A comment shared between windows',{exact:true}).count()).toBe(1);
    await a.getByRole('button',{name:'Back to task',exact:true}).click();
    const shots=process.env.LOOM_TEST_SHOTS??resolve('artifacts/tasks-app');mkdirSync(shots,{recursive:true});
    for(const look of ['neon','daylight']) for(const width of [390,1280,1920]) {
      await b.setViewportSize({width,height:900});
      await b.evaluate(look=>{document.documentElement.dataset.look=look;document.documentElement.dataset.mode=look==='daylight'?'light':'dark';document.documentElement.dataset.motion='reduce';},look);
      await expect.poll(()=>b.locator('.loom-split').getAttribute('data-mode')).toBe(width<640?'one':'three');
      await b.screenshot({path:join(shots,`tasks-${look}-${width}.png`),fullPage:true,animations:'disabled'});
    }
    await a.getByRole('button',{name:'Close task',exact:true}).click();
    await a.getByRole('textbox',{name:'Reason',exact:true}).fill('Complete in the fixture');
    await a.getByRole('button',{name:'Close task',exact:true}).click();
    await expect.poll(()=>row(b,'Pond work').count()).toBe(0);
    const pollock=await browser.newContext({serviceWorkers:'block',viewport:{width:1280,height:900}});
    await pollock.grantPermissions(['local-network-access'],{origin:loom.url});
    await pollock.addCookies([{name:'fixture',value:'pollock',url:loom.url}]);await pollock.route('**/*',staticFiles);
    const p=await pollock.newPage();await p.goto(`${loom.url}/_dev/tasks`);
    await expect.poll(()=>p.getByRole('button',{name:'Create task',exact:true}).isEnabled()).toBe(true);
    await p.getByRole('button',{name:/All open/}).click();
    await expect.poll(()=>row(p,'Pond-bot own work').count()).toBe(1);
    expect(await row(p,'Other project work').count()).toBe(0); expect(await row(p,'Unfiled household work').count()).toBe(0);
    await p.getByRole('button',{name:/Recently closed/}).click();
    await expect.poll(()=>row(p,'Pond work').count()).toBe(1);
    await pollock.close();
    await b.getByRole('button',{name:/Recently closed/}).click();
    clock.advance(8*86400_000);
    await expect.poll(()=>row(b,'Pond work').count()).toBe(0);
    await b.getByRole('button',{name:'Load older closed tasks',exact:true}).click();
    await expect.poll(()=>row(b,'Pond work').count()).toBe(1);
    await row(b,'Pond work').click();
    await expect.poll(()=>b.getByText('A comment shared between windows',{exact:true}).count()).toBe(1);
    await b.getByRole('button',{name:'Reopen',exact:true}).first().click();
    await b.getByRole('button',{name:'Reopen',exact:true}).last().click();
    await a.getByRole('button',{name:/Ready/}).click();
    await expect.poll(()=>row(a,'Pond work').count()).toBe(1);
  } finally { await browser.close();await loom.close();rmSync(home,{recursive:true,force:true}); }
},60_000);
