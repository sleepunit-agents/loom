/** The shipped desk on the actual shared HTTP/socket listener; CI owns Chromium.
 * Query contributors are real SQL readers passed through the root's public
 * composition seam. No legacy home, JSON records, copied app or route feeds. */
import {it,expect} from 'vitest';
import Database from 'better-sqlite3';
import {createHash} from 'node:crypto';
import {existsSync,mkdirSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {chromium,type Page} from 'playwright-core';
import {eq} from 'drizzle-orm';
import {generateX25519Identity} from 'age-encryption';
import {FakeClock} from '../core/clock.js';
import {createDataSchema} from '../core/data/database.js';
import {agents,agentStatus,members,memberAgents,tokens} from '../core/data/schema.js';
import {workVisibility} from '../core/data/work-visibility.js';
import {CommsMessages} from '../core/conversations/messages.js';
import {CommsQueries,commsQueryFields} from '../core/conversations/comms-query.js';
import {InboxQueries,inboxQueryFields} from '../core/conversations/inbox-query.js';
import {ConversationSummaries,conversationSummaryFields} from '../core/conversations/summaries.js';
import {wordsKey} from '../pieces/comms/crypto.js';
import {serveShared} from '../shared-serve.js';
const enabled=process.env.LOOM_DESK_EVIDENCE==='1',chrome=process.env.LOOM_TEST_CHROME,webRoot=resolve('dist/web');
if(enabled&&(!chrome||!existsSync(chrome)||!existsSync(join(webRoot,'next.html'))))throw Error('Desk evidence needs Chrome and the built app');
it.runIf(enabled)('shared desk applies live appearance, renders owned cards and opens actual Inbox rows at three looks and sizes',async()=>{
 const client=new Database(':memory:'),clock=new FakeClock(Date.now()),now=()=>new Date(clock.now()).toISOString(),db=createDataSchema(client,now);
 const raw='d'.repeat(64),fingerprint=createHash('sha256').update(raw).digest('hex');
 db.insert(members).values({id:'owner',role:'owner',joinedAt:now()}).run();
 const ids=['art','birch','cedar','elm','fern'];
 db.insert(agents).values(ids.map((id,position)=>({id,position,about:id==='art'?'Keeps the household moving.':'',markBg:'#B8A6FF',markFg:'#ffffff',faceShape:'pebble' as const,faceEyes:'dot' as const}))).run();
 db.insert(memberAgents).values(ids.map(agent=>({member:'owner',agent}))).run();
 db.insert(agentStatus).values(ids.map(agent=>({agent,state:agent==='art'?'working' as const:'idle' as const,work:agent==='art'?'Rebuilding the shared desk':'',changedAt:now()}))).run();
 db.insert(tokens).values({fingerprint,label:'Disposable desk fixture',kind:'owner',member:'owner',createdAt:now()}).run();
 const key=wordsKey(await generateX25519Identity()),messages=new CommsMessages(db,key,now);
 const thread=messages.threads.open({member:'owner',agent:'art',title:'Desk fixture conversation'});
 await messages.send({thread:thread.id,sender:'art',kind:'reply',words:'The shared desk reader is ready.'});
 const question=await messages.ask(thread.id,'art','desk-question',{words:'OK to run the backup now?',why:'A disposable browser fixture question.',answers:'yes-no'});
 // Existing source policy and readers, rather than hand-written fixture results.
 const policy:ConstructorParameters<typeof CommsQueries>[2]=(viewer,fields)=>workVisibility(viewer).approvals!(fields);
 const fields={...commsQueryFields(new CommsQueries(db,key,policy,now)),...inboxQueryFields(new InboxQueries(db,key,policy,now)),...conversationSummaryFields(new ConversationSummaries(db,key,now))};
 const app=await serveShared({db,clock,webRoot,fields,originAllowed:req=>!req.headers.origin||req.headers.origin===`http://${req.headers.host}`,reportError:error=>{throw error;}});
 let browser:Awaited<ReturnType<typeof chromium.launch>>|undefined;
 try {
  browser=await chromium.launch({executablePath:chrome,args:['--no-sandbox']});
  const context=await browser.newContext({viewport:{width:1280,height:900},serviceWorkers:'block'});
  const a=await context.newPage(),b=await context.newPage(),errors:string[]=[],connections=new Map<Page,number>();let maximumConnections=0;
  for(const page of [a,b]){page.on('pageerror',error=>errors.push(error.message));page.on('request',request=>{if(request.isNavigationRequest()&&request.frame()===page.mainFrame())connections.set(page,0);});page.on('websocket',socket=>{if(new URL(socket.url()).pathname==='/graphql'){const count=(connections.get(page)??0)+1;connections.set(page,count);maximumConnections=Math.max(maximumConnections,count);}});}
  const issued=await app.http.request(app.url+'/api/signin/link',{method:'POST',headers:{authorization:'Bearer '+raw}});
  expect(issued.status).toBe(200);const link=await issued.json() as {ok:boolean;value:{path:string}};
  await a.goto(app.url+link.value.path);
  const admitted=a.waitForResponse(response=>response.request().method()==='POST'&&new URL(response.url()).pathname.startsWith('/login/'));
  await a.getByRole('button',{name:'Sign in',exact:true}).click();
  const response=await admitted;
  if(response.status()!==303){const headers=response.request().headers();console.error('Desk sign-in headers',{origin:headers.origin??'absent',fetchSite:headers['sec-fetch-site']??'absent',status:response.status()});}
  expect(response.status()).toBe(303);
  await expect.poll(()=>a.locator('.next-shell').count()).toBe(1);await b.goto(app.url);
  for(const page of [a,b])await expect.poll(()=>page.getByRole('heading',{name:'Needs you · 1',exact:true}).count()).toBe(1);
  await a.locator('.next-preferences summary').click();
  await a.getByRole('combobox',{name:'Look',exact:true}).selectOption('daylight');
  for(const page of [a,b])await expect.poll(()=>page.locator('html').getAttribute('data-look')).toBe('daylight');
  // Saves travel through the real cookie HTTP command; displayed choices come
  // back through each window's one generated live-query connection.
  const set=async(input:object,id:string)=>{
   const result=await a.evaluate(async({input,id})=>{const response=await fetch('/api/household/setPreferences',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({input,id})});return {status:response.status,ok:(await response.json()).ok};},{input,id});
   expect(result).toEqual({status:200,ok:true});
  };
  await set({sound:true,motion:'on',contrast:'on',zoom:true,ground:'wash'},'appearance');
  for(const page of [a,b]){
   await expect.poll(()=>page.locator('html').getAttribute('data-sound')).toBe('on');await expect.poll(()=>page.locator('html').getAttribute('data-motion')).toBe('reduce');
   await expect.poll(()=>page.locator('html').getAttribute('data-contrast')).toBe('more');await expect.poll(()=>page.locator('html').getAttribute('data-ground')).toBe('wash');
   expect(await page.locator('meta[name=viewport]').getAttribute('content')).not.toContain('user-scalable=no');
  }
  app.writes.run(()=>db.update(agents).set({about:'Keeps the shared desk readable.'}).where(eq(agents.id,'art')).run());
  for(const page of [a,b]){await page.goto(app.url+'/p/agents-preview/agent/art');await expect.poll(()=>page.getByText('Keeps the shared desk readable.',{exact:true}).count()).toBe(1);expect(await page.getByRole('button',{name:'Edit profile in Setup',exact:false}).count()).toBe(0);}
  const shots=resolve('artifacts/desk-shell');mkdirSync(shots,{recursive:true});
  for(const look of ['neon','lowlight','daylight']){
   await set({look},'look-'+look);
   for(const width of [390,1280,1440]){
    await b.setViewportSize({width,height:900});await b.goto(app.url);
    await expect.poll(()=>b.locator('html').getAttribute('data-look')).toBe(look);
    await expect.poll(()=>b.getByRole('heading',{name:'Needs you · 1',exact:true}).count()).toBe(1);
    await expect.poll(()=>b.locator('.desk-home-card').count()).toBe(width<1024?1:5);
    expect(await b.locator('.desk-home-compact').count()).toBe(width<1024?4:0);
    expect(await b.evaluate(()=>document.documentElement.scrollWidth)).toBeLessThanOrEqual(width);
    await b.evaluate(()=>document.fonts.ready);await b.screenshot({path:join(shots,`new-home-${look}-${width}.png`),animations:'disabled'});
    await b.locator('.next-preferences summary').click();await expect.poll(()=>b.getByRole('combobox',{name:'Look',exact:true}).isVisible()).toBe(true);
    await b.screenshot({path:join(shots,`new-preferences-${look}-${width}.png`),animations:'disabled'});await b.locator('.next-preferences summary').click();
    await b.getByText('The shared desk reader is ready.',{exact:true}).scrollIntoViewIfNeeded();
    await b.screenshot({path:join(shots,`new-home-answer-${look}-${width}.png`),animations:'disabled'});
    const first=b.getByRole('list',{name:'First waiting item',exact:true});
    await first.getByRole('button').click();
    await expect.poll(()=>new URL(b.url()).pathname).toBe('/p/inbox-preview/ask/'+encodeURIComponent(question.inboxItem!));
    await expect.poll(()=>b.locator('[data-tile=inbox]').getByText('OK to run the backup now?',{exact:true}).count()).toBeGreaterThan(0);
    await b.screenshot({path:join(shots,`new-work-${look}-${width}.png`),animations:'disabled'});
    if(width>=1024){await expect.poll(()=>b.locator('.desk-rail-card').count()).toBe(1);await b.locator('.next-rail').screenshot({path:join(shots,`new-rail-${look}-${width}.png`),animations:'disabled'});}
    await b.getByRole('button',{name:'All apps',exact:true}).first().click();
    await expect.poll(()=>b.getByRole('textbox',{name:'Find an app',exact:true}).isVisible()).toBe(true);
    await b.screenshot({path:join(shots,`new-launcher-${look}-${width}.png`),animations:'disabled'});await b.keyboard.press('Escape');
    await b.goto(app.url+'/p/agents-preview/agent/art');await expect.poll(()=>b.getByText('Keeps the shared desk readable.',{exact:true}).count()).toBe(1);
    expect(await b.evaluate(()=>document.documentElement.scrollWidth)).toBeLessThanOrEqual(width);await b.screenshot({path:join(shots,`new-agent-${look}-${width}.png`),animations:'disabled'});
   }
  }
  // Changing ownership must remove cards even though an owner's directory and
  // status rows remain visible. This is an actual same-root write + socket read.
  await b.goto(app.url);app.writes.run(()=>db.delete(memberAgents).run());
  await expect.poll(()=>b.getByText('No agents of your own',{exact:true}).count()).toBe(1);expect(db.select().from(agents).all()).toHaveLength(5);
  expect(maximumConnections).toBe(1);expect(connections.get(a)).toBe(1);expect(connections.get(b)).toBe(1);
  expect((await fetch(app.url+'/manifest.webmanifest')).status).toBe(200);expect((await fetch(app.url+'/sw.js')).headers.get('service-worker-allowed')).toBe('/');
  app.writes.run(()=>db.update(tokens).set({revokedAt:now()}).where(eq(tokens.fingerprint,fingerprint)).run());
  for(const page of [a,b])await expect.poll(()=>page.getByText('OK to run the backup now?',{exact:true}).count()).toBe(0);
  expect(errors).toEqual([]);
 }finally{await browser?.close();await app.close();client.close();}
},300000);
