import {afterEach,expect,test,vi} from 'vitest';
import {existsSync,readFileSync} from 'node:fs';
import {join} from 'node:path';
import {startLoom} from './foundation.js';
import {signin} from './core/signin/index.js';
import {SharingDatabase} from './core/household/sharing.js';
import {runtimeHouseDestination} from './pieces/runtime/role.js';
import {ticketAuthorityFixture} from './runtime-runner/ticket-authority.fixture.js';
import {startAdmittedSecretCommand} from './runtime-runner/admitted-secret-command.js';
import {workerSecretTransport} from './runtime-runner/secret-transport.js';
import {listenHolderHandoff} from './pieces/secrets/holder-handoff.js';
import {routedHolderAuthority} from './pieces/secrets/holder-routing.js';
import {workerAdmission} from './pieces/secrets/worker-admission.js';
import type {SecretWorkersConfig} from './secret-worker-startup.js';
const closes:Array<()=>unknown>=[];
afterEach(async()=>{vi.restoreAllMocks();for(const close of closes.reverse())await close();closes.length=0;});
async function setup(service?:string) {
 const f=await ticketAuthorityFixture(closes,service);
 await f.authority.close();await f.app.close();
 const holderSocket=join(f.home,'startup-holder.sock'),admissionSocket=join(f.home,'startup-admission.sock');
 const config:SecretWorkersConfig={authority:{...f.server},admission:{...f.server,socket:admissionSocket},
  holder:{config:{...f.server,socket:holderSocket,servername:'holder.test'},fingerprint:f.fingerprint('holder')},
  workers:[{tokenDigest:f.tokenDigest,fingerprint:f.fingerprint('daemon')}]};
 const start=(override=config,staging=true)=>startLoom({home:f.home,next:true,staging,clock:f.clock,stdout(){},secretWorkers:override});
 return {...f,config,start,holderSocket,admissionSocket};
}
test.each([true,false])('actual daemon startup shares original admission and authority with fd3 (staging=%s)',async(staging)=>{
 const f=await setup('bridge');const app=await f.start(f.config,staging);closes.push(app.close);
 const viewer=signin(app).token(f.tokenDigest)!.viewer;
 const destination=runtimeHouseDestination(app,()=>new SharingDatabase(app.db,f.home).sharing(),viewer)!;
 const {agent,job,runner,box,claimedAt,service}=destination;
 const binding={agent,job,runner,box,claimedAt,service};
 const input=join(f.home,'startup-input.sock'),marker=join(f.home,'accepted');
 const transport=workerSecretTransport({...f.config.holder.config,socket:input,cert:join(f.home,'holder.pem'),key:join(f.home,'holder.key'),servername:'daemon.test'},f.fingerprint('daemon'));closes.push(transport.close);
 const source=vi.fn(async()=>Buffer.from('synthetic-startup-value'));
 const holder=await listenHolderHandoff({...f.server,socket:f.holderSocket,cert:join(f.home,'holder.pem'),key:join(f.home,'holder.key')},{read:source},f.fingerprint('daemon'),routedHolderAuthority(f.remote,[{binding,transport}]));closes.push(holder.close);
 const script="const fs=require('node:fs');let b=[];fs.createReadStream(null,{fd:3}).on('data',v=>b.push(v)).on('end',()=>{if(Buffer.concat(b).toString()!=='synthetic-startup-value')process.exit(1);fs.writeFileSync(process.argv[1],'accepted');setTimeout(()=>process.exit(0),100);});";
 const command=await startAdmittedSecretCommand({command:process.execPath,args:['-e',script,marker],cwd:f.home,env:{},
  input:{...f.server,socket:input},holderFingerprint:f.fingerprint('holder'),authority:{...f.server,servername:'daemon.test'},
  daemonFingerprint:f.fingerprint('daemon'),admission:{...f.server,socket:f.admissionSocket,servername:'daemon.test'}},
  {name:'API',binding,current:()=>destination.current(),expiresAt:Date.now()+20_000});closes.push(command.close);
 // Staging must hold the owning daemon's original dispatch, even though both
 // private listeners and the actual worker process have started successfully.
 expect(await command.delivery).toBe(!staging);
 if(staging) {expect(source).not.toHaveBeenCalled();expect(existsSync(marker)).toBe(false);}
 else {expect(await command.completed).toBe(true);expect(source).toHaveBeenCalledOnce();expect(readFileSync(marker,'utf8')).toBe('accepted');}
 expect(app.db.prepare('SELECT state FROM secrets_tickets').get()).toEqual({state:staging?'uncertain':'released'});
 expect(JSON.stringify(app.db.prepare('SELECT * FROM secrets_tickets').all())).not.toContain('synthetic-startup-value');
});
test('startup rejects stale and non-body credentials without opening either listener',async()=>{
 const f=await setup();
 await expect(f.start({...f.config,workers:[{...f.config.workers[0],tokenDigest:'0'.repeat(64)}]})).rejects.toThrow('Secret worker startup unavailable');
 expect(existsSync(f.server.socket)).toBe(false);expect(existsSync(f.admissionSocket)).toBe(false);
 // Failure releases home ownership; a later legitimate startup is possible.
 const app=await f.start();closes.push(app.close);
});
test('partial admission startup failure drains the already listening authority and releases the home',async()=>{
 const f=await setup();
 await expect(f.start({...f.config,admission:{...f.config.admission,socket:join(f.home,'missing','admission.sock')}})).rejects.toThrow('Secret worker startup unavailable');
 expect(existsSync(f.server.socket)).toBe(false);
 const app=await f.start();closes.push(app.close);
});
test('daemon close retires an admitted original ticket before closing SQLite and removes listeners',async()=>{
 const f=await setup();const app=await f.start();closes.push(app.close);
 const client=workerAdmission({...f.server,socket:f.admissionSocket,servername:'daemon.test'},f.fingerprint('daemon'),'11111111-1111-4111-8111-111111111111');closes.push(client.close);
 const id=await client.admit('API');
 const closeDb=vi.spyOn(app.db,'close');
 let state:unknown;
 closeDb.mockImplementationOnce(()=>{state=app.db.prepare('SELECT state FROM secrets_tickets WHERE id=?').get(id);closeDb.mockRestore();app.db.close();});
 await app.close();expect(state).toEqual({state:'uncertain'});
 expect(existsSync(f.server.socket)).toBe(false);expect(existsSync(f.admissionSocket)).toBe(false);
});
test('configuration is captured before startup awaits and cannot redirect the original peer',async()=>{
 const f=await setup();const started=f.start();
 f.config.workers[0].tokenDigest='0'.repeat(64);f.config.admission.socket=join(f.home,'wrong.sock');
 f.config.holder.config.socket=join(f.home,'wrong-holder.sock');
 const app=await started;closes.push(app.close);
 const client=workerAdmission({...f.server,socket:f.admissionSocket,servername:'daemon.test'},f.fingerprint('daemon'),'22222222-2222-4222-8222-222222222222');closes.push(client.close);
 expect(await client.admit('API')).toMatch(/^[0-9a-f-]{36}$/);
});
test('legacy mode refuses credential worker startup explicitly',async()=>{
 const f=await setup();await expect(startLoom({home:f.home,secretWorkers:f.config})).rejects.toThrow('requires next mode');
});
test('original authenticated startup viewer loses admission authority on credential revocation',async()=>{
 const f=await setup();const app=await f.start();closes.push(app.close);
 signin(app).tokens.change(tokens=>{for(const token of tokens)if(token.sha256===f.tokenDigest)token.revoked=new Date(f.clock.now()).toISOString();});
 const client=workerAdmission({...f.server,socket:f.admissionSocket,servername:'daemon.test'},f.fingerprint('daemon'),'33333333-3333-4333-8333-333333333333');closes.push(client.close);
 await expect(client.admit('API')).rejects.toThrow('Worker admission unavailable');
 expect(app.db.prepare('SELECT COUNT(*) AS n FROM secrets_tickets').get()).toEqual({n:0});
});
test('configured distinct worker pin rejects another CA-valid peer before admission',async()=>{
 const f=await setup();const app=await f.start();closes.push(app.close);
 const client=workerAdmission({...f.server,cert:join(f.home,'stranger.pem'),key:join(f.home,'stranger.key'),socket:f.admissionSocket,servername:'daemon.test'},f.fingerprint('daemon'),'44444444-4444-4444-8444-444444444444');closes.push(client.close);
 await expect(client.admit('API')).rejects.toThrow('Worker admission unavailable');
 expect(app.db.prepare('SELECT COUNT(*) AS n FROM secrets_tickets').get()).toEqual({n:0});
});
test('duplicate worker pins and holder/worker pin collision fail startup with no listener left',async()=>{
 const f=await setup();
 await expect(f.start({...f.config,workers:[...f.config.workers,...f.config.workers]})).rejects.toThrow('Secret worker startup unavailable');
 await expect(f.start({...f.config,workers:[{...f.config.workers[0],fingerprint:f.fingerprint('holder')}]})).rejects.toThrow('Secret worker startup unavailable');
 expect(existsSync(f.server.socket)).toBe(false);expect(existsSync(f.admissionSocket)).toBe(false);
});
