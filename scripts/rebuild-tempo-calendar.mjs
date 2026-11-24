import assert from 'node:assert/strict';
import { join } from 'node:path';
import { PeopleStore } from '../dist/backends/people.js';
import { FakeClock } from '../dist/core/clock.js';
import { exampleHome } from '../dist/example-home.js';
import { startSharedHome } from '../dist/shared-startup.js';

export async function tempoCalendar({ browser, home }) {
  await exampleHome(home);
  const zone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  // Choose two distinct times on one household date regardless of the worker's zone.
  const morning = new Date(2027, 2, 17, 9, 13);
  const afternoon = new Date(2027, 2, 17, 14, 47);
  const clock = new FakeClock(morning.getTime());
  const app = await startSharedHome({ home, clock, port: 0, stdout() {} });
  let context;
  try {
    context = await browser.newContext({locale:'en-US',timezoneId:'Pacific/Honolulu',serviceWorkers:'block'});
    await context.route('**/*',route=>new URL(route.request().url()).origin===app.url?route.continue():route.abort());
    await context.routeWebSocket(url=>url.origin!==app.url.replace(/^http/,'ws'),route=>route.close());
    const page = await context.newPage();
    page.setDefaultTimeout(10000);
    await page.goto(app.signinLink('alex'));
    await page.getByRole('button',{name:'Sign in',exact:true}).click();
    await page.locator('.next-shell').waitFor();
    const note = 'Check the seed trays';
    const trigger = app.writes.run(()=>app.services.tempo.triggers.set({
      ownerKind:'member',owner:'alex',sourceKind:'time',times:afternoon.toISOString(),
      lifespan:'once',targetKind:'inbox',toKind:'person',to:'alex',instructions:note,note,
    })).value;
    await page.goto(app.url+'/p/tempo');
    const day = page.getByRole('region',{name:'Day schedule'});
    const row = day.getByRole('button',{name:new RegExp(note)});
    const format = new Intl.DateTimeFormat('en-US',{timeZone:zone,hour:'2-digit',minute:'2-digit'});
    const at = date => format.format(date).replace(/\s/g,' ');
    await row.getByText(at(afternoon),{exact:true}).waitFor();
    await day.getByRole('separator',{name:'Now'}).waitFor();
    await page.getByRole('button',{name:'Next day'}).click();
    await page.getByRole('navigation',{name:'Calendar date'}).locator('time[datetime="2027-03-18"]').waitFor();
    await row.waitFor({state:'hidden'});
    assert.equal(await row.count(),0);
    await page.getByRole('button',{name:'Today',exact:true}).click();
    await row.getByText(at(afternoon),{exact:true}).waitFor();
    app.writes.run(()=>app.services.tempo.triggers.runNow(trigger.id));
    await row.getByText('fired',{exact:true}).waitFor();
    await row.getByText(at(morning),{exact:true}).waitFor();
    await page.reload();
    await row.click();
    await page.getByRole('heading',{name:note,exact:true}).waitFor();
    await checkFrequentRows(page,app);
    await checkDayHistory(page,app,clock);
    await checkStoppedSchedule(page,app,clock);
    const directory=new PeopleStore({dbPath:join(home,'commons','people.db')});
    try{directory.write({slug:'fern',name:'Fern Evergreen',how:{kind:'agent'}});}finally{directory.close();}
    await checkKindFilters(page,app,clock);
    return {ok:true,reason:'The scheduled wake appeared at its household time. Navigating away and back preserved its day. Firing it early moved it to the actual firing time with a fired result, and its reader opened after reload. Four recurring times shared one row in Day and Week, with live outcomes and the next time; three times kept their hourly rows. The selected day’s history showed recurring work, a lost worker’s reason, a delivered notice and a stopped trigger in order. A stopped schedule retained its former deadline and restarted at its next future time. Each of four trigger kinds had a distinct word and colour. Kind and household filters kept the selected day. Opening three triggers showed the household, agent and person who set each one.'};
  } finally {
    await context?.close();
    await app.close();
  }
}

async function checkFrequentRows(page, app) {
  const add = (note,times) => app.writes.run(()=>app.services.tempo.triggers.set({
    ownerKind:'member', owner:'alex', sourceKind:'time', times, days:'wed',
    lifespan:'until-stopped', targetKind:'inbox', toKind:'person', to:'alex', instructions:note, note,
  })).value;
  const title = 'Water the seedlings';
  const trigger = add(title,'12:00,13:00,14:00,15:00');
  add('Check the greenhouse','12:15,13:15,14:15');
  await page.goto(app.url+'/p/tempo');
  const day = page.getByRole('region',{name:'Day schedule',exact:true});
  const row = day.getByRole('region',{name:'Frequent triggers'}).getByRole('button',{name:new RegExp(title)});
  await row.getByText(/4 scheduled.*Next 12:00 PM/i).waitFor();
  assert.equal(await day.getByRole('button',{name:new RegExp(title)}).count(),1);
  assert.equal(await day.getByRole('button',{name:/Check the greenhouse/}).count(),3);
  app.writes.run(()=>app.services.tempo.triggers.runNow(trigger.id));
  await row.getByText(/1 fired.*4 scheduled/i).waitFor();
  await row.click();
  await page.getByRole('heading',{name:title,exact:true}).waitFor();
  await page.goto(app.url+'/p/tempo');
  await page.getByRole('button',{name:'Week',exact:true}).click();
  const week = page.getByRole('region',{name:'Week schedule'});
  await week.getByRole('region',{name:'Frequent triggers'}).getByRole('button',{name:new RegExp(title)}).waitFor();
  assert.equal(await week.getByRole('button',{name:new RegExp(title)}).count(),1);
}

