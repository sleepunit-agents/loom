import { afterEach, expect, it, vi } from 'vitest';
import { mkdtempSync, readFileSync, writeFileSync, rmSync, chmodSync } from 'node:fs';
import { X509Certificate, randomUUID } from 'node:crypto';
import { Writable } from 'node:stream';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import https from 'node:https';
import { ServerResponse } from 'node:http';
import { createServer as netServer, connect as netConnect } from 'node:net';
import { connect as tlsConnect } from 'node:tls';
import { workerSecretInputs } from './secret-input.js';
import { listenWorkerSecretInput, workerSecretTransport } from './secret-transport.js';
const closes:Array<()=>unknown>=[];
afterEach(async()=>{vi.useRealTimers();vi.restoreAllMocks();for(const close of closes.splice(0).reverse())await close();});
function deferred<T>() {let resolve!:(v:T)=>void;const promise=new Promise<T>(r=>{resolve=r;});return {promise,resolve};}
async function setup() {
 const home=mkdtempSync(join(tmpdir(),'loom-worker-input-'));closes.push(()=>rmSync(home,{recursive:true,force:true}));
 const fixtures=fileURLToPath(new URL('../pieces/secrets/fixtures/holder-tls/',import.meta.url));
 for(const name of ['ca.pem','holder.pem','holder.key','daemon.pem','daemon.key','stranger.pem','stranger.key'])writeFileSync(join(home,name),readFileSync(join(fixtures,name)),{mode:0o600});
 // Fixture names denote certificates, not deployment roles: holder.pem is the
 // worker server certificate here, daemon.pem is the sending holder process.
 const common={socket:join(home,'worker.sock'),ca:join(home,'ca.pem')};
 const serverConfig={...common,cert:join(home,'holder.pem'),key:join(home,'holder.key')};
 const clientConfig={...common,cert:join(home,'daemon.pem'),key:join(home,'daemon.key'),servername:'holder.test'};
 const fingerprint=(name:string)=>new X509Certificate(readFileSync(join(home,`${name}.pem`))).fingerprint256;
 const inputs=workerSecretInputs(),received:string[]=[],borrowed:Buffer[]=[];
 const input=new Writable({write(b,_e,done){received.push(b.toString());borrowed.push(b);done();}});
 const binding={agent:'art',job:randomUUID(),runner:'runner',box:'box',claimedAt:10,service:'work'};
 const current=vi.fn(()=>true),authority=vi.fn(async()=>true);
 const pending=inputs.register(binding,input,current,authority,Date.now()+30_000);
 const server=await listenWorkerSecretInput(serverConfig,fingerprint('daemon'),inputs);closes.push(server.close);
 const client=workerSecretTransport(clientConfig,fingerprint('holder'));closes.push(client.close);
 return {home,serverConfig,clientConfig,fingerprint,inputs,received,borrowed,binding,current,authority,pending,server,client};
}
it('delivers through real pinned mutual TLS to the original worker stream, returning an empty ack',async()=>{
 const f=await setup(),bytes=Buffer.from('WORKER-SECRET-SENTINEL');
 expect(await f.client.deliver(f.pending.id,f.binding,bytes)).toBeUndefined();
 expect(f.received).toEqual(['WORKER-SECRET-SENTINEL']);expect(f.borrowed[0].every(b=>b===0)).toBe(true);
 expect(f.authority).toHaveBeenCalledOnce();expect(bytes.toString()).toBe('WORKER-SECRET-SENTINEL');
 await expect(f.client.deliver(f.pending.id,f.binding,bytes)).rejects.toThrow(/^Worker secret delivery unavailable$/);
 expect(f.received).toHaveLength(1);
});
it('rejects a CA-valid client whose certificate differs from the configured holder pin',async()=>{
 const f=await setup();await f.server.close();
 const inputs=workerSecretInputs(),received:string[]=[];
 const pending=inputs.register(f.binding,new Writable({write(b,_e,done){received.push(b.toString());done();}}),()=>true,f.authority,Date.now()+20_000);
 const server=await listenWorkerSecretInput(f.serverConfig,f.fingerprint('holder'),inputs);closes.push(server.close);
 await expect(f.client.deliver(pending.id,f.binding,Buffer.from('SECRET'))).rejects.toThrow();
 expect(f.authority).not.toHaveBeenCalled();expect(received).toEqual([]);
 // Authentication rejection must not consume the worker's pending capability.
 expect(inputs.claim(pending.id,f.binding)).not.toBeNull();
});
it('rejects an untrusted client certificate before worker authority',async()=>{
 const f=await setup();
 const wrong=workerSecretTransport({...f.clientConfig,cert:join(f.home,'stranger.pem'),key:join(f.home,'stranger.key')},f.fingerprint('holder'));closes.push(wrong.close);
 await expect(wrong.deliver(f.pending.id,f.binding,Buffer.from('SECRET'))).rejects.toThrow();
 expect(f.authority).not.toHaveBeenCalled();await f.client.deliver(f.pending.id,f.binding,Buffer.from('RIGHT'));expect(f.received).toEqual(['RIGHT']);
});

