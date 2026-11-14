import {afterEach,expect,test} from 'vitest';
import {randomUUID} from 'node:crypto';
import {join} from 'node:path';
import {readFileSync,writeFileSync} from 'node:fs';
import {startSecretCommand} from './runtime-runner/secret-command.js';
import {workerSecretTransport} from './runtime-runner/secret-transport.js';
import {listenHolderHandoff} from './pieces/secrets/holder-handoff.js';
import {routedHolderAuthority} from './pieces/secrets/holder-routing.js';
import {runtimeHouseDestination} from './pieces/runtime/role.js';
import {ticketAuthorityFixture} from './runtime-runner/ticket-authority.fixture.js';
import {SharingDatabase} from './core/household/sharing.js';
import {signin,hash} from './core/signin/index.js';
import {runtimeStore} from './pieces/runtime/store.js';
import {startSecretWorkers} from './secret-worker-startup.js';
import {workerAdmission} from './pieces/secrets/worker-admission.js';
import {remoteWorkerTicketProof} from './pieces/secrets/ticket-authority.js';
const closes:Array<()=>unknown>=[];
afterEach(async()=>{for(const close of closes.splice(0).reverse())await close();});
async function setup() {
 const f=await ticketAuthorityFixture(closes);await f.authority.close();
 const config={authority:f.server,admission:{...f.server,socket:join(f.home,'refresh.sock')},
  holder:{config:{...f.server,socket:join(f.home,'holder.sock'),servername:'holder.test'},fingerprint:f.fingerprint('holder')},
  workers:[{tokenDigest:f.tokenDigest,fingerprint:f.fingerprint('daemon')}]};
 const owner=await startSecretWorkers(f.app,()=>new SharingDatabase(f.app.db,f.home).sharing(),f.app.effects!,config);closes.push(owner.close);
 const client=(pending=randomUUID())=>{const c=workerAdmission({...config.admission,servername:'daemon.test'},f.fingerprint('daemon'),pending);closes.push(c.close);return c;};
 return {...f,config,owner,client};
}
test('peer replacement retires original pending and claimed tickets, including equal metadata',async()=>{
 const f=await setup(),pending=randomUUID(),original=f.client(pending),id=await original.admit('API');
 expect(await f.remote.claim(id)).toBeNull();f.release(id);const claim=(await f.remote.claim(id))!;expect(await claim.current()).toBe(true);
 const proof=remoteWorkerTicketProof({...f.server,servername:'daemon.test'},f.fingerprint('daemon'),id,pending);closes.push(proof.close);
 expect(await proof.current()).toBe(true);
 f.owner.replaceWorkers(f.config.workers);
 expect(f.state(id)).toEqual({state:'uncertain'});expect(await claim.current()).toBe(false);expect(await proof.current()).toBe(false);
 await expect(original.dispatch()).rejects.toThrow();await expect(f.client(pending).admit('API')).rejects.toThrow();
 const next=await f.client().admit('API');expect(f.state(next)).toEqual({state:'admitted'});
 f.owner.replaceWorkers([]);expect(f.state(next)).toEqual({state:'uncertain'});
 await expect(f.client().admit('API')).rejects.toThrow();
 f.owner.replaceWorkers(f.config.workers);expect(await proof.current()).toBe(false);expect(await f.remote.claim(id)).toBeNull();
});
test('replacement resolves a new original authenticated job instead of retaining the startup assignment',async()=>{
 const f=await setup(),old=f.client(),id=await old.admit('API'),store=runtimeStore(f.app.db),job=randomUUID();
 const token=f.app.db.transaction(()=>{
  const {changedAt:_,...before}=store.read('job',f.id)!;
  store.put('job',{...before,id:job,claimedAt:f.clock.now()+1},f.clock.now());
  return signin(f.app).issueBody('art',job);
 })();
 f.call('secrets.grant',{...f.grant,scope:{house:job}});
 const selected=[{tokenDigest:hash(token),fingerprint:f.fingerprint('daemon')}];
 f.owner.replaceWorkers(selected);selected[0].tokenDigest='0'.repeat(64);
 expect(f.state(id)).toEqual({state:'uncertain'});await expect(old.dispatch()).rejects.toThrow();
 const next=await f.client().admit('API');
 const row=f.app.db.prepare('SELECT destination FROM secrets_tickets WHERE id=?').get(next) as {destination:string};
 expect(JSON.parse(row.destination)).toMatchObject({job,claimedAt:f.clock.now()+1});
 const binding=JSON.parse(row.destination),input=join(f.home,'new-job-input.sock'),marker=join(f.home,'new-job-consumed');
 const holderIdentity={...f.server,cert:join(f.home,'holder.pem'),key:join(f.home,'holder.key')};
 const transport=workerSecretTransport({...holderIdentity,socket:input,servername:'daemon.test'},f.fingerprint('daemon'));closes.push(transport.close);
 const holder=await listenHolderHandoff({...holderIdentity,socket:f.config.holder.config.socket},{read:async()=>Buffer.from('synthetic-refresh-value')},f.fingerprint('daemon'),routedHolderAuthority(f.remote,[{binding,transport}]));closes.push(holder.close);
 const viewer=signin(f.app).token(hash(token))!.viewer;
 const destination=runtimeHouseDestination(f.app,()=>new SharingDatabase(f.app.db,f.home).sharing(),viewer)!;
 const exit=join(f.home,'new-job-exit');
 // The owner releases process exit only after the original dispatch ack.
 // No wall-clock delay can race a loaded CI runner's acknowledgement.
 const script="const fs=require('node:fs');let b=[];fs.createReadStream(null,{fd:3}).on('data',v=>b.push(v)).on('end',()=>{if(Buffer.concat(b).toString()!=='synthetic-refresh-value'){process.exit(1);return;}const exit=process.argv[2];const watcher=fs.watch(require('node:path').dirname(exit),()=>{if(fs.existsSync(exit)){watcher.close();process.exit(0);}});fs.writeFileSync(process.argv[1],'accepted');if(fs.existsSync(exit)){watcher.close();process.exit(0);}});";
 const command=await startSecretCommand({command:process.execPath,args:['-e',script,marker,exit],cwd:f.home,env:{},
  input:{...f.server,socket:input},holderFingerprint:f.fingerprint('holder'),authority:{...f.server,servername:'daemon.test'},daemonFingerprint:f.fingerprint('daemon')},
  {binding,current:()=>destination.current(),expiresAt:Date.now()+20_000});closes.push(command.close);
 const client=f.client(command.pending.id),ticket=await client.admit('API');command.bindTicket(ticket);
 expect(await f.remote.claim(ticket)).toBeNull();f.release(ticket);
 await client.dispatch();writeFileSync(exit,'exit');expect(await command.completed).toBe(true);expect(readFileSync(marker,'utf8')).toBe('accepted');
 expect(f.state(ticket)).toEqual({state:'released'});

});
test.each(['unknown','malformed-pin','holder-pin','duplicate','overflow','revoked'] as const)('invalid %s replacement does not partially retire the current generation',async failure=>{
 const f=await setup(),id=await f.client().admit('API');
 let selected=f.config.workers;
 if(failure==='unknown')selected=[{...selected[0],tokenDigest:'0'.repeat(64)}];
 if(failure==='malformed-pin')selected=[{...selected[0],fingerprint:'invalid'}];
 if(failure==='holder-pin')selected=[{...selected[0],fingerprint:f.fingerprint('holder')}];
 if(failure==='duplicate')selected=[...selected,...selected];
 if(failure==='overflow')selected=Array.from({length:1025},()=>selected[0]);
 if(failure==='revoked')signin(f.app).tokens.change(tokens=>{tokens[0].revoked=new Date(f.clock.now()).toISOString();});
 expect(()=>f.owner.replaceWorkers(selected)).toThrow('Secret worker startup unavailable');
 expect(f.state(id)).toEqual({state:'admitted'});
 if(failure!=='revoked')expect(await f.client().admit('API')).toMatch(/^[0-9a-f-]{36}$/);
});
test('shutdown permanently refuses peer refresh',async()=>{
 const f=await setup();await f.owner.close();expect(()=>f.owner.replaceWorkers(f.config.workers)).toThrow('Secret worker startup unavailable');
});

