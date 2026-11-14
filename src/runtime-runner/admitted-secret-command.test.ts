import {afterEach,expect,it,vi} from 'vitest';
import {existsSync,readFileSync,chmodSync} from 'node:fs';
import https from 'node:https';
import {connect} from 'node:tls';
import {tlsMaterial} from '../pieces/secrets/local-holder.js';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {ServerResponse} from 'node:http';
import {Duplex} from 'node:stream';
import {ticketAuthorityFixture} from './ticket-authority.fixture.js';
import {startAdmittedSecretCommand} from './admitted-secret-command.js';
import {listenWorkerAdmission,workerAdmission} from '../pieces/secrets/worker-admission.js';
import {listenTicketAuthority} from '../pieces/secrets/ticket-authority.js';
import {localHolderHandoff,listenHolderHandoff} from '../pieces/secrets/holder-handoff.js';
import {routedHolderAuthority} from '../pieces/secrets/holder-routing.js';
import {workerSecretTransport} from './secret-transport.js';
const closes:Array<()=>unknown>=[];
afterEach(async()=>{vi.restoreAllMocks();for(const close of closes.splice(0).reverse())await close();});
async function setup(releaseStaging=true) {
 const f=await ticketAuthorityFixture(closes);
 const binding={agent:'art',job:f.id,runner:'worker',box:'worker',claimedAt:f.clock.now()};
 await f.authority.close();
 const central=await listenTicketAuthority(f.server,f.fingerprint('holder'),f.tickets,[{fingerprint:f.fingerprint('daemon'),binding}]);closes.push(central.close);
 const holderSocket=join(f.home,'admitted-holder.sock');
 const client=localHolderHandoff({...f.server,socket:holderSocket,servername:'holder.test'},f.fingerprint('holder'));closes.push(client.close);
 const input=join(f.home,'admitted-input.sock');
 const transport=workerSecretTransport({...f.config,socket:input},f.fingerprint('daemon'));closes.push(transport.close);
 const source=vi.fn(async()=>Buffer.from('synthetic-admitted-value'));
 const holder=await listenHolderHandoff({...f.config,socket:holderSocket},{read:source},f.fingerprint('daemon'),routedHolderAuthority(f.remote,[{binding,transport}]));closes.push(holder.close);
 const socket=join(f.home,'admission.sock');
 const peer={fingerprint:f.fingerprint('daemon'),binding:{...binding},viewer:f.viewer,holder:client};
 const listener=await listenWorkerAdmission({...f.server,socket},f.tickets,[peer]);closes.push(listener.close);
 // Release only the synthetic staging effect, before admission reply reaches
 // the real worker. This is an owner action, not a transport retry or claim.
 if(releaseStaging) {
  const writeHead=ServerResponse.prototype.writeHead;
  vi.spyOn(ServerResponse.prototype,'writeHead').mockImplementation(function(this:ServerResponse,...args:Parameters<ServerResponse['writeHead']>){
   if(this.req.url?.endsWith('/admit')&&args[0]===200) {
    const row=f.app.db.prepare('SELECT id FROM secrets_tickets').get() as {id:string};
    expect(f.tickets.claim(row.id)).toBeNull();f.release(row.id);
   }
   return Reflect.apply(writeHead,this,args);
  });
 }
 const marker=join(f.home,'consumer-metadata');
 const script="const fs=require('node:fs');let b=[];fs.createReadStream(null,{fd:3}).on('data',v=>b.push(v)).on('end',()=>{const ok=Buffer.concat(b).toString()==='synthetic-admitted-value';fs.writeFileSync(process.argv[1],ok?'accepted':'wrong');setTimeout(()=>process.exit(ok?0:1),200);});";
 const config={command:process.execPath,args:['-e',script,marker],cwd:f.home,env:{},
  input:{...f.server,socket:input},holderFingerprint:f.fingerprint('holder'),authority:{...f.config,cert:f.server.cert,key:f.server.key},
  daemonFingerprint:f.fingerprint('daemon'),admission:{...f.config,socket,cert:f.server.cert,key:f.server.key}};
 let current=true;
 const request={name:'API',binding,current:()=>current,expiresAt:Date.now()+20_000};
 const start=async()=>{const c=await startAdmittedSecretCommand(config,request);closes.push(c.close);return c;};
 const admitted=async()=>{
  await expect.poll(()=>f.app.db.prepare('SELECT id FROM secrets_tickets').get()).toBeTruthy();
  return (f.app.db.prepare('SELECT id FROM secrets_tickets').get() as {id:string}).id;
 };
 return {...f,binding,config,request,peer,listener,marker,source,start,admitted,revoke(){current=false;}};
}
it('admits the real original command over pinned worker TLS, binds once, then dispatches retained daemon completion',async()=>{
 const f=await setup(),command=await f.start(),id=await f.admitted();
 expect(await command.delivery).toBe(true);expect(await command.completed).toBe(true);
 expect(readFileSync(f.marker,'utf8')).toBe('accepted');expect(f.state(id)).toEqual({state:'released'});expect(f.source).toHaveBeenCalledTimes(1);
});
it.each(['local','grant','job','policy'] as const)('fences original %s replacement during the admission reply await',async outcome=>{
 const f=await setup();let entered!:()=>void,resume!:()=>void;
 const ready=new Promise<void>(r=>{entered=r;}),wait=new Promise<void>(r=>{resume=r;});
 const end=ServerResponse.prototype.end;
 const spy=vi.spyOn(ServerResponse.prototype,'end').mockImplementation(function(this:ServerResponse,...args:Parameters<ServerResponse['end']>){
  if(this.req.url?.endsWith('/admit')&&this.statusCode===200){entered();void wait.then(()=>end.apply(this,args));return this;}
  return end.apply(this,args);
 });
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
 const starting=f.start();f.config.admission.socket=join(f.home,'replaced.sock');f.request.name='REPLACED';
 const command=await starting,id=await f.admitted();
 expect(await command.delivery).toBe(true);expect(await command.completed).toBe(true);expect(readFileSync(f.marker,'utf8')).toBe('accepted');
});
it.each(['peer','pin','assignment'] as const)('refuses %s before secret source or command release',async outcome=>{
 const f=await setup();
 if(outcome==='peer'){f.config.admission.cert=join(f.home,'stranger.pem');f.config.admission.key=join(f.home,'stranger.key');}
 if(outcome==='pin')f.config.daemonFingerprint=f.fingerprint('holder');
 if(outcome==='assignment')f.job({claimedAt:f.clock.now()+1});
 const command=await f.start();expect(await command.delivery).toBe(false);expect(await command.completed).toBe(false);
 expect(existsSync(f.marker)).toBe(false);expect(f.source).not.toHaveBeenCalled();
 expect(f.app.db.prepare('SELECT count(*) AS n FROM secrets_tickets').get()).toEqual({n:0});
});
it('cancels startup while admission response is delayed, and never sends readiness after shutdown',async()=>{
 const f=await setup();let entered!:()=>void,resume!:()=>void;
 const ready=new Promise<void>(r=>{entered=r;}),wait=new Promise<void>(r=>{resume=r;});const end=ServerResponse.prototype.end;
 const spy=vi.spyOn(ServerResponse.prototype,'end').mockImplementation(function(this:ServerResponse,...args:Parameters<ServerResponse['end']>){
  if(this.req.url?.endsWith('/admit')&&this.statusCode===200){entered();void wait.then(()=>end.apply(this,args));return this;}
  return end.apply(this,args);
 });
 try {
  const command=await f.start();await ready;const id=await f.admitted();await command.close();
  expect(await command.delivery).toBe(false);expect(await command.completed).toBe(false);
  await expect.poll(()=>f.state(id)).toEqual({state:'uncertain'});
  expect(existsSync(f.marker)).toBe(false);expect(f.source).not.toHaveBeenCalled();
 }finally{resume();spy.mockRestore();}
});
it('retains original admission separately, rejects replay, and retires it on listener shutdown',async()=>{
 const f=await setup(),pending=randomUUID();
 const client=workerAdmission(f.config.admission,f.fingerprint('daemon'),pending);closes.push(client.close);
 const id=await client.admit('API');expect(f.state(id)).toEqual({state:'admitted'});
 await expect(client.admit('API')).rejects.toThrow('Worker admission unavailable');
 const replay=workerAdmission(f.config.admission,f.fingerprint('daemon'),pending);closes.push(replay.close);
 await expect(replay.admit('API')).rejects.toThrow('Worker admission unavailable');
 await f.listener.close();expect(f.state(id)).toEqual({state:'uncertain'});
 await expect(client.dispatch()).rejects.toThrow();expect(f.source).not.toHaveBeenCalled();
});
it('closes an admitted original request without dispatch or retry',async()=>{
 const f=await setup(),client=workerAdmission(f.config.admission,f.fingerprint('daemon'),randomUUID());closes.push(client.close);
 const id=await client.admit('API');await client.close();expect(f.state(id)).toEqual({state:'uncertain'});
 await expect(client.dispatch()).rejects.toThrow();expect(f.source).not.toHaveBeenCalled();
});
it('drains native pipe cancellation without resuming an externally held completion callback',async()=>{
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
  await command.close(); // Held callback intentionally remains held until finally.
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
it('refuses a copied authenticated viewer and duplicate configured worker pins',async()=>{
 const f=await setup();await f.listener.close();
 await expect(listenWorkerAdmission({...f.config.input,socket:f.config.admission.socket},f.tickets,[f.peer,f.peer])).rejects.toThrow('Worker admission unavailable');
 const listener=await listenWorkerAdmission({...f.config.input,socket:f.config.admission.socket},f.tickets,[{...f.peer,viewer:{...f.viewer}}]);closes.push(listener.close);
 const command=await f.start();expect(await command.delivery).toBe(false);expect(f.source).not.toHaveBeenCalled();
 expect(f.app.db.prepare('SELECT count(*) AS n FROM secrets_tickets').get()).toEqual({n:0});
});

it('expires undispatched original admission and refuses subsequent dispatch',async()=>{
 const f=await setup(),set=globalThis.setTimeout;
 vi.spyOn(globalThis,'setTimeout').mockImplementation(((fn:()=>void,ms?:number,...args:unknown[])=>set(fn,ms===30_000?30:ms,...args)) as typeof setTimeout);
 const client=workerAdmission(f.config.admission,f.fingerprint('daemon'),randomUUID());closes.push(client.close);
 const id=await client.admit('API');await expect.poll(()=>f.state(id),{timeout:500}).toEqual({state:'uncertain'});
 await expect(client.dispatch()).rejects.toThrow();expect(f.source).not.toHaveBeenCalled();
});
it('enforces the server deadline independently for authenticated partial headers',async()=>{
 const f=await setup(),set=globalThis.setTimeout;
 vi.spyOn(globalThis,'setTimeout').mockImplementation(((fn:()=>void,ms?:number,...args:unknown[])=>set(fn,ms===5000?40:ms,...args)) as typeof setTimeout);
 const socket=connect({path:f.config.admission.socket,...tlsMaterial(f.config.admission),servername:'daemon.test',minVersion:'TLSv1.3'});closes.push(()=>socket.destroy());socket.on('error',()=>{});
 await new Promise<void>(resolve=>socket.once('secureConnect',resolve));socket.write('POST /v1/admission/');
 await expect.poll(()=>socket.destroyed,{timeout:500}).toBe(true);
 expect(f.app.db.prepare('SELECT count(*) AS n FROM secrets_tickets').get()).toEqual({n:0});
});
it('enforces the client deadline independently for an incomplete authenticated reply',async()=>{
 const f=await setup(false),socket=join(f.home,'stalled-admission.sock');
 const server=https.createServer({...tlsMaterial(f.config.input),requestCert:true,rejectUnauthorized:true},(_req,res)=>{res.writeHead(200,{'content-length':108});res.flushHeaders();});
 await new Promise<void>(resolve=>server.listen(socket,resolve));chmodSync(socket,0o600);
 closes.push(()=>new Promise<void>(resolve=>{server.closeAllConnections();server.close(()=>resolve());}));
 const set=globalThis.setTimeout;vi.spyOn(globalThis,'setTimeout').mockImplementation(((fn:()=>void,ms?:number,...args:unknown[])=>set(fn,ms===5000?40:ms,...args)) as typeof setTimeout);
 const client=workerAdmission({...f.config.admission,socket},f.fingerprint('daemon'),randomUUID());closes.push(client.close);
 await expect(Promise.race([client.admit('API'),new Promise(resolve=>setTimeout(()=>resolve('still pending'),500))])).rejects.toThrow('Worker admission unavailable');
 await expect(client.admit('API')).rejects.toThrow();expect(f.source).not.toHaveBeenCalled();
});
it.each(['body','chunked','headers'])('rejects authenticated malformed %s before admission',async mode=>{
 const f=await setup();
 const status=await new Promise<number>((resolve,reject)=>{
  const req=https.request({...tlsMaterial(f.config.admission),socketPath:f.config.admission.socket,servername:'daemon.test',agent:false,method:'POST',path:`/v1/admission/${randomUUID()}/admit`,
   headers:{'x-loom-name':'API',...(mode==='chunked'?{'transfer-encoding':'chunked'}:{'content-length':mode==='body'?1:0}),...(mode==='headers'?{'x-extra':'x'.repeat(9000)}:{})}},res=>{res.resume();res.on('end',()=>resolve(res.statusCode!));});req.on('error',reject);req.end(mode==='headers'?undefined:'x');
 });
 expect([431,503]).toContain(status);expect(f.app.db.prepare('SELECT count(*) AS n FROM secrets_tickets').get()).toEqual({n:0});expect(f.source).not.toHaveBeenCalled();
});
it.each(['oversize','chunked','length'])('rejects malformed admission reply %s without worker release',async mode=>{
 const f=await setup(false),writeHead=ServerResponse.prototype.writeHead,end=ServerResponse.prototype.end;
 const spy=vi.spyOn(ServerResponse.prototype,'writeHead').mockImplementation(function(this:ServerResponse,...args:Parameters<ServerResponse['writeHead']>){
  if(this.req.url?.endsWith('/admit')&&args[0]===200){const headers=args[1] as Record<string,string|number>;if(mode==='chunked'){delete headers['content-length'];headers['transfer-encoding']='chunked';}else headers['content-length']=mode==='oversize'?999:0;}
  return Reflect.apply(writeHead,this,args);
 });
 const endSpy=vi.spyOn(ServerResponse.prototype,'end').mockImplementation(function(this:ServerResponse,...args:Parameters<ServerResponse['end']>){
  if(mode==='oversize'&&this.req.url?.endsWith('/admit')&&this.statusCode===200)args[0]=(args[0] as string).padEnd(999,' ');
  return end.apply(this,args);
 });
 const client=workerAdmission(f.config.admission,f.fingerprint('daemon'),randomUUID());closes.push(client.close);
 try {await expect(client.admit('API')).rejects.toThrow('Worker admission unavailable');expect(f.source).not.toHaveBeenCalled();}finally{endSpy.mockRestore();spy.mockRestore();}
});
