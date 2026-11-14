import {afterEach,expect,it,vi} from 'vitest';
import {existsSync,readFileSync} from 'node:fs';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {ServerResponse} from 'node:http';
import {Duplex} from 'node:stream';
import {ticketAuthorityFixture} from './ticket-authority.fixture.js';
import {startSecretCommand} from './secret-command.js';
import {workerSecretTransport} from './secret-transport.js';
import {listenTicketAuthority} from '../pieces/secrets/ticket-authority.js';
import {localHolderHandoff,listenHolderHandoff} from '../pieces/secrets/holder-handoff.js';
import {routedHolderAuthority} from '../pieces/secrets/holder-routing.js';
const closes:Array<()=>unknown>=[];
afterEach(async()=>{vi.restoreAllMocks();for(const close of closes.splice(0).reverse())await close();});
const setup=()=>ticketAuthorityFixture(closes);

async function commandChannels(mutateAfterStart=false) {
 const f=await setup(),binding={agent:'art',job:f.id,runner:'worker',box:'worker',claimedAt:f.clock.now()};
 await f.authority.close();
 const central=await listenTicketAuthority(f.server,f.fingerprint('holder'),f.tickets,[{fingerprint:f.fingerprint('daemon'),binding}]);closes.push(central.close);
 const marker=join(f.home,'consumer-status');
 // Real consumer reads ONLY fd3, requires EOF and records only a boolean result.
 // It holds alive after consumption so delivery can acknowledge before exit.
 const script="const fs=require('node:fs');const chunks=[];fs.createReadStream(null,{fd:3}).on('data',b=>chunks.push(b)).on('end',()=>{const ok=Buffer.concat(chunks).toString()==='synthetic-command-value';fs.writeFileSync(process.argv[1],ok?'accepted':'wrong');setTimeout(()=>process.exit(ok?0:1),200);});";
 let local=true;
 const config={command:process.execPath,args:['-e',script,marker],cwd:f.home,env:{},
  input:{...f.server,socket:join(f.home,'command-input.sock')},holderFingerprint:f.fingerprint('holder'),
  authority:{...f.config,cert:f.server.cert,key:f.server.key},daemonFingerprint:f.fingerprint('daemon')};
 const request={binding,current:()=>local,expiresAt:Date.now()+20_000};
 const starting=startSecretCommand(config,request);
 if(mutateAfterStart){config.command='/synthetic/missing';config.args=['-e','process.exit(1)'];config.authority.socket=join(f.home,'wrong.sock');request.current=()=>false;request.expiresAt=0;}
 const command=await starting;closes.push(command.close);
 const socket=join(f.home,'command-holder.sock');
 const client=localHolderHandoff({...f.server,socket,servername:'holder.test'},f.fingerprint('holder'));closes.push(client.close);
 const completion=f.tickets.admitHandoff(f.viewer,'API',command.pending,client);
 expect(f.tickets.claim(completion.id)).toBeNull();
 const transport=workerSecretTransport({...f.config,socket:config.input.socket},f.fingerprint('daemon'));closes.push(transport.close);
 const source={read:async()=>Buffer.from('synthetic-command-value')};
 const holder=await listenHolderHandoff({...f.config,socket},source,f.fingerprint('daemon'),routedHolderAuthority(f.remote,[{binding,transport}]));closes.push(holder.close);
 return {...f,binding,config,request,command,completion,transport,marker,client,revoke(){local=false;},restore(){local=true;}};
}
it('starts an actual command with its original fd3 request and completes daemon delivery through real pinned channels',async()=>{
 const f=await commandChannels();
 f.command.bindTicket(f.completion.id);f.release(f.completion.id);
 await f.completion.dispatch();
 expect(f.state(f.completion.id)).toEqual({state:'released'});
 expect(await f.command.completed).toBe(true);expect(readFileSync(f.marker,'utf8')).toBe('accepted');
 await f.command.close();
 await expect(f.transport.deliver(f.command.pending.id,f.binding,Buffer.from('synthetic-command-value'))).rejects.toThrow();
 await expect(f.completion.dispatch()).rejects.toThrow();
});
it.each(['unbound','cancel','local','grant','job'] as const)('real command startup refuses %s credentials and never writes its fd3',async outcome=>{
 const f=await commandChannels();
 f.release(f.completion.id);
 if(outcome!=='unbound')f.command.bindTicket(f.completion.id);
 if(outcome==='cancel')f.command.pending.cancel();
 if(outcome==='local')f.revoke();
 if(outcome==='grant'){const {expiresAt:_,...grant}=f.grant;f.call('secrets.revoke',grant);}
 if(outcome==='job')f.job({claimedAt:f.clock.now()+1});
 await expect(f.completion.dispatch()).rejects.toThrow();
 await f.command.close();expect(await f.command.completed).toBe(false);expect(existsSync(f.marker)).toBe(false);
 expect(f.state(f.completion.id)).toEqual({state:outcome==='grant'?'revoked':'uncertain'});
});
it('retains one ticket proof and refuses rebind without replacing the original command request',async()=>{
 const f=await commandChannels();f.command.bindTicket(f.completion.id);
 expect(()=>f.command.bindTicket(randomUUID())).toThrow();
 f.release(f.completion.id);await f.completion.dispatch();
 expect(await f.command.completed).toBe(true);expect(readFileSync(f.marker,'utf8')).toBe('accepted');
});
it('burns a startup after invalid ticket binding, with no reconstructed proof or command write',async()=>{
 const f=await commandChannels();expect(()=>f.command.bindTicket('invalid')).toThrow();
 expect(()=>f.command.bindTicket(f.completion.id)).toThrow();await f.command.close();
 expect(await f.command.completed).toBe(false);expect(existsSync(f.marker)).toBe(false);
});
it('snapshots original owner configuration and request before startup awaits',async()=>{
 const f=await commandChannels(true);f.command.bindTicket(f.completion.id);f.release(f.completion.id);
 await f.completion.dispatch();expect(await f.command.completed).toBe(true);
 expect(readFileSync(f.marker,'utf8')).toBe('accepted');
});
it('never recovers after its original local proof fails at ticket binding',async()=>{
 const f=await commandChannels();f.revoke();expect(()=>f.command.bindTicket(f.completion.id)).toThrow();
 f.restore();expect(()=>f.command.bindTicket(f.completion.id)).toThrow();await f.command.close();
 expect(existsSync(f.marker)).toBe(false);
});
it('cancels the actual command while original central current acknowledgement is delayed',async()=>{
 const f=await commandChannels();f.command.bindTicket(f.completion.id);f.release(f.completion.id);
 let entered!:()=>void,resume!:()=>void;
 const ready=new Promise<void>(r=>{entered=r;}),wait=new Promise<void>(r=>{resume=r;});
 const end=ServerResponse.prototype.end;
 const spy=vi.spyOn(ServerResponse.prototype,'end').mockImplementation(function(this:ServerResponse,...args:Parameters<ServerResponse['end']>){
  if(this.req.url?.endsWith('/worker-current')){entered();void wait.then(()=>end.apply(this,args));return this;}
  return end.apply(this,args);
 });
 try {
  const rejected=expect(f.completion.dispatch()).rejects.toThrow();await ready;
  f.command.pending.cancel();resume();await rejected;await f.command.close();
  expect(await f.command.completed).toBe(false);expect(existsSync(f.marker)).toBe(false);
  expect(f.state(f.completion.id)).toEqual({state:'uncertain'});
  await expect(f.transport.deliver(f.command.pending.id,f.binding,Buffer.from('synthetic-command-value'))).rejects.toThrow();
 }finally{resume();spy.mockRestore();}
});
it.each(['launch','expired','revoked'] as const)('real startup cleans up %s failure and exposes no pending request',async outcome=>{
 const f=await commandChannels();await f.command.close();
 const config={...f.config,input:{...f.config.input,socket:join(f.home,'failed-command.sock')},
  ...(outcome==='launch'?{command:'/synthetic/missing-command'}:{})};
 await expect(startSecretCommand(config,{...f.request,expiresAt:outcome==='expired'?Date.now()-1:Date.now()+20_000,
  current:()=>outcome!=='revoked'})).rejects.toThrow();
 expect(existsSync(f.marker)).toBe(false);
});
it.each(['exit','expiry'] as const)('retires the actual original command on %s before credential delivery',async outcome=>{
 const f=await commandChannels();await f.command.close();
 const command=await startSecretCommand({...f.config,
  args:outcome==='exit'?['-e','process.exit(0)']:f.config.args,
  input:{...f.config.input,socket:join(f.home,'retired-command.sock')}},
  {...f.request,expiresAt:Date.now()+300});closes.push(command.close);
 expect(await command.completed).toBe(false);await command.close();
 expect(()=>command.bindTicket(randomUUID())).toThrow();
 expect(existsSync(f.marker)).toBe(false);
});
it('retires on original process exit even while a descendant holds fd3 open',async()=>{
 const f=await commandChannels();await f.command.close();
 const marker=join(f.home,'descendant-pids');
 const script="const c=require('node:child_process').spawn(process.execPath,['-e','setTimeout(()=>{},10000)'],{stdio:['ignore','ignore','ignore',3]});require('node:fs').writeFileSync(process.argv[1],process.pid+':'+c.pid);process.exit(0);";
 const command=await startSecretCommand({...f.config,args:['-e',script,marker],
  input:{...f.config.input,socket:join(f.home,'descendant.sock')}},f.request);closes.push(command.close);
 await expect.poll(()=>existsSync(marker)).toBe(true);
 const [parent,descendant]=readFileSync(marker,'utf8').split(':').map(Number);
 try {
  await expect.poll(()=>{try{process.kill(parent,0);return false;}catch{return true;}}).toBe(true);
  expect(()=>command.bindTicket(randomUUID())).toThrow();
  expect(await command.completed).toBe(false);await command.close();
 }finally{try{process.kill(descendant,'SIGKILL');}catch{/* already gone */}}
});
it('returns only a generic error for malformed original binding',async()=>{
 const f=await commandChannels();await f.command.close();
 const error=await startSecretCommand(f.config,{...f.request,binding:{...f.binding,job:'PRIVATE-INVALID'}}).catch(e=>e as Error);
 expect(error.message).toBe('Worker secret command unavailable');expect(error.stack).not.toContain('PRIVATE');
});
it('drains the actual process and listener when cancellation holds a pipe write completion',async()=>{
 const f=await commandChannels();await f.command.close();
 const marker=join(f.home,'blocked-pid');
 const command=await startSecretCommand({...f.config,args:['-e',"require('node:fs').writeFileSync(process.argv[1],String(process.pid));setInterval(()=>{},1000)",marker]},f.request);closes.push(command.close);
 await expect.poll(()=>existsSync(marker)).toBe(true);const pid=Number(readFileSync(marker,'utf8'));
 const ticket=f.tickets.admit(f.viewer,'API',command.pending);expect(f.tickets.claim(ticket.id)).toBeNull();f.release(ticket.id);
 command.bindTicket(ticket.id);const claim=await f.remote.claim(ticket.id);expect(claim).not.toBeNull();
 let entered!:()=>void,resume!:()=>void,borrowed:Buffer|undefined;
 const ready=new Promise<void>(r=>{entered=r;}),wait=new Promise<void>(r=>{resume=r;});
 const end=Duplex.prototype.end;
 // Hold completion of a real pipe write, not a synthetic stream or spawn.
 // The kernel may already accept this bounded write; cancellation stays uncertain.
 const spy=vi.spyOn(Duplex.prototype,'end').mockImplementation(function(this:Duplex,...args:Parameters<Duplex['end']>){
  if(Buffer.isBuffer(args[0])&&args[0].toString()==='synthetic-command-value') {
   borrowed=args[0];const callback=args[1] as unknown as (error?:Error|null)=>void;
   return Reflect.apply(end,this,[args[0],(error?:Error|null)=>{entered();void wait.then(()=>callback(error));}]);
  }
  return Reflect.apply(end,this,args);
 });
 try {
  const delivery=f.transport.deliver(command.pending.id,f.binding,Buffer.from('synthetic-command-value')).catch(e=>e);
  await ready;expect(borrowed!.toString()).toBe('synthetic-command-value');
  const closing=command.close();resume();await closing;
  expect(await delivery).toBeInstanceOf(Error);expect(borrowed!.every(b=>b===0)).toBe(true);
  expect(()=>process.kill(pid,0)).toThrow();expect(await command.completed).toBe(false);
  await expect(f.transport.deliver(command.pending.id,f.binding,Buffer.from('synthetic-command-value'))).rejects.toThrow();
  await claim!.finish(false);
 }finally{resume();spy.mockRestore();}
});
it('disconnects prompt and diagnostics descriptors in the real consumer',async()=>{
 const f=await commandChannels();await f.command.close();
 const marker=join(f.home,'descriptor-status');
 const script="const fs=require('node:fs');const nullDev=fs.statSync('/dev/null').rdev;const ok=[0,1,2].every(fd=>{const s=fs.fstatSync(fd);return s.isCharacterDevice()&&s.rdev===nullDev;});process.stdout.write('PRIVATE OUTPUT');process.stderr.write('PRIVATE DIAGNOSTIC');fs.writeFileSync(process.argv[1],ok?'disconnected':'inherited');setTimeout(()=>{},10000);";
 const command=await startSecretCommand({...f.config,args:['-e',script,marker],input:{...f.config.input,socket:join(f.home,'diagnostics.sock')}},f.request);closes.push(command.close);
 await expect.poll(()=>existsSync(marker)).toBe(true);expect(readFileSync(marker,'utf8')).toBe('disconnected');
 await command.close();expect(await command.completed).toBe(false);
});