test('replacement inside a database transaction cannot retire the generation',async()=>{
 const f=await setup(),id=await f.client().admit('API');
 f.app.db.transaction(()=>{expect(()=>f.owner.replaceWorkers([])).toThrow('Secret worker startup unavailable');})();
 expect(f.state(id)).toEqual({state:'admitted'});expect(await f.client().admit('API')).toMatch(/^[0-9a-f-]{36}$/);
});
test('replacement changes the pinned peer on both admission and read-only worker authority',async()=>{
 const f=await setup();f.owner.replaceWorkers([{tokenDigest:f.tokenDigest,fingerprint:f.fingerprint('stranger')}]);
 await expect(f.client().admit('API')).rejects.toThrow();
 const pending=randomUUID(),peer={...f.server,cert:join(f.home,'stranger.pem'),key:join(f.home,'stranger.key'),servername:'daemon.test'};
 const client=workerAdmission({...peer,socket:f.config.admission.socket},f.fingerprint('daemon'),pending);closes.push(client.close);
 const id=await client.admit('API');expect(await f.remote.claim(id)).toBeNull();f.release(id);
 const claim=(await f.remote.claim(id))!;expect(await claim.current()).toBe(true);
 const proof=remoteWorkerTicketProof(peer,f.fingerprint('daemon'),id,pending);closes.push(proof.close);
 const oldProof=remoteWorkerTicketProof({...f.server,servername:'daemon.test'},f.fingerprint('daemon'),id,pending);closes.push(oldProof.close);
 expect(await proof.current()).toBe(true);expect(await oldProof.current()).toBe(false);
});
test('a mixed batch with a valid prefix and invalid tail preserves the original live authority claim',async()=>{
 const f=await setup(),pending=randomUUID(),id=await f.client(pending).admit('API');
 expect(await f.remote.claim(id)).toBeNull();f.release(id);const claim=(await f.remote.claim(id))!;
 const proof=remoteWorkerTicketProof({...f.server,servername:'daemon.test'},f.fingerprint('daemon'),id,pending);closes.push(proof.close);
 const batch=[...f.config.workers,{...f.config.workers[0],tokenDigest:'0'.repeat(64)}];
 expect(()=>f.owner.replaceWorkers(batch)).toThrow('Secret worker startup unavailable');
 expect(f.state(id)).toEqual({state:'claimed'});expect(await claim.current()).toBe(true);expect(await proof.current()).toBe(true);
 const undispatched=await f.client().admit('API');
 expect(()=>f.owner.replaceWorkers(batch)).toThrow();expect(f.state(undispatched)).toEqual({state:'admitted'});
 await claim.finish(false);
});
test.each(['sparse','member','agent','ended-job','split-assignment','imported-job'] as const)('rejects %s selection before touching either original listener generation',async failure=>{
 const f=await setup(),pending=randomUUID(),id=await f.client(pending).admit('API');
 expect(await f.remote.claim(id)).toBeNull();f.release(id);const claim=(await f.remote.claim(id))!;
 let selected=f.config.workers;
 if(failure==='sparse')selected=new Array(1);
 else {
  const auth=signin(f.app);let token='synthetic-refresh-'+failure;
  if(failure==='member'||failure==='agent')auth.tokens.change(tokens=>tokens.push({role:failure==='member'?'owner':'agent:art',...(failure==='member'?{member:'jonathan'}:{}),sha256:hash(token),label:failure,created:new Date(f.clock.now()).toISOString()}));
  else {
   const store=runtimeStore(f.app.db),job=randomUUID();
   token=f.app.db.transaction(()=>{
    const {changedAt:_,...before}=store.read('job',f.id)!;
    store.put('job',{...before,id:job,...(failure==='ended-job'?{state:'done' as const}:failure==='split-assignment'?{runner:'other'}:{imported:{history:'unknown' as const}})},f.clock.now());
    return auth.issueBody('art',job);
   })();
  }
  expect(auth.token(hash(token))).toBeDefined();
  selected=[...selected,{tokenDigest:hash(token),fingerprint:f.fingerprint('stranger')}];
 }
 expect(()=>f.owner.replaceWorkers(selected)).toThrow('Secret worker startup unavailable');
 expect(f.state(id)).toEqual({state:'claimed'});expect(await claim.current()).toBe(true);
 const proof=remoteWorkerTicketProof({...f.server,servername:'daemon.test'},f.fingerprint('daemon'),id,pending);closes.push(proof.close);expect(await proof.current()).toBe(true);
 const next=await f.client().admit('API');expect(f.state(next)).toEqual({state:'admitted'});
 await claim.finish(false);
});
