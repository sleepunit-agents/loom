import {afterEach,expect,it,vi} from 'vitest';
import {mkdirSync,writeFileSync,existsSync,readFileSync,symlinkSync,chmodSync} from 'node:fs';
import {join} from 'node:path';
import {randomBytes,randomUUID} from 'node:crypto';
import {Writable} from 'node:stream';
import {ServerResponse} from 'node:http';
import {localSecretSource} from './local-holder.js';
import {generateIdentity} from 'age-encryption';
import {ticketAuthorityFixture} from '../../runtime-runner/ticket-authority.fixture.js';
import {workerSecretInputs} from '../../runtime-runner/secret-input.js';
import {listenWorkerSecretInput} from '../../runtime-runner/secret-transport.js';
import {remoteWorkerTicketProof} from './ticket-authority.js';
import {workerAdmission} from './worker-admission.js';
import {startLoom} from '../../foundation.js';
import {signin} from '../../core/signin/index.js';
import {SharingDatabase} from '../../core/household/sharing.js';
import {runtimeHouseDestination} from '../runtime/role.js';
import {startPersistentHolder} from './holder-lifecycle.js';
import {localHolderMutations} from './holder-mutations.js';
import {localHolderHandoff} from './holder-handoff.js';
import * as storage from './holder-store.js';
import * as authority from './ticket-authority.js';
const closes:Array<()=>unknown>=[];
afterEach(async()=>{vi.restoreAllMocks();for(const close of closes.splice(0).reverse())await close();});
async function setup(staging=false) {
 const f=await ticketAuthorityFixture(closes);await f.authority.close();await f.app.close();
 const daemon={...f.server},holder={...f.config};delete (holder as Partial<typeof holder>).servername;
 const endpoint=(name:string)=>join(f.home,`${name}.sock`);
 const config={read:{...holder,socket:endpoint('read')},mutation:{...holder,socket:endpoint('mutation')},
  authority:{...f.config,socket:endpoint('mutation-authority')},daemonFingerprint:f.fingerprint('daemon'),
  directory:join(f.home,'ciphertext'),identity:join(f.home,'age-key'),fingerprintKey:join(f.home,'retry-key'),
  handoff:{listen:{...holder,socket:endpoint('handoff')},authority:{...f.config},workers:[] as Array<{binding:{agent:string;job:string;runner:string;box:string;claimedAt:number};config:typeof f.config;fingerprint:string}>}};
 mkdirSync(config.directory,{mode:0o700});writeFileSync(config.identity,await generateIdentity(),{mode:0o600});writeFileSync(config.fingerprintKey,randomBytes(32),{mode:0o600});
 const app=await startLoom({home:f.home,next:true,staging,clock:f.clock,stdout(){},
  secretAuthority:{...daemon,socket:config.authority.socket,holderFingerprint:f.fingerprint('holder')},
  secretWorkers:{authority:daemon,admission:{...daemon,socket:endpoint('admission')},
   holder:{config:{...daemon,socket:config.handoff.listen.socket,servername:'holder.test'},fingerprint:f.fingerprint('holder')},
   workers:[{tokenDigest:f.tokenDigest,fingerprint:f.fingerprint('daemon')}]}});closes.push(app.close);
 const viewer=signin(app).token(f.tokenDigest)!.viewer;
 const destination=runtimeHouseDestination(app,()=>new SharingDatabase(app.db,f.home).sharing(),viewer)!;
 const {agent,job,runner,box,claimedAt}=destination,binding={agent,job,runner,box,claimedAt};
 const input={...daemon,socket:endpoint('input')};
 config.handoff.workers.push({binding,config:{...f.config,socket:input.socket},fingerprint:f.fingerprint('daemon')});
 const file=join(f.home,'persistent-holder.json');const save=()=>writeFileSync(file,JSON.stringify(config),{mode:0o600});save();
 const start=async()=>{const h=await startPersistentHolder(file);closes.push(h.close);return h;};
 const mutate=localHolderMutations({...daemon,socket:config.mutation.socket,servername:'holder.test'});
 const inputs=workerSecretInputs(),received:string[]=[],borrowed:Buffer[]=[];
 let proof:ReturnType<typeof remoteWorkerTicketProof>|undefined;
 const pending=inputs.register(binding,new Writable({write(b,_e,done){received.push(b.toString());borrowed.push(b);done();}}),
  ()=>destination.current(),()=>proof?proof.current():Promise.resolve(false),Date.now()+30_000);
 const listener=await listenWorkerSecretInput(input,f.fingerprint('holder'),inputs);closes.push(listener.close);
 const admission=workerAdmission({...daemon,socket:endpoint('admission'),servername:'daemon.test'},f.fingerprint('daemon'),pending.id);closes.push(admission.close);
 const admit=async()=>{const id=await admission.admit('API');proof=remoteWorkerTicketProof({...daemon,servername:'daemon.test'},f.fingerprint('daemon'),id,pending.id);closes.push(proof.close);return id;};
 const put=()=>mutate.set({member:'jonathan',writeId:randomUUID()},'API',Buffer.from('SYNTHETIC-PERSISTENT-HANDOFF'),'add');
 return {...f,app,config,file,save,start,put,admit,admission,received,borrowed};
}
it.each([false,true])('persistent startup reaches real Runtime-selected worker with central proof (staging=%s)',async staging=>{
 const f=await setup(staging);await f.start();await f.put();const id=await f.admit();
 if(staging)await expect(f.admission.dispatch()).rejects.toThrow();else await f.admission.dispatch();
 expect(f.received).toEqual(staging?[]:['SYNTHETIC-PERSISTENT-HANDOFF']);
 expect(f.borrowed.every(b=>b.every(v=>v===0))).toBe(true);
 expect(f.app.db.prepare('SELECT state FROM secrets_tickets WHERE id=?').get(id)).toEqual({state:staging?'uncertain':'released'});
 for(const file of ['holder.db','holder.db-wal'])expect(readFileSync(join(f.config.directory,file)).includes('SYNTHETIC-PERSISTENT-HANDOFF')).toBe(false);
 expect(JSON.stringify(f.app.db.prepare('SELECT * FROM secrets_tickets').all())).not.toContain('SYNTHETIC-PERSISTENT-HANDOFF');
});
it.each(['grant','job','token'] as const)('persistent handoff denies original %s revoked after admission',async kind=>{
 const f=await setup();await f.start();await f.put();await f.admit();
 if(kind==='grant'){const {expiresAt:_,...grant}=f.grant;expect(f.app.operations.call('direct',{kind:'member',id:'jonathan'},'secrets.revoke',grant,randomUUID()).ok).toBe(true);}
 if(kind==='token')signin(f.app).tokens.change(tokens=>{for(const t of tokens)if(t.sha256===f.tokenDigest)t.revoked=new Date(f.clock.now()).toISOString();});
 if(kind==='job') { // Use the actual Runtime store, never a replacement proof.
  const {runtimeStore}=await import('../runtime/store.js');const store=runtimeStore(f.app.db),{changedAt:_,...before}=store.read('job',f.id)!;
  f.app.db.transaction(()=>store.put('job',{...before,claimedAt:f.clock.now()+1},f.clock.now()))();
 }
 await expect(f.admission.dispatch()).rejects.toThrow();expect(f.received).toEqual([]);
});
it.each(['duplicate','overlap','dot-alias','parent-alias','symlink-alias','authority-directory','worker-directory','tls','unknown','listener'] as const)('preflights %s failure without committing holder storage/key history',async kind=>{
 const f=await setup();
 if(kind==='duplicate')f.config.handoff.workers.push({...f.config.handoff.workers[0]});
 if(kind==='overlap')f.config.handoff.listen.socket=f.config.mutation.socket;
 if(kind==='dot-alias')f.config.handoff.workers.push({...f.config.handoff.workers[0],binding:{...f.config.handoff.workers[0].binding,job:randomUUID()},config:{...f.config.handoff.workers[0].config,socket:f.home+'/./input.sock'}});
 if(kind==='parent-alias'){mkdirSync(join(f.home,'child'),{mode:0o700});f.config.handoff.workers[0].config.socket=f.home+'/child/../input.sock';}
 if(kind==='symlink-alias'){symlinkSync(f.home,join(f.home,'alias'));f.config.handoff.workers[0].config.socket=join(f.home,'alias','input.sock');}
 if(kind==='authority-directory'||kind==='worker-directory'){
  const directory=join(f.home,'public');mkdirSync(directory,{mode:0o755});chmodSync(directory,0o755);
  const endpoint=kind==='authority-directory'?f.config.handoff.authority:f.config.handoff.workers[0].config;
  endpoint.socket=join(directory,'endpoint.sock');
 }
 if(kind==='tls')f.config.handoff.workers[0].config.key=join(f.home,'missing-key');
 if(kind==='unknown')Object.assign(f.config.handoff,{extra:true});
 if(kind==='listener')writeFileSync(f.config.handoff.listen.socket,'occupied',{mode:0o600});
 f.save();await expect(f.start()).rejects.toThrow(/^Persistent secret holder could not start$/);
 expect(existsSync(join(f.config.directory,'holder.db'))).toBe(false);
 expect(existsSync(f.config.read.socket)).toBe(false);expect(existsSync(f.config.mutation.socket)).toBe(false);
 if(kind==='listener')expect(readFileSync(f.config.handoff.listen.socket,'utf8')).toBe('occupied');
});
it('binds handoff before key history commits and rejects authenticated work until ready',async()=>{
 const f=await setup(),actual=storage.openHolderStore;let entered!:()=>void,resume!:()=>void;
 const ready=new Promise<void>(r=>{entered=r;}),hold=new Promise<void>(r=>{resume=r;});
 vi.spyOn(storage,'openHolderStore').mockImplementation(async(...args)=>{entered();await hold;return actual(...args);});
 const minted=vi.spyOn(authority,'remoteTicketAuthority');
 const starting=f.start();await ready;
 const claims=vi.spyOn(minted.mock.results[0].value as ReturnType<typeof authority.remoteTicketAuthority>,'claim');
 const client=localHolderHandoff({...f.server,socket:f.config.handoff.listen.socket,servername:'holder.test'},f.fingerprint('holder'));closes.push(client.close);
 try {expect(existsSync(f.config.handoff.listen.socket)).toBe(true);await expect(client.handTo(randomUUID())).rejects.toThrow();expect(claims).not.toHaveBeenCalled();expect(existsSync(join(f.config.directory,'holder.db'))).toBe(false);}
 finally {resume();await starting;}
});
it('shutdown fences a held read, drains its route and source before closing storage',async()=>{
 const f=await setup(),actual=storage.openHolderStore;let entered!:()=>void,resume!:()=>void;
 const ready=new Promise<void>(r=>{entered=r;}),hold=new Promise<void>(r=>{resume=r;});let bytes:Uint8Array|undefined;
 const closed=vi.fn();
 vi.spyOn(storage,'openHolderStore').mockImplementation(async(...args)=>{
  const store=await actual(...args);return {...store,async read(name:string){bytes=await store.read(name);entered();await hold;return bytes;},close(){
   expect(existsSync(f.config.handoff.listen.socket)).toBe(false);expect(bytes?.every(v=>v===0)).toBe(true);closed();store.close();
  }};
 });
 let retired=false;
 const end=ServerResponse.prototype.end;
 vi.spyOn(ServerResponse.prototype,'end').mockImplementation(function(this:ServerResponse,...args:Parameters<ServerResponse['end']>){
  const value=end.apply(this,args);if(this.req.url?.endsWith('/uncertain'))retired=true;return value;
 });
 const holder=await f.start();await f.put();const id=await f.admit();const delivery=f.admission.dispatch().catch(e=>e);await ready;
 const first=holder.close(),second=holder.close();expect(second).toBe(first);expect(closed).not.toHaveBeenCalled();
 try {await vi.waitFor(()=>expect(retired).toBe(true));expect(f.app.db.prepare('SELECT state FROM secrets_tickets WHERE id=?').get(id)).toEqual({state:'uncertain'});}
 finally {resume();await first;}
 expect(await delivery).toBeInstanceOf(Error);expect(f.received).toEqual([]);expect(closed).toHaveBeenCalledOnce();
});

