/** One Home browser proof, run in CI; fixtures never read a live home. */
import { it, expect } from 'vitest';
import { existsSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { chromium } from 'playwright-core';
import { startLoom } from '../foundation.js';
import { FakeClock } from '../core/clock.js';
import { fixture, fixtureSharing, installFixture } from '../fixture.js';
import { runtimeStore } from '../pieces/runtime/store.js';
import { PeopleStore } from '../backends/people.js';
import { TokenDatabase } from '../core/household/tokens.js';
const root=resolve(import.meta.dirname,'../../dist/web');
const chrome=[process.env.LOOM_TEST_CHROME,'/usr/bin/google-chrome','/usr/bin/chromium',chromium.executablePath()].find(p=>p&&existsSync(p));
it.runIf(chrome && existsSync(join(root,'next.html')))('Home keeps idle owned cards, shares answers and Inbox counts across windows, and captures both looks',async()=>{
  const home=mkdtempSync(join(tmpdir(),'loom-home-browser-'));fixture(home);
  mkdirSync(join(home,'commons'),{recursive:true});
  const directory=new PeopleStore({dbPath:join(home,'commons/people.db')});
  directory.write({slug:'art',name:'Art E Fish',how:{kind:'agent'}});
  directory.write({slug:'mark',name:'Mark',how:{kind:'agent'}});
  directory.write({slug:'pond-bot',name:'Pond Bot',how:{kind:'agent'}});
  const owner={kind:'member' as const,id:'jonathan'};
  const loom=await startLoom({home,next:true,clock:new FakeClock(Date.parse('2026-11-13T08:00:00Z')),sharing:fixtureSharing,webRoot:root,install:app=>{installFixture(app);app.db.transaction(()=>new TokenDatabase(app.db).replace({v:1,tokens:[]},{}))();}});
  let serial=0;
  const raise=(input:object)=>{expect(loom.operations.call('direct',owner,'attention.raise',{agent:'art',answers:'yes-no',source:{kind:'piece',id:'fixture'},...input},`raise:${++serial}`).ok).toBe(true);};
  raise({id:'a-public',ask:'Continue the household rebuild?',why:'One shared set of asks keeps Home and the Inbox in agreement.',if_yes:'I build the remaining runtime connections.',if_no:'I stop and keep the preview available.',refs:['t-2205']});
  raise({id:'b-private',member:'jonathan',ask:'Private conversation needs you'});
  raise({id:'c-pond',project:'pond',ask:'Review the shared Pond plan?'});
  raise({id:'d-bot',agent:'pond-bot',project:'pond',ask:'Review the Pond release?'});
  expect(loom.operations.call('direct',{kind:'agent',id:'art'},'attention.reportStatus',{
    id:'art-work',agent:'art',state:'working',work:'Connecting the next Home panels',
    jobs:[{id:'task',label:'Finish the shared Home',href:'/p/tasks-preview/task/t-2205'},{id:'queued',label:'Waiting for the next runtime connection'}],
    watched:[{id:'pr',label:'Home preview pull request',href:'https://github.com/sleepunit-agents/loom/pull/927'},{id:'plain',label:'A reported item without a destination'}],
  },'home-work').ok).toBe(true);
  const scheduled=loom.operations.call('direct',owner,'clock.in',{agent:'art',when:'2h',prompt:'Private runtime words',note:'Review the next clock slice'},'home-clock');
  expect(scheduled.ok).toBe(true);if(!scheduled.ok)throw Error('Clock fixture failed');
  const wakeId=(scheduled.value as {id:string}).id;
  // Metadata-only fixture worker: these operations never start a process.
  const runtime=runtimeStore(loom.db);
  loom.db.transaction(()=>{
    runtime.put('box',{id:'fixture-worker',name:'Fixture worker',owner:'jonathan',local:false,mayHost:'*',lentTo:[],facts:[],labels:[],alwaysOn:false,reportOnly:false,createdAt:1},1);
    for(const agent of ['art','pond-bot'])runtime.put('settings',{id:agent,agent,boxes:['fixture-worker']},1);
  })();
  const queue=(agent:string,title:string,scope:object={})=>{
    const result=loom.operations.call('direct',owner,'runtime.queueBody',{agent,title,brief:'Private Runtime input must never appear on Home',...scope},`home-queue:${++serial}`);
    expect(result.ok).toBe(true);if(!result.ok)throw Error('Runtime queue fixture failed');return (result.value as {job:string}).job;
  };
  const current=queue('art','Inspect the rebuilt household Runtime');
  queue('art','Inspect the rebuilt household Runtime'); // Concurrent work with the same title stays separate.
  queue('pond-bot','Visible Pond Runtime work',{project:'pond'});
  queue('pond-bot','Owner-private Runtime work',{project:'pond',member:'jonathan'});
  expect(loom.operations.call('direct',owner,'runtime.configureHouse',{agent:'art',house:{repo:'/fixture/art'}},'home-runtime-house').ok).toBe(true);
  const runner={kind:'runner' as const,id:'fixture-worker'};
  expect(loom.operations.call('direct',runner,'runtime.claimJob',{job:current},'home-runtime-claim').ok).toBe(true);
  expect(loom.operations.call('direct',runner,'runtime.reportJob',{job:current,state:'running',log:'Private Runtime log must never appear on Home'},'home-runtime-running').ok).toBe(true);
  const browser=await chromium.launch({executablePath:chrome,args:['--no-sandbox']});
  try {
    const context=await browser.newContext({serviceWorkers:'block',viewport:{width:1280,height:900}});await context.grantPermissions(['local-network-access'],{origin:loom.url});
    const a=await context.newPage(),b=await context.newPage();
    const signIn=async(page:typeof a,member:string)=>{
      const link=loom.operations.call('direct',owner,'signin.link',{member});expect(link.ok).toBe(true);if(!link.ok)throw Error('Fixture sign-in failed');
      await page.goto(loom.url+(link.value as {path:string}).path);const response=page.waitForResponse(r=>r.request().method()==='POST');await page.getByRole('button',{name:'Sign in',exact:true}).click();expect((await response).status()).toBe(303);
    };
    await signIn(a,'jonathan');await Promise.all([a.goto(loom.url),b.goto(loom.url)]);
    const cards=(p:typeof a)=>p.locator('[data-attention-home] [aria-label$=" card"]');
    await expect.poll(()=>cards(a).evaluateAll(nodes=>nodes.map(n=>n.getAttribute('aria-label')))).toEqual(['Art E Fish card','Mark card']);
    await expect.poll(()=>b.getByRole('heading',{name:'Needs you · 4',exact:true}).count()).toBe(1);
    expect(await b.getByText('Nothing right now',{exact:true}).count()).toBe(1);
    await expect.poll(()=>b.getByRole('button',{name:'Finish the shared Home',exact:true}).count()).toBe(1);
    expect(await b.getByRole('link',{name:'Home preview pull request'}).getAttribute('href')).toBe('https://github.com/sleepunit-agents/loom/pull/927');
    for(const page of [a,b]) {
      const panel=page.getByRole('region',{name:'Art E Fish clock',exact:true});
      await expect.poll(()=>panel.getByText('Nov 13, 2026, 4:00 AM CT · Review the next clock slice',{exact:true}).count()).toBe(1);
      expect(await panel.getByRole('heading',{name:'Clock jobs · 1',exact:true}).count()).toBe(1);
      expect(await page.getByText('Private runtime words',{exact:true}).count()).toBe(0);
    }
    for(const page of [a,b]) {
      const panel=page.getByRole('region',{name:'Art E Fish runtime jobs',exact:true});
      await expect.poll(()=>panel.getByRole('heading',{name:'Runtime jobs · 2',exact:true}).count()).toBe(1);
      expect(await panel.getByRole('heading',{name:'Inspect the rebuilt household Runtime',exact:true}).count()).toBe(2);
      expect(await panel.getByText('running · Box fixture-worker',{exact:true}).count()).toBe(1);
      expect(await page.getByText('Private Runtime input must never appear on Home',{exact:true}).count()).toBe(0);
      expect(await page.getByText('Private Runtime log must never appear on Home',{exact:true}).count()).toBe(0);
    }
    await a.getByRole('button',{name:'Check again',exact:true}).click();await b.getByRole('button',{name:'Check again',exact:true}).click();
    const yes=(p:typeof a)=>p.getByRole('button',{name:'Yes',exact:true});await expect.poll(()=>yes(a).isEnabled()).toBe(true);await expect.poll(()=>yes(b).isEnabled()).toBe(true);
    const shots=resolve('artifacts/attention-home');mkdirSync(shots,{recursive:true});
    const overflows:unknown[]=[];
    for(const look of ['neon','daylight'])for(const width of [390,1280,1920]){
      await b.setViewportSize({width,height:900});
      // Shell choice is made at boot: open at each size so 390 exercises the actual phone shell.
      await b.goto(loom.url);await expect.poll(()=>cards(b).count()).toBe(2);
      await b.getByRole('button',{name:'Check again',exact:true}).click();await expect.poll(()=>yes(b).isEnabled()).toBe(true);
      await b.locator('[data-attention-home]').evaluate(node=>{node.scrollTop=0;});
      await b.evaluate(look=>{document.documentElement.dataset.look=look;document.documentElement.dataset.mode=look==='daylight'?'light':'dark';document.documentElement.dataset.motion='reduce';},look);
      const dimensions=await b.locator('[data-attention-home]').evaluate(node=>({
        home:[node.clientWidth,node.scrollWidth],page:[innerWidth,document.documentElement.scrollWidth],
        wide:[...node.querySelectorAll('*')].filter(el=>el.scrollWidth>el.clientWidth).map(el=>({tag:el.tagName,classes:el.className,width:el.clientWidth,scroll:el.scrollWidth})),
      }));
      writeFileSync(join(shots,`home-${look}-${width}-layout.json`),JSON.stringify(dimensions,null,2));
      if(dimensions.home[1]>dimensions.home[0] || dimensions.page[1]>dimensions.page[0])overflows.push({look,width,...dimensions});
      await b.screenshot({path:join(shots,`home-${look}-${width}.png`),fullPage:true,animations:'disabled'});
      await b.getByRole('region',{name:'Art E Fish clock',exact:true}).scrollIntoViewIfNeeded();
      await b.screenshot({path:join(shots,`home-clock-${look}-${width}.png`),fullPage:true,animations:'disabled'});
      await b.getByRole('region',{name:'Art E Fish runtime jobs',exact:true}).scrollIntoViewIfNeeded();
      await b.screenshot({path:join(shots,`home-runtime-${look}-${width}.png`),fullPage:true,animations:'disabled'});
      await b.getByRole('region',{name:'Art E Fish reported work',exact:true}).scrollIntoViewIfNeeded();
      await b.screenshot({path:join(shots,`home-work-${look}-${width}.png`),fullPage:true,animations:'disabled'});
    }
    expect(overflows).toEqual([]);
    expect(loom.operations.call('direct',runner,'runtime.reportJob',{job:current,state:'waiting'},'home-runtime-waiting').ok).toBe(true);
    for(const page of [a,b])await expect.poll(()=>page.getByRole('region',{name:'Art E Fish runtime jobs',exact:true}).getByText('waiting · Box fixture-worker',{exact:true}).count()).toBe(1);
    expect(loom.operations.call('direct',runner,'runtime.finishJob',{job:current,state:'done'},'home-runtime-done').ok).toBe(true);
    for(const page of [a,b]) {
      const panel=page.getByRole('region',{name:'Art E Fish runtime jobs',exact:true});
      await expect.poll(()=>panel.getByRole('heading',{name:'Runtime jobs · 1',exact:true}).count()).toBe(1);
      expect(await panel.getByText('waiting · Box fixture-worker',{exact:true}).count()).toBe(0);
    }
    expect(loom.operations.call('direct',owner,'clock.pause',{agent:'art'},'home-pause').ok).toBe(true);
    for(const page of [a,b])await expect.poll(()=>page.getByRole('region',{name:'Art E Fish clock',exact:true}).getByText('Clock paused',{exact:true}).count()).toBe(1);
    expect(loom.operations.call('direct',owner,'clock.cancel',{id:wakeId},'home-cancel').ok).toBe(true);
    expect(loom.operations.call('direct',owner,'clock.resume',{agent:'art'},'home-resume').ok).toBe(true);
    for(const page of [a,b]) {
      const panel=page.getByRole('region',{name:'Art E Fish clock',exact:true});
      await expect.poll(()=>panel.getByText('No clock jobs.',{exact:true}).count()).toBe(1);
      expect(await panel.getByText('No wake scheduled',{exact:true}).count()).toBe(1);
      expect(await panel.getByText('Review the next clock slice',{exact:true}).count()).toBe(0);
    }

    await yes(a).click();await expect.poll(()=>yes(b).count()).toBe(0);await expect.poll(()=>b.getByRole('heading',{name:'Needs you · 3',exact:true}).count()).toBe(1);
    await expect.poll(()=>b.getByText('Answer this in its private conversation. Private replies stay there.').count()).toBe(1);
    expect(await cards(b).count()).toBe(2);
    await expect.poll(()=>b.getByRole('region',{name:'Art E Fish last answer'}).count()).toBe(1);
    expect(await b.getByText(/yes · jonathan/).count()).toBe(1);
    await b.getByRole('button',{name:'Inbox',exact:true}).click();await expect.poll(()=>b.locator('[data-split-row]').count()).toBe(3);
    await b.goto(`${loom.url}/p/home-preview`);await expect.poll(()=>cards(b).count()).toBe(2);
    await b.getByRole('button',{name:'Finish the shared Home',exact:true}).click();
    await expect.poll(()=>new URL(b.url()).pathname).toBe('/p/tasks-preview/task/t-2205');
    await b.goto(`${loom.url}/p/home-preview`);
    directory.write({slug:'art',name:'Art the Fish'});
    await expect.poll(()=>cards(a).evaluateAll(nodes=>nodes.map(n=>n.getAttribute('aria-label')))).toEqual(['Art the Fish card','Mark card']);
    await expect.poll(()=>cards(b).evaluateAll(nodes=>nodes.map(n=>n.getAttribute('aria-label')))).toEqual(['Art the Fish card','Mark card']);
    await b.getByRole('button',{name:'Art the Fish in People',exact:true}).click();
    await expect.poll(()=>new URL(b.url()).pathname).toBe('/p/people-preview/person/art');
    await expect.poll(()=>b.getByRole('heading',{name:'Art the Fish',exact:true}).count()).toBe(1);
    const member=await browser.newContext({serviceWorkers:'block',viewport:{width:1280,height:900}});await member.grantPermissions(['local-network-access'],{origin:loom.url});
    const p=await member.newPage();await signIn(p,'pollock');await p.goto(loom.url);
    await expect.poll(()=>cards(p).evaluateAll(nodes=>nodes.map(n=>n.getAttribute('aria-label')))).toEqual(['pond-bot card']);
    expect(await p.getByRole('button',{name:'Pond Bot in People',exact:true}).count()).toBe(0);
    await expect.poll(()=>p.getByRole('heading',{name:'Needs you · 2',exact:true}).count()).toBe(1);
    const pondRuntime=p.getByRole('region',{name:'pond-bot runtime jobs',exact:true});
    await expect.poll(()=>pondRuntime.getByRole('heading',{name:'Visible Pond Runtime work',exact:true}).count()).toBe(1);
    expect(await pondRuntime.getByRole('heading',{name:'Runtime jobs · 1',exact:true}).count()).toBe(1);
    expect(await p.getByText('Owner-private Runtime work',{exact:true}).count()).toBe(0);
    expect(await p.getByText('Inspect the rebuilt household Runtime',{exact:true}).count()).toBe(0);
    expect(await p.getByText('Private conversation needs you',{exact:true}).count()).toBe(0);
    expect(await p.getByText('Connecting the next Home panels',{exact:true}).count()).toBe(0);
    expect(loom.operations.call('direct',owner,'tasks.close',{id:'t-1',actor:'jonathan',at:'2026-11-13T08:00:00Z'},'home-close-wait-task').ok).toBe(true);
    raise({id:'home-task-wait',ask:'Check the finished household work?',waits_on:{task:'t-1'}});
    await expect.poll(()=>loom.operations.call('direct',owner,'attention.get',{id:'home-task-wait'})).toMatchObject({ok:true,value:{state:'resolved',resolution:'t-1 is closed'}});
    await expect.poll(()=>a.getByRole('heading',{name:'Needs you · 3',exact:true}).count()).toBe(1);
    expect(await a.getByText('Check the finished household work?',{exact:true}).count()).toBe(0);
    await member.close();
  }finally{await browser.close();await loom.close();directory.close();rmSync(home,{recursive:true,force:true});}
},60_000);