async function checkDayHistory(page,app,clock) {
 const add=(note,toKind,to)=>app.writes.run(()=>app.services.tempo.triggers.set({
   ownerKind:'member',owner:'alex',sourceKind:'time',times:'23:55',lifespan:'until-stopped',
   targetKind:'inbox',toKind,to,instructions:note,note,
 })).value;
 const note='Check the citrus trees', trigger=add(note,'agent','fern');
 const marker='Check rainfall', paused=add(marker,'person','alex');
 app.writes.run(()=>app.services.tempo.triggers.runNow(trigger.id));
 clock.advance(60000);
 const db=app.services.comms.db.$client;
 const job=db.prepare("select job from inbox where source='trigger' and source_id like ? and job is not null").get(trigger.id+':%');
 assert.ok(job?.job);
 await page.goto(app.url+'/p/tempo');
 const day=page.getByRole('region',{name:'Day schedule',exact:true});
   const active=state=>day.getByRole('button',{name:new RegExp(note)}).filter({hasText:'Agent wake '+state});
   await active('queued').waitFor();
   app.writes.run(()=>db.prepare("update jobs set state='lost',ended_at=?,ended_note='Worker stopped reporting' where id=?").run(new Date(clock.now()).toISOString(),job.job));
   await active('lost').waitFor();
   clock.advance(1000);app.writes.run(()=>app.services.tempo.triggers.runNow(paused.id));
   clock.advance(1000);app.writes.run(()=>app.services.tempo.triggers.stop(paused.id));
   await page.getByRole('button',{name:/Recent history/}).click();
   const history=page.getByRole('region',{name:'Day history'});
   const lost=history.getByRole('button',{name:new RegExp(note)}).filter({hasText:'Worker stopped reporting'});
   await lost.waitFor();assert.match(await lost.innerText(),/Agent wake lost/);
   await history.getByRole('button',{name:new RegExp(marker)}).filter({hasText:'Inbox notice delivered'}).waitFor();
   const list=await history.getByRole('button').allTextContents();
   assert.ok(list.findIndex(x=>x.includes(marker)&&x.includes('stopped'))>=0);
   assert.ok(list.findIndex(x=>x.includes(marker)&&x.includes('stopped'))<list.findIndex(x=>x.includes(note)));
   await page.getByRole('button',{name:'Previous day'}).click();await lost.waitFor({state:'hidden'});
   const previous=await page.locator('nav[aria-label="Calendar date"] time').getAttribute('datetime');
   await page.getByRole('button',{name:'Day',exact:true}).click();
   assert.equal(await page.locator('nav[aria-label="Calendar date"] time').getAttribute('datetime'),previous);
   await page.getByRole('button',{name:'Today',exact:true}).click();await active('lost').waitFor();
   await page.getByRole('button',{name:/Recent history/}).click();await lost.click();
   await page.getByRole('heading',{name:note,exact:true}).waitFor();
   await page.getByRole('region',{name:'Recent runs'}).getByText(/Agent wake · lost/).waitFor();
}

