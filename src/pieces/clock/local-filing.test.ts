import { randomUUID, createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { startLoom } from '../../foundation.js';
import { FakeClock, type Viewer } from '../../core/index.js';
import { fixtureSharing } from '../../fixture.js';
import { installApprovals } from '../approvals/index.js';
import { load } from '../approvals/store.js';
import type { Caller } from '../approvals/model.js';
import { installClock } from './index.js';
import { clockLocalFiling, filedLocal, localMarker, localWords } from './local-filing.js';
import { wakes } from './store.js';
const owner: Viewer = {kind:'member',id:'jonathan'};
const caller: Caller = {who:{agent:'art',where:'house (queue)'},for:'owner',conversation:'cv-123456789abc'};
const prompt = localMarker + '\nInspect the host disk usage and report it.';
const closes: (()=>Promise<void>)[] = [];
afterEach(async()=>{for(const close of closes.splice(0).reverse())await close();});
async function setup() {
  const home=mkdtempSync(join(tmpdir(),'clock-local-')), access=fixtureSharing(), clock=new FakeClock(Date.parse('2026-11-13T12:00:00Z'));
  access.services.clock={types:['clock','approval'],operations:['clock.localRequest','approvals.piece-request']};
  access.services.approvals={types:['approval'],operations:['approvals.piece-request']};
  const options={home,clock,sharing:()=>access,authenticate:()=>({viewer:owner,valid:()=>true}),install(app:Parameters<NonNullable<Parameters<typeof startLoom>[0]['install']>>[0]) {
    installApprovals(app.db,app.operations,app.live,()=>access);
    const jobs=installClock(app.db,app.operations,app.live,()=>access); app.onClose(jobs.close);
  }};
  let app=await startLoom(options);
  closes.push(async()=>{await app.close();rmSync(home,{recursive:true,force:true});});
  return {get app(){return app;},access,clock,
    request(p=prompt,n='disk report',c=caller){return clockLocalFiling(app.operations).request(c,p,n);},
    async restart(){await app.close();app=await startLoom(options);},
  };
}
const value = <T>(r: import('../../core/index.js').Result): T => {if(!r.ok)throw Error(JSON.stringify(r));return r.value as T;};
it('files owning full-text card and retains exact prompt, note and caller across restart without scheduling or spending',async()=>{
  const s=await setup(), note='Ａ disk\nreport '+ 'n'.repeat(200);
  const card=value<{id:string;state:string;target:string}>(s.request(prompt,note));
  const digest=createHash('sha256').update(prompt).digest('hex');
  expect(card).toMatchObject({state:'pending',target:`art:${digest.slice(0,16)}`});
  const a=load(s.app.db).approvals[0];
  expect(a).toMatchObject({id:card.id,kind:'local-wake',digest,who:caller.who,for:'owner',conversation:caller.conversation});
  expect(a.details).toBe(localWords(prompt,note).details);
  expect(a.details!.endsWith('Inspect the host disk usage and report it.')).toBe(true);
  expect(a.details!.split('\n')[0]).toHaveLength("Agent's note (its own words): ".length+160);
  expect(filedLocal(s.app.db,card.id)).toEqual({id:card.id,target:card.target,digest,prompt,note,caller});
  expect(wakes(s.app.db)).toEqual([]);
  await s.restart();
  expect(filedLocal(s.app.db,card.id)?.note).toBe(note);
  expect(s.request(prompt,note)).toEqual({ok:true,value:card});
  expect(load(s.app.db).approvals).toHaveLength(1);
  expect(s.app.operations.call('direct',owner,'approvals.answer',{id:card.id,action:'allow'},randomUUID()).ok).toBe(true);
  expect(value<{state:string}>(s.request(prompt,note)).state).toBe('allowed');
  expect(load(s.app.db).approvals[0].state).toBe('allowed');
  expect(wakes(s.app.db)).toEqual([]);
});
it('refuses changed notes before mutating existing filing, cards or audit',async()=>{
  const s=await setup(),card=value<{id:string}>(s.request()), before=load(s.app.db),saved=filedLocal(s.app.db,card.id);
  expect(s.request(prompt,'other words')).toMatchObject({ok:false,code:'denied'});
  expect(load(s.app.db)).toEqual(before);expect(filedLocal(s.app.db,card.id)).toEqual(saved);
});
it('refuses invalid and undisplayable executable words before creating a card',async()=>{
  const s=await setup();
  for(const p of ['no marker',localMarker,localMarker+'\n'+ 'a'.repeat(271),localMarker+'\nＡ',localMarker+'\ntext\tmore',localMarker+'\ntext\u200bmore',localMarker+'\ntext\rmore',localMarker+'\nInspect\u034f disk',localMarker+'\nInspect\ufe0f disk'])
    expect(s.request(p)).toMatchObject({ok:false,code:'invalid'});
  expect(load(s.app.db).approvals).toEqual([]);
  expect(s.app.db.prepare("SELECT * FROM clock_meta WHERE key LIKE 'local-filing:%'").all()).toEqual([]);
  expect(s.request(localMarker+'\n'+ '😀'.repeat(270)).ok).toBe(true);
});
it('refuses forged callers on every public door, members, agents and other services',async()=>{
  const s=await setup(),input={caller,prompt,note:'disk report'};
  for(const door of ['http','mcp','direct'] as const)for(const viewer of [owner,{kind:'agent',id:'art'},{kind:'service',id:'approvals'},{kind:'runner',id:'runner'}] as Viewer[])
    expect(s.app.operations.call(door,viewer,'clock.localRequest',input,randomUUID()).ok).toBe(false);
  for(const door of ['http','mcp'] as const) expect(s.app.operations.call(door,{kind:'service',id:'clock'},'clock.localRequest',input,randomUUID()).ok).toBe(false);
  for(const c of [{...caller,for:'?'},{...caller,for:'pollock'},{...caller,people:['pollock']},{...caller,member:'pollock'}])
    expect(s.request(prompt,'disk report',c).ok).toBe(false);
  expect(load(s.app.db).approvals).toEqual([]);
});
it('keeps projects scoped, refuses cross-project card reuse and rechecks current agent policy',async()=>{
  const s=await setup(), c={...caller,project:'pond'},card=value<{id:string}>(s.request(prompt,'disk report',c));
  expect(load(s.app.db).approvals[0].project).toBe('pond');
  const before=load(s.app.db);
  expect(s.request(prompt,'disk report',{...caller,project:'other'}).ok).toBe(false);
  expect(load(s.app.db)).toEqual(before);expect(filedLocal(s.app.db,card.id)?.caller.project).toBe('pond');
  s.access.projects.pond.agents=[];
  expect(s.request(prompt,'disk report',c)).toMatchObject({ok:false,code:'denied'});
});
it('rolls back the owning request and audit when exact-word persistence fails',async()=>{
  const s=await setup(),before=load(s.app.db);
  s.app.db.exec("CREATE TRIGGER abort_local BEFORE INSERT ON clock_meta WHEN NEW.key LIKE 'local-filing:%' BEGIN SELECT RAISE(ABORT,'fixture'); END");
  expect(s.request().ok).toBe(false);expect(load(s.app.db)).toEqual(before);
  s.app.db.exec('DROP TRIGGER abort_local');expect(s.request().ok).toBe(true);
});
it('refuses reuse when an owning card with the short target has another full digest',async()=>{
  const s=await setup(),card=value<{id:string}>(s.request()),before=filedLocal(s.app.db,card.id);
  const row=load(s.app.db).approvals[0];
  s.app.db.prepare('UPDATE approvals_approvals SET record=? WHERE id=?').run(JSON.stringify({...row,digest:'f'.repeat(64)}),card.id);
  expect(s.request()).toMatchObject({ok:false,code:'denied'});expect(filedLocal(s.app.db,card.id)).toEqual(before);
});

it('refuses attaching saved words to a preexisting card with different displayed details',async()=>{
  const s=await setup(),card=value<{id:string}>(s.request());
  s.app.db.prepare("DELETE FROM clock_meta WHERE key=?").run(`local-filing:${card.id}`);
  const row=load(s.app.db).approvals[0];
  s.app.db.prepare('UPDATE approvals_approvals SET record=? WHERE id=?').run(JSON.stringify({...row,ask:undefined,details:'Other displayed words'}),card.id);
  const before=load(s.app.db);
  expect(s.request()).toMatchObject({ok:false,code:'denied'});expect(filedLocal(s.app.db,card.id)).toBeUndefined();expect(load(s.app.db)).toEqual(before);
});
it('requires both trusted Clock operation access and independent owning Approvals access',async()=>{
  const s=await setup();
  s.access.services.clock.operations=[]; expect(s.request()).toMatchObject({ok:false,code:'denied'});
  s.access.services.clock.operations=['clock.localRequest'];
  expect(s.request()).toMatchObject({ok:false,code:'denied'});expect(load(s.app.db).approvals).toEqual([]);
  s.access.services.clock.operations.push('approvals.piece-request');s.access.services.approvals.operations=[];
  expect(s.request().ok).toBe(true);
});
