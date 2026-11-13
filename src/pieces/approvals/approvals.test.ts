import { afterEach, describe, expect, it } from 'vitest';
import { once } from 'node:events';
import { Readable } from 'node:stream';
import { runApprovalsClient } from './client.js';
import { WebSocket } from 'ws';
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startLoom } from '../../foundation.js';
import { fixtureSharing } from '../../fixture.js';
import { FakeClock, type Viewer } from '../../core/index.js';
import { installApprovals, type ApprovalOptions } from './index.js';
import { load, persist } from './store.js';
import { importApprovals } from './importer.js';
import { approvalsRole } from './role.js';
import { type Caller } from './model.js';
import type { ApprovalApplications } from './apply.js';
const owner:Viewer={kind:'member',id:'jonathan'},agent:Viewer={kind:'agent',id:'art'},pollock:Viewer={kind:'member',id:'pollock'},other:Viewer={kind:'agent',id:'pond-bot'};
const closes:(()=>Promise<void>)[]=[],dirs:string[]=[];
const dir=()=>{const d=mkdtempSync(join(tmpdir(),'approvals-test-'));dirs.push(d);return d;};
afterEach(async()=>{for(const close of closes.splice(0).reverse())await close();for(const d of dirs.splice(0))rmSync(d,{recursive:true,force:true});});
const target=`github:acme/app#12@${'a'.repeat(40)}`;
const ask={kind:'merge',target,ask:'Merge the fix?',why:'It fixes the broken page.',if_yes:'I merge it.',if_no:'I leave it open.'};
async function setup(applications?: ApprovalApplications,resolver?:ApprovalOptions['caller']){
  const clock=new FakeClock();let identity:Caller={who:{agent:'art',where:'h-1'},for:'owner'};
  const access=fixtureSharing();
  const sharing=()=>({...access,services:{runtime:{types:['approval'],operations:['approvals.piece-request','approvals.piece-use','approvals.piece-withdraw','approvals.piece-rule','approvals.piece-tell','approvals.standing']}}});
  const app=await startLoom({home:dir(),clock,sharing,authenticate:req=>{const id=req.headers.authorization?.replace('Bearer ','');return id==='art'?{viewer:{kind:'agent',id},valid:()=>true}:id&&access.members[id]?{viewer:{kind:'member',id},valid:()=>!!access.members[id]}:undefined;},install:app=>installApprovals(app.db,app.operations,app.live,sharing,{applications,localAgent:'art',projects:()=>[{slug:'pond',repos:['github:acme/app']}],caller:resolver??(v=>v.kind==='agent'?{...identity,who:{...identity.who,agent:v.id}}:undefined)})});closes.push(app.close);let seq=0;
  const call=(op:string,input:Record<string,unknown>={},viewer:Viewer=agent,id=`op-${++seq}`)=>app.operations.call('direct',viewer,`approvals.${op}`,input,id);
  const value=(op:string,input:Record<string,unknown>={},viewer:Viewer=agent)=>{const r=call(op,input,viewer);expect(r.ok,JSON.stringify(r)).toBe(true);return r.ok?r.value as any:undefined;};
  return {...app,clock,call,value,access,identity:(next:Partial<Caller>)=>{identity={...identity,...next};},role:approvalsRole(app.operations,'runtime')};
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
    const a=await setup({runtime:{apply:()=>({ok:true,value:null})}});a.identity({project:'pond'});const card=a.value('request',{...ask,kind:'grant',target:'tasks:mark'});expect(a.value('check',{id:card.id},pollock)).toMatchObject({state:'pending'});expect(a.call('answer',{id:card.id,action:'allow'},pollock)).toMatchObject({code:'denied'});a.value('answer',{id:card.id,action:'allow'},owner);expect(a.call('use',{id:card.id,kind:'grant',target:'tasks:mark'})).toMatchObject({code:'denied'});expect(load(a.db).approvals.find(r=>r.id===card.id)).toMatchObject({state:'used'});expect(a.role.call('use',{who:{agent:'art',where:'a body'},for:'?'},{id:card.id,kind:'grant',target:'tasks:mark'},'piece-grant')).toMatchObject({ok:false,code:'denied'});
  });

  it('leaves owner-applied cards pending when their application role is missing',async()=>{
    const a=await setup(),card=a.value('request',{...ask,kind:'grant',target:'tasks:mark'});
    expect(a.call('answer',{id:card.id,action:'allow'},owner)).toMatchObject({ok:false,code:'unavailable'});
    expect(load(a.db).approvals[0]).toMatchObject({state:'pending'});
    expect(load(a.db).audit.map(r=>r.event)).toEqual(['request']);
    expect(a.value('answer',{id:card.id,action:'deny'},owner)).toMatchObject({state:'denied'});
  });
  it('rolls back application database writes and answer on role failure, and retries once on success',async()=>{
    let app:Awaited<ReturnType<typeof setup>>, fail=true, calls=0;
    app=await setup({runtime:{apply:card=>{
      calls++;
      app.db.prepare('INSERT INTO application_effects VALUES (?)').run(card.id);
      return fail?{ok:false,code:'conflict',message:'Target changed'}:{ok:true,value:null};
    }}});
    app.db.exec('CREATE TABLE application_effects (id TEXT PRIMARY KEY)');
    const card=app.value('request',{...ask,kind:'grant',target:'tasks:mark'}),input={id:card.id,action:'allow'};
    expect(app.call('answer',input,owner,'apply')).toMatchObject({ok:false,code:'conflict'});
    expect(app.db.prepare('SELECT * FROM application_effects').all()).toEqual([]);
    expect(load(app.db).approvals[0].state).toBe('pending');
    fail=false;
    const first=app.call('answer',input,owner,'apply');
    expect(first).toMatchObject({ok:true,value:{state:'used'}});
    expect(app.call('answer',input,owner,'apply')).toEqual(first);
    expect(calls).toBe(2);
    expect(app.db.prepare('SELECT * FROM application_effects').all()).toEqual([{id:card.id}]);
    expect(load(app.db).audit.map(r=>r.event)).toEqual(['request','allow','use']);
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
describe('import validation',()=>{
  const receipt={id:'a-01234567',kind:'relay',target:'art->mark',what:'Ask Mark.',why:'He knows.',who:{agent:'art',where:'h-1'},for:'owner',minutes:60,at:'2026-11-12T00:00:00Z',state:'pending'};
  it.each([
    {state:'allowed'}, {state:'used',decided:'2026-11-12T00:00:00Z',expires:'2026-11-12T01:00:00Z'},
    {for:[]}, {people:['loren',null]}, {minutes:0}, {minutes:1e50},
    {expires:'never'}, {at:'2026-02-30T00:00:00Z'}, {agent:'mark'}, {who:{agent:'art',where:7}},
  ])('rejects malformed receipts without importing any rows: %j',async change=>{
    const a=await setup(),source=dir();
    writeFileSync(join(source,'approvals.json'),JSON.stringify({v:1,approvals:{[receipt.id]:{...receipt,...change}}}));
    expect(()=>importApprovals(a.db,source,a.clock.now())).toThrow('Invalid source approval');
    expect(load(a.db).approvals).toEqual([]);
    expect(a.db.prepare('SELECT * FROM approvals_meta').all()).toEqual([]);
  });
  it('requires approvals, accepts optional files absent and refuses nonempty destination',async()=>{
    const a=await setup(),source=dir();
    expect(()=>importApprovals(a.db,source,a.clock.now())).toThrow('required');
    writeFileSync(join(source,'approvals.json'),JSON.stringify({v:1,approvals:{[receipt.id]:receipt}}));
    a.value('request',ask);
    expect(()=>importApprovals(a.db,source,a.clock.now())).toThrow('destination must be empty');
    const b=await setup();expect(importApprovals(b.db,source,b.clock.now())).toMatchObject({approvals:1,rules:0,audit:0});
  });
  it('rejects duplicate rules and malformed standing jobs',async()=>{
    const a=await setup(),source=dir();
    writeFileSync(join(source,'approvals.json'),JSON.stringify({v:1,approvals:{}}));
    const rule={kind:'merge',scope:'github:acme/*',tier:'do',by:'jonathan',at:receipt.at};
    writeFileSync(join(source,'rules.json'),JSON.stringify({v:1,rules:[rule,rule]}));
    expect(()=>importApprovals(a.db,source,a.clock.now())).toThrow('Duplicate source rule');
    writeFileSync(join(source,'rules.json'),JSON.stringify({v:1,rules:[],standing:[{id:'s-01234567',kind:'local-wake',agent:'art',target:`art:${'a'.repeat(16)}`,digest:'a'.repeat(64),who:{agent:'art',where:'h-1'},for:'owner',uses:0}]}));
    expect(()=>importApprovals(a.db,source,a.clock.now())).toThrow('Invalid standing job');
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

describe('live receipt deadlines and access',()=>{
  it('publishes exact expiry, drops week-old history, retains pending and refreshes access',async()=>{
    const a=await setup();a.identity({project:'pond'});
    const card=a.value('request',{...ask,minutes:1});
    const pending=a.value('request',{...ask,target:target.replace('#12@','#13@')});
    const ws=new WebSocket(a.url.replace('http:','ws:')+'/live',{headers:{authorization:'Bearer pollock'}});
    const messages:unknown[]=[],waiting:((message:unknown)=>void)[]=[];
    ws.on('message',raw=>{const message=JSON.parse(raw.toString()),receive=waiting.shift();if(receive)receive(message);else messages.push(message);});
    const next=()=>messages.length?Promise.resolve(messages.shift()):new Promise<unknown>(resolve=>waiting.push(resolve));
    closes.push(async()=>{ws.terminate();});await once(ws,'open');
    ws.send(JSON.stringify({kind:'subscribe',type:'approval'}));
    expect(await next()).toMatchObject({kind:'set',records:[{id:card.id},{id:pending.id}]});
    a.value('answer',{id:card.id,action:'allow'},owner);
    expect(await next()).toMatchObject({kind:'put',record:{id:card.id,state:'allowed'}});
    a.clock.advance(60_000);
    expect(await next()).toMatchObject({kind:'put',record:{id:card.id,state:'expired'}});
    a.clock.advance(7*86400_000-60_000);
    expect(await next()).toMatchObject({kind:'del',id:card.id});
    a.access.projects.pond.members=[];a.live.refreshAccess();
    expect(await next()).toMatchObject({kind:'set',records:[]});
    a.access.projects.pond.members=['pollock'];a.live.refreshAccess();
    expect(await next()).toMatchObject({kind:'set',records:[{id:pending.id,state:'pending'}]});
  });
});

describe('standing local jobs',()=>{
  const digest='a'.repeat(64),localTarget=`art:${'a'.repeat(16)}`;
  const caller:Caller={who:{agent:'art',where:'h-1'},for:'owner'};
  const file=(a:Awaited<ReturnType<typeof setup>>,who=caller,extra:Record<string,unknown>={})=>{
    const r=a.role.call('request',who,{...ask,kind:'local-wake',target:localTarget,digest,...extra},`file-${Math.random()}`);
    expect(r.ok,JSON.stringify(r)).toBe(true);return r.ok?r.value as {id:string}:undefined as never;
  };
  it('only the clock matches standing jobs, counts each use and keeps the whole digest and caller binding',async()=>{
    const a=await setup(),card=file(a);
    expect(a.call('every-time',{id:card.id})).toMatchObject({code:'denied'});
    a.value('every-time',{id:card.id},owner);
    expect(a.value('check',{id:card.id})).toEqual({state:'allowed'});
    const input={kind:'local-wake',target:localTarget,digest};
    expect(a.call('standing',input)).toMatchObject({ok:false});
    const first=a.role.standing(caller,input,'standing-1');
    expect(first).toMatchObject({ok:true,value:{uses:1}});
    expect(a.role.standing(caller,input,'standing-1')).toEqual(first);
    expect(a.role.standing({...caller,who:{agent:'art',where:'h-99'}},input,'standing-2')).toMatchObject({ok:true,value:{uses:2}});
    for(const [who,data] of [
      [{...caller,for:'loren'},input],
      [{...caller,for:'?'},input],
      [{...caller,who:{agent:'art',where:'h-9 (chat)'}},input],
      [caller,{...input,digest:'a'.repeat(16)+'b'.repeat(48)}],
      [{...caller,who:{agent:'mark',where:'h-1'}},input],
    ] as [Caller,Record<string,unknown>][])expect(a.role.standing(who,data,`miss-${Math.random()}`)).toMatchObject({ok:false,code:'not-found'});
    expect(load(a.db).standing[0].uses).toBe(2);
    expect(load(a.db).audit.filter(r=>r.event==='standing-use')).toHaveLength(2);
  });
  it('turning off a job makes the clock ask again, preserving history and preventing another agent reading its state',async()=>{
    const a=await setup(),card=file(a),job=a.value('every-time',{id:card.id},owner);
    expect(a.role.standing(caller,{check:job.id},'check-on')).toMatchObject({ok:true,value:{state:'on'}});
    expect(a.role.standing({...caller,who:{agent:'mark',where:'h-1'}},{check:job.id},'check-other')).toMatchObject({ok:true,value:{state:'none'}});
    expect(a.call('standing-off',{id:job.id},pollock)).toMatchObject({code:'denied'});
    a.value('standing-off',{id:job.id},owner);
    expect(a.role.standing(caller,{check:job.id},'check-off')).toMatchObject({ok:true,value:{state:'off'}});
    expect(a.role.standing(caller,{kind:'local-wake',target:localTarget,digest},'off')).toMatchObject({ok:false,code:'not-found'});
    expect(load(a.db).standing[0]).toMatchObject({off:{by:'jonathan'}});
  });
  it.each([
    {who:{agent:'mark',where:'h-1'},for:'owner'},
    {who:{agent:'art',where:'h-1 (chat)'},for:'?'},
    {who:{agent:'art',where:'h-1'},for:'loren'},
    {who:{agent:'art',where:'h-1'},for:'?',people:['eve']},
  ] satisfies Caller[])('refuses every-time for another local agent, a service or named people: %j',async who=>{
    const a=await setup(),card=file(a,who,{target:`${who.who.agent}:${digest.slice(0,16)}`});
    expect(a.call('every-time',{id:card.id},owner)).toMatchObject({ok:false,code:'invalid'});
    expect(load(a.db).standing).toEqual([]);
  });
  it('permits an exact unknown principal with nobody named, never widens it to owner',async()=>{
    const a=await setup(),unknown={...caller,for:'?'},card=file(a,unknown);
    a.value('every-time',{id:card.id},owner);
    const input={kind:'local-wake',target:localTarget,digest};
    expect(a.role.standing(unknown,input,'unknown')).toMatchObject({ok:true});
    expect(a.role.standing(caller,input,'owner')).toMatchObject({ok:false});
    expect(a.role.standing({...unknown,people:['eve']},input,'eve')).toMatchObject({ok:false});
  });
});

describe('frozen independent old CLI oracle',()=>{
  const oracle=JSON.parse(readFileSync(new URL('./fixtures/cli-oracle.json',import.meta.url),'utf8'));
  it.each(oracle.cases)('$label',async test=>{
    const a=await setup();
    persist(a.db,{approvals:test.approvals,rules:test.rules,grants:[],standing:[],audit:[],notices:[]},a.clock.now());
    const result=a.value('command',{argv:test.argv},test.member?owner:agent);
    // Request and owner grant allocate a new random id; the oracle freezes that allocation.
    if(['request','grant'].includes(test.argv[0]))result.stdout=result.stdout.replace(/a-[0-9a-f]{8}/g,'a-01234567');
    expect(result).toEqual(test.expected);
  });
});

describe('owner application routing and denial retention',()=>{
  const caller:Caller={who:{agent:'art',where:'h-1'},for:'owner'};
  it.each([
    ['grant','tasks:mark','runtime','Access to Tasks.'],
    ['vouch-wake','art:w-000001,w-000002','clock','w-000001 fires at ten\nw-000002 fires at eleven'],
    ['principal-reset','art:cv-0123456789ab','runtime','The conversation cv-0123456789ab.'],
    ['box-write-off','art:box-one@1762718400','runtime','The box box-one was last heard yesterday.'],
  ])('applies %s through %s exactly once at Allow',async(kind,target,route,details)=>{
    const calls:string[]=[];
    const a=await setup({runtime:{apply:card=>{calls.push('runtime:'+card.kind);return {ok:true,value:null};}},clock:{apply:card=>{calls.push('clock:'+card.kind);return {ok:true,value:null};}}});
    const response=kind==='grant'?a.call('request',{...ask,kind,target,details}):a.role.call('request',caller,{...ask,kind,target,details},'piece-file');
    expect(response).toMatchObject({ok:true});if(!response.ok)return;
    const card=response.value as {id:string};
    expect(a.call('answer',{id:card.id,action:'allow'},pollock)).toMatchObject({ok:false});
    expect(a.value('answer',{id:card.id,action:'allow'},owner)).toMatchObject({state:'used'});
    expect(calls).toEqual([route+':'+kind]);
    expect(a.call('answer',{id:card.id,action:'allow'},owner)).toMatchObject({ok:false});
    expect(calls).toHaveLength(1);
  });
  it('refuses overlapping vouches while pending and keeps a no beyond live history',async()=>{
    const a=await setup();
    const file=(target:string,id:string)=>a.role.call('request',caller,{...ask,kind:'vouch-wake',target,details:target.split(':')[1].split(',').map(id=>`${id} fires at ten`).join('\n')},id);
    const first=file('art:w-000001,w-000002','first');expect(first.ok).toBe(true);if(!first.ok)return;
    expect(file('art:w-000002,w-000003','overlap')).toMatchObject({ok:false,code:'denied'});
    expect(file('art:w-000001,w-000002','same')).toMatchObject({ok:true,value:{id:(first.value as any).id}});
    a.value('answer',{id:(first.value as any).id,action:'deny'},owner);
    a.clock.advance(30*86400_000);
    expect(file('art:w-000002','after')).toMatchObject({ok:false,code:'denied'});
    expect(file('art:w-000003','unrelated')).toMatchObject({ok:true});
  });
  it('pregrants do not answer conversation cards, and a deny revokes unspent yes without closing that thread',async()=>{
    const a=await setup(),conversation='cv-0123456789ab';a.identity({conversation});
    const card=a.value('request',{...ask,conversation});
    const yes=a.value('grant',{kind:'merge',target,for:'art'},owner);
    expect(yes.id).not.toBe(card.id);
    expect(load(a.db).approvals.find(r=>r.id===card.id)?.state).toBe('pending');
    a.value('grant',{kind:'merge',target,for:'art',deny:true},owner);
    expect(load(a.db).approvals.find(r=>r.id===card.id)?.state).toBe('pending');
    expect(a.call('use',{id:yes.id,kind:'merge',target})).toMatchObject({ok:false,code:'denied'});
  });
  it('Always grants only that person, using project scope without changing the owner rules',async()=>{
    const a=await setup();a.identity({for:'loren'});const card=a.value('request',ask);
    expect(a.value('always',{id:card.id},owner)).toMatchObject({scope:'project:pond',person:'loren',tier:'do'});
    expect(load(a.db).rules).toEqual([]);
    expect(a.value('rule',{kind:'merge',targets:[target]})[target]).toMatchObject({tier:'do',for:'loren'});
    a.identity({for:'owner'});
    expect(a.value('rule',{kind:'merge',targets:[target]})[target]).toMatchObject({tier:'ask',for:'owner'});
  });
});

describe('compatibility client and HTTP door',()=>{
  it('retries the same argv and operation id after losing a committed response',async()=>{
    const a=await setup(),token=join(dir(),'token');writeFileSync(token,'art');
    let stdout='',stderr='',drop=true;const bodies:string[]=[];
    const request:typeof fetch=async(url,options)=>{
      bodies.push(String(options?.body));const response=await fetch(url,options);
      if(drop){drop=false;await response.text();throw Error('lost response');}
      return response;
    };
    const exit=await runApprovalsClient(['request','--kind','merge','--target',target,'--ask','Merge the fix?','--why','It fixes the page.','--if-yes','I merge it.','--if-no','I leave it open.'],{
      env:{LOOM_URL:a.url,LOOM_TOKEN_FILE:token},stdin:Readable.from([]),stdinIsTTY:false,
      stdout:s=>{stdout+=s;},stderr:s=>{stderr+=s;},
    },{request,retry:async()=>{}});
    expect(exit).toBe(0);expect(stderr).toBe('');expect(stdout).toMatch(/^a-[0-9a-f]{8}: asked the owner/);
    expect(bodies).toHaveLength(2);expect(bodies[0]).toBe(bodies[1]);
    expect(load(a.db).approvals).toHaveLength(1);expect(load(a.db).audit).toHaveLength(1);
  });
  it('rejects anonymous writes and direct service operations through HTTP',async()=>{
    const a=await setup();
    expect((await fetch(a.url+'/api/approvals/request',{method:'POST',body:'{}'})).status).toBe(401);
    const response=await fetch(a.url+'/api/approvals/piece-request',{method:'POST',headers:{authorization:'Bearer art','content-type':'application/json'},body:JSON.stringify({id:'forged',input:{...ask,caller:{who:{agent:'art',where:'h-1'},for:'owner'}}})});
    expect(await response.json()).toMatchObject({ok:false,code:'denied'});
    expect(load(a.db).approvals).toEqual([]);
  });
});

describe('refused spend audit survives rejection',()=>{
  it('keeps the upstream request/allow/refusals/use sequence without changing the receipt',async()=>{
    const a=await setup(),card=a.value('request',ask);
    expect(a.call('use',{id:card.id,kind:'merge',target})).toMatchObject({ok:false});
    a.value('answer',{id:card.id,action:'allow'},owner);
    expect(a.call('use',{id:card.id,kind:'merge',target:target+'b'})).toMatchObject({ok:false});
    expect(a.call('use',{id:card.id,kind:'relay',target})).toMatchObject({ok:false});
    expect(a.call('use',{id:card.id,kind:'merge',target},other)).toMatchObject({ok:false});
    a.identity({who:{agent:'art',where:'h-9 (chat)'}});
    expect(a.call('use',{id:card.id,kind:'merge',target})).toMatchObject({ok:false});
    expect(load(a.db).approvals[0].state).toBe('allowed');
    a.identity({who:{agent:'art',where:'h-99'}});a.value('use',{id:card.id,kind:'merge',target});
    expect(a.call('use',{id:card.id,kind:'merge',target})).toMatchObject({ok:false});
    expect(load(a.db).audit.map(r=>r.event)).toEqual(['request','allow','refused-use','refused-use','refused-use','refused-use','use']);
  });
});

describe('cold review authorization regressions',()=>{
  it.each(['answer','open','use','withdraw','always','every-time','check'])('rejects non-string IDs before authorizing %s',async verb=>{
    const a=await setup(),card=a.value('request',ask);
    for(const id of [[card.id],{toString:card.id},null,0])
      expect(a.call(verb,{id,action:'allow',kind:'merge',target})).toMatchObject({ok:false,code:'invalid'});
    expect(load(a.db).approvals[0].state).toBe('pending');
  });
  it('checks request creation scope regardless of extra id input',async()=>{
    const a=await setup();a.identity({project:'missing-project'});
    for(const id of ['a-00000000',['a-00000000'],undefined])
      expect(a.call('request',{...ask,id})).toMatchObject({ok:false,code:'denied'});
    expect(load(a.db).approvals).toEqual([]);
  });
  it('Always and Every time cannot act on another member private card, including for a household owner',async()=>{
    const a=await setup(),card=a.value('request',ask),state=load(a.db);
    state.approvals[0].member='pollock';persist(a.db,state,a.clock.now());
    expect(a.call('always',{id:card.id},owner)).toMatchObject({ok:false,code:'denied'});
    expect(a.call('every-time',{id:card.id},owner)).toMatchObject({ok:false,code:'denied'});
    expect(a.call('answer',{id:card.id,action:'allow'},owner)).toMatchObject({ok:false,code:'denied'});
    expect(load(a.db).rules).toEqual([]);expect(load(a.db).standing).toEqual([]);
  });
  it.each([
    ()=>({who:{agent:'mark',where:'h-1'},for:'owner'}),
    ()=>Promise.resolve({who:{agent:'art',where:'h-1'},for:'owner'}),
    ()=>({who:{agent:'art',where:'h-1'},for:'?',people:['eve',null]}),
  ])('rejects malformed or asynchronous trusted callers',async resolver=>{
    const a=await setup(undefined,resolver as ApprovalOptions['caller']);
    expect(a.call('request',ask)).toMatchObject({ok:false,code:'denied'});
    expect(load(a.db).approvals).toEqual([]);
  });
  it('ignores body assertions of agent, owner principal and service context',async()=>{
    const a=await setup();a.identity({for:'?',who:{agent:'art',where:'h-1 (chat)'},people:['eve']});
    const card=a.value('request',{...ask,for:'owner',who:{agent:'mark',where:'h-9'},caller:{who:{agent:'mark',where:'h-9'},for:'owner'},principal:'fabricated',agent:'mark'});
    expect(card).toMatchObject({for:'?',people:['eve'],who:{agent:'art',where:'h-1 (chat)'},agent:'art'});
  });
  it('rejects an asynchronous application role and rolls back its synchronous writes',async()=>{
    let a:Awaited<ReturnType<typeof setup>>;
    a=await setup({runtime:{apply:((card:any)=>{a.db.prepare('INSERT INTO async_effect VALUES (?)').run(card.id);return Promise.resolve({ok:true,value:null});}) as any}});
    a.db.exec('CREATE TABLE async_effect (id TEXT)');
    const card=a.value('request',{...ask,kind:'grant',target:'tasks:mark'});
    expect(a.call('answer',{id:card.id,action:'allow'},owner)).toMatchObject({ok:false,code:'unavailable'});
    expect(a.db.prepare('SELECT * FROM async_effect').all()).toEqual([]);
    expect(load(a.db).approvals[0].state).toBe('pending');
    expect(load(a.db).audit.map(r=>r.event)).toEqual(['request']);
  });
});

describe('service notices',()=>{
  it('keeps the same person on notices filed directly by a piece',async()=>{
    const a=await setup();a.value('set-rule',{kind:'merge',scope:'github:acme/*',tier:'tell',person:'loren'},owner);
    expect(a.role.call('tell',{who:{agent:'art',where:'h-1'},for:'loren'},{kind:'merge',target,what:'Fixed the page.'},'notice')).toMatchObject({ok:true,value:{for:'loren'}});
    expect(load(a.db).notices).toHaveLength(1);
  });
});

describe('private decision lookups',()=>{
  it('does not disclose private receipts through rule or request deduplication',async()=>{
    const a=await setup(),card=a.value('request',ask),state=load(a.db);
    state.approvals[0].member='pollock';persist(a.db,state,a.clock.now());
    expect(a.value('rule',{kind:'merge',targets:[target]})[target]).not.toHaveProperty('approval');
    expect(a.role.call('rule',{who:{agent:'art',where:'h-1'},for:'owner'},{kind:'merge',targets:[target]},'private-rule')).toMatchObject({ok:true,value:{[target]:{tier:'ask'}}});
    const duplicate=a.value('request',ask);expect(duplicate.id).not.toBe(card.id);
    expect(load(a.db).approvals).toHaveLength(2);
    expect(a.role.call('withdraw',{who:{agent:'art',where:'h-1'},for:'owner'},{id:card.id},'private-withdraw')).toMatchObject({ok:false,code:'denied'});
  });
  it('owner pregrants leave private pending and allowed cards untouched',async()=>{
    const a=await setup(),card=a.value('request',ask),state=load(a.db);
    state.approvals[0].member='pollock';persist(a.db,state,a.clock.now());
    const yes=a.value('grant',{kind:'merge',target,for:'art'},owner);
    expect(yes.id).not.toBe(card.id);
    a.value('answer',{id:card.id,action:'allow'},pollock);
    a.value('grant',{kind:'merge',target,for:'art',deny:true},owner);
    expect(load(a.db).approvals.find(r=>r.id===card.id)?.state).toBe('allowed');
    expect(a.role.call('use',{who:{agent:'art',where:'h-1'},for:'owner'},{id:card.id,kind:'merge',target},'private-use')).toMatchObject({ok:false,code:'denied'});
  });
});

describe('host answer authority',()=>{
  it('a sharing member sees a host question but only the household owner answers, and only the service spends',async()=>{
    const a=await setup();a.identity({project:'pond'});
    const target='restart:loom-http.service',card=a.value('request',{...ask,kind:'host',target});
    expect(a.value('check',{id:card.id},pollock)).toEqual({state:'pending'});
    expect(a.call('answer',{id:card.id,action:'allow'},pollock)).toMatchObject({ok:false,code:'denied'});
    a.value('answer',{id:card.id,action:'allow'},owner);
    expect(a.call('use',{id:card.id,kind:'host',target})).toMatchObject({ok:false,code:'denied'});
    expect(a.role.call('use',{who:{agent:'art',where:'h-1'},for:'owner'},{id:card.id,kind:'host',target},'host-spend')).toMatchObject({ok:true,value:{state:'used'}});
  });
  it('an existing allowed pregrant satisfies an identical owner-principal request without rewriting its provenance',async()=>{
    const a=await setup(),yes=a.value('grant',{kind:'merge',target,for:'art'},owner),conversation='cv-0123456789ab';
    a.identity({conversation});
    const card=a.value('request',{...ask,conversation});
    expect(card).toMatchObject({id:yes.id,state:'allowed'});expect(card).not.toHaveProperty('conversation');
    expect(load(a.db).approvals).toHaveLength(1);
  });
});