it.each(['pin','binding','empty'] as const)('configured %s cannot redirect a central original claim',async kind=>{
 const f=await setup();
 if(kind==='pin')f.config.handoff.workers[0].fingerprint=f.fingerprint('stranger');
 if(kind==='binding')f.config.handoff.workers[0].binding.claimedAt++;
 if(kind==='empty')f.config.handoff.workers=[];
 f.save();await f.start();await f.put();const id=await f.admit();
 await expect(f.admission.dispatch()).rejects.toThrow();expect(f.received).toEqual([]);
 expect(f.app.db.prepare('SELECT state FROM secrets_tickets WHERE id=?').get(id)).toEqual({state:'uncertain'});
});

it.each(['read','mutation'] as const)('shutdown drains original %s handler before closing persistent storage',async kind=>{
 const f=await setup(),actual=storage.openHolderStore;let entered!:()=>void,resume!:()=>void;
 const ready=new Promise<void>(r=>{entered=r;}),hold=new Promise<void>(r=>{resume=r;});let borrowed:Uint8Array|undefined;
 const closed=vi.fn();
 vi.spyOn(storage,'openHolderStore').mockImplementation(async(...args)=>{
  const store=await actual(...args);return {...store,
   async read(name:string){const value=await store.read(name);if(kind==='read'){borrowed=value;entered();await hold;}return value;},
   async set(...args:Parameters<typeof store.set>){await store.set(...args);if(kind==='mutation'){borrowed=args[2];entered();await hold;}},
   close(){expect(borrowed?.every(v=>v===0)).toBe(true);closed();store.close();}
  };
 });
 const holder=await f.start();
 let pending:Promise<unknown>;
 if(kind==='read'){
  await f.put();const source=localSecretSource({...f.server,socket:f.config.read.socket,servername:'holder.test'});
  pending=source.read('API').catch(e=>e);
 }else pending=f.put().catch(e=>e);
 await ready;const closing=holder.close();
 try {await pending;expect(closed).not.toHaveBeenCalled();}
 finally {resume();await closing;}
 expect(closed).toHaveBeenCalledOnce();
});

