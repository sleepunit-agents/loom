/** Setup's one browser proof: actual shared listener, two windows, native sessions. */
import {it,expect} from 'vitest';
import {existsSync,mkdirSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {createHash} from 'node:crypto';
import Database from 'better-sqlite3';
import {chromium} from 'playwright-core';
import {FakeClock} from '../core/clock.js';
import {createDataSchema} from '../core/data/database.js';
import {members,agents,tokens,sessions,memberAgents} from '../core/data/schema.js';
import {serveShared} from '../shared-serve.js';
const root=resolve('dist/web'),chrome=process.env.LOOM_TEST_CHROME;
it.runIf(chrome&&existsSync(join(root,'next.html')))('Setup changes are live across windows and fit three widths',async()=>{
 const client=new Database(':memory:'),clock=new FakeClock(),now=()=>new Date(clock.now()).toISOString(),db=createDataSchema(client,now);
 const hash=(value:string)=>createHash('sha256').update(value).digest('hex'),cookie='s'.repeat(64),token=hash('t'.repeat(64));
 db.insert(members).values([{id:'jonathan',role:'owner',joinedAt:now()},{id:'pollock',role:'member',joinedAt:now()}]).run();
 db.insert(agents).values(['art','mark'].map(id=>({id,about:'Fixture agent',markBg:'#000000',markFg:'#ffffff',faceShape:'pebble' as const,faceEyes:'dot' as const}))).run();
 db.insert(tokens).values({fingerprint:token,label:'Fixture',kind:'owner',member:'jonathan',createdAt:now()}).run();
 db.insert(sessions).values({id:hash(cookie),token,device:'Fixture',via:'token',isAgent:false,issuedAt:now(),seenAt:now(),provedAt:now()}).run();
 const app=await serveShared({db,clock,webRoot:root,originAllowed:req=>!req.headers.origin||req.headers.origin===`http://${req.headers.host}`,reportError:error=>{throw error;}});
 const browser=await chromium.launch({executablePath:chrome,args:['--no-sandbox']});
 try{
  const context=await browser.newContext({serviceWorkers:'block',viewport:{width:1280,height:1000}});await context.addCookies([{name:'loom_ui',value:cookie,url:app.url}]);
  const a=await context.newPage(),b=await context.newPage();await Promise.all([a.goto(app.url+'/p/setup-preview'),b.goto(app.url+'/p/setup-preview')]);
  const form=(page:typeof a,id:string)=>page.getByRole('form',{name:`Save membership for ${id}`,exact:true});
  await expect.poll(()=>form(a,'pollock').count()).toBe(1);
  await form(a,'pollock').getByRole('checkbox',{name:'mark',exact:true}).check();
  await form(a,'pollock').getByRole('checkbox',{name:'I confirm this membership change',exact:true}).check();await form(a,'pollock').getByRole('button').click();
  await expect.poll(()=>form(b,'pollock').getByRole('checkbox',{name:'mark',exact:true}).isChecked()).toBe(true);
  expect(db.select().from(memberAgents).all()).toEqual([{member:'pollock',agent:'mark'}]);
  expect(await form(b,'pollock').getByRole('combobox',{name:'Household role',exact:true}).inputValue()).toBe('member');
  expect(await form(b,'pollock').getByRole('checkbox',{name:'Owns every agent, present and future',exact:true}).isChecked()).toBe(false);
  const agent=(page:typeof a)=>page.getByRole('form',{name:'Save agent art',exact:true});
  await agent(a).getByRole('textbox',{name:'Description',exact:true}).fill('Keeps the household moving.');await agent(a).getByRole('button').click();
  await expect.poll(()=>agent(b).getByRole('textbox',{name:'Description',exact:true}).inputValue()).toBe('Keeps the household moving.');
  await form(a,'jonathan').getByRole('combobox',{name:'Household role',exact:true}).selectOption('member');
  await form(a,'jonathan').getByRole('checkbox',{name:'I confirm this membership change',exact:true}).check();await form(a,'jonathan').getByRole('button').click();
  await expect.poll(()=>form(a,'jonathan').getByRole('alert').count()).toBe(1);
  expect((await form(b,'jonathan').getByRole('combobox',{name:'Household role',exact:true}).inputValue())).toBe('owner');
  await b.reload();await expect.poll(()=>agent(b).getByRole('textbox',{name:'Description',exact:true}).inputValue()).toBe('Keeps the household moving.');
  const shots=resolve('artifacts/household-setup');mkdirSync(shots,{recursive:true});
  for(const width of [390,1280,1920]){await b.setViewportSize({width,height:1000});await b.screenshot({path:join(shots,`setup-${width}.png`),fullPage:true,animations:'disabled'});}
 }finally{await browser.close();await app.close();client.close();}
},60_000);
