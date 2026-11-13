import { afterEach, expect, it } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createFoundation } from '../../core/app.js';
import { importApprovals } from './importer.js';
import { load, persist } from './store.js';
const dirs:string[]=[],closes:(()=>void)[]=[];
const dir=()=>{const path=mkdtempSync(join(tmpdir(),'approvals-import-'));dirs.push(path);return path;};
afterEach(()=>{for(const close of closes.splice(0))close();for(const path of dirs.splice(0))rmSync(path,{recursive:true,force:true});});
const at='2026-11-12T00:00:00Z',now=Date.parse(at),who={agent:'art',where:'h-1'};
const receipt={id:'a-01234567',kind:'relay',target:'art->mark',what:'Ask Mark.',why:'He knows.',who,for:'?',people:['loren'],minutes:60,at,state:'used',decided:at,expires:'2026-11-12T01:00:00Z',used:at,by:'jonathan',conversation:'cv-0123456789ab'};
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
