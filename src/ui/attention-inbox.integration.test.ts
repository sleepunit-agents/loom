/** One browser proof; CI owns Chromium and the six screenshot artifacts. */
import { it, expect } from 'vitest';
import { existsSync, mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { chromium } from 'playwright-core';
import { startLoom } from '../foundation.js';
import { FakeClock } from '../core/clock.js';
import { fixture, fixtureSharing, installFixture } from '../fixture.js';
import { TokenDatabase } from '../core/household/tokens.js';
import { installAttention } from '../pieces/attention/index.js';
const root=resolve(import.meta.dirname,'../../dist/web');
const chrome=[process.env.LOOM_TEST_CHROME,'/usr/bin/google-chrome','/usr/bin/chromium',chromium.executablePath()].find(p=>p&&existsSync(p));
it.runIf(chrome && existsSync(join(root,'next.html')))('Inbox confirms asks, answers once across windows, respects private scope and captures both looks',async()=>{
  const home=mkdtempSync(join(tmpdir(),'loom-inbox-browser-')); fixture(home);
  const clock=new FakeClock(Date.parse('2026-11-13T06:00:00Z'));
  const owner={kind:'member' as const,id:'jonathan'};
  const loom=await startLoom({home,clock,next:true,sharing:fixtureSharing,webRoot:root,install:app=>{installFixture(app);app.db.transaction(()=>new TokenDatabase(app.db).replace({v:1,tokens:[]},{}))();installAttention(app.db,app.operations,app.live,fixtureSharing);}});
  let serial=0;
  const raise=(input:object)=>{const result=loom.operations.call('direct',owner,'attention.raise',{agent:'art',answers:'yes-no',source:{kind:'piece',id:'fixture'},...input},`raise:${++serial}`);expect(result.ok).toBe(true);};
  raise({id:'public',ask:'Continue the Attention rebuild?',why:'The shared Inbox should show one current question in every window.',if_yes:'I build the remaining Home cards.',if_no:'I stop and keep this preview available.',refs:['t-2205','sleepunit-agents/loom#912']});
  raise({id:'private',member:'jonathan',ask:'Private conversation needs you'});
  raise({id:'pond',agent:'pond-bot',project:'pond',ask:'Review the shared Pond plan?'});
  const browser=await chromium.launch({executablePath:chrome,args:['--no-sandbox']});
  try {
    const context=await browser.newContext({serviceWorkers:'block',viewport:{width:1280,height:900}});
    await context.grantPermissions(['local-network-access'],{origin:loom.url});
    const a=await context.newPage(),b=await context.newPage();
    const signIn=async(page:typeof a,member:string)=>{
      const link=loom.operations.call('direct',owner,'signin.link',{member});
      expect(link.ok).toBe(true);if(!link.ok)throw Error('Fixture sign-in failed');
      await page.goto(loom.url+(link.value as {path:string}).path);
      const response=page.waitForResponse(r=>r.request().method()==='POST');
      await page.getByRole('button',{name:'Sign in',exact:true}).click();expect((await response).status()).toBe(303);
    };
    await signIn(a,'jonathan');
    await Promise.all([a.goto(`${loom.url}/p/inbox-preview/ask/public`),b.goto(`${loom.url}/p/inbox-preview/ask/public`)]);
    await a.getByRole('button',{name:'Check again',exact:true}).click();
    await b.getByRole('button',{name:'Check again',exact:true}).click();
    const yes=(p:typeof a)=>p.getByRole('button',{name:'Yes',exact:true});
    await expect.poll(()=>yes(a).isEnabled()).toBe(true);await expect.poll(()=>yes(b).isEnabled()).toBe(true);
    const shots=resolve('artifacts/attention-inbox');mkdirSync(shots,{recursive:true});
    for(const look of ['neon','daylight']) for(const width of [390,1280,1920]) {
      await b.setViewportSize({width,height:900});
      await b.evaluate(look=>{document.documentElement.dataset.look=look;document.documentElement.dataset.mode=look==='daylight'?'light':'dark';document.documentElement.dataset.motion='reduce';},look);
      await expect.poll(()=>b.locator('.loom-split').getAttribute('data-mode')).toBe(width<640?'one':'three');
      expect(await b.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
      await b.screenshot({path:join(shots,`inbox-${look}-${width}.png`),fullPage:true,animations:'disabled'});
    }
    await yes(a).click();
    await expect.poll(()=>yes(b).count()).toBe(0);
    await expect.poll(()=>b.getByText(/yes · jonathan/).count()).toBe(1);
    expect(loom.operations.call('direct',owner,'attention.get',{id:'public'})).toMatchObject({ok:true,value:{answer:{kind:'yes',by:owner}}});
    await b.setViewportSize({width:1280,height:900});
    await b.getByRole('button',{name:/Answered/}).click();
    await expect.poll(()=>b.locator('[data-split-row]').filter({hasText:'Continue the Attention rebuild?'}).count()).toBe(1);
    await b.goto(`${loom.url}/p/inbox-preview/ask/private`);
    await expect.poll(()=>b.getByText('Answer this in its private conversation. Private replies stay there.').count()).toBe(1);
    expect(await yes(b).count()).toBe(0);
    const member=await browser.newContext({serviceWorkers:'block',viewport:{width:1280,height:900}});
    await member.grantPermissions(['local-network-access'],{origin:loom.url});
    const p=await member.newPage();await signIn(p,'pollock');await p.goto(`${loom.url}/p/inbox-preview`);
    await expect.poll(()=>p.locator('[data-split-row]').filter({hasText:'Review the shared Pond plan?'}).count()).toBe(1);
    expect(await p.getByText('Private conversation needs you').count()).toBe(0);
    expect(await p.getByText('Continue the Attention rebuild?').count()).toBe(0);
    await member.close();
  } finally {await browser.close();await loom.close();rmSync(home,{recursive:true,force:true});}
},60_000);
