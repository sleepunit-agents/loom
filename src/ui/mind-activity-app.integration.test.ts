/** One opt-in hosted browser test, two windows, six screenshots. */
import {expect,it} from 'vitest';
import BetterSqlite3 from 'better-sqlite3';
import {existsSync,mkdtempSync,mkdirSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {chromium} from 'playwright-core';
import {startLoom} from '../foundation.js';
import {createFoundation} from '../core/app.js';
import {FakeClock} from '../core/clock.js';
import {migrateHouseholdTables} from '../core/household/schema.js';
import {TokenDatabase} from '../core/household/tokens.js';
import {HouseholdDatabase} from '../core/household/document.js';
import {installMindActivity} from '../pieces/mind/activity.js';
import type {ActivityRun} from '../pieces/mind/activity-role.js';
const root=resolve(import.meta.dirname,'../../dist/web');
const chrome=[process.env.LOOM_TEST_CHROME,chromium.executablePath()].find(p=>p&&existsSync(p));
const enabled=!!process.env.CI&&process.env.LOOM_ACTIVITY_EVIDENCE==='1';
if(enabled&&process.env.RUNNER_ENVIRONMENT==='self-hosted')throw Error('Activity browser evidence requires a hosted runner');
if(enabled&&(!chrome||!existsSync(join(root,'next.html'))))throw Error('Activity evidence requires Chrome and built next app in CI');
it.runIf(enabled&&chrome&&existsSync(join(root,'next.html')))('Activity filters, stories, earlier days and outside updates in two windows',async()=>{
 const home=mkdtempSync(join(tmpdir(),'activity-app-')),clock=new FakeClock(Date.parse('2026-11-13T18:00:00Z'));
 const metadata=createFoundation({home});migrateHouseholdTables(metadata.db);
 metadata.db.transaction(()=>new HouseholdDatabase(metadata.db).replace(home,{v:1,agents:['art'],default:'art',owner:'owner',members:[{person:'owner',role:'owner',agents:'*'},{person:'other-member',role:'member',agents:['art']}]}))();
 metadata.db.transaction(()=>new TokenDatabase(metadata.db).replace({v:1,tokens:[]},{}))();metadata.close();
 mkdirSync(join(home,'agents/art'),{recursive:true});const path=join(home,'agents/art/memories.db'),db=new BetterSqlite3(path);
 db.exec("CREATE TABLE memories(ref TEXT PRIMARY KEY,title TEXT,content TEXT,created TEXT,project TEXT,metadata TEXT,expires_at TEXT,category TEXT,archived INTEGER)");
 const add=(ref:string,title:string,created='2026-11-13T15:00:00Z')=>db.prepare('INSERT INTO memories VALUES(?,?,?,?,NULL,?,NULL,?,0)').run(ref,title,'The field team has the release. Work continues on t-2207.',created,'{"where":"slack"}','episode');
 add('m-field','Field release: team connected');add('m-older','Earlier field notes','2026-11-09T12:00:00Z');
 const rows:ActivityRun[]=[{kind:'digest',key:'dg-one',at:'2026-11-13T17:10:00Z',conversation:{id:'cv-111111111111',agent:'art',venue:'loom',place:'thread',label:'Build the household desk',people:['owner'],member:'owner'},summary:'Shipped the household desk. The live timeline brings the work together.',asked:['Show what happened across the household'],decided:['Keep content in the agents’ stores'],tasks:['t-2207'],links:[{label:'The thread in Comms',href:'/p/comms-preview/thread/thread-one'}],steps:[{label:'Read the contracts',state:'done',tool:'Read'},{label:'Built the Activity screen',state:'done',tool:'Edit'}],needs:'Review the result',needsForMember:'owner',more:[]},
 {kind:'conversation',key:'cv-222222222222',at:'2026-11-13T16:00:00Z',conversation:{id:'cv-222222222222',agent:'art',venue:'terminal',place:'terminal',label:'Planning the next release',people:[]},turns:3,replies:1,asked:[],decided:[],tasks:[],links:[],more:[]}];
 rows.push({...rows[0],key:'private',conversation:{...rows[0].conversation,id:'cv-333333333333',member:'other-member',label:'Other member private thread'}});
 const app=await startLoom({home,next:true,clock,webRoot:root,install(app){const reader=installMindActivity(app.operations,app.live,{agents:[{agent:'art',memories:path}],sharing:()=>({members:{owner:{owner:true,agents:[]},'other-member':{owner:false,agents:['art']}},projects:{},services:{}}),owner:'owner',ownerLabel:'Jonathan',conversations:{list:(_v,q)=>({available:true,rows:rows.filter(r=>Date.parse(r.at)>=q.from&&Date.parse(r.at)<q.until)}),read:(_v,a,k,key)=>rows.find(r=>r.conversation.agent===a&&r.kind===k&&r.key===key),conversation:(_v,_a,id)=>rows.find(r=>r.conversation.id===id)?.conversation}});app.onClose(()=>reader.close());}});
 const owner={kind:'member' as const,id:'owner'},browser=await chromium.launch({executablePath:chrome,args:['--no-sandbox']});
 try{
  const context=await browser.newContext({serviceWorkers:'block',viewport:{width:1280,height:900}}),a=await context.newPage(),b=await context.newPage();await b.setViewportSize({width:390,height:900});
  const errors:string[]=[];a.on('pageerror',e=>errors.push(e.message));b.on('pageerror',e=>errors.push(e.message));
  const link=app.operations.call('direct',owner,'signin.link',{member:'owner'});if(!link.ok)throw Error('Fixture sign-in failed');await a.goto(app.url+(link.value as {path:string}).path);
  const signed=a.waitForResponse(r=>r.request().method()==='POST');await a.getByRole('button',{name:'Sign in',exact:true}).click();expect((await signed).status()).toBe(303);
  await Promise.all([a.goto(`${app.url}/p/activity-preview`),b.goto(`${app.url}/p/activity-preview`)]);
  const row=(p:typeof a,title:string)=>p.locator('[data-split-row]').filter({has:p.getByText(title,{exact:true})});
  await expect.poll(()=>row(b,'Build the household desk').count()).toBe(1);expect(await row(a,'Other member private thread').count()).toBe(0);
  expect(await row(a,'Planning the next release').count()).toBe(1);await row(a,'Planning the next release').click();await expect.poll(()=>a.getByRole('heading',{name:'Planning the next release',exact:true}).count()).toBe(1);
  await row(a,'Build the household desk').click();await row(b,'Build the household desk').click();
  await expect.poll(()=>b.getByRole('heading',{name:'What happened',exact:true}).count()).toBe(1);expect(await b.getByText('Keep content in the agents’ stores',{exact:true}).count()).toBe(1);expect(await b.getByText('Read the contracts',{exact:false}).count()).toBe(1);
  expect(await b.locator('article a[href="/p/tasks-preview/task/t-2207"]').count()).toBe(1);expect(await b.getByText('Review the result',{exact:false}).count()).toBe(1);
  await a.setViewportSize({width:800,height:900});await expect.poll(()=>a.locator('.loom-split').getAttribute('data-mode')).toBe('two');await a.setViewportSize({width:1280,height:900});
  await expect.poll(()=>b.getByText('Shipped the household desk. The live timeline brings the work together.',{exact:true}).count()).toBe(1);
  const shots=resolve('artifacts/activity-app');mkdirSync(shots,{recursive:true});
  for(const look of ['neon','daylight'])for(const width of [390,1280,1920]){const page=width<640?b:a;await page.setViewportSize({width,height:900});await page.evaluate(look=>{document.documentElement.dataset.look=look;document.documentElement.dataset.mode=look==='daylight'?'light':'dark';document.documentElement.dataset.motion='reduce';},look);await expect.poll(()=>page.locator('.loom-split').getAttribute('data-mode')).toBe(width<640?'one':'three');expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);await page.screenshot({path:join(shots,`activity-${look}-${width}.png`),fullPage:true,animations:'disabled'});}
  await b.getByRole('button',{name:'Activity',exact:true}).last().click();await b.getByText('Filter activity',{exact:true}).click();await b.getByRole('button',{name:'Work done · 1',exact:true}).click();await expect.poll(()=>row(b,'Planning the next release').count()).toBe(0);expect(await b.url()).toContain('what=work');
  await b.getByRole('button',{name:'Show everything',exact:true}).click();await b.getByRole('button',{name:'Earlier',exact:true}).click();await expect.poll(()=>row(b,'Earlier field notes').count()).toBe(1);
  await b.getByRole('combobox',{name:'Shown day',exact:true}).selectOption('2026-11-09');await expect.poll(()=>b.getByRole('button',{name:'6:00: 1 entries',exact:true}).count()).toBe(1);await b.getByRole('button',{name:'6:00: 1 entries',exact:true}).click();expect(await row(b,'Earlier field notes').evaluate(el=>el===document.activeElement)).toBe(true);
  await b.getByRole('combobox',{name:'Shown day',exact:true}).selectOption('2026-11-13');
  add('m-new','Outside field update','2026-11-13T17:59:00Z');expect(app.operations.call('direct',{kind:'agent',id:'art'},'core.touched',{type:'memory',id:'art:m-new'})).toMatchObject({ok:true});
  await expect.poll(()=>row(a,'Outside field update').count()).toBe(1);await expect.poll(()=>row(b,'Outside field update').count()).toBe(1);await row(b,'Outside field update').click();await expect.poll(()=>b.getByRole('heading',{name:'Outside field update',exact:true}).count()).toBe(1);
  await b.getByRole('link',{name:'The memory',exact:true}).click();await expect.poll(()=>b.url().includes('/memory/art%3Am-new')).toBe(true);expect(await b.getByText('The field team has the release. Work continues on t-2207.',{exact:true}).count()).toBe(1);
  db.prepare('UPDATE memories SET archived=1 WHERE ref=?').run('m-new');app.operations.call('direct',{kind:'agent',id:'art'},'core.touched',{type:'memory',id:'art:m-new'});await expect.poll(()=>b.getByText('This entry is no longer available',{exact:true}).count()).toBe(1);expect(errors).toEqual([]);
 }finally{await browser.close();await app.close();db.close();rmSync(home,{recursive:true,force:true});}
},60000);
