import {afterEach,expect,it,vi} from 'vitest';
import {chmodSync} from 'node:fs';
import https from 'node:https';
import {connect} from 'node:tls';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {ServerResponse} from 'node:http';
import {tlsMaterial} from './local-holder.js';
import {listenWorkerAdmission,workerAdmission} from './worker-admission.js';
import {admissionFixture} from '../../runtime-runner/worker-admission.fixture.js';
const closes:Array<()=>unknown>=[];
afterEach(async()=>{vi.restoreAllMocks();for(const close of closes.splice(0).reverse())await close();});
const setup=(releaseStaging=true)=>admissionFixture(closes,releaseStaging);
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
it('refuses a copied authenticated viewer and duplicate configured worker pins',async()=>{
 const f=await setup();await f.listener.close();
 await expect(listenWorkerAdmission({...f.config.input,socket:f.config.admission.socket},f.tickets,Array(1025).fill(f.peer))).rejects.toThrow('Worker admission unavailable');
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
it('keeps admission dispatch and cancellation exclusive to the original configured peer and ticket',async()=>{
 const f=await setup(false);await f.listener.close();
 const listener=await listenWorkerAdmission({...f.config.input,socket:f.config.admission.socket},f.tickets,[f.peer,{...f.peer,fingerprint:f.fingerprint('stranger')}]);closes.push(listener.close);
 const pending=randomUUID(),client=workerAdmission(f.config.admission,f.fingerprint('daemon'),pending);closes.push(client.close);const id=await client.admit('API');
 for(const [peer,ticket] of [['stranger',id],['daemon',randomUUID()]])for(const action of ['dispatch','cancel']) {
  const status=await new Promise<number>((resolve,reject)=>{
   const req=https.request({...tlsMaterial({...f.config.admission,cert:join(f.home,`${peer}.pem`),key:join(f.home,`${peer}.key`)}),socketPath:f.config.admission.socket,servername:'daemon.test',agent:false,method:'POST',path:`/v1/admission/${pending}/${action}`,headers:{'content-length':0,'x-loom-ticket':ticket}},res=>{res.resume();res.on('end',()=>resolve(res.statusCode!));});req.on('error',reject);req.end();
  });
  expect(status).toBe(503);expect(f.state(id)).toEqual({state:'admitted'});expect(f.source).not.toHaveBeenCalled();
 }
 await client.close();expect(f.state(id)).toEqual({state:'uncertain'});
});
