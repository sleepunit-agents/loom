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
 const home=mkdtempSync(join(tmpdir(),'comms-browser-')),clock=new FakeClock(),key=await loadKey(home);const starts:{seq:number;generation?:number}[]=[];let comms!:ReturnType<typeof installComms>;let reply=true;
 const loom=await startLoom({home,clock,authenticate:()=>({viewer:{kind:'member',id:'jonathan'},window:true,valid:()=>true}),install:app=>{
  installFixture(app);
  comms=installComms({...app,clock,key,sharing:fixtureSharing,hold:effect=>effect(),attention:{answer:()=>({ok:true,value:{answered:true}})},runtime:{
   deliver:async d=>{starts.push({seq:d.seq,generation:d.generation});if(!reply)return;await comms.post(d.agent,d.thread,{id:`reply-${d.seq}`,kind:'reply',text:'Fixture reply **received**. [Unsafe](javascript:alert(1)) <script>bad()</script> ![no image](https://example.com/image.png)'});},end:async()=>{},
  }});
 }});
 const first=await loom.operations.callAsync('socket',{kind:'member',id:'jonathan'},'comms.open',{agent:'art',id:'fixturefirstaaaa',text:'Comms fixture message'},'fixture-first',true);
 if(!first.ok)throw new Error('fixture failed');const place=(first.value as {thread:string}).thread;await comms.deliver('art',place,1);
 const browser=await chromium.launch({executablePath:chrome,args:['--no-sandbox']});
 try{
  const context=await browser.newContext({serviceWorkers:'block',viewport:{width:1280,height:900}});await context.grantPermissions(['local-network-access'],{origin:loom.url});
  await context.route('**/*',async route=>{const url=new URL(route.request().url());if(url.pathname==='/live'||url.pathname.startsWith('/api/'))return route.continue();const path=url.pathname.startsWith('/app/')?resolve(root,url.pathname.slice(5)):join(root,'index.html');if(!path.startsWith(root+'/')||!existsSync(path))return route.fulfill({status:404,body:''});await route.fulfill({body:readFileSync(path),contentType:({'.js':'text/javascript','.css':'text/css','.html':'text/html','.woff2':'font/woff2'} as Record<string,string>)[extname(path)]??'application/octet-stream'});});
  const a=await context.newPage(),b=await context.newPage();await b.clock.install({time:clock.now()});await Promise.all([a.goto(`${loom.url}/p/comms-preview`),b.goto(`${loom.url}/p/comms-preview`)]);
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
  // Body activity comes from the thread subscription; it must disappear when the turn ends.
  comms.status('art',place,'working');comms.activity('art',place,{at:clock.now(),tokens:41900});
  await expect.poll(()=>b.getByLabel('Body activity').textContent()).toContain('41,900 tokens');
  expect(await b.getByLabel('Body activity').locator('time').getAttribute('datetime')).toBe(new Date(clock.now()).toISOString());
  comms.activity('art',place,{at:clock.now()+1});
  await expect.poll(()=>b.getByLabel('Body activity').textContent()).not.toContain('tokens');
  comms.status('art',place,'done');
  await expect.poll(()=>b.getByLabel('Body activity').count()).toBe(0);
  await expect.poll(()=>b.getByLabel('Working status').count()).toBe(0);
  comms.status('art',place,'working');comms.activity('art',place,{at:clock.now()+2,tokens:0});
  await expect.poll(()=>b.getByLabel('Body activity').textContent()).toContain('0 tokens');
  await expect.poll(()=>b.getByLabel('Working status').getAttribute('data-alive')).toBe('working');
  // Browser time alone changes the display; no new server record is needed.
  await b.clock.fastForward(121000);
  await expect.poll(()=>b.getByLabel('Working status').getAttribute('data-alive')).toBe('quiet');
  expect(await b.getByLabel('Working status').textContent()).toContain('art is still running');
  await b.clock.fastForward(600000);
  await expect.poll(()=>b.getByLabel('Working status').getAttribute('data-alive')).toBe('stuck');
  expect(await b.getByLabel('Working status').textContent()).toContain('it may be stuck');
  await b.clock.setSystemTime(clock.now());
  await comms.post('art',place,{id:'limited-step',kind:'card',text:'Run fixture tests',tool:'shell',state:'running',step:{t0:new Date(clock.now()).toISOString(),limit:1}});
  await b.clock.fastForward(31001);
  await expect.poll(()=>b.getByLabel('Working status').textContent()).toContain('past its limit');
  await b.clock.setSystemTime(clock.now());
  // A queued start retry shows its encrypted time; Live progress removes the old promise.
  comms.status('art',place,'done');reply=false;
  const sentRetry=await loom.operations.callAsync('socket',{kind:'member',id:'jonathan'},'comms.send',{thread:place,id:'retrystartaaaaaa',text:'A queued start'},'fixture-retry',true);
  if(!sentRetry.ok)throw new Error('retry fixture failed');
  const seq=(sentRetry.value as {seq:number}).seq;
  // Retry notices follow runtime acceptance; do not race the delivery receipt write.
  await comms.deliver('art',place,seq);
  expect(comms.trace('art',place).messages.find(m=>m.seq===seq)?.delivery).toBe('delivered');
  const retryAt=new Date(clock.now()+60000).toISOString();
  await comms.startNotice('art',place,{kind:'start-retry',seq,attempt:2,retryAt,reason:'private fixture host reason'});
  await expect.poll(()=>b.getByLabel('Start retry').count()).toBe(1);
  expect(await b.getByLabel('Start retry').locator('time').getAttribute('datetime')).toBe(retryAt);
  expect(await b.getByLabel('Start retry').textContent()).toContain('CT');
  expect(await b.getByLabel('Start retry').textContent()).not.toContain('private fixture host reason');
  const shots=process.env.LOOM_TEST_SHOTS??resolve('artifacts/comms-app');mkdirSync(shots,{recursive:true});
  for(const look of ['neon','daylight'])for(const width of [390,1280,1920]){await b.setViewportSize({width,height:900});await b.evaluate(look=>{document.documentElement.dataset.look=look;document.documentElement.dataset.mode=look==='daylight'?'light':'dark';document.documentElement.dataset.motion='reduce';},look);await expect.poll(()=>b.locator('.loom-split').getAttribute('data-mode')).toBe(width<640?'one':'three');await b.screenshot({path:join(shots,`comms-${look}-${width}.png`),fullPage:true,animations:'disabled'});}
  await comms.startNotice('art',place,{kind:'start-failed',seq,attempt:3});
  await expect.poll(()=>b.getByRole('button',{name:'Send again',exact:true}).count()).toBe(1);
  await b.getByRole('button',{name:'Send again',exact:true}).click();
  await expect.poll(()=>starts.filter(d=>d.seq===seq&&d.generation===1).length).toBe(1);
  await expect.poll(()=>b.getByRole('button',{name:'Send again',exact:true}).count()).toBe(0);
  await comms.startNotice('art',place,{kind:'start-retry',seq,generation:1,attempt:1,retryAt});
  await expect.poll(()=>b.getByLabel('Start retry').count()).toBe(1);
  comms.status('art',place,'working');
  await expect.poll(()=>b.getByLabel('Start retry').count()).toBe(0);
  await expect.poll(()=>b.getByText("Art couldn't start at first.",{exact:true}).count()).toBe(1);
  // Move the first message outside the live hundred, then load it as an earlier page.
  // Only the browser crosses its deadline: no server sweep can update that cached page.
  comms.status('art',place,'done');clock.advance(14*86400000-1000);
  await b.clock.setSystemTime(clock.now());
  for(let n=0;n<101;n++)await comms.post('art',place,{id:`page-filler-${n}`,kind:'card',text:`Retained recent card ${n}`});
  await expect.poll(()=>b.getByText('Retained recent card 100',{exact:true}).count()).toBe(1);
  await expect.poll(()=>b.getByText('Comms fixture message',{exact:true}).count()).toBe(0);
  await b.getByRole('button',{name:'Load earlier messages',exact:true}).click();
  await expect.poll(()=>b.getByText('Comms fixture message',{exact:true}).count()).toBe(1);
  await b.clock.fastForward(1000);
  await expect.poll(()=>b.getByText('Comms fixture message',{exact:true}).count()).toBe(0);
  expect(await b.getByText('Retained recent card 100',{exact:true}).count()).toBe(1);
  await a.getByRole('button',{name:'Delete',exact:true}).click();await a.getByRole('button',{name:'Keep thread',exact:true}).click();expect(await a.getByRole('textbox',{name:'Message',exact:true}).count()).toBe(1);
 }finally{await browser.close();await comms.close();await loom.close();rmSync(home,{recursive:true,force:true});}
},60000);
