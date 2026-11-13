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
it.runIf(chrome && existsSync(join(root, 'index.html')))('Approvals confirms open cards, updates two windows and keeps six responsive views', async () => {
  const home = mkdtempSync(join(tmpdir(), 'loom-approvals-browser-'));
  fixture(home);
  const clock = new FakeClock(Date.parse('2026-11-12T12:00:00Z'));
  const loom = await startLoom({ home, clock, install: installFixture,
    authenticate: req => {
      const id = req.headers.cookie?.includes('fixture=pollock') ? 'pollock' : req.headers.cookie?.includes('fixture=jonathan') ? 'jonathan' : undefined;
      return id ? { viewer: { kind:'member',id },valid:()=>true } : undefined;
    } });
  const seeded=loom.operations.call('direct',{kind:'agent',id:'art'},'approvals.request',{
    kind:'merge',target:`github:acme/app#12@${'a'.repeat(40)}`,
    ask:'Merge the page fix?',why:'The page opens correctly after this fix.',
    if_yes:'I merge the fix.',if_no:'I leave the change open.',
    details:'The change repairs the missing page and includes its regression test.',
  },'fixture:approval');
  if(!seeded.ok)throw Error(seeded.message);
  const approval=seeded.value as {id:string};
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
    await Promise.all([a.goto(`${loom.url}/p/approvals-preview`),b.goto(`${loom.url}/p/approvals-preview`)]);
    const row=(page:typeof a,title:string)=>page.locator('[data-split-row]').filter({hasText:title});
    await expect.poll(()=>row(b,'Merge the page fix?').count()).toBe(1);
    await row(a,'Merge the page fix?').click(); await row(b,'Merge the page fix?').click();
    await expect.poll(()=>a.getByRole('button',{name:'Allow',exact:true}).count()).toBe(1);
    await expect.poll(()=>b.getByRole('button',{name:'Allow',exact:true}).count()).toBe(1);
    expect(new URL(b.url()).pathname).toBe(`/p/approvals-preview/approval/${approval.id}`);
    const shots=process.env.LOOM_TEST_SHOTS??resolve('artifacts/approvals-app');mkdirSync(shots,{recursive:true});
    for(const look of ['neon','daylight']) for(const width of [390,1280,1920]) {
      await b.setViewportSize({width,height:900});
      await b.evaluate(look=>{document.documentElement.dataset.look=look;document.documentElement.dataset.mode=look==='daylight'?'light':'dark';document.documentElement.dataset.motion='reduce';},look);
      await expect.poll(()=>b.locator('.loom-split').getAttribute('data-mode')).toBe(width<640?'one':'three');
      await b.screenshot({path:join(shots,`approvals-${look}-${width}.png`),fullPage:true,animations:'disabled'});
    }
    await a.getByRole('button',{name:'Deny',exact:true}).click();
    await expect.poll(()=>b.getByRole('button',{name:'Allow',exact:true}).count()).toBe(0);
    await expect.poll(()=>row(b,'Merge the page fix?').count()).toBe(0);
    expect(loom.operations.call('direct',{kind:'member',id:'jonathan'},'approvals.answer',{id:approval.id,action:'allow'},'stale')).toMatchObject({ok:false,code:'denied'});
    await b.getByRole('button',{name:'History',exact:true}).click();
    await expect.poll(()=>row(b,'Merge the page fix?').count()).toBe(1);
    await row(b,'Merge the page fix?').click();
    expect(await b.getByRole('button',{name:'Allow',exact:true}).count()).toBe(0);
    await b.getByRole('button',{name:'Rules',exact:true}).click();
    await expect.poll(()=>b.getByRole('form',{name:'Set standing rule'}).count()).toBe(1);
    await b.getByRole('textbox',{name:'Scope',exact:true}).fill('github:acme/*');
    await b.getByRole('button',{name:'Save rule',exact:true}).click();
    await expect.poll(()=>b.getByText('github:acme/*',{exact:true}).count()).toBe(1);
  } finally { await browser.close();await loom.close();rmSync(home,{recursive:true,force:true}); }
},60_000);
