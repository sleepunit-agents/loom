import {ChildProcess} from 'node:child_process';
import {startAdmittedSecretCommand} from './admitted-secret-command.js';
import {afterEach,expect,it,vi} from 'vitest';
import {existsSync,readFileSync} from 'node:fs';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {ServerResponse} from 'node:http';
import {Duplex} from 'node:stream';
import {admissionFixture,holdAdmissionResponse} from './worker-admission.fixture.js';
const closes:Array<()=>unknown>=[];
afterEach(async()=>{vi.restoreAllMocks();for(const close of closes.splice(0).reverse())await close();});
const setup=(releaseStaging=true)=>admissionFixture(closes,releaseStaging);
it('admits the real original command over pinned worker TLS, binds once, then dispatches retained daemon completion',async()=>{
 const f=await setup(),end=ServerResponse.prototype.end,cancelled=vi.fn();
 vi.spyOn(ServerResponse.prototype,'end').mockImplementation(function(this:ServerResponse,...args:Parameters<ServerResponse['end']>){if(this.req.url?.endsWith('/cancel'))cancelled();return end.apply(this,args);});
 const command=await f.start(),id=await f.admitted();
 expect(await command.delivery).toBe(true);expect(await command.completed).toBe(true);
 expect(readFileSync(f.marker,'utf8')).toBe('accepted');expect(f.state(id)).toEqual({state:'released'});expect(f.source).toHaveBeenCalledTimes(1);expect(cancelled).not.toHaveBeenCalled();
});
it.each(['local','grant','job','policy'] as const)('fences original %s replacement during the admission reply await',async outcome=>{
 const f=await setup(),{ready,resume,spy}=holdAdmissionResponse('/admit');
 try {
  const command=await f.start();await ready;const id=await f.admitted();
  if(outcome==='local')f.revoke();
  if(outcome==='grant'){const {expiresAt:_,...grant}=f.grant;f.call('secrets.revoke',grant);}
  if(outcome==='job')f.job({claimedAt:f.clock.now()+1});
  if(outcome==='policy')f.app.db.prepare("INSERT OR REPLACE INTO secrets_meta(key,value) VALUES ('policy','replacement')").run();
  resume();expect(await command.delivery).toBe(false);await command.close();expect(await command.completed).toBe(false);
  expect(existsSync(f.marker)).toBe(false);expect(f.source).not.toHaveBeenCalled();
  expect(f.state(id)).toEqual({state:outcome==='grant'||outcome==='policy'?'revoked':'uncertain'});
 }finally{resume();spy.mockRestore();}
});
it('snapshots configured admission peer/viewer/assignment and original startup endpoints before awaits',async()=>{
 const f=await setup();
 f.peer.binding.job=randomUUID();f.peer.viewer={kind:'member',id:'nobody'};f.peer.fingerprint=f.fingerprint('stranger');
 const starting=f.start();f.config.admission.socket=join(f.home,'replaced.sock');f.request.name='REPLACED';f.config.daemonFingerprint=f.fingerprint('stranger');
 const command=await starting,id=await f.admitted();
 expect(await command.delivery).toBe(true);expect(await command.completed).toBe(true);expect(readFileSync(f.marker,'utf8')).toBe('accepted');
});
it.each(['peer','pin','assignment'] as const)('refuses %s before secret source or command release',async outcome=>{
 const f=await setup();
 if(outcome==='peer'){f.config.admission.cert=join(f.home,'stranger.pem');f.config.admission.key=join(f.home,'stranger.key');}
 if(outcome==='pin')f.config.daemonFingerprint=f.fingerprint('holder');
 if(outcome==='assignment')f.job({claimedAt:f.clock.now()+1});
 if(outcome==='assignment')await expect(f.start()).rejects.toThrow('Worker secret command unavailable');
 else {const command=await f.start();expect(await command.delivery).toBe(false);expect(await command.completed).toBe(false);}
 expect(existsSync(f.marker)).toBe(false);expect(f.source).not.toHaveBeenCalled();
 expect(f.app.db.prepare('SELECT count(*) AS n FROM secrets_tickets').get()).toEqual({n:0});
});
it('cancels startup while admission response is delayed, and never sends readiness after shutdown',async()=>{
 const f=await setup(),{ready,resume,spy}=holdAdmissionResponse('/admit');
 try {
  const command=await f.start();await ready;const id=await f.admitted();await command.close();
  expect(await command.delivery).toBe(false);expect(await command.completed).toBe(false);
  await expect.poll(()=>f.state(id)).toEqual({state:'uncertain'});
  expect(existsSync(f.marker)).toBe(false);expect(f.source).not.toHaveBeenCalled();
 }finally{resume();spy.mockRestore();}
});
it.each(['command','listener'])('drains %s shutdown without resuming an externally held native completion callback',async target=>{
 const f=await setup();let entered!:()=>void,resume!:()=>void,borrowed:Buffer|undefined;
 const ready=new Promise<void>(r=>{entered=r;}),wait=new Promise<void>(r=>{resume=r;});const end=Duplex.prototype.end;
 const spy=vi.spyOn(Duplex.prototype,'end').mockImplementation(function(this:Duplex,...args:Parameters<Duplex['end']>){
  if(Buffer.isBuffer(args[0])&&args[0].toString()==='synthetic-admitted-value') {
   borrowed=args[0];const callback=args[1] as unknown as (error?:Error|null)=>void;
   return Reflect.apply(end,this,[args[0],(error?:Error|null)=>{entered();void wait.then(()=>callback(error));}]);
  }
  return Reflect.apply(end,this,args);
 });
 try {
  const command=await f.start(),id=await f.admitted();await ready;
  await (target==='command'?command.close():f.listener.close());await command.close(); // Callback remains held until finally.
  expect(await command.delivery).toBe(false);expect(await command.completed).toBe(false);
  expect(borrowed!.every(b=>b===0)).toBe(true);expect(f.state(id)).toEqual({state:'uncertain'});
 }finally{resume();spy.mockRestore();}
});

