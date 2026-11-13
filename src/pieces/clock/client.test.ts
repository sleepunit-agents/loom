import { afterEach, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { FakeClock, type Viewer } from '../../core/index.js';
import { startLoom } from '../../foundation.js';
import { installClock } from './index.js';
import { clockTime, type CommandAnswer } from './binding.js';
import { clockCommands, clockOperationCommands } from './commands.js';
import { wakes, schedules } from './store.js';
const dirs: string[] = [], closes: Array<()=>Promise<void>> = [];
afterEach(async()=>{for(const close of closes.splice(0)) await close();for(const dir of dirs.splice(0))rmSync(dir,{recursive:true,force:true});});
const owner: Viewer = {kind:'member',id:'jonathan'};
async function setup() {
  const home=mkdtempSync(join(tmpdir(),'clock-cli-'));dirs.push(home);
  const clock=new FakeClock(Date.parse('2026-11-13T15:00:00Z'));
  const app=await startLoom({home,clock, install(app){const jobs=installClock(app.db,app.operations,app.live,()=>({members:{jonathan:{owner:true,agents:['art','other']}},projects:{},services:{}}),{approvals:{check:()=>({state:'pending'}),subscribe:()=>()=>{}}});app.onClose(jobs.close);}});closes.push(()=>app.close());
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
  expect(run.stdout).toBe(`${extra.id}: nightly runs within a minute\n`);
  expect(a.run(['schedule','rm','nightly']).stdout).toBe('removed schedule nightly\n');
  expect(a.run(['lane','set','upkeep','--agent','art','--at','08:31','-f','routines/upkeep.md'],owner,randomUUID(),{path:'routines/upkeep.md',text:'Whole lane\n'}).exit).toBe(0);
  expect(a.run(['lane','text','upkeep']).stdout).toBe('Whole lane\n');
  expect(a.run(['lane','assign','upkeep','--agent','other']).stdout).toMatch(/\nloom lane upkeep: Other's, 8:31 AM daily\n$/);
  expect(a.run(['lane','rm','upkeep']).stdout).toBe('removed loom lane upkeep\n');
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
  expect(answer).toEqual({exit:0,stdout:`already scheduled: other/care, next at ${clockTime(due)} (nothing armed)\n`,stderr:''});
  expect(wakes(a.db)).toHaveLength(1);
  expect(a.run(['schedule','list']).stdout).toBe('art has no schedules\n');
});
