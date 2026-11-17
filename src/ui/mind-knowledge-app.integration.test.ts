/** One two-window proof; CI alone runs Chrome. LOOM_SHOTS retains six look/width images. */
import {memorySharedFixture,signInMemory} from './memory-shared.fixture.js';
import { expect, it } from 'vitest';
import { existsSync, mkdtempSync, mkdirSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { chromium, type Route } from 'playwright-core';
import { FakeClock } from '../core/clock.js';
import { KnowledgePages } from '../../test/fixtures/knowledge-pages.js';
import Database from 'better-sqlite3';
import {migrateMindReceipts} from '../pieces/mind/receipt-schema.js';
const root=resolve(import.meta.dirname,'../../dist/web');
const chrome=[process.env.LOOM_TEST_CHROME,'/usr/bin/google-chrome','/usr/bin/chromium','/usr/bin/chromium-browser',chromium.executablePath()].find(p=>p&&existsSync(p));
if(process.env.CI && (!chrome || !existsSync(join(root,'next.html')))) throw new Error('Knowledge browser evidence requires Chrome and the built next app in CI');
it.runIf(chrome&&existsSync(join(root,'next.html')))('Knowledge reads and checks in two windows, follows citations, ages and removes pages',async()=>{
  const home=mkdtempSync(join(tmpdir(),'knowledge-app-'));

  const source=new KnowledgePages({dbPath:join(home,'commons/knowledge.db')});
  await source.writePage({slug:'six-voices',title:'Six voices',domain:'music/norns',verified_at:'2026-11-10T12:00:00Z',body:'softcut has **six voices**. See [[clock-tempo]].',citations:[{claim:'Six voices',source_kind:'web',source_locator:'https://example.com/voices',excerpt:'six'}]});
  await source.writePage({slug:'clock-tempo',title:'Clock tempo',domain:'music/norns',verified_at:'2026-11-10T12:00:00Z',body:'Set the clock tempo with params.'});
  await source.writePage({slug:'backup',title:'Nightly backup',domain:'ours/homelab',verified_at:'2026-11-10T12:00:00Z',body:'Backups run overnight.'});
  // This fixture owns new files; the server never upgrades existing sources.
  const prepared=new Database(join(home,'commons/knowledge.db'));try{migrateMindReceipts(prepared);}finally{prepared.close();}
  const clock=new FakeClock(Date.parse('2026-11-12T12:00:00Z'));
  const fixture=await memorySharedFixture({home,clock,webRoot:root,agents:['art']}),{app}=fixture;
  const browser=await chromium.launch({executablePath:chrome,args:['--no-sandbox']});
  try{
    const context=await browser.newContext({serviceWorkers:'block',viewport:{width:1280,height:900}});
    const manifest=JSON.parse(readFileSync(join(root,'.vite/manifest.json'),'utf8')) as Record<string,{file:string}>;
    const barAsset=manifest['src/pieces/attention/bar.tsx']?.file;
    if(!barAsset)throw Error('Knowledge fixture needs the lazy status bar asset');
    let holdBar=true;const barRequests:Route[]=[];
    const a=await context.newPage(),b=await context.newPage();await b.setViewportSize({width:390,height:900});
    await b.route(`**/app/${barAsset}`,route=>{if(holdBar)barRequests.push(route);else return route.continue();});
    // Keep fixture diagnostics only on failure; never include sign-in links or cookies.
    const diagnostics:string[]=[];
    for(const [name,page] of [['desktop',a],['phone',b]] as const){
      page.on('pageerror',error=>diagnostics.push(`${name}: ${error.message}`));
      page.on('websocket',socket=>socket.on('framereceived',({payload})=>{
        try{const frame=JSON.parse(String(payload));if(frame.ok===false)diagnostics.push(`${name}: ${frame.code}: ${frame.message}`);}catch{/* not a JSON frame */}
      }));
    }
    try{
    // Exercise the real signed-in window resolver: a synthetic member cannot
    // subscribe to browser-only shell records.
    const signIn=async()=>{
      await signInMemory(a,fixture);
      await Promise.all([a.goto(`${app.url}/p/knowledge-preview`),b.goto(`${app.url}/p/knowledge-preview`,{waitUntil:'domcontentloaded'})]);
    };
    await signIn();
    const row=(p:typeof a,title:string)=>p.locator('[data-split-row]').filter({hasText:title});
    await expect.poll(()=>row(a,'Six voices').count()).toBe(1);
    await expect.poll(()=>row(b,'Six voices').count()).toBe(1);
    await a.setViewportSize({width:1280,height:900});
    await b.getByRole('button',{name:/^ours/}).click();
    await expect.poll(()=>row(b,'Six voices').count()).toBe(0);
    await expect.poll(()=>row(b,'Nightly backup').count()).toBe(1);
    await b.getByRole('button',{name:/Recently verified/}).click();
    await expect.poll(()=>row(b,'Six voices').count()).toBe(1);
    await row(a,'Six voices').click();await row(b,'Six voices').click();
    await expect.poll(()=>b.locator('article strong').textContent()).toBe('six voices');
    await expect.poll(()=>b.locator('article a').filter({hasText:'https://example.com/voices'}).getAttribute('href')).toBe('https://example.com/voices');
    expect(await b.locator('article dd').textContent()).toContain('Six voices');
    await a.getByRole('button',{name:'Still true',exact:true}).click();
    await expect.poll(()=>b.getByText('Last check by owner',{exact:true}).count()).toBe(1);
    await b.reload({waitUntil:'domcontentloaded'});await expect.poll(()=>b.getByText('Last check by owner',{exact:true}).count()).toBe(1);
    expect(await source.getVerifications('six-voices')).toHaveLength(1);
    await a.getByRole('button',{name:'Check again',exact:true}).click();
    await expect.poll(()=>b.getByText(/Asked to be checked again/).count()).toBe(1);
    // Trace only this fixture's citation, never arbitrary links or page words.
    // A successful Playwright click can still lose its target between down/up.
    await b.evaluate(()=>{
      const link=document.querySelector('article a[href="https://loom.invalid/knowledge/clock-tempo"]');
      const trace:string[]=[];
      (window as unknown as {knowledgeClickTrace:string[]}).knowledgeClickTrace=trace;
      const tile=link?.closest('[data-tile]'),reader=link?.closest('.loom-split__reader');
      const header=link?.closest('article')?.querySelector('header');
      let complete=false;
      const geometry=(element:Element|null|undefined)=>{
        const r=element?.getBoundingClientRect();return r?[r.x,r.y,r.width,r.height]:null;
      };
      const snapshot=(type:string,event?:Event)=>{
        if(complete||trace.length>=32)return;
        const target=event?.target instanceof Element?event.target:null;
        const look=document.documentElement.dataset.look;
        // Capture before/hover geometry, ancestor scroll, header row heights and
        // font readiness. Link focus and tile focus are separate fixed flags.
        trace.push(JSON.stringify({type,citation:target?.closest('a')===link,
          connected:!!link?.isConnected,prevented:event?.defaultPrevented??false,
          target:target===reader?'reader':target?.closest('.loom-prose')?'prose':target?.closest('article')?'article':'other',
          point:event instanceof MouseEvent?[event.clientX,event.clientY]:undefined,rect:geometry(link),
          readerScroll:reader?.scrollTop,pageScroll:scrollY,
          focused:document.activeElement===link,tileFocused:tile?.hasAttribute('data-focused')??false,
          fontsReady:document.fonts.status==='loaded',look:['neon','lowlight','daylight'].includes(look??'')?look:'other',
          header:geometry(header),paragraphs:[...header?.querySelectorAll('p')??[]].map(geometry),
          ancestors:['.loom-split__reader','.loom-split','.next-page','.next-tile','.next-ground'].map(selector=>{
            const element=link?.closest(selector);return {rect:geometry(element),scroll:element?[element.scrollLeft,element.scrollTop]:null};
          })}));
      };
      const observer=new MutationObserver(()=>snapshot('header mutation'));
      if(header)observer.observe(header,{subtree:true,childList:true,characterData:true});
      const fonts=()=>snapshot('fonts loaded');document.fonts.addEventListener('loadingdone',fonts);
      const listeners:{type:string;handler:(event:Event)=>void}[]=[];
      snapshot('before click');
      for(const type of ['pointerover','pointermove','pointerdown','mousedown','focusin','pointerup','mouseup','click','scroll']){
        const handler=(event:Event)=>{
          snapshot(type,event);
          if(type==='click'||type==='pointerdown')queueMicrotask(()=>{
            snapshot(`after ${type}`,event);
            if(type==='click'){
              complete=true;observer.disconnect();document.fonts.removeEventListener('loadingdone',fonts);
              for(const listener of listeners)document.removeEventListener(listener.type,listener.handler,true);
            }
          });
        };
        listeners.push({type,handler});document.addEventListener(type,handler,{capture:true});
      }
    });
    const citation=b.locator('article a[href^="https://loom.invalid/knowledge/"]');
    await citation.scrollIntoViewIfNeeded();
    await expect.poll(()=>barRequests.some(route=>!route.request().failure())).toBe(true);
    const before=await b.locator('.next-ground').boundingBox(),hit=await citation.boundingBox();
    if(!before||!hit)throw Error('Knowledge fixture citation is not visible');
    await b.mouse.move(hit.x+hit.width/2,hit.y+hit.height/2);await b.mouse.down();
    try {
      // Force the module to arrive between press and release, without a sleep.
      holdBar=false;await Promise.all(barRequests.splice(0).filter(route=>!route.request().failure()).map(route=>route.continue()));
      await expect.poll(()=>b.locator('.next-status-bar').count()).toBe(1);
      const after=await b.locator('.next-ground').boundingBox();
      expect(after?.y).toBe(before.y);
    } finally {await b.mouse.up();}
    await expect.poll(()=>new URL(b.url()).pathname).toBe('/p/knowledge-preview/page/clock-tempo');
    await expect.poll(()=>b.getByRole('heading',{name:'Clock tempo',exact:true}).count()).toBe(1);
    await b.locator('article').getByRole('button',{name:'Six voices',exact:true}).click();
    await expect.poll(()=>b.getByRole('heading',{name:'Six voices',exact:true}).count()).toBe(1);
    const shots=process.env.LOOM_SHOTS;if(shots)mkdirSync(shots,{recursive:true});
    for(const look of ['neon','daylight'])for(const width of [390,1280,1920]){
      const target=width<640?b:a;
      await target.setViewportSize({width,height:900});
      await target.evaluate(look=>{document.documentElement.dataset.look=look;document.documentElement.dataset.mode=look==='daylight'?'light':'dark';document.documentElement.dataset.motion='reduce';},look);
      await expect.poll(()=>target.locator('.loom-split').getAttribute('data-mode')).toBe(width<640?'one':'three');
      if(shots)await target.screenshot({path:join(shots,`knowledge-${look}-${width}.png`),fullPage:true,animations:'disabled'});
    }
    await b.setViewportSize({width:390,height:900});await b.getByRole('button',{name:'Knowledge',exact:true}).last().click();
    await expect.poll(()=>row(b,'Clock tempo').isVisible()).toBe(true);
    await b.getByRole('searchbox',{name:'Search knowledge',exact:true}).fill('backup');
    await expect.poll(()=>row(b,'Six voices').count()).toBe(0);expect(await row(b,'Nightly backup').count()).toBe(1);
    await source.archivePage({slug:'six-voices'});
    await expect.poll(()=>a.getByText('This page is no longer available',{exact:true}).count()).toBe(1);
    await b.getByRole('searchbox',{name:'Search knowledge',exact:true}).fill('');
    await b.getByRole('button',{name:/Due a check/}).first().click();
    await expect.poll(()=>row(b,'Clock tempo').count()).toBe(0);
    // Age this fictional source record through the same backend notification
    // path as the archive above. Advancing the whole program by a month would
    // replay every Runtime sweep; exact clock boundaries have Node coverage.
    await source.writePage({slug:'clock-tempo',title:'Clock tempo',domain:'music/norns',verified_at:'2026-10-10T12:00:00Z',body:'Set the clock tempo with params.'});
    await expect.poll(()=>row(b,'Clock tempo').count()).toBe(1);
    await b.getByRole('button',{name:'Add a fact',exact:true}).click();
    await b.getByRole('textbox',{name:'Title',exact:true}).fill('A shared new fact');
    await b.getByRole('textbox',{name:'Topic',exact:true}).fill('systems');
    await b.getByRole('textbox',{name:'What it says',exact:true}).fill('Added through the new Knowledge app.');
    await b.getByRole('button',{name:'Add',exact:true}).click();
    await expect.poll(()=>b.getByText('Added to Knowledge',{exact:false}).count()).toBe(1);
    await expect.poll(()=>row(a,'A shared new fact').count()).toBe(1);
    await b.getByRole('button',{name:'Open fact',exact:true}).click();
    await expect.poll(()=>b.getByRole('heading',{name:'A shared new fact',exact:true}).count()).toBe(1);
    }catch(error){
      for(const [name,page] of [['desktop',a],['phone',b]] as const){
        // Inspect the actual shell and reader. Never serialize URLs, history
        // payloads, HTML, or arbitrary text: those may contain sign-in links.
        const state=await page.evaluate(()=>{
          const knownPath=(value:unknown)=>typeof value==='string' && /^\/p\/knowledge-preview(?:\/page\/(?:six-voices|clock-tempo|backup))?$/.test(value) ? value : 'other';
          const shell=document.querySelector('[data-shell]');
          const tile=document.querySelector('[data-tile="knowledge"]');
          const split=tile?.querySelector('.loom-split');
          const saved=history.state?.loomNext;
          const savedTile=Array.isArray(saved?.tiles) ? saved.tiles.find((t:{id?:string})=>t.id==='knowledge') : undefined;
          const text=tile?.textContent ?? '';
          return {
            clickTrace:(window as unknown as {knowledgeClickTrace?:string[]}).knowledgeClickTrace,
            path:knownPath(location.pathname),
            route:knownPath(savedTile?.trail?.[savedTile?.at]),
            shell:shell?.getAttribute('data-shell') ?? null,
            tile:!!tile, hidden:tile?.hasAttribute('hidden') ?? null,
            inert:!!tile?.closest('[inert]'), focused:tile?.getAttribute('data-focused') ?? null,
            split:split?.getAttribute('data-mode') ?? null, readerOpen:split?.getAttribute('data-open') ?? null,
            rows:tile?.querySelectorAll('[data-split-row]').length ?? 0,
            articles:tile?.querySelectorAll('article').length ?? 0,
            sixVoices:[...tile?.querySelectorAll('h1') ?? []].some(h=>h.textContent==='Six voices'),
            clockTempo:[...tile?.querySelectorAll('h1') ?? []].some(h=>h.textContent==='Clock tempo'),
            loading:text.includes('Opening page') || text.includes('Opening knowledge'),
            denied:text.includes('You don’t have access to Knowledge.'),
            offline:text.includes('Connection lost.'),
            unavailable:text.includes('This page is no longer available'),
          };
        }).catch(()=>({unavailable:true}));
        diagnostics.push(`${name} Knowledge state: ${JSON.stringify(state)}`);
      }
      console.error('Knowledge fixture diagnostics',diagnostics);throw error;
    }
  }finally{await browser.close();await fixture.close();source.close();rmSync(home,{recursive:true,force:true});}
},60_000);
