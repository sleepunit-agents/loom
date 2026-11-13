/** One browser proof: two windows and all six visual fixtures, on an in-process home. */
import { it, expect } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, rmSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, extname, resolve } from 'node:path';
import { chromium } from 'playwright-core';
import { startLoom } from '../foundation.js';
import { FakeClock } from '../core/clock.js';
import { installFixture, fixtureSharing } from '../fixture.js';
import { installComms } from '../pieces/comms/index.js';
import { loadKey } from '../pieces/comms/crypto.js';
import { draftKey } from '../../web/src/pieces/comms/drafts.js';
const root=resolve(import.meta.dirname,'../../dist/web');
const chrome=[process.env.LOOM_TEST_CHROME,'/usr/bin/google-chrome','/usr/bin/chromium',chromium.executablePath()].find(p=>p&&existsSync(p));
it.runIf(chrome&&existsSync(join(root,'index.html')))('Comms sends once across two windows, retains a device draft, sanitises replies and captures both looks',async()=>{
 const home=mkdtempSync(join(tmpdir(),'comms-browser-')),clock=new FakeClock(),key=await loadKey(home);let comms!:ReturnType<typeof installComms>;
 const loom=await startLoom({home,clock,authenticate:()=>({viewer:{kind:'member',id:'jonathan'},window:true,valid:()=>true}),install:app=>{
  installFixture(app);
  comms=installComms({...app,clock,key,sharing:fixtureSharing,hold:effect=>effect(),attention:{answer:()=>({ok:true,value:{answered:true}})},runtime:{
   deliver:async d=>{await comms.post(d.agent,d.thread,{id:`reply-${d.seq}`,kind:'reply',text:'Fixture reply **received**. [Unsafe](javascript:alert(1)) <script>bad()</script> ![no image](https://example.com/image.png)'});},end:async()=>{},
  }});
 }});
 const first=await loom.operations.callAsync('socket',{kind:'member',id:'jonathan'},'comms.open',{agent:'art',id:'fixturefirstaaaa',text:'Comms fixture message'},'fixture-first',true);
 if(!first.ok)throw new Error('fixture failed');const place=(first.value as {thread:string}).thread;await comms.deliver('art',place,1);
 const browser=await chromium.launch({executablePath:chrome,args:['--no-sandbox']});
 try{
  const context=await browser.newContext({serviceWorkers:'block',viewport:{width:1280,height:900}});await context.grantPermissions(['local-network-access'],{origin:loom.url});
  await context.route('**/*',async route=>{const url=new URL(route.request().url());if(url.pathname==='/live'||url.pathname.startsWith('/api/'))return route.continue();const path=url.pathname.startsWith('/app/')?resolve(root,url.pathname.slice(5)):join(root,'index.html');if(!path.startsWith(root+'/')||!existsSync(path))return route.fulfill({status:404,body:''});await route.fulfill({body:readFileSync(path),contentType:({'.js':'text/javascript','.css':'text/css','.html':'text/html','.woff2':'font/woff2'} as Record<string,string>)[extname(path)]??'application/octet-stream'});});
  const a=await context.newPage(),b=await context.newPage();await Promise.all([a.goto(`${loom.url}/p/comms-preview`),b.goto(`${loom.url}/p/comms-preview`)]);
  const row=(page:typeof a)=>page.locator('[data-split-row]').filter({hasText:'New thread with art'});
  await expect.poll(()=>row(a).count()).toBe(1);await row(a).click();await row(b).click();
  await expect.poll(()=>a.getByText('Comms fixture message',{exact:true}).count()).toBe(1);
  await a.getByRole('textbox',{name:'Message',exact:true}).fill('A device draft');
  const storageKey=`${draftKey('jonathan',place)}:v1`;
  const saved=await a.evaluate(k=>JSON.parse(localStorage.getItem(k)!),storageKey);expect(saved.id).toMatch(/^[a-z2-7]{16}$/);
  await a.reload();await expect.poll(()=>a.getByRole('textbox',{name:'Message',exact:true}).inputValue()).toBe('A device draft');
  expect(await a.evaluate(k=>JSON.parse(localStorage.getItem(k)!),storageKey)).toEqual(saved);
  await a.getByRole('textbox',{name:'Message',exact:true}).fill('Sent from the first window');
  const sent=await a.evaluate(k=>JSON.parse(localStorage.getItem(k)!),storageKey);expect(sent.id).not.toBe(saved.id);expect(sent.id).toMatch(/^[a-z2-7]{16}$/);
  await a.getByRole('button',{name:'Send',exact:true}).click();
  await expect.poll(()=>b.getByText('Sent from the first window',{exact:true}).count()).toBe(1);
  expect(loom.db.prepare('SELECT id FROM comms_messages WHERE thread=? AND id=?').get(place,sent.id)).toBeTruthy();
  await expect.poll(()=>a.evaluate(k=>localStorage.getItem(k),storageKey)).toBe(null);
  expect(await b.locator('[aria-label="Thread messages"] img').count()).toBe(0);expect(await b.locator('a[href^="javascript:"]').count()).toBe(0);expect(await b.locator('[aria-label="Thread messages"] script').count()).toBe(0);
  const shots=process.env.LOOM_TEST_SHOTS??resolve('artifacts/comms-app');mkdirSync(shots,{recursive:true});
  for(const look of ['neon','daylight'])for(const width of [390,1280,1920]){await b.setViewportSize({width,height:900});await b.evaluate(look=>{document.documentElement.dataset.look=look;document.documentElement.dataset.mode=look==='daylight'?'light':'dark';document.documentElement.dataset.motion='reduce';},look);await expect.poll(()=>b.locator('.loom-split').getAttribute('data-mode')).toBe(width<640?'one':'three');await b.screenshot({path:join(shots,`comms-${look}-${width}.png`),fullPage:true,animations:'disabled'});}
  await a.getByRole('button',{name:'Delete',exact:true}).click();await a.getByRole('button',{name:'Keep thread',exact:true}).click();expect(await a.getByRole('textbox',{name:'Message',exact:true}).count()).toBe(1);
 }finally{await browser.close();await comms.close();await loom.close();rmSync(home,{recursive:true,force:true});}
},60000);
