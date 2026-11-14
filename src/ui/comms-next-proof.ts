/** The Comms browser proof's real next-mode delivery checkpoint (no delivery fake). */
import { expect } from 'vitest';
import type { Browser, Page } from 'playwright-core';
import { randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { startLoom } from '../foundation.js';
import { fixture } from '../fixture.js';
import { FakeClock, type Result } from '../core/index.js';
import { signin, hash } from '../core/signin/index.js';
import { runtimeStore } from '../pieces/runtime/store.js';

const value=<T>(r:Result):T=>{expect(r.ok).toBe(true);return (r as {ok:true;value:T}).value;};
export async function proveNextComms(browser:Browser,webRoot:string) {
 const home=mkdtempSync(join(tmpdir(),'comms-next-browser-'));fixture(home);
 const clock=new FakeClock(),app=await startLoom({home,clock,next:true,webRoot,stdout:()=>{}});
 const context=await browser.newContext({serviceWorkers:'block',viewport:{width:1280,height:900}});
 try {
  const auth=signin(app);auth.tokens.replace({v:1,tokens:[]},{});
  const token=(role:string)=>{const secret=randomBytes(32).toString('hex');auth.tokens.change(ts=>ts.push({role,sha256:hash(secret),label:'Comms browser fixture',created:new Date(clock.now()).toISOString()}));return secret;};
  const owner=token('owner'),runner=token('runner:a');
  expect(app.operations.call('direct',{kind:'member',id:'jonathan'},'signin.setPrincipal',{kind:'runner',id:'a',active:true},'enable-runner')).toMatchObject({ok:true});
  app.db.transaction(()=>{const store=runtimeStore(app.db);
   store.put('settings',{id:'art',agent:'art',boxes:['a'],house:{repo:'/fixture/art',houseFile:'house/house.json'}},clock.now());
   store.put('box',{id:'a',name:'Fixture worker',owner:'jonathan',local:true,mayHost:'*',lentTo:[],facts:[],labels:[],alwaysOn:false,reportOnly:false,createdAt:clock.now()},clock.now());
  })();
  await context.addCookies([{name:'loom_ui',value:auth.createSession(hash(owner)),url:app.url}]);
  await context.grantPermissions(['local-network-access'],{origin:app.url});
  const a=await context.newPage(),b=await context.newPage();
  for(const page of [a,b])await page.clock.install({time:clock.now()});
  let n=0;
  const post=async(secret:string,name:string,input:unknown):Promise<Result>=>{
   const [piece,op]=name.split('.');return (await fetch(`${app.url}/api/${piece}/${op}`,{method:'POST',headers:{authorization:`Bearer ${secret}`,'content-type':'application/json'},body:JSON.stringify({input,id:`next-browser-${++n}`})})).json();
  };
  // A separate browser socket uses the same real page cookie/origin as the app.
  // This exercises the attachment backend while its shell sheet is still unfinished.
  const socket=async(page:Page,name:string,input:unknown):Promise<Result>=>page.evaluate(({name,input,id})=>new Promise((resolve,reject)=>{
   const ws=new WebSocket(location.origin.replace(/^http/,'ws')+'/live');
   const timer=setTimeout(()=>{ws.close();reject(new Error('Fixture socket deadline'));},10000);
   ws.onopen=()=>ws.send(JSON.stringify({kind:'call',name,input,id,request:id}));
   ws.onmessage=e=>{const m=JSON.parse(e.data);if(m.kind==='result'&&m.request===id){clearTimeout(timer);ws.close();resolve(m.result);}};
   ws.onerror=()=>{clearTimeout(timer);ws.close();reject(new Error('Fixture socket failed'));};
  }),{name,input,id:`next-browser-${++n}`});
  for(const kind of ['ordinary','filed','attached'] as const) {
   const inbound=`PRIVATE ${kind} browser inbound`,outbound=`PRIVATE ${kind} body reply`;
   await a.goto(`${app.url}/p/comms-preview/new`);
   await expect.poll(()=>a.getByRole('textbox',{name:'Message',exact:true}).count()).toBe(1);
   let thread:string;
   if(kind==='attached') {
    const opened=value<{thread:string}>(await socket(a,'comms.open',{agent:'art',id:'attachedaaaaaaaa',text:inbound,about:{ref:'t-1',label:'Fixture work item',page:'p/tasks-preview/t-1'}}));
    thread=opened.thread;await a.goto(`${app.url}/p/comms-preview/thread/${thread.slice(3)}`);
   } else {
    await a.getByRole('combobox',{name:'Agent',exact:true}).selectOption('art');
    await a.getByRole('textbox',{name:'Message',exact:true}).fill(inbound);
    await a.getByRole('button',{name:'Send',exact:true}).click();
    await expect.poll(()=>new URL(a.url()).pathname.includes('/thread/')).toBe(true);
    thread=`th:${new URL(a.url()).pathname.split('/thread/')[1]}`;
   }
   await b.goto(a.url());
   await expect.poll(()=>b.getByText(inbound,{exact:true}).count()).toBe(1);
   let jobs:string[]=[];
   await expect.poll(async()=>{jobs=value<{jobs:string[]}>(await post(runner,'runtime.claimableJobs',{})).jobs;return jobs.length;}).toBe(1);
   const job=jobs[0];
   if(kind==='filed') {
    await a.getByText('Thread settings',{exact:true}).click();
    await a.getByRole('textbox',{name:'Project',exact:true}).fill('pond');
    await a.getByRole('button',{name:'File thread',exact:true}).click();
    await expect.poll(()=>runtimeStore(app.db).read('job',job)?.project).toBe('pond');
    expect(runtimeStore(app.db).read('binding',runtimeStore(app.db).read('job',job)!.conversation!)?.project).toBe('pond');
   }
   expect(await post(runner,'runtime.claimJob',{job})).toMatchObject({ok:true});
   const input=value<{credential:string}>(await post(runner,'runtime.takeInput',{job}));
   expect(JSON.stringify(input)).not.toContain(inbound);
   expect(await post(runner,'runtime.reportJob',{job,state:'running'})).toMatchObject({ok:true});
   const read=await post(input.credential,'runtime.readConversation',{});
   expect(JSON.stringify(value(read))).toContain(inbound);
   if(kind==='attached')expect(JSON.stringify(read)).toContain('Fixture work item');
   expect(await post(input.credential,'runtime.reply',{id:`${kind}-reply`,text:outbound})).toMatchObject({ok:true});
   expect(await post(input.credential,'runtime.reply',{id:`${kind}-reply`,text:outbound})).toMatchObject({ok:true});
   for(const page of [a,b])await expect.poll(()=>page.getByText(outbound,{exact:true}).count()).toBe(1);
   expect(app.db.prepare('SELECT count(*) AS n FROM comms_messages WHERE thread=? AND id=?').get(thread,`${kind}-reply`)).toEqual({n:1});
   // The next member message stays on this active body and appears in both pages.
   await a.getByRole('textbox',{name:'Message',exact:true}).fill(`${inbound} follow-up`);
   await a.getByRole('button',{name:'Send',exact:true}).click();
   await expect.poll(()=>b.getByText(`${inbound} follow-up`,{exact:true}).count()).toBe(1);
   expect(JSON.stringify(value(await post(input.credential,'runtime.readConversation',{})))).toContain(`${inbound} follow-up`);
   expect(value<{jobs:string[]}>(await post(runner,'runtime.claimableJobs',{})).jobs).toEqual([]);
   if(kind==='filed') {
    const shots=process.env.LOOM_TEST_SHOTS??resolve('artifacts/comms-app');mkdirSync(shots,{recursive:true});
    for(const look of ['neon','daylight'])for(const width of [390,1280,1920]) {
     await b.setViewportSize({width,height:900});
     await b.evaluate(look=>{document.documentElement.dataset.look=look;document.documentElement.dataset.mode=look==='daylight'?'light':'dark';document.documentElement.dataset.motion='reduce';},look);
     await expect.poll(()=>b.locator('.loom-split').getAttribute('data-mode')).toBe(width<640?'one':'three');
     expect(await b.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
     await b.screenshot({path:join(shots,`comms-next-${look}-${width}.png`),fullPage:true,animations:'disabled'});
    }
   }
   expect(await post(runner,'runtime.finishJob',{job,state:'done'})).toMatchObject({ok:true});
   expect(await post(input.credential,'runtime.readConversation',{})).toMatchObject({ok:false});
   for(const table of ['runtime_inputs','runtime_jobs','runtime_bindings','runtime_deliveries','core_operations']) {
    const saved=JSON.stringify(app.db.prepare(`SELECT * FROM ${table}`).all());
    expect(saved).not.toContain(inbound);expect(saved).not.toContain(outbound);expect(saved).not.toContain(input.credential);
   }
  }
 } finally {await context.close();await app.close();rmSync(home,{recursive:true,force:true});}
}
