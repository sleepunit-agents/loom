/** The shipped desk on the actual shared HTTP/socket listener; CI owns Chromium.
 * Production root composition owns the readers and lifetime. No legacy home,
 * JSON records, copied app or route feeds. */
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
import {agents,agentStatus,household,members,memberAgents,tokens,jobs,boxes} from '../core/data/schema.js';
import {CommsMessages} from '../core/conversations/messages.js';
import {wordsKey} from '../pieces/comms/crypto.js';
import {serveShared} from '../shared-serve.js';
import {storeDeskSprite} from '../desk-sprites.js';
import {manifestFromPixelLab} from '../household.js';
import {sheet} from './pixel-sheet.fixture.js';
const enabled=process.env.LOOM_DESK_EVIDENCE==='1',chrome=process.env.LOOM_TEST_CHROME,webRoot=resolve('dist/web');
if(enabled&&(!chrome||!existsSync(chrome)||!existsSync(join(webRoot,'next.html'))))throw Error('Desk evidence needs Chrome and the built app');
it.runIf(enabled)('shared desk applies live appearance, renders owned cards and opens actual Inbox rows at three looks and sizes',async()=>{
 const client=new Database(':memory:'),clock=new FakeClock(Date.now()),now=()=>new Date(clock.now()).toISOString(),db=createDataSchema(client,now);
 const raw='d'.repeat(64),fingerprint=createHash('sha256').update(raw).digest('hex');
 db.insert(members).values({id:'owner',role:'owner',joinedAt:now()}).run();
 db.insert(household).values({timezone:'America/Chicago'}).run();
 const ids=['art','birch','cedar','elm','fern'];
 db.insert(agents).values(ids.map((id,position)=>({id,position,about:id==='art'?'Keeps the household moving.':'',markBg:'#B8A6FF',markFg:'#ffffff',faceShape:'pebble' as const,faceEyes:'dot' as const}))).run();
 db.insert(memberAgents).values(ids.map(agent=>({member:'owner',agent}))).run();
 db.insert(agentStatus).values(ids.map(agent=>({agent,state:agent==='art'?'working' as const:'idle' as const,work:agent==='art'?'Rebuilding the shared desk':'',changedAt:now()}))).run();
 db.insert(tokens).values({fingerprint,label:'Disposable desk fixture',kind:'owner',member:'owner',createdAt:now()}).run();
 const privateBrief='PRIVATE JOB INSTRUCTIONS OMITTED';db.insert(jobs).values({id:'desk-current-job',agent:'art',member:'owner',state:'waiting',title:'Fixture current desk work',brief:privateBrief,model:'fixture-model',startedByKind:'agent',startedBy:'art',houseRepository:'fixture',houseFile:'Housefile',houseBranch:'next',queuedAt:now()}).run();
 const machine={owner:'owner',sameMachineAsLoom:false,hostsAny:false,reportOnly:false,alwaysOn:false,enrolledAt:now()};
 db.insert(boxes).values([{...machine,id:'desk-box',name:'Disposable worker'},{...machine,id:'retired-box',name:'Retired worker',revokedAt:now()}]).run();
 const picture=sheet(),layout=manifestFromPixelLab(JSON.parse(picture.json.toString()));storeDeskSprite(db,'art',layout,{'sheet.png':picture.png});
 const key=wordsKey(await generateX25519Identity()),messages=new CommsMessages(db,key,now);
 const thread=messages.threads.open({member:'owner',agent:'art',title:'Desk fixture conversation'});
 await messages.send({thread:thread.id,sender:'art',kind:'reply',words:'The shared desk reader is ready.'});
 const question=await messages.ask(thread.id,'art','desk-question',{words:'OK to run the backup now?',why:'A disposable browser fixture question.',answers:'yes-no'});
 const app=await serveShared({db,clock,webRoot,commsKey:key,originAllowed:req=>!req.headers.origin||req.headers.origin===`http://${req.headers.host}`,reportError:error=>{throw error;}});
 let browser:Awaited<ReturnType<typeof chromium.launch>>|undefined;
 try {
  browser=await chromium.launch({executablePath:chrome,args:['--no-sandbox']});
  const context=await browser.newContext({viewport:{width:1280,height:900},serviceWorkers:'block',hasTouch:true});
  await context.addInitScript(()=>{const w=window as typeof window&{__deskVibrations:number};w.__deskVibrations=0;Object.defineProperty(navigator,'vibrate',{value:()=>{w.__deskVibrations++;return true;}});});
  const a=await context.newPage(),b=await context.newPage(),errors:string[]=[],connections=new Map<Page,number>();let maximumConnections=0,legacyConnections=0,faceRequests=0;
  for(const page of [a,b]){page.on('pageerror',error=>errors.push(error.message));page.on('request',request=>{if(new URL(request.url()).pathname.startsWith('/faces/'))faceRequests++;if(request.isNavigationRequest()&&request.frame()===page.mainFrame())connections.set(page,0);});page.on('websocket',socket=>{if(new URL(socket.url()).pathname==='/graphql'){const count=(connections.get(page)??0)+1;connections.set(page,count);maximumConnections=Math.max(maximumConnections,count);}else if(new URL(socket.url()).pathname==='/live')legacyConnections++;});}
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
  for(const page of [a,b]){await expect.poll(()=>page.getByText('Fixture current desk work',{exact:true}).count()).toBe(1);expect(await page.locator('body').innerText()).not.toContain(privateBrief);}
  for(const page of [a,b])await expect.poll(()=>page.getByRole('img',{name:'1 enrolled box; health unavailable',exact:true}).count()).toBe(1);
  app.writes.run(()=>db.update(boxes).set({revokedAt:now()}).where(eq(boxes.id,'desk-box')).run());
  for(const page of [a,b])await expect.poll(()=>page.getByRole('img',{name:'0 enrolled boxes; health unavailable',exact:true}).count()).toBe(1);
  app.writes.run(()=>db.insert(boxes).values({...machine,id:'new-desk-box',name:'New disposable worker'}).run());
  for(const page of [a,b])await expect.poll(()=>page.getByRole('img',{name:'1 enrolled box; health unavailable',exact:true}).count()).toBe(1);
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
  // Accessibility choices belong to this shared Appearance control, rather
  // than the retired Accessibility app. Follow reacts to each device live.
  await set({motion:'follow',contrast:'follow'},'access-follow');
  await b.emulateMedia({reducedMotion:'reduce',contrast:'more'});
  await expect.poll(()=>b.locator('html').getAttribute('data-motion')).toBe('reduce');
  await expect.poll(()=>b.locator('html').getAttribute('data-contrast')).toBe('more');
  await b.emulateMedia({reducedMotion:'no-preference',contrast:'no-preference'});
  await expect.poll(()=>b.locator('html').getAttribute('data-motion')).toBe('full');
  await expect.poll(()=>b.locator('html').getAttribute('data-contrast')).toBe('normal');
  await set({motion:'on',contrast:'on'},'access-on');
  for(const page of [a,b]){await expect.poll(()=>page.locator('html').getAttribute('data-motion')).toBe('reduce');await expect.poll(()=>page.locator('html').getAttribute('data-contrast')).toBe('more');}
  await b.emulateMedia({reducedMotion:'reduce',contrast:'more'});
  await set({motion:'off',contrast:'off'},'access-off');
  await expect.poll(()=>b.locator('html').getAttribute('data-motion')).toBe('full');
  await expect.poll(()=>b.locator('html').getAttribute('data-contrast')).toBe('normal');
  await set({motion:'on',contrast:'on'},'access-restore');
  const painted=async(page:Page)=>page.locator('.desk-home-card .loom-pixel-face canvas').evaluateAll(nodes=>nodes.some(node=>{const canvas=node as HTMLCanvasElement,pixels=canvas.getContext('2d')?.getImageData(0,0,canvas.width,canvas.height).data;return pixels?.some((value,index)=>index%4===3&&value>0);}));
  for(const page of [a,b]){
   await expect.poll(()=>painted(page)).toBe(true);
   const scale=await page.locator('.desk-home-card .loom-pixel-face canvas').first().evaluate(node=>{const canvas=node as HTMLCanvasElement,box=canvas.getBoundingClientRect();return {x:box.width/canvas.width,y:box.height/canvas.height};});
   expect(Number.isInteger(scale.x)&&scale.x>=1).toBe(true);expect(scale.y).toBe(scale.x);
  }
  await set({pixel:false},'pixel-off');for(const page of [a,b]){await expect.poll(()=>page.locator('.desk-home-card .loom-pixel-face').count()).toBe(0);await expect.poll(()=>page.locator('.desk-home-card [data-slot=agent-face]').count()).toBe(5);}
  await set({pixel:true},'pixel-on');for(const page of [a,b])await expect.poll(()=>painted(page)).toBe(true);
  // Validly stored but undecodable bytes use the drawn fallback; a later valid
  // version recovers through the same query connection, without an asset route.
  app.writes.run(()=>storeDeskSprite(db,'art',layout,{'sheet.png':picture.png.subarray(0,8)}));
  for(const page of [a,b])await expect.poll(()=>page.locator('.desk-home-card [data-slot=agent-face]').count()).toBe(5);
  app.writes.run(()=>storeDeskSprite(db,'art',layout,{'sheet.png':picture.png}));for(const page of [a,b])await expect.poll(()=>painted(page)).toBe(true);
  app.writes.run(()=>db.update(agents).set({about:'Keeps the shared desk readable.'}).where(eq(agents.id,'art')).run());
  for(const page of [a,b]){await page.goto(app.url+'/p/agents-preview/agent/art');await expect.poll(()=>page.getByText('Keeps the shared desk readable.',{exact:true}).count()).toBe(1);expect(await page.getByRole('button',{name:'Edit profile in Setup',exact:false}).count()).toBe(0);}
  expect(legacyConnections).toBe(0);
  const clockTitle=new Intl.DateTimeFormat('en-US',{timeZone:'America/Chicago',hour:'numeric',minute:'2-digit',hourCycle:'h12'}).format(clock.now())+', America/Chicago time';
  await expect.poll(()=>b.locator('.next-system-clock').getAttribute('title')).toBe(clockTitle);
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
    const first=b.getByRole('group',{name:'First waiting item',exact:true});
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
  // Shell behavior uses actual registered apps on the same shared program.
  // Paths survive reload; minimizing and Home retain the existing tile state.
  await b.setViewportSize({width:1440,height:900});await b.goto(app.url+'/p/agents-preview/agent/art');
  await expect.poll(()=>b.locator('[data-tile=agents]').count()).toBe(1);
  await b.getByRole('button',{name:'All apps',exact:true}).first().click();
  const launcher=b.getByRole('dialog',{name:'Apps',exact:true});
  for(const group of ['Work','People & agents','Library','System'])expect(await launcher.getByRole('region',{name:group,exact:true}).count()).toBe(1);
  const inventory=await launcher.locator('.loom-lapp__nm').allTextContents();await b.keyboard.press('Escape');
  await expect.poll(()=>launcher.count()).toBe(0);
  for(const title of inventory)expect(await b.getByRole('button',{name:title==='Home'?'Home':`Open ${title}`,exact:true}).count()).toBeGreaterThan(0);
  await b.getByRole('button',{name:'All apps',exact:true}).first().click();
  const find=launcher.getByRole('textbox',{name:'Find an app',exact:true});
  await find.fill('not-an-installed-app');await expect.poll(()=>launcher.getByRole('status').innerText()).toContain('No app called');
  await find.fill('Tas');await expect.poll(()=>launcher.locator('.loom-lapp').allTextContents()).toEqual(['Tasks']);
  await find.press('Enter');await expect.poll(()=>launcher.count()).toBe(0);
  await expect.poll(()=>b.locator('[data-tile]').count()).toBe(2);
  const paths=JSON.parse(new URL(b.url()).searchParams.get('paths')??'{}');expect(paths.agents).toBe('/p/agents-preview/agent/art');
  await b.reload();await expect.poll(()=>b.locator('[data-tile]').count()).toBe(2);
  await expect.poll(()=>b.getByText('Keeps the shared desk readable.',{exact:true}).count()).toBe(1);
  await b.locator('.next-preferences summary').click();
  const oneWindow=b.getByRole('checkbox',{name:'One window at a time',exact:true});
  await oneWindow.check();await expect.poll(()=>b.locator('[data-tile]').count()).toBe(1);
  await b.getByRole('button',{name:'Open Agents',exact:true}).click();
  await expect.poll(()=>new URL(b.url()).pathname).toBe('/p/agents-preview/agent/art');
  await oneWindow.uncheck();await expect.poll(()=>b.locator('[data-tile]').count()).toBe(2);
  await b.locator('.next-preferences summary').click();
  await b.getByRole('button',{name:'Minimize Tasks',exact:true}).click();await expect.poll(()=>b.locator('[data-tile]').count()).toBe(1);
  await b.getByRole('button',{name:'Open Tasks',exact:true}).click();await expect.poll(()=>b.locator('[data-tile]').count()).toBe(2);
  const makeBig=b.getByRole('button',{name:'Make Tasks big',exact:true});await makeBig.focus();
  await expect.poll(()=>makeBig.evaluate(button=>document.activeElement===button&&button.closest('[data-tile]')?.hasAttribute('data-focused')===true)).toBe(true);
  await b.keyboard.press('Alt+Shift+Enter');await expect.poll(()=>b.locator('[data-tile]').first().getAttribute('data-tile')).toBe('tasks');
  await b.keyboard.press('Alt+h');await expect.poll(()=>b.locator('[data-tile]').count()).toBe(0);
  await b.getByRole('button',{name:'Home',exact:true}).click();await expect.poll(()=>b.locator('[data-tile]').count()).toBe(2);
  // Home's two-phase composer uses real shared cookie HTTP operations and
  // returns to current query facts; navigation alone is not a successful send.
  clock.advance(1); // Distinguish the new thread's lastAt from the seeded one.
  await b.goto(app.url);
  const compose=b.getByRole('region',{name:'Message Art',exact:true}),draftWords='Disposable shared desk composer message';
  await compose.getByRole('textbox',{name:'Message',exact:true}).fill(draftWords);
  const opened=b.waitForResponse(response=>response.request().method()==='POST'&&new URL(response.url()).pathname==='/api/comms/open');
  const sent=b.waitForResponse(response=>response.request().method()==='POST'&&new URL(response.url()).pathname==='/api/comms/send');
  await compose.getByRole('button',{name:'Send',exact:true}).click();
  const openResponse=await opened,sendResponse=await sent;expect(openResponse.status()).toBe(200);expect(sendResponse.status()).toBe(200);
  const openResult=await openResponse.json(),sendResult=await sendResponse.json();expect(openResult.ok).toBe(true);expect(sendResult.ok).toBe(true);expect(sendResult.value.thread).toBe(openResult.value.thread);
  await expect.poll(()=>new URL(b.url()).pathname).toBe('/p/comms-preview/thread/'+encodeURIComponent(openResult.value.thread.replace(/^th:/,'')));
  const confirmed=await app.http.request('/graphql',{method:'POST',headers:{authorization:'Bearer '+raw,'content-type':'application/json'},body:JSON.stringify({query:`{ commsMessages(thread:${JSON.stringify(openResult.value.thread)}) { words } }`})});
  expect((await confirmed.json()).data.commsMessages.map((message:{words:string})=>message.words)).toEqual([draftWords]);
  await b.goto(app.url);await expect.poll(()=>compose.getByRole('textbox',{name:'Message',exact:true}).inputValue()).toBe('');
  await expect.poll(()=>b.getByRole('region',{name:'Art conversations',exact:true}).getByRole('button',{name:/New conversation/}).count()).toBe(1);
  // A supporting touch browser gets navigation feedback only when enabled.
  const vibrations=()=>b.evaluate(()=>(window as typeof window&{__deskVibrations:number}).__deskVibrations);
  await set({haptics:false},'haptics-off');await expect.poll(()=>b.locator('html').getAttribute('data-haptics')).toBe('off');
  const muted=await vibrations();await b.getByRole('button',{name:'Open Agents',exact:true}).click();
  await expect.poll(()=>b.locator('[data-tile=agents]').count()).toBe(1);expect(await vibrations()).toBe(muted);
  await set({haptics:true},'haptics-on');await expect.poll(()=>b.locator('html').getAttribute('data-haptics')).toBe('on');
  const audible=await vibrations();await b.getByRole('button',{name:'Open Tasks',exact:true}).click();await expect.poll(vibrations).toBeGreaterThan(audible);
  // Changing ownership must remove cards even though an owner's directory and
  // status rows remain visible. This is an actual same-root write + socket read.
  await b.goto(app.url);app.writes.run(()=>db.delete(memberAgents).run());
  await expect.poll(()=>b.getByText('No agents of your own',{exact:true}).count()).toBe(1);expect(db.select().from(agents).all()).toHaveLength(5);
  expect(faceRequests).toBe(0);expect(maximumConnections).toBe(1);expect(connections.get(a)).toBe(1);expect(connections.get(b)).toBe(1);
  expect((await fetch(app.url+'/manifest.webmanifest')).status).toBe(200);expect((await fetch(app.url+'/sw.js')).headers.get('service-worker-allowed')).toBe('/');
  app.writes.run(()=>db.update(tokens).set({revokedAt:now()}).where(eq(tokens.fingerprint,fingerprint)).run());
  for(const page of [a,b])await expect.poll(()=>page.getByText('OK to run the backup now?',{exact:true}).count()).toBe(0);
  expect(errors).toEqual([]);
 }finally{await browser?.close();await app.close();client.close();}
},300000);
