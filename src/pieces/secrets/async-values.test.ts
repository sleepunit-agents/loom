import {afterEach,expect,it,vi} from 'vitest';
import {mkdtempSync,rmSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {generateIdentity} from 'age-encryption';
import {openHolderStore} from './holder-store.js';
import {createHash,createHmac,randomUUID} from 'node:crypto';
import {z} from 'zod';
import {startLoom} from '../../foundation.js';
import {fixture,fixtureSharing} from '../../fixture.js';
import {FakeClock,type Viewer} from '../../core/index.js';
import {installAsyncSecretValues,type AsyncSecretMutations} from './async-values.js';
import {startSecretReconciliation} from './reconciliation.js';
const owner:Viewer={kind:'member',id:'jonathan'};
const key=Buffer.alloc(32,7),sentinel='ASYNC-SECRET-SENTINEL';
const closes:(()=>Promise<void>)[]=[],homes:string[]=[];
afterEach(async()=>{for(const c of closes.splice(0).reverse())await c();for(const h of homes.splice(0))rmSync(h,{recursive:true,force:true});vi.restoreAllMocks();});
function fake(){
  const receipts=new Set<string>();
  return {receipts,set:vi.fn(async(who:{writeId:string})=>{receipts.add(who.writeId);}),remove:vi.fn(async(who:{writeId:string})=>{receipts.add(who.writeId);}),hasReceipt:vi.fn(async(who:{writeId:string})=>receipts.has(who.writeId))};
}
async function setup(holder:AsyncSecretMutations=fake(),home?:string,clock=new FakeClock(),retryKey:Uint8Array=key){
  if(!home){home=mkdtempSync(join(tmpdir(),'secrets-intents-'));homes.push(home);fixture(home);}
  const app=await startLoom({home,next:true,staging:true,clock,stdout:()=>{}});closes.push(app.close);
  let sharing=fixtureSharing();
  const recovery=installAsyncSecretValues(app.db,app.operations,()=>sharing,holder,retryKey);
  app.onClose(recovery.close);
  app.operations.register({name:'test.other',write:true,input:z.object({}).strict(),output:z.null(),may:()=>true,run:()=>null});
  const call=(name:string,input:unknown,id:string,v=owner,valid=()=>true)=>app.operations.callAsync('http',v,name,input,id,false,valid);
  const input={name:'API',mode:'add' as const,value:sentinel,writeId:randomUUID()};
  const rows=()=>app.db.prepare('SELECT * FROM secrets_write_intents ORDER BY sequence').all() as Array<{sequence:number;state:string;holder_id:string;committed_at:number}>;
  return {app,home,clock,call,input,rows,recovery,addOwner(){sharing.members.dana={owner:true,agents:['art','mark']};},deny(){sharing={members:{},projects:{},services:{}};}};
}
it('durably reserves before holder work and binds global core ids and unique holder ids without values',async()=>{
  const holder=fake(),s=await setup(holder);let release!:()=>void;
  holder.hasReceipt.mockImplementationOnce(()=>new Promise<boolean>(r=>{release=()=>r(false);}));
  const pending=s.call('secrets.set',s.input,'core');
  expect(s.rows()).toMatchObject([{state:'pending'}]);
  const holderId=s.rows()[0].holder_id;expect(holderId).not.toBe(s.input.writeId);
  expect(await s.call('secrets.set',{...s.input,value:'DIFFERENT'},'core')).toMatchObject({code:'conflict'});
  expect(s.app.operations.call('direct',owner,'test.other',{},'core')).toMatchObject({code:'conflict'});
  expect(await s.call('secrets.remove',{name:'API',writeId:s.input.writeId},'core')).toMatchObject({code:'conflict'});
  expect(await s.call('secrets.set',s.input,'other-core')).toMatchObject({code:'conflict'});
  expect(await s.call('secrets.set',{...s.input,writeId:randomUUID()},'same-name')).toMatchObject({code:'unavailable'});
  release();expect(await pending).toEqual({ok:true,value:{saved:true}});
  expect(s.rows()).toMatchObject([{state:'complete'}]);expect(holder.set).toHaveBeenCalledTimes(1);
  expect(await s.call('secrets.set',s.input,'core')).toEqual({ok:true,value:{saved:true}});
  for(const {name} of s.app.db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as {name:string}[])
    expect(JSON.stringify(s.app.db.prepare(`SELECT * FROM "${name}"`).all())).not.toContain(sentinel);
  const bytes=holder.set.mock.calls[0][2]; // captured transport input is erased
  expect(bytes).toBeDefined();expect([...bytes]).toEqual(Array(Buffer.byteLength(sentinel)).fill(0));
});
it('keeps uncertain reservations through restart, expiry and false evidence, then reconciles lost acknowledgement',async()=>{
  const holder=fake();holder.set.mockImplementationOnce(async who=>{holder.receipts.add(who.writeId);throw Error(sentinel);});
  let s=await setup(holder);const {home,clock,input}=s;
  expect(await s.call('secrets.set',input,'lost')).toEqual({ok:false,code:'unavailable',message:'Secret write awaits reconciliation'});
  expect(s.rows()).toMatchObject([{state:'pending'}]);const holderId=s.rows()[0].holder_id;
  await s.app.close();clock.advance(31*86400_000);s=await setup(holder,home,clock);
  expect(s.app.operations.call('direct',owner,'test.other',{},'lost')).toMatchObject({code:'conflict'});
  expect(await s.call('secrets.set',input,'lost')).toEqual({ok:true,value:{saved:true}});
  expect(holder.set).toHaveBeenCalledTimes(1);expect(s.rows()[0].holder_id).toBe(holderId);
  await s.app.close();clock.advance(31*86400_000);s=await setup(holder,home,clock);
  expect(await s.call('secrets.set',{...input,value:'changed'},'lost')).toMatchObject({code:'conflict'});
  expect(await s.call('secrets.set',input,'lost')).toEqual({ok:true,value:{saved:true}});
  expect(holder.set).toHaveBeenCalledTimes(1);
});
it('never releases a reservation after absence, transport failure or current permission/authentication loss',async()=>{
  const holder=fake();holder.set.mockRejectedValueOnce(Error(sentinel));const s=await setup(holder);
  expect(await s.call('secrets.set',s.input,'pending')).toMatchObject({code:'unavailable'});
  const row=s.rows()[0];expect(row.state).toBe('pending');
  expect(await s.call('secrets.set',{...s.input,writeId:randomUUID()},'next')).toMatchObject({code:'unavailable'});
  expect(await s.call('secrets.set',s.input,'pending')).toMatchObject({ok:true});
  expect(s.rows()[0].holder_id).toBe(row.holder_id);expect(holder.set).toHaveBeenCalledTimes(2);
  const next={...s.input,name:'OTHER',writeId:randomUUID()};let valid=true;
  holder.set.mockImplementationOnce(async who=>{holder.receipts.add(who.writeId);valid=false;});
  expect(await s.call('secrets.set',next,'auth',owner,()=>valid)).toMatchObject({code:'denied'});
  expect(s.rows()[1].state).toBe('committed');s.deny();
  expect(await s.call('secrets.set',next,'auth')).toMatchObject({code:'denied'});
  expect(s.rows()[1].state).toBe('committed');
});
it('serializes simultaneous identical calls and retains the durable name lock after metadata rollback',async()=>{
  const holder=fake(),s=await setup(holder);let release!:()=>void;
  holder.set.mockImplementationOnce(who=>new Promise<void>(r=>{release=()=>{holder.receipts.add(who.writeId);r();};}));
  const first=s.call('secrets.set',s.input,'same');await Promise.resolve();await Promise.resolve();
  const second=s.call('secrets.set',s.input,'same');expect(holder.set).toHaveBeenCalledTimes(1);
  s.app.db.exec("CREATE TRIGGER refuse_secret BEFORE INSERT ON secrets_names BEGIN SELECT RAISE(ABORT,'private'); END");
  release();expect(await first).toMatchObject({code:'unavailable'});expect(await second).toMatchObject({code:'unavailable'});
  expect(s.rows()[0].state).toBe('committed');
  expect(await s.call('secrets.set',{...s.input,writeId:randomUUID()},'overtake')).toMatchObject({code:'unavailable'});
  s.app.db.exec('DROP TRIGGER refuse_secret');
  expect(await s.call('secrets.set',s.input,'same')).toMatchObject({ok:true});expect(holder.set).toHaveBeenCalledTimes(1);
  expect(s.app.db.prepare('SELECT record FROM secrets_names').get()).toEqual({record:JSON.stringify({id:'API',description:'',by:'jonathan',changedAt:s.rows()[0].committed_at})});
});
it('removes metadata and grants after a real acknowledged write, then admits a later add without obsolete replay',async()=>{
  const holder=fake();let s=await setup(holder);
  expect(await s.call('secrets.set',s.input,'add')).toMatchObject({ok:true});
  expect(s.app.operations.call('direct',owner,'secrets.grant',{agent:'art',kind:'secret',target:'API'},'grant')).toMatchObject({ok:true});
  const removal={name:'API',writeId:randomUUID()};expect(await s.call('secrets.remove',removal,'remove')).toEqual({ok:true,value:{removed:true}});
  expect(s.app.db.prepare('SELECT * FROM secrets_names').all()).toEqual([]);expect(s.app.db.prepare('SELECT * FROM secrets_grants').all()).toEqual([]);
  expect(await s.call('secrets.set',{...s.input,writeId:randomUUID()},'new')).toMatchObject({ok:true});
  const {home,clock}=s;await s.app.close();clock.advance(31*86400_000);s=await setup(holder,home,clock);
  expect(await s.call('secrets.remove',removal,'remove')).toMatchObject({ok:true});
  expect(s.app.db.prepare('SELECT id FROM secrets_names').all()).toEqual([{id:'API'}]);expect(holder.remove).toHaveBeenCalledTimes(1);
});
it('refuses nested admission, wrong callers and bad metadata modes before transport',async()=>{
  const holder=fake(),s=await setup(holder);
  let nested!:ReturnType<typeof s.call>;
  s.app.db.transaction(()=>{nested=s.call('secrets.set',s.input,'nested');})();
  expect(await nested).toMatchObject({code:'unavailable'});
  for(const v of [{kind:'agent',id:'art'},{kind:'member',id:'pollock'}] as Viewer[])
    expect(await s.call('secrets.set',s.input,'wrong',v)).toMatchObject({code:'denied'});
  expect(await s.call('secrets.set',{...s.input,mode:'replace'},'absent')).toMatchObject({code:'not-found'});
  expect(await s.call('secrets.remove',{name:'API',writeId:randomUUID()},'absent-remove')).toMatchObject({code:'not-found'});
  expect(s.rows()).toEqual([]);expect(holder.set).not.toHaveBeenCalled();expect(holder.hasReceipt).not.toHaveBeenCalled();
});
it('keeps global id protection when restarted with no async holder installer',async()=>{
  const holder=fake();holder.set.mockRejectedValueOnce(Error('lost'));
  const s=await setup(holder);expect(await s.call('secrets.set',s.input,'reserved')).toMatchObject({code:'unavailable'});
  await s.app.close();
  const app=await startLoom({home:s.home,next:true,staging:true,clock:s.clock,stdout:()=>{}});closes.push(app.close);
  expect(app.operations.has('secrets.set')).toBe(false);
  expect(app.operations.call('direct',owner,'secrets.describe',{name:'OTHER',description:''},'reserved')).toMatchObject({code:'conflict'});
  expect(app.db.prepare('SELECT state FROM secrets_write_intents').get()).toEqual({state:'pending'});
  expect(app.operations.call('direct',owner,'secrets.describe',{name:'OTHER',description:''},'fresh-metadata')).toMatchObject({code:'unavailable'});
});
it('rolls metadata, history, completion and publication back on late core receipt failure',async()=>{
  const holder=fake(),s=await setup(holder),publish=vi.spyOn(s.app.live,'changed');
  s.app.db.exec("CREATE TRIGGER refuse_core BEFORE INSERT ON core_operations BEGIN SELECT RAISE(ABORT,'private'); END");
  expect(await s.call('secrets.set',s.input,'receipt-failure')).toMatchObject({code:'unavailable'});
  expect(s.rows()[0].state).toBe('committed');expect(s.app.db.prepare('SELECT * FROM secrets_names').all()).toEqual([]);
  expect(s.app.db.prepare('SELECT * FROM secrets_changes').all()).toEqual([]);expect(publish).not.toHaveBeenCalled();
  s.app.db.exec('DROP TRIGGER refuse_core');
  expect(await s.call('secrets.set',s.input,'receipt-failure')).toMatchObject({ok:true});
  expect(holder.set).toHaveBeenCalledTimes(1);expect(s.app.db.prepare('SELECT * FROM secrets_changes').all()).toHaveLength(1);
  expect(publish).toHaveBeenCalledTimes(1);
});
it('records durable holder commit order before reconciliation across independent names',async()=>{
  const holder=fake(),s=await setup(holder);let release!:()=>void;
  holder.set.mockImplementationOnce(who=>new Promise<void>(r=>{release=()=>{holder.receipts.add(who.writeId);r();};}));
  const first=s.call('secrets.set',s.input,'first');await Promise.resolve();await Promise.resolve();
  const next={...s.input,name:'OTHER',writeId:randomUUID()};
  expect(await s.call('secrets.set',next,'second')).toMatchObject({code:'unavailable'});
  release();expect(await first).toMatchObject({ok:true});
  expect(await s.call('secrets.set',next,'second')).toMatchObject({ok:true});
  expect(s.app.db.prepare('SELECT name,commit_order,state FROM secrets_write_intents ORDER BY commit_order').all())
    .toEqual([{name:'API',commit_order:1,state:'complete'},{name:'OTHER',commit_order:2,state:'complete'}]);
});
it('recovers actual encrypted holder success after a lost reply and restart without repeating the mutation',async()=>{
  const directory=mkdtempSync(join(tmpdir(),'async-encrypted-'));homes.push(directory);
  const identity=join(directory,'identity'),receiptKey=join(directory,'key');
  writeFileSync(identity,await generateIdentity(),{mode:0o600});writeFileSync(receiptKey,Buffer.alloc(32,12),{mode:0o600});
  let store=await openHolderStore(directory,identity,receiptKey);closes.push(async()=>store.close());
  let lost=true;
  const holder:AsyncSecretMutations={
    set:vi.fn(async(...args)=>{await store.set(...args);if(lost){lost=false;throw Error(sentinel);}}),
    remove:async(...args)=>store.remove(...args),hasReceipt:async who=>store.hasReceipt(who),
  };
  let s=await setup(holder);const {home,clock,input}=s;
  expect(await s.call('secrets.set',input,'actual')).toMatchObject({code:'unavailable'});
  await s.app.close();store.close();store=await openHolderStore(directory,identity,receiptKey);
  s=await setup(holder,home,clock);
  await startSecretReconciliation(s.app,s.recovery).run();
  expect(s.rows()[0].state).toBe('complete');
  expect(await s.call('secrets.set',input,'actual')).toEqual({ok:true,value:{saved:true}});
  expect(holder.set).toHaveBeenCalledTimes(1);
  const bytes=await store.read('API');expect(Buffer.from(bytes).toString()).toBe(sentinel);bytes.fill(0);
  expect(s.app.operations.call('direct',owner,'secrets.describe',{name:'API',description:'Keep this description'},'describe')).toMatchObject({ok:true});
  const replace={...input,mode:'replace' as const,value:'REPLACED-SENTINEL',writeId:randomUUID()};lost=true;clock.advance(50);
  expect(await s.call('secrets.set',replace,'actual-replace')).toMatchObject({code:'unavailable'});
  const row=s.app.db.prepare('SELECT holder_id FROM secrets_write_intents WHERE id=?').get('actual-replace') as {holder_id:string};
  expect(holder.set).toHaveBeenLastCalledWith({member:'jonathan',writeId:row.holder_id},'API',expect.any(Buffer),'replace');
  await s.app.close();store.close();store=await openHolderStore(directory,identity,receiptKey);
  s=await setup(holder,home,clock);
  await startSecretReconciliation(s.app,s.recovery).run();
  expect(s.rows()[1].state).toBe('complete');
  expect(await s.call('secrets.set',replace,'actual-replace')).toEqual({ok:true,value:{saved:true}});
  expect(holder.set).toHaveBeenCalledTimes(2);
  const replaced=await store.read('API');expect(Buffer.from(replaced).toString()).toBe(replace.value);replaced.fill(0);
  const record=JSON.parse((s.app.db.prepare('SELECT record FROM secrets_names WHERE id=?').get('API') as {record:string}).record);
  expect(record).toEqual({id:'API',description:'Keep this description',by:'jonathan',changedAt:clock.now()});
  const changes=(s.app.db.prepare('SELECT record FROM secrets_changes ORDER BY id').all() as {record:string}[]).map(r=>JSON.parse(r.record));
  expect(changes.map(r=>({name:r.name,action:r.action,by:r.by}))).toEqual([{name:'API',action:'add',by:'jonathan'},{name:'API',action:'replace',by:'jonathan'}]);
  expect(await s.call('secrets.set',replace,'actual-replace')).toMatchObject({ok:true});expect(holder.set).toHaveBeenCalledTimes(2);
});
it.each(['throw','async','change'] as const)('rolls admission back and never prepares when admission fails by %s',async mode=>{
  const s=await setup(),prepare=vi.fn(async()=>null);
  s.app.operations.register({name:'test.admission',write:true,input:z.object({}),output:z.null(),may:()=>true,recover:()=>undefined,
    admit(ctx){
      ctx.db.prepare("INSERT INTO secrets_meta VALUES ('admission-test','value')").run();
      if(mode==='throw')throw Error('no');
      if(mode==='async')return Promise.reject(Error('no')) as never;
      ctx.changed('secret.name','API');
    },prepare,run:()=>null});
  expect(await s.call('test.admission',{},'admission')).toMatchObject({code:'unavailable'});
  expect(prepare).not.toHaveBeenCalled();expect(s.app.db.prepare("SELECT * FROM secrets_meta WHERE key='admission-test'").all()).toEqual([]);
});
it('persists the independently calculated keyed full-input identity and separates different daemon keys',async()=>{
  const first=await setup(),input=first.input;
  expect(await first.call('secrets.set',input,'keyed')).toMatchObject({ok:true});
  const canonical=JSON.stringify({mode:input.mode,name:input.name,value:input.value,writeId:input.writeId});
  const expected=createHmac('sha256',key).update('loom-secrets-operation-v1\0').update(canonical).digest('hex');
  const hash=(s:typeof first)=>(s.app.db.prepare('SELECT input_hash FROM secrets_write_intents').get() as {input_hash:string}).input_hash;
  expect(hash(first)).toBe(expected);expect(hash(first)).not.toBe(createHash('sha256').update(canonical).digest('hex'));
  const second=await setup(fake(),undefined,new FakeClock(),Buffer.alloc(32,8));
  expect(await second.call('secrets.set',input,'keyed')).toMatchObject({ok:true});expect(hash(second)).not.toBe(hash(first));
});
it.each(['set','remove'] as const)('rechecks current owner permission before cached core %s receipt replay',async action=>{
  const holder=fake(),s=await setup(holder);
  expect(await s.call('secrets.set',s.input,'saved')).toMatchObject({ok:true});
  const input=action==='set' ? s.input : {name:'API',writeId:randomUUID()},id=action==='set' ? 'saved' : 'removed';
  if(action==='remove')expect(await s.call('secrets.remove',input,id)).toMatchObject({ok:true});
  expect(s.app.db.prepare('SELECT id FROM core_operations WHERE id=?').get(id)).toEqual({id});
  s.deny();expect(await s.call(`secrets.${action}`,input,id)).toMatchObject({code:'denied'});
  expect(holder.set).toHaveBeenCalledTimes(1);expect(holder.remove).toHaveBeenCalledTimes(action==='remove'?1:0);
});
it('blocks later metadata edits while removal is uncertain and preserves edits made after reconciliation',async()=>{
  const holder=fake(),s=await setup(holder);
  expect(await s.call('secrets.set',s.input,'add')).toMatchObject({ok:true});
  let release!:()=>void;
  holder.remove.mockImplementationOnce(who=>new Promise<void>(r=>{release=()=>{holder.receipts.add(who.writeId);r();};}));
  const removal={name:'API',writeId:randomUUID()},pending=s.call('secrets.remove',removal,'removing');
  await Promise.resolve();await Promise.resolve();expect(holder.remove).toHaveBeenCalledTimes(1);
  const describe={name:'API',description:'Later description'};
  expect(s.app.operations.call('direct',owner,'secrets.describe',describe,'later-description')).toMatchObject({code:'unavailable'});
  expect(s.app.operations.call('direct',owner,'secrets.describe',{...describe,name:'OTHER'},'different-name')).toMatchObject({code:'unavailable'});
  expect(s.app.operations.call('direct',owner,'secrets.grant',{agent:'art',kind:'secret',target:'API'},'later-grant')).toMatchObject({code:'unavailable'});
  expect(s.app.db.prepare('SELECT * FROM secrets_grants').all()).toEqual([]);
  expect(JSON.parse((s.app.db.prepare('SELECT record FROM secrets_names').get() as {record:string}).record).description).toBe('');
  release();expect(await pending).toMatchObject({ok:true});
  expect(s.app.operations.call('direct',owner,'secrets.describe',describe,'later-description')).toMatchObject({ok:true});
  expect(await s.call('secrets.remove',removal,'removing')).toMatchObject({ok:true});
  expect(JSON.parse((s.app.db.prepare('SELECT record FROM secrets_names').get() as {record:string}).record).description).toBe('Later description');
});
it('separates global viewer/id and holder identity for two current authorized owners using the same core id',async()=>{
  const holder=fake();holder.set.mockRejectedValueOnce(Error('uncertain'));
  const s=await setup(holder),dana:Viewer={kind:'member',id:'dana'};s.addOwner();
  expect(await s.call('secrets.set',s.input,'shared')).toMatchObject({code:'unavailable'});
  const second={...s.input,name:'OTHER'}; // Deliberately reuse both core id and caller UUID in another member's namespace.
  expect(await s.call('secrets.set',second,'shared',dana)).toMatchObject({code:'unavailable'});
  expect(await s.call('secrets.set',s.input,'shared')).toMatchObject({ok:true});
  expect(await s.call('secrets.set',second,'shared',dana)).toMatchObject({ok:true});
  const rows=s.app.db.prepare('SELECT viewer,id,member,write_id,holder_id FROM secrets_write_intents ORDER BY sequence').all() as {viewer:string;id:string;member:string;write_id:string;holder_id:string}[];
  expect(rows.map(r=>({viewer:JSON.parse(r.viewer),id:r.id,member:r.member,writeId:r.write_id})))
    .toEqual([{viewer:owner,id:'shared',member:'jonathan',writeId:s.input.writeId},{viewer:dana,id:'shared',member:'dana',writeId:s.input.writeId}]);
  expect(rows[0].holder_id).not.toBe(rows[1].holder_id);
  const {home,clock}=s;await s.app.close();clock.advance(31*86400_000);const next=await setup(holder,home,clock);next.addOwner();
  expect(await next.call('secrets.set',second,'shared',dana)).toMatchObject({ok:true});
  expect(await next.call('secrets.set',s.input,'shared')).toMatchObject({ok:true});
  expect(holder.set).toHaveBeenCalledTimes(3);
  expect(await next.call('secrets.set',s.input,'shared',dana)).toMatchObject({code:'conflict'});
});

it('automatically reconciles a durable positive receipt after restart without caller plaintext',async()=>{
  const holder=fake();holder.set.mockImplementationOnce(async who=>{holder.receipts.add(who.writeId);throw Error(sentinel);});
  let s=await setup(holder);const {home,clock,input}=s;
  expect(await s.call('secrets.set',input,'lost-auto')).toMatchObject({code:'unavailable'});
  await s.app.close();clock.advance(31*86400_000);s=await setup(holder,home,clock);
  const publish=vi.spyOn(s.app.live,'changed'),job=startSecretReconciliation(s.app,s.recovery);
  clock.advance(0);await job.run();
  expect(s.rows()[0].state).toBe('complete');expect(holder.set).toHaveBeenCalledTimes(1);expect(holder.remove).not.toHaveBeenCalled();
  expect(s.app.db.prepare('SELECT name FROM core_operations WHERE id=?').get('lost-auto')).toEqual({name:'secrets.set'});
  expect(s.app.db.prepare('SELECT * FROM secrets_changes').all()).toHaveLength(1);expect(publish).toHaveBeenCalledTimes(1);
  expect(await s.call('secrets.set',{...input,value:'different'},'lost-auto')).toMatchObject({code:'conflict'});
  expect(await s.call('secrets.set',input,'lost-auto')).toMatchObject({ok:true});
  for(const {name} of s.app.db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as {name:string}[])
    expect(JSON.stringify(s.app.db.prepare(`SELECT * FROM "${name}"`).all())).not.toContain(sentinel);
});
it('automatic negative, malformed and failed receipt lookups never resend or release an uncertain write',async()=>{
  const holder=fake();holder.set.mockRejectedValueOnce(Error(sentinel));const s=await setup(holder);
  expect(await s.call('secrets.set',s.input,'uncertain')).toMatchObject({code:'unavailable'});
  const job=startSecretReconciliation(s.app,s.recovery);
  for(const mode of ['negative','malformed','failure']) {
    if(mode==='malformed')holder.hasReceipt.mockResolvedValueOnce('true' as never);
    if(mode==='failure')holder.hasReceipt.mockRejectedValueOnce(Error(sentinel));
    await job.run();expect(s.rows()[0].state).toBe('pending');
    expect(await s.call('secrets.set',{...s.input,writeId:randomUUID()},'blocked')).toMatchObject({code:'unavailable'});
  }
  expect(holder.set).toHaveBeenCalledTimes(1);expect(holder.remove).not.toHaveBeenCalled();
  // A late commit is still possible after false evidence; later positive evidence recovers it.
  holder.receipts.add(s.rows()[0].holder_id);s.clock.advance(60_000);await job.run();expect(s.rows()[0].state).toBe('complete');
});
it('rechecks actual original owner after an awaited receipt and resumes after authority returns',async()=>{
  const holder=fake();holder.set.mockImplementationOnce(async who=>{holder.receipts.add(who.writeId);throw Error('lost');});
  const s=await setup(holder);expect(await s.call('secrets.set',s.input,'authority')).toMatchObject({code:'unavailable'});
  const job=startSecretReconciliation(s.app,s.recovery);let release!:(v:boolean)=>void;
  holder.hasReceipt.mockImplementationOnce(()=>new Promise(r=>{release=r;}));
  const work=job.run();s.deny();release(true);await work;
  expect(s.rows()[0].state).toBe('committed');expect(s.app.db.prepare('SELECT * FROM secrets_names').all()).toEqual([]);
  expect(s.app.db.prepare('SELECT * FROM core_operations WHERE id=?').all('authority')).toEqual([]);
  s.addOwner();await job.run();expect(s.rows()[0].state).toBe('committed'); // Dana cannot stand in for Jonathan.
  await s.app.close();const next=await setup(holder,s.home,s.clock);const resumed=startSecretReconciliation(next.app,next.recovery);
  await resumed.run();expect(next.rows()[0].state).toBe('complete');expect(holder.set).toHaveBeenCalledTimes(1);
});
it('automatic reconciliation rolls metadata/history/live/completion back when core receipt persistence fails',async()=>{
  const holder=fake();holder.set.mockImplementationOnce(async who=>{holder.receipts.add(who.writeId);throw Error('lost');});
  const s=await setup(holder);expect(await s.call('secrets.set',s.input,'rollback-auto')).toMatchObject({code:'unavailable'});
  const job=startSecretReconciliation(s.app,s.recovery),publish=vi.spyOn(s.app.live,'changed');
  s.app.db.exec("CREATE TRIGGER fail_auto BEFORE INSERT ON core_operations BEGIN SELECT RAISE(ABORT,'private'); END");
  await job.run();expect(s.rows()[0].state).toBe('committed');
  expect(s.app.db.prepare('SELECT * FROM secrets_names').all()).toEqual([]);expect(s.app.db.prepare('SELECT * FROM secrets_changes').all()).toEqual([]);expect(publish).not.toHaveBeenCalled();
  s.app.db.exec('DROP TRIGGER fail_auto');await job.run();expect(s.rows()[0].state).toBe('complete');expect(publish).toHaveBeenCalledTimes(1);expect(holder.set).toHaveBeenCalledTimes(1);
});
it('shutdown during lookup prevents late database access and job runs coalesce',async()=>{
  const holder=fake();holder.set.mockRejectedValueOnce(Error('lost'));const s=await setup(holder);
  expect(await s.call('secrets.set',s.input,'closing')).toMatchObject({code:'unavailable'});
  let release!:(v:boolean)=>void;holder.hasReceipt.mockImplementationOnce(()=>new Promise(r=>{release=r;}));
  const job=startSecretReconciliation(s.app,s.recovery),work=job.run();expect(job.run()).toBe(work);
  await s.app.close();release(true);await expect(work).resolves.toBeUndefined();await job.run();
  const next=await setup(holder,s.home,s.clock);expect(next.rows()[0].state).toBe('pending');
});

it('automatic remove clears grants once and never overwrites later edits on a retry',async()=>{
  const holder=fake(),s=await setup(holder);expect(await s.call('secrets.set',s.input,'add-auto-remove')).toMatchObject({ok:true});
  expect(s.app.operations.call('direct',owner,'secrets.grant',{agent:'art',kind:'secret',target:'API'},'grant-auto')).toMatchObject({ok:true});
  holder.remove.mockImplementationOnce(async who=>{holder.receipts.add(who.writeId);throw Error('lost');});
  const input={name:'API',writeId:randomUUID()};expect(await s.call('secrets.remove',input,'auto-remove')).toMatchObject({code:'unavailable'});
  const job=startSecretReconciliation(s.app,s.recovery);await job.run();
  expect(s.rows()[1].state).toBe('complete');expect(s.app.db.prepare('SELECT * FROM secrets_grants').all()).toEqual([]);expect(s.app.db.prepare('SELECT * FROM secrets_names').all()).toEqual([]);
  expect(s.app.operations.call('direct',owner,'secrets.describe',{name:'API',description:'later'},'later-auto')).toMatchObject({ok:true});
  await s.app.close();s.clock.advance(31*86400_000);const next=await setup(holder,s.home,s.clock);await startSecretReconciliation(next.app,next.recovery).run();
  expect(await next.call('secrets.remove',input,'auto-remove')).toMatchObject({ok:true});
  expect(JSON.parse((next.app.db.prepare('SELECT record FROM secrets_names').get() as {record:string}).record).description).toBe('later');expect(holder.remove).toHaveBeenCalledTimes(1);
});
