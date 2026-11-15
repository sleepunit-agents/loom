/** One Household setup browser proof through the running shared program. */
import {it,expect} from 'vitest';
import Database from 'better-sqlite3';
import {createHash} from 'node:crypto';
import {existsSync,mkdirSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {chromium} from 'playwright-core';
import {FakeClock} from '../core/clock.js';
import {createDataSchema} from '../core/data/database.js';
import {members,agents,tokens,sessions,agentAccounts} from '../core/data/schema.js';
import {serveShared} from '../shared-serve.js';
import {deskMemoryFixture} from './desk-memory.fixture.js';
const enabled=process.env.LOOM_DESK_EVIDENCE==='1',chrome=process.env.LOOM_TEST_CHROME,webRoot=resolve('dist/web');
if(enabled&&(!chrome||!existsSync(chrome)||!existsSync(join(webRoot,'next.html'))))throw Error('Setup evidence needs Chrome and the built app');
it.runIf(enabled)('Household owners edit canonical members and accounts, mint a one-time token and end another browser across shared windows',async()=>{
 const client=new Database(':memory:'),clock=new FakeClock(),now=()=>new Date(clock.now()).toISOString(),db=createDataSchema(client,now),hash=(value:string)=>createHash('sha256').update(value).digest('hex'),cookie='c'.repeat(64);
 db.insert(members).values([{id:'owner',role:'owner',joinedAt:now()},{id:'sam',role:'member',joinedAt:now()}]).run();db.insert(agents).values({id:'art',about:'Fixture agent',markBg:'#000000',markFg:'#ffffff',faceShape:'pebble',faceEyes:'dot'}).run();
 for(const [member,raw]of [['owner','a'.repeat(64)],['sam','b'.repeat(64)]])db.insert(tokens).values({fingerprint:hash(raw),kind:'owner',member,label:member,createdAt:now()}).run();
 db.insert(sessions).values([{id:hash(cookie),token:hash('a'.repeat(64)),device:'Current owner browser',via:'link',isAgent:false,issuedAt:now(),seenAt:now(),provedAt:now()},{id:hash('d'.repeat(64)),token:hash('b'.repeat(64)),device:'Kitchen tablet',via:'link',isAgent:false,issuedAt:now(),seenAt:now(),provedAt:now()}]).run();
 const memory=deskMemoryFixture(['art']),app=await serveShared({db,clock,webRoot,memory:{sources:memory.sources,checkingAgent:'art'},originAllowed:()=>true,reportError:error=>{throw error;}}),browser=await chromium.launch({executablePath:chrome,args:['--no-sandbox']});
 try{
  const context=await browser.newContext({serviceWorkers:'block',viewport:{width:1280,height:900}});await context.addCookies([{name:'loom_ui',value:cookie,url:app.url}]);const a=await context.newPage(),b=await context.newPage(),errors:string[]=[];let legacy=0;
  for(const page of [a,b]){page.on('pageerror',error=>errors.push(error.message));page.on('websocket',socket=>{if(new URL(socket.url()).pathname==='/live')legacy++;});await page.goto(app.url+'/p/setup-preview');}
  const add=a.getByRole('form',{name:'Add member',exact:true});await add.getByRole('textbox',{name:'Member name',exact:true}).fill('pat');await add.getByRole('checkbox',{name:'art',exact:true}).check();await add.getByRole('button',{name:'Add member',exact:true}).click();
  await expect.poll(()=>b.getByRole('form',{name:'Save member pat',exact:true}).count()).toBe(1);
  const ownership=a.getByRole('form',{name:'Save member pat',exact:true});await ownership.getByRole('combobox',{name:'Role',exact:true}).selectOption('owner');await ownership.getByRole('checkbox',{name:'Own every agent',exact:false}).check();await ownership.getByRole('button',{name:'Save member',exact:true}).click();
  await expect.poll(()=>b.getByRole('form',{name:'Save member pat',exact:true}).getByRole('checkbox',{name:'Own every agent',exact:false}).isChecked()).toBe(true);expect(db.select().from(members).all().find(member=>member.id==='pat')).toMatchObject({role:'owner',fullOwner:true});
  const appearance=a.getByRole('form',{name:'Save appearance for art',exact:true});await appearance.getByRole('textbox',{name:'Description',exact:true}).fill('Updated fixture description');await appearance.getByRole('combobox',{name:'Face shape',exact:true}).selectOption('drop');await appearance.getByRole('combobox',{name:'Eyes',exact:true}).selectOption('oval');await appearance.getByRole('button',{name:'Save appearance',exact:true}).click();
  await expect.poll(()=>b.getByRole('form',{name:'Save appearance for art',exact:true}).getByRole('textbox',{name:'Description',exact:true}).inputValue()).toBe('Updated fixture description');expect(db.select().from(agents).get()).toMatchObject({about:'Updated fixture description',markBg:'#000000',markFg:'#ffffff',faceShape:'drop',faceEyes:'oval'});
  const accounts=a.getByRole('form',{name:'Save accounts for art',exact:true});await accounts.getByRole('textbox',{name:'GitHub accounts',exact:true}).fill('ART-BOT');await accounts.getByRole('button',{name:'Save accounts',exact:true}).click();
  await expect.poll(()=>b.getByRole('form',{name:'Save accounts for art',exact:true}).getByRole('textbox').inputValue()).toBe('art-bot');expect(db.select().from(agentAccounts).all()).toEqual([{agent:'art',service:'github',login:'art-bot'}]);
  const mint=a.getByRole('form',{name:'Create token',exact:true});await mint.getByRole('textbox',{name:'Token label',exact:true}).fill('Fictional owner token');await mint.getByRole('button',{name:'Create token',exact:true}).click();
  await expect.poll(()=>a.getByLabel('Token value',{exact:true}).count()).toBe(1);const raw=await a.getByLabel('Token value',{exact:true}).textContent();expect(app.credentials.authenticate(new Request(app.url,{headers:{authorization:'Bearer '+raw}}))?.viewer).toEqual({kind:'member',id:'owner'});
  await a.getByRole('button',{name:'Hide token',exact:true}).click();expect(await a.getByLabel('Token value',{exact:true}).count()).toBe(0);await expect.poll(()=>b.getByRole('heading',{name:'Fictional owner token',exact:true}).count()).toBe(1);
  await a.getByRole('heading',{name:'Kitchen tablet',exact:true}).locator('..').getByRole('button',{name:'Sign out browser',exact:true}).click();await expect.poll(()=>b.getByRole('heading',{name:'Kitchen tablet',exact:true}).count()).toBe(0);
  const shots=resolve('artifacts/household-setup');mkdirSync(shots,{recursive:true});await a.screenshot({path:join(shots,'setup-shared.png'),animations:'disabled'});expect(errors).toEqual([]);expect(legacy).toBe(0);
 }finally{await browser.close();await app.close();memory.close();client.close();}
});
