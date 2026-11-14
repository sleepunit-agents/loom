import {afterEach,expect,it,vi} from 'vitest';
import {mkdirSync,writeFileSync,readFileSync,existsSync} from 'node:fs';
import {join} from 'node:path';
import {randomBytes,randomUUID} from 'node:crypto';
import {ChildProcess} from 'node:child_process';
import {EventEmitter} from 'node:events';
import {startSecretJobSupervisor} from '../secret-job-supervisor.js';
import {serveHolderOwner} from '../secret-holder-owner.js';
vi.mock('node:child_process',async original=>({...await original<typeof import('node:child_process')>(),fork:vi.fn()}));
import {fork} from 'node:child_process';
import {generateIdentity} from 'age-encryption';
import {startLoom} from '../foundation.js';
import {SharingDatabase} from '../core/household/sharing.js';
import {signin,hash} from '../core/signin/index.js';
import {runtimeStore} from '../pieces/runtime/store.js';
import * as holderStorage from '../pieces/secrets/holder-store.js';
import {openHolderStore} from '../pieces/secrets/holder-store.js';
import {startPersistentHolder} from '../secret-holder-startup.js';
import {inspectWorkerReceipts} from './receipts.js';
import {ticketAuthorityFixture} from './ticket-authority.fixture.js';
import type {WorkerControlRuntime} from './control.js';
const closes:Array<()=>unknown>=[];
afterEach(async()=>{vi.restoreAllMocks();for(const close of closes.splice(0).reverse())await close();});

/** Controlled inherited channel and original close event; no real holder OS
 * process witness. The production supervisor still calls the fixed fork seam. */
function ownedChannels(file:string){
 class Channel extends EventEmitter {
  connected=true;peer!:Channel;
  send(value:unknown,callback:(error:Error|null)=>void){queueMicrotask(()=>{if(this.connected&&this.peer.connected){this.peer.emit('message',structuredClone(value));callback(null);}else callback(Error('closed'));});return true;}
  disconnect(){if(!this.connected)return;this.connected=false;this.emit('disconnect');if(this.peer.connected){this.peer.connected=false;this.peer.emit('disconnect');}}
  kill(){this.disconnect();return true;}
 }
 const parent=new Channel(),child=new Channel();parent.peer=child;child.peer=parent;
 const closed={seen:false};
 return {parent,closed,start(){const serving=serveHolderOwner(child,()=>startPersistentHolder(file,true));void serving.done.then(()=>{closed.seen=true;parent.emit('close',0,null);},()=>{closed.seen=true;parent.emit('close',1,null);});}};
}

