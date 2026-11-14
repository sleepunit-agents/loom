import {afterEach,expect,it,vi} from 'vitest';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {inspect} from 'node:util';
import {startLoom} from '../../foundation.js';
import {fixture} from '../../fixture.js';
import {FakeClock} from '../../core/clock.js';
import {SharingDatabase} from '../../core/household/sharing.js';
import type {SecretUsage} from './usage.js';

const homes:string[]=[],closes:Array<()=>Promise<void>>=[];
afterEach(async()=>{for(const close of closes.splice(0).reverse())await close();for(const home of homes.splice(0))rmSync(home,{recursive:true,force:true});vi.restoreAllMocks();});
const sentinel='CHANGES-CREDENTIAL-MUST-STAY-PRIVATE';
async function setup(staging=false) {
  const home=mkdtempSync(join(tmpdir(),'changes-secret-accounting-'));homes.push(home);fixture(home);
  const clock=new FakeClock(),buffers:Buffer[]=[];
  const source={read:vi.fn(async()=>{const bytes=Buffer.from(sentinel);buffers.push(bytes);return bytes;})};
  const request=vi.fn<typeof fetch>(async(_url,init)=>{
    expect(new Headers(init?.headers).get('authorization')).toBe(`Bearer ${sentinel}`);
    return Response.json({data:{repository:{pullRequests:{nodes:[],pageInfo:{hasNextPage:false,endCursor:null}}}}});
  });
  const app=await startLoom({home,next:true,staging,clock,changes:{source,github:{acme:'github'},request},stdout(){}});closes.push(app.close);
  const logs=[vi.spyOn(console,'log').mockImplementation(()=>{}),vi.spyOn(console,'warn').mockImplementation(()=>{}),vi.spyOn(console,'error').mockImplementation(()=>{})];
  const published:unknown[]=[];
  const changed=app.live.changed.bind(app.live);
  vi.spyOn(app.live,'changed').mockImplementation(changes=>{published.push(changes);changed(changes);});
  let seq=0;
  const call=(name:string,input:unknown={})=>app.operations.call('direct',{kind:'member',id:'jonathan'},name,input,`accounting-${++seq}`);
  app.db.transaction(()=>new SharingDatabase(app.db,home).create({slug:'accounting',name:'Accounting',repositories:['acme/app'],agents:['art'],members:[]}))();
  expect(call('secrets.describe',{name:'github',description:'Fixture forge credential'})).toMatchObject({ok:true});
  expect(call('secrets.grantService',{service:'changes',name:'github'})).toMatchObject({ok:true});
  const events=()=> (app.db.prepare('SELECT record FROM secrets_uses').all() as {record:string}[]).map(row=>JSON.parse(row.record) as SecretUsage);
  async function refresh() {
    expect(call('changes.refresh')).toMatchObject({ok:true});
    // Observe the actual job's committed completion, not a fixed microtask count.
    const finished=new Promise<void>(resolve=>{
      const stop=app.live.observe(changes=>{
        if(changes.some(c=>c.type==='change-sync')&&app.db.prepare("SELECT value FROM changes_meta WHERE key='sync-status'").get()) {stop();resolve();}
      });
    });
    clock.advance(0);await finished;
  }
  const assertPrivate=()=>{
    const tables=app.db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as {name:string}[];
    const dump=tables.map(t=>app.db.prepare(`SELECT * FROM "${t.name.replaceAll('"','""')}"`).all());
    expect(JSON.stringify([dump,published])).not.toContain(sentinel);
    // JSON.stringify(Error(...)) is {}, hiding precisely the provider diagnostic.
    expect(inspect(logs.map(log=>log.mock.calls),{depth:null})).not.toContain(sentinel);
    expect(buffers.every(bytes=>bytes.every(byte=>byte===0))).toBe(true);
  };
  return {app,clock,source,request,call,events,refresh,assertPrivate};
}
it('next Changes staging prevents both credential acquisition and usage admission on repeated refreshes',async()=>{
  const s=await setup(true);
  await s.refresh();await s.refresh();
  expect(s.source.read).not.toHaveBeenCalled();expect(s.request).not.toHaveBeenCalled();expect(s.events()).toEqual([]);
  expect(s.call('secrets.usage',{name:'github'})).toEqual({ok:true,value:{events:[],count:0,lastUsedAt:null}});s.assertPrivate();
});
it.each(['success','forge-failure'] as const)('next Changes %s counts credential delivery once per acquisition, independently of forge success',async mode=>{
  const s=await setup();
  if(mode==='forge-failure')s.request.mockRejectedValue(Error(sentinel));
  await s.refresh();
  expect(s.source.read).toHaveBeenCalledExactlyOnceWith('github');expect(s.request).toHaveBeenCalledTimes(mode==='success'?2:1);
  const events=s.events();expect(events).toHaveLength(1);
  expect(events[0]).toEqual({id:expect.stringMatching(/^use-/),name:'github',action:'service-use',by:{kind:'service',id:'changes'},at:s.clock.now(),state:'released'});
  expect(s.call('secrets.usage',{name:'github'})).toEqual({ok:true,value:{events,count:1,lastUsedAt:s.clock.now()}});
  expect(s.app.db.prepare("SELECT value FROM changes_meta WHERE key='sync-status'").get()).toEqual({value:JSON.stringify({at:s.clock.now(),error:mode==='forge-failure',held:false})});s.assertPrivate();
});
it.each(['admission','settlement'] as const)('next Changes %s audit failure prevents forge use and never records confirmed delivery',async phase=>{
  const s=await setup();
  s.app.db.exec(`CREATE TRIGGER fail_usage BEFORE ${phase==='admission'?'INSERT':'UPDATE'} ON secrets_uses BEGIN SELECT RAISE(ABORT,'${sentinel}'); END`);
  await s.refresh();
  expect(s.source.read).toHaveBeenCalledTimes(phase==='admission'?0:1);expect(s.request).not.toHaveBeenCalled();
  expect(s.events().map(e=>e.state)).toEqual(phase==='admission'?[]:['started']);
  expect(s.call('secrets.usage',{name:'github'})).toMatchObject({ok:true,value:{count:0,lastUsedAt:null}});s.assertPrivate();
});
it('next Changes rechecks a revoked service grant after holder acquisition before contacting the forge',async()=>{
  const s=await setup(),read=s.source.read.getMockImplementation()!;
  s.source.read.mockImplementationOnce(async()=>{const bytes=await read();expect(s.call('secrets.revokeService',{service:'changes',name:'github'})).toMatchObject({ok:true});return bytes;});
  await s.refresh();
  expect(s.source.read).toHaveBeenCalledOnce();expect(s.request).not.toHaveBeenCalled();expect(s.events().map(e=>e.state)).toEqual(['failed']);
  expect(s.call('secrets.usage',{name:'github'})).toMatchObject({ok:true,value:{count:0,lastUsedAt:null}});s.assertPrivate();
});
