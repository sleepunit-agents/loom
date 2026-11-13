import { afterEach, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { startLoom } from '../../foundation.js';
import { fixture, fixtureSharing } from '../../fixture.js';
import { FakeClock, migrate, openDb, type RecordType, type Viewer } from '../../core/index.js';
import { installSecrets } from './index.js';
import { installSecretValues } from './values.js';
import { schema } from './schema/001.js';
const homes: string[] = [], closes: (() => Promise<void>)[] = [];
afterEach(async () => { for (const close of closes.splice(0)) await close(); for (const h of homes.splice(0)) rmSync(h, {recursive:true, force:true}); vi.restoreAllMocks(); });
async function setup() {
  const home = mkdtempSync(join(tmpdir(), 'loom-secret-history-')); homes.push(home); fixture(home);
  const clock = new FakeClock(), holder = {names:()=>[], set:vi.fn(), remove:vi.fn(), handTo(){}, rotate(){}};
  const sharing = () => ({...fixtureSharing(), services:{reader:{types:['secret.change'],operations:['secrets.history']}}});
  let history: RecordType;
  const app = await startLoom({home, next:true, staging:true, clock, sharing, install:a=> {
    const register=a.live.register.bind(a.live);
    vi.spyOn(a.live,'register').mockImplementation(type=>{ if(type.name==='secret.change') history=type; register(type); });
    installSecrets(a.db,a.operations,a.live,sharing);
    installSecretValues(a.db,a.operations,sharing,holder);
  }}); closes.push(app.close);
  let seq=0;
  const call=(name:string,input:unknown, viewer:Viewer={kind:'member',id:'jonathan'}, id=`history-${++seq}`)=>app.operations.call('direct',viewer,`secrets.${name}`,input,id);
  const set=(mode='add',name='api-key',writeId=randomUUID())=>({name,mode,writeId,value:'HISTORY-VALUE-SENTINEL'});
  const rows=()=>app.db.prepare('SELECT * FROM secrets_changes ORDER BY id').all();
  return {app,clock,holder,call,set,rows,history:history!};
}
it('records only value changes, keeps removal history, and deduplicates stable writes', async()=>{
  const {app,clock,holder,call,set,rows}=await setup();
  const input=set();
  expect(call('set',input)).toEqual({ok:true,value:{saved:true}});
  const first=rows(); clock.advance(100);
  expect(call('set',input).ok).toBe(true); expect(rows()).toEqual(first);
  expect(call('describe',{name:'api-key',description:'description only'}).ok).toBe(true); expect(rows()).toEqual(first);
  expect(call('set',set('replace')).ok).toBe(true); clock.advance(100);
  const remove={name:'api-key',writeId:randomUUID()};
  expect(call('remove',remove).ok).toBe(true);
  expect(call('remove',remove).ok).toBe(true);
  const history=call('history',{name:'api-key'});
  expect(history).toMatchObject({ok:true,value:[{action:'add',name:'api-key',by:'jonathan',at:clock.now()-200},{action:'replace',at:clock.now()-100},{action:'removed',at:clock.now()}]});
  expect(call('set',set()).ok).toBe(true); expect(rows()).toHaveLength(4);
  expect(call('history',{name:'other'})).toEqual({ok:true,value:[]});
  holder.set.mockImplementationOnce(()=>{throw Error('HISTORY-VALUE-SENTINEL');});
  expect(call('set',set('replace'))).toMatchObject({ok:false,code:'unavailable'}); expect(rows()).toHaveLength(4);
  const tables=app.db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as {name:string}[];
  expect(JSON.stringify(tables.map(t=>app.db.prepare(`SELECT * FROM "${t.name.replaceAll('"','""')}"`).all()))).not.toContain('HISTORY-VALUE-SENTINEL');
});
it('restricts history operations and Live reads to household owners even for explicit service type access', async()=>{
  const {call,set,history}=await setup(); expect(call('set',set()).ok).toBe(true);
  const id=history.ids(undefined)[0];
  for(const viewer of [{kind:'member',id:'pollock'},{kind:'agent',id:'art'},{kind:'service',id:'reader'},{kind:'runner',id:'one'}] as Viewer[]){
    expect(call('history',{name:'api-key'},viewer)).toMatchObject({ok:false,code:'denied'});
    expect(history.read(id,viewer)).toBeUndefined();
  }
  expect(history.read(id,{kind:'member',id:'jonathan'})).toMatchObject({action:'add',name:'api-key'});
  expect(call('history',{name:'../key'})).toMatchObject({ok:false,code:'invalid'});
});
it.each(['set','remove'])('rolls history and notifications back on final %s receipt failure, then retries once', async action=>{
  const {app,call,set,rows}=await setup();
  if(action==='remove') expect(call('set',set()).ok).toBe(true);
  const before=rows(), names=app.db.prepare('SELECT * FROM secrets_names').all(), changed=vi.spyOn(app.live,'changed');
  const input=action==='set'?set():{name:'api-key',writeId:randomUUID()};
  app.db.exec("CREATE TRIGGER fail_history_receipt BEFORE INSERT ON core_operations BEGIN SELECT RAISE(ABORT,'test'); END");
  expect(call(action,input).ok).toBe(false); expect(rows()).toEqual(before);
  expect(app.db.prepare('SELECT * FROM secrets_names').all()).toEqual(names); expect(changed).not.toHaveBeenCalled();
  app.db.exec('DROP TRIGGER fail_history_receipt');
  expect(call(action,input).ok).toBe(true); expect(rows()).toHaveLength(before.length+1);
  expect(changed).toHaveBeenCalledTimes(1);
  expect(changed.mock.calls[0][0].filter(c=>c.type==='secret.change')).toHaveLength(1);
});
it('upgrades the previous schema without changing names, grants, requests or policy; repeat is a no-op',()=>{
  const home=mkdtempSync(join(tmpdir(),'loom-history-upgrade-')); homes.push(home);
  const lease=openDb(home); try{
    migrate(lease.db,'secrets',schema.slice(0,2));
    lease.db.prepare('INSERT INTO secrets_names VALUES (?,?)').run('api-key','{"id":"api-key","description":"old"}');
    lease.db.prepare('INSERT INTO secrets_grants VALUES (?,?,?,?,?)').run('g','art','secret','api-key','{"expiresAt":42}');
    lease.db.prepare('INSERT INTO secrets_requests VALUES (?,?)').run('q','{"state":"revoked"}');
    lease.db.prepare('INSERT INTO secrets_meta VALUES (?,?)').run('policy','{"default":"never"}');
    const snapshot=()=>['secrets_names','secrets_grants','secrets_requests','secrets_meta'].map(t=>lease.db.prepare(`SELECT * FROM ${t}`).all());
    const before=snapshot(); migrate(lease.db,'secrets',schema); migrate(lease.db,'secrets',schema);
    expect(snapshot()).toEqual(before); expect(lease.db.prepare('SELECT * FROM secrets_changes').all()).toEqual([]);
  } finally {lease.close();}
});
