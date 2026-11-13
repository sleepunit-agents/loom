import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startLoom } from '../../foundation.js';
import { fixtureSharing } from '../../fixture.js';
import { FakeClock, type Viewer } from '../../core/index.js';
import { installApprovals } from './index.js';
import { load } from './store.js';
import { importApprovals } from './importer.js';
import { approvalsRole } from './role.js';
import { type Caller } from './model.js';
const owner:Viewer={kind:'member',id:'jonathan'},agent:Viewer={kind:'agent',id:'art'},pollock:Viewer={kind:'member',id:'pollock'},other:Viewer={kind:'agent',id:'pond-bot'};
const closes:(()=>Promise<void>)[]=[],dirs:string[]=[];
const dir=()=>{const d=mkdtempSync(join(tmpdir(),'approvals-test-'));dirs.push(d);return d;};
afterEach(async()=>{for(const close of closes.splice(0).reverse())await close();for(const d of dirs.splice(0))rmSync(d,{recursive:true,force:true});});
const target=`github:acme/app#12@${'a'.repeat(40)}`;
const ask={kind:'merge',target,ask:'Merge the fix?',why:'It fixes the broken page.',if_yes:'I merge it.',if_no:'I leave it open.'};
async function setup(){
  const clock=new FakeClock();let identity:Caller={who:{agent:'art',where:'h-1'},for:'owner'};
  const sharing=()=>({...fixtureSharing(),services:{runtime:{types:['approval'],operations:['approvals.piece-request','approvals.piece-use','approvals.piece-withdraw','approvals.piece-rule','approvals.piece-tell','approvals.standing']}}});
  const app=await startLoom({home:dir(),clock,sharing,install:app=>installApprovals(app.db,app.operations,app.live,sharing,{localAgent:'art',projects:()=>[{slug:'pond',repos:['github:acme/app']}],caller:v=>v.kind==='agent'?{...identity,who:{...identity.who,agent:v.id}}:undefined})});closes.push(app.close);let seq=0;
  const call=(op:string,input:Record<string,unknown>={},viewer:Viewer=agent,id=`op-${++seq}`)=>app.operations.call('direct',viewer,`approvals.${op}`,input,id);
  const value=(op:string,input:Record<string,unknown>={},viewer:Viewer=agent)=>{const r=call(op,input,viewer);expect(r.ok,JSON.stringify(r)).toBe(true);return r.ok?r.value as any:undefined;};
  return {...app,clock,call,value,identity:(next:Partial<Caller>)=>{identity={...identity,...next};},role:approvalsRole(app.operations,'runtime')};
}
describe('approval receipts and central policy',()=>{
  it('allows once, exact kind and raw target, never another agent',async()=>{
    const a=await setup(),card=a.value('request',ask);
    expect(a.call('answer',{id:card.id,action:'allow'})).toMatchObject({ok:false,code:'denied'});
    a.value('answer',{id:card.id,action:'allow'},owner);
    expect(a.call('use',{id:card.id,kind:'relay',target})).toMatchObject({ok:false,code:'denied'});
    expect(a.call('use',{id:card.id,kind:'merge',target:target.toUpperCase()})).toMatchObject({ok:false,code:'denied'});
    expect(a.call('use',{id:card.id,kind:'merge',target},other)).toMatchObject({ok:false,code:'denied'});
    expect(a.value('use',{id:card.id,kind:'merge',target})).toMatchObject({state:'used'});
    expect(a.call('use',{id:card.id,kind:'merge',target})).toMatchObject({ok:false,code:'denied'});
  });
  it('retries a spend with the same operation id safely',async()=>{
    const a=await setup(),card=a.value('request',ask);a.value('answer',{id:card.id,action:'allow'},owner);
    const input={id:card.id,kind:'merge',target};const first=a.call('use',input,agent,'same');expect(a.call('use',input,agent,'same')).toEqual(first);expect(a.call('use',{...input,target:target+'x'},agent,'same')).toMatchObject({code:'conflict'});
    expect(load(a.db).audit.filter(r=>r.event==='use')).toHaveLength(1);
  });
  it('expires at the exact deadline and records the answering member',async()=>{
    const a=await setup(),card=a.value('request',{...ask,minutes:1});expect(a.value('answer',{id:card.id,action:'allow'},owner)).toMatchObject({by:'jonathan'});a.clock.advance(60_000);expect(a.value('check',{id:card.id})).toEqual({state:'expired'});expect(a.call('use',{id:card.id,kind:'merge',target})).toMatchObject({code:'denied'});
  });
  it('deduplicates across houses without allowing a different house to reword it',async()=>{
    const a=await setup(),card=a.value('request',ask);a.identity({who:{agent:'art',where:'h-2'}});expect(a.value('request',{...ask,ask:'Do something else?'})).toMatchObject({id:card.id,ask:ask.ask});
  });
  it('service houses only spend their own service, plain continuations spend across houses',async()=>{
    const a=await setup();a.identity({who:{agent:'art',where:'h-1 (discord-bodies)'}});const card=a.value('request',ask);a.value('answer',{id:card.id,action:'allow'},owner);a.identity({who:{agent:'art',where:'h-2 (slack-bodies)'}});expect(a.call('use',{id:card.id,kind:'merge',target})).toMatchObject({code:'denied'});a.identity({who:{agent:'art',where:'h-3'}});expect(a.value('use',{id:card.id,kind:'merge',target})).toMatchObject({state:'used'});
  });
  it('binds principal and the exact unknown people set',async()=>{
    const a=await setup();a.identity({for:'?',people:['loren','dan']});const card=a.value('request',ask);a.value('answer',{id:card.id,action:'allow'},owner);a.identity({people:['eve']});expect(a.call('use',{id:card.id,kind:'merge',target})).toMatchObject({code:'denied'});a.identity({people:['dan','loren']});expect(a.value('use',{id:card.id,kind:'merge',target})).toMatchObject({state:'used'});
  });
  it('a newer denial stops earlier yes across principals and keeps conversation asks pending',async()=>{
    const a=await setup(),first=a.value('request',ask);a.value('answer',{id:first.id,action:'allow'},owner);a.clock.advance(1000);a.identity({for:'loren'});const second=a.value('request',ask);a.value('answer',{id:second.id,action:'deny'},owner);a.identity({for:'owner'});expect(a.call('use',{id:first.id,kind:'merge',target})).toMatchObject({code:'denied'});
  });
  it('only repairs provenance proven by runtime and never retargets it',async()=>{
    const a=await setup(),cv='cv-0123456789ab',card=a.value('request',{...ask,conversation:cv});expect(card).not.toHaveProperty('conversation');a.identity({conversation:cv});expect(a.value('request',{...ask,conversation:cv})).toMatchObject({id:card.id,conversation:cv});a.identity({conversation:'cv-abcdef012345'});expect(a.value('request',{...ask,conversation:'cv-abcdef012345'})).toMatchObject({conversation:cv});
  });
  it('uses project sharing for records and denies owner-only answers to agent owners',async()=>{
    const a=await setup();a.identity({project:'pond'});const card=a.value('request',{...ask,kind:'grant',target:'tasks:mark'});expect(a.value('check',{id:card.id},pollock)).toMatchObject({state:'pending'});expect(a.call('answer',{id:card.id,action:'allow'},pollock)).toMatchObject({code:'denied'});a.value('answer',{id:card.id,action:'allow'},owner);expect(a.call('use',{id:card.id,kind:'grant',target:'tasks:mark'})).toMatchObject({code:'denied'});expect(a.role.call('use',{who:{agent:'art',where:'a body'},for:'?'},{id:card.id,kind:'grant',target:'tasks:mark'},'piece-grant')).toMatchObject({ok:true,value:{state:'used'}});
  });
  it('members answer shared asks but agents never answer asks for people',async()=>{
    const a=await setup();a.identity({project:'pond'});const card=a.value('request',ask);expect(a.call('answer',{id:card.id,action:'allow'},other)).toMatchObject({code:'denied'});expect(a.value('answer',{id:card.id,action:'allow'},pollock)).toMatchObject({by:'pollock'});
  });
  it.each(['invisible\u200b','double  space',' leading','trailing ','unicode-é','new\nline'])('refuses visually ambiguous targets: %s',async target=>{const a=await setup();expect(a.call('request',{...ask,kind:'relay',target})).toMatchObject({code:'invalid'});});
  it.each(['Fix t-123?','Fix round 2?','Fix local-wake?','Fix deadbeef12?','Fix S13?'])('refuses jargon in a headline: %s',async question=>{const a=await setup();expect(a.call('request',{...ask,ask:question})).toMatchObject({code:'invalid'});});
  it('withdraws pending own cards only and refuses owner-applied body spends',async()=>{
    const a=await setup(),card=a.value('request',ask);expect(a.value('withdraw',{id:card.id})).toMatchObject({state:'withdrawn'});expect(a.call('answer',{id:card.id,action:'allow'},owner)).toMatchObject({code:'denied'});expect(a.call('request',{...ask,kind:'local-wake',target:`art:${'a'.repeat(16)}`})).toMatchObject({code:'denied'});
  });
});
describe('standing merge and host rules',()=>{
  it('only owner edits rules, most specific wins then strictest',async()=>{
    const a=await setup();expect(a.call('set-rule',{kind:'merge',scope:'github:acme/*',tier:'do'})).toMatchObject({code:'denied'});a.value('set-rule',{kind:'merge',scope:'github:acme/*',tier:'do'},owner);expect(a.value('rule',{kind:'merge',targets:[target]})[target]).toMatchObject({tier:'do'});a.value('set-rule',{kind:'merge',scope:'project:pond',tier:'tell'},owner);expect(a.value('rule',{kind:'merge',targets:[target]})[target]).toMatchObject({tier:'tell'});a.value('set-rule',{kind:'merge',scope:'github:acme/app',tier:'ask'},owner);expect(a.value('rule',{kind:'merge',targets:[target]})[target]).toMatchObject({tier:'ask'});
  });
  it('rules cover only their principal, unknown always asks, grants retain owner rules',async()=>{
    const a=await setup();a.value('set-rule',{kind:'merge',scope:'github:acme/*',tier:'do'},owner);a.identity({for:'loren'});expect(a.value('rule',{kind:'merge',targets:[target]})[target]).toMatchObject({tier:'ask'});a.value('set-rule',{kind:'merge',scope:'github:acme/*',tier:'tell',person:'loren'},owner);expect(a.value('rule',{kind:'merge',targets:[target]})[target]).toMatchObject({tier:'tell'});a.identity({for:'?'});expect(a.value('rule',{kind:'merge',targets:[target]})[target]).toMatchObject({tier:'ask'});expect(load(a.db).rules).toHaveLength(1);
  });
  it('do/tell merges never file cards, tell rejects ask and stores notices',async()=>{
    const a=await setup();expect(a.call('tell',{kind:'merge',target,what:'Fixed it.'})).toMatchObject({code:'denied'});a.value('set-rule',{kind:'merge',scope:'github:acme/*',tier:'tell'},owner);expect(a.call('request',ask)).toMatchObject({code:'denied'});a.value('tell',{kind:'merge',target,what:'Fixed it.'});expect(load(a.db).approvals).toHaveLength(0);expect(load(a.db).notices).toHaveLength(1);
  });
  it('owner pre-grants answer unthreaded pending cards with one-day exact receipts',async()=>{
    const a=await setup(),card=a.value('request',ask);expect(a.call('grant',{kind:'merge',target,for:'art'})).toMatchObject({code:'denied'});expect(a.value('grant',{kind:'merge',target,for:'art'},owner)).toMatchObject({id:card.id,minutes:60,expires:'2026-11-13T00:00:00Z'});
  });
  it('host rules use verb defaults, exact and pattern priority, never a person grant',async()=>{
    const a=await setup();expect(a.value('rule',{kind:'host',targets:['restart:loom-http.service']})['restart:loom-http.service']).toMatchObject({tier:'none'});a.value('set-rule',{kind:'host',scope:'restart',tier:'ask'},owner);a.value('set-rule',{kind:'host',scope:'restart:loom-*',tier:'tell'},owner);expect(a.value('rule',{kind:'host',targets:['restart:loom-http.service']})['restart:loom-http.service']).toMatchObject({tier:'tell'});expect(a.call('set-rule',{kind:'host',scope:'restart',tier:'do',person:'loren'},owner)).toMatchObject({code:'invalid'});
  });
});
describe('transactional offline importer',()=>{
  it('imports and compares all source content, rolls back interruption and refuses a different source',async()=>{
    const a=await setup(),source=dir();const receipt={id:'a-01234567',kind:'relay',target:'art->mark',what:'Ask Mark.',why:'He knows.',who:{agent:'art',where:'h-1'},for:'owner',minutes:60,at:'2026-11-12T00:00:00Z',state:'pending'};
    writeFileSync(join(source,'approvals.json'),JSON.stringify({v:1,approvals:{[receipt.id]:receipt},notices:[]}));writeFileSync(join(source,'rules.json'),JSON.stringify({v:1,rules:[],grants:[],standing:[]}));writeFileSync(join(source,'audit.jsonl'),JSON.stringify({at:receipt.at,event:'request',id:receipt.id})+'\n');
    expect(()=>importApprovals(a.db,source,a.clock.now(),{interrupt:()=>{throw Error('power loss');}})).toThrow('power loss');expect(load(a.db).approvals).toHaveLength(0);expect(a.db.prepare('SELECT * FROM approvals_meta').all()).toHaveLength(0);
    expect(importApprovals(a.db,source,a.clock.now())).toMatchObject({imported:true,approvals:1,audit:1});expect(load(a.db).approvals[0]).toEqual({...receipt,agent:'art'});expect(importApprovals(a.db,source,a.clock.now())).toMatchObject({imported:false});writeFileSync(join(source,'audit.jsonl'),'');expect(()=>importApprovals(a.db,source,a.clock.now())).toThrow('different approvals source');
  });
});
