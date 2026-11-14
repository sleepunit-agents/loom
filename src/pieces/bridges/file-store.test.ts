import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { exportDatabase } from '../../core/db/export.js';
import { startLoom } from '../../foundation.js';
import { FakeClock, type Sharing } from '../../core/index.js';
import { installBridges } from './index.js';
import { bridgeFileStore, BRIDGE_FILE_RETENTION, type BridgeFileReadPermit } from './file-store.js';
import { SLACK_FILE_BYTES, slackFiles, type SlackFilesPermit } from './slack-files.js';
const sharing:Sharing={members:{jonathan:{owner:true,agents:['art']}},projects:{},services:{}};
const closes:(()=>Promise<void>)[]=[],roots:string[]=[];
afterEach(async()=>{for(const close of closes.splice(0))await close();for(const root of roots.splice(0))rmSync(root,{recursive:true,force:true});});
async function fixture(home=mkdtempSync(join(tmpdir(),'bridge-files-')),at=1000){
  if(!roots.includes(home))roots.push(home);
  const clock=new FakeClock(at);
  const app=await startLoom({home,clock,install:app=>installBridges(app,()=>sharing)});
  let closed=false;const close=async()=>{if(!closed){closed=true;await app.close();}};closes.push(close);
  const store=bridgeFileStore(app.db,()=>clock.now());
  // Explicit FAKE Runtime issuer. No caller/viewer can issue these in production.
  const facts={authenticated:true,setup:true,credential:true,delivered:true,job:true,policy:true};
  const current=()=>Object.values(facts).every(Boolean);
  const permit:SlackFilesPermit={agent:'art',venue:'slack-art',workspace:'T1',channel:'D1',delivery:'delivery-1',
    files:[{id:'FABC',name:'../photo 1.jpg',size:4,url:'https://files.slack.com/x'}],current};
  const read:BridgeFileReadPermit={agent:permit.agent,venue:permit.venue,workspace:permit.workspace,channel:permit.channel,
    delivery:permit.delivery,job:'job-1',file:'FABC',current};
  const batch=()=>[{id:'FABC',name:'photo_1.jpg',bytes:Buffer.from('data')}];
  return {app,home,clock,store,facts,permit,read,batch,close};
}
describe('private attachment storage (fake owning Runtime permits)',()=>{
  it('migrates idempotently and retains an exact delivery across restart',async()=>{
    const f=await fixture();f.store.save(f.permit,f.batch());await f.close();
    const g=await fixture(f.home,2000);
    const got=g.store.read(g.read);expect(got.name).toBe('photo_1.jpg');expect(got.bytes.toString()).toBe('data');
    expect(got.sha256).toMatch(/^[a-f0-9]{64}$/);
    expect(g.app.db.prepare('SELECT count(*) n FROM bridges_files').get()).toEqual({n:1});
  });
  it('integrates real bounded fetch with storage without granting a public operation',async()=>{
    const f=await fixture();
    const fetched=await slackFiles({id:'slack-art',platform:'slack',workspace:'T1',agent:'art',bot:'U1',enabled:true,tokenSecret:'token'},f.permit,
      {withValue:async(_id,use)=>use('fake-token')},()=>true,async()=>new Response('data')).fetch();
    f.store.save(f.permit,fetched);fetched[0].bytes.fill(0);
    expect(f.store.read(f.read).bytes.toString()).toBe('data');
    const result=f.app.operations.call('direct',{kind:'member',id:'jonathan'},'bridges.file',{},'try');expect(result.ok).toBe(false);
  });
  it('deduplicates stored bytes, links each delivery and never refreshes original age',async()=>{
    const f=await fixture();f.store.save(f.permit,f.batch());f.clock.advance(100);
    f.store.save({...f.permit,delivery:'delivery-2'},f.batch());
    expect(f.store.read({...f.read,delivery:'delivery-2'}).bytes.toString()).toBe('data');
    expect(f.app.db.prepare('SELECT count(*) n,min(created) at FROM bridges_files').get()).toEqual({n:1,at:1000});
    expect(f.app.db.prepare('SELECT count(*) n FROM bridges_file_sources').get()).toEqual({n:2});
    f.store.save(f.permit,f.batch());expect(f.app.db.prepare('SELECT count(*) n FROM bridges_file_sources').get()).toEqual({n:2});
  });
  for(const field of ['agent','venue','workspace','channel','delivery','file'] as const)it(`refuses a different ${field} without a matching stored source`,async()=>{
    const f=await fixture();f.store.save(f.permit,f.batch());
    expect(()=>f.store.read({...f.read,[field]:'other'})).toThrow('Bridge file unavailable');
  });
  for(const fact of ['authenticated','setup','credential','delivered','job','policy'] as const)it(`independently checks fake Runtime ${fact} revocation`,async()=>{
    const f=await fixture();f.store.save(f.permit,f.batch());f.facts[fact]=false;
    expect(()=>f.store.read(f.read)).toThrow('Bridge file unavailable');expect(()=>f.store.save(f.permit,f.batch())).toThrow('Bridge file unavailable');
  });
  it('rolls back a whole batch and delivery if a later file conflicts',async()=>{
    const f=await fixture();f.store.save(f.permit,f.batch());
    const permit={...f.permit,delivery:'second',files:[{...f.permit.files[0],id:'FDEF'},...f.permit.files]};
    expect(()=>f.store.save(permit,[{id:'FDEF',name:'photo_1.jpg',bytes:Buffer.from('new')},{...f.batch()[0],bytes:Buffer.from('evil')}])).toThrow('Bridge file unavailable');
    expect(f.app.db.prepare('SELECT count(*) n FROM bridges_files').get()).toEqual({n:1});
    expect(f.app.db.prepare('SELECT count(*) n FROM bridges_file_deliveries').get()).toEqual({n:1});
    expect(f.store.read(f.read).bytes.toString()).toBe('data');
  });
  it('refuses changed delivery manifests and deduplicated content instead of overwriting',async()=>{
    const f=await fixture();f.store.save(f.permit,f.batch());
    expect(()=>f.store.save({...f.permit,files:[{...f.permit.files[0],url:'https://files.slack.com/changed'}]},f.batch())).toThrow();
    expect(()=>f.store.save({...f.permit,delivery:'new'},[{...f.batch()[0],bytes:Buffer.from('evil')}])).toThrow();
    expect(f.store.read(f.read).bytes.toString()).toBe('data');
  });
  it('expires exactly at fourteen days without a cleanup job and prunes links atomically',async()=>{
    const f=await fixture();f.store.save(f.permit,f.batch());f.clock.advance(BRIDGE_FILE_RETENTION-1);
    expect(f.store.read(f.read).bytes.toString()).toBe('data');f.clock.advance(1);
    expect(()=>f.store.read(f.read)).toThrow();f.store.prune();
    for(const table of ['bridges_files','bridges_file_deliveries','bridges_file_sources'])expect(f.app.db.prepare(`SELECT count(*) n FROM ${table}`).get()).toEqual({n:0});
  });
  it('rolls back if authority or the immutable permit changes at the final check',async()=>{
    const f=await fixture();let calls=0;
    expect(()=>f.store.save({...f.permit,current:()=>++calls===1},f.batch())).toThrow();
    expect(f.app.db.prepare('SELECT count(*) n FROM bridges_files').get()).toEqual({n:0});
    const permit={...f.permit,current:()=>{permit.delivery='changed';return true;}};
    expect(()=>f.store.save(permit,f.batch())).toThrow();
    expect(f.app.db.prepare('SELECT count(*) n FROM bridges_files').get()).toEqual({n:0});
  });
  it('rechecks body proof after reading and erases owned bytes on refusal',async()=>{
    const f=await fixture();f.store.save(f.permit,f.batch());let calls=0;
    expect(()=>f.store.read({...f.read,current:()=>++calls===1})).toThrow();expect(calls).toBe(2);
    expect(f.store.read(f.read).bytes.toString()).toBe('data');
  });
  it('excludes private attachment bytes and source associations from exports/backups',async()=>{
    const f=await fixture();f.store.save(f.permit,f.batch());
    const tables=exportDatabase(f.app.db).filter(t=>['bridges_files','bridges_file_sources','bridges_file_deliveries'].includes(t.name));
    expect(tables).toHaveLength(3);for(const table of tables)expect(table.rows).toEqual([]);
  });
  it('returns separate buffers, detects tampered bytes and reveals fixed errors only',async()=>{
    const f=await fixture();f.store.save(f.permit,f.batch());f.store.read(f.read).bytes.fill(0);
    expect(f.store.read(f.read).bytes.toString()).toBe('data');
    f.app.db.prepare('UPDATE bridges_files SET bytes=?').run(Buffer.from('tampered private words'));
    expect(()=>f.store.read(f.read)).toThrow('Bridge file unavailable');
    expect(()=>f.store.read({...f.read,current:()=>{throw Error('private words');}})).toThrow('Bridge file unavailable');
  });
  it('refuses invalid batches, unsafe names, excess bytes, mismatched ids and missing body ids',async()=>{
    const f=await fixture();
    for(const batch of [[],[{...f.batch()[0],name:'../escape'}],[{...f.batch()[0],id:'FDEF'}],[{...f.batch()[0],bytes:Buffer.alloc(SLACK_FILE_BYTES+1)}]])expect(()=>f.store.save(f.permit,batch)).toThrow();
    expect(()=>f.store.save({...f.permit,files:[f.permit.files[0],f.permit.files[0]]},[...f.batch(),...f.batch()])).toThrow();
    f.store.save(f.permit,f.batch());expect(()=>f.store.read({...f.read,job:''})).toThrow();
  });
});
