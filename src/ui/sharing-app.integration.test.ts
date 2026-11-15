/** One Sharing browser proof on the shared listener; CI owns Chromium. */
import {it,expect} from 'vitest';
import Database from 'better-sqlite3';
import {createHash} from 'node:crypto';
import {existsSync,mkdirSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {chromium} from 'playwright-core';
import {FakeClock} from '../core/clock.js';
import {createDataSchema} from '../core/data/database.js';
import {members,tokens,sessions,agents,projectMembers,projectAgents} from '../core/data/schema.js';
import {serveShared} from '../shared-serve.js';
import {deskMemoryFixture} from './desk-memory.fixture.js';
const enabled=process.env.LOOM_DESK_EVIDENCE==='1',chrome=process.env.LOOM_TEST_CHROME,webRoot=resolve('dist/web');
if(enabled&&(!chrome||!existsSync(chrome)||!existsSync(join(webRoot,'next.html'))))throw Error('Sharing evidence needs Chrome and the built app');
it.runIf(enabled)('Sharing creates projects and changes member and agent lists live across two shared windows',async()=>{
 const client=new Database(':memory:'),clock=new FakeClock(),now=()=>new Date(clock.now()).toISOString(),db=createDataSchema(client,now),hash=(value:string)=>createHash('sha256').update(value).digest('hex'),cookie='c'.repeat(64);
 db.insert(members).values([{id:'owner',role:'owner',joinedAt:now()},{id:'sam',role:'member',joinedAt:now()}]).run();db.insert(agents).values({id:'art',about:'',markBg:'#000',markFg:'#fff',faceShape:'pebble',faceEyes:'dot'}).run();
 db.insert(tokens).values({fingerprint:hash('a'.repeat(64)),kind:'owner',member:'owner',label:'Owner',createdAt:now()}).run();db.insert(sessions).values({id:hash(cookie),token:hash('a'.repeat(64)),device:'Browser',via:'link',isAgent:false,issuedAt:now(),seenAt:now(),provedAt:now()}).run();
 const memory=deskMemoryFixture(['art']);const app=await serveShared({db,clock,webRoot,memory:{sources:memory.sources,checkingAgent:'art'},originAllowed:()=>true,reportError:error=>{throw error;}}),browser=await chromium.launch({executablePath:chrome,args:['--no-sandbox']});
 try{
  const context=await browser.newContext({serviceWorkers:'block',viewport:{width:1280,height:900}});await context.addCookies([{name:'loom_ui',value:cookie,url:app.url}]);const a=await context.newPage(),b=await context.newPage(),errors:string[]=[];let legacy=0;
  for(const page of [a,b]){page.on('pageerror',error=>errors.push(error.message));page.on('websocket',socket=>{if(new URL(socket.url()).pathname==='/live')legacy++;});await page.goto(app.url+'/p/sharing-preview');}
  await a.getByRole('textbox',{name:'Slug',exact:true}).fill('garden');await a.getByRole('textbox',{name:'Name',exact:true}).fill('Garden');await a.getByRole('checkbox',{name:'sam',exact:true}).check();await a.getByRole('checkbox',{name:'art',exact:true}).check();await a.getByRole('button',{name:'Create project',exact:true}).click();
  const row=(page:typeof a)=>page.locator('[data-split-row]').filter({hasText:'Garden'});
  await expect.poll(()=>row(b).count()).toBe(1);await row(a).click();await row(b).click();
  expect(db.select().from(projectMembers).all()).toEqual([{project:'garden',member:'sam'}]);expect(db.select().from(projectAgents).all()).toEqual([{project:'garden',agent:'art'}]);
  await a.getByRole('checkbox',{name:'sam',exact:true}).uncheck();await a.getByRole('button',{name:'Save project',exact:true}).click();await expect.poll(()=>b.getByRole('checkbox',{name:'sam',exact:true}).isChecked()).toBe(false);
  await b.getByRole('checkbox',{name:'art',exact:true}).uncheck();await b.getByRole('button',{name:'Save project',exact:true}).click();await expect.poll(()=>a.getByRole('checkbox',{name:'art',exact:true}).isChecked()).toBe(false);
  const shots=resolve('artifacts/household-sharing');mkdirSync(shots,{recursive:true});await a.screenshot({path:join(shots,'sharing-shared.png'),animations:'disabled'});expect(errors).toEqual([]);expect(legacy).toBe(0);
 }finally{await browser.close();await app.close();memory.close();client.close();}
});
