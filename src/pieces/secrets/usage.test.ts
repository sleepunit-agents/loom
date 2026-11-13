import { afterEach, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startLoom } from '../../foundation.js';
import { fixture, fixtureSharing } from '../../fixture.js';
import { FakeClock, migrate, openDb, type RecordType, type Viewer } from '../../core/index.js';
import { installSecrets } from './index.js';
import { handSecret } from './values.js';
import { installSecretServices, secretUseRole } from './service.js';
import { schema } from './schema/001.js';
const homes: string[] = [], closes: (() => Promise<void>)[] = [];
afterEach(async()=>{for(const close of closes.splice(0)) await close(); for(const home of homes.splice(0)) rmSync(home,{recursive:true,force:true}); vi.restoreAllMocks();});
async function setup() {
  const home=mkdtempSync(join(tmpdir(),'loom-secret-usage-')); homes.push(home); fixture(home);
  const clock=new FakeClock(), sharing=()=>({...fixtureSharing(),services:{changes:{types:[],operations:[]},reader:{types:['secret.use'],operations:['secrets.usage']}}});
  let usage: RecordType;
  const app=await startLoom({home,next:true,staging:true,clock,sharing,install:a=>{
    const register=a.live.register.bind(a.live);
    vi.spyOn(a.live,'register').mockImplementation(type=>{if(type.name==='secret.use') usage=type; register(type);});
    installSecrets(a.db,a.operations,a.live,sharing); installSecretServices(a.db,a.operations,sharing);
  }}); closes.push(app.close);
  let seq=0;
  const call=(name:string,input:unknown,viewer:Viewer={kind:'member',id:'jonathan'})=>app.operations.call('direct',viewer,`secrets.${name}`,input,`usage-${++seq}`);
  call('describe',{name:'github',description:'A description is not usage'});
  const holder={names:()=>[],set(){},remove(){},rotate(){},handTo:vi.fn()};
  const scope={house:'h-123',service:'bridge'};
  const hand=(action:'read'|'issue'='read')=>handSecret(app.db,app.live,holder,'art','github','SINK-MUST-NOT-BE-STORED',clock.now(),scope,action);
  const source={read:vi.fn(async()=>Buffer.from('USAGE-VALUE-SENTINEL'))};
  const role=secretUseRole(app.db,source,sharing,{kind:'service',id:'changes'},()=>clock.now(),app.live);
  const rows=()=>app.db.prepare('SELECT record FROM secrets_uses ORDER BY id').all() as {record:string}[];
  return {app,clock,call,holder,scope,hand,source,role,rows,usage:usage!};
}
it('records exact runtime read/issue scope and service acquisition; callback failure still counts as a read',async()=>{
  const {app,clock,call,scope,hand,role,rows,holder}=await setup();
  expect(call('usage',{name:'github'})).toEqual({ok:true,value:{events:[],count:0,lastUsedAt:null}});
  expect(hand()).toBe(false); expect(rows()).toEqual([]); expect(holder.handTo).not.toHaveBeenCalled();
  call('grant',{agent:'art',kind:'secret',target:'github',scope,expiresAt:clock.now()+1000});
  const firstAt=clock.now(); expect(hand('issue')).toBe(true); clock.advance(10); expect(hand()).toBe(true);
  call('grantService',{service:'changes',name:'github'}); clock.advance(10);
  await expect(role.withValue('github',async token=>{
    expect(call('usage',{name:'github'})).toMatchObject({ok:true,value:{count:3,lastUsedAt:clock.now()}});
    expect(rows().map(r=>JSON.parse(r.record)).filter(r=>r.action==='service-use')).toMatchObject([{state:'released'}]);
    throw Error(token);
  })).rejects.toMatchObject({message:'Secret use failed'});
  const result=call('usage',{name:'github'});
  expect(result).toMatchObject({ok:true,value:{count:3,lastUsedAt:clock.now(),events:[
    {action:'issue',by:{kind:'agent',id:'art'},house:'h-123',service:'bridge',at:firstAt,state:'released'},
    {action:'read',by:{kind:'agent',id:'art'},house:'h-123',service:'bridge',at:firstAt+10,state:'released'},
    {action:'service-use',by:{kind:'service',id:'changes'},at:clock.now(),state:'released'},
  ]}});
  for(const {record} of rows()) {
    const event=JSON.parse(record);
    expect(Object.keys(event).sort()).toEqual((event.action==='service-use'?['id','name','action','by','at','state']:['id','name','action','by','at','state','house','service']).sort());
  }
  // Retained history is independent of name removal/re-add, matching change history.
  app.db.prepare('DELETE FROM secrets_names WHERE id=?').run('github'); call('describe',{name:'github',description:''});
  expect(call('usage',{name:'github'})).toEqual(result);
  call('describe',{name:'second',description:''}); call('grantService',{service:'changes',name:'second'}); clock.advance(10);
  await role.withValue('second',async()=>true);
  expect(call('usage',{name:'github'})).toEqual(result);
  expect(call('usage',{name:'second'})).toMatchObject({ok:true,value:{count:1,lastUsedAt:clock.now(),events:[{name:'second'}]}});
  const tables=app.db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as {name:string}[];
  const dump=JSON.stringify(tables.map(t=>app.db.prepare(`SELECT * FROM "${t.name.replaceAll('"','""')}"`).all()));
  expect(dump).not.toContain('USAGE-VALUE-SENTINEL'); expect(dump).not.toContain('SINK-MUST-NOT-BE-STORED');
});
it('does not count failed handoffs, failed transport or transport-time revocation as confirmed use',async()=>{
  const {call,clock,scope,hand,holder,source,role,rows}=await setup();
  call('grant',{agent:'art',kind:'secret',target:'github',scope,expiresAt:clock.now()+1000});
  holder.handTo.mockImplementationOnce(()=>{throw Error('USAGE-VALUE-SENTINEL');}); expect(hand()).toBe(false);
  call('grantService',{service:'changes',name:'github'});
  source.read.mockRejectedValueOnce(Error('USAGE-VALUE-SENTINEL'));
  await expect(role.withValue('github',async()=>true)).rejects.toMatchObject({code:'unavailable'});
  const bytes=Buffer.from('USAGE-VALUE-SENTINEL'), use=vi.fn(async()=>true);
  source.read.mockImplementationOnce(async()=>{call('revokeService',{service:'changes',name:'github'}); return bytes;});
  await expect(role.withValue('github',use)).rejects.toMatchObject({code:'unavailable'});
  expect(use).not.toHaveBeenCalled(); expect(bytes.every(v=>v===0)).toBe(true);
  expect(rows().map(r=>JSON.parse(r.record).state)).toEqual(['failed','failed','failed']);
  expect(call('usage',{name:'github'})).toMatchObject({ok:true,value:{count:0,lastUsedAt:null}});
});
it('fails closed before delivery when the attempt cannot persist, and refuses an enclosing transaction',async()=>{
  const {app,call,clock,scope,hand,holder,source,role,rows}=await setup();
  call('grant',{agent:'art',kind:'secret',target:'github',scope,expiresAt:clock.now()+1000}); call('grantService',{service:'changes',name:'github'});
  app.db.exec("CREATE TRIGGER fail_usage BEFORE INSERT ON secrets_uses BEGIN SELECT RAISE(ABORT,'test'); END");
  expect(hand()).toBe(false); await expect(role.withValue('github',async()=>true)).rejects.toMatchObject({code:'unavailable'});
  expect(holder.handTo).not.toHaveBeenCalled(); expect(source.read).not.toHaveBeenCalled(); expect(rows()).toEqual([]);
  app.db.exec('DROP TRIGGER fail_usage');
  app.db.transaction(()=>{expect(hand()).toBe(false);})(); expect(rows()).toEqual([]);
  app.db.exec("CREATE TRIGGER fail_finish BEFORE UPDATE ON secrets_uses BEGIN SELECT RAISE(ABORT,'test'); END");
  expect(hand()).toBe(false); expect(holder.handTo).toHaveBeenCalledOnce();
  expect(rows().map(r=>JSON.parse(r.record).state)).toEqual(['started']);
  expect(call('usage',{name:'github'})).toMatchObject({ok:true,value:{count:0,lastUsedAt:null}});
});
it('publishes value-free changes after commit and confines both operation and Live to the household',async()=>{
  const {app,call,role,usage}=await setup(); call('grantService',{service:'changes',name:'github'});
  const notifications: {inTransaction:boolean;changes:unknown}[]=[];
  const changed=app.live.changed.bind(app.live);
  vi.spyOn(app.live,'changed').mockImplementation(changes=>{notifications.push({inTransaction:app.db.inTransaction,changes});changed(changes);});
  await role.withValue('github',async()=>true);
  expect(notifications).toHaveLength(2); expect(notifications.every(n=>!n.inTransaction)).toBe(true);
  const id=usage.ids(undefined)[0];
  for(const viewer of [{kind:'member',id:'pollock'},{kind:'agent',id:'art'},{kind:'service',id:'reader'},{kind:'runner',id:'one'}] as Viewer[]){
    expect(call('usage',{name:'github'},viewer)).toMatchObject({ok:false,code:'denied'}); expect(usage.read(id,viewer)).toBeUndefined();
  }
  expect(usage.read(id,{kind:'member',id:'jonathan'})).toMatchObject({name:'github',state:'released'});
  expect(call('usage',{name:'../github'})).toMatchObject({ok:false,code:'invalid'});
  expect(call('usage',{name:'missing'})).toEqual({ok:true,value:{events:[],count:0,lastUsedAt:null}});
});
it('adds usage to a populated prior schema without changing existing records; repeated migration is harmless',()=>{
  const home=mkdtempSync(join(tmpdir(),'loom-usage-upgrade-')); homes.push(home); const lease=openDb(home);
  try {
    migrate(lease.db,'secrets',schema.slice(0,3));
    lease.db.prepare('INSERT INTO secrets_changes VALUES (?,?)').run('change','{"name":"github","action":"removed"}');
    lease.db.prepare('INSERT INTO secrets_meta VALUES (?,?)').run('policy','{"default":"never"}');
    const before=lease.db.prepare('SELECT * FROM secrets_changes').all(); migrate(lease.db,'secrets',schema); migrate(lease.db,'secrets',schema);
    expect(lease.db.prepare('SELECT * FROM secrets_changes').all()).toEqual(before);
    expect(lease.db.prepare('SELECT * FROM secrets_meta').all()).toEqual([{key:'policy',value:'{"default":"never"}'}]);
    expect(lease.db.prepare('SELECT * FROM secrets_uses').all()).toEqual([]);
  } finally {lease.close();}
});

it('refuses service callback and erases bytes when release auditing fails before delivery',async()=>{
  const {app,call,source,role,rows}=await setup(); call('grantService',{service:'changes',name:'github'});
  const bytes=Buffer.from('USAGE-VALUE-SENTINEL'), use=vi.fn(async()=>true);
  source.read.mockResolvedValueOnce(bytes);
  app.db.exec("CREATE TRIGGER fail_service_finish BEFORE UPDATE ON secrets_uses BEGIN SELECT RAISE(ABORT,'USAGE-VALUE-SENTINEL'); END");
  await expect(role.withValue('github',use)).rejects.toMatchObject({code:'unavailable',message:'Secret use failed'});
  expect(source.read).toHaveBeenCalledOnce(); expect(use).not.toHaveBeenCalled(); expect(bytes.every(v=>v===0)).toBe(true);
  expect(rows().map(r=>JSON.parse(r.record).state)).toEqual(['started']);
  expect(call('usage',{name:'github'})).toMatchObject({ok:true,value:{count:0,lastUsedAt:null}});
});
