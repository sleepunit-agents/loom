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
it.runIf(chrome && existsSync(join(root, 'index.html')))('Project sharing creates projects and changes members and agents across two windows', async () => {
  const home = mkdtempSync(join(tmpdir(), 'loom-tasks-browser-'));
  fixture(home);
  const clock = new FakeClock(Date.parse('2026-11-12T12:00:00Z'));
  const loom = await startLoom({ home, clock, install: installFixture,
    authenticate: req => {
      const id = req.headers.cookie?.includes('fixture=pollock') ? 'pollock' : req.headers.cookie?.includes('fixture=jonathan') ? 'jonathan' : undefined;
      return id ? { viewer: { kind:'member',id },valid:()=>true } : undefined;
    } });
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
    await Promise.all([a.goto(`${loom.url}/p/sharing-preview`),b.goto(`${loom.url}/p/sharing-preview`)]);
    await expect.poll(()=>a.getByRole('textbox',{name:'Name',exact:true}).count()).toBe(1);
    await a.getByRole('textbox',{name:'Name',exact:true}).fill('Garden');
    await a.getByRole('textbox',{name:'Slug',exact:true}).fill('garden');
    await a.getByRole('button',{name:'Create project',exact:true}).click();
    const row=(page:typeof a,title:string)=>page.locator('[data-split-row]').filter({hasText:title});
    await expect.poll(()=>row(b,'Garden').count()).toBe(1);
    await a.getByRole('button',{name:'Create project',exact:true}).click();
    await expect.poll(()=>a.getByRole('alert').textContent()).toContain('conflict: Project already exists');
    expect(await a.getByRole('textbox',{name:'Name',exact:true}).inputValue()).toBe('Garden');
    await row(a,'Garden').click(); await row(b,'Garden').click();
    await a.getByRole('checkbox',{name:'pollock',exact:true}).check();
    await a.getByRole('button',{name:'Save members',exact:true}).click();
    await expect.poll(()=>b.getByRole('checkbox',{name:'pollock',exact:true}).isChecked()).toBe(true);
    await a.getByRole('checkbox',{name:'mark',exact:true}).check();
    await a.getByRole('button',{name:'Save agents',exact:true}).click();
    await expect.poll(()=>b.getByRole('checkbox',{name:'mark',exact:true}).isChecked()).toBe(true);
    await b.reload();
    await expect.poll(()=>row(b,'Garden').count()).toBe(1); await row(b,'Garden').click();
    await expect.poll(()=>b.getByRole('checkbox',{name:'mark',exact:true}).isChecked()).toBe(true);
    const shots=process.env.LOOM_TEST_SHOTS??resolve('artifacts/sharing-app');mkdirSync(shots,{recursive:true});
    for(const look of ['neon','daylight']) for(const width of [390,1280,1920]) {
      await b.setViewportSize({width,height:900});
      await b.evaluate(look=>{document.documentElement.dataset.look=look;document.documentElement.dataset.mode=look==='daylight'?'light':'dark';document.documentElement.dataset.motion='reduce';},look);
      await b.screenshot({path:join(shots,`sharing-${look}-${width}.png`),fullPage:true,animations:'disabled'});
    }
    await a.getByRole('checkbox',{name:'pollock',exact:true}).uncheck();
    await a.getByRole('button',{name:'Save members',exact:true}).click();
    await expect.poll(()=>b.getByRole('checkbox',{name:'pollock',exact:true}).isChecked()).toBe(false);
    const pollock=await browser.newContext({serviceWorkers:'block',viewport:{width:1280,height:900}});
    await pollock.grantPermissions(['local-network-access'],{origin:loom.url});
    await pollock.addCookies([{name:'fixture',value:'pollock',url:loom.url}]);await pollock.route('**/*',staticFiles);
    const p=await pollock.newPage();await p.goto(`${loom.url}/p/sharing-preview`);
    await expect.poll(()=>p.getByText('Household owners manage sharing',{exact:true}).count()).toBe(1);
    expect(await p.getByRole('button',{name:'Create project',exact:true}).count()).toBe(0);
    await pollock.close();
  } finally { await browser.close();await loom.close();rmSync(home,{recursive:true,force:true}); }
},60_000);
