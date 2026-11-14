import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { startLoom } from '../../foundation.js';
import { fixture } from '../../fixture.js';
import { FakeClock, operation, type Viewer, type RecordType } from '../../core/index.js';
import { approvalAskId } from '../attention/role.js';
import { installApprovals } from './index.js';
import { SharingDatabase } from '../../core/household/sharing.js';
import { load, persist } from './store.js';
import type { Approval } from './model.js';
const dirs:string[]=[],closes:Array<()=>Promise<void>>=[];
afterEach(async()=>{for(const close of closes.splice(0))await close();for(const d of dirs.splice(0))rmSync(d,{recursive:true,force:true});});
const owner:Viewer={kind:'member',id:'jonathan'}, pollock:Viewer={kind:'member',id:'pollock'};
const card=(extra:Partial<Approval>={}):Approval=>({id:'a-12345678',kind:'merge',target:`github:acme/app#12@${'a'.repeat(40)}`,what:'Review a fix',why:'It repairs the page',ask:'Merge the fix?',if_yes:'I merge it',if_no:'I hold it',who:{agent:'art',where:'h-1'},for:'owner',minutes:30,at:'2026-11-13T00:00:00Z',state:'pending',...extra});
async function setup(home?:string, denied=false) {
  if(!home){home=mkdtempSync(join(tmpdir(),'approval-attention-'));dirs.push(home);fixture(home);}
  const types=new Map<string,RecordType>();
  let coreDb:import('../../core/index.js').Db;
  const access=()=>{const held=new SharingDatabase(coreDb,home!).sharing();return denied?{...held,services:{...held.services,approvals:{...held.services.approvals,operations:[]}}}:held;};
  const app=await startLoom({home,next:true,staging:true,clock:new FakeClock(1_800_000_000_000),stdout:()=>{},sharing:access,install:a=>{
    coreDb=a.db;
    const register=a.live.register.bind(a.live);a.live.register=t=>{types.set(t.name,t);register(t);};
    installApprovals(a.db,a.operations,a.live,access,{caller:v=>({who:{agent:v.id,where:'h-test'},for:'owner',project:'pond'})});
  }});closes.push(app.close);
  const call=(name:string,input:unknown,viewer=owner,id=randomUUID())=>app.operations.call('direct',viewer,name,input,id);
  app.operations.register(operation({name:'fixture.approval',write:true,input:z.unknown(),output:z.null(),may:()=>true,run(ctx,raw){
    const state=load(ctx.db),a=raw as Approval;state.approvals=state.approvals.filter(x=>x.id!==a.id);state.approvals.push(a);
    for(const c of persist(ctx.db,state,ctx.now))ctx.changed(c.type,c.id);return null;
  }}));
  const reconcile=()=>call('approvals.reconcileAttention',{}, {kind:'service',id:'approvals'});
  const seed=(a=card())=>{expect(call('fixture.approval',a).ok).toBe(true);expect(reconcile().ok).toBe(true);return a.id;};
  const ask=(id='a-12345678',v=owner)=>call('attention.get',{id:approvalAskId(id)},v);
  return {app,call,home,types,reconcile,seed,ask};
}
it('files pending exact-scoped approval cards, preserving principal wording and owning decisions',async()=>{
  const s=await setup(),id=s.seed(card({project:'pond',for:'loren'}));
  expect(s.ask(id,pollock)).toMatchObject({ok:true,value:{source:{kind:'approval',id},sourceManaged:true,agent:'art',project:'pond',ask:'For Loren: Merge the fix?',state:'open'}});
  for(const [verb,input] of [['answer',{answer:{kind:'yes'}}],['resolve',{reason:'Bypass'}],['raise',{ask:'Bypass',source:{kind:'approval',id}}]] as const)
    expect(s.call(`attention.${verb}`,{id:approvalAskId(id),...input})).toMatchObject({ok:false,code:'denied'});
  expect(s.call('approvals.answer',{id,action:'allow'},pollock)).toMatchObject({ok:true});
  expect(s.ask(id)).toMatchObject({ok:true,value:{state:'resolved',ask:'Approval no longer needs you'}});
  expect(s.ask(id)).not.toHaveProperty('value.answer');
  expect(s.call('approvals.check',{id})).toMatchObject({ok:true,value:{state:'allowed'}});
});
it('projects private approvals as opaque metadata with exact member scope and never copies words',async()=>{
  const s=await setup(),id=s.seed(card({agent:'pond-bot',who:{agent:'pond-bot',where:'private'},project:'pond',member:'pollock',ask:'Secret question?',why:'Secret reason',if_yes:'Secret yes',if_no:'Secret no',details:'Secret details',for:'loren'}));
  expect(s.ask(id,pollock)).toMatchObject({ok:true,value:{member:'pollock',agent:'pond-bot',project:'pond',ask:'Private approval needs you',state:'open'}});
  for(const viewer of [owner,{kind:'agent',id:'pond-bot'},{kind:'service',id:'attention'}] as Viewer[]){expect(s.ask(id,viewer).ok).toBe(false);expect(s.types.get('attention.ask')!.read(approvalAskId(id),viewer)).toBeUndefined();}
  const row=s.app.db.prepare('SELECT record FROM attention_asks WHERE id=?').get(approvalAskId(id)) as {record:string};
  expect(row.record).not.toMatch(/Secret|Loren|if_yes|if_no|why|details/);
  // The owning decision still requires an authenticated member window.
  expect(s.app.operations.call('http',pollock,'approvals.answer',{id,action:'allow'},randomUUID()).ok).toBe(false);
  expect(s.ask(id,pollock)).toMatchObject({ok:true,value:{state:'open'}});
});
it('keeps request/answer filing, receipt and live publication atomic and retries a refusal safely',async()=>{
  const s=await setup(),id=s.seed(),receipt=randomUUID(),input={id,action:'allow'},events:unknown[]=[];
  s.app.live.observe(c=>{if(c.length)events.push(c);});
  s.app.db.exec("CREATE TRIGGER fail_approval_filing BEFORE UPDATE ON attention_asks BEGIN SELECT RAISE(ABORT,'fixture'); END");
  expect(s.call('approvals.answer',input,owner,receipt).ok).toBe(false);
  expect(s.call('approvals.check',{id})).toMatchObject({ok:true,value:{state:'pending'}});expect(s.ask(id)).toMatchObject({ok:true,value:{state:'open'}});expect(events).toEqual([]);
  s.app.db.exec('DROP TRIGGER fail_approval_filing');
  const result=s.call('approvals.answer',input,owner,receipt);expect(result.ok).toBe(true);expect(s.call('approvals.answer',input,owner,receipt)).toEqual(result);
  expect(events).toHaveLength(1);expect(events[0]).toEqual(expect.arrayContaining([{type:'approval',id},{type:'attention.ask',id:approvalAskId(id)}]));
});
it('reconciles existing new-side cards on startup without no-op receipts on reopen',async()=>{
  const s=await setup();s.seed();await s.app.close();closes.pop();
  // Simulates a stopped pre-filing copy; source approvals remain authoritative.
  const Database=(await import('better-sqlite3')).default, db=new Database(join(s.home,'loom.db'));db.prepare('DELETE FROM attention_asks WHERE id=?').run(approvalAskId('a-12345678'));db.close();
  const again=await setup(s.home);expect(again.ask()).toMatchObject({ok:true,value:{state:'open'}});
  const before=again.app.db.prepare('SELECT * FROM core_operations').all();
  expect(again.call('approvals.attentionPending',{}, {kind:'service',id:'approvals'})).toEqual({ok:true,value:false});
  expect(again.app.db.prepare('SELECT * FROM core_operations').all()).toEqual(before);
});
it('redacts withdrawn words and follows source scope moves even after resolution',async()=>{
  const s=await setup();s.seed(card({project:'pond'}));expect(s.ask(undefined,pollock).ok).toBe(true);
  s.seed(card({state:'denied',project:'other',agent:'pond-bot'}));
  expect(s.ask(undefined,pollock).ok).toBe(false);expect(s.ask()).toMatchObject({ok:true,value:{project:'other',agent:'pond-bot',state:'resolved',ask:'Approval no longer needs you'}});
  expect(s.ask()).not.toHaveProperty('value.why');
});
it('reserves future approval keys and refuses reconciliation over public doors or other identities',async()=>{
  const s=await setup();
  for(const name of ['approvals.attentionPending','approvals.reconcileAttention']){
    for(const v of [owner,pollock,{kind:'agent',id:'art'},{kind:'service',id:'attention'}] as Viewer[])expect(s.call(name,{},v).ok).toBe(false);
    expect(s.app.operations.call('http',{kind:'service',id:'approvals'},name,{},randomUUID()).ok).toBe(false);
  }
  for(const kind of ['approval','conversation','task','piece'])expect(s.call('attention.raise',{id:approvalAskId('a-abcdef12'),ask:'Spoof',source:{kind,id:'spoof'}}).ok).toBe(false);
  expect(s.call('attention.raise',{id:'forged-approval',ask:'Spoof',source:{kind:'approval',id:'a-abcdef12'}}).ok).toBe(false);
});

