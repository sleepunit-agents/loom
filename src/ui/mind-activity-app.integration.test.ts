/** One opt-in hosted browser test, two windows, six screenshots. */
import {touched} from '../core/touched/index.js';
import {memorySharedFixture,signInMemory} from './memory-shared-fixture.js';
import {expect,it} from 'vitest';
import BetterSqlite3 from 'better-sqlite3';
import {existsSync,mkdtempSync,mkdirSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {chromium} from 'playwright-core';
import {FakeClock} from '../core/clock.js';
const root=resolve(import.meta.dirname,'../../dist/web');
const chrome=[process.env.LOOM_TEST_CHROME,chromium.executablePath()].find(p=>p&&existsSync(p));
const enabled=!!process.env.CI&&process.env.LOOM_ACTIVITY_EVIDENCE==='1';
if(enabled&&process.env.RUNNER_ENVIRONMENT==='self-hosted')throw Error('Activity browser evidence requires a hosted runner');
if(enabled&&(!chrome||!existsSync(join(root,'next.html'))))throw Error('Activity evidence requires Chrome and built next app in CI');
it.runIf(enabled&&chrome&&existsSync(join(root,'next.html')))('Activity filters, stories, earlier days and outside updates in two windows',async()=>{
 const home=mkdtempSync(join(tmpdir(),'activity-app-')),clock=new FakeClock(Date.parse('2026-11-13T18:00:00Z'));

 mkdirSync(join(home,'agents/art'),{recursive:true});const path=join(home,'agents/art/memories.db'),db=new BetterSqlite3(path);
 db.exec("CREATE TABLE memories(ref TEXT PRIMARY KEY,title TEXT,content TEXT,created TEXT,project TEXT,metadata TEXT,expires_at TEXT,category TEXT,archived INTEGER)");
 const add=(ref:string,title:string,created='2026-11-13T15:00:00Z')=>db.prepare('INSERT INTO memories VALUES(?,?,?,?,NULL,?,NULL,?,0)').run(ref,title,'The field team has the release. Work continues on t-2207.',created,'{"where":"slack"}','episode');
 add('m-field','Field release: team connected');add('m-older','Earlier field notes','2026-11-09T12:00:00Z');
 const fixture=await memorySharedFixture({home,clock,webRoot:root,agents:['art'],otherMembers:['other-member']}),{app}=fixture;
 app.writes.run(()=>{
  const first=app.services.conversations.open({agent:'art',venue:'wake',place:'owner-session',member:'owner',label:'Build the household desk'});
  app.services.conversations.turn({conversation:first.id,kind:'reply',fromKind:'agent',fromId:'art'});
  app.services.conversations.digest({conversation:first.id,run:'fictional-owner-run',summary:'Shipped the household desk. The live timeline brings the work together.',items:[{kind:'ask',text:'Show what happened across the household'},{kind:'decision',text:'Keep content in the agents’ stores'},{kind:'task',text:'t-2207'}],question:{to:'owner',words:'Review the result',answers:'yes-no'}});
  const planning=app.services.conversations.open({agent:'art',venue:'wake',place:'planning-session',label:'Planning the next release'});
  for(let i=0;i<3;i++)app.services.conversations.turn({conversation:planning.id,kind:i===2?'reply':'message',fromKind:i===2?'agent':'person',fromId:i===2?'art':'owner'});
  const other=app.services.conversations.open({agent:'art',venue:'wake',place:'other-session',member:'other-member',label:'Other member private thread'});
  app.services.conversations.digest({conversation:other.id,run:'fictional-other-run',summary:'Shipped the household desk. The live timeline brings the work together.',items:[{kind:'decision',text:'Keep content in the agents’ stores'}]});
 });
 const browser=await chromium.launch({executablePath:chrome,args:['--no-sandbox']});
 try{
  const context=await browser.newContext({serviceWorkers:'block',viewport:{width:1280,height:900}}),a=await context.newPage(),b=await context.newPage();await b.setViewportSize({width:390,height:900});
  const errors:string[]=[];a.on('pageerror',e=>errors.push(e.message));b.on('pageerror',e=>errors.push(e.message));
  await signInMemory(a,fixture);
  await Promise.all([a.goto(`${app.url}/p/activity-preview`),b.goto(`${app.url}/p/activity-preview`)]);
  const row=(p:typeof a,title:string)=>p.locator('[data-split-row]').filter({has:p.getByText(title,{exact:true})});
  await expect.poll(()=>row(b,'Build the household desk').count()).toBe(1);expect(await row(a,'Other member private thread').count()).toBe(1);
  expect(await row(a,'Planning the next release').count()).toBe(1);await row(a,'Planning the next release').click();await expect.poll(()=>a.getByRole('heading',{name:'Planning the next release',exact:true}).count()).toBe(1);
  await row(a,'Build the household desk').click();await row(b,'Build the household desk').click();
  await expect.poll(()=>b.getByRole('heading',{name:'What happened',exact:true}).count()).toBe(1);expect(await b.getByText('Keep content in the agents’ stores',{exact:true}).count()).toBe(1);
  expect(await b.locator('article a[href="/p/tasks-preview/task/t-2207"]').count()).toBe(1);expect(await b.getByText('Review the result',{exact:false}).count()).toBe(1);
  await b.getByRole('link',{name:'Conversation',exact:true}).click();
  const conversationTile=b.locator('[data-tile=comms]');
  await expect.poll(()=>conversationTile.getByRole('heading',{name:'Conversation activity',exact:true}).count()).toBe(1);
  await expect.poll(()=>conversationTile.getByText('Build the household desk',{exact:true}).count()).toBe(1);
  await expect.poll(()=>conversationTile.getByText('reply · art',{exact:true}).count()).toBe(1);
  await b.goBack();await expect.poll(()=>b.getByRole('heading',{name:'What happened',exact:true}).count()).toBe(1);
  await a.setViewportSize({width:800,height:900});await expect.poll(()=>a.locator('.loom-split').getAttribute('data-mode')).toBe('two');await a.setViewportSize({width:1280,height:900});
  await expect.poll(()=>b.getByText('Shipped the household desk. The live timeline brings the work together.',{exact:true}).count()).toBe(1);
  const shots=resolve('artifacts/activity-app');mkdirSync(shots,{recursive:true});
  for(const look of ['neon','daylight'])for(const width of [390,1280,1920]){const page=width<640?b:a;await page.setViewportSize({width,height:900});await page.evaluate(look=>{document.documentElement.dataset.look=look;document.documentElement.dataset.mode=look==='daylight'?'light':'dark';document.documentElement.dataset.motion='reduce';},look);await expect.poll(()=>page.locator('.loom-split').getAttribute('data-mode')).toBe(width<640?'one':'three');expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);await page.screenshot({path:join(shots,`activity-${look}-${width}.png`),fullPage:true,animations:'disabled'});}
  await b.getByRole('button',{name:'Activity',exact:true}).last().click();await b.getByText('Filter activity',{exact:true}).click();await b.getByRole('button',{name:'Work done · 2',exact:true}).click();await expect.poll(()=>row(b,'Planning the next release').count()).toBe(0);expect(await b.url()).toContain('what=work');
  await b.getByRole('button',{name:'Show everything',exact:true}).click();await b.getByRole('button',{name:'Earlier',exact:true}).click();await expect.poll(()=>row(b,'Earlier field notes').count()).toBe(1);
  await b.getByRole('combobox',{name:'Shown day',exact:true}).selectOption('2026-11-09');await expect.poll(()=>b.getByRole('button',{name:'6:00: 1 entries',exact:true}).count()).toBe(1);await b.getByRole('button',{name:'6:00: 1 entries',exact:true}).click();expect(await row(b,'Earlier field notes').evaluate(el=>el===document.activeElement)).toBe(true);
  await b.getByRole('combobox',{name:'Shown day',exact:true}).selectOption('2026-11-13');
  add('m-new','Outside field update','2026-11-13T17:59:00Z');touched(join(home,'agents/art'),'memory','m-new');
  await expect.poll(()=>row(a,'Outside field update').count()).toBe(1);await expect.poll(()=>row(b,'Outside field update').count()).toBe(1);await row(b,'Outside field update').click();await expect.poll(()=>b.getByRole('heading',{name:'Outside field update',exact:true}).count()).toBe(1);
  await b.getByRole('link',{name:'The memory',exact:true}).click();await expect.poll(()=>b.url().includes('/memory/art%3Am-new')).toBe(true);expect(await b.getByText('The field team has the release. Work continues on t-2207.',{exact:true}).count()).toBe(1);
  db.prepare('UPDATE memories SET archived=1 WHERE ref=?').run('m-new');touched(join(home,'agents/art'),'memory','m-new');await expect.poll(()=>b.getByText('This entry is no longer available',{exact:true}).count()).toBe(1);expect(errors).toEqual([]);
 }finally{await browser.close();await fixture.close();db.close();rmSync(home,{recursive:true,force:true});}
},60000);