it('pins the worker before sending any HTTP metadata or bytes, even to a CA-valid server',async()=>{
 const f=await setup();await f.server.close();
 const handler=vi.fn((_req:unknown,res:ServerResponse)=>{res.writeHead(204,{'content-length':0});res.end();});
 const server=https.createServer({ca:readFileSync(f.serverConfig.ca),cert:readFileSync(f.serverConfig.cert),key:readFileSync(f.serverConfig.key),requestCert:true,rejectUnauthorized:true},handler);
 await new Promise<void>(resolve=>server.listen(f.serverConfig.socket,resolve));chmodSync(f.serverConfig.socket,0o600);
 closes.push(()=>new Promise<void>(resolve=>{server.closeAllConnections();server.close(()=>resolve());}));
 const wrong=workerSecretTransport(f.clientConfig,f.fingerprint('daemon'));closes.push(wrong.close);
 await expect(wrong.deliver(f.pending.id,f.binding,Buffer.from('SECRET'))).rejects.toThrow();expect(handler).not.toHaveBeenCalled();
});
it.each(['binding','id'] as const)('refuses incorrect pending %s without delivering',async what=>{
 const f=await setup();
 await expect(f.client.deliver(what==='id'?randomUUID():f.pending.id,what==='binding'?{...f.binding,claimedAt:11}:f.binding,Buffer.from('SECRET'))).rejects.toThrow();
 expect(f.received).toEqual([]);expect(f.authority).not.toHaveBeenCalled();
 if(what==='binding')await expect(f.client.deliver(f.pending.id,f.binding,Buffer.from('SECRET'))).rejects.toThrow();
});
it.each(['revoke','replacement','shutdown','authority','disconnect'] as const)('fences %s after transport bytes arrive but before final worker release',async phase=>{
 const f=await setup(),entered=deferred<void>(),release=deferred<boolean>();
 f.authority.mockImplementationOnce(async()=>{entered.resolve();return release.promise;});
 const result=f.client.deliver(f.pending.id,f.binding,Buffer.from('SECRET')).catch(e=>e);await entered.promise;
 let closing:Promise<void>|undefined;
 if(phase==='revoke')f.current.mockReturnValue(false);
 if(phase==='replacement')f.pending.cancel();
 if(phase==='shutdown')closing=f.server.close();
 if(phase==='disconnect'){
  const disconnected=deferred<void>(),emit=ServerResponse.prototype.emit;
  vi.spyOn(ServerResponse.prototype,'emit').mockImplementation(function(this:ServerResponse,event,...args){
   const value=Reflect.apply(emit,this,[event,...args]);if(event==='close')disconnected.resolve();return value;
  });
  await f.client.close();await disconnected.promise;
 }
 release.resolve(phase!=='authority');expect(await result).toBeInstanceOf(Error);await closing;
 expect(f.received).toEqual([]);expect(f.inputs.claim(f.pending.id,f.binding)).toBeNull();
});
it('lost acknowledgement does not permit a second write',async()=>{
 const f=await setup(),end=ServerResponse.prototype.end;
 vi.spyOn(ServerResponse.prototype,'end').mockImplementation(function(this:ServerResponse,...args:Parameters<typeof end>){
  if(this.statusCode===204){this.destroy();return this;}
  return Reflect.apply(end,this,args);
 });
 await expect(f.client.deliver(f.pending.id,f.binding,Buffer.from('SECRET'))).rejects.toThrow();
 expect(f.received).toEqual(['SECRET']);
 await expect(f.client.deliver(f.pending.id,f.binding,Buffer.from('SECRET'))).rejects.toThrow();expect(f.received).toHaveLength(1);
});
it.each(['tls','headers','body'] as const)('bounds slow %s from connection acceptance without relying on the sending client',async phase=>{
 const f=await setup();vi.useFakeTimers({toFake:['setTimeout','clearTimeout','Date']});
 const connected=deferred<void>(),closed=deferred<void>();
 const peer=phase==='tls'?netConnect(f.clientConfig.socket,()=>connected.resolve()):tlsConnect({path:f.clientConfig.socket,servername:f.clientConfig.servername,
  ca:readFileSync(f.clientConfig.ca),cert:readFileSync(f.clientConfig.cert),key:readFileSync(f.clientConfig.key)},()=>{
   const header=Buffer.from(JSON.stringify(f.binding)).toString('base64url');
   peer.write(`POST /v1/input/${f.pending.id} HTTP/1.1\r\nHost: holder.test\r\nContent-Length: 6\r\nx-loom-binding: ${header}\r\n${phase==='body'?'\r\nx':''}`);connected.resolve();
  });
 peer.on('error',()=>{});peer.on('close',()=>closed.resolve());
 try {await connected.promise;await vi.advanceTimersByTimeAsync(5000);await closed.promise;expect(f.received).toEqual([]);expect(f.authority).not.toHaveBeenCalled();}
 finally {peer.destroy();vi.useRealTimers();}
});
it('absolute connection deadline fences pending authority even before network close propagates',async()=>{
 const f=await setup(),entered=deferred<void>(),release=deferred<boolean>();
 f.authority.mockImplementationOnce(async()=>{entered.resolve();return release.promise;});
 vi.useFakeTimers({toFake:['setTimeout','clearTimeout','Date']});
 const result=f.client.deliver(f.pending.id,f.binding,Buffer.from('SECRET')).catch(e=>e);await entered.promise;
 await vi.advanceTimersByTimeAsync(5000);release.resolve(true);
 expect(await result).toBeInstanceOf(Error);await f.server.close();expect(f.received).toEqual([]);
});
it('reserves before awaiting a partial authenticated body, excluding another delivery immediately',async()=>{
 const f=await setup(),claim=vi.spyOn(f.inputs,'claim');
 const peer=tlsConnect({path:f.clientConfig.socket,servername:f.clientConfig.servername,ca:readFileSync(f.clientConfig.ca),cert:readFileSync(f.clientConfig.cert),key:readFileSync(f.clientConfig.key)},()=>{
  const header=Buffer.from(JSON.stringify(f.binding)).toString('base64url');
  peer.write(`POST /v1/input/${f.pending.id} HTTP/1.1\r\nHost: holder.test\r\nContent-Length: 6\r\nx-loom-binding: ${header}\r\n\r\nx`);
 });peer.on('error',()=>{});
 try {
  await vi.waitFor(()=>expect(claim).toHaveBeenCalledOnce());
  expect(f.inputs.claim(f.pending.id,f.binding)).toBeNull();expect(f.authority).not.toHaveBeenCalled();
  peer.write('yyyyy');await vi.waitFor(()=>expect(f.received).toEqual(['xyyyyy']));
 }finally {peer.destroy();}
});
it.each(['tls','ack'] as const)('holder deadline independently bounds a worker stalled at %s',async phase=>{
 const f=await setup();await f.server.close();
 const entered=deferred<void>(),sockets=new Set<import('node:net').Socket>();
 const server=phase==='tls'?netServer(()=>entered.resolve()):https.createServer({ca:readFileSync(f.serverConfig.ca),cert:readFileSync(f.serverConfig.cert),key:readFileSync(f.serverConfig.key),requestCert:true,rejectUnauthorized:true},req=>{req.resume();req.on('end',()=>entered.resolve());});
 server.on('connection',socket=>{sockets.add(socket);socket.on('close',()=>sockets.delete(socket));});
 await new Promise<void>(resolve=>server.listen(f.serverConfig.socket,resolve));chmodSync(f.serverConfig.socket,0o600);
 closes.push(()=>new Promise<void>(resolve=>{for(const socket of sockets)socket.destroy();server.close(()=>resolve());}));
 vi.useFakeTimers({toFake:['setTimeout','clearTimeout','Date']});
 const result=f.client.deliver(f.pending.id,f.binding,Buffer.from('SECRET')).catch(e=>e);await entered.promise;
 await vi.advanceTimersByTimeAsync(5000);expect(await result).toBeInstanceOf(Error);
});
it('rejects an oversized raw authenticated body before reserving or invoking authority',async()=>{
 const f=await setup(),claim=vi.spyOn(f.inputs,'claim');
 const status=await new Promise<number|undefined>((resolve,reject)=>{
  const req=https.request({socketPath:f.clientConfig.socket,servername:f.clientConfig.servername,ca:readFileSync(f.clientConfig.ca),cert:readFileSync(f.clientConfig.cert),key:readFileSync(f.clientConfig.key),method:'POST',path:`/v1/input/${f.pending.id}`,
   headers:{'content-length':65537,'x-loom-binding':Buffer.from(JSON.stringify(f.binding)).toString('base64url')}},res=>{res.resume();res.on('end',()=>resolve(res.statusCode));});
  req.on('error',reject);req.end(Buffer.alloc(65537));
 });
 expect(status).toBe(503);expect(claim).not.toHaveBeenCalled();expect(f.authority).not.toHaveBeenCalled();expect(f.received).toEqual([]);
});
