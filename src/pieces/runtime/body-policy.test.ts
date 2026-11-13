import { afterEach, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startLoom } from '../../foundation.js';
import { FakeClock } from '../../core/index.js';
import { fixtureSharing } from '../../fixture.js';
import { bodyPolicy, compileBodyRules, sameBodyRules, type BodyPolicyInput } from './body-policy.js';
const gates={people:{jonathan:{name:'Jonathan',tier:3},phil:{name:'Phil',tier:2,grant:'Fleet setup',restrict:'No onterris pushes'},
  kim:{name:'Kim',tier:1,grant:'NEVER TELL',venues:['555']},anton:{tier:2,restrict:['No spending','No publishing']}},agents:{mark:{name:'Mark',kind:'agent'}}};
const policy={deny:['mcp__handoff'],guest_deny:['mcp__mail'],briefs:{guest:'house/guest.md',peer:'house/peer.md',venues:{slack:'house/slack.md'},notes:{work:'house/work.md'},tiers:{'2':'house/trusted.md'}}};
const card=async(s:string)=>`CARD ${s}`;
function input(extra:Partial<BodyPolicyInput>={}):BodyPolicyInput{return {
 conversation:{agent:'art',venue:'slack',place:'dm:phil'},messages:[{from:{kind:'person',slug:'phil'}}],
 gates:structuredClone(gates),policy:structuredClone(policy),about:{kind:'dm',venue:'D1',members:['phil']},platform:true,
 principal:{for:'phil'},...extra};}
