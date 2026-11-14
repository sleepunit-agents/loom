import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {once} from 'node:events';
import {WebSocket} from 'ws';
import {afterEach,expect,it,vi} from 'vitest';
import {startLoom} from '../../foundation.js';
import {FakeClock,migrate,type Sharing} from '../../core/index.js';
import {installComms} from './index.js';
import {schema} from './schema/001.js';
import {append,saveThread,thread,type Thread} from './store.js';
import {refsOf,indexRefs} from './refs.js';
import type {WordsKey} from './crypto.js';
import {loadKey} from './crypto.js';
import * as cryptoModule from './crypto.js';
import * as commsModule from './index.js';
import {installFixture} from '../../fixture.js';
const cleanup:(()=>Promise<void>)[]=[];
afterEach(async()=>{try{for(const f of cleanup.splice(0).reverse())await f();}finally{vi.restoreAllMocks();}});
const day=86400_000;
async function fixture(){
 const home=mkdtempSync(join(tmpdir(),'comms-backfill-')),clock=new FakeClock();
 const sharing:Sharing={members:{jonathan:{owner:true,agents:['art']}},projects:{pond:{members:['jonathan'],agents:['art']}},services:{}};
 const authenticate=()=>({viewer:{kind:'member' as const,id:'jonathan'},window:true,valid:()=>true});
 let app=await startLoom({home,clock,authenticate});migrate(app.db,'comms',schema);
 const base:WordsKey={seal:async text=>Buffer.from(text),open:async bytes=>Buffer.from(bytes).toString(),hash:text=>text};
 let comms:ReturnType<typeof installComms>|undefined;
 const start=(key:WordsKey=base)=>comms=installComms({...app,clock,key,sharing:()=>sharing,hold:async f=>f(),runtime:{deliver:async()=>{},end:async()=>{}},attention:{answer:()=>({ok:true,value:{}})}});
 cleanup.push(async()=>{await comms?.close();await app.close();rmSync(home,{recursive:true,force:true});});
 const addThread=(id='th:old',extra:Partial<Thread>={})=>{
  const t:Thread={id,member:'jonathan',agent:'art',conversation:`cv-${id}`,title:null,titledBy:null,pinned:false,archived:null,opened:clock.now(),last:clock.now(),readSeq:0,nextSeq:1,stop:false,firstId:'first',firstHash:'hash',working:false,...extra};saveThread(app.db,t);return t;
 };
 const add=(t:Thread,text:string,kind='message',encoding='json',at=clock.now())=>app.db.transaction(()=>append(app.db,t,{id:`row-${t.nextSeq}`,kind,at,sender:t.member,words:Buffer.from(encoding==='text'?text:JSON.stringify({text})),hash:`hash-${t.nextSeq}`,record:JSON.stringify({encoding,delivery:'delivered'})}))();
 return {get app(){return app;},home,clock,sharing,base,start,addThread,add,marker:()=>app.db.prepare("SELECT value FROM comms_meta WHERE key='refs_backfilled'").get(),async next(){await app.close();app=await startLoom({home,clock,next:true,staging:true,stdout:()=>{},sharing:()=>sharing,install:a=>installFixture(a,()=>sharing),authenticate});return app;},async restart(key:WordsKey=base){await comms?.close();await app.close();app=await startLoom({home,clock,authenticate});return start(key);}};
}
it('startup scans retained message/reply words once, including archives; never asks, cards, errors or revoked threads',async()=>{
 const s=await fixture(),t=s.addThread(),archived=s.addThread('th:archive',{archived:s.clock.now()}),revoked=s.addThread('th:revoked',{member:'gone'});
 s.add(t,'PRIVATE t-1 note:pond/plan');s.add(t,'acme/app#3 t-1','reply','text');s.add(archived,'t-4');s.add(revoked,'t-999');
 for(const kind of ['ask','card','error'])s.add(t,'t-998',kind);
 s.add(t,'t-997','message','text',s.clock.now()-14*day);
 s.add(t,'t-996');s.app.db.prepare('UPDATE comms_messages SET words=NULL WHERE thread=? AND seq=?').run(t.id,t.nextSeq-1);
 indexRefs(s.app.db,t.id,0,0,['t-88']);
 const open=vi.fn(s.base.open),c=s.start({...s.base,open});expect(await c.referencesReady).toBe(true);
 expect(open).toHaveBeenCalledTimes(3);expect(s.marker()).toEqual({value:String(s.clock.now())});
 expect(refsOf(s.app.db,t.id)).toEqual([{ref:'t-1',seq:2,pos:1,at:s.clock.now()},{ref:'github:acme/app#3',seq:2,pos:0,at:s.clock.now()},{ref:'note:pond/plan',seq:1,pos:1,at:s.clock.now()},{ref:'t-88',seq:0,pos:0,at:0}]);
 expect(refsOf(s.app.db,archived.id).map(r=>r.ref)).toEqual(['t-4']);expect(refsOf(s.app.db,revoked.id)).toEqual([]);
 expect(JSON.stringify(s.app.db.prepare('SELECT * FROM comms_refs').all())).not.toContain('PRIVATE');
 expect(await (await s.restart({...s.base,open})).referencesReady).toBe(true);expect(open).toHaveBeenCalledTimes(3);
});
function gate(){let entered!:()=>void,release!:()=>void;const began=new Promise<void>(r=>entered=r),wait=new Promise<void>(r=>release=r);return {began,release,open:async(bytes:Uint8Array)=>{entered();await wait;return Buffer.from(bytes).toString();}};}
it('opens actual age-encrypted retained history without copying words into refs or the marker',async()=>{
 const s=await fixture(),t=s.addThread();s.add(t,'placeholder');const key=await loadKey(s.home);
 const words=await key.seal(JSON.stringify({text:'PRIVATE actual cipher t-73 note:pond/real'}));
 s.app.db.prepare('UPDATE comms_messages SET words=?').run(words);
 expect(await s.start(key).referencesReady).toBe(true);
 expect(refsOf(s.app.db,t.id).map(r=>r.ref)).toEqual(['note:pond/real','t-73']);
 expect(JSON.stringify(s.app.db.prepare('SELECT * FROM comms_messages').all())).not.toContain('PRIVATE');
 expect(JSON.stringify(s.app.db.prepare('SELECT * FROM comms_refs').all())).not.toContain('PRIVATE');
 expect(JSON.stringify(s.marker())).not.toContain('PRIVATE');
});
for(const boundary of ['revoked','deleted','member','agent','conversation','project','columns','ciphertext','sender','expiry','closed'] as const)it(`rechecks ${boundary} after startup decryption`,async()=>{
 const s=await fixture(),t=s.addThread();s.add(t,'t-1');const g=gate(),c=s.start({...s.base,open:g.open});await g.began;
 let closing:Promise<void>|undefined;
 if(boundary==='revoked')s.sharing.members.jonathan.agents=[];
 else if(boundary==='deleted')s.app.db.prepare('DELETE FROM comms_threads WHERE id=?').run(t.id);
 else if(boundary==='closed')closing=c.close();
 else if(boundary==='expiry'){
  // Cross the deadline without running the sweep: retained ciphertext alone
  // must never authorize indexing after its words have expired.
  vi.spyOn(s.clock,'now').mockReturnValue(s.clock.now()+14*day);
  expect(s.app.db.prepare('SELECT words FROM comms_messages').get()).toMatchObject({words:expect.any(Buffer)});
 }
 else if(boundary==='columns')s.app.db.prepare("UPDATE comms_threads SET member='other' WHERE id=?").run(t.id);
 else if(boundary==='ciphertext')s.app.db.prepare('UPDATE comms_messages SET words=?').run(Buffer.from('{"text":"t-2"}'));
 else if(boundary==='sender')s.app.db.prepare("UPDATE comms_messages SET sender='other'").run();
 else {const current=thread(s.app.db,t.id)!;current[boundary]=boundary==='project'?'pond':'other';saveThread(s.app.db,current);}
 g.release();expect(await c.referencesReady).toBe(boundary!=='closed');await closing;
 expect(refsOf(s.app.db,t.id)).toEqual([]);if(boundary==='closed')expect(s.marker()).toBeUndefined();
});
it('older backfill cannot replace a new append or displace its newest 200 pointers',async()=>{
 const s=await fixture(),t=s.addThread();s.add(t,'t-1 t-2');const g=gate(),c=s.start({...s.base,open:g.open});await g.began;
 const current=thread(s.app.db,t.id)!;
 s.app.db.transaction(()=>append(s.app.db,current,{id:'new',kind:'reply',at:s.clock.now(),sender:'art',words:Buffer.from('fixture'),hash:'new',record:'{}'},Array.from({length:201},(_,n)=>`t-${n+1}`).join(' ')))();
 g.release();expect(await c.referencesReady).toBe(true);expect(refsOf(s.app.db,t.id)).toHaveLength(200);
 expect(refsOf(s.app.db,t.id).every(r=>r.seq===2)).toBe(true);expect(refsOf(s.app.db,t.id).some(r=>r.ref==='t-1')).toBe(false);
});
it('a failed scan leaves no marker, retries safely, and shutdown drains a suspended decrypt',async()=>{
 const s=await fixture(),t=s.addThread();s.add(t,'t-1');s.add(t,'t-2');
 let n=0;const c=s.start({...s.base,open:async b=>{if(++n===2)throw new Error('fixture crypto failure');return s.base.open(b);}});
 expect(await c.referencesReady).toBe(false);expect(s.marker()).toBeUndefined();expect(refsOf(s.app.db,t.id).map(r=>r.ref)).toEqual(['t-1']);
 const g=gate(),again=await s.restart({...s.base,open:g.open});await g.began;let closed=false;const closing=again.close().then(()=>{closed=true;});
 await Promise.resolve();expect(closed).toBe(false);g.release();await closing;expect(s.marker()).toBeUndefined();
 expect(await (await s.restart()).referencesReady).toBe(true);expect(refsOf(s.app.db,t.id).map(r=>r.ref)).toEqual(['t-2','t-1']);
});
it('production next startup and application shutdown drain retained-history crypto before closing SQLite',async()=>{
 const s=await fixture(),t=s.addThread();s.add(t,'t-1');const g=gate();
 let drained=false,enteredClose!:()=>void;const closeEntered=new Promise<void>(r=>enteredClose=r);
 vi.spyOn(cryptoModule,'loadKey').mockResolvedValue({...s.base,open:async b=>{try{return await g.open(b);}finally{drained=true;}}});
 const install=commsModule.installComms;
 vi.spyOn(commsModule,'installComms').mockImplementation(o=>{const c=install(o),close=c.close.bind(c);vi.spyOn(c,'close').mockImplementation(()=>{enteredClose();return close();});return c;});
 const app=await s.next();await g.began;expect(s.marker()).toBeUndefined();
 const closeDb=app.db.close.bind(app.db);vi.spyOn(app.db,'close').mockImplementation(()=>{expect(drained).toBe(true);return closeDb();});
 const closing=app.close();await closeEntered;
 expect(app.db.open).toBe(true);expect(drained).toBe(false);
 g.release();await closing;expect(app.db.open).toBe(false);
});
it('work calls and live subscriptions never reopen retained words after startup',async()=>{
 const s=await fixture(),t=s.addThread();s.add(t,'t-1');const open=vi.fn(s.base.open);
 expect(await s.start({...s.base,open}).referencesReady).toBe(true);expect(open).toHaveBeenCalledTimes(1);
 open.mockImplementation(async()=>{throw new Error('view opened history');});
 expect(await s.app.operations.callAsync('socket',{kind:'member',id:'jonathan'},'comms.work',{thread:t.id},'view',true)).toMatchObject({ok:true});
 const ws=new WebSocket(s.app.url.replace('http','ws')+'/live');await once(ws,'open');
 try {
  const initial=once(ws,'message');ws.send(JSON.stringify({kind:'subscribe',type:'threadWork',scope:t.id}));
  expect(JSON.parse(String((await initial)[0]))).toMatchObject({kind:'set',type:'threadWork',records:[{id:t.id}]});
  const changed=once(ws,'message');s.app.live.changed([{type:'thread',id:t.id}]);
  expect(JSON.parse(String((await changed)[0]))).toMatchObject({kind:'put',type:'threadWork',record:{id:t.id}});
  expect(open).toHaveBeenCalledTimes(1);
 } finally {ws.terminate();}
});