async function checkStoppedSchedule(page,app,clock) {
  const note='Water the seed beds';
  const first=clock.now()+5*60000,second=first+10*60000;
  const wall=at=>new Date(at).toTimeString().slice(0,5);
  const schedule=app.writes.run(()=>app.services.tempo.triggers.set({
    ownerKind:'member',owner:'alex',sourceKind:'time',times:wall(first)+','+wall(second),
    lifespan:'until-stopped',targetKind:'inbox',toKind:'person',to:'alex',instructions:note,note,
  })).value;
  const due=Date.parse(schedule.nextDueAt);
  const db=app.services.comms.db.$client;
  const firings=()=>db.prepare("select count(*) from trigger_log where trigger=? and event='fired'").pluck().get(schedule.id);
  const stored=()=>db.prepare('select enabled,next_due_at from triggers where id=?').get(schedule.id);
  await page.goto(app.url+'/p/tempo/trigger/'+encodeURIComponent(schedule.id));
  await page.getByRole('button',{name:'Stop',exact:true}).click();
  await page.getByRole('button',{name:'Start',exact:true}).waitFor();
  assert.deepEqual(stored(),{enabled:0,next_due_at:null});
  await page.reload();
  await page.getByRole('button',{name:'Start',exact:true}).waitFor();
  await page.goto(app.url+'/p/tempo');
  const day=page.getByRole('region',{name:'Day schedule'});
  const stopped=day.getByRole('button',{name:new RegExp(note)}).filter({hasText:'Was due'});
  await stopped.waitFor();
  const when=new Intl.DateTimeFormat('en-US',{timeZone:Intl.DateTimeFormat().resolvedOptions().timeZone,dateStyle:'medium',timeStyle:'short'}).format(due);
  assert.ok((await stopped.innerText()).replace(/\s/g,' ').includes(when.replace(/\s/g,' ')));
  assert.equal(await stopped.locator('s').innerText(),note);
  clock.advance(due-clock.now()+1000);
  assert.equal(firings(),0);
  await stopped.click();
  await page.getByRole('button',{name:'Start',exact:true}).click();
  await page.getByRole('button',{name:'Stop',exact:true}).waitFor();
  assert.equal(Date.parse(stored().next_due_at),due+10*60000);
  clock.advance(due+10*60000-clock.now());
  assert.equal(firings(),1);

  const later='Thursday misting';
  const weekly=app.writes.run(()=>app.services.tempo.triggers.set({
    ownerKind:'member',owner:'alex',sourceKind:'time',times:'14:00',days:'thu',lifespan:'until-stopped',
    targetKind:'inbox',toKind:'person',to:'alex',instructions:later,note:later,
  })).value;
  app.writes.run(()=>{app.services.tempo.triggers.stop(weekly.id);app.services.tempo.triggers.start(weekly.id);app.services.tempo.triggers.stop(weekly.id);});
  await page.goto(app.url+'/p/tempo');
  await page.getByRole('button',{name:'Next day'}).click();
  const former=day.getByRole('button',{name:new RegExp(later)}).filter({hasText:'Was due'});
  await former.waitFor();
  assert.equal(await former.count(),1);
  assert.match(await former.innerText(),/Stopped .*17.*Was due .*18/s);
  await former.click();await page.getByRole('button',{name:'Start',exact:true}).click();
  await former.waitFor({state:'hidden'});
  await day.getByRole('button',{name:new RegExp(later)}).filter({hasText:'standing'}).waitFor();
}

async function checkKindFilters(page,app,clock) {
  const engine=app.services.tempo.triggers;
  const later=new Date(clock.now()+30*60000);
  const base={ownerKind:'agent',owner:'fern',targetKind:'inbox',toKind:'agent',to:'fern',
    sourceKind:'time',times:later.toTimeString().slice(0,5),lifespan:'until-stopped',instructions:'Check the gauge'};
  app.writes.run(()=>{
    engine.set({...base,ownerKind:'household',owner:null,note:'Gauge rounds'});
    engine.set({...base,program:{name:'read-gauge',program:'tools/gauge',repository:'https://example.org/house.git',
      commit:'1'.repeat(40),image:'sha256:'+'a'.repeat(64),args:[],secrets:{},timeoutMs:5000},note:'Gauge program'});
    engine.set({...base,ownerKind:'member',owner:'alex',toKind:'person',to:'alex',note:'Gauge notice'});
    engine.set({...base,lifespan:'once',times:later.toISOString(),note:'Gauge follow-up'});
  });
  await page.goto(app.url+'/p/tempo');
  await page.getByText('Gauge rounds',{exact:true}).waitFor();
  const search=page.getByRole('searchbox',{name:'Search tempo'});
  await search.click();await search.fill('Gauge');
  assert.equal(await search.inputValue(),'Gauge');
  const day=page.getByRole('region',{name:'Day schedule'});
  const rows=day.locator('[data-trigger-kind]');
  for(const word of ['Wakes an agent','A program decides','Loom itself','Once']) await rows.getByText(word,{exact:true}).waitFor();
  assert.equal(await rows.count(),4);
  assert.equal(new Set(await rows.evaluateAll(items=>items.map(item=>getComputedStyle(item).borderInlineStartColor))).size,4);
  for(const [note,owner] of [['Gauge rounds','Household'],['Gauge program','Agent · Fern Evergreen'],['Gauge notice','Person · Alex']]){
    await day.getByRole('button',{name:new RegExp(note)}).click();
    const reader=page.locator('article').filter({has:page.getByRole('heading',{name:note,exact:true})});
    const field=reader.locator('dl > div').filter({has:page.getByText('Set by',{exact:true})});
    await field.getByText(owner,{exact:true}).waitFor();
  }
  const kind=page.getByRole('combobox',{name:'Kind',exact:true});
  await kind.selectOption('program');
  await day.getByText('Gauge rounds',{exact:true}).waitFor({state:'hidden'});
  assert.equal(await rows.count(),1);
  await page.getByRole('button',{name:'Next day'}).click();
  await day.getByText('Gauge program',{exact:true}).waitFor();
  await kind.selectOption('');
  await page.getByRole('combobox',{name:'Whose',exact:true}).selectOption('lanes');
  await day.getByText('Gauge rounds',{exact:true}).waitFor();
  assert.equal(await rows.count(),1);
}