const text=(r:Awaited<ReturnType<typeof compileBodyRules>>)=>r.sections.map(p=>'text' in p?p.text:p.file).join('');
it('compiles gates identity, personal authority, restrictions, cards and repo references',async()=>{
 const r=await compileBodyRules(input({about:{kind:'channel',venue:'D1',members:['phil'],notes:['work']}}),card);
 expect(r).toMatchObject({guest:false,deny:['mcp__handoff'],grantFor:'phil',members:['phil'],persons:['phil']});
 for(const s of ['phil: tier 2','Your owner (tier 3): Jonathan (jonathan)','Standing restriction','No onterris pushes','Standing authority','Fleet setup','CARD phil','house/slack.md','house/work.md','house/trusted.md'])expect(text(r)).toContain(s);
 expect(text(r)).not.toContain('No spending');
});
it('a guest member sets the room floor, tools and cards even when the owner writes',async()=>{
 const r=await compileBodyRules(input({messages:[{from:{kind:'person',slug:'jonathan'}}],about:{kind:'group',members:['jonathan','phil','kim']}}),card);
 expect(r).toMatchObject({guest:true,deny:['mcp__handoff','mcp__mail'],readers:['kim'],grantFor:null});
 for(const s of ['lowest tier present governs the room: tier 1','No onterris pushes','THIS IS A GUEST VENUE','house/guest.md','CARD kim'])expect(text(r)).toContain(s);
 for(const s of ['CARD phil','CARD jonathan','Fleet setup','NEVER TELL'])expect(text(r)).not.toContain(s);
});
it.each(['sender','gate-venue','owner-place','adapter','narrowing'])('narrows every guest source: %s',async kind=>{
 const m=input({about:{kind:'channel',venue:'X'}});
 if(kind==='sender')m.messages=[{from:{kind:'person',slug:'kim'}}];
 if(kind==='gate-venue')m.about={kind:'channel',venue:'555'};
 if(kind==='owner-place')m.policy={...policy,guest_places:{slack:{'dm:phil':['kim']}}};
 if(kind==='adapter')m.about={kind:'channel',guest:true,readers:['kim']};
 if(kind==='narrowing')m.narrowing={guest:true,deny:['mcp__extra'],readers:['kim']};
 const r=await compileBodyRules(m,card);expect(r.guest).toBe(true);expect(r.readers).toEqual(['kim']);expect(r.deny).toContain('mcp__mail');if(kind==='narrowing')expect(r.deny).toContain('mcp__extra');expect(r.grantFor).toBeNull();
});
it.each(['deny','floor','readers','card'])('fails closed for missing guest %s',async kind=>{
 const m=input({about:{kind:'channel',guest:true,readers:['kim']}});
 if(kind==='deny')m.policy={...policy,guest_deny:[]};
 if(kind==='floor')m.policy={...policy,briefs:{}};
 if(kind==='readers')m.about={kind:'channel',guest:true};
 await expect(compileBodyRules(m,kind==='card'?async()=>null:card)).rejects.toThrow();
});
it.each([[],Array.from({length:13},(_,n)=>`p${n}`),['phil','Bad Slug'],['phil','phil'],'phil',['phil',7],['phil','unknown']])('never truncates or drops an invalid roster: %j',async members=>{
 await expect(compileBodyRules(input({about:{kind:'group',members}}),card)).rejects.toThrow();
});
it('refuses a person outside the complete roster',async()=>{
 await expect(compileBodyRules(input({messages:[{from:{kind:'person',slug:'anton'}}]}),card)).rejects.toThrow('absent');
});
it('ignores adapter authority, cards, tier and brief lines and source-supplied tiers',async()=>{
 const m=input({about:{kind:'group',members:['anton'],tier:3,grant:'ADAPTER GRANT',restrict:'ADAPTER RESTRICTION',cards:{anton:'ADAPTER CARD'},brief:['ADAPTER BRIEF']},
  messages:[{from:{kind:'person',slug:'anton'},...{tier:3,owner:true}}]});
 const r=await compileBodyRules(m,card);
 expect(text(r)).toContain('anton: tier 2');expect(text(r)).toContain('No spending; No publishing');
 expect(text(r)).not.toContain('ADAPTER');expect(r.grantFor).toBeNull();
});
it.each(['relay','owner-spoke','unknown','different-principal','principal-owner','group','guest','owner-tier'])('never carries standing authority through %s',async kind=>{
 const m=input();
 if(kind==='relay')m.messages.push({from:{kind:'agent',id:'mark'}});
 if(kind==='owner-spoke')m.ownerSpoke=true;
 if(kind==='unknown')m.principal={for:'phil',unknown:true};
 if(kind==='different-principal')m.principal={for:'anton'};
 if(kind==='principal-owner')m.principal={for:'phil',owner:true};
 if(kind==='group')m.about={kind:'group',members:['phil','anton']};
 if(kind==='guest')m.about={kind:'group',members:['phil'],guest:true,readers:['kim']};
 if(kind==='owner-tier'){m.about={kind:'group',members:['jonathan']};m.messages=[{from:{kind:'person',slug:'jonathan'}}];m.principal={for:'jonathan'};}
 const r=await compileBodyRules(m,card);expect(r.grantFor).toBeNull();expect(text(r)).not.toContain('Standing authority');
});
it('allows unreadable cards only in a non-guest room',async()=>{
 const r=await compileBodyRules(input(),async()=>{throw Error('offline');});expect(r.guest).toBe(false);expect(text(r)).not.toContain('CARD');
});
it('requires gates and description on a platform, with a bounded core-owner exception',async()=>{
 await expect(compileBodyRules(input({gates:null}),card)).rejects.toThrow('gates');
 await expect(compileBodyRules(input({about:null}),card)).rejects.toThrow('description');
 const r=await compileBodyRules(input({platform:false,core:true,gates:null,about:{brief:['Core line']},messages:[{from:{kind:'person',slug:'jonathan'},owner:true}]}),card);
 expect(text(r)).toContain('Your owner (tier 3): jonathan');expect(text(r)).toContain('Core line');
 await expect(compileBodyRules(input({platform:false,core:true,gates:null}),card)).rejects.toThrow('gates');
});
it.each([{deny:'x'},{briefs:{guest:'../x'}},{briefs:{guest:'/etc/passwd'}},{briefs:{guest:'x/./y'}},{briefs:{tiers:{'4':'x.md'}}},{more:1},{guest_places:{slack:{x:['Bad Slug']}}}])('validates the whole owner policy: %j',p=>{
 expect(bodyPolicy.safeParse(p).success).toBe(false);
});
it('keeps list and named-item owner words',async()=>{
 const g=structuredClone(gates) as Record<string,Record<string,Record<string,unknown>>>;
 g.people.phil.grant={fleet:'fleet setup',staff:''};g.people.phil.restrict=['No spending','No publishing'];
 const r=await compileBodyRules(input({gates:g}),card);expect(text(r)).toContain('fleet: fleet setup; staff');expect(text(r)).toContain('No spending; No publishing');
});
it('changes the session key for changed gates, policy, roster, files, sender or card',async()=>{
 const before=await compileBodyRules(input(),card);expect(sameBodyRules(undefined,before)).toBe(false);
 expect(sameBodyRules(before,await compileBodyRules(input(),card))).toBe(true);
 for(const m of [input({policy:{...policy,deny:['mcp__other']}}),input({policy:{...policy,briefs:{...policy.briefs,venues:{slack:'different.md'}}}}),
  input({gates:{...gates,people:{...gates.people,phil:{...gates.people.phil,grant:'Only read'}}}}),
  input({gates:{...gates,people:{...gates.people,phil:{...gates.people.phil,restrict:'No spending'}}}}),input({about:{kind:'group',members:['phil','anton']}}),
  input({messages:[{from:{kind:'agent',id:'mark'}}]})])expect(sameBodyRules(before,await compileBodyRules(m,card))).toBe(false);
 expect(sameBodyRules(before,await compileBodyRules(input(),async s=>`Changed ${s}`))).toBe(false);
});
it('snapshots all inputs before asynchronous card reads',async()=>{
 const m=input();let release!:(s:string)=>void;const waiting=new Promise<string>(r=>{release=r;});
 const pending=compileBodyRules(m,()=>waiting);
 (m.policy as typeof policy).deny.push('mcp__new');(m.gates as typeof gates).people.phil.grant='CHANGED';m.messages.push({from:{kind:'agent',id:'mark'}});
 release('CARD phil');const r=await pending;expect(r.deny).toEqual(['mcp__handoff']);expect(text(r)).toContain('Fleet setup');expect(text(r)).not.toContain('CHANGED');
});
it('rejects overfull readers rather than narrowing an incomplete audience',async()=>{
 await expect(compileBodyRules(input({about:{kind:'channel',guest:true,readers:Array.from({length:13},(_,n)=>`p${n}`)}}),card)).rejects.toThrow();
 const m=input({about:{kind:'channel',guest:true,readers:Array.from({length:12},(_,n)=>`p${n}`)},narrowing:{guest:true,readers:['another'],deny:[]}});
 await expect(compileBodyRules(m,card)).rejects.toThrow('Too many');
});
it('never treats inherited object keys as a person or policy place',async()=>{
 await expect(compileBodyRules(input({about:{kind:'group',members:['constructor']},messages:[{from:{kind:'person',slug:'constructor'}}]}),card)).rejects.toThrow('gate tier');
});
it('malformed supplied gates cannot lose restrictions on a relay',async()=>{
 await expect(compileBodyRules(input({platform:false,gates:{people:{phil:{tier:7}}},messages:[{from:{kind:'agent',id:'mark'}}]}),card)).rejects.toThrow('malformed');
});

