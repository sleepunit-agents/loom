import {afterEach,expect,it,vi} from 'vitest';
import {mkdtempSync,rmSync,chmodSync,readFileSync,writeFileSync} from 'node:fs';
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
import {ServerResponse} from 'node:http';
import {Socket} from 'node:net';
import {connect as tlsConnect} from 'node:tls';
import {listenTicketAuthority,remoteTicketAuthority} from './ticket-authority.js';
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
 return {home,app,clock,id,job,call,tickets,admit,release,grant,server,config,fingerprint,authority,remote,admitted,state};
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
 const server=https.createServer({ca:readFileSync(f.server.ca),cert:readFileSync(f.server.cert),key:readFileSync(f.server.key),
  requestCert:true,rejectUnauthorized:true},(_req,res)=>{calls++;const body=JSON.stringify({name:'API',destination:{job:'SECRET-SENTINEL'}});
  res.writeHead(200,{'content-length':Buffer.byteLength(body)});res.end(body);});
 await new Promise<void>(resolve=>server.listen(f.config.socket,resolve));chmodSync(f.config.socket,0o600);
 closes.push(()=>new Promise<void>(resolve=>server.close(()=>resolve())));
 expect(await f.remote.claim(randomUUID())).toBeNull();expect(calls).toBe(1);
});
it('does not send a ticket to a CA-valid server with the wrong pin',async()=>{
 const f=await setup();await f.authority.close();const handler=vi.fn((_req:unknown,res:import('node:http').ServerResponse)=>res.end());
 const server=https.createServer({ca:readFileSync(f.server.ca),cert:readFileSync(f.server.cert),key:readFileSync(f.server.key),
  requestCert:true,rejectUnauthorized:true},handler);
 await new Promise<void>(resolve=>server.listen(f.config.socket,resolve));chmodSync(f.config.socket,0o600);
 closes.push(()=>new Promise<void>(resolve=>server.close(()=>resolve())));
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
 const server=https.createServer({ca:readFileSync(f.server.ca),cert:readFileSync(f.server.cert),key:readFileSync(f.server.key),
  requestCert:true,rejectUnauthorized:true},()=>entered());
 await new Promise<void>(resolve=>server.listen(f.config.socket,resolve));chmodSync(f.config.socket,0o600);
 closes.push(()=>{server.closeAllConnections();return new Promise<void>(resolve=>server.close(()=>resolve()));});
 vi.useFakeTimers({toFake:['setTimeout','clearTimeout']});
 try {const pending=f.remote.claim(randomUUID());await ready;if(phase==='deadline')await vi.advanceTimersByTimeAsync(5000);else await f.remote.close();expect(await pending).toBeNull();}
 finally {vi.useRealTimers();}
});
it('rejects oversized and nonempty empty-ack responses with fixed errors',async()=>{
 const f=await setup();await f.authority.close();let phase=0;
 const value=JSON.stringify({name:'API',destination:{agent:'art',job:f.id,runner:'worker',box:'worker',claimedAt:0}});
 const server=https.createServer({ca:readFileSync(f.server.ca),cert:readFileSync(f.server.cert),key:readFileSync(f.server.key),
  requestCert:true,rejectUnauthorized:true},(_req,res)=>{
   if(phase===0){res.writeHead(200,{'content-length':9000});res.end('SECRET-SENTINEL');}
   else if(phase===1){res.writeHead(200,{'content-length':Buffer.byteLength(value)});res.end(value);}
   else {res.writeHead(200,{'content-length':15});res.end('SECRET-SENTINEL');}
  });
 await new Promise<void>(resolve=>server.listen(f.config.socket,resolve));chmodSync(f.config.socket,0o600);
 closes.push(()=>new Promise<void>(resolve=>server.close(()=>resolve())));
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
