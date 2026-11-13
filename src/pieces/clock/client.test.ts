import { Readable } from 'node:stream';
import { runWakeClient } from '../../cli/wake-client.js';
import { afterEach, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { FakeClock, type Viewer } from '../../core/index.js';
import { startLoom } from '../../foundation.js';
import { importClock } from './importer.js';
import { installClock } from './index.js';
import { clockTime, type CommandAnswer } from './binding.js';
import { clockCommands, clockOperationCommands } from './commands.js';
import { wakes, schedules } from './store.js';
const dirs: string[] = [], closes: Array<()=>Promise<void>> = [];
afterEach(async()=>{for(const close of closes.splice(0)) await close();for(const dir of dirs.splice(0))rmSync(dir,{recursive:true,force:true});});
const owner: Viewer = {kind:'member',id:'jonathan'};
async function setup(imported = false) {
  const home=mkdtempSync(join(tmpdir(),'clock-cli-'));dirs.push(home);
  if (imported) {
    const source=join(home,'old');mkdirSync(join(source,'art'),{recursive:true});
    writeFileSync(join(source,'art','spool.jsonl'), ['w-aaaaaa','w-bbbbbb'].map(id=>JSON.stringify({id,kind:'wake',for:'-',at:'2026-11-14 09:00:00',created:'2026-11-13 08:00:00',prompt:'Imported work',note:'unknown'})).join('\n'));
  }
  const clock=new FakeClock(Date.parse('2026-11-13T15:00:00Z'));
  const app=await startLoom({home,clock, authenticate:req => req.headers.authorization === 'Bearer fixture-token' ? {viewer:owner,valid:()=>true} : undefined, install(app){if(imported)importClock(app.db,join(home,'old'),clock.now());const jobs=installClock(app.db,app.operations,app.live,()=>({members:{jonathan:{owner:true,agents:['art','other']}},projects:{},services:{}}),{approvals:{check:()=>({state:'pending'}),subscribe:()=>()=>{}}});app.onClose(jobs.close);}});closes.push(()=>app.close());
  const run=(argv:string[],viewer=owner,id=randomUUID(),laneFile?:{path:string;text:string})=>{
    const answer=app.operations.call('http',viewer,'clock.command',{argv,agent:'art',laneFile},id);
    if(!answer.ok)throw Error(JSON.stringify(answer));return answer.value as CommandAnswer;
  };
  return {...app,clock,run};
}
it('registers shared metadata and ports elapsed tokens, CT formatting, list and cancel text',async()=>{
  const a=await setup();
  for(const [operation,name] of Object.entries(clockOperationCommands))expect(a.operations.offered('http').find(o=>o.name===`clock.${operation}`)?.cli).toEqual(clockCommands.find(c=>c.name===name));
  const args=['in','1h','30m','-p','Continue work','--note','t-2201'];
  const result=a.run(args,owner,'retry');const w=wakes(a.db)[0];
  expect(result).toEqual({exit:0,stdout:`${w.id} will wake at 2026-11-13 10:30:00\n`,stderr:''});
  expect(a.run(args,owner,'retry')).toEqual(result);expect(wakes(a.db)).toHaveLength(1);
  expect(a.run(['list']).stdout).toBe(`${w.id}  2026-11-13 10:30:00  (in 1h30m)  [wake]  t-2201\n`);
  expect(a.run(['cancel',w.id])).toEqual({exit:0,stdout:`cancelled ${w.id}\n`,stderr:''});
  expect(a.run(['list']).stdout).toBe('no pending wakes\n');
});
it('ports schedule create, list, run, remove and lane text input without daemon files',async()=>{
  const a=await setup();
  const created=a.run(['schedule','set','nightly','--at','03:31','--days','mon-fri','-f','routines/upkeep.md','--note','care']);
  const s=schedules(a.db)[0],w=wakes(a.db)[0];
  expect(s.id).toBe('art/nightly');expect(created.stdout).toBe(`schedule nightly: next at ${clockTime(w.due)} (${w.id})\n`);
  expect(a.run(['schedule','list']).stdout).toBe(`${'nightly'.padEnd(22)} ${'Weekdays 3:31 AM'.padEnd(18)} next ${clockTime(w.due)}  routines/upkeep.md  — care\n`);
  const run=a.run(['schedule','run','nightly']);const extra=wakes(a.db).find(e=>e.id!==w.id)!;
  expect(run.stdout).toBe(`${extra.id}: nightly runs within a minute\n`);expect(extra.note).toBe('nightly run now');
  expect(a.run(['schedule','rm','nightly']).stdout).toBe('removed schedule nightly\n');
  expect(a.run(['lane','set','upkeep','--agent','art','--at','08:31','-f','routines/upkeep.md'],owner,randomUUID(),{path:'routines/upkeep.md',text:'Whole lane\n'}).exit).toBe(0);
  expect(a.run(['lane','text','upkeep']).stdout).toBe('Whole lane\n');
  expect(a.run(['lane','assign','upkeep','--agent','other']).stdout).toMatch(/\nloom lane upkeep: Other's, 8:31 AM daily\n$/);
  expect(a.run(['lane','rm','upkeep']).stdout).toBe('removed schedule upkeep\nremoved loom lane upkeep\n');
});
it('preserves park, fresh now and pause/resume output, including repeated actions',async()=>{
  const a=await setup();
  const park=a.run(['park','--on','a-wait','-p','Continue','--note','ask']);const w=wakes(a.db)[0];
  expect(park.stdout).toBe(`${w.id} parked on a-wait: it wakes when the owner answers (checked every 5 minutes; 24h at most). End this session now.\n`);
  expect(a.run(['pause']).stdout).toBe("paused art's clock: wakes that come due are held until resume\n");
  expect(a.run(['pause']).stdout).toBe("art's clock is already paused\n");
  expect(a.run(['resume']).stdout).toBe("resumed art's clock\n");
  expect(a.run(['resume']).stdout).toBe("art's clock isn't paused\n");
  expect(a.run(['now']).stdout).toMatch(/^w-[\w-]+: art wakes within a minute\n$/);
});
it('retains central policy and refuses forged identity, malformed grammar and unavailable workflows',async()=>{
  const a=await setup();
  expect(a.run(['in','1h','-p','Work'],{kind:'agent',id:'stranger'})).toMatchObject({exit:1,stderr:'wake: Permission denied\n'});
  expect(a.run(['in','1h','-p','Work','--principal','owner']).exit).toBe(2);
  expect(a.run(['in','1h','-p','Work','--note']).exit).toBe(2);
  expect(a.run(['in','1h','-p','Work','-f','routines/x.md']).exit).toBe(1);
  expect(a.run(['lane','set','care','--agent','art','--at','08:31','-f','missing.md']).exit).toBe(1);
  expect(a.run(['ask-vouch','w-old']).stderr).toContain('not implemented yet');
  expect(a.run(['fire','w-old']).exit).toBe(1);
  expect(a.run(['relay','--to','mark','--say','hi'])).toEqual({exit:1,stdout:'',stderr:'wake: relays moved to loom\'s runtime: use the relay tool (to, say, why?, reply_to?, from?, approval?), or from a house: loom runtime relay --to <agent> --say "…" [--reply-to r-…] [--approval a-…]; loom runtime relays lists them\n'});
  expect(wakes(a.db)).toEqual([]);
});
it('shows already-scheduled output without duplicate work, respects global agent selection',async()=>{
  const a=await setup();
  expect(a.run(['--agent','other','schedule','set','care','--at','11:31','-f','routines/care.md']).exit).toBe(0);
  const due=wakes(a.db)[0].due;
  const answer=a.run(['--agent=other','at','11:31','-f','routines/care.md'],{kind:'agent',id:'other'});
  expect(answer).toEqual({exit:0,stdout:`already scheduled: care, next at ${clockTime(due)} (nothing armed)\n`,stderr:''});
  expect(wakes(a.db)).toHaveLength(1);
  expect(a.run(['schedule','list']).stdout).toBe('art has no schedules\n');
});

it('crosses the real HTTP door and retries a lost committed response without another wake',async()=>{
  const a=await setup(), token=join(dirs.at(-1)!,'token');writeFileSync(token,'fixture-token');
  let stdout='',stderr='',calls=0;const bodies: string[]=[];
  const code=await runWakeClient(['in','1h','-p','Continue'],{
    env:{LOOM_URL:a.url,LOOM_TOKEN_FILE:token,WAKE_AGENT:'art'},stdin:Readable.from([]),stdinIsTTY:false,stdout:s=>stdout+=s,stderr:s=>stderr+=s,
  },{request:async(url,init)=>{
    bodies.push(String(init?.body));const response=await fetch(url,init);
    if(++calls===1){await response.body?.cancel();throw Error('lost response');}return response;
  },retry:async()=>{}});
  expect(code).toBe(0);expect(stderr).toBe('');expect(bodies).toHaveLength(2);expect(bodies[0]).toBe(bodies[1]);
  const rows=wakes(a.db);expect(rows).toHaveLength(1);expect(stdout).toBe(`${rows[0].id} will wake at 2026-11-13 10:00:00\n`);
});

it('accepts nested options before the action and filters the actual displayed log lines',async()=>{
  const a=await setup();
  expect(a.run(['schedule','--at','03:31','-p','Work','set','nightly']).exit).toBe(0);
  const run=a.run(['schedule','--note','extra','run','nightly']);expect(run.exit).toBe(0);
  expect(wakes(a.db).find(w=>w.runNow)?.note).toBe('nightly run now: extra');
  expect(a.run(['log','--grep','2026-11-13']).stdout).toContain('2026-11-13 09:00:00 set');
  expect(a.run(['log','--grep','agent']).stdout).toBe('\n');
  expect(a.run(['lane','--at','08:31','--agent','art','-p','Words','set','care']).exit).toBe(0);
});
it('defaults authenticated agents to themselves and requires member clock selection',async()=>{
  const a=await setup();
  const call=(viewer:Viewer)=>a.operations.call('http',viewer,'clock.command',{argv:['in','1h','-p','Work']},randomUUID());
  expect(call({kind:'agent',id:'art'})).toMatchObject({ok:true,value:{exit:0}});
  expect(wakes(a.db)[0].agent).toBe('art');
  expect(call(owner)).toMatchObject({ok:true,value:{exit:1,stderr:'wake: select a clock with --agent or WAKE_AGENT\n'}});
});
it('resolves raw schedule ids only on their own clock',async()=>{
  const a=await setup();
  expect(a.operations.call('direct',owner,'clock.scheduleSet',{id:'care',agent:'other',at:'08:31',prompt:'Other work',note:''},randomUUID()).ok).toBe(true);
  expect(a.run(['schedule','rm','care']).exit).toBe(1);
  expect(schedules(a.db).find(s=>s.id==='care')?.agent).toBe('other');
  expect(a.run(['--agent','other','schedule','rm','care']).exit).toBe(0);
});
it('prints actual firing and held states without inspecting transient units',async()=>{
  const a=await setup();a.run(['in','1m','-p','Words']);
  const w=wakes(a.db)[0];a.clock.advance(60000);
  // Dispatch intent commits synchronously; its asynchronous runtime result follows.
  expect(a.run(['list']).stdout).toContain('[firing]');
  for(let n=0;n<10 && wakes(a.db).find(e=>e.id===w.id)?.state==='firing';n++) await Promise.resolve();
  expect(wakes(a.db).find(e=>e.id===w.id)?.state).toBe('held');
  expect(a.run(['list']).stdout).toContain('[held]');
});

it('accepts attached short options and prevents cancelling another selected clock',async()=>{
  const a=await setup();
  expect(a.run(['in','1h','-pWords']).exit).toBe(0);
  const w=wakes(a.db)[0];
  expect(a.run(['--agent','other','cancel',w.id])).toEqual({exit:1,stdout:'',stderr:`wake: no spool entry ${w.id}\n`});
  expect(wakes(a.db)[0].state).toBe('pending');
  expect(a.run(['lane','--at','08:31','--agent','art','-froutines/care.md','set','care'],owner,randomUUID(),{path:'routines/care.md',text:'Words'}).exit).toBe(0);
});
it('renders lane list, rearm and duration-filtered bounded logs',async()=>{
  const a=await setup();
  expect(a.run(['lane','list']).stdout).toBe('no loom lanes\n');
  a.run(['lane','set','care','--agent','art','--at','08:31','-pWords','--local']);
  expect(a.run(['lane','list']).stdout).toBe(`${'care'.padEnd(22)} ${'art'.padEnd(8)} ${'8:31 AM daily'.padEnd(18)} 5 chars local\n`);
  expect(a.run(['rearm'])).toEqual({exit:0,stdout:'clock deadlines rearmed\n',stderr:''});
  const w=wakes(a.db)[0];a.db.prepare('DELETE FROM clock_events').run();
  const insert=a.db.prepare('INSERT INTO clock_events(wake,record) VALUES (?,?)');
  a.db.transaction(()=>{
    insert.run(w.id,JSON.stringify({at:a.clock.now()-7200000,kind:'set',note:'old',agent:'art'}));
    for(let n=0;n<2003;n++)insert.run(w.id,JSON.stringify({at:a.clock.now()-10000+n,kind:'set',note:`event-${n}`,agent:'art'}));
  })();
  const log=a.run(['log','--since','1h']);expect(log.exit).toBe(0);
  const lines=log.stdout.trimEnd().split('\n');expect(lines).toHaveLength(2000);
  expect(lines[0]).toContain('event-3');expect(lines.at(-1)).toContain('event-2002');expect(log.stdout).not.toContain(' old');
  expect(a.run(['log','--since','1s']).stdout).toBe('\n');
  expect(a.run(['log','--since','broken']).exit).toBe(1);
});

it('runs and lists household lanes through schedule commands and joins absolute time tokens',async()=>{
  const a=await setup();
  expect(a.run(['lane','set','care','--agent','art','--at','08:31','-p','Words']).exit).toBe(0);
  expect(a.run(['schedule','list']).stdout).toContain('care');
  expect(a.run(['schedule','run','care']).exit).toBe(0);
  const run=wakes(a.db).find(w=>w.runNow)!;expect(run).toMatchObject({schedule:'lane/care',note:'care run now'});
  expect(a.run(['list']).stdout).toContain('[schedule]  schedule care: loom lane');
  expect(a.run(['at','tomorrow','11:31','-pWords']).stdout).toMatch(/will wake at 2026-11-14 11:31:00\n$/);
  expect(a.run(['at','2026-11-15','08:31:20','-pWords']).stdout).toMatch(/will wake at 2026-11-15 08:31:20\n$/);
});
it('refuses ambiguous same-agent schedule names instead of choosing different work',async()=>{
  const a=await setup();
  a.run(['lane','set','care','--agent','art','--at','08:31','-pWords']);
  a.operations.call('direct',owner,'clock.scheduleSet',{id:'art/care',agent:'art',at:'09:31',prompt:'Other words',note:''},randomUUID());
  expect(a.run(['schedule','run','care'])).toMatchObject({exit:1,stderr:'wake: schedule name is ambiguous; use its exact id in the Clock app\n'});
  expect(wakes(a.db).filter(w=>w.runNow)).toHaveLength(0);
});

it('vouches through the command with canonical unique ids and one outer retry receipt',async()=>{
  const a=await setup(true), args=['vouch','w-bbbbbb','w-aaaaaa','w-bbbbbb'];
  const result=a.run(args,owner,'vouch-retry');
  expect(result).toEqual({exit:0,stdout:"vouched for w-aaaaaa w-bbbbbb: they fire as the owner's\n",stderr:''});
  const snapshot=wakes(a.db);
  expect(snapshot.every(w=>w.state==='pending' && w.by.kind==='member' && w.by.id==='jonathan')).toBe(true);
  expect(a.run(args,owner,'vouch-retry')).toEqual(result);
  expect(wakes(a.db)).toEqual(snapshot);
  expect(a.db.prepare("SELECT * FROM clock_events").all()).toHaveLength(2);
});
it('reports unchanged vouch targets truthfully and keeps the owning policy on every command call',async()=>{
  const a=await setup(true), before=wakes(a.db);
  for(const viewer of [{kind:'agent',id:'art'},{kind:'member',id:'stranger'}] as Viewer[])
    expect(a.run(['vouch','w-aaaaaa'],viewer)).toMatchObject({exit:1,stdout:''});
  expect(a.run(['--agent','other','vouch','w-aaaaaa'])).toMatchObject({exit:1,stdout:''});
  expect(a.run(['vouch'])).toMatchObject({exit:2,stdout:''});
  expect(a.run(['vouch','w-aaaaaa','--approval','a-old'])).toMatchObject({exit:2,stdout:''});
  expect(a.run(['vouch','w-INVALID'])).toMatchObject({exit:1,stdout:''});
  expect(a.operations.call('http',{kind:'service',id:'clock'},'clock.command',{argv:['vouch','w-aaaaaa'],agent:'art'},randomUUID())).toMatchObject({ok:false,code:'denied'});
  expect(wakes(a.db)).toEqual(before);
  const missing='w-cccccc';
  expect(a.run(['vouch','w-aaaaaa',missing])).toEqual({exit:0,stdout:"vouched for w-aaaaaa: it fires as the owner's\nunchanged: w-cccccc\n",stderr:''});
  expect(wakes(a.db).find(w=>w.id==='w-bbbbbb')).toEqual(before.find(w=>w.id==='w-bbbbbb'));
  expect(a.run(['vouch','w-aaaaaa'])).toMatchObject({exit:1,stdout:''});
});
it('retries owner vouch over HTTP after losing the committed answer without adopting twice',async()=>{
  const a=await setup(true),token=join(dirs.at(-1)!,'token');writeFileSync(token,'fixture-token');
  let stdout='',stderr='',calls=0;const bodies:string[]=[];
  const code=await runWakeClient(['vouch','w-aaaaaa'],{
    env:{LOOM_URL:a.url,LOOM_TOKEN_FILE:token,WAKE_AGENT:'art'},stdin:Readable.from([]),stdinIsTTY:false,stdout:s=>stdout+=s,stderr:s=>stderr+=s,
  },{request:async(url,init)=>{
    bodies.push(String(init?.body));const response=await fetch(url,init);
    if(++calls===1){await response.body?.cancel();throw Error('lost response');}return response;
  },retry:async()=>{}});
  expect(code).toBe(0);expect(stderr).toBe('');
  expect(stdout).toBe("vouched for w-aaaaaa: it fires as the owner's\n");
  expect(bodies).toHaveLength(2);expect(bodies[0]).toBe(bodies[1]);
  expect(a.db.prepare('SELECT * FROM clock_events').all()).toHaveLength(1);
  expect(wakes(a.db).find(w=>w.id==='w-aaaaaa')).toMatchObject({state:'pending',by:owner});
});
