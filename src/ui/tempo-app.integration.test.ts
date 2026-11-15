/** One real Tempo browser proof. CI owns Chromium; all rows/credentials are fake. */
import {it,expect} from 'vitest';
import Database from 'better-sqlite3';
import {createHash} from 'node:crypto';
import {createServer} from 'node:http';
import {existsSync,readFileSync} from 'node:fs';
import {resolve,join,extname} from 'node:path';
import {getRequestListener} from '@hono/node-server';
import {chromium} from 'playwright-core';
import {createDataSchema} from '../core/data/database.js';
import {dataAuthentication} from '../core/data/authentication.js';
import {FakeClock} from '../core/clock.js';
import {members,agents,household,tokens,sessions} from '../core/data/schema.js';
import {sharedRoot} from '../shared-root.js';
const root=resolve(import.meta.dirname,'../../dist/web');
const chrome=[process.env.LOOM_TEST_CHROME,'/usr/bin/google-chrome','/usr/bin/chromium',chromium.executablePath()].find(p=>p&&existsSync(p));
const hash=(v:string)=>createHash('sha256').update(v).digest('hex');
it.runIf(chrome&&existsSync(join(root,'next.html')))('Tempo reads household time, follows real commands across windows and withdraws revoked data',async()=>{
 const client=new Database(':memory:'),clock=new FakeClock(Date.now()),now=()=>new Date(clock.now()).toISOString(),db=createDataSchema(client,now);
 db.insert(members).values({id:'owner',role:'owner',joinedAt:now()}).run();
 db.insert(agents).values({id:'art',about:'',markBg:'#fff',markFg:'#000',faceShape:'pebble',faceEyes:'dot'}).run();
 db.insert(household).values({timezone:'America/Chicago'}).run();
 const token='tempo-token-'.repeat(6),cookie='tempo-cookie-'.repeat(6);
 db.insert(tokens).values({fingerprint:hash(token),label:'Owner',kind:'owner',member:'owner',createdAt:now()}).run();
 db.insert(sessions).values({id:hash(cookie),token:hash(token),device:'Browser',via:'token',isAgent:false,issuedAt:now(),seenAt:now(),provedAt:now()}).run();
 const app=sharedRoot({db,clock,originAllowed:()=>true,reportError(error){throw error;}});
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
 const detach=app.attach(server);let browser:Awaited<ReturnType<typeof chromium.launch>>|undefined;
 try {
  await new Promise<void>(ok=>server.listen(0,'127.0.0.1',ok));const address=server.address();if(!address||typeof address==='string')throw Error('No address');
  const url=`http://127.0.0.1:${address.port}`;
  browser=await chromium.launch({executablePath:chrome,args:['--no-sandbox']});
  const context=await browser.newContext({serviceWorkers:'block',timezoneId:'Asia/Tokyo',locale:'en-US'});context.setDefaultTimeout(10000);
  await context.addCookies([{name:'loom_ui',value:cookie,url}]);
  const a=await context.newPage(),b=await context.newPage();
  await Promise.all([a,b].map(page=>page.goto(url+'/p/tempo')));
  for(const page of [a,b]){
   await page.getByRole('button',{name:/Check pump delivery/}).click();
   await expect.poll(()=>page.getByRole('heading',{name:'Check pump delivery',exact:true}).count()).toBe(1);
   expect(await page.getByText(/America\/Chicago/).count()).toBeGreaterThan(0);
   const due=new Intl.DateTimeFormat('en-US',{timeZone:'America/Chicago',dateStyle:'medium',timeStyle:'short'}).format(new Date(trigger.nextDueAt!));
   expect((await page.getByText(/^Due:/).textContent())?.replace(/\s+/g,' ')).toBe(`Due: ${due} · America/Chicago`.replace(/\s+/g,' '));
   expect(await page.getByText('Check the pump shipment',{exact:true}).count()).toBe(1);
  }
  app.writes.run(()=>{
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
  await a.getByRole('button',{name:'Pause agent',exact:true}).click();
  for(const page of [a,b])await expect.poll(()=>page.getByText(/Held · agent paused/).count()).toBeGreaterThan(0);
  await b.getByRole('button',{name:'Resume agent',exact:true}).click();
  for(const page of [a,b])await expect.poll(()=>page.getByRole('button',{name:'Pause agent',exact:true}).count()).toBe(1);
  await a.getByRole('button',{name:'Cancel',exact:true}).click();
  for(const page of [a,b])await expect.poll(()=>page.getByText(/once · stopped/).count()).toBe(1);
  await a.getByRole('button',{name:'Create trigger',exact:true}).click();
  const form=a.getByRole('form',{name:'Create trigger'});
  await form.getByLabel('Label',{exact:true}).fill('Browser-created trigger');
  await form.getByLabel('Time (America/Chicago)',{exact:true}).fill(new Date(clock.now()+7200000).toISOString());
  await form.getByLabel('Set by',{exact:true}).selectOption('household');
  await form.getByLabel('Recipient',{exact:true}).fill('art');
  await form.getByLabel('Words',{exact:true}).fill('Created through Tempo');
  await form.getByRole('button',{name:'Create trigger',exact:true}).click();
  await expect.poll(()=>a.getByRole('form',{name:'Create trigger'}).count()).toBe(0);
  for(const page of [a,b]){
   await page.getByRole('button',{name:/Browser-created trigger/}).click();
   await expect.poll(()=>page.getByText('Created through Tempo',{exact:true}).count()).toBe(1);
  }
  await a.getByRole('button',{name:'Run now',exact:true}).click();
  for(const page of [a,b])await expect.poll(()=>page.getByText(/once · fired/).count()).toBe(1);
  expect(client.prepare("SELECT words FROM inbox WHERE source='trigger' AND words='Created through Tempo'").all()).toHaveLength(1);
  app.writes.run(()=>db.update(tokens).set({revokedAt:now()}).run());
  for(const page of [a,b]){
   await expect.poll(()=>page.getByRole('heading',{name:'Browser-created trigger',exact:true}).count()).toBe(0);
   await expect.poll(()=>page.getByRole('status',{name:'Inbox notification'}).count()).toBe(0);
  }
 } finally {
  await browser?.close();detach();await app.close();server.closeAllConnections();await new Promise<void>(ok=>server.close(()=>ok()));client.close();
 }
});