it('keeps staging closed without an explicit owner release',async()=>{
 const f=await setup(false),command=await f.start(),id=await f.admitted();
 expect(await command.delivery).toBe(false);expect(await command.completed).toBe(false);
 expect(f.state(id)).toEqual({state:'uncertain'});expect(f.source).not.toHaveBeenCalled();
 expect(f.app.effects!.status(`secrets:handoff:${id}`)).toBe('due');
});
it('rejects a mismatched admission reply without binding or dispatching the original command',async()=>{
 const f=await setup(),end=ServerResponse.prototype.end;
 const spy=vi.spyOn(ServerResponse.prototype,'end').mockImplementation(function(this:ServerResponse,...args:Parameters<ServerResponse['end']>){
  if(this.req.url?.endsWith('/admit')&&this.statusCode===200) {
   const body=JSON.parse(args[0] as string);body.pendingId=randomUUID();args[0]=JSON.stringify(body);
  }
  return end.apply(this,args);
 });
 try {
  const command=await f.start(),id=await f.admitted();
  expect(await command.delivery).toBe(false);expect(await command.completed).toBe(false);
  expect(existsSync(f.marker)).toBe(false);expect(f.source).not.toHaveBeenCalled();
  await f.listener.close();expect(f.state(id)).toEqual({state:'uncertain'});
 }finally{spy.mockRestore();}
});

it.each(['local','policy','grant','job'])('keeps the final original %s fence after admission and awaited worker authority',async outcome=>{
 const write=vi.spyOn(Duplex.prototype,'end'),f=await setup(),{ready,resume,spy}=holdAdmissionResponse('/worker-current');
 try {
  const command=await f.start();await ready;
  if(outcome==='local')f.revoke();
  if(outcome==='grant'){const {expiresAt:_,...grant}=f.grant;f.call('secrets.revoke',grant);}
  if(outcome==='policy')f.app.db.prepare("INSERT OR REPLACE INTO secrets_meta(key,value) VALUES ('policy','replacement')").run();
  if(outcome==='job')f.job({claimedAt:f.clock.now()+1});
  resume();expect(await command.delivery).toBe(false);expect(await command.completed).toBe(false);
  expect(write.mock.calls.some(args=>Buffer.isBuffer(args[0])&&args[0].toString()==='synthetic-admitted-value')).toBe(false);expect(existsSync(f.marker)).toBe(false);
 }finally{resume();spy.mockRestore();}
});
it('retires and drains original admission when listener closes during holder dispatch',async()=>{
 const f=await setup();let entered!:()=>void,resume!:()=>void;const ready=new Promise<void>(r=>{entered=r;}),wait=new Promise<void>(r=>{resume=r;});
 f.source.mockImplementation(async()=>{entered();await wait;return Buffer.from('synthetic-admitted-value');});
 const command=await f.start();try {await ready;const id=await f.admitted(),closing=f.listener.close();expect(f.state(id)).toEqual({state:'uncertain'});resume();await closing;expect(await command.delivery).toBe(false);expect(await command.completed).toBe(false);expect(existsSync(f.marker)).toBe(false);}finally{resume();}
});

it('expires the actual command during admission, closes its client and retires the undispatched original',async()=>{
 const f=await setup(),{ready,resume,spy}=holdAdmissionResponse('/admit');f.request.expiresAt=Date.now()+600;
 try {const command=await f.start();await ready;const id=await f.admitted();expect(await command.completed).toBe(false);expect(await command.delivery).toBe(false);await expect.poll(()=>f.state(id)).toEqual({state:'uncertain'});expect(f.source).not.toHaveBeenCalled();expect(existsSync(f.marker)).toBe(false);}finally{resume();spy.mockRestore();}
});
it('reports generic admission setup failure and drains the real already-started command',async()=>{
 const f=await setup(),kill=vi.spyOn(ChildProcess.prototype,'kill');f.config.admission.socket='PRIVATE-relative-socket';
 const error=await startAdmittedSecretCommand(f.config,f.request).catch(e=>e as Error);
 expect(error.message).toBe('Worker admission unavailable');expect(error.stack).not.toContain('PRIVATE');expect(kill).toHaveBeenCalledWith('SIGKILL');
 for(const child of kill.mock.contexts)if(child.pid)expect(()=>process.kill(child.pid!,0)).toThrow();expect(existsSync(f.marker)).toBe(false);
});
