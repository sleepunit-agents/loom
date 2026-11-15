/** One CI-only browser test, two windows and six responsive look screenshots. */
import {memorySharedFixture,signInMemory} from './memory-shared-fixture.js';
import { expect,it } from 'vitest';
import { existsSync,mkdtempSync,mkdirSync,rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join,resolve } from 'node:path';
import { chromium } from 'playwright-core';
import { FakeClock } from '../core/clock.js';
import { PeopleStore } from '../backends/people.js';
const root=resolve(import.meta.dirname,'../../dist/web');
const chrome=[process.env.LOOM_TEST_CHROME,'/usr/bin/google-chrome','/usr/bin/chromium','/usr/bin/chromium-browser',chromium.executablePath()].find(p=>p&&existsSync(p));
const enabled=!!process.env.CI&&process.env.LOOM_PEOPLE_EVIDENCE==='1';
if(enabled&&process.env.RUNNER_ENVIRONMENT==='self-hosted')throw new Error('People browser evidence requires a hosted runner');
if(enabled&&(!chrome||!existsSync(join(root,'next.html'))))throw new Error('People browser evidence requires Chrome and built next app in CI');
it.runIf(enabled&&chrome&&existsSync(join(root,'next.html')))('People filters, authorized relationships, outside updates and add in two windows',async()=>{
  const home=mkdtempSync(join(tmpdir(),'people-app-'));const clock=new FakeClock(Date.parse('2026-11-13T12:00:00Z'));

  for(const directory of ['commons','agents/art','agents/other'])mkdirSync(join(home,directory),{recursive:true});
  const directory=new PeopleStore({dbPath:join(home,'commons/people.db'),now:()=>clock.now()});
  const relationship=new PeopleStore({dbPath:join(home,'agents/art/memories.db'),now:()=>clock.now()});
  const other=new PeopleStore({dbPath:join(home,'agents/other/memories.db'),now:()=>clock.now()});
  directory.write({slug:'jonathan',name:'Jonathan Barket',where:{github:{value:'jbarket',source:'Owner supplied'}},how:{pronouns:'he/him'}});
  directory.write({slug:'art',name:'Art E Fish',how:{kind:'agent'}});
  directory.write({slug:'casey',name:'Casey Smith'});
  relationship.write({slug:'jonathan',name:'Jonathan Barket',summary:'Builds the household',how:{mode:'direct'},may:[{text:'May discuss projects',source:'Jonathan'}]});
  other.write({slug:'casey',name:'Casey Smith',summary:'Knows the workshop'});
  const fixture=await memorySharedFixture({home,clock,webRoot:root,agents:['art','other']}),{app}=fixture;
  const browser=await chromium.launch({executablePath:chrome,args:['--no-sandbox']});
  try {
    const context=await browser.newContext({serviceWorkers:'block',viewport:{width:1280,height:900}});
    const a=await context.newPage(),b=await context.newPage();await b.setViewportSize({width:390,height:900});
    const diagnostics:string[]=[];
    for(const [name,page] of [['desktop',a],['phone',b]] as const){
      page.on('pageerror',error=>diagnostics.push(`${name}: ${error.message}`));
      page.on('websocket',socket=>{
        socket.on('close',()=>diagnostics.push(`${name}: websocket closed`));
        socket.on('framereceived',({payload})=>{
          try{const frame=JSON.parse(String(payload));if(frame.ok===false)diagnostics.push(`${name}: ${frame.code}: ${frame.message}`);}catch{/* not JSON */}
        });
      });
    }
    try {
    await signInMemory(a,fixture);
    await Promise.all([a.goto(`${app.url}/p/people-preview`),b.goto(`${app.url}/p/people-preview`)]);
    const row=(p:typeof a,name:string)=>p.locator('[data-split-row]').filter({hasText:name});
    await expect.poll(()=>row(b,'Jonathan Barket').count()).toBe(1);
    await a.getByRole('combobox',{name:'Known to agent',exact:true}).selectOption('art');
    await expect.poll(()=>row(a,'Casey Smith').count()).toBe(0);expect(await row(a,'Jonathan Barket').count()).toBe(1);
    await a.getByRole('combobox',{name:'Known to agent',exact:true}).selectOption('');
    await a.getByRole('button',{name:/^Agents/}).click();await expect.poll(()=>row(a,'Art E Fish').count()).toBe(1);expect(await row(a,'Jonathan Barket').count()).toBe(0);
    await a.getByRole('button',{name:/^Everyone/}).click();
    await row(a,'Jonathan Barket').click();await row(b,'Jonathan Barket').click();
    await expect.poll(()=>b.getByText('Builds the household',{exact:true}).count()).toBe(1);
    expect(await b.locator('article a[href="https://github.com/jbarket"]').count()).toBe(1);
    expect(await b.getByText('Owner supplied',{exact:false}).count()).toBe(1);
    expect(await b.getByText('May discuss projects',{exact:false}).count()).toBe(1);
    const shots=resolve('artifacts/people-app');mkdirSync(shots,{recursive:true});
    for(const look of ['neon','daylight'])for(const width of [390,1280,1920]){
      const page=width<640?b:a;await page.setViewportSize({width,height:900});
      await page.evaluate(look=>{document.documentElement.dataset.look=look;document.documentElement.dataset.mode=look==='daylight'?'light':'dark';document.documentElement.dataset.motion='reduce';},look);
      await expect.poll(()=>page.locator('.loom-split').getAttribute('data-mode')).toBe(width<640?'one':'three');
      await page.screenshot({path:join(shots,`people-${look}-${width}.png`),fullPage:true,animations:'disabled'});
    }
    relationship.write({slug:'jonathan',summary:'Updated from outside the app'});
    await expect.poll(()=>b.getByText('Updated from outside the app',{exact:true}).count()).toBe(1);
    await b.reload();await expect.poll(()=>b.getByText('Updated from outside the app',{exact:true}).count()).toBe(1);
    // Bounded fixture trace: distinguish a missed press from a rejected route.
    // No text, HTML, input values, sign-in URLs or history payloads are retained.
    await b.evaluate(()=>{
      const button=document.querySelector('.loom-split__back');
      const trace:object[]=[];
      (window as unknown as {peopleBackTrace:object[]}).peopleBackTrace=trace;
      const snapshot=(type:string,event:Event)=>{
        if(trace.length>=32)return;
        const target=event.target instanceof Element ? event.target : null;
        const rect=button?.getBoundingClientRect(),split=button?.closest('.loom-split');
        const reader=button?.closest('.loom-split__reader');
        trace.push({type,back:target?.closest('button')===button,connected:!!button?.isConnected,
          prevented:event.defaultPrevented,point:event instanceof MouseEvent?[event.clientX,event.clientY]:null,
          rect:rect?[rect.x,rect.y,rect.width,rect.height]:null,
          readerScroll:reader?.scrollTop,pageScroll:scrollY,
          target:target===reader?'reader':target?.closest('[data-split-row]')?'row':target?.closest('article')?'article':'other',
          focused:document.activeElement===button,open:split?.hasAttribute('data-open')});
      };
      for(const type of ['pointerdown','mousedown','focusin','pointerup','mouseup','click','scroll'])
        document.addEventListener(type,event=>{
          snapshot(type,event);
          if(type==='pointerdown'||type==='click')queueMicrotask(()=>snapshot(`after ${type}`,event));
        },{capture:true});
    });
    await b.getByRole('button',{name:'Contacts',exact:true}).last().click();
    await expect.poll(()=>b.locator('.loom-split').getAttribute('data-open')).toBe(null);
    await b.getByRole('searchbox',{name:'Search people',exact:true}).fill('Casey');
    await expect.poll(()=>row(b,'Jonathan Barket').count()).toBe(0);expect(await row(b,'Casey Smith').count()).toBe(1);
    await b.getByRole('searchbox',{name:'Search people',exact:true}).fill('');
    await b.getByRole('button',{name:'Add a person',exact:true}).click();
    await b.getByRole('textbox',{name:'Name',exact:true}).fill('Robin New');
    await b.getByRole('textbox',{name:'Who they are',exact:true}).fill('Helps with the workshop');
    await b.getByRole('combobox',{name:'Reach them on',exact:true}).selectOption('email');
    await b.getByRole('textbox',{name:'Their handle or address',exact:true}).fill('robin@example.com');
    await b.getByRole('button',{name:'Add',exact:true}).click();
    await expect.poll(()=>b.getByText('Added to People',{exact:false}).count()).toBe(1);
    await expect.poll(()=>row(a,'Robin New').count()).toBe(1);
    await b.getByRole('button',{name:'Open person',exact:true}).click();
    await expect.poll(()=>b.getByRole('heading',{name:'Robin New',exact:true}).count()).toBe(1);
    expect(await b.getByText('Helps with the workshop',{exact:true}).count()).toBe(1);
    directory.archive({slug:'casey',reason:'fixture archive',actor:'owner'});
    await expect.poll(()=>row(a,'Casey Smith').count()).toBe(0);
    }catch(error){
      // Fixture-only content; omit addresses, sign-in links, cookies and input values.
      for(const [name,page] of [['desktop',a],['phone',b]] as const){
        const state=await page.evaluate(()=>{
          const knownPath=(value:unknown)=>typeof value==='string' && /^\/p\/people-preview(?:\/person\/(?:jonathan|casey|art))?$/.test(value)?value:'other';
          const tile=document.querySelector('[data-tile="people"]'),split=tile?.querySelector('.loom-split');
          const saved=history.state?.loomNext;
          const savedTile=Array.isArray(saved?.tiles)?saved.tiles.find((t:{id?:string})=>t.id==='people'):undefined;
          return {backTrace:(window as unknown as {peopleBackTrace?:object[]}).peopleBackTrace,
            path:knownPath(location.pathname),route:knownPath(savedTile?.trail?.[savedTile?.at]),
            tile:!!tile,hidden:tile?.hasAttribute('hidden'),inert:!!tile?.closest('[inert]'),focused:tile?.hasAttribute('data-focused'),
            mode:split?.getAttribute('data-mode'),open:split?.hasAttribute('data-open'),
            rows:tile?.querySelectorAll('[data-split-row]').length??0,
            backButtons:tile?.querySelectorAll('.loom-split__back').length??0};
        }).catch(()=>({unavailable:true}));
        diagnostics.push(`${name} People view: ${JSON.stringify(state)}`);
      }
      console.error('People fixture diagnostics',diagnostics);throw error;
    }
  } finally {await browser.close();await fixture.close();directory.close();relationship.close();other.close();rmSync(home,{recursive:true,force:true});}
},60_000);
