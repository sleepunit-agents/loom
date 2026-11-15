/** One real Tempo browser proof. CI owns Chromium; all rows/credentials are fake. */
import {it,expect,describe,beforeAll,afterAll} from 'vitest';
import Database from 'better-sqlite3';
import {createHash} from 'node:crypto';
import {createServer} from 'node:http';
import type {Socket} from 'node:net';
import {existsSync,readFileSync} from 'node:fs';
import {resolve,join,extname} from 'node:path';
import {getRequestListener} from '@hono/node-server';
import {chromium,type Browser,type BrowserContext} from 'playwright-core';
import {createDataSchema} from '../core/data/database.js';
import {dataAuthentication} from '../core/data/authentication.js';
import {FakeClock} from '../core/clock.js';
import {members,agents,household,tokens,sessions} from '../core/data/schema.js';
import {sharedRoot} from '../shared-root.js';
const root=resolve(import.meta.dirname,'../../dist/web');
const chrome=[process.env.LOOM_TEST_CHROME,'/usr/bin/google-chrome','/usr/bin/chromium',chromium.executablePath()].find(p=>p&&existsSync(p));
const hash=(v:string)=>createHash('sha256').update(v).digest('hex');
describe.runIf(chrome&&existsSync(join(root,'next.html')))('Tempo browser',()=>{
 let browser:Browser;
 beforeAll(async()=>{
  console.info('[Tempo fixture] launch');
  browser=await chromium.launch({executablePath:chrome,args:['--no-sandbox']});
  console.info('[Tempo fixture] ready');
 });
 afterAll(async()=>{await browser?.close();});
 it('Tempo reads household time, follows real commands across windows and withdraws revoked data',async()=>{
 const client=new Database(':memory:'),clock=new FakeClock(Date.now()),now=()=>new Date(clock.now()).toISOString(),db=createDataSchema(client,now);
 db.insert(members).values({id:'owner',role:'owner',joinedAt:now()}).run();
 db.insert(agents).values({id:'art',about:'',markBg:'#fff',markFg:'#000',faceShape:'pebble',faceEyes:'dot'}).run();
 db.insert(household).values({timezone:'America/Chicago'}).run();
 const token='tempo-token-'.repeat(6),cookie='tempo-cookie-'.repeat(6);
 db.insert(tokens).values({fingerprint:hash(token),label:'Owner',kind:'owner',member:'owner',createdAt:now()}).run();
 db.insert(sessions).values({id:hash(cookie),token:hash(token),device:'Browser',via:'token',isAgent:false,issuedAt:now(),seenAt:now(),provedAt:now()}).run();
 const app=sharedRoot({db,clock,originAllowed:()=>true,commsKey:{seal:async words=>Buffer.from(words),open:async blob=>Buffer.from(blob).toString(),hash},reportError(error){throw error;}});
 const bodyToken='tempo-browser-body-'.repeat(4);
 db.insert(boxes).values({id:'browser-box',name:'Fixture box',owner:'owner',sameMachineAsLoom:false,hostsAny:false,reportOnly:false,alwaysOn:false,enrolledAt:now()}).run();
 const thread=app.services.comms!.threads.open({id:'th:tempo-settings',agent:'art',member:'owner',title:'Tempo settings'});
 const chat=app.services.conversations.conversation(thread.conversation);
 db.insert(jobs).values({id:'browser-body',box:'browser-box',agent:'art',conversation:chat.id,member:'owner',title:'Settings body',state:'running',brief:'',model:'fixture',startedByKind:'agent',startedBy:'art',houseRepository:'repo',houseFile:'Housefile',houseBranch:'next',queuedAt:now()}).run();
 db.update(conversations).set({job:'browser-body'}).where(eq(conversations.id,chat.id)).run();
 db.insert(tokens).values({fingerprint:hash(bodyToken),label:'Fixture body',kind:'agent',agent:'art',job:'browser-body',createdAt:now()}).run();
 const trigger=app.services.tempo.triggers.set({id:'delivery',ownerKind:'household',sourceKind:'time',times:new Date(clock.now()+3600000).toISOString(),lifespan:'once',targetKind:'inbox',toKind:'agent',to:'art',instructions:'Check the pump shipment',note:'Check pump delivery'});
 const authenticate=dataAuthentication(db,()=>clock.now());
 const server=createServer(getRequestListener(request=>{
  const path=new URL(request.url).pathname;
  if(path==='/graphql'||path.startsWith('/api/'))return app.http.fetch(request);
  if(path==='/auth/session')return Response.json({viewer:authenticate(request)?.viewer??null,csrf:''});
  const file=path.startsWith('/app/')?resolve(root,path.slice(5)):join(root,'next.html');
  if(!file.startsWith(root+'/')||!existsSync(file))return new Response(null,{status:404});
  return new Response(new Uint8Array(readFileSync(file)),{headers:{'content-type':({'.html':'text/html','.js':'application/javascript','.css':'text/css','.woff2':'font/woff2'} as Record<string,string>)[extname(file)]??'application/octet-stream'}});
 }));
 const sockets=new Set<Socket>();server.on('connection',socket=>{sockets.add(socket);socket.once('close',()=>sockets.delete(socket));});
 const mark=(phase:string)=>console.info('[Tempo browser]',phase);
 const detach=app.attach(server);server.on('upgrade',(request,socket)=>{if(new URL(request.url??'/','http://loom').pathname!=='/graphql')socket.end('HTTP/1.1 404 Not Found\r\nConnection: close\r\nContent-Length: 0\r\n\r\n');});let context:BrowserContext|undefined;
 try {
  await new Promise<void>(ok=>server.listen(0,'127.0.0.1',ok));const address=server.address();if(!address||typeof address==='string')throw Error('No address');
  const url=`http://127.0.0.1:${address.port}`;
  // This is a command/data proof; motion has separate coverage. Keep animation
  // waits out of the budget and let independent windows hydrate together.
  context=await browser.newContext({serviceWorkers:'block',timezoneId:'Asia/Tokyo',locale:'en-US',reducedMotion:'reduce'});context.setDefaultTimeout(10000);
  await context.addCookies([{name:'loom_ui',value:cookie,url}]);
  const [a,b]=await Promise.all([context.newPage(),context.newPage()]);
  for(const page of [a,b]){
   // Numeric, bounded diagnostics for a hosted click that failed stability.
   // Never retain DOM words, query variables, credentials or navigation URLs.
   await page.addInitScript(()=>{
    const trace={active:true,samples:[] as unknown[],last:undefined as unknown};
    (window as typeof window&{__tempoGeometry:typeof trace}).__tempoGeometry=trace;
    const start=performance.now();let previous='',generation=0,lastButton:Element|undefined;
    const rect=(element:Element|null)=>{const r=element?.getBoundingClientRect();return r?[r.x,r.y,r.width,r.height].map(n=>Math.round(n*100)/100):null;};
    const sample=()=>{
     if(!trace.active)return;
     const button=[...document.querySelectorAll('button[data-split-row]')].find(el=>el.textContent?.includes('Check pump delivery'));
     if(button!==lastButton){generation++;lastButton=button;}
     const box=button?.getBoundingClientRect(),style=button?getComputedStyle(button):undefined;
     const hit=box?document.elementFromPoint(box.x+box.width/2,box.y+box.height/2):null;
     const value={generation,button:rect(button??null),tile:rect(button?.closest('[data-tile]')??null),connected:button?.isConnected??false,
      display:style?.display,visibility:style?.visibility,opacity:style?.opacity,hit:!!button&&!!hit&&button.contains(hit),
      fonts:document.fonts.status,motion:document.documentElement.dataset.motion,hidden:document.hidden};
     const signature=JSON.stringify(value);
     if(signature!==previous){const entry={at:Math.round(performance.now()-start),...value};if(trace.samples.length<24)trace.samples.push(entry);trace.last=entry;previous=signature;}
     requestAnimationFrame(sample);
    };requestAnimationFrame(sample);
   });
   page.on('pageerror',error=>console.error('[Tempo page error]',error.message));
   page.on('console',message=>{if(message.type()==='error')console.error('[Tempo console]',message.text());});
   page.on('websocket',socket=>{
    const names=new Map<string,string>();
    socket.on('framesent',frame=>{try{const value=JSON.parse(String(frame.payload)),query=value.payload?.variables?.query;if(value.type==='subscribe'&&typeof query==='string'&&names.size<64)names.set(value.id,query.match(/^\s*(?:query|subscription)\s+([A-Za-z_]\w*)/)?.[1]??'unnamed');}catch{}});
    socket.on('framereceived',frame=>{try{const value=JSON.parse(String(frame.payload));if(value.type==='error'||value.payload?.errors)console.error('[Tempo GraphQL error]',JSON.stringify({operation:names.get(value.id),...value}));}catch{}});
   });
  }
  mark('navigate');await Promise.all([a,b].map(page=>page.goto(url+'/p/tempo')));mark('navigated');
  await Promise.all([a,b].map(async page=>{
   mark('open trigger');try{await page.getByRole('button',{name:/Check pump delivery/}).click();}catch(error){console.error('[Tempo geometry]',JSON.stringify(await page.evaluate(()=>(window as typeof window&{__tempoGeometry:unknown}).__tempoGeometry)));console.error('[Tempo visible body]',await page.locator('body').innerText());throw error;}finally{await page.evaluate(()=>{(window as typeof window&{__tempoGeometry:{active:boolean}}).__tempoGeometry.active=false;});}
   await expect.poll(()=>page.getByRole('heading',{name:'Check pump delivery',exact:true}).count()).toBe(1);
   expect(await page.getByText(/America\/Chicago/).count()).toBeGreaterThan(0);
   const due=new Intl.DateTimeFormat('en-US',{timeZone:'America/Chicago',dateStyle:'medium',timeStyle:'short'}).format(new Date(trigger.nextDueAt!));
   expect((await page.getByText(/^Due:/).textContent())?.replace(/\s+/g,' ')).toBe(`Due: ${due} · America/Chicago`.replace(/\s+/g,' '));
   expect(await page.getByText('Check the pump shipment',{exact:true}).count()).toBe(1);
  }));
  mark('settled notice');app.writes.run(()=>{
   for(const words of ['PRIVATE FIRST NOTICE','PRIVATE SECOND NOTICE'])app.services.conversations.send({toKind:'person',to:'owner',member:'owner',source:'notice',fromKind:'agent',words});
  });
  clock.advance(4999);
  for(const page of [a,b])expect(await page.getByRole('status',{name:'Inbox notification'}).count()).toBe(0);
  clock.advance(1);
  for(const page of [a,b]){
   await expect.poll(()=>page.getByRole('status',{name:'Inbox notification'}).count()).toBe(1);
   expect(await page.getByRole('status',{name:'Inbox notification'}).textContent()).toContain('2 items are waiting in your Inbox');
   expect(await page.getByRole('status',{name:'Inbox notification'}).textContent()).not.toContain('PRIVATE');
  }
  await a.getByRole('button',{name:'Dismiss Inbox notification',exact:true}).click();
  expect(await a.getByRole('status',{name:'Inbox notification'}).count()).toBe(0);
  expect(await b.getByRole('status',{name:'Inbox notification'}).count()).toBe(1);
  // Inbox volume, chat settings and Tempo controls are independent journeys.
  // Keep each command sequence ordered and finish both before revocation.
  let settingsPage: Awaited<ReturnType<typeof context.newPage>> | undefined;
  await Promise.all([
   (async()=>{
  mark('pause');await a.getByRole('button',{name:'Pause agent',exact:true}).click();
  await Promise.all([a,b].map(page=>expect.poll(()=>page.getByText(/Held · agent paused/).count()).toBeGreaterThan(0)));
  await b.getByRole('button',{name:'Resume agent',exact:true}).click();
  await Promise.all([a,b].map(page=>expect.poll(()=>page.getByRole('button',{name:'Pause agent',exact:true}).count()).toBe(1)));
  await a.getByRole('button',{name:'Cancel',exact:true}).click();
  await Promise.all([a,b].map(page=>expect.poll(()=>page.getByText(/once · stopped/).count()).toBe(1)));
  mark('create');await a.getByRole('button',{name:'Create trigger',exact:true}).click();
  const form=a.getByRole('form',{name:'Create trigger'});
  await form.getByLabel('Label',{exact:true}).fill('Browser-created trigger');
  await form.getByLabel('Time (America/Chicago)',{exact:true}).fill(new Date(clock.now()+7200000).toISOString());
  await form.getByLabel('Set by',{exact:true}).selectOption('household');
  await form.getByLabel('Recipient',{exact:true}).fill('art');
  await form.getByLabel('Words',{exact:true}).fill('Created through Tempo');
  await form.getByRole('button',{name:'Create trigger',exact:true}).click();
  await expect.poll(()=>a.getByRole('form',{name:'Create trigger'}).count()).toBe(0);
  await Promise.all([a,b].map(async page=>{
   await page.getByRole('button',{name:/Browser-created trigger/}).click();
   await expect.poll(()=>page.getByText('Created through Tempo',{exact:true}).count()).toBe(1);
  }));
  mark('run now');await a.getByRole('button',{name:'Run now',exact:true}).click();
  await Promise.all([a,b].map(page=>expect.poll(()=>page.getByText(/once · fired/).count()).toBe(1)));
  expect(client.prepare("SELECT words FROM inbox WHERE source='trigger' AND words='Created through Tempo'").all()).toHaveLength(1);
   })(),
   (async()=>{
  mark('recipient volume');
  const notice=client.prepare("SELECT id FROM inbox WHERE words='PRIVATE FIRST NOTICE'").get() as {id:string};
  const volumePage=await context!.newPage();
  await volumePage.goto(url+'/p/inbox-preview/ask/'+encodeURIComponent(notice.id));
  await volumePage.getByRole('button',{name:'Dim',exact:true}).click();
  await expect.poll(()=>client.prepare('SELECT volume FROM inbox WHERE id=?').get(notice.id)).toEqual({volume:'dim'});
  await expect.poll(()=>volumePage.getByRole('button',{name:'Dim',exact:true}).isDisabled()).toBe(true);
  await volumePage.getByRole('button',{name:'Mute',exact:true}).click();
  await expect.poll(()=>client.prepare('SELECT volume FROM inbox WHERE id=?').get(notice.id)).toEqual({volume:'mute'});
  await expect.poll(()=>volumePage.getByRole('button',{name:'Mute',exact:true}).isDisabled()).toBe(true);
  expect(client.prepare('SELECT quiet_until AS until FROM inbox WHERE id=?').get(notice.id)).toEqual({until:new Date(clock.now()+7*86400000).toISOString()});
  expect(await volumePage.getByText(/returns to full/).count()).toBe(1);
  await volumePage.getByRole('button',{name:'Full',exact:true}).click();
  await expect.poll(()=>client.prepare('SELECT volume,quiet_until AS quietUntil FROM inbox WHERE id=?').get(notice.id)).toEqual({volume:'full',quietUntil:null});
  await volumePage.close();
   })(),
   (async()=>{
  mark('settings in chat');const page=await context!.newPage();settingsPage=page;
  await page.goto(url+'/p/comms-preview/thread/tempo-settings');
  for(const [allow,seconds] of [[true,60],[false,120]] as const){
   const proposal=await context!.request.post(url+'/api/tempo/proposeSettings',{headers:{authorization:'Bearer '+bodyToken},data:{id:'timing-'+seconds,input:{who:{kind:'person',id:'owner'},patch:{settleSeconds:seconds}}}});expect(proposal.status()).toBe(200);
   const card=page.getByRole('article',{name:'Inbox item',exact:true}).filter({has:page.getByText(seconds+' seconds',{exact:true})});
   await expect.poll(()=>card.count()).toBe(1);
   expect(await card.getByRole('heading',{name:'Before',exact:true}).count()).toBe(1);expect(await card.getByRole('heading',{name:'After',exact:true}).count()).toBe(1);
   await card.getByRole('button',{name:allow?'Allow':'Deny',exact:true}).click();
   await expect.poll(()=>card.getByRole('button',{name:'Allow',exact:true}).count()).toBe(0);
   expect(app.services.tempo.volume.timings({kind:'person',id:'owner'}).settleSeconds).toBe(60);
  }
   })(),
  ]);
  mark('revoke');app.writes.run(()=>db.update(tokens).set({revokedAt:now()}).run());
  await expect.poll(()=>settingsPage!.getByRole('region',{name:'Tempo settings change',exact:true}).count()).toBe(0);
  for(const page of [a,b]){
   await expect.poll(()=>page.getByRole('heading',{name:'Browser-created trigger',exact:true}).count()).toBe(0);
   await expect.poll(()=>page.getByRole('status',{name:'Inbox notification'}).count()).toBe(0);
  }
 } finally {
  mark('cleanup context');await context?.close();detach();mark('cleanup root');await app.close();for(const socket of sockets)socket.destroy();server.closeAllConnections();mark('cleanup server');await new Promise<void>(ok=>server.close(()=>ok()));client.close();mark('closed');
 }
});
});
