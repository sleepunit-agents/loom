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
import {manifestFromPixelLab,sheet} from './pixel-sheet.fixture.js';
import {deskMemoryFixture} from './desk-memory.fixture.js';
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
 const privateBrief='PRIVATE JOB INSTRUCTIONS OMITTED';db.insert(jobs).values({id:'desk-current-job',agent:'art',member:'owner',state:'running',title:'Fixture current desk work',brief:privateBrief,model:'fixture-model',startedByKind:'agent',startedBy:'art',houseRepository:'fixture',houseFile:'Housefile',houseBranch:'next',queuedAt:now()}).run();
 const machine={owner:'owner',sameMachineAsLoom:false,hostsAny:false,reportOnly:false,alwaysOn:false,enrolledAt:now()};
 db.insert(boxes).values([{...machine,id:'desk-box',name:'Disposable worker'},{...machine,id:'retired-box',name:'Retired worker',revokedAt:now()}]).run();
 const picture=sheet(),layout=manifestFromPixelLab(JSON.parse(picture.json.toString()));storeDeskSprite(db,'art',layout,{'sheet.png':picture.png});
 const key=wordsKey(await generateX25519Identity()),messages=new CommsMessages(db,key,now);
 const thread=messages.threads.open({member:'owner',agent:'art',title:'Desk fixture conversation'});
 await messages.send({thread:thread.id,sender:'art',kind:'reply',words:'The shared desk reader is ready.'});
 const question=await messages.ask(thread.id,'art','desk-question',{words:'OK to run the backup now?',why:'A disposable browser fixture question.',answers:'yes-no'});
 // Newer unanswered threads must not hide the latest actual agent reply.
 for(let n=0;n<9;n++){clock.advance(1);messages.threads.open({member:'owner',agent:'art',title:`Unanswered seed ${n}`});}
 const memory=deskMemoryFixture(ids),displayName=memory.name;
 const activityTitle='Shared desk activity proof',activitySummary='The actual shared Activity reader is available from Home.';
 clock.advance(1);
 const history=messages.threads.conversations;
 const activity=history.open({agent:'art',member:'owner',venue:'wake',place:'desk-activity-fixture',label:activityTitle});
 history.turn({conversation:activity.id,kind:'reply',fromKind:'agent',fromId:'art'});
 const digest=history.digest({conversation:activity.id,run:'fictional-desk-activity',summary:activitySummary});
 let browser:Awaited<ReturnType<typeof chromium.launch>>|undefined;
 let closeApp=async()=>{};
 try {
  const app=await serveShared({db,clock,webRoot,commsKey:key,memory:{sources:memory.sources,checkingAgent:'art'},originAllowed:req=>!req.headers.origin||req.headers.origin===`http://${req.headers.host}`,reportError:error=>{throw error;}});
  closeApp=()=>app.close();
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
  for(const page of [a,b]){
   await expect.poll(()=>page.getByRole('heading',{name:displayName,exact:true}).count()).toBe(1);
   expect(await page.getByRole('link',{name:`Open ${displayName} ›`,exact:true}).count()).toBe(1);
  }
  // An agent's steps are on its own page in the Agents app; Home's card is the summary that leads there.
  await b.getByRole('link',{name:`Open ${displayName} ›`,exact:true}).click();
  await expect.poll(()=>new URL(b.url()).pathname).toBe('/p/agents-preview/agent/art');
  const steps=b.locator('[data-tile=agents]').getByRole('region',{name:'Last steps',exact:true});
  await expect.poll(()=>steps.getByText(activityTitle,{exact:true}).count()).toBe(1);
  await steps.getByText(activityTitle,{exact:true}).click();
  await expect.poll(()=>new URL(b.url()).pathname).toBe('/p/activity-preview/');
  expect(new URL(b.url()).searchParams.get('who')).toBe('art');
  expect(new URL(b.url()).searchParams.get('e')).toBe(`d~art~${digest.id}`);
  const activityTile=b.locator('[data-tile=activity]');
  await expect.poll(()=>activityTile.getByRole('heading',{name:activityTitle,exact:true}).count()).toBe(1);
  await expect.poll(()=>activityTile.getByText(activitySummary,{exact:true}).count()).toBeGreaterThan(0);
  await b.goto(app.url);
  for(const page of [a,b])await expect.poll(()=>page.getByRole('region',{name:'Needs you',exact:true}).getByText('Needs you · 1',{exact:true}).count()).toBe(1);
  for(const page of [a,b]){await expect.poll(()=>page.getByText('Fixture current desk work',{exact:true}).count()).toBe(1);expect(await page.locator('body').innerText()).not.toContain(privateBrief);}
  for(const page of [a,b])await expect.poll(()=>page.getByRole('img',{name:'1 enrolled box',exact:true}).count()).toBe(1);
  app.writes.run(()=>db.update(boxes).set({revokedAt:now()}).where(eq(boxes.id,'desk-box')).run());
  for(const page of [a,b])await expect.poll(()=>page.getByRole('img',{name:'0 enrolled boxes',exact:true}).count()).toBe(1);
  app.writes.run(()=>db.insert(boxes).values({...machine,id:'new-desk-box',name:'New disposable worker'}).run());
  for(const page of [a,b])await expect.poll(()=>page.getByRole('img',{name:'1 enrolled box',exact:true}).count()).toBe(1);
  // Appearance is an app in a tile like any other: open it from the launcher, choose, close it.
  await a.getByRole('button',{name:'All apps',exact:true}).first().click();
  await a.getByRole('dialog',{name:'Apps',exact:true}).getByRole('region',{name:'Look & feel',exact:true}).getByRole('button',{name:'Appearance',exact:true}).click();
  const appearance=a.getByRole('region',{name:'Appearance tile',exact:true});
  await appearance.getByText('Daylight',{exact:true}).press('Enter');
  for(const page of [a,b])await expect.poll(()=>page.locator('html').getAttribute('data-look')).toBe('daylight');
  await appearance.getByRole('button',{name:'Close Appearance',exact:true}).click();await expect.poll(()=>a.locator('[data-tile]').count()).toBe(0);
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
  // Use Setup in a separate window. The already-open desks must update without a reload.
  const setup=await context.newPage();
  await setup.goto(app.url+'/p/setup-preview');
  const portrait=setup.getByRole('form',{name:'Animated portrait for fern'});
  const assign=async(data:ReturnType<typeof sheet>,label:string)=>{
    await portrait.locator('[name=png]').setInputFiles({name:'sheet.png',mimeType:'image/png',buffer:data.png});
    await portrait.locator('[name=metadata]').setInputFiles({name:'export.json',mimeType:'application/json',buffer:data.json});
    const reply=setup.waitForResponse(response=>response.url().endsWith('/api/household/setPortrait'));
    await portrait.getByRole('button',{name:label}).click();
    expect((await reply).status()).toBe(200);
  };
  const fernColor=(page:Page,red:number)=>page.locator('.desk-home-card[data-agent="fern"] canvas').evaluateAll((nodes,red)=>{
    return nodes.some(node=>{
      const canvas=node as HTMLCanvasElement;
      const pixels=canvas.getContext('2d')?.getImageData(0,0,canvas.width,canvas.height).data;
      return pixels?.some((v,i)=>i%4===0&&v===red&&pixels[i+1]===0xe6&&pixels[i+2]===0xf0&&pixels[i+3]===255);
    });
  },red);
  const faceCount=()=>b.locator('.desk-home-card .loom-pixel-face canvas').count();
  const version=(id:string)=>db.select().from(agents).where(eq(agents.id,id)).get()?.spriteVersion;
  const artVersion=version('art');
  await assign(picture,'Add portrait');
  await expect.poll(faceCount).toBe(2);
  const first=version('fern');
  for(const page of [a,b])await expect.poll(()=>fernColor(page,0x2e)).toBe(true);
  const concurrent=await context.newPage();
  await concurrent.goto(app.url+'/p/setup-preview');
  const draft=concurrent.getByRole('form',{name:'Animated portrait for fern'});
  await draft.locator('[name=png]').setInputFiles({name:'sheet.png',mimeType:'image/png',buffer:picture.png});
  await draft.locator('[name=metadata]').setInputFiles({name:'export.json',mimeType:'application/json',buffer:picture.json});
  await assign(sheet(['south'],0x99),'Replace portrait');
  for(const page of [a,b])await expect.poll(()=>fernColor(page,0x99)).toBe(true);
  expect(version('fern')).not.toBe(first);
  await expect.poll(faceCount).toBe(2);
  await draft.getByRole('button',{name:'Replace portrait'}).click();
  await draft.getByText(/portrait changed/i).waitFor();
  await concurrent.close();
  let lostId='';
  await setup.route('**/api/household/setPortrait',async route=>{
    lostId=route.request().postDataJSON().id;
    expect((await route.fetch()).status()).toBe(200);
    await route.abort();
  },{times:1});
  await portrait.getByRole('button',{name:'Use generated face'}).click();
  await expect.poll(faceCount).toBe(1);
  const replay=setup.waitForResponse(response=>response.url().endsWith('/api/household/setPortrait'));
  await portrait.getByRole('button',{name:'Retry portrait change'}).click();
  const recovered=await replay;
  expect(recovered.status()).toBe(200);
  expect(recovered.request().postDataJSON().id).toBe(lostId);
  expect(version('fern')).toBeNull();
  expect(version('art')).toBe(artVersion);
  await setup.close();
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
    await expect.poll(()=>b.getByRole('region',{name:'Needs you',exact:true}).locator('.desk-needs-label').textContent()).toBe('Needs you · 1');
    await expect.poll(()=>b.locator('.desk-home-card').count()).toBe(width<1024?1:5);
    expect(await b.locator('.desk-home-compact').count()).toBe(width<1024?4:0);
    expect(await b.evaluate(()=>document.documentElement.scrollWidth)).toBeLessThanOrEqual(width);
    await b.evaluate(()=>document.fonts.ready);await b.screenshot({path:join(shots,`new-home-${look}-${width}.png`),animations:'disabled'});
    await b.getByRole('button',{name:'Open Appearance',exact:true}).click();await expect.poll(()=>b.getByText('Daylight',{exact:true}).isVisible()).toBe(true);
    await b.screenshot({path:join(shots,`new-preferences-${look}-${width}.png`),animations:'disabled'});await b.getByRole('button',{name:'Close Appearance',exact:true}).click();
    await b.getByText('The shared desk reader is ready.',{exact:true}).scrollIntoViewIfNeeded();
    await b.screenshot({path:join(shots,`new-home-answer-${look}-${width}.png`),animations:'disabled'});
    await b.getByRole('region',{name:'Needs you',exact:true}).locator('.desk-need-open').first().click();
    await expect.poll(()=>new URL(b.url()).pathname).toBe('/p/inbox-preview/ask/'+encodeURIComponent(question.inboxItem!));
    await expect.poll(()=>b.locator('[data-tile=inbox]').getByText('OK to run the backup now?',{exact:true}).count()).toBeGreaterThan(0);
    await b.screenshot({path:join(shots,`new-work-${look}-${width}.png`),animations:'disabled'});
    if(width>=1024){await expect.poll(()=>b.locator('.desk-rail-card').count()).toBe(1);await b.locator('.next-rail').screenshot({path:join(shots,`new-rail-${look}-${width}.png`),animations:'disabled'});}
    await b.goto(app.url+'/p/comms-preview/thread/'+encodeURIComponent(thread.id.replace(/^th:/,'')));
    const screen=width>=1280?b.getByRole('region',{name:`${displayName}'s comm screen`,exact:true}):b.locator('.desk-comms-mini');
    await expect.poll(()=>screen.count()).toBe(1);
    await expect.poll(()=>screen.getAttribute('data-location')).toBe(width>=1280?'rail':'inline');
    if(width>=1280){const glass=await screen.locator('.desk-comms-glass').boundingBox();expect(glass?.width).toBe(194);expect(glass?.height).toBe(194);}
    else expect(await screen.getByRole('button',{name:`Open ${displayName}`}).count()).toBe(1);
    if(width>=1280){await expect.poll(()=>b.locator('.desk-agent-rail > [data-companion=true]').getAttribute('data-agent')).toBe('art');expect(await b.locator('.next-rail .desk-comms-screen').count()).toBe(1);}
    expect(await b.evaluate(()=>document.documentElement.scrollWidth)).toBeLessThanOrEqual(width);
    await b.screenshot({path:join(shots,`new-comms-${look}-${width}.png`),animations:'disabled'});
    await b.goto(app.url+'/p/agents-preview/agent/art');await expect.poll(()=>b.locator('.desk-comms-screen').count()).toBe(0);
    await b.getByRole('button',{name:'All apps',exact:true}).first().click();
    await expect.poll(()=>b.getByRole('textbox',{name:'Find an app',exact:true}).isVisible()).toBe(true);
    await b.screenshot({path:join(shots,`new-launcher-${look}-${width}.png`),animations:'disabled'});await b.keyboard.press('Escape');
    await b.goto(app.url+'/p/agents-preview/agent/art');await expect.poll(()=>b.getByText('Keeps the shared desk readable.',{exact:true}).count()).toBe(1);
    expect(await b.evaluate(()=>document.documentElement.scrollWidth)).toBeLessThanOrEqual(width);await b.screenshot({path:join(shots,`new-agent-${look}-${width}.png`),animations:'disabled'});
   }
  }
  // A reply in a different open thread animates even while Art has a question elsewhere.
  const portraitThread=app.writes.run(()=>messages.threads.open({member:'owner',agent:'art',title:'Live portrait'})).value;
  const portraitUrl=app.url+'/p/comms-preview/thread/'+encodeURIComponent(portraitThread.id.replace(/^th:/,''));
  await set({motion:'off'},'portrait-motion');
  await b.goto(portraitUrl);
  const replyScreen=b.locator('.desk-comms-screen');
  await expect.poll(()=>replyScreen.locator('canvas').count()).toBe(1);
  app.writes.run(await messages.prepareSend({thread:portraitThread.id,sender:'art',kind:'reply',words:'A new live reply.'}));
  await expect.poll(()=>replyScreen.getAttribute('data-face'),{interval:50}).toBe('talking');
  await expect.poll(()=>replyScreen.getAttribute('data-face'),{interval:50}).toBe('complete');
  await expect.poll(()=>replyScreen.getAttribute('data-face')).toBe('working');
  await b.reload();
  await expect.poll(()=>replyScreen.locator('canvas').count()).toBe(1);
  expect(await replyScreen.getAttribute('data-face')).toBe('working');
  await set({motion:'on'},'portrait-restore');
  // A narrow desktop keeps the compact companion inline; minimizing clears
  // selection even though the reader component remains mounted in the tile.
  await b.setViewportSize({width:1024,height:900});await b.goto(app.url+'/p/comms-preview/thread/'+encodeURIComponent(thread.id.replace(/^th:/,'')));
  await expect.poll(()=>b.locator('.desk-comms-mini').getAttribute('data-location')).toBe('inline');
  await b.getByRole('button',{name:'Minimize Comms',exact:true}).click();
  await expect.poll(()=>b.locator('.desk-comms-screen').count()).toBe(0);expect(await b.locator('[data-companion=true]').count()).toBe(0);
  // Shell behavior uses actual registered apps on the same shared program.
  // Paths survive reload; minimizing and Home retain the existing tile state.
  await b.setViewportSize({width:1440,height:900});await b.goto(app.url+'/p/agents-preview/agent/art');
  await expect.poll(()=>b.locator('[data-tile=agents]').count()).toBe(1);
  await b.getByRole('button',{name:'All apps',exact:true}).first().click();
  const launcher=b.getByRole('dialog',{name:'Apps',exact:true});
  for(const group of ['Work','People & agents','Library','System','Look & feel'])expect(await launcher.getByRole('region',{name:group,exact:true}).count()).toBe(1);
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
  // The saved choice, through the same command the Appearance app sends (its own switch is exercised by the
  // rebuild walkthrough and web/src/pieces/appearance/index.test.tsx); an Appearance tile here would change the counts.
  await set({oneWindow:true},'one-window-on');await expect.poll(()=>b.locator('[data-tile]').count()).toBe(1);
  await b.getByRole('button',{name:'Open Agents',exact:true}).click();
  await expect.poll(()=>new URL(b.url()).pathname).toBe('/p/agents-preview/agent/art');
  await set({oneWindow:false},'one-window-off');await expect.poll(()=>b.locator('[data-tile]').count()).toBe(2);
  await b.getByRole('button',{name:'Minimize Tasks',exact:true}).click();await expect.poll(()=>b.locator('[data-tile]').count()).toBe(1);
  await b.getByRole('button',{name:'Open Tasks',exact:true}).click();await expect.poll(()=>b.locator('[data-tile]').count()).toBe(2);
  const maximize=b.getByRole('button',{name:'Maximize Tasks',exact:true});
  const strip=b.locator('[aria-label="Tasks tile"] .next-strip');
  // A dialog in another tile is modal only to that app, whether visible or covered.
  await b.locator('[aria-label="Agents tile"]').evaluate(tile=>{
   const dialog=document.createElement('div');dialog.setAttribute('role','dialog');dialog.dataset.fixture='covered';tile.append(dialog);
  });
  await maximize.focus();await maximize.press('Alt+Shift+F');
  await expect.poll(()=>b.locator('[data-tile]').count()).toBe(1);
  await b.getByRole('button',{name:'Restore Tasks',exact:true}).press('Alt+Shift+F');
  await b.locator('[data-fixture=covered]').evaluate(el=>el.remove());
  await expect.poll(()=>b.locator('[data-tile]').count()).toBe(2);
  await strip.click({button:'right'});await b.getByRole('menuitem',{name:'Maximize',exact:true}).click();
  await strip.click({button:'right'});await b.getByRole('menuitem',{name:'Restore size',exact:true}).click();
  const otherStrip=b.locator('[data-tile] .next-strip').nth(1);
  const promoted=await otherStrip.evaluate(el=>el.closest('[data-tile]')!.getAttribute('data-tile'));
  await otherStrip.click({button:'right'});await b.getByRole('menuitem',{name:'Make this the big one',exact:true}).click();
  await expect.poll(()=>b.locator('[data-tile]').first().getAttribute('data-tile')).toBe(promoted);
  await b.setViewportSize({width:390,height:900});await expect.poll(()=>b.locator('.next-shell[data-shell=phone]').count()).toBe(1);
  expect(await b.getByRole('button',{name:/^Maximize /}).count()).toBe(0);
  await b.setViewportSize({width:1440,height:900});await expect.poll(()=>b.locator('[data-tile]').count()).toBe(2);
  await maximize.focus();
  await expect.poll(()=>maximize.evaluate(button=>document.activeElement===button&&button.closest('[data-tile]')?.hasAttribute('data-focused')===true)).toBe(true);
  await b.keyboard.press('Alt+Shift+Enter');await expect.poll(()=>b.locator('[data-tile]').first().getAttribute('data-tile')).toBe('tasks');
  await b.keyboard.press('Alt+h');await expect.poll(()=>b.locator('[data-tile]').count()).toBe(0);
  await b.getByRole('button',{name:'Home',exact:true}).click();await expect.poll(()=>b.locator('[data-tile]').count()).toBe(2);
  // Home's two-phase composer uses real shared cookie HTTP operations and
  // returns to current query facts; navigation alone is not a successful send.
  clock.advance(1); // Distinguish the new thread's lastAt from the seeded one.
  await b.goto(app.url);
  const compose=b.getByRole('region',{name:`${displayName} card`,exact:true}),draftWords='Disposable shared desk composer message';
  await compose.getByRole('textbox',{name:`Message ${displayName}`,exact:true}).fill(draftWords);
  const opened=b.waitForResponse(response=>response.request().method()==='POST'&&new URL(response.url()).pathname==='/api/comms/open');
  const sent=b.waitForResponse(response=>response.request().method()==='POST'&&new URL(response.url()).pathname==='/api/comms/send');
  await compose.getByRole('button',{name:'Send',exact:true}).click();
  const openResponse=await opened,sendResponse=await sent;expect(openResponse.status()).toBe(200);expect(sendResponse.status()).toBe(200);
  const openResult=await openResponse.json(),sendResult=await sendResponse.json();expect(openResult.ok).toBe(true);expect(sendResult.ok).toBe(true);expect(sendResult.value.thread).toBe(openResult.value.thread);
  await expect.poll(()=>new URL(b.url()).pathname).toBe('/p/comms-preview/thread/'+encodeURIComponent(openResult.value.thread.replace(/^th:/,'')));
  const confirmed=await app.http.request('/graphql',{method:'POST',headers:{authorization:'Bearer '+raw,'content-type':'application/json'},body:JSON.stringify({query:`{ commsMessages(thread:${JSON.stringify(openResult.value.thread)}) { words } }`})});
  expect((await confirmed.json()).data.commsMessages.map((message:{words:string})=>message.words)).toEqual([draftWords]);
  await b.goto(app.url);await expect.poll(()=>compose.getByRole('textbox',{name:`Message ${displayName}`,exact:true}).inputValue()).toBe('');
  await expect.poll(()=>b.getByRole('navigation',{name:`${displayName} conversations`,exact:true}).locator(`a[href="/p/comms-preview/thread/${encodeURIComponent(openResult.value.thread.replace(/^th:/,''))}"]`).count()).toBe(1);
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
  expect(legacyConnections).toBe(0);expect(faceRequests).toBe(0);expect(maximumConnections).toBe(1);expect(connections.get(a)).toBe(1);expect(connections.get(b)).toBe(1);
  expect((await fetch(app.url+'/manifest.webmanifest')).status).toBe(200);expect((await fetch(app.url+'/sw.js')).headers.get('service-worker-allowed')).toBe('/');
  app.writes.run(()=>db.update(tokens).set({revokedAt:now()}).where(eq(tokens.fingerprint,fingerprint)).run());
  for(const page of [a,b])await expect.poll(()=>page.getByText('OK to run the backup now?',{exact:true}).count()).toBe(0);
  expect(errors).toEqual([]);
 }finally{
  try{await browser?.close();}
  finally{try{await closeApp();}finally{client.close();memory.close();}}
 }
},300000);