it('failed startup drains an original authenticated mutation authority await before closing clients',async()=>{
 const f=await setup();let entered!:()=>void,fail!:()=>void;
 const opening=new Promise<void>(r=>{entered=r;}),failure=new Promise<void>(r=>{fail=r;});
 vi.spyOn(storage,'openHolderStore').mockImplementation(async()=>{entered();await failure;throw Error('synthetic storage failure');});
 const minted=vi.spyOn(authority,'remoteTicketAuthority');
 let stopped=false;const starting=f.start().then(()=>{throw Error('unexpected success');},e=>{stopped=true;return e;});
 await opening;
 const clientClose=vi.spyOn(minted.mock.results[0].value as ReturnType<typeof authority.remoteTicketAuthority>,'close');
 let reached!:()=>void,respond!:()=>void;const held=new Promise<void>(r=>{reached=r;});
 const end=ServerResponse.prototype.end;
 const reply=vi.spyOn(ServerResponse.prototype,'end').mockImplementation(function(this:ServerResponse,...args:Parameters<ServerResponse['end']>){
  if(this.req.url==='/v1/authority'){respond=()=>{end.apply(this,args);};reached();return this;}
  return end.apply(this,args);
 });
 const mutation=f.put().catch(e=>e);await held;fail();
 try {
  await mutation;await new Promise<void>(r=>setImmediate(r));
  expect(stopped).toBe(false);expect(clientClose).not.toHaveBeenCalled();
  expect(existsSync(join(f.config.directory,'holder.db'))).toBe(false);
 }finally {respond();reply.mockRestore();expect(await starting).toEqual(Error('Persistent secret holder could not start'));}
 expect(clientClose).toHaveBeenCalledOnce();expect(stopped).toBe(true);
});
