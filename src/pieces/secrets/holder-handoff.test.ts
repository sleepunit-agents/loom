import { afterEach, expect, it, vi } from 'vitest';
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { X509Certificate, randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import https from 'node:https';
import { listenHolderHandoff, localHolderHandoff, type HolderDestination } from './holder-handoff.js';
const closes: Array<()=>unknown> = [];
afterEach(async()=>{for(const close of closes.splice(0).reverse())await close();vi.restoreAllMocks();});
function deferred<T>() {let resolve!:(value:T)=>void; const promise=new Promise<T>(r=>{resolve=r;});return {promise,resolve};}
async function setup() {
 const home=mkdtempSync(join(tmpdir(),'loom-handoff-'));closes.push(()=>rmSync(home,{recursive:true,force:true}));
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
 const server=https.createServer({ca:readFileSync(f.config.ca),cert:readFileSync(f.server.cert),key:readFileSync(f.server.key),requestCert:true,rejectUnauthorized:true},(_req,res)=>{res.writeHead(200,{'content-type':'application/octet-stream'});res.end('HANDOFF-SECRET-SENTINEL');});
 await new Promise<void>(resolve=>server.listen(f.server.socket,resolve));
 const {chmodSync}=await import('node:fs');chmodSync(f.server.socket,0o600);
 closes.push(()=>new Promise<void>(resolve=>{server.closeAllConnections();server.close(()=>resolve());}));
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
