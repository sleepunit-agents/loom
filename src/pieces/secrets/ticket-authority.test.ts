import {Writable} from 'node:stream';
import {workerSecretInputs} from '../../runtime-runner/secret-input.js';
import {listenWorkerSecretInput,workerSecretTransport} from '../../runtime-runner/secret-transport.js';
import {afterEach,expect,it,vi} from 'vitest';
import {mkdtempSync,mkdirSync,existsSync,rmSync,chmodSync,readFileSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {X509Certificate,randomUUID} from 'node:crypto';
import {fixture} from '../../fixture.js';
import {startLoom} from '../../foundation.js';
import {FakeClock,type Viewer} from '../../core/index.js';
import {SharingDatabase} from '../../core/household/sharing.js';
import {signin,hash} from '../../core/signin/index.js';
import {runtimeStore} from '../runtime/store.js';
import type {RuntimeRecords} from '../runtime/records.js';
import {secretTickets} from './tickets.js';
import {fileURLToPath} from 'node:url';
import https from 'node:https';
import {ServerResponse,type IncomingMessage} from 'node:http';
import {Socket,connect as netConnect} from 'node:net';
import {connect as tlsConnect} from 'node:tls';
import {listenTicketAuthority,remoteTicketAuthority,remoteWorkerTicketProof} from './ticket-authority.js';
const closes:Array<()=>unknown>=[];
afterEach(async()=>{vi.useRealTimers();for(const close of closes.splice(0).reverse())await close();vi.restoreAllMocks();});
async function setup(service?:string) {
 const home=mkdtempSync(join(tmpdir(),'runtime-secret-destination-'));closes.push(()=>rmSync(home,{recursive:true,force:true}));fixture(home);
 const clock=new FakeClock(),app=await startLoom({home,next:true,staging:true,clock,stdout(){}});closes.push(app.close);
 const auth=signin(app),store=runtimeStore(app.db),id=randomUUID(),house={repo:'/synthetic/art',houseFile:'house/house.json'};
 app.db.transaction(()=>{
  auth.tokens.replace({v:1,tokens:[]},{});
  for(const box of ['worker','other'])store.put('box',{id:box,name:box,owner:'jonathan',local:false,mayHost:'*',lentTo:[],facts:[],labels:[],alwaysOn:false,reportOnly:false,createdAt:clock.now()},clock.now());
  store.put('settings',{id:'art',agent:'art',boxes:['worker'],house},clock.now());
  store.put('job',{id,agent:'art',box:'worker',runner:'worker',title:'fixture',state:'running',createdAt:clock.now(),claimedAt:clock.now(),made:house,...(service?{service}:{})},clock.now());
 })();
 const token=service?'synthetic-service-body':app.db.transaction(()=>auth.issueBody('art',id))();
 if(service)auth.tokens.change(tokens=>tokens.push({role:`agent:art/${service}@${id}`,sha256:hash(token),label:'synthetic',created:new Date(clock.now()).toISOString()}));
 const viewer=auth.token(hash(token))!.viewer,sharing=()=>new SharingDatabase(app.db,home).sharing();
 const job=(set:Partial<RuntimeRecords['job']>)=>app.db.transaction(()=>{const {changedAt:_,...before}=store.read('job',id)!;store.put('job',{...before,...set},clock.now());})();
 const box=(set:Partial<RuntimeRecords['box']>)=>app.db.transaction(()=>{const {changedAt:_,...before}=store.read('box','worker')!;store.put('box',{...before,...set},clock.now());})();
 const owner:Viewer={kind:'member',id:'jonathan'}; let seq=0;
 const call=(op:string,input:unknown)=>{const result=app.operations.call('direct',owner,op,input,`ticket-test-${++seq}`);expect(result.ok,JSON.stringify(result)).toBe(true);return result;};
 call('secrets.describe',{name:'API',description:''});
 const scope={house:id,...(service?{service}:{})};
 const grant={agent:'art',kind:'secret',target:'API',scope,expiresAt:clock.now()+60_000};
 call('secrets.grant',grant);
 const tickets=secretTickets(app,sharing,app.effects!);
 const admit=()=>tickets.admit(viewer,'API');
 const release=(ticket:string)=>call('core.releaseEffect',{id:`secrets:handoff:${ticket}`});
 const claim=()=>{const ticket=admit();expect(tickets.claim(ticket.id)).toBeNull();release(ticket.id);const c=tickets.claim(ticket.id);expect(c).not.toBeNull();return {ticket,c:c!};};
 const fixtures=fileURLToPath(new URL('./fixtures/lifecycle-tls/',import.meta.url));
 for(const name of ['ca.pem','holder.pem','holder.key','daemon.pem','daemon.key','stranger.pem','stranger.key'])writeFileSync(join(home,name),readFileSync(join(fixtures,name)),{mode:0o600});
 const common={socket:join(home,'tickets.sock'),ca:join(home,'ca.pem')};
 const server={...common,cert:join(home,'daemon.pem'),key:join(home,'daemon.key')};
 const config={...common,cert:join(home,'holder.pem'),key:join(home,'holder.key'),servername:'daemon.test'};
 const fingerprint=(name:string)=>new X509Certificate(readFileSync(join(home,`${name}.pem`))).fingerprint256;
 const authority=await listenTicketAuthority(server,fingerprint('holder'),tickets);closes.push(authority.close);
 const remote=remoteTicketAuthority(config,fingerprint('daemon'));closes.push(remote.close);
 const admitted=()=>{const ticket=admit();expect(tickets.claim(ticket.id)).toBeNull();release(ticket.id);return ticket;};
 const state=(ticket:string)=>app.db.prepare('SELECT state FROM secrets_tickets WHERE id=?').get(ticket);
 return {home,app,clock,id,viewer,job,call,tickets,admit,release,grant,server,config,fingerprint,authority,remote,admitted,state};
}
async function fakeAuthority(f:Awaited<ReturnType<typeof setup>>,handler:(req:IncomingMessage,res:ServerResponse)=>void) {
 await f.authority.close();
 const server=https.createServer({ca:readFileSync(f.server.ca),cert:readFileSync(f.server.cert),key:readFileSync(f.server.key),
  requestCert:true,rejectUnauthorized:true},handler);
 await new Promise<void>(resolve=>server.listen(f.config.socket,resolve));chmodSync(f.config.socket,0o600);
 closes.push(()=>{server.closeAllConnections();return new Promise<void>(resolve=>server.close(()=>resolve()));});
}
it.each([undefined,'slack'])('claims exact original metadata through real pinned mutual TLS for service %s',async service=>{
 const f=await setup(service),t=f.admitted(),c=await f.remote.claim(t.id);
 expect(c).not.toBeNull();expect(c!.name).toBe('API');
 expect(c!.destination).toEqual({agent:'art',job:f.id,runner:'worker',box:'worker',claimedAt:f.clock.now(),...(service?{service}:{})});
 expect(await c!.current()).toBe(true);expect(await f.remote.claim(t.id)).toBeNull();
 await c!.finish(true);expect(f.state(t.id)).toEqual({state:'released'});
 expect(await c!.current()).toBe(false);await expect(c!.finish(true)).rejects.toThrow(/^Secret ticket authority unavailable$/);
 expect(await f.remote.claim(t.id)).toBeNull();
 for(const op of ['secrets.houseGet','secrets.get','secrets.claimTicket'])expect(f.app.operations.has(op)).toBe(false);
});
it('keeps staging due and never claims before explicit release',async()=>{
 const f=await setup(),t=f.admit();expect(await f.remote.claim(t.id)).toBeNull();
 expect(f.state(t.id)).toEqual({state:'admitted'});expect(f.app.effects!.status(`secrets:handoff:${t.id}`)).toBe('due');
 f.release(t.id);const c=await f.remote.claim(t.id);expect(c).not.toBeNull();await c!.finish(false);
 expect(f.state(t.id)).toEqual({state:'uncertain'});
});
it.each(['grant','policy','runtime','expiry','effect'] as const)('fences a retained remote claim after %s changes',async change=>{
 const f=await setup(),t=f.admitted(),c=(await f.remote.claim(t.id))!;
 if(change==='grant'){const {expiresAt:_,...input}=f.grant;f.call('secrets.revoke',input);f.call('secrets.grant',f.grant);}
 if(change==='policy')f.call('secrets.policy',{default:'never',secrets:{}});
 if(change==='runtime')f.job({claimedAt:f.clock.now()+1});
 if(change==='expiry')f.clock.advance(30_000);
 if(change==='effect')f.app.effects!.finish(`secrets:handoff:${t.id}`,false);
 expect(await c.current()).toBe(false);await expect(c.finish(true)).rejects.toThrow(/^Secret ticket authority unavailable$/);
 expect(f.state(t.id)).toEqual({state:['grant','policy'].includes(change)?'revoked':'uncertain'});
 expect(await f.remote.claim(t.id)).toBeNull();
});
it('checks authority again at finish even without a cooperative current call',async()=>{
 const f=await setup(),t=f.admitted(),c=(await f.remote.claim(t.id))!;
 f.job({state:'done'});await expect(c.finish(true)).rejects.toThrow();
 expect(f.state(t.id)).toEqual({state:'uncertain'});
});
it('pins both peers before claim, and refuses ordinary CA-valid and untrusted peers',async()=>{
 const f=await setup(),t=f.admitted();
 for(const [patch,pin] of [
  [{},f.fingerprint('holder')],
  [{servername:'wrong.test'},f.fingerprint('daemon')],
  [{cert:join(f.home,'stranger.pem'),key:join(f.home,'stranger.key')},f.fingerprint('daemon')],
 ] as const) {
  const remote=remoteTicketAuthority({...f.config,...patch},pin);closes.push(remote.close);
  expect(await remote.claim(t.id)).toBeNull();expect(f.state(t.id)).toEqual({state:'admitted'});
 }
 await f.authority.close();
 const wrong=await listenTicketAuthority(f.server,f.fingerprint('daemon'),f.tickets);closes.push(wrong.close);
 expect(await f.remote.claim(t.id)).toBeNull();expect(f.state(t.id)).toEqual({state:'admitted'});
});
it('server shutdown burns outstanding claims and restart cannot recreate proof closures',async()=>{
 const f=await setup(),t=f.admitted(),c=(await f.remote.claim(t.id))!;
 await f.authority.close();expect(await c.current()).toBe(false);expect(f.state(t.id)).toEqual({state:'uncertain'});
 const restarted=await listenTicketAuthority(f.server,f.fingerprint('holder'),f.tickets);closes.push(restarted.close);
 expect(await f.remote.claim(t.id)).toBeNull();
});
it('client shutdown fences retained current and finish without retrying',async()=>{
 const f=await setup(),t=f.admitted(),c=(await f.remote.claim(t.id))!;
 await f.remote.close();expect(await c.current()).toBe(false);await expect(c.finish(true)).rejects.toThrow();
 expect(f.state(t.id)).toEqual({state:'claimed'});await f.authority.close();expect(f.state(t.id)).toEqual({state:'uncertain'});
});
it('rejects malformed method/path/body before consuming an otherwise valid ticket',async()=>{
 const f=await setup(),t=f.admitted();
 for(const input of [{method:'GET',path:`/v1/tickets/${t.id}/claim`,body:''},
  {method:'POST',path:`/v1/tickets/${t.id}/claim`,body:'x'},
  {method:'POST',path:`/v1/tickets/${t.id}/claim?runner=other`,body:''},
  {method:'POST',path:'/v1/tickets/not-a-ticket/claim',body:''}]) {
  const status=await new Promise<number|undefined>((resolve,reject)=>{
   const req=https.request({socketPath:f.config.socket,servername:f.config.servername,ca:readFileSync(f.config.ca),
    cert:readFileSync(f.config.cert),key:readFileSync(f.config.key),method:input.method,path:input.path,
    headers:{'content-length':Buffer.byteLength(input.body)}},res=>{res.resume();res.on('end',()=>resolve(res.statusCode));});
   req.on('error',reject);req.end(input.body);
  });expect(status).toBe(503);expect(f.state(t.id)).toEqual({state:'admitted'});
 }
 expect(await f.remote.claim('../API')).toBeNull();
});
it('fails closed on holder diagnostics and malformed metadata without echoing them',async()=>{
 const f=await setup();await f.authority.close();let calls=0;
 await fakeAuthority(f,(_req,res)=>{calls++;const body=JSON.stringify({name:'API',destination:{job:'SECRET-SENTINEL'}});
  res.writeHead(200,{'content-length':Buffer.byteLength(body)});res.end(body);});
 expect(await f.remote.claim(randomUUID())).toBeNull();expect(calls).toBe(1);
});
it('does not send a ticket to a CA-valid server with the wrong pin',async()=>{
 const f=await setup();await f.authority.close();const handler=vi.fn((_req:unknown,res:import('node:http').ServerResponse)=>res.end());
 await fakeAuthority(f,handler);
 const remote=remoteTicketAuthority(f.config,f.fingerprint('holder'));closes.push(remote.close);
 expect(await remote.claim(randomUUID())).toBeNull();expect(handler).not.toHaveBeenCalled();
});
it('consumes a claim when its metadata reply is lost and never retries the claim',async()=>{
 const f=await setup(),t=f.admitted(),spy=vi.spyOn(f.tickets,'claim');
 const writeHead=ServerResponse.prototype.writeHead;
 const drop=vi.spyOn(ServerResponse.prototype,'writeHead').mockImplementation(function(this:ServerResponse,...args:Parameters<ServerResponse['writeHead']>){
  const result=writeHead.apply(this,args);
  if(args[0]===200)this.socket?.destroy();
  return result;
 });
 try {expect(await f.remote.claim(t.id)).toBeNull();}finally {drop.mockRestore();}
 expect(f.state(t.id)).toEqual({state:expect.stringMatching(/^(claimed|uncertain)$/)});expect(spy).toHaveBeenCalledTimes(1);
 expect(await f.remote.claim(t.id)).toBeNull();
});
it.each(['deadline','close'])('bounds pending client work on %s independently of a silent authenticated server',async phase=>{
 const f=await setup();await f.authority.close();let entered!:()=>void;
 const ready=new Promise<void>(resolve=>{entered=resolve;});
 await fakeAuthority(f,()=>entered());
 vi.useFakeTimers({toFake:['setTimeout','clearTimeout']});
 try {const pending=f.remote.claim(randomUUID());await ready;if(phase==='deadline')await vi.advanceTimersByTimeAsync(5000);else await f.remote.close();expect(await pending).toBeNull();}
 finally {vi.useRealTimers();}
});
it('rejects oversized and nonempty empty-ack responses with fixed errors',async()=>{
 const f=await setup();await f.authority.close();let phase=0;
 const value=JSON.stringify({name:'API',destination:{agent:'art',job:f.id,runner:'worker',box:'worker',claimedAt:0}});
 await fakeAuthority(f,(_req,res)=>{
   if(phase===0){res.writeHead(200,{'content-length':9000});res.end('SECRET-SENTINEL');}
   else if(phase===1){res.writeHead(200,{'content-length':Buffer.byteLength(value)});res.end(value);}
   else {res.writeHead(200,{'content-length':15});res.end('SECRET-SENTINEL');}
  });
 expect(await f.remote.claim(randomUUID())).toBeNull();phase=1;
 const c=(await f.remote.claim(randomUUID()))!;expect(c).not.toBeNull();phase=2;
 expect(await c.current()).toBe(false);await expect(c.finish(true)).rejects.toThrow(/^Secret ticket authority unavailable$/);
});
it('refuses a request completed at its original connection deadline even if socket close is delayed',async()=>{
 const f=await setup(),t=f.admitted();let output='';
 vi.useFakeTimers({toFake:['setTimeout','clearTimeout','Date']});
 const peer=tlsConnect({path:f.config.socket,servername:f.config.servername,ca:readFileSync(f.config.ca),
  cert:readFileSync(f.config.cert),key:readFileSync(f.config.key),rejectUnauthorized:true});
 peer.on('error',()=>{});peer.on('data',bytes=>{output+=bytes.toString();});
 try {
  await new Promise<void>(resolve=>peer.once('secureConnect',resolve));
  peer.write(`POST /v1/tickets/${t.id}/claim HTTP/1.1\r\nHost: daemon.test\r\nContent-Length: 0\r\n`);
  const destroy=vi.spyOn(Socket.prototype,'destroy').mockImplementation(function(this:Socket){return this;});
  try {
   await vi.advanceTimersByTimeAsync(5000);peer.write('\r\n');
   await vi.waitFor(()=>expect(output).toContain('503'));
   expect(f.state(t.id)).toEqual({state:'admitted'});
  }finally {destroy.mockRestore();}
 }finally {peer.destroy();vi.useRealTimers();}
});
it.each(['tls','headers'])('disconnects silent %s peers at the accepted deadline and drains shutdown',async phase=>{
 const f=await setup();let closed=false;
 vi.useFakeTimers({toFake:['setTimeout','clearTimeout']});
 const peer=phase==='tls'?netConnect(f.config.socket):tlsConnect({path:f.config.socket,servername:f.config.servername,
  ca:readFileSync(f.config.ca),cert:readFileSync(f.config.cert),key:readFileSync(f.config.key),rejectUnauthorized:true});
 peer.on('error',()=>{});peer.once('close',()=>{closed=true;});
 try {
  await new Promise<void>(resolve=>peer.once(phase==='tls'?'connect':'secureConnect',resolve));
  if(phase==='headers')peer.write('POST /v1/tickets/');
  await vi.advanceTimersByTimeAsync(5000);await vi.waitFor(()=>expect(closed).toBe(true));
  await f.authority.close();
 }finally {peer.destroy();vi.useRealTimers();}
});
it('does not revive a retained claim after a failed current response and subsequent recovery',async()=>{
 const f=await setup(),t=f.admitted(),c=(await f.remote.claim(t.id))!;
 const writeHead=ServerResponse.prototype.writeHead;
 const drop=vi.spyOn(ServerResponse.prototype,'writeHead').mockImplementation(function(this:ServerResponse,...args:Parameters<ServerResponse['writeHead']>){
  const result=writeHead.apply(this,args);
  if(this.req.url?.endsWith('/current'))this.socket?.destroy();
  return result;
 });
 try {expect(await c.current()).toBe(false);}finally {drop.mockRestore();}
 // The central proof remains valid; only the retained client was invalidated.
 expect(f.state(t.id)).toEqual({state:'claimed'});
 expect(await c.current()).toBe(false);await c.finish(true);
 expect(f.state(t.id)).toEqual({state:'uncertain'});
});
it('admits only one winner when authenticated holders overlap claims',async()=>{
 const f=await setup(),t=f.admitted(),spy=vi.spyOn(f.tickets,'claim');
 const other=remoteTicketAuthority(f.config,f.fingerprint('daemon'));closes.push(other.close);
 const results=await Promise.all([f.remote.claim(t.id),other.claim(t.id)]);
 const winners=results.filter(c=>c!==null);expect(winners).toHaveLength(1);expect(spy).toHaveBeenCalledTimes(1);
 await winners[0]!.finish(true);expect(f.state(t.id)).toEqual({state:'released'});
});
it.each(['settle','close'])('fences a delayed successful current response overlapping %s',async phase=>{
 const f=await setup(),t=f.admitted(),c=(await f.remote.claim(t.id))!;
 let entered!:()=>void,release!:()=>void;
 const ready=new Promise<void>(resolve=>{entered=resolve;});
 const end=ServerResponse.prototype.end;
 const hold=vi.spyOn(ServerResponse.prototype,'end').mockImplementation(function(this:ServerResponse,...args:Parameters<ServerResponse['end']>){
  if(this.req.url?.endsWith('/current')){release=()=>{end.apply(this,args);};entered();return this;}
  return end.apply(this,args);
 });
 try {
  const pending=c.current();await ready;
  if(phase==='settle')await c.finish(true);else await f.remote.close();
  release();expect(await pending).toBe(false);
 }finally {hold.mockRestore();release?.();}
 expect(f.state(t.id)).toEqual({state:phase==='settle'?'released':'claimed'});
});
it('rejects an unknown action without settling a retained claim',async()=>{
 const f=await setup(),t=f.admitted(),c=(await f.remote.claim(t.id))!;
 const status=await new Promise<number|undefined>((resolve,reject)=>{
  const req=https.request({socketPath:f.config.socket,servername:f.config.servername,ca:readFileSync(f.config.ca),
   cert:readFileSync(f.config.cert),key:readFileSync(f.config.key),method:'POST',path:`/v1/tickets/${t.id}/retry`,
   headers:{'content-length':0}},res=>{res.resume();res.once('end',()=>resolve(res.statusCode));});
  req.on('error',reject);req.end();
 });
 expect(status).toBe(503);expect(f.state(t.id)).toEqual({state:'claimed'});
 expect(await c.current()).toBe(true);await c.finish(true);expect(f.state(t.id)).toEqual({state:'released'});
});
it('rejects an accessible server directory before binding or ticket consumption',async()=>{
 const f=await setup(),t=f.admitted(),spy=vi.spyOn(f.tickets,'claim');
 const directory=join(f.home,'accessible');mkdirSync(directory,{mode:0o755});chmodSync(directory,0o755);
 const config={...f.server,socket:join(directory,'authority.sock')};
 await expect(listenTicketAuthority(config,f.fingerprint('holder'),f.tickets)).rejects.toThrow(/^Secret ticket authority unavailable$/);
 expect(existsSync(config.socket)).toBe(false);expect(spy).not.toHaveBeenCalled();
 expect(f.state(t.id)).toEqual({state:'admitted'});
 chmodSync(directory,0o700);
 const server=await listenTicketAuthority(config,f.fingerprint('holder'),f.tickets);closes.push(server.close);
});
it.each(['directory','socket'])('rejects accessible client %s before transmitting ticket metadata',async target=>{
 const f=await setup(),t=f.admitted(),spy=vi.spyOn(f.tickets,'claim');
 const remote=remoteTicketAuthority(f.config,f.fingerprint('daemon'));closes.push(remote.close);
 // Construct with valid TLS files first; fail at the socket admission call site.
 const path=target==='directory'?f.home:f.config.socket;
 chmodSync(path,target==='directory'?0o755:0o666);
 try {
  expect(await remote.claim(t.id)).toBeNull();expect(spy).not.toHaveBeenCalled();
  expect(f.state(t.id)).toEqual({state:'admitted'});
 }finally {chmodSync(path,target==='directory'?0o700:0o600);}
 const c=await remote.claim(t.id);expect(c).not.toBeNull();await c!.finish(false);
});

it('carries the original bound pending id across pinned TLS without accepting a holder replacement',async()=>{
 const f=await setup('slack'),request={id:randomUUID(),binding:{agent:'art',job:f.id,runner:'worker',box:'worker',claimedAt:f.clock.now(),service:'slack'}};
 const t=f.tickets.admit(f.viewer,'API',request);expect(f.tickets.claim(t.id)).toBeNull();f.release(t.id);
 const c=(await f.remote.claim(t.id))!;
 expect(c.pendingId).toBe(request.id);expect(Object.isFrozen(c)).toBe(true);
 expect(c.destination).toEqual(request.binding);expect(await c.current()).toBe(true);
 f.job({claimedAt:f.clock.now()+1});expect(await c.current()).toBe(false);
 await expect(c.finish(true)).rejects.toThrow();expect(f.state(t.id)).toEqual({state:'uncertain'});
 expect(await f.remote.claim(t.id)).toBeNull();
});

it.each(['job','pending','pin','unbound','revoked','restart'] as const)('worker current proof rejects %s and cannot claim or finish',async change=>{
 const f=await setup('slack'),binding={agent:'art',job:f.id,runner:'worker',box:'worker',claimedAt:f.clock.now(),service:'slack'},pendingId=randomUUID();
 const t=f.tickets.admit(f.viewer,'API',change==='unbound'?undefined:{id:pendingId,binding});
 expect(f.tickets.claim(t.id)).toBeNull();f.release(t.id);
 await f.authority.close();
 const server=await listenTicketAuthority(f.server,f.fingerprint('holder'),f.tickets,[{fingerprint:f.fingerprint('daemon'),binding:change==='job'?{...binding,job:randomUUID()}:binding}]);closes.push(server.close);
 const c=(await f.remote.claim(t.id))!;expect(c).not.toBeNull();
 const workerConfig={...f.config,cert:f.server.cert,key:f.server.key};
 const worker=remoteWorkerTicketProof(change==='pin'?f.config:workerConfig,f.fingerprint('daemon'),t.id,change==='pending'?randomUUID():pendingId);closes.push(worker.close);
 if(change==='revoked')f.job({claimedAt:f.clock.now()+1});
 if(change==='restart'){await server.close();const restarted=await listenTicketAuthority(f.server,f.fingerprint('holder'),f.tickets,[{fingerprint:f.fingerprint('daemon'),binding}]);closes.push(restarted.close);}
 expect(await worker.current()).toBe(false);
 const elevated=remoteTicketAuthority(workerConfig,f.fingerprint('daemon'));closes.push(elevated.close);
 expect(await elevated.claim(t.id)).toBeNull();
 // A worker cannot settle the retained central claim even with the ticket id.
 const status=await new Promise<number|undefined>((resolve,reject)=>{
  const req=https.request({socketPath:f.config.socket,servername:f.config.servername,ca:readFileSync(f.config.ca),cert:readFileSync(workerConfig.cert),key:readFileSync(workerConfig.key),method:'POST',path:`/v1/tickets/${t.id}/released`,headers:{'content-length':0}},res=>{res.resume();res.once('end',()=>resolve(res.statusCode));});req.on('error',reject);req.end();
 });expect(status).toBe(503);
});
it('checks the original retained central claim for its exact worker and pending id; failure is sticky',async()=>{
 const f=await setup(),binding={agent:'art',job:f.id,runner:'worker',box:'worker',claimedAt:f.clock.now()},pendingId=randomUUID();
 const t=f.tickets.admit(f.viewer,'API',{id:pendingId,binding});expect(f.tickets.claim(t.id)).toBeNull();f.release(t.id);
 await f.authority.close();
 const configured={fingerprint:f.fingerprint('daemon'),binding:{...binding}};
 const server=await listenTicketAuthority(f.server,f.fingerprint('holder'),f.tickets,[configured]);closes.push(server.close);
 configured.binding.runner='replacement';
 const c=(await f.remote.claim(t.id))!;
 const worker=remoteWorkerTicketProof({...f.config,cert:f.server.cert,key:f.server.key},f.fingerprint('daemon'),t.id,pendingId);closes.push(worker.close);
 expect(await worker.current()).toBe(true);
 const end=ServerResponse.prototype.end;
 const drop=vi.spyOn(ServerResponse.prototype,'end').mockImplementation(function(this:ServerResponse,...args:Parameters<ServerResponse['end']>){
  if(this.req.url?.endsWith('/worker-current'))this.socket?.destroy();return end.apply(this,args);
 });
 try {expect(await worker.current()).toBe(false);}finally {drop.mockRestore();}
 expect(await c.current()).toBe(true);expect(await worker.current()).toBe(false);
 await c.finish(false);expect(f.state(t.id)).toEqual({state:'uncertain'});
});

it.each(['release','grant','local'] as const)('fences a real worker stream against original central and local proofs: %s',async outcome=>{
 const f=await setup(),binding={agent:'art',job:f.id,runner:'worker',box:'worker',claimedAt:f.clock.now()},inputs=workerSecretInputs();
 closes.push(()=>inputs.close());let local=true,proof:ReturnType<typeof remoteWorkerTicketProof>|undefined;
 const writes:string[]=[];
 const input=new Writable({write(bytes,_encoding,done){writes.push(bytes.toString());done();}});
 const pending=inputs.register(binding,input,()=>local,async()=>proof?.current()??false,Date.now()+30_000);
 const t=f.tickets.admit(f.viewer,'API',pending);expect(f.tickets.claim(t.id)).toBeNull();f.release(t.id);
 await f.authority.close();
 const central=await listenTicketAuthority(f.server,f.fingerprint('holder'),f.tickets,[{fingerprint:f.fingerprint('daemon'),binding}]);closes.push(central.close);
 proof=remoteWorkerTicketProof({...f.config,cert:f.server.cert,key:f.server.key},f.fingerprint('daemon'),t.id,pending.id);closes.push(proof.close);
 const workerServer=await listenWorkerSecretInput({...f.server,socket:join(f.home,'input.sock')},f.fingerprint('holder'),inputs);closes.push(workerServer.close);
 const transport=workerSecretTransport({...f.config,socket:join(f.home,'input.sock')},f.fingerprint('daemon'));closes.push(transport.close);
 const c=(await f.remote.claim(t.id))!;expect(c.pendingId).toBe(pending.id);
 if(outcome==='grant'){const {expiresAt:_,...revoke}=f.grant;f.call('secrets.revoke',revoke);}
 if(outcome==='local')local=false;
 const bytes=Buffer.from('synthetic-test-value');
 try {
  if(outcome==='release'){await transport.deliver(c.pendingId!,c.destination,bytes);await c.finish(true);}
  else {await expect(transport.deliver(c.pendingId!,c.destination,bytes)).rejects.toThrow();try {await c.finish(false);}catch { /* authority may already prune */ }}
  expect(writes).toEqual(outcome==='release'?['synthetic-test-value']:[]);
  expect(f.state(t.id)).toEqual({state:outcome==='release'?'released':outcome==='grant'?'revoked':'uncertain'});
  await expect(transport.deliver(pending.id,binding,bytes)).rejects.toThrow();
 }finally {bytes.fill(0);}
});
it('rejects holder/worker pin aliasing before listening',async()=>{
 const f=await setup();
 await expect(listenTicketAuthority({...f.server,socket:join(f.home,'alias.sock')},f.fingerprint('holder'),f.tickets,
  [{fingerprint:f.fingerprint('holder'),binding:{agent:'art',job:f.id,runner:'worker',box:'worker',claimedAt:f.clock.now()}}])).rejects.toThrow(/^Secret ticket authority unavailable$/);
 expect(existsSync(join(f.home,'alias.sock'))).toBe(false);
});