async function setup(staging=false,commandExit=0,service?:string) {
 const f=await ticketAuthorityFixture(closes,service);await f.authority.close();await f.app.close();
 const app=await startLoom({home:f.home,next:true,staging,clock:f.clock,stdout(){}});closes.push(app.close);
 const sharing=()=>new SharingDatabase(app.db,f.home).sharing();
 const socket=(name:string)=>join(f.home,name+'.sock');
 const directory=join(f.home,'ciphertext'),identity=join(f.home,'age-key'),fingerprintKey=join(f.home,'retry-key');
 mkdirSync(directory,{mode:0o700});writeFileSync(identity,await generateIdentity(),{mode:0o600});writeFileSync(fingerprintKey,randomBytes(32),{mode:0o600});
 const seed=await openHolderStore(directory,identity,fingerprintKey);
 await seed.set({member:'jonathan',writeId:randomUUID()},'API',Buffer.from('synthetic-owner-value'),'add');seed.close();
 const holderFile=join(f.home,'holder.json');
 writeFileSync(holderFile,JSON.stringify({directory,identity,fingerprintKey,daemonFingerprint:f.fingerprint('daemon'),
  read:{...f.config,socket:socket('read'),servername:undefined},mutation:{...f.config,socket:socket('write'),servername:undefined},
  authority:{...f.config,socket:socket('write-authority')},handoff:{listen:{...f.config,socket:socket('holder'),servername:undefined},authority:f.config,workers:[],ownerPeers:[{config:{...f.config,socket:socket('input')},fingerprint:f.fingerprint('daemon')}]}}),{mode:0o600});

 const store=runtimeStore(app.db),house=store.read('settings','art')!.house!;
 app.db.transaction(()=>{
  const {changedAt:_,claimedAt:_claim,made:_made,...before}=store.read('job',f.id)!;
  store.put('job',{...before,state:'queued'},f.clock.now());
  app.db.prepare('INSERT INTO runtime_inputs(job,brief,needs) VALUES (?,?,?)').run(f.id,'Unused command brief','[]');
 })();
 expect(app.operations.call('direct',{kind:'member',id:'jonathan'},'signin.setPrincipal',{kind:'runner',id:'worker',active:true},randomUUID()).ok).toBe(true);
 const token='synthetic-owner-runner';
 signin(app).tokens.change(tokens=>tokens.push({role:'runner:worker',sha256:hash(token),label:'fixture',created:new Date(f.clock.now()).toISOString()}));
 const receipts=join(f.home,'receipts');mkdirSync(receipts,{mode:0o700});
 const marker=join(f.home,'accepted'),input=socket('input');
 const script="const fs=require('node:fs');process.on('SIGUSR2',()=>process.exit(0));let b=[];fs.createReadStream(null,{fd:3}).on('data',v=>b.push(v)).on('end',()=>{if(Buffer.concat(b).toString()!=='synthetic-owner-value')process.exit(1);fs.writeFileSync(process.argv[1],'accepted');setInterval(()=>{},10000);});";
 const config={job:f.id,agent:'art',tokenDigest:f.tokenDigest,fingerprint:f.fingerprint('daemon'),policy:['API'],name:'API',
  expiresAt:Date.now()+20_000,grantExpiresAt:Date.now()+20_000,
  command:{command:process.execPath,args:['-e',script.replace('process.exit(0)','process.exit('+commandExit+')'),marker],cwd:f.home,env:{},input:{...f.server,socket:input},holderFingerprint:f.fingerprint('holder'),
   authority:{...f.server,servername:'daemon.test'},daemonFingerprint:f.fingerprint('daemon'),admission:{...f.server,socket:socket('admission'),servername:'daemon.test'}},
  holder:{config:{...f.config,socket:input},fingerprint:f.fingerprint('daemon')}};

 let child:ChildProcess|undefined;
 const emit=ChildProcess.prototype.emit;
 vi.spyOn(ChildProcess.prototype,'emit').mockImplementation(function(this:ChildProcess,...args:Parameters<ChildProcess['emit']>){
  if(args[0]==='spawn')child=this;return Reflect.apply(emit,this,args);
 });
 const calls:{name:string;body:unknown}[]=[],ticks=new Set<()=>void>();
 const runtime:WorkerControlRuntime={deadline:ms=>AbortSignal.timeout(ms),every(callback){ticks.add(callback);return ()=>{ticks.delete(callback);};},request:async(url,init)=>{
  const name=new URL(String(url)).pathname.split('/').pop()!;calls.push({name,body:JSON.parse(String(init?.body))});
  const response=await fetch(url,init);
  if(name==='reportJob'&&response.ok){await expect.poll(()=>existsSync(marker)).toBe(true);child?.kill('SIGUSR2');}
  return response;
 }};
 const channels=ownedChannels(holderFile);
 vi.mocked(fork).mockImplementation(()=>{channels.start();return channels.parent as unknown as ChildProcess;});
 const owner=startSecretJobSupervisor(app,sharing,app.effects!,{
  daemon:{authority:f.server,admission:{...f.server,socket:socket('admission')},holder:{config:{...f.server,socket:socket('holder'),servername:'holder.test'},fingerprint:f.fingerprint('holder')}},
  holderFile,assignment:config,control:{url:app.url,token,job:f.id},selected:{agent:'art',house,receipts}},runtime);
 closes.push(()=>owner.close().catch(()=>{}));
 return {...f,app,owner,config,runtime,calls,marker,receipts,directory,store,channels};
}

