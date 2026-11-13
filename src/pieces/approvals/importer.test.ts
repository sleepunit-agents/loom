import { afterEach, expect, it } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createFoundation } from '../../core/app.js';
import { importApprovals } from './importer.js';
import { load, persist } from './store.js';
const dirs:string[]=[],closes:(()=>void)[]=[];
const dir=()=>{const path=mkdtempSync(join(tmpdir(),'approvals-import-'));dirs.push(path);return path;};
afterEach(()=>{for(const close of closes.splice(0))close();for(const path of dirs.splice(0))rmSync(path,{recursive:true,force:true});});
const at='2026-11-12T00:00:00Z',now=Date.parse(at),who={agent:'art',where:'h-1'};
const receipt={id:'a-01234567',kind:'relay',target:'art->mark',what:'pond: Ask Mark about the pond project.',why:'He knows.',who,for:'?',people:['loren'],minutes:60,at,state:'used',decided:at,expires:'2026-11-12T01:00:00Z',used:at,by:'jonathan',conversation:'cv-0123456789ab'};
const rule={kind:'merge',scope:'github:acme/*',tier:'do',by:'jonathan',at};
const standing={id:'s-01234567',kind:'local-wake',agent:'art',target:`art:${'a'.repeat(16)}`,digest:'a'.repeat(64),who,for:'owner',from:receipt.id,what:'Run job',at,by:'jonathan',uses:2,used:at,off:{at,by:'jonathan'}};
const notice={at,agent:'art',kind:'merge',target:'github:acme/app',what:'Merged it',for:'owner'};
const audit={at,event:'use',id:receipt.id,kind:receipt.kind,target:receipt.target,who};
function setup(){
  const app=createFoundation({home:dir()});closes.push(()=>app.close());const source=dir();
  writeFileSync(join(source,'approvals.json'),JSON.stringify({v:1,approvals:{[receipt.id]:receipt},notices:[notice]}));
  writeFileSync(join(source,'rules.json'),JSON.stringify({v:1,rules:[rule],grants:[{...rule,person:'loren'}],standing:[standing]}));
  writeFileSync(join(source,'audit.jsonl'),JSON.stringify(audit)+'\n');
  return {...app,source};
}
it('preserves every authority collection and maps conversation scope without title guessing',()=>{
  const a=setup();importApprovals(a.db,a.source,now,{projects:{[receipt.conversation]:'pond'}});
  expect(load(a.db)).toEqual({approvals:[{...receipt,agent:'art',project:'pond'}],rules:[rule],grants:[{...rule,person:'loren'}],standing:[standing],notices:[notice],audit:[audit]});
  const b=setup();importApprovals(b.db,b.source,now);expect(load(b.db).approvals[0]).not.toHaveProperty('project');
});
it.each(['grants','standing'])('refuses explicit null %s before schema creation',field=>{
  const a=setup();writeFileSync(join(a.source,'rules.json'),JSON.stringify({v:1,rules:[],[field]:null}));
  expect(()=>importApprovals(a.db,a.source,now)).toThrow('Invalid rules source');
  expect(a.db.prepare("SELECT name FROM sqlite_master WHERE name LIKE 'approvals_%'").all()).toEqual([]);
});
it.each([{}, {...audit,at:'never'}, {...audit,who:[]}, {...audit,id:'oops'}])('refuses malformed audit %j atomically',row=>{
  const a=setup();writeFileSync(join(a.source,'audit.jsonl'),JSON.stringify(row));expect(()=>importApprovals(a.db,a.source,now)).toThrow('Invalid audit source');
  expect(a.db.prepare("SELECT name FROM sqlite_master WHERE name LIKE 'approvals_%'").all()).toEqual([]);
});
it('rolls schema back on interruption and content mismatch, then can retry',()=>{
  const a=setup();
  expect(()=>importApprovals(a.db,a.source,now,{interrupt:()=>{throw Error('power loss');}})).toThrow('power loss');
  expect(a.db.prepare("SELECT name FROM sqlite_master WHERE name LIKE 'approvals_%'").all()).toEqual([]);
  expect(()=>importApprovals(a.db,a.source,now,{interrupt:()=>{a.db.prepare('UPDATE approvals_approvals SET record=?').run(JSON.stringify({...receipt,what:'lost content'}));}})).toThrow('comparison failed');
  expect(a.db.prepare("SELECT name FROM sqlite_master WHERE name LIKE 'approvals_%'").all()).toEqual([]);
  expect(importApprovals(a.db,a.source,now)).toMatchObject({imported:true});
});
it('never rewrites or shrinks persisted audit history',()=>{
  const a=setup();importApprovals(a.db,a.source,now);const state=load(a.db);
  expect(()=>persist(a.db,{...state,audit:[]},now)).toThrow('cannot shrink');
  expect(()=>persist(a.db,{...state,audit:[{...audit,event:'allow'}]},now)).toThrow('cannot change');
  expect(load(a.db).audit).toEqual([audit]);
});
it('uses only the explicit map for project scope even when source asserts a project',()=>{
  const a=setup();writeFileSync(join(a.source,'approvals.json'),JSON.stringify({v:1,approvals:{[receipt.id]:{...receipt,project:'pond'}}}));
  importApprovals(a.db,a.source,now);expect(load(a.db).approvals[0]).not.toHaveProperty('project');
  const b=setup();writeFileSync(join(b.source,'approvals.json'),JSON.stringify({v:1,approvals:{[receipt.id]:{...receipt,project:'pond'}}}));
  importApprovals(b.db,b.source,now,{projects:{[receipt.id]:'guides'}});expect(load(b.db).approvals[0].project).toBe('guides');
});
it('retires only pending legacy agent grants without spending or changing the source',()=>{
  const a=setup();
  const pending={id:receipt.id,kind:'grant',target:'tasks:mark:read/*',state:'pending',details:'Original request.',what:receipt.what,why:receipt.why,who,for:'owner',minutes:60,at};
  const allowed={...receipt,id:'a-89abcdef',kind:'grant',target:'tasks:mark',state:'allowed'};
  const secret={...receipt,id:'a-fedcba98',kind:'secret-use',target:'api-key',state:'pending'};
  const source=JSON.stringify({v:1,approvals:{[pending.id]:pending,[allowed.id]:allowed,[secret.id]:secret}});
  writeFileSync(join(a.source,'approvals.json'),source);
  expect(()=>importApprovals(a.db,a.source,now,{interrupt:()=>{throw Error('interrupted');}})).toThrow('interrupted');
  expect(importApprovals(a.db,a.source,now)).toMatchObject({imported:true});
  const state=load(a.db),retired=state.approvals.find(r=>r.id===pending.id)!;
  expect(retired).toMatchObject({...pending,state:'withdrawn',withdrawn:at,details:'Original request.\nno longer applies: agent access follows record scope'});
  expect(retired).not.toHaveProperty('used');expect(retired).not.toHaveProperty('decided');
  expect(readFileSync(join(a.source,'approvals.json'),'utf8')).toBe(source);
  expect(state.approvals.find(r=>r.id===allowed.id)).toMatchObject(allowed);
  expect(state.approvals.find(r=>r.id===secret.id)).toMatchObject(secret);
  expect(state.audit.filter(r=>r.event==='retire-agent-grant')).toEqual([expect.objectContaining({id:pending.id,reason:'no longer applies: agent access follows record scope'})]);
  expect(importApprovals(a.db,a.source,now+10000)).toMatchObject({imported:false});
  expect(load(a.db)).toEqual(state);
});

it('projects legacy grant closure identically across fresh imports at different times',()=>{
  const a=setup(),b=setup();
  const pending={id:receipt.id,kind:'grant',target:'tasks:mark',state:'pending',what:'Access Tasks.',why:'Old request.',who,for:'owner',minutes:60,at};
  for(const app of [a,b])writeFileSync(join(app.source,'approvals.json'),JSON.stringify({v:1,approvals:{[pending.id]:pending}}));
  importApprovals(a.db,a.source,now+10000);importApprovals(b.db,b.source,now+20000);
  expect(load(a.db)).toEqual(load(b.db));
  expect(load(a.db).approvals[0]).toMatchObject({state:'withdrawn',withdrawn:at});
  expect(load(a.db).audit.at(-1)).toMatchObject({event:'retire-agent-grant',at});
});