it('files actual registry requests and withdraws/denies through their owning paths',async()=>{
  const s=await setup(),agent:Viewer={kind:'agent',id:'art'};
  for(const action of ['deny','withdraw'] as const){
    const result=s.call('approvals.request',{kind:'merge',target:`github:acme/app#${action==='deny'?12:13}@${'a'.repeat(40)}`,ask:'Merge the fix?',why:'It repairs the page',if_yes:'I merge it',if_no:'I hold it'},agent);
    expect(result).toMatchObject({ok:true,value:{state:'pending'}});if(!result.ok)throw Error(result.message);const id=(result.value as Approval).id;
    expect(s.ask(id)).toMatchObject({ok:true,value:{project:'pond',agent:'art',ask:'Merge the fix?',state:'open'}});
    const decision=action==='deny'?s.call('approvals.answer',{id,action},owner):s.call('approvals.withdraw',{id},agent);
    expect(decision.ok).toBe(true);expect(s.ask(id)).toMatchObject({ok:true,value:{state:'resolved'}});
  }
});
it('holds colliding source identity and rolls an owning request back',async()=>{
  const s=await setup(),id=s.seed();
  s.app.operations.register(operation({name:'fixture.collision',write:true,input:z.object({}),output:z.null(),may:()=>true,run(ctx){
    ctx.db.prepare('UPDATE attention_asks SET record=? WHERE id=?').run(JSON.stringify({id:approvalAskId(id),source:{kind:'conversation',id:'unrelated'},ask:'Keep me',state:'open',createdAt:ctx.now,changedAt:ctx.now}),approvalAskId(id));return null;
  }}));expect(s.call('fixture.collision',{}).ok).toBe(true);
  expect(s.call('approvals.answer',{id,action:'deny'})).toMatchObject({ok:false,code:'conflict'});
  expect(s.call('approvals.check',{id})).toMatchObject({ok:true,value:{state:'pending'}});
  expect(s.ask(id)).toMatchObject({ok:true,value:{ask:'Keep me'}});
});

it('holds startup reconciliation on actual service denial, without altering owning write policy',async()=>{
  const first=await setup();first.seed(card({why:'Sensitive wording'}));await first.app.close();closes.pop();
  const warn=vi.spyOn(console,'warn').mockImplementation(()=>{});
  try{
    const s=await setup(first.home,true);
    expect(warn.mock.calls).toEqual([['Approval filing failed (denied)']]);
    expect(s.call('approvals.attentionPending',{}, {kind:'service',id:'approvals'})).toMatchObject({ok:false,code:'denied'});
    expect(s.call('approvals.reconcileAttention',{}, {kind:'service',id:'approvals'})).toMatchObject({ok:false,code:'denied'});
    expect(s.call('approvals.answer',{id:'a-12345678',action:'deny'}).ok).toBe(true);
    expect(s.ask()).toMatchObject({ok:true,value:{state:'resolved'}});
  }finally{warn.mockRestore();}
});
