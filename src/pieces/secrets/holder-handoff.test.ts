import { afterEach, expect, it, vi } from 'vitest';
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { X509Certificate, randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import https from 'node:https';
import { ServerResponse, type IncomingMessage } from 'node:http';
import { connect as netConnect } from 'node:net';
import { connect as tlsConnect } from 'node:tls';
import { startLoom } from '../../foundation.js';
import { fixture } from '../../fixture.js';
import { FakeClock } from '../../core/clock.js';
import { listenHolderHandoff, localHolderHandoff, type HolderDestination } from './holder-handoff.js';
const closes: Array<()=>unknown> = [];
afterEach(async()=>{vi.useRealTimers();for(const close of closes.splice(0).reverse())await close();vi.restoreAllMocks();});
function deferred<T>() {let resolve!:(value:T)=>void; const promise=new Promise<T>(r=>{resolve=r;});return {promise,resolve};}
async function setup() {
 const home=mkdtempSync(join(tmpdir(),'loom-handoff-'));closes.push(()=>rmSync(home,{recursive:true,force:true}));
 const daemonHome=join(home,'daemon');fixture(daemonHome);
 const app=await startLoom({home:daemonHome,next:true,staging:true,host:'127.0.0.1',port:0,clock:new FakeClock(),stdout(){}});closes.push(()=>app.close());
 for(const op of ['secrets.houseGet','secrets.get','secrets.handTo'])expect(app.operations.has(op)).toBe(false);
 const fixtures=fileURLToPath(new URL('./fixtures/holder-tls/',import.meta.url));
 for(const name of ['ca.pem','holder.pem','holder.key','daemon.pem','daemon.key','stranger.pem','stranger.key'])writeFileSync(join(home,name),readFileSync(join(fixtures,name)),{mode:0o600});
 const common={socket:join(home,'handoff.sock'),ca:join(home,'ca.pem')};
 const server={...common,cert:join(home,'holder.pem'),key:join(home,'holder.key')};
 const config={...common,cert:join(home,'daemon.pem'),key:join(home,'daemon.key'),servername:'holder.test'};
 const fingerprint=(name:string)=>new X509Certificate(readFileSync(join(home,`${name}.pem`))).fingerprint256;
 const id=randomUUID(), bytes=Buffer.from('HANDOFF-SECRET-SENTINEL');
 const read=vi.fn(async()=>bytes),current=vi.fn(async()=>true),handTo=vi.fn(async(_b:Uint8Array)=>{});
 const destination:HolderDestination={name:'API',current,handTo};
 const authority=vi.fn(async(ticket:string)=>ticket===id?destination:null);
 const holder=await listenHolderHandoff(server,{read},fingerprint('daemon'),authority);closes.push(holder.close);
 const client=localHolderHandoff(config,fingerprint('holder'));closes.push(client.close);
 return {home,config,server,fingerprint,id,bytes,read,current,handTo,destination,authority,holder,client};
}
it('hands bytes only to the authorized destination and acknowledges metadata through real pinned mutual TLS',async()=>{
 const f=await setup(),received=deferred<void>(),release=deferred<void>();
 f.handTo.mockImplementationOnce(async b=>{expect(b).toBe(f.bytes);expect(Buffer.from(b).toString()).toBe('HANDOFF-SECRET-SENTINEL');received.resolve();await release.promise;});
 const pending=f.client.handTo(f.id);await received.promise;
 expect(f.bytes.toString()).toBe('HANDOFF-SECRET-SENTINEL');
 release.resolve();expect(await pending).toBeUndefined();
 expect(f.bytes.every(b=>b===0)).toBe(true);expect(f.authority).toHaveBeenCalledExactlyOnceWith(f.id);
 expect(f.read).toHaveBeenCalledExactlyOnceWith('API');expect(f.current).toHaveBeenCalledTimes(2);
});
it('refuses absent tickets, wrong peer pins, untrusted TLS and malformed tickets before reading',async()=>{
 const f=await setup();
 await expect(f.client.handTo(randomUUID())).rejects.toThrow(/^Secret handoff unavailable$/);
 await expect(f.client.handTo('../API')).rejects.toThrow(/^Secret handoff unavailable$/);
 for(const patch of [{servername:'wrong.test'},{cert:join(f.home,'stranger.pem'),key:join(f.home,'stranger.key')}]){
  const c=localHolderHandoff({...f.config,...patch},f.fingerprint('holder'));closes.push(c.close);
  await expect(c.handTo(f.id)).rejects.toThrow(/^Secret handoff unavailable$/);
 }
 const wrong=localHolderHandoff(f.config,f.fingerprint('daemon'));closes.push(wrong.close);
 await expect(wrong.handTo(f.id)).rejects.toThrow(/^Secret handoff unavailable$/);
 expect(f.handTo).not.toHaveBeenCalled();
});
it('fences authority loss during holder read, erases failure bytes and never echoes diagnostics',async()=>{
 const f=await setup();
 f.current.mockResolvedValueOnce(false);
 await expect(f.client.handTo(f.id)).rejects.toThrow(/^Secret handoff unavailable$/);expect(f.read).not.toHaveBeenCalled();
 f.read.mockImplementationOnce(async()=>{f.current.mockResolvedValue(false);return f.bytes;});
 await expect(f.client.handTo(f.id)).rejects.toThrow(/^Secret handoff unavailable$/);
 expect(f.handTo).not.toHaveBeenCalled();expect(f.bytes.every(b=>b===0)).toBe(true);
 f.current.mockResolvedValue(true);f.read.mockRejectedValueOnce(Error('HANDOFF-SECRET-SENTINEL'));
 await expect(f.client.handTo(f.id)).rejects.toThrow(/^Secret handoff unavailable$/);
 const bad=Buffer.alloc(65537,1);f.read.mockResolvedValueOnce(bad);
 await expect(f.client.handTo(f.id)).rejects.toThrow(/^Secret handoff unavailable$/);expect(bad.every(b=>b===0)).toBe(true);
 f.read.mockResolvedValueOnce(Buffer.from('HANDOFF-SECRET-SENTINEL'));f.handTo.mockRejectedValueOnce(Error('HANDOFF-SECRET-SENTINEL'));
 await expect(f.client.handTo(f.id)).rejects.toThrow(/^Secret handoff unavailable$/);
 expect(f.handTo).toHaveBeenCalledOnce(); // No automatic retry after uncertain delivery.
});
it('holder pins the daemon certificate before invoking authority, even for a CA-valid peer',async()=>{
 const f=await setup();await f.holder.close();
 const holder=await listenHolderHandoff(f.server,{read:f.read},f.fingerprint('holder'),f.authority);closes.push(holder.close);
 await expect(f.client.handTo(f.id)).rejects.toThrow(/^Secret handoff unavailable$/);
 expect(f.authority).not.toHaveBeenCalled();expect(f.read).not.toHaveBeenCalled();
});
it('drains pending source work on holder close and fences late release; client close aborts pending requests',async()=>{
 const f=await setup(),entered=deferred<void>(),release=deferred<Buffer>();
 f.read.mockImplementationOnce(async()=>{entered.resolve();return release.promise;});
 const result=f.client.handTo(f.id).catch(e=>e);await entered.promise;
 let done=false;const close=f.holder.close().then(()=>{done=true;});
 await f.client.close();expect(done).toBe(false);
 release.resolve(f.bytes);await close;
 expect((await result).message).toBe('Secret handoff unavailable');expect(f.handTo).not.toHaveBeenCalled();expect(f.bytes.every(b=>b===0)).toBe(true);
 await expect(f.client.handTo(f.id)).rejects.toThrow(/^Secret handoff unavailable$/);
});
it('rejects malformed success responses without retaining or returning holder output',async()=>{
 const f=await setup();await f.holder.close();
 await fakeHolder(f,(_req,res)=>{res.writeHead(200,{'content-type':'application/octet-stream'});res.end('HANDOFF-SECRET-SENTINEL');});
 await expect(f.client.handTo(f.id)).rejects.toThrow(/^Secret handoff unavailable$/);
});
it('drains an already-started runner transfer before erasing its borrowed buffer',async()=>{
 const f=await setup(),entered=deferred<void>(),release=deferred<void>();
 f.handTo.mockImplementationOnce(async b=>{entered.resolve();await release.promise;expect(Buffer.from(b).toString()).toBe('HANDOFF-SECRET-SENTINEL');});
 const result=f.client.handTo(f.id).catch(e=>e);await entered.promise;
 let done=false;const close=f.holder.close().then(()=>{done=true;});
 await f.client.close();expect(done).toBe(false);expect(f.bytes.toString()).toBe('HANDOFF-SECRET-SENTINEL');
 release.resolve();await close;expect((await result).message).toBe('Secret handoff unavailable');expect(f.bytes.every(b=>b===0)).toBe(true);
});
it('refuses authority exceptions, invalid names and nonempty request bodies before source work',async()=>{
 const f=await setup();
 f.authority.mockRejectedValueOnce(Error('HANDOFF-SECRET-SENTINEL'));
 await expect(f.client.handTo(f.id)).rejects.toThrow(/^Secret handoff unavailable$/);
 f.destination.name='../API';await expect(f.client.handTo(f.id)).rejects.toThrow(/^Secret handoff unavailable$/);
 f.destination.name='API';
 for(const request of [{method:'GET',path:`/v1/handoff/${f.id}`,body:''},{method:'POST',path:`/v1/handoff/${f.id}`,body:'x'},{method:'POST',path:'/v1/handoff/not-a-ticket',body:''}]){
  const status=await new Promise<number|undefined>((resolve,reject)=>{
   const req=https.request({socketPath:f.config.socket,servername:f.config.servername,ca:readFileSync(f.config.ca),cert:readFileSync(f.config.cert),key:readFileSync(f.config.key),method:request.method,path:request.path,headers:{'content-length':Buffer.byteLength(request.body)}},res=>{res.resume();res.on('end',()=>resolve(res.statusCode));});req.on('error',reject);req.end(request.body);
  });expect(status).toBe(503);
 }
 expect(f.read).not.toHaveBeenCalled();expect(f.handTo).not.toHaveBeenCalled();
});

// Raw peers have no application deadline, so holder timeouts cannot be masked by
// the daemon client's own timeout. The outside peer stays beside the next home.
function rawPeer(f: Awaited<ReturnType<typeof setup>>, partial=false) {
 let closed=false;
 const responses:Buffer[]=[];
 const peer=tlsConnect({path:f.config.socket,servername:f.config.servername,
  ca:readFileSync(f.config.ca),cert:readFileSync(f.config.cert),key:readFileSync(f.config.key),minVersion:'TLSv1.3'},()=>{
   peer.write(`POST /v1/handoff/${f.id} HTTP/1.1\r\nHost: holder.test\r\nContent-Length: 0\r\nConnection: close\r\n${partial?'':'\r\n'}`);
  });
 peer.on('data',b=>responses.push(b));peer.on('error',()=>{});peer.on('close',()=>{closed=true;});
 closes.push(()=>{peer.destroy();});
 return {peer,responses,closed:()=>closed};
}
it('wrong CA-valid holder pin sends no ticket to the HTTP handler',async()=>{
 const f=await setup();await f.holder.close();const received=vi.fn((_req:IncomingMessage,res:ServerResponse)=>{res.writeHead(204,{'content-length':0});res.end();});
 await fakeHolder(f,received);
 const client=localHolderHandoff(f.config,f.fingerprint('daemon'));closes.push(client.close);
 await expect(client.handTo(f.id)).rejects.toThrow(/^Secret handoff unavailable$/);
 expect(received).not.toHaveBeenCalled();
});
it('client close independently aborts a live request and disconnect fences late source release',async()=>{
 const f=await setup(),entered=deferred<void>(),release=deferred<Buffer>();
 f.read.mockImplementationOnce(async()=>{entered.resolve();return release.promise;});
 const disconnected=deferred<void>(),emit=ServerResponse.prototype.emit;
 vi.spyOn(ServerResponse.prototype,'emit').mockImplementation(function(this:ServerResponse,event,...args){
  const result=Reflect.apply(emit,this,[event,...args]);if(event==='close'&&this.req.url===`/v1/handoff/${f.id}`)disconnected.resolve();return result;
 });
 const pending=f.client.handTo(f.id).catch(e=>e);await entered.promise;
 await f.client.close();await disconnected.promise;expect((await pending).message).toBe('Secret handoff unavailable');
 release.resolve(f.bytes);
 // Draining the still-running holder waits for source settlement, without
 // setting its closed flag until the disconnected handler has already ended.
 await vi.waitFor(()=>expect(f.bytes.every(b=>b===0)).toBe(true));
 expect(f.handTo).not.toHaveBeenCalled();expect(f.current).toHaveBeenCalledOnce();
 // A separate client still uses the same live holder.
 f.read.mockResolvedValueOnce(Buffer.from('FRESH'));
 const next=localHolderHandoff(f.config,f.fingerprint('holder'));closes.push(next.close);
 await next.handTo(f.id);expect(f.handTo).toHaveBeenCalledOnce();
});
it.each(['tls','headers'])('bounds the holder connection before complete %s',async phase=>{
 const f=await setup();vi.useFakeTimers({toFake:['setTimeout','clearTimeout']});
 let connected=false,closed=false;
 const raw=phase==='tls'?netConnect(f.config.socket,()=>{connected=true;}):rawPeer(f,true).peer;
 if(phase==='headers')raw.once('secureConnect',()=>{connected=true;});
 raw.on('error',()=>{});raw.on('close',()=>{closed=true;});
 try {
  await vi.waitFor(()=>expect(connected).toBe(true));
  await vi.advanceTimersByTimeAsync(5000);await vi.waitFor(()=>expect(closed).toBe(true));
  expect(f.authority).not.toHaveBeenCalled();expect(f.read).not.toHaveBeenCalled();
 }finally{raw.destroy();vi.useRealTimers();}
});
it.each(['authority','source','transfer'])('holder deadline fences late %s settlement and drains borrowed bytes',async phase=>{
 const f=await setup(),entered=deferred<void>(),release=deferred<void>();
 if(phase==='authority')f.authority.mockImplementationOnce(async()=>{entered.resolve();await release.promise;return f.destination;});
 if(phase==='source')f.read.mockImplementationOnce(async()=>{entered.resolve();await release.promise;return f.bytes;});
 if(phase==='transfer')f.handTo.mockImplementationOnce(async b=>{entered.resolve();await release.promise;expect(Buffer.from(b).toString()).toBe('HANDOFF-SECRET-SENTINEL');});
 vi.useFakeTimers({toFake:['setTimeout','clearTimeout']});const raw=rawPeer(f);
 try {
  await entered.promise;await vi.advanceTimersByTimeAsync(5000);await vi.waitFor(()=>expect(raw.closed()).toBe(true));
  if(phase==='transfer')expect(f.bytes.toString()).toBe('HANDOFF-SECRET-SENTINEL');
  release.resolve();
  if(phase!=='authority')await vi.waitFor(()=>expect(f.bytes.every(b=>b===0)).toBe(true));
  await f.holder.close();expect(Buffer.concat(raw.responses).length).toBe(0);
  expect(f.handTo).toHaveBeenCalledTimes(phase==='transfer'?1:0);
  if(phase==='authority')expect(f.read).not.toHaveBeenCalled();
 }finally{release.resolve();raw.peer.destroy();vi.useRealTimers();}
});
it('client has its own absolute deadline against a holder with no response deadline',async()=>{
 const f=await setup();await f.holder.close();const entered=deferred<void>();
 await fakeHolder(f,()=>{entered.resolve();});
 vi.useFakeTimers({toFake:['setTimeout','clearTimeout']});
 try {
  const pending=expect(f.client.handTo(f.id)).rejects.toThrow(/^Secret handoff unavailable$/);
  await entered.promise;await vi.advanceTimersByTimeAsync(5000);await pending;
 }finally{vi.useRealTimers();}
});

it('holder deadline retains the connection budget across partial headers and authority',async()=>{
 const f=await setup(),entered=deferred<void>(),release=deferred<void>();
 f.authority.mockImplementationOnce(async()=>{entered.resolve();await release.promise;return f.destination;});
 vi.useFakeTimers({toFake:['setTimeout','clearTimeout']});const raw=rawPeer(f,true);
 try {
  await new Promise<void>(resolve=>raw.peer.once('secureConnect',resolve));
  await vi.advanceTimersByTimeAsync(3000);raw.peer.write('\r\n');await entered.promise;
  await vi.advanceTimersByTimeAsync(2000);await vi.waitFor(()=>expect(raw.closed()).toBe(true));
  release.resolve();await f.holder.close();expect(f.read).not.toHaveBeenCalled();expect(f.handTo).not.toHaveBeenCalled();
 }finally{release.resolve();raw.peer.destroy();vi.useRealTimers();}
});

async function fakeHolder(f:Awaited<ReturnType<typeof setup>>,handler:(req:IncomingMessage,res:ServerResponse)=>void) {
 const server=https.createServer({ca:readFileSync(f.config.ca),cert:readFileSync(f.server.cert),key:readFileSync(f.server.key),requestCert:true,rejectUnauthorized:true},handler);
 await new Promise<void>(resolve=>server.listen(f.server.socket,resolve));
 const {chmodSync}=await import('node:fs');chmodSync(f.server.socket,0o600);
 closes.push(()=>new Promise<void>(resolve=>{server.closeAllConnections();server.close(()=>resolve());}));
}
