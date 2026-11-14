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
import { proveNextComms } from './comms-next-proof.js';
import { draftKey } from '../../web/src/pieces/comms/drafts.js';
const root=resolve(import.meta.dirname,'../../dist/web');
const chrome=[process.env.LOOM_TEST_CHROME,'/usr/bin/google-chrome','/usr/bin/chromium',chromium.executablePath()].find(p=>p&&existsSync(p));
it.runIf(chrome&&existsSync(join(root,'index.html')))('Comms sends once across two windows, retains a device draft, sanitises replies and captures both looks',async()=>{
 const home=mkdtempSync(join(tmpdir(),'comms-browser-')),clock=new FakeClock(),key=await loadKey(home);const starts:{seq:number;generation?:number}[]=[];const ends:string[]=[];let comms!:ReturnType<typeof installComms>;let reply=true;
 const conversations=new Map([['cv-label-fixture',{agent:'art',venue:'discord',version:'one'}]]);
 const loom=await startLoom({home,clock,authenticate:()=>({viewer:{kind:'member',id:'jonathan'},window:true,valid:()=>true}),install:app=>{
  installFixture(app);
  comms=installComms({...app,clock,key,sharing:fixtureSharing,conversation:id=>conversations.get(id),hold:effect=>effect(),attention:{answer:()=>({ok:true,value:{answered:true}})},runtime:{
   deliver:async d=>{starts.push({seq:d.seq,generation:d.generation});if(!reply)return;await comms.post(d.agent,d.thread,{id:`reply-${d.seq}`,kind:'reply',on:'Codex',text:'Fixture reply **received**. [Unsafe](javascript:alert(1)) <script>bad()</script> ![no image](https://example.com/image.png)'});},end:async conversation=>{ends.push(conversation);},
  }});
 }});
 const firstAt=clock.now();
 const first=await loom.operations.callAsync('socket',{kind:'member',id:'jonathan'},'comms.open',{agent:'art',id:'fixturefirstaaaa',text:'Comms fixture message'},'fixture-first',true);
 if(!first.ok)throw new Error('fixture failed');const place=(first.value as {thread:string}).thread;await comms.deliver('art',place,1);
 const browser=await chromium.launch({executablePath:chrome,args:['--no-sandbox']});
 try{
  await proveNextComms(browser,root);
  const context=await browser.newContext({serviceWorkers:'block',viewport:{width:1280,height:900}});await context.grantPermissions(['local-network-access'],{origin:loom.url});
  await context.route('**/*',async route=>{const url=new URL(route.request().url());if(url.pathname==='/live'||url.pathname.startsWith('/api/'))return route.continue();const path=url.pathname.startsWith('/app/')?resolve(root,url.pathname.slice(5)):join(root,'index.html');if(!path.startsWith(root+'/')||!existsSync(path))return route.fulfill({status:404,body:''});await route.fulfill({body:readFileSync(path),contentType:({'.js':'text/javascript','.css':'text/css','.html':'text/html','.woff2':'font/woff2'} as Record<string,string>)[extname(path)]??'application/octet-stream'});});
  const a=await context.newPage(),b=await context.newPage();await b.addInitScript(()=>{const sockets:WebSocket[]=[];Reflect.set(window,'__fixtureSockets',sockets);const Native=window.WebSocket;window.WebSocket=class extends Native{constructor(url:string|URL,protocols?:string|string[]){super(url,protocols);sockets.push(this);}};});await b.clock.install({time:clock.now()});await Promise.all([a.goto(`${loom.url}/p/comms-preview`),b.goto(`${loom.url}/p/comms-preview`)]);
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
  await expect.poll(()=>b.getByLabel('Reply harness').textContent()).toBe(' · ON CODEX');
  await comms.post('art',place,{id:'ordinary-harness',kind:'reply',text:'Back on the ordinary harness.'});
  await expect.poll(()=>b.getByLabel('Reply harness').count()).toBe(0);
  // A hidden arrival must become read on focus without needing another Live message.
  for(const page of [a,b])await page.evaluate(()=>{Object.defineProperty(document,'visibilityState',{configurable:true,value:'hidden'});Object.defineProperty(document,'hasFocus',{configurable:true,value:()=>false});document.dispatchEvent(new Event('visibilitychange'));});
  const hiddenReply=await comms.post('art',place,{id:'hidden-read-reply',kind:'reply',text:'A reply while both pages are hidden.'});
  await expect.poll(()=>b.getByText('A reply while both pages are hidden.',{exact:true}).count()).toBe(1);
  const readSeq=()=>JSON.parse((loom.db.prepare('SELECT record FROM comms_threads WHERE id=?').get(place) as {record:string}).record).readSeq as number;
  expect(readSeq()).toBeLessThan(hiddenReply.seq);
  await b.evaluate(()=>{Object.defineProperty(document,'visibilityState',{configurable:true,value:'visible'});Object.defineProperty(document,'hasFocus',{configurable:true,value:()=>true});window.dispatchEvent(new Event('focus'));});
  await expect.poll(readSeq).toBeGreaterThanOrEqual(hiddenReply.seq);
  // An already-read thread must keep renewing foreground presence without new records.
  const inFront=()=>JSON.parse((loom.db.prepare('SELECT record FROM comms_threads WHERE id=?').get(place) as {record:string}).record).inFront as number;
  clock.advance(30000);await b.clock.fastForward(30000);
  await expect.poll(inFront).toBe(clock.now());expect(readSeq()).toBe(hiddenReply.seq);
  for(const page of [a,b])await page.evaluate(()=>{Reflect.deleteProperty(document,'visibilityState');Reflect.deleteProperty(document,'hasFocus');document.dispatchEvent(new Event('visibilitychange'));});
  // Body activity comes from the thread subscription; it must disappear when the turn ends.
  const activeRow=b.locator('[data-split-row]').filter({hasText:'New thread with art'});
  expect(await activeRow.locator('.comms-agent-letter').textContent()).toBe('A');
  expect(await activeRow.locator('.comms-agent-letter').getAttribute('aria-hidden')).toBe('true');
  await expect.poll(()=>activeRow.getByLabel('Thread activity time').getAttribute('datetime')).toBe(new Date(JSON.parse((loom.db.prepare('SELECT record FROM comms_threads WHERE id=?').get(place) as {record:string}).record).last).toISOString());
  expect(await activeRow.getByLabel('Thread activity time').textContent()).toContain('CT');
  comms.status('art',place,'working');comms.activity('art',place,{at:clock.now(),tokens:41900});
  await expect.poll(()=>activeRow.getByLabel('Thread working').textContent()).toBe('working…');
  await expect.poll(()=>b.getByRole('button',{name:'Stop',exact:true}).isEnabled()).toBe(true);
  await expect.poll(()=>b.getByLabel('Body activity').textContent()).toContain('41,900 tokens');
  expect(await b.getByLabel('Body activity').locator('time').getAttribute('datetime')).toBe(new Date(clock.now()).toISOString());
  comms.activity('art',place,{at:clock.now()+1});
  await expect.poll(()=>b.getByLabel('Body activity').textContent()).not.toContain('tokens');
  comms.status('art',place,'done');
  await expect.poll(()=>activeRow.getByLabel('Thread working').count()).toBe(0);
  await expect.poll(()=>b.getByLabel('Body activity').count()).toBe(0);
  await expect.poll(()=>b.getByLabel('Working status').count()).toBe(0);
  await expect.poll(()=>b.getByRole('button',{name:'Stop',exact:true}).count()).toBe(0);
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
  await expect.poll(()=>b.getByLabel('Thinking status').textContent()).toBe('art is thinking');
  const retryAt=new Date(clock.now()+60000).toISOString();
  await comms.startNotice('art',place,{kind:'start-retry',seq,attempt:2,retryAt,reason:'private fixture host reason'});
  await expect.poll(()=>b.getByLabel('Start retry').count()).toBe(1);
  expect(await b.getByLabel('Start retry').locator('time').getAttribute('datetime')).toBe(retryAt);
  expect(await b.getByLabel('Start retry').textContent()).toContain('CT');
  expect(await b.getByLabel('Start retry').textContent()).not.toContain('private fixture host reason');
  const shots=process.env.LOOM_TEST_SHOTS??resolve('artifacts/comms-app');mkdirSync(shots,{recursive:true});
  const capture=async(prefix:string,split=false)=>{for(const look of ['neon','daylight'])for(const width of [390,1280,1920]){await b.setViewportSize({width,height:900});await b.evaluate(look=>{document.documentElement.dataset.look=look;document.documentElement.dataset.mode=look==='daylight'?'light':'dark';document.documentElement.dataset.motion='reduce';},look);if(split)await expect.poll(()=>b.locator('.loom-split').getAttribute('data-mode')).toBe(width<640?'one':'three');if(prefix==='comms-menu'||prefix==='comms-hold'){await b.getByRole('button',{name:'Actions for New thread with art',exact:true}).click();await expect.poll(()=>b.getByRole('menuitem',{name:prefix==='comms-hold'?'Unpin':'Pin',exact:true}).count()).toBe(1);}if(prefix==='comms-list'||prefix==='comms-menu'){expect(await row(b).locator('.comms-agent-letter').textContent()).toBe('A');expect(await b.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);}await b.screenshot({path:join(shots,`${prefix}-${look}-${width}.png`),fullPage:true,animations:'disabled'});if(prefix==='comms-menu'||prefix==='comms-hold')await b.keyboard.press('Escape');}};
  await capture('comms',true);
  await b.setViewportSize({width:390,height:900});
  await expect.poll(()=>b.locator('.loom-split').getAttribute('data-mode')).toBe('one');
  await b.locator('.loom-split__back').click();
  await capture('comms-list',true);
  await capture('comms-menu',true);
  const rowTrigger=()=>b.getByRole('button',{name:'Actions for New thread with art',exact:true});
  // Pointer and keyboard context entry must not navigate; Escape restores trigger focus.
  const listPath=new URL(b.url()).pathname;
  await row(b).click({button:'right'});
  await expect.poll(()=>b.getByRole('menuitem',{name:'Pin',exact:true}).count()).toBe(1);
  expect(new URL(b.url()).pathname).toBe(listPath);
  await b.keyboard.press('Escape');
  await expect.poll(()=>rowTrigger().evaluate(el=>el===document.activeElement)).toBe(true);
  await row(b).focus();await b.keyboard.press('Shift+F10');
  await expect.poll(()=>b.getByRole('menuitem',{name:'Pin',exact:true}).count()).toBe(1);
  await b.getByRole('menuitem',{name:'Pin',exact:true}).click();
  const threadState=()=>JSON.parse((loom.db.prepare('SELECT record FROM comms_threads WHERE id=?').get(place) as {record:string}).record);
  await expect.poll(()=>threadState().pinned).toBe(true);
  expect(new URL(b.url()).pathname).toBe(listPath);
  await expect.poll(()=>rowTrigger().isEnabled()).toBe(true);
  await rowTrigger().focus();await b.keyboard.press('ArrowDown');
  await expect.poll(()=>b.getByRole('menuitem',{name:'Unpin',exact:true}).evaluate(el=>el===document.activeElement)).toBe(true);
  await b.keyboard.press('Enter');
  await expect.poll(()=>threadState().pinned).toBe(false);
  expect(new URL(b.url()).pathname).toBe(listPath);
  // A touch hold pins without a compatibility click opening the reader. Advance only
  // the installed browser clock; ordinary scrolling/cancellation must stay ordinary.
  await b.setViewportSize({width:390,height:900});
  await expect.poll(()=>b.locator('.loom-split').getAttribute('data-mode')).toBe('one');
  await b.clock.pauseAt(await b.evaluate(()=>Date.now()+1000));
  const touch={pointerType:'touch',pointerId:7,isPrimary:true,button:0,clientX:120,clientY:180};
  await row(b).dispatchEvent('pointerdown',touch);await b.clock.fastForward(549);
  expect(threadState().pinned).toBe(false);
  await b.clock.fastForward(1);await expect.poll(()=>threadState().pinned).toBe(true);
  await row(b).dispatchEvent('pointerup',touch);await row(b).dispatchEvent('click',{detail:1});
  expect(new URL(b.url()).pathname).toBe(listPath);
  await expect.poll(()=>rowTrigger().isEnabled()).toBe(true);
  await capture('comms-hold',true);
  await rowTrigger().click();await b.getByRole('menuitem',{name:'Unpin',exact:true}).click();
  await expect.poll(()=>threadState().pinned).toBe(false);
  await expect.poll(()=>rowTrigger().isEnabled()).toBe(true);
  for(const cancel of ['scroll','cancel','second','release']){
   await row(b).dispatchEvent('pointerdown',touch);
   if(cancel==='scroll')await row(b).dispatchEvent('pointermove',{...touch,clientY:210});
   if(cancel==='cancel')await row(b).dispatchEvent('pointercancel',touch);
   if(cancel==='second')await row(b).dispatchEvent('pointerdown',{...touch,pointerId:8,isPrimary:false});
   if(cancel==='release')await row(b).dispatchEvent('pointerup',touch);
   await b.clock.fastForward(600);expect(threadState().pinned).toBe(false);
   await row(b).dispatchEvent('pointerup',touch);
   expect(new URL(b.url()).pathname).toBe(listPath);
  }
  // A held menu trigger stays a menu control, never the row's pin gesture.
  const menuTouchTarget=await rowTrigger().elementHandle();if(!menuTouchTarget)throw new Error('Missing row menu trigger');
  await menuTouchTarget.dispatchEvent('pointerdown',touch);await b.clock.fastForward(600);
  expect(threadState().pinned).toBe(false);
  await expect.poll(()=>b.getByRole('menuitem',{name:'Pin',exact:true}).count()).toBe(1);
  expect(new URL(b.url()).pathname).toBe(listPath);
  await menuTouchTarget.dispatchEvent('pointercancel',touch);
  await b.keyboard.press('Escape');await b.clock.resume();
  await rowTrigger().click();await b.getByRole('menuitem',{name:'Archive',exact:true}).click();
  await expect.poll(()=>row(b).count()).toBe(0);
  expect(new URL(b.url()).pathname).toBe(listPath);
  await b.getByRole('button',{name:'Archived',exact:true}).filter({visible:true}).click();
  await expect.poll(()=>row(b).count()).toBe(1);
  await rowTrigger().click();await b.getByRole('menuitem',{name:'Unarchive',exact:true}).click();
  await expect.poll(()=>row(b).count()).toBe(0);
  await b.getByRole('button',{name:'Threads',exact:true}).filter({visible:true}).click();
  await expect.poll(()=>row(b).count()).toBe(1);
  await row(b).click();
  const conversation=JSON.parse((loom.db.prepare('SELECT record FROM comms_threads WHERE id=?').get(place) as {record:string}).record).conversation;
  const created=loom.operations.call('direct',{kind:'member',id:'jonathan'},'tasks.create',{title:'Work made in this thread',agent:'art',source:`conversation:${conversation}`,actor:'art',at:new Date(clock.now()).toISOString()},'fixture-work');
  expect(created).toMatchObject({ok:true,value:{result:{ok:true}}});
  const task=(created as {ok:true;value:{result:{id:string}}}).value.result.id;
  await expect.poll(()=>b.getByRole('region',{name:'Work in this thread'}).getByRole('link',{name:'Work made in this thread'}).count()).toBe(1);
  expect(await b.getByRole('region',{name:'Work in this thread'}).getByRole('link').getAttribute('href')).toBe(`/p/tasks-preview/task/${task}`);
  const blocker=loom.operations.call('direct',{kind:'member',id:'jonathan'},'tasks.create',{title:'Blocking fixture work',agent:'art',actor:'art',at:new Date(clock.now()).toISOString()},'fixture-blocker');
  expect(blocker).toMatchObject({ok:true,value:{result:{ok:true}}});
  const blockerId=(blocker as {ok:true;value:{result:{id:string}}}).value.result.id;
  expect(loom.operations.call('direct',{kind:'member',id:'jonathan'},'tasks.link',{id:task,dependsOn:blockerId,type:'blocks',actor:'art',at:new Date(clock.now()).toISOString()},'fixture-block')).toMatchObject({ok:true,value:{result:{ok:true}}});
  await b.setViewportSize({width:390,height:900});
  await expect.poll(()=>b.getByRole('button',{name:'Work (1 · 1 needs a look)',exact:true}).getAttribute('aria-expanded')).toBe('false');
  expect(await b.getByRole('region',{name:'Work in this thread'}).count()).toBe(0);
  await b.getByRole('button',{name:'Work (1 · 1 needs a look)',exact:true}).click();
  await expect.poll(()=>b.getByRole('region',{name:'Work in this thread'}).textContent()).toContain('Blocked');
  const badge=b.getByRole('region',{name:'Work in this thread'}).locator('[data-tone="bad"]');
  expect(await badge.evaluate(el=>getComputedStyle(el).color!==getComputedStyle(el.parentElement!).color)).toBe(true);
  await capture('comms-work',true);
  // At desktop widths the region is visible beside the message column without a toggle.
  expect(await b.getByRole('button',{name:/^Work/}).count()).toBe(0);
  const workBox=await b.getByRole('region',{name:'Work in this thread'}).boundingBox(),messageBox=await b.getByLabel('Thread messages').boundingBox();
  expect(workBox!.x).toBeGreaterThanOrEqual(messageBox!.x+messageBox!.width);
  const closed=loom.operations.call('direct',{kind:'member',id:'jonathan'},'tasks.close',{id:task,actor:'art',at:new Date(clock.now()).toISOString()},'fixture-work-close');
  expect(closed).toMatchObject({ok:true,value:{result:{ok:true}}});
  for(const page of [a,b])await expect.poll(()=>page.getByRole('region',{name:'Work in this thread'}).textContent()).toContain('Done');
  const doneBadge=b.getByRole('region',{name:'Work in this thread'}).locator('[data-tone="ok"]');
  expect(await doneBadge.evaluate(el=>getComputedStyle(el).color!==getComputedStyle(el.parentElement!).color)).toBe(true);
  const importedId='..';
  expect(loom.operations.call('direct',{kind:'member',id:'jonathan'},'tasks.import',{tasks:[{id:importedId,title:'Imported work link',type:'task',status:'closed',closedAt:new Date(clock.now()-8*86400000).toISOString(),priority:2,createdBy:'art',createdAt:new Date(clock.now()-9*86400000).toISOString(),agent:'art',source:`conversation:${conversation}`,description:'Imported work detail'}],actor:'art',at:new Date(clock.now()).toISOString()},'fixture-imported-work')).toMatchObject({ok:true,value:{result:{ok:true}}});
  await expect.poll(()=>a.getByRole('link',{name:'Imported work link'}).count()).toBe(1);
  await a.getByRole('link',{name:'Imported work link'}).click();
  await expect.poll(()=>a.getByText('Imported work detail',{exact:true}).count()).toBe(1);
  await a.goto(`${loom.url}/p/comms-preview/thread/${place.replace(/^th:/,'')}`);
  await expect.poll(()=>a.getByRole('link',{name:'Work made in this thread'}).count()).toBe(1);
  await b.clock.pauseAt(await b.evaluate(()=>Date.now()+1000));
  await b.evaluate(()=>{for(const socket of Reflect.get(window,'__fixtureSockets') as WebSocket[])socket.close();});
  await expect.poll(()=>b.getByRole('link',{name:'Work made in this thread'}).count()).toBe(0);
  await b.clock.fastForward(250);
  await expect.poll(()=>b.getByRole('link',{name:'Work made in this thread'}).count()).toBe(1);
  await b.clock.resume();

  await comms.startNotice('art',place,{kind:'start-failed',seq,attempt:3});
  await expect.poll(()=>b.getByRole('button',{name:'Send again',exact:true}).count()).toBe(1);
  await expect.poll(()=>b.getByLabel('Thinking status').count()).toBe(0);
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
  comms.status('art',place,'done');clock.advance(firstAt+14*86400000-1000-clock.now());
  // setSystemTime leaves time running: encrypting/posting the fillers may consume
  // the final second before Load earlier is clicked. Hold it until fastForward.
  await b.clock.pauseAt(clock.now());
  for(let n=0;n<101;n++)await comms.post('art',place,{id:`page-filler-${n}`,kind:'card',text:`Retained recent card ${n}`});
  await expect.poll(()=>b.getByText('Retained recent card 100',{exact:true}).count()).toBe(1);
  await expect.poll(()=>b.getByText('Comms fixture message',{exact:true}).count()).toBe(0);
  // Scroll following uses new sequence identities, including when Live stays capped at 100.
  const messages=b.getByLabel('Thread messages');
  const gap=()=>messages.evaluate(el=>el.scrollHeight-el.scrollTop-el.clientHeight);
  // Clicking the older Send again control may have scrolled back. Card-only
  // arrivals correctly preserve that position; establish following explicitly.
  await messages.evaluate(el=>{el.scrollTop=el.scrollHeight;el.dispatchEvent(new Event('scroll'));});
  await expect.poll(gap).toBeLessThanOrEqual(80);
  // The standalone app must own a real scroller on phone and desktop alike;
  // gap=0 alone would also pass for a message area grown to its entire content.
  for(const width of [390,1280,1920]){
   await b.setViewportSize({width,height:900});
   await expect.poll(()=>messages.evaluate(el=>el.scrollHeight-el.clientHeight)).toBeGreaterThan(80);
   expect(await messages.evaluate(el=>el.clientHeight)).toBeGreaterThan(0);
   await expect.poll(()=>b.getByRole('textbox',{name:'Message',exact:true}).evaluate(el=>el.closest('form')!.getBoundingClientRect().bottom)).toBeLessThanOrEqual(900);
   await expect.poll(gap,{message:`following after resize to ${width}px`}).toBeLessThanOrEqual(80);
  }
  // Chromium does not open an OS keyboard. Change only visualViewport metrics,
  // leaving the layout viewport at 900px, as iOS does when its keyboard opens.
  await b.setViewportSize({width:390,height:900});
  const composer=b.getByRole('textbox',{name:'Message',exact:true});
  await composer.focus();
  await b.evaluate(()=>{
   Object.defineProperties(window.visualViewport!,{height:{configurable:true,value:450},offsetTop:{configurable:true,value:50},scale:{configurable:true,value:1}});
   window.visualViewport!.dispatchEvent(new Event('resize'));
  });
  const composerBottom=()=>composer.evaluate(el=>el.closest('form')!.getBoundingClientRect().bottom);
  await expect.poll(composerBottom).toBeLessThanOrEqual(500);
  expect(await messages.evaluate(el=>el.clientHeight)).toBeGreaterThan(0);
  expect(await b.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
  // Panning the visual viewport updates its bottom without a layout resize.
  await b.evaluate(()=>{Object.defineProperty(window.visualViewport!,'offsetTop',{configurable:true,value:20});window.visualViewport!.dispatchEvent(new Event('scroll'));});
  await expect.poll(composerBottom).toBeLessThanOrEqual(470);
  await composer.fill('Sent above the keyboard');await composer.press('Enter');
  expect(await composer.inputValue()).toBe('Sent above the keyboard\n');
  const beforeKeyboardSend=starts.length;
  await b.getByRole('button',{name:'Send',exact:true}).click();
  await expect.poll(()=>starts.length).toBe(beforeKeyboardSend+1);
  expect(await composer.evaluate(el=>document.activeElement===el)).toBe(true);
  expect(await composer.inputValue()).toBe('');
  // Start the scroll-away proof only after the actual own-message Live record,
  // not merely its operation acknowledgement or optimistic preview.
  await expect.poll(()=>messages.getByText('Sent above the keyboard',{exact:true}).count()).toBe(1);
  await expect.poll(composerBottom).toBeLessThanOrEqual(470);
  await b.evaluate(()=>{
   for(const key of ['height','offsetTop','scale'])Reflect.deleteProperty(window.visualViewport!,key);
   window.visualViewport!.dispatchEvent(new Event('resize'));
  });
  await expect.poll(()=>b.locator('.loom-comms').getAttribute('data-comms-keyboard')).toBe(null);
  // Let the existing resize observer adopt restored geometry before testing a
  // separate deliberate scroll. No wall-clock sleep or extra browser is used.
  await messages.evaluate(el=>new Promise<void>(resolve=>{const observer=new ResizeObserver(()=>{observer.disconnect();resolve();});observer.observe(el);}));
  await expect.poll(gap).toBeLessThanOrEqual(80);
  await messages.evaluate(el=>{el.scrollTop=0;el.dispatchEvent(new Event('scroll'));});
  expect(await gap()).toBeGreaterThan(80);
  await comms.post('art',place,{id:'follow-reply-one',kind:'reply',text:'Reply while reading earlier words'});
  await expect.poll(()=>b.getByRole('button',{name:'New messages ↓ (1)',exact:true}).count()).toBe(1);
  expect(await gap()).toBeGreaterThan(80);
  await b.getByRole('button',{name:'New messages ↓ (1)',exact:true}).click();
  await expect.poll(gap).toBeLessThanOrEqual(80);
  await comms.post('art',place,{id:'follow-reply-two',kind:'reply',text:'Reply while following the end'});
  await expect.poll(()=>b.getByText('Reply while following the end',{exact:true}).count()).toBe(1);
  await expect.poll(gap).toBeLessThanOrEqual(80);
  expect(await b.getByRole('button',{name:/New messages ↓/}).count()).toBe(0);
  // Loading an earlier page does not count as an appended reply or pull the reader down.
  await b.getByRole('button',{name:'Load earlier messages',exact:true}).click();
  await expect.poll(()=>b.getByText('Comms fixture message',{exact:true}).count()).toBe(1);
  expect(await b.getByRole('button',{name:/New messages ↓/}).count()).toBe(0);

  // Any authoritative Live replacement fences older pages, even before cleanup.
  await comms.post('art',place,{id:'page-filler-100',kind:'card',text:'Updated recent card 100'});
  await expect.poll(()=>b.getByText('Updated recent card 100',{exact:true}).count()).toBe(1);
  expect(await b.getByText('Comms fixture message',{exact:true}).count()).toBe(0);
  await b.getByRole('button',{name:'Load earlier messages',exact:true}).click();
  await expect.poll(()=>b.getByText('Comms fixture message',{exact:true}).count()).toBe(1);
  expect(await b.evaluate(()=>Date.now())).toBe(clock.now());
  await b.clock.fastForward(999);
  expect(await b.getByText('Comms fixture message',{exact:true}).count()).toBe(1);
  await b.clock.fastForward(1);
  await expect.poll(()=>b.getByText('Comms fixture message',{exact:true}).count()).toBe(0);
  expect(await b.getByText('Updated recent card 100',{exact:true}).count()).toBe(1);
  // Ordinary-conversation labels use a separate scoped Live page, with no body text.
  const writer=comms.conversationWriter({agent:'art',conversation:'cv-label-fixture',run:'fixture-label-run',startedAt:clock.now(),valid:()=>true});
  await writer.write([{id:'earliest',tool:'Shell',summary:'Earlier conversation label',state:'done'}]);
  clock.advance(500);
  for(let start=0;start<102;start+=50)await writer.write(Array.from({length:Math.min(50,102-start)},(_,n)=>({id:`label-${start+n}`,tool:'Shell',summary:`Conversation label ${start+n}`,state:'running' as const})));
  // Prove fixture writes independently of the browser before opening its scoped view.
  const labels=await loom.operations.callAsync('socket',{kind:'member',id:'jonathan'},'comms.conversationSteps',{conversation:'cv-label-fixture'},undefined,true);
  expect(labels).toMatchObject({ok:true,value:{steps:expect.arrayContaining([expect.objectContaining({text:'Conversation label 101'})])}});
  // Navigation installs a fresh document. Let its startup timers and lazy app load
  // run before freezing time for the next exact-deadline proof.
  await b.clock.setSystemTime(clock.now());
  await b.clock.resume();
  await b.goto(`${loom.url}/p/comms-preview/conversation/cv-label-fixture`);
  await expect.poll(async()=>({label:await b.getByText('Conversation label 101',{exact:true}).count(),page:await b.locator('body').innerText()})).toMatchObject({label:1});
  await b.clock.pauseAt(await b.evaluate(()=>Date.now()+1000));
  await b.clock.setSystemTime(clock.now());
  expect(await b.getByText('Earlier conversation label',{exact:true}).count()).toBe(0);
  await b.getByRole('button',{name:'Load earlier activity',exact:true}).click();
  await expect.poll(()=>b.getByText('Earlier conversation label',{exact:true}).count()).toBe(1);
  await capture('comms-conversation');
  await b.clock.fastForward(14*86400000-501);
  expect(await b.getByText('Earlier conversation label',{exact:true}).count()).toBe(1);
  await b.clock.fastForward(1);
  await expect.poll(()=>b.getByText('Earlier conversation label',{exact:true}).count()).toBe(0);
  expect(await b.getByText('Conversation label 101',{exact:true}).count()).toBe(1);
  // An authoritative private transition removes the aggregate and cached pages.
  conversations.get('cv-label-fixture')!.venue='comms';loom.live.changed([{type:'conversation',id:'cv-label-fixture'}]);
  await expect.poll(()=>b.getByText('Conversation unavailable',{exact:true}).count()).toBe(1);
  expect(await b.getByText('Conversation label 101',{exact:true}).count()).toBe(0);
  await a.getByRole('button',{name:'Delete',exact:true}).click();await a.getByRole('button',{name:'Keep thread',exact:true}).click();expect(await a.getByRole('textbox',{name:'Message',exact:true}).count()).toBe(1);
  // Explicit fixture job: preserve a supplied spawn conversation without starting
  // it through Comms. Production spawn creation remains a separate role.
  const job=await loom.operations.callAsync('socket',{kind:'member',id:'jonathan'},'comms.open',{agent:'art',id:'fixturejobaaaaaa',text:'Assigned job brief'},'fixture-job',true);
  if(!job.ok)throw new Error('job fixture failed');const jobPlace=(job.value as {thread:string}).thread;await comms.deliver('art',jobPlace,1);
  const jobRow=JSON.parse((loom.db.prepare('SELECT record FROM comms_threads WHERE id=?').get(jobPlace) as {record:string}).record);
  jobRow.conversation='cv-spawn-fixture';jobRow.title='Assigned background job';
  loom.db.prepare('UPDATE comms_threads SET record=? WHERE id=?').run(JSON.stringify(jobRow),jobPlace);
  loom.db.prepare("UPDATE comms_messages SET sender='art' WHERE thread=? AND kind='message'").run(jobPlace);
  conversations.set('cv-spawn-fixture',{agent:'art',venue:'spawn',version:'one'});loom.live.changed([{type:'conversation',id:'cv-spawn-fixture'}]);
  await b.clock.setSystemTime(clock.now());await b.clock.resume();await b.setViewportSize({width:1280,height:900});
  await b.goto(`${loom.url}/p/comms-preview`);
  await expect.poll(()=>b.getByRole('button',{name:'New thread',exact:true}).isEnabled()).toBe(true);
  expect(await b.getByText('Assigned background job',{exact:true}).count()).toBe(0);
  await b.getByRole('navigation',{name:'Comms folders'}).getByRole('button',{name:'Background work',exact:true}).click();
  await expect.poll(()=>b.getByText('Assigned background job',{exact:true}).count()).toBe(1);
  comms.status('art',jobPlace,'working');
  const startsBeforeJoin=starts.length,endsBeforeWatch=ends.length;
  await b.getByText('Assigned background job',{exact:true}).click();
  await expect.poll(()=>b.getByLabel('Watching job').count()).toBe(1);
  expect(await b.getByRole('textbox',{name:'Message',exact:true}).count()).toBe(0);
  expect(await b.getByRole('button',{name:'Stop',exact:true}).count()).toBe(0);
  await comms.activityCards('art',jobPlace,{run:'watch-fixture',cards:[{id:'watch-step',tool:'Shell',summary:'Live watched work',state:'running'}]});
  await expect.poll(()=>b.getByText('Live watched work',{exact:true}).count()).toBe(1);
  await capture('comms-watching');
  await b.getByRole('button',{name:'Join in',exact:true}).click();
  await expect.poll(()=>b.getByRole('textbox',{name:'Message',exact:true}).count()).toBe(1);
  expect(await b.getByRole('button',{name:'Stop',exact:true}).count()).toBe(1);
  // Joining alone neither promotes nor touches the run; reopening watches again.
  expect(starts.length).toBe(startsBeforeJoin);expect(ends.length).toBe(endsBeforeWatch);
  expect(await b.getByLabel('Thread list').getByText('Assigned background job',{exact:true}).count()).toBe(1);
  await b.goto(`${loom.url}/p/comms-preview/thread/${jobPlace.slice(3)}`);
  await expect.poll(()=>b.getByLabel('Watching job').count()).toBe(1);
  expect(starts.length).toBe(startsBeforeJoin);expect(ends.length).toBe(endsBeforeWatch);
  await b.getByRole('navigation',{name:'Comms folders'}).getByRole('button',{name:'Background work',exact:true}).click();
  await b.getByRole('button',{name:'Join in',exact:true}).click();
  await b.getByRole('textbox',{name:'Message',exact:true}).fill('A member follow-up');await b.getByRole('button',{name:'Send',exact:true}).click();
  await expect.poll(()=>starts.length).toBe(startsBeforeJoin+1);
  await expect.poll(()=>b.getByRole('heading',{name:'Assigned background job',exact:true}).count()).toBe(1);
  // Promotion removes the list row but preserves the direct-link reader.
  await expect.poll(()=>b.getByLabel('Thread list').getByText('Assigned background job',{exact:true}).count()).toBe(0);
  await b.getByRole('navigation',{name:'Comms folders'}).getByRole('button',{name:'Threads',exact:true}).click();
  await expect.poll(()=>b.getByLabel('Thread list').getByText('Assigned background job',{exact:true}).count()).toBe(1);
  await b.reload();
  await expect.poll(()=>b.getByRole('textbox',{name:'Message',exact:true}).count()).toBe(1);
  expect(await b.getByLabel('Watching job').count()).toBe(0);expect(ends.length).toBe(endsBeforeWatch);

 }finally{await browser.close();await comms.close();await loom.close();rmSync(home,{recursive:true,force:true});}
},180000);
