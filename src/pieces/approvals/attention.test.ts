import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
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
import type { Ask } from '../attention/role.js';
import type { Approval } from './model.js';
const dirs:string[]=[],closes:Array<()=>Promise<void>>=[];
afterEach(async()=>{for(const close of closes.splice(0))await close();for(const d of dirs.splice(0))rmSync(d,{recursive:true,force:true});});
const owner:Viewer={kind:'member',id:'jonathan'}, pollock:Viewer={kind:'member',id:'pollock'};
const card=(extra:Partial<Approval>={}):Approval=>({id:'a-12345678',kind:'merge',target:`github:acme/app#12@${'a'.repeat(40)}`,what:'Review a fix',why:'It repairs the page',ask:'Merge the fix?',if_yes:'I merge it',if_no:'I hold it',who:{agent:'art',where:'h-1'},for:'owner',minutes:30,at:'2026-11-13T00:00:00Z',state:'pending',...extra});
async function setup(home?:string, denied=false) {
  if(!home){home=mkdtempSync(join(tmpdir(),'approval-attention-'));dirs.push(home);fixture(home);}
  const types=new Map<string,RecordType>(), startupChanges:unknown[]=[];
  let coreDb:import('../../core/index.js').Db;
  const access=()=>{const held=new SharingDatabase(coreDb,home!).sharing();return denied?{...held,services:{...held.services,approvals:{...held.services.approvals,operations:[]}}}:held;};
  const app=await startLoom({home,next:true,staging:true,clock:new FakeClock(1_800_000_000_000),stdout:()=>{},sharing:access,install:a=>{
    coreDb=a.db;
    a.live.observe(changes=>{if(changes.some(c=>c.type==='attention.ask'))startupChanges.push(changes);});
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
  return {app,call,home,types,reconcile,seed,ask,startupChanges};
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
  expect(s.ask(id,owner)).toMatchObject({ok:true,value:{member:'pollock'}});
  for(const viewer of [{kind:'agent',id:'pond-bot'},{kind:'service',id:'attention'}] as Viewer[]){expect(s.ask(id,viewer).ok).toBe(false);expect(s.types.get('attention.ask')!.read(approvalAskId(id),viewer)).toBeUndefined();}
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

it('reopens an already-current home without a write receipt or Attention publication',async()=>{
  const s=await setup();s.seed();const before=s.app.db.prepare('SELECT * FROM core_operations').all();
  await s.app.close();closes.pop();
  const again=await setup(s.home);
  expect(again.app.db.prepare('SELECT * FROM core_operations').all()).toEqual(before);
  expect(again.startupChanges).toEqual([]);expect(again.ask()).toMatchObject({ok:true,value:{state:'open'}});
});
it('moves an already-resolved projection to a later audience without restoring private or stale words',async()=>{
  const s=await setup();s.seed(card({state:'denied',project:'other'}));
  // An inactive card never filed has no projection: file while pending first.
  s.seed(card({project:'other'}));s.seed(card({state:'denied',project:'other'}));
  expect(s.ask(undefined,pollock).ok).toBe(false);
  s.seed(card({state:'denied',project:'pond',agent:'pond-bot'}));
  expect(s.ask(undefined,pollock)).toMatchObject({ok:true,value:{state:'resolved',ask:'Approval no longer needs you',project:'pond',agent:'pond-bot'}});
  s.seed(card({state:'denied',project:'other',agent:'art'}));expect(s.ask(undefined,pollock).ok).toBe(false);
});
it('uses fixed owning promises for an applied owner action despite conflicting source words',async()=>{
  const s=await setup();s.seed(card({kind:'principal-reset',target:'art:cv-0123456789ab',if_yes:'Misleading supplied promise',if_no:'Another supplied promise'}));
  expect(s.ask()).toMatchObject({ok:true,value:{ask:'Count this conversation as your work from now on?',if_yes:'I count this conversation as your work from now on.',if_no:'I leave the conversation unchanged.'}});
});

it('hides stale source projections when startup reconciliation is denied after stopped source changes',async()=>{
  const first=await setup();first.seed(card({project:'pond'}));expect(first.ask(undefined,pollock).ok).toBe(true);
  await first.app.close();closes.pop();
  const Database=(await import('better-sqlite3')).default,db=new Database(join(first.home,'loom.db'));
  db.prepare('UPDATE approvals_approvals SET record=? WHERE id=?').run(JSON.stringify(card({member:'jonathan',project:'other',ask:'New private wording',why:'New private reason'})),'a-12345678');db.close();
  const warn=vi.spyOn(console,'warn').mockImplementation(()=>{});
  try{
    const s=await setup(first.home,true);expect(warn.mock.calls).toEqual([['Approval filing failed (denied)']]);
    for(const v of [owner,pollock]){
      expect(s.ask(undefined,v).ok).toBe(false);
      expect(s.types.get('attention.ask')!.read(approvalAskId('a-12345678'),v)).toBeUndefined();
    }
    expect(s.app.db.prepare('SELECT record FROM attention_asks WHERE id=?').get(approvalAskId('a-12345678'))).not.toEqual(expect.objectContaining({record:expect.stringContaining('New private')}));
    // An authorized owning answer can reconcile even while the background service is held.
    expect((await s.app.operations.callAsync('socket',owner,'approvals.answer',{id:'a-12345678',action:'deny'},randomUUID(),true)).ok).toBe(true);
    expect(s.ask()).toMatchObject({ok:true,value:{state:'resolved',member:'jonathan',project:'other'}});
  }finally{warn.mockRestore();}
});

it('keeps private source words out of filing and read-mark retry results after a real window decision',async()=>{
  const s=await setup();s.seed(card({member:'jonathan',ask:'Private sentinel question',why:'Private sentinel reason',if_yes:'Private sentinel yes',if_no:'Private sentinel no'}));
  const mark=s.call('attention.markRead',{id:approvalAskId('a-12345678')});expect(mark.ok).toBe(true);
  const answered=await s.app.operations.callAsync('socket',owner,'approvals.answer',{id:'a-12345678',action:'deny'},'owning-private-answer',true);
  expect(answered.ok).toBe(true);expect(s.ask()).toMatchObject({ok:true,value:{state:'resolved'}});
  const receipts=s.app.db.prepare("SELECT result FROM core_operations WHERE name IN ('approvals.reconcileAttention','attention.markRead')").all();
  expect(receipts.length).toBeGreaterThan(0);expect(JSON.stringify(receipts)).not.toContain('Private sentinel');
  expect(JSON.stringify(s.app.db.prepare('SELECT record FROM attention_asks').all())).not.toContain('Private sentinel');
});
it('holds missing source filing on denied startup while the owning card remains available',async()=>{
  const first=await setup();first.seed();await first.app.close();closes.pop();
  const Database=(await import('better-sqlite3')).default,db=new Database(join(first.home,'loom.db'));db.prepare('DELETE FROM attention_asks WHERE id=?').run(approvalAskId('a-12345678'));db.close();
  const warn=vi.spyOn(console,'warn').mockImplementation(()=>{});
  try{const s=await setup(first.home,true);expect(warn.mock.calls).toEqual([['Approval filing failed (denied)']]);expect(s.ask().ok).toBe(false);expect(s.call('approvals.open',{id:'a-12345678'})).toMatchObject({ok:true,value:{open:true,mayAnswer:true}});}finally{warn.mockRestore();}
});
it('holds source conflicts at startup without replacing the unrelated record or hiding the owning approval',async()=>{
  const first=await setup();first.seed();await first.app.close();closes.pop();
  const Database=(await import('better-sqlite3')).default,db=new Database(join(first.home,'loom.db'));
  db.prepare('UPDATE attention_asks SET record=? WHERE id=?').run(JSON.stringify({id:approvalAskId('a-12345678'),source:{kind:'conversation',id:'unrelated'},ask:'Original unrelated ask',state:'open',createdAt:1,changedAt:1}),approvalAskId('a-12345678'));db.close();
  const warn=vi.spyOn(console,'warn').mockImplementation(()=>{});
  try{const s=await setup(first.home);expect(warn.mock.calls).toEqual([['Approval filing failed (conflict)']]);expect(s.ask()).toMatchObject({ok:true,value:{source:{kind:'conversation',id:'unrelated'},ask:'Original unrelated ask'}});expect(s.call('approvals.open',{id:'a-12345678'})).toMatchObject({ok:true,value:{open:true,mayAnswer:true}});}finally{warn.mockRestore();}
});

it('files each tell event atomically as fixed scoped FYI, with permanent per-member read facts',async()=>{
  const s=await setup(), agent:Viewer={kind:'agent',id:'art'};
  expect(s.call('approvals.set-rule',{kind:'merge',scope:'github:acme/*',tier:'tell'}).ok).toBe(true);
  const input={kind:'merge',target:card().target,what:'Do not copy these source words'};
  const batches:Array<Array<{type:string;id:string}>>=[];
  s.app.live.observe(changes=>{
    if(changes.some(c=>c.type==='approval.notice')) {
      batches.push(changes);
      expect(s.app.db.inTransaction).toBe(false);
      expect(s.types.get('approval.notice')!.ids().length).toBeGreaterThan(0);
      expect(changes.some(c=>c.type==='attention.ask')).toBe(true);
    }
  });
  const first=s.call('approvals.tell',input,agent,'tell-first');expect(first.ok).toBe(true);
  const entries=()=>s.app.db.prepare("SELECT record FROM attention_asks WHERE id LIKE 'approval-notice:%'").all().map(r=>JSON.parse((r as {record:string}).record) as Ask);
  const original=entries()[0];expect(original).toMatchObject({agent:'art',state:'resolved',ask:'Merge reported in Approvals',source:{kind:'piece',id:'approvals-notices'}});
  expect(JSON.stringify(original)).not.toContain(input.what);expect(JSON.stringify(original)).not.toContain(input.target);
  expect(s.call('attention.get',{id:original.id},pollock).ok).toBe(false);
  expect(s.call('attention.markRead',{id:original.id}).ok).toBe(true);
  expect(s.call('approvals.tell',input,agent,'tell-first')).toEqual(first);expect(entries()).toHaveLength(1);
  expect(s.call('approvals.tell',input,agent,'tell-second').ok).toBe(true);expect(entries()).toHaveLength(2);
  expect(entries().find(n=>n.id===original.id)).toEqual(original);
  expect(s.call('attention.answer',{id:original.id,answer:{kind:'yes'}}).ok).toBe(false);
  expect(s.call('attention.resolve',{id:original.id,reason:'replace'}).ok).toBe(false);
  expect(s.call('attention.raise',{id:'approval-notice:future',agent:'art',ask:'fake',source:{kind:'piece',id:'approvals-notices'}},agent).ok).toBe(false);
  const marks=s.types.get('attention.readMark')!;expect(marks.ids()).toHaveLength(1);
  expect(s.types.get('approval.notice')!.ids()).toHaveLength(2);expect(batches).toHaveLength(2);
  expect(s.startupChanges.length).toBeGreaterThan(0);
});

it('reconciles offline legacy notices at startup without positional identities or source wording',async()=>{
  const s=await setup();
  const n={at:'2026-11-13T00:00:00Z',agent:'art',kind:'merge',target:card().target,what:'Legacy source words'};
  const state=load(s.app.db);state.notices=[n,{...n}];s.app.db.transaction(()=>persist(s.app.db,state,s.app.operations.clock.now()))();
  const home=s.home;await s.app.close();
  const restarted=await setup(home);
  const ids=restarted.types.get('attention.ask')!.ids().filter(id=>id.startsWith('approval-notice:'));expect(ids).toHaveLength(2);expect(new Set(ids).size).toBe(2);
  expect(restarted.call('approvals.attentionPending',{}, {kind:'service',id:'approvals'})).toMatchObject({ok:true,value:false});
  const before=ids.map(id=>restarted.call('attention.get',{id}));
  const newer={...n,id:'notice-new',at:'2026-11-14T00:00:00Z'};
  const next=load(restarted.app.db);next.notices.unshift(newer);restarted.app.db.transaction(()=>persist(restarted.app.db,next,restarted.app.operations.clock.now()))();
  expect(restarted.reconcile().ok).toBe(true);expect(ids.map(id=>restarted.call('attention.get',{id}))).toEqual(before);
});

it('rolls back the owning tell when its permanent projection conflicts',async()=>{
  const s=await setup();expect(s.call('approvals.set-rule',{kind:'merge',scope:'github:acme/*',tier:'tell'}).ok).toBe(true);
  const state=load(s.app.db);state.notices=[{id:'collision',at:'2026-11-13T00:00:00Z',agent:'art',kind:'merge',target:card().target,what:'Source'}];
  s.app.db.transaction(()=>persist(s.app.db,state,s.app.operations.clock.now()))();
  const {approvalNoticeId}=await import('../attention/approval-notices.js');
  const id=approvalNoticeId('collision');s.app.db.prepare('INSERT INTO attention_asks VALUES (?,?)').run(id,JSON.stringify({id,source:{kind:'conversation',id:'other'},state:'open',ask:'Unrelated'}));
  const events:unknown[]=[];const stop=s.app.live.observe(changes=>events.push(changes));
  const prior=load(s.app.db).notices;
  expect(s.call('approvals.tell',{kind:'merge',target:card().target,what:'Will roll back'},{kind:'agent',id:'art'})).toMatchObject({ok:false,code:'conflict'});
  expect(load(s.app.db).notices).toEqual(prior);expect(events).toEqual([]);stop();
});

it('excludes private/unknown source notices and removes trimmed FYIs without reassigning read marks',async()=>{
  const s=await setup(),agent:Viewer={kind:'agent',id:'art'};
  expect(s.call('approvals.set-rule',{kind:'merge',scope:'github:acme/*',tier:'tell'}).ok).toBe(true);
  const input={kind:'merge',target:card().target,what:'Public source'};
  expect(s.call('approvals.tell',input,agent).ok).toBe(true);
  const first=s.types.get('attention.ask')!.ids().find(id=>id.startsWith('approval-notice:'))!;
  expect(s.call('attention.markRead',{id:first}).ok).toBe(true);
  const removedSourceId=load(s.app.db).notices[0].id;
  const changes:Array<Array<{type:string;id:string}>>=[];s.app.live.observe(batch=>changes.push(batch));
  for(let i=0;i<50;i++){const r=s.call('approvals.tell',input,agent);expect(r,JSON.stringify(r)).toMatchObject({ok:true});}
  expect(s.types.get('approval.notice')!.ids()).toHaveLength(50);
  expect(s.types.get('attention.ask')!.ids().filter(id=>id.startsWith('approval-notice:')&&s.types.get('attention.ask')!.read(id,owner))).toHaveLength(50);
  expect(s.call('attention.get',{id:first}).ok).toBe(false);
  expect(changes.some(batch=>batch.some(c=>c.type==='approval.notice'&&c.id===removedSourceId)&&batch.some(c=>c.type==='attention.ask'&&c.id===first))).toBe(true);
  expect(s.app.db.prepare('SELECT count(*) AS n FROM attention_read_marks').get()).toEqual({n:1});
  expect(s.call('approvals.attentionPending',{}, {kind:'service',id:'approvals'})).toMatchObject({ok:true,value:false});
  const state=load(s.app.db);state.notices.unshift({...state.notices[0],id:'private-notice',member:'pollock',what:'Private words'}, {...state.notices[0],id:'unknown-notice',kind:'secret-output',what:'One-time output'});
  s.app.db.transaction(()=>persist(s.app.db,state,s.app.operations.clock.now()))();expect(s.reconcile().ok).toBe(true);
  const rows=s.types.get('approval.notice')!.ids().map(id=>s.types.get('approval.notice')!.read(id,owner));
  expect(JSON.stringify(rows)).not.toContain('Private words');expect(JSON.stringify(rows)).not.toContain('One-time output');
  const fyis=s.types.get('attention.ask')!.ids().map(id=>s.types.get('attention.ask')!.read(id,owner));
  expect(JSON.stringify(fyis)).not.toContain('Private words');expect(JSON.stringify(fyis)).not.toContain('One-time output');
});

it('persists legacy identities before filing, retaining the second duplicate after the first is removed',async()=>{
  const s=await setup(),n={at:'2026-11-13T00:00:00Z',agent:'art',kind:'merge',target:card().target,what:'Same legacy event'};
  // Exercise an actual pre-identity database, without persist assigning ids first.
  for(let i=0;i<2;i++)s.app.db.prepare('INSERT INTO approvals_notices VALUES (?,?)').run(i,JSON.stringify(n));
  expect(s.reconcile().ok).toBe(true);
  const initial=load(s.app.db).notices;expect(initial[0].id).toBeTruthy();expect(initial[1].id).not.toBe(initial[0].id);
  const {approvalNoticeId}=await import('../attention/approval-notices.js');
  const first=approvalNoticeId(initial[0].id!),second=approvalNoticeId(initial[1].id!);
  expect(s.call('attention.markRead',{id:first}).ok).toBe(true);
  const state=load(s.app.db);state.notices.shift();state.notices.unshift({...n,id:'explicit-identical'});
  s.app.db.transaction(()=>persist(s.app.db,state,s.app.operations.clock.now()))();expect(s.reconcile().ok).toBe(true);
  expect(s.call('attention.get',{id:first}).ok).toBe(false);expect(s.call('attention.get',{id:second}).ok).toBe(true);
  const mark=s.app.db.prepare('SELECT ask FROM attention_read_marks').all();expect(mark).toEqual([{ask:first}]);
  expect(s.call('approvals.attentionPending',{}, {kind:'service',id:'approvals'})).toMatchObject({ok:true,value:false});
  const restored=load(s.app.db);restored.notices.unshift(initial[0]);
  s.app.db.transaction(()=>persist(s.app.db,restored,s.app.operations.clock.now()))();expect(s.reconcile().ok).toBe(true);
  expect(s.call('attention.get',{id:first}).ok).toBe(true);
  expect(s.app.db.prepare('SELECT ask FROM attention_read_marks').all()).toEqual(mark);
});

it('files valid owning host notices with fixed FYI text and no target or source-word copying',async()=>{
  const s=await setup();const state=load(s.app.db);
  state.notices=[{at:'2026-11-13T00:00:00Z',agent:'art',kind:'host',target:'restart:fixture.service',what:'Source-only host wording'}];
  s.app.db.transaction(()=>persist(s.app.db,state,s.app.operations.clock.now()))();expect(s.reconcile().ok).toBe(true);
  const id=s.types.get('attention.ask')!.ids().find(id=>id.startsWith('approval-notice:'))!;
  const result=s.call('attention.get',{id});expect(result).toMatchObject({ok:true,value:{ask:'Host step reported in Approvals',state:'resolved',agent:'art'}});
  expect(JSON.stringify(result)).not.toContain('fixture.service');expect(JSON.stringify(result)).not.toContain('Source-only host wording');
});

it('reserves identified legacy keys and bounds oversized stopped imports before startup projection',async()=>{
  const s=await setup(),source=mkdtempSync(join(tmpdir(),'notice-import-'));dirs.push(source);
  const n={at:'2026-11-13T00:00:00Z',agent:'art',kind:'merge',target:card().target,what:'Duplicate legacy event'};
  const {identifyNotices}=await import('./notices.js');const state=load(s.app.db);state.notices=[{...n}];identifyNotices(state);
  const identified=state.notices[0];
  const document=JSON.stringify({v:1,approvals:{},notices:[identified,{...n},...Array.from({length:58},(_,i)=>({...n,what:`Legacy event ${i}`}))]});
  const path=join(source,'approvals.json');writeFileSync(path,document);
  const {importApprovals}=await import('./importer.js');expect(importApprovals(s.app.db,source,s.app.operations.clock.now()).imported).toBe(true);
  expect(readFileSync(path,'utf8')).toBe(document);expect(load(s.app.db).notices).toHaveLength(60);
  const retained=load(s.app.db).notices;expect(retained[0].id).toBe(identified.id);expect(retained[1].id).not.toBe(identified.id);
  await s.app.close();const restarted=await setup(s.home);
  expect(restarted.call('approvals.notices',{})).toMatchObject({ok:true,value:{notices:expect.any(Array)}});
  const listed=restarted.call('approvals.notices',{});if(!listed.ok)throw Error('Notice list failed');
  expect((listed.value as {notices:unknown[]}).notices).toHaveLength(50);
  expect(restarted.types.get('approval.notice')!.ids()).toHaveLength(50);
  expect(restarted.types.get('attention.ask')!.ids().filter(id=>id.startsWith('approval-notice:'))).toHaveLength(50);
});

it('never reuses a retired legacy read identity for a later unidentified identical event',async()=>{
  const s=await setup(),n={at:'2026-11-13T00:00:00Z',agent:'art',kind:'merge',target:card().target,what:'Identical source words'};
  let state=load(s.app.db);state.notices=[{...n}];s.app.db.transaction(()=>persist(s.app.db,state,s.app.operations.clock.now()))();expect(s.reconcile().ok).toBe(true);
  const retiredId=load(s.app.db).notices[0].id!;
  const {approvalNoticeId}=await import('../attention/approval-notices.js');const oldKey=approvalNoticeId(retiredId);
  expect(s.call('attention.markRead',{id:oldKey}).ok).toBe(true);
  state=load(s.app.db);state.notices=[];s.app.db.transaction(()=>persist(s.app.db,state,s.app.operations.clock.now()))();expect(s.reconcile().ok).toBe(true);
  state=load(s.app.db);state.notices=[{...n}];s.app.db.transaction(()=>persist(s.app.db,state,s.app.operations.clock.now()))();expect(s.reconcile().ok).toBe(true);
  const newId=load(s.app.db).notices[0].id!;expect(newId).not.toBe(retiredId);expect(s.call('attention.get',{id:oldKey}).ok).toBe(false);
  expect(s.call('attention.get',{id:approvalNoticeId(newId)}).ok).toBe(true);
  expect(s.app.db.prepare('SELECT ask FROM attention_read_marks').all()).toEqual([{ask:oldKey}]);
});

it('retains actual answered verdicts in owning History after live retention, distinct from central clearing facts',async()=>{
  const s=await setup();s.seed();s.seed(card({state:'used',decided:'2026-11-13T00:01:00Z',used:'2026-11-13T00:02:00Z',by:'jonathan'}));
  s.app.db.prepare('UPDATE approvals_approvals SET changed_at=?').run(s.app.operations.clock.now()-8*86400_000);
  const type=s.types.get('approval')!,row=type.read('a-12345678',owner)!;expect(type.inScope(row,undefined,s.app.operations.clock.now())).toBe(false);
  expect(s.call('approvals.history',{})).toMatchObject({ok:true,value:{approvals:[{id:'a-12345678',state:'used',by:'jonathan',used:'2026-11-13T00:02:00Z'}]}});
  expect(s.ask()).toMatchObject({ok:true,value:{ask:'Approval no longer needs you',state:'resolved'}});
  expect(JSON.stringify(s.ask())).not.toContain('used');
});