const cleanups:Array<()=>void|Promise<void>>=[];
afterEach(async()=>{for(const f of cleanups.splice(0).reverse())await f();});
it('keeps policy compilation behind owning next-mode composition rather than a public authority operation',async()=>{
 const home=mkdtempSync(join(tmpdir(),'runtime-body-policy-'));cleanups.push(()=>rmSync(home,{recursive:true,force:true}));
 const app=await startLoom({home,next:true,clock:new FakeClock(),sharing:fixtureSharing});cleanups.push(app.close);
 const r=await compileBodyRules(input(),card);expect(r.grantFor).toBe('phil');
 for(const op of ['runtime.compileBodyRules','runtime.deliver']){
  expect(app.operations.call('http',{kind:'agent',id:'art'},op,input(),'forged-policy')).toMatchObject({ok:false,code:'not-found'});
 }
});
it.each([{}, {kind:'dm'}, {kind:'group'}, {kind:'unknown',members:['phil']}])('rejects ambiguous or missing platform audience: %j',async about=>{
 await expect(compileBodyRules(input({about}),card)).rejects.toThrow();
});
it('rejects invalid gate keys instead of omitting a guest venue',async()=>{
 await expect(compileBodyRules(input({gates:{people:{'Bad Slug':{tier:1,venues:['555']}}},about:{kind:'channel',venue:'555'}}),card)).rejects.toThrow('malformed');
});
it('compiles peer, pair and peer-conduct references from owner gates and policy',async()=>{
 const r=await compileBodyRules(input({about:{kind:'channel',peer:true,pair:'mark'}}),card);
 expect(text(r)).toContain('Mark (mark)');expect(text(r)).toContain('pair channel with mark');expect(text(r)).toContain('house/peer.md');
});