it('production source root owns queued claim, daemon, inherited holder and dedicated worker through joined finish',async()=>{
 const f=await setup();await f.owner.ready;f.clock.advance(17);await f.owner.run();
 expect(f.store.read('job',f.id)).toMatchObject({state:'done',claimedAt:f.clock.now()});
 expect(readFileSync(f.marker,'utf8')).toBe('accepted');expect(f.channels.closed.seen).toBe(true);
 expect(fork).toHaveBeenCalledOnce();expect(inspectWorkerReceipts(f.receipts)).toMatchObject([{phase:'finished'}]);
 expect(f.calls.filter(c=>c.name!=='jobControl').map(c=>c.name)).toEqual(['claimJob','takeInput','reportJob','finishJob']);
 const row=f.app.db.prepare('SELECT destination,state FROM secrets_tickets').get() as {destination:string;state:string};
 expect(JSON.parse(row.destination)).toMatchObject({job:f.id,claimedAt:f.clock.now()});expect(row.state).toBe('released');
 expect(f.app.operations.call('direct',{kind:'member',id:'jonathan'},'secrets.usage',{name:'API'})).toMatchObject({ok:true,value:{count:1,events:[{state:'released',action:'issue',by:{kind:'agent',id:'art'},house:f.id}]}});
 for(const {name} of f.app.db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as {name:string}[])expect(JSON.stringify(f.app.db.prepare('SELECT * FROM "'+name.replaceAll('"','""')+'"').all())).not.toContain('synthetic-owner-value');
 expect(JSON.stringify(f.calls)).not.toContain('synthetic-owner-value');
 expect(existsSync(f.config.command.input.socket)).toBe(false);
 await expect(f.owner.run()).rejects.toThrow();
});
it('production source root staging holds the actual input without spawning a command',async()=>{
 const f=await setup(true),spawn=vi.spyOn(ChildProcess.prototype,'spawn');await expect(f.owner.run()).rejects.toThrow();
 expect(spawn).not.toHaveBeenCalled();expect(existsSync(f.marker)).toBe(false);expect(f.channels.closed.seen).toBe(true);
 expect(inspectWorkerReceipts(f.receipts)).toMatchObject([{phase:'input-attempt'}]);
 expect(f.app.db.prepare('SELECT * FROM secrets_tickets').all()).toEqual([]);
 expect(f.app.db.prepare('SELECT * FROM secrets_uses').all()).toEqual([]);
 const held=f.app.db.prepare("SELECT id,kind,state FROM core_effects WHERE kind='body-start'").all() as {id:string;kind:string;state:string}[];
 expect(held).toEqual([{id:expect.any(String),kind:'body-start',state:'due'}]);
 expect(f.app.operations.call('direct',{kind:'member',id:'jonathan'},'core.releaseEffect',{id:held[0].id},randomUUID()).ok).toBe(true);
 f.clock.advance(1);await expect(f.owner.run()).rejects.toThrow();
 expect(spawn).not.toHaveBeenCalled();
 expect(f.app.db.prepare('SELECT * FROM secrets_uses').all()).toEqual([]);
});

it('counts acknowledged delivery even when the original command subsequently fails, without finishing Runtime',async()=>{
 const f=await setup(false,1);await expect(f.owner.run()).rejects.toThrow();
 expect(f.store.read('job',f.id)?.state).toBe('running');
 expect(f.calls.some(c=>c.name==='finishJob')).toBe(false);
 expect(f.app.operations.call('direct',{kind:'member',id:'jonathan'},'secrets.usage',{name:'API'})).toMatchObject({ok:true,value:{count:1,events:[{state:'released'}]}});
 expect(f.channels.closed.seen).toBe(true);
});

it('refuses the real holder read and delivery when usage admission fails',async()=>{
 const read=vi.fn(),open=holderStorage.openHolderStore;
 vi.spyOn(holderStorage,'openHolderStore').mockImplementation(async(...args)=>{
  const store=await open(...args),original=store.read.bind(store);
  store.read=(name)=>{read(name);return original(name);};return store;
 });
 const f=await setup();
 f.app.db.exec("CREATE TRIGGER deny_use BEFORE INSERT ON secrets_uses BEGIN SELECT RAISE(ABORT,'synthetic-private-error'); END");
 const spawn=vi.spyOn(ChildProcess.prototype,'spawn');
 await expect(f.owner.run()).rejects.toThrow('Secret job supervisor unavailable');
 expect(read).not.toHaveBeenCalled();expect(existsSync(f.marker)).toBe(false);
 expect(f.app.db.prepare('SELECT * FROM secrets_uses').all()).toEqual([]);
 expect(f.app.db.prepare('SELECT state FROM secrets_tickets').all()).toEqual([{state:'uncertain'}]);
 expect(f.app.db.prepare("SELECT state FROM core_effects WHERE kind='secret-read'").all()).toEqual([{state:'uncertain'}]);
 spawn.mockClear();f.app.db.exec('DROP TRIGGER deny_use');await expect(f.owner.run()).rejects.toThrow();
 expect(spawn).not.toHaveBeenCalled();expect(f.channels.closed.seen).toBe(true);
});
it('leaves real delivery unconfirmed and cannot retry when final audit persistence fails',async()=>{
 const f=await setup();
 f.app.db.exec("CREATE TRIGGER deny_use_finish BEFORE UPDATE ON secrets_uses BEGIN SELECT RAISE(ABORT,'synthetic-private-error'); END");
 await expect(f.owner.run()).rejects.toThrow('Secret job supervisor unavailable');
 expect(f.app.operations.call('direct',{kind:'member',id:'jonathan'},'secrets.usage',{name:'API'})).toMatchObject({ok:true,value:{count:0,events:[{state:'started'}]}});
 const spawn=vi.spyOn(ChildProcess.prototype,'spawn');
 f.app.db.exec('DROP TRIGGER deny_use_finish');await expect(f.owner.run()).rejects.toThrow();expect(spawn).not.toHaveBeenCalled();
 expect(f.calls.some(c=>c.name==='finishJob')).toBe(false);expect(f.channels.closed.seen).toBe(true);
});
