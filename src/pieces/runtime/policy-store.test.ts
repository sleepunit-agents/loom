import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { startLoom } from '../../foundation.js';
import { fixture, fixtureSharing } from '../../fixture.js';
import { FakeClock, type Viewer } from '../../core/index.js';
import { currentBodyPolicy } from './policy-store.js';
import { compileBodyRules } from './body-policy.js';
const cleanup:Array<()=>void|Promise<void>>=[];
afterEach(async()=>{for(const close of cleanup.splice(0).reverse())await close();});
const owner:Viewer={kind:'member',id:'jonathan'};
const gates={people:{jonathan:{tier:3,name:'Jonathan'},guest:{tier:1,restrict:'Never publish private files',venues:['C1']}},_notes:'retain exactly'};
const policy={deny:['Bash'],guest_deny:['Read'],briefs:{guest:'GUEST.md'},guest_places:{slack:{C1:['guest']}}};
async function setup() {
 const home=mkdtempSync(join(tmpdir(),'runtime-policy-store-'));fixture(home);cleanup.push(()=>rmSync(home,{recursive:true,force:true}));
 const clock=new FakeClock(),sharing=fixtureSharing();let app=await startLoom({home,next:true,clock,sharing:()=>sharing});cleanup.push(()=>app.close());let seq=0;
 const call=(name:string,input:unknown,viewer=owner,id=`policy-${++seq}`)=>app.operations.call('direct',viewer,`runtime.${name}`,input,id);
 const read=()=>{const result=call('readBodyPolicy',{agent:'art'});if(!result.ok)throw Error(result.message);return result.value as {revision:number;archive:string;reconciled:boolean;valid:boolean;gates:unknown;policy:unknown;proposals:unknown[];source:unknown[]};};
 const archive=(collection:string,key:string,doc:unknown)=>{const record=JSON.stringify({collection,key,doc:JSON.stringify(doc),rev:7,updated:'2026-11-12',by:'owner-original'});app.db.prepare('INSERT INTO runtime_import_documents VALUES (?,?,?)').run(collection,key,record);return {collection,key,record};};
 const configure=(revision=0,g=gates,p=policy)=>call('configureBodyPolicy',{agent:'art',revision,gates:g,policy:p});
 return {get app(){return app;},call,read,archive,configure,sharing,async restart(){await app.close();app=await startLoom({home,next:true,clock,sharing:()=>sharing});}};
}
it('fails closed until complete owner configuration exists, then compiles the exact persisted restrictions after restart',async()=>{
 const f=await setup();expect(()=>currentBodyPolicy(f.app.db,'art')).toThrow('reconciliation');
 expect(f.read()).toMatchObject({revision:0,reconciled:false,valid:false,gates:null,policy:null});
 expect(f.configure()).toEqual({ok:true,value:{agent:'art',revision:1}});await f.restart();
 const current=currentBodyPolicy(f.app.db,'art');expect(current).toMatchObject({revision:1,gates,policy});
 expect(f.read()).toMatchObject({revision:1,reconciled:true,valid:true,gates,policy,proposals:[],source:[]});
 const rules=await compileBodyRules({conversation:{agent:'art',venue:'slack',place:'C1'},messages:[{from:{kind:'person',slug:'guest'}}],platform:true,about:{kind:'channel',venue:'C1'},...current},async()=> 'Guest card');
 expect(rules.guest).toBe(true);expect(rules.deny).toEqual(['Bash','Read']);expect(rules.sections).toContainEqual({text:'Standing restriction from your owner for guest (your gates): Never publish private files\n'});
 current.gates.people={};expect(currentBodyPolicy(f.app.db,'art').gates).toEqual(gates);
});
it('all public reads, adoption and edits are household-owner only even for granted services and the named agent',async()=>{
 const f=await setup();const source=f.archive('gates','art',gates);const key=f.read().archive;
 f.sharing.services.svc={types:['runtime.body-policy'],operations:['runtime.readBodyPolicy','runtime.adoptBodyPolicy','runtime.configureBodyPolicy']};
 for(const viewer of [{kind:'agent',id:'art'},{kind:'agent',id:'mark'},{kind:'runner',id:'art'},{kind:'service',id:'svc'},{kind:'member',id:'pollock'},{kind:'member',id:'absent'}] as Viewer[])
  for(const [name,input] of [['readBodyPolicy',{agent:'art'}],['adoptBodyPolicy',{agent:'art',archive:key}],['configureBodyPolicy',{agent:'art',revision:0,gates,policy}]] as const)
   expect(f.call(name,input,viewer)).toMatchObject({ok:false,code:'denied'});
 expect(f.app.db.prepare('SELECT * FROM runtime_body_policy').all()).toEqual([]);
 expect(f.app.db.prepare('SELECT * FROM runtime_import_documents').all()).toEqual([source]);
 expect(f.call('readBodyPolicy',{agent:'absent'})).toMatchObject({ok:false,code:'not-found'});
});
it('requires adoption before replacement and retains original proposals and exact rows without manufacturing owner answers',async()=>{
 const f=await setup();const proposal={agent:'art',id:'p-original',slug:'guest',entry:{name:'Guest',tier:2},before:{tier:1},rev:7,at:123,why:'Original question',relay:{via:'slack',say:'Original words'}};
 const originals=[f.archive('gates','art',gates),f.archive('policy','art',policy),f.archive('gate-proposals','art.p-original',proposal),f.archive('gate-proposals','unexpected-key',{...proposal,id:'p-other'})];
 f.archive('gates','mark',{people:{}});f.archive('gate-proposals','mark.p-hidden',{agent:'mark',entry:{name:'private'}});
 expect(f.configure()).toMatchObject({ok:false,code:'conflict'});expect(()=>currentBodyPolicy(f.app.db,'art')).toThrow();
 const before=f.read();expect(before.proposals).toHaveLength(2);expect(before.source).toHaveLength(4);
 expect(f.call('adoptBodyPolicy',{agent:'art',archive:before.archive})).toEqual({ok:true,value:{agent:'art',revision:1}});
 expect(currentBodyPolicy(f.app.db,'art')).toMatchObject({gates,policy});
 expect(f.configure(1,{people:{jonathan:{tier:3,name:'Jonathan'}}},{}).ok).toBe(true);await f.restart();
 expect(f.read().proposals).toEqual(before.proposals);
 expect(f.read().source).toEqual(before.source);
 for(const row of originals)expect(f.app.db.prepare('SELECT * FROM runtime_import_documents WHERE collection=? AND key=?').get(row.collection,row.key)).toEqual(row);
 expect(f.app.db.prepare('SELECT * FROM runtime_owner_requests').all()).toEqual([]);
 expect(f.app.db.prepare('SELECT * FROM runtime_jobs').all()).toEqual([]);
 expect(f.app.db.prepare('SELECT * FROM core_effects').all()).toEqual([]);
});
it('a changed inactive archive fences both adoption and active access, including late original proposals',async()=>{
 const f=await setup();f.archive('gates','art',gates);f.archive('policy','art',policy);const old=f.read().archive;
 f.archive('gate-proposals','art.p-late',{agent:'art',entry:{tier:2}});
 expect(f.call('adoptBodyPolicy',{agent:'art',archive:old})).toMatchObject({ok:false,code:'conflict'});
 expect(f.call('adoptBodyPolicy',{agent:'art',archive:f.read().archive}).ok).toBe(true);
 f.archive('gate-proposals','art.p-later',{agent:'art',entry:{tier:1}});
 expect(f.read().reconciled).toBe(false);expect(()=>currentBodyPolicy(f.app.db,'art')).toThrow('reconciliation');
 expect(f.configure(1)).toMatchObject({ok:false,code:'conflict'});
 expect(f.call('adoptBodyPolicy',{agent:'art',archive:f.read().archive})).toMatchObject({ok:false,code:'conflict'});
});
it('adopts malformed or absent logical documents without defaulting them into active authority',async()=>{
 const f=await setup();f.archive('gates','art',{people:{guest:{tier:0}}});const source=f.read();
 expect(f.call('adoptBodyPolicy',{agent:'art',archive:source.archive}).ok).toBe(true);
 expect(f.read()).toMatchObject({valid:false,reconciled:true,gates:{people:{guest:{tier:0}}},policy:null});
 expect(()=>currentBodyPolicy(f.app.db,'art')).toThrow('repair');
 expect(f.configure(1)).toMatchObject({ok:true,value:{revision:2}});expect(currentBodyPolicy(f.app.db,'art')).toMatchObject({gates,policy});
});
it('validates whole paired documents and rejects stale edits, injected authority and invalid agent ids',async()=>{
 const f=await setup();
 for(const input of [
  {agent:'art',revision:0,gates:{people:{guest:{}}},policy},
  {agent:'art',revision:0,gates,policy:{deny:['Read'],unknownRule:true}},
  {agent:'art',revision:0,gates,policy:{briefs:{guest:'../private'}}},
  {agent:'art',revision:0,gates,policy,proposals:[]},
  {agent:'../art',revision:0,gates,policy},
 ])expect(f.call('configureBodyPolicy',input)).toMatchObject({ok:false,code:'invalid'});
 expect(f.configure().ok).toBe(true);const first=currentBodyPolicy(f.app.db,'art');
 expect(f.configure()).toMatchObject({ok:false,code:'conflict'});
 expect(f.configure(1,gates,{}).ok).toBe(true);expect(currentBodyPolicy(f.app.db,'art').key).not.toBe(first.key);
});
it('receipts replay acknowledgements without reverting later policy and late failure rolls back adoption and edits',async()=>{
 const f=await setup();const input={agent:'art',revision:0,gates,policy};
 expect(f.call('configureBodyPolicy',input,owner,'original').ok).toBe(true);expect(f.configure(1,gates,{}).ok).toBe(true);
 await f.restart();expect(f.call('configureBodyPolicy',input,owner,'original')).toEqual({ok:true,value:{agent:'art',revision:1}});
 expect(currentBodyPolicy(f.app.db,'art')).toMatchObject({revision:2,policy:{}});
 f.app.db.exec("CREATE TRIGGER abort_receipt BEFORE INSERT ON core_operations BEGIN SELECT RAISE(ABORT,'abort'); END");
 expect(f.configure(2)).toMatchObject({ok:false,code:'unavailable'});expect(currentBodyPolicy(f.app.db,'art')).toMatchObject({revision:2,policy:{}});
 f.archive('gates','mark',gates);const result=f.call('readBodyPolicy',{agent:'mark'});if(!result.ok)throw Error(result.message);
 expect(f.call('adoptBodyPolicy',{agent:'mark',archive:(result.value as {archive:string}).archive})).toMatchObject({ok:false,code:'unavailable'});
 expect(f.app.db.prepare('SELECT * FROM runtime_body_policy WHERE agent=?').get('mark')).toBeUndefined();
});
it('refuses oversized source words before returning a truncated owner review',async()=>{
 const f=await setup();f.archive('gate-proposals','art.p-large',{agent:'art',words:'x'.repeat(1024*1024)});
 expect(f.call('readBodyPolicy',{agent:'art'})).toMatchObject({ok:false,code:'conflict'});
 expect(f.configure()).toMatchObject({ok:false,code:'conflict'});expect(()=>currentBodyPolicy(f.app.db,'art')).toThrow('review limit');
});
