/** One Account browser proof through the actual shared program; CI owns Chrome. */
import {it,expect} from 'vitest';
import Database from 'better-sqlite3';
import {createHash} from 'node:crypto';
import {existsSync,mkdirSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {chromium} from 'playwright-core';
import {FakeClock} from '../core/clock.js';
import {createDataSchema} from '../core/data/database.js';
import {members,tokens,sessions,passkeys} from '../core/data/schema.js';
import {serveShared} from '../shared-serve.js';
const enabled=process.env.LOOM_DESK_EVIDENCE==='1',chrome=process.env.LOOM_TEST_CHROME,webRoot=resolve('dist/web');
if(enabled&&(!chrome||!existsSync(chrome)||!existsSync(join(webRoot,'next.html'))))throw Error('Account evidence needs Chrome and the built app');
it.runIf(enabled)('Account shows personal shared metadata, removes passkeys live and signs another browser out over the one door',async()=>{
 const client=new Database(':memory:'),clock=new FakeClock(),now=()=>new Date(clock.now()).toISOString(),db=createDataSchema(client,now),hash=(value:string)=>createHash('sha256').update(value).digest('hex'),cookie='c'.repeat(64);
 db.insert(members).values({id:'sam',role:'member',joinedAt:now()}).run();
 db.insert(tokens).values({fingerprint:hash('a'.repeat(64)),kind:'owner',member:'sam',label:'Sam',createdAt:now()}).run();
 db.insert(sessions).values([{id:hash(cookie),token:hash('a'.repeat(64)),device:'Current browser',via:'link',isAgent:false,issuedAt:now(),seenAt:now(),provedAt:now()},{id:hash('d'.repeat(64)),token:hash('a'.repeat(64)),device:'Kitchen tablet',via:'link',isAgent:false,issuedAt:now(),seenAt:now(),provedAt:now()}]).run();
 db.insert(passkeys).values({id:'fixture-key',token:hash('a'.repeat(64)),label:'Fixture laptop',publicKey:'unused-public-half',counter:0,createdAt:now()}).run();
 const app=await serveShared({db,clock,webRoot,originAllowed:()=>true,reportError:error=>{throw error;}}),browser=await chromium.launch({executablePath:chrome,args:['--no-sandbox']});
 try{
  const context=await browser.newContext({serviceWorkers:'block',viewport:{width:1280,height:900}});await context.addCookies([{name:'loom_ui',value:cookie,url:app.url}]);
  const a=await context.newPage(),b=await context.newPage(),errors:string[]=[];let legacy=0;
  for(const page of [a,b]){page.on('pageerror',error=>errors.push(error.message));page.on('websocket',socket=>{if(new URL(socket.url()).pathname==='/live')legacy++;});}
  await a.goto(app.url+'/p/account-preview');await b.goto(app.url+'/p/account-preview');
  for(const page of [a,b])await expect.poll(()=>page.getByRole('heading',{name:'Fixture laptop',exact:true}).count()).toBe(1);
  await a.getByRole('button',{name:'Remove passkey',exact:true}).click();
  await expect.poll(()=>b.getByRole('heading',{name:'Fixture laptop',exact:true}).count()).toBe(0);expect(db.select().from(passkeys).all()).toEqual([]);
  const tablet=a.locator('div.rounded-xl').filter({has:a.getByRole('heading',{name:'Kitchen tablet',exact:true})});
  await tablet.getByRole('button',{name:'Sign out browser',exact:true}).click();
  await expect.poll(()=>b.getByRole('heading',{name:'Kitchen tablet',exact:true}).count()).toBe(0);expect(db.select().from(sessions).all()).toHaveLength(1);
  await a.getByRole('button',{name:'Make sign-in link',exact:true}).click();await expect.poll(()=>a.getByRole('status').last().textContent()).toContain('/login/');
  const shots=resolve('artifacts/household-account');mkdirSync(shots,{recursive:true});
  await a.screenshot({path:join(shots,'account-shared.png'),animations:'disabled'});
  expect(legacy).toBe(0);expect(errors).toEqual([]);
 }finally{await browser.close();await app.close();client.close();}
});
