import { afterEach, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startLoom } from '../../foundation.js';
import { FakeClock } from '../../core/index.js';
import { installBridges } from './index.js';
import { bridgeFileStore, BRIDGE_FILE_RETENTION, type BridgeFileSavePermit } from './file-store.js';
import { bridgeFilesOnce } from './file-once.js';
const closes:(()=>Promise<void>)[]=[],roots:string[]=[];
afterEach(async()=>{for(const close of closes.splice(0))await close();for(const root of roots.splice(0))rmSync(root,{recursive:true,force:true});});
async function fixture(home=mkdtempSync(join(tmpdir(),'files-once-')),at=1000){
 if(!roots.includes(home))roots.push(home);
 const clock=new FakeClock(at),app=await startLoom({home,clock,install:a=>installBridges(a,()=>({members:{},projects:{},services:{}}))});
 let closed=false;const close=async()=>{if(!closed){closed=true;await app.close();}};closes.push(close);
 const facts={authenticated:true,setup:true,credential:true,delivered:true,policy:true};
 // Explicit fake owning Runtime permit; no production issuer exists.
 const permit:BridgeFileSavePermit={agent:'art',venue:'slack-art',workspace:'T1',channel:'D1',delivery:'one',deliveredAt:1000,
 files:[{id:'FABC',name:'photo.jpg',size:4,url:'https://files.slack.com/x'}],current:()=>Object.values(facts).every(Boolean)};
 const store=bridgeFileStore(app.db,()=>clock.now());
 const fetched:Buffer[]=[];let calls=0;
 const fetch=async(p:BridgeFileSavePermit)=>{calls++;return p.files.map(f=>{const bytes=Buffer.from('data');fetched.push(bytes);return {id:f.id,name:f.name,bytes};});};
 const run=(p=permit,transport=fetch)=>bridgeFilesOnce(app.db,()=>clock.now(),p,transport);
 const read=(p=permit,file='FABC')=>store.read({...p,file,job:'job',conversation:'conversation'});
 return {app,home,clock,permit,store,run,read,facts,fetch,fetched,calls:()=>calls,close};
}
it('fetches once across concurrent deliveries, separate callers and restart, with private associations',async()=>{
 const f=await fixture();const second={...f.permit,delivery:'two'};
 await Promise.all([f.run(),f.run(),f.run(second)]);expect(f.calls()).toBe(1);
 expect(f.read().bytes.toString()).toBe('data');expect(f.read(second).bytes.toString()).toBe('data');
 expect(f.fetched.every(b=>b.equals(Buffer.alloc(4)))).toBe(true);
 await f.close();const g=await fixture(f.home,2000);await g.run({...g.permit,delivery:'three'});
 expect(g.calls()).toBe(0);expect(g.read({...g.permit,delivery:'three'}).bytes.toString()).toBe('data');
});
it('fetches only missing IDs and atomically associates the whole original batch',async()=>{
 const f=await fixture();await f.run();const p={...f.permit,delivery:'two',files:[...f.permit.files,{...f.permit.files[0],id:'FDEF'}]};
 let selected:string[]=[];await f.run(p,async input=>{selected=input.files.map(x=>x.id);return f.fetch(input);});
 expect(selected).toEqual(['FDEF']);expect(f.read(p,'FABC').bytes.toString()).toBe('data');expect(f.read(p,'FDEF').bytes.toString()).toBe('data');
});
for(const fact of ['authenticated','setup','credential','delivered','policy'] as const)it(`rechecks queued ${fact} authority even with cached bytes`,async()=>{
 const f=await fixture();let release!:()=>void;const gate=new Promise<void>(r=>{release=r;});
 const first=f.run(f.permit,async p=>{await gate;return f.fetch(p);});
 const p={...f.permit,delivery:'two',current:()=>f.facts[fact]};const second=f.run(p);f.facts[fact]=false;
 release();await expect(first).rejects.toThrow('Bridge file unavailable');await expect(second).rejects.toThrow('Bridge file unavailable');
 expect(f.app.db.prepare('SELECT count(*) n FROM bridges_file_deliveries').get()).toEqual({n:0});
});
it('does not inherit a concurrent caller proof and recovers after a failed fetch',async()=>{
 const f=await fixture();await expect(f.run(f.permit,async()=>{throw Error('private URL');})).rejects.toThrow(/^Bridge file unavailable$/);
 await f.run();expect(f.calls()).toBe(1);
 await expect(f.run({...f.permit,current:()=>false})).rejects.toThrow();expect(f.calls()).toBe(1);
});
it('refuses manifest changes, unsafe cache name changes and corrupt cached bytes before IO',async()=>{
 const f=await fixture();await f.run();
 await expect(f.run({...f.permit,files:[{...f.permit.files[0],url:'https://files.slack.com/changed'}]})).rejects.toThrow();
 await expect(f.run({...f.permit,delivery:'two',files:[{...f.permit.files[0],name:'other'}]})).rejects.toThrow();
 f.app.db.prepare('UPDATE bridges_files SET bytes=?').run(Buffer.from('evil'));
 await expect(f.run({...f.permit,delivery:'two'})).rejects.toThrow();expect(f.calls()).toBe(1);
});
it('does not refresh original age or revive expired deliveries, but fetches a new delivery after expiry',async()=>{
 const f=await fixture();await f.run();f.clock.advance(BRIDGE_FILE_RETENTION);
 await expect(f.run()).rejects.toThrow();expect(f.calls()).toBe(1);
 const p={...f.permit,delivery:'fresh',deliveredAt:f.clock.now()};await f.run(p);expect(f.calls()).toBe(2);expect(f.read(p).bytes.toString()).toBe('data');
});
it('erases fetched buffers and rolls back associations on post-fetch revocation',async()=>{
 const f=await fixture();await expect(f.run(f.permit,async p=>{const batch=await f.fetch(p);f.facts.policy=false;return batch;})).rejects.toThrow();
 expect(f.fetched[0]).toEqual(Buffer.alloc(4));expect(f.app.db.prepare('SELECT count(*) n FROM bridges_files').get()).toEqual({n:0});
});
it('uses the real bounded Slack fetch and does no second credential or HTTP read',async()=>{
 const {slackFiles}=await import('./slack-files.js');const f=await fixture();let secrets=0,http=0;
 const transport=(p:BridgeFileSavePermit)=>slackFiles({id:'slack-art',agent:'art',platform:'slack',workspace:'T1',bot:'U1',enabled:true,tokenSecret:'token'},p,
 {withValue:async(_id,use)=>{secrets++;return use('fixture-token');}},()=>true,async()=>{http++;return new Response('data');}).fetch();
 await f.run(f.permit,transport);await f.run({...f.permit,delivery:'two'},transport);
 expect([secrets,http]).toEqual([1,1]);expect(f.read().bytes.toString()).toBe('data');
});
for(const field of ['agent','venue','workspace','channel','delivery','deliveredAt','files'] as const)it(`refuses queued mutation of captured ${field}`,async()=>{
 const f=await fixture();let release!:()=>void;const gate=new Promise<void>(r=>{release=r;});
 const first=f.run(f.permit,async p=>{await gate;return f.fetch(p);});
 const p={...f.permit,delivery:'two'};const second=f.run(p);
 if(field==='files')p.files=[{...p.files[0],id:'FDEF'}];else if(field==='deliveredAt')p.deliveredAt++;else p[field]='changed';
 release();await first;await expect(second).rejects.toThrow();expect(f.calls()).toBe(1);
});
it('keeps scopes independent and rolls back a failed save before a successful retry',async()=>{
 const f=await fixture();await Promise.all([f.run(),f.run({...f.permit,channel:'D2'})]);expect(f.calls()).toBe(2);
 f.app.db.exec("CREATE TRIGGER fail_save BEFORE INSERT ON bridges_file_sources BEGIN SELECT RAISE(ABORT,'private words'); END");
 const p={...f.permit,delivery:'two'};await expect(f.run(p)).rejects.toThrow(/^Bridge file unavailable$/);
 expect(f.app.db.prepare('SELECT count(*) n FROM bridges_file_deliveries').get()).toEqual({n:2});
 f.app.db.exec('DROP TRIGGER fail_save');await f.run(p);expect(f.calls()).toBe(2);expect(f.read(p).bytes.toString()).toBe('data');
});
it('rejects extra fetched results before committing any bytes',async()=>{
 const f=await fixture();await expect(f.run(f.permit,async p=>[...await f.fetch(p),...await f.fetch(p)])).rejects.toThrow();
 expect(f.app.db.prepare('SELECT count(*) n FROM bridges_files').get()).toEqual({n:0});expect(f.fetched.every(b=>b.equals(Buffer.alloc(4)))).toBe(true);
});
