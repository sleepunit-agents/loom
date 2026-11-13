import {afterEach,expect,it,vi} from 'vitest';
import {mkdtempSync,mkdirSync,readFileSync,writeFileSync,rmSync,chmodSync,openSync,fstatSync,constants} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {X509Certificate,randomBytes,randomUUID} from 'node:crypto';
import {generateIdentity} from 'age-encryption';
import {startLoom} from '../../foundation.js';
import * as foundation from '../../foundation.js';
import {run as serve} from '../../cli/serve.js';
import {Readable} from 'node:stream';
import https from 'node:https';
import type {Socket} from 'node:net';
import {fixture} from '../../fixture.js';
import {FakeClock} from '../../core/clock.js';
import {configuredSecretWrites} from './holder-config.js';
import {startPersistentHolder} from './holder-lifecycle.js';
import {localSecretSource} from './local-holder.js';
vi.mock('node:fs',async importOriginal=>{
  const real=await importOriginal<typeof import('node:fs')>();
  return {...real,openSync:vi.fn(real.openSync),fstatSync:vi.fn(real.fstatSync),readFileSync:vi.fn(real.readFileSync)};
});
const realFs=await vi.importActual<typeof import('node:fs')>('node:fs');
const homes:string[]=[],stops:Array<()=>Promise<void>>=[];
afterEach(async()=>{for(const stop of stops.splice(0).reverse())await stop();for(const home of homes.splice(0))rmSync(home,{recursive:true,force:true});vi.restoreAllMocks();});
async function setup(){
  const home=mkdtempSync(join(tmpdir(),'next-secret-writes-'));homes.push(home);
  const tls=fileURLToPath(new URL('./fixtures/lifecycle-tls/',import.meta.url));
  for(const name of ['ca.pem','holder.pem','holder.key','daemon.pem','daemon.key'])writeFileSync(join(home,name),readFileSync(join(tls,name)),{mode:0o600});
  const ca=join(home,'ca.pem'),holder={ca,cert:join(home,'holder.pem'),key:join(home,'holder.key')},daemon={ca,cert:join(home,'daemon.pem'),key:join(home,'daemon.key')};
  const authority={...daemon,socket:join(home,'authority.sock'),holderFingerprint:new X509Certificate(readFileSync(holder.cert)).fingerprint256};
  const directory=join(home,'store');mkdirSync(directory,{mode:0o700});
  const identity=join(home,'identity'),fingerprintKey=join(home,'receipt'),retry=join(home,'retry');
  writeFileSync(identity,await generateIdentity(),{mode:0o600});writeFileSync(fingerprintKey,randomBytes(32),{mode:0o600});writeFileSync(retry,randomBytes(32),{mode:0o600});
  const read={...holder,socket:join(home,'read.sock')},mutation={...holder,socket:join(home,'mutation.sock')};
  const file=join(home,'holder.json');writeFileSync(file,JSON.stringify({read,mutation,authority:{...holder,socket:authority.socket,servername:'daemon.test'},directory,identity,fingerprintKey,daemonFingerprint:new X509Certificate(readFileSync(daemon.cert)).fingerprint256}),{mode:0o600});
  const writes=join(home,'writes.json');writeFileSync(writes,JSON.stringify({holder:{...daemon,socket:mutation.socket,servername:'holder.test'},retryKeys:{active:retry,previous:[]}}),{mode:0o600});
  const appHome=join(home,'app');mkdirSync(appHome,{mode:0o700});fixture(appHome);
  return {home,appHome,authority,file,writes,source:localSecretSource({...daemon,socket:read.socket,servername:'holder.test'})};
}
const owner={kind:'member' as const,id:'jonathan'};
it('normal root uses real authenticated holder, stable keys, metadata and removal across restart',async()=>{
  const s=await setup(),clock=new FakeClock();
  let app=await startLoom({home:s.appHome,next:true,clock,secretAuthority:s.authority,secretWrites:configuredSecretWrites(s.writes),stdout:()=>{}});
  let holder=await startPersistentHolder(s.file);stops.push(async()=>{await holder.close();await app.close();});
  const input={name:'API',writeId:randomUUID(),mode:'add',value:'ROOT-ONLY-SENTINEL'};
  expect(await app.operations.callAsync('http',{kind:'agent',id:'art'},'secrets.set',input,'denied')).toMatchObject({ok:false,code:'denied'});
  expect(await app.operations.callAsync('http',owner,'secrets.set',input,'save')).toEqual({ok:true,value:{saved:true}});
  const bytes=await s.source.read('API');expect(Buffer.from(bytes).toString()).toBe(input.value);bytes.fill(0);
  await holder.close();await app.close();
  app=await startLoom({home:s.appHome,next:true,clock,secretAuthority:s.authority,secretWrites:configuredSecretWrites(s.writes),stdout:()=>{}});holder=await startPersistentHolder(s.file);
  expect(await app.operations.callAsync('http',owner,'secrets.set',input,'save')).toEqual({ok:true,value:{saved:true}});
  expect(await app.operations.callAsync('http',owner,'secrets.remove',{name:'API',writeId:randomUUID()},'remove')).toEqual({ok:true,value:{removed:true}});
  await expect(s.source.read('API')).rejects.toThrow();
  for(const {name} of app.db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as {name:string}[])
    expect(JSON.stringify(app.db.prepare(`SELECT * FROM "${name.replaceAll('"','""')}"`).all())).not.toContain(input.value);
});
it('staging makes no holder call before release, retains admission and retries exact input after release',async()=>{
  const s=await setup(),clock=new FakeClock(),config=configuredSecretWrites(s.writes);
  const read=vi.spyOn(config.holder,'hasReceipt'),set=vi.spyOn(config.holder,'set');
  const app=await startLoom({home:s.appHome,next:true,staging:true,clock,secretAuthority:s.authority,secretWrites:config,stdout:()=>{}});stops.push(app.close);
  const holder=await startPersistentHolder(s.file);stops.push(holder.close);
  const input={name:'API',writeId:randomUUID(),mode:'add',value:'HELD-SENTINEL'};
  expect(await app.operations.callAsync('http',owner,'secrets.set',input,'held')).toMatchObject({ok:false,code:'unavailable'});
  clock.advance(60_000);await Promise.resolve();
  expect(read).not.toHaveBeenCalled();expect(set).not.toHaveBeenCalled();
  const effect=app.db.prepare("SELECT * FROM core_effects WHERE kind='secret-write'").get() as {id:string;state:string};expect(effect.state).toBe('due');
  expect(app.operations.call('http',owner,'core.releaseEffect',{id:effect.id},'release').ok).toBe(true);
  expect(await app.operations.callAsync('http',owner,'secrets.set',input,'held')).toEqual({ok:true,value:{saved:true}});
  expect(read).toHaveBeenCalledTimes(1);expect(set).toHaveBeenCalledTimes(1);
});
it('root recovers a confirmed write on clock alone after lost acknowledgement and database restart',async()=>{
  const s=await setup(),clock=new FakeClock(),config=configuredSecretWrites(s.writes),real=config.holder.set;
  config.holder.set=async(...args)=>{await real(...args);throw new Error('lost acknowledgement');};
  let app=await startLoom({home:s.appHome,next:true,clock,secretAuthority:s.authority,secretWrites:config,stdout:()=>{}});
  let holder=await startPersistentHolder(s.file);stops.push(async()=>{await holder.close();await app.close();});
  expect(await app.operations.callAsync('http',owner,'secrets.set',{name:'API',writeId:randomUUID(),mode:'add',value:'RECOVER-SENTINEL'},'recover')).toMatchObject({ok:false,code:'unavailable'});
  await holder.close();await app.close();
  app=await startLoom({home:s.appHome,next:true,clock,secretAuthority:s.authority,secretWrites:configuredSecretWrites(s.writes),stdout:()=>{}});holder=await startPersistentHolder(s.file);
  clock.advance(0);
  await expect.poll(()=>app.db.prepare('SELECT state FROM secrets_write_intents').get()).toEqual({state:'complete'});
  expect(app.operations.call('http',owner,'secrets.list',{})).toMatchObject({ok:true,value:{names:[{id:'API'}]}});
});
it('refuses writes without authority and releases startup resources after an invalid retry key',async()=>{
  const s=await setup(),config=configuredSecretWrites(s.writes);
  await expect(startLoom({home:s.appHome,next:true,secretWrites:config,stdout:()=>{}})).rejects.toThrow('Secret writes require holder authority');
  await expect(startLoom({home:s.appHome,next:true,secretAuthority:s.authority,secretWrites:{...config,retryKeys:join(s.home,'missing')},stdout:()=>{}})).rejects.toThrow('Secret retry key unavailable');
  const app=await startLoom({home:s.appHome,next:true,secretAuthority:s.authority,secretWrites:config,stdout:()=>{}});stops.push(app.close);
  expect(app.operations.has('secrets.set')).toBe(true);
});
it('close during holder acknowledgement performs no late database work and staging restart reconciles its previously released attempt',async()=>{
  const s=await setup(),clock=new FakeClock(),config=configuredSecretWrites(s.writes),real=config.holder.set;
  let release!:()=>void,entered!:()=>void;
  const blocked=new Promise<void>(r=>{release=r;}),started=new Promise<void>(r=>{entered=r;});
  config.holder.set=async(...args)=>{await real(...args);entered();await blocked;};
  let app=await startLoom({home:s.appHome,next:true,staging:true,clock,secretAuthority:s.authority,secretWrites:config,stdout:()=>{}});
  const holder=await startPersistentHolder(s.file);stops.push(async()=>{await holder.close();await app.close();});
  const input={name:'API',writeId:randomUUID(),mode:'add',value:'CLOSE-SENTINEL'};
  await app.operations.callAsync('http',owner,'secrets.set',input,'closing');
  const effect=app.db.prepare("SELECT id FROM core_effects WHERE kind='secret-write'").get() as {id:string};
  expect(app.operations.call('http',owner,'core.releaseEffect',effect,'allow').ok).toBe(true);
  const pending=app.operations.callAsync('http',owner,'secrets.set',input,'closing');await started;
  await app.close();
  const prepare=vi.spyOn(app.db,'prepare'),transaction=vi.spyOn(app.db,'transaction');
  release();expect(await pending).toMatchObject({ok:false,code:'unavailable'});
  expect(prepare).not.toHaveBeenCalled();expect(transaction).not.toHaveBeenCalled();prepare.mockRestore();transaction.mockRestore();
  app=await startLoom({home:s.appHome,next:true,staging:true,clock,secretAuthority:s.authority,secretWrites:configuredSecretWrites(s.writes),stdout:()=>{}});
  clock.advance(0);await expect.poll(()=>app.db.prepare('SELECT state FROM secrets_write_intents').get()).toEqual({state:'complete'});
});

it('serve loads explicit strict private writes configuration and dispatches through the normal root',async()=>{
  const s=await setup(),authorityFile=join(s.home,'authority.json');writeFileSync(authorityFile,JSON.stringify(s.authority),{mode:0o600});
  const actual=foundation.startLoom;let app:Awaited<ReturnType<typeof startLoom>>|undefined;
  const start=vi.spyOn(foundation,'startLoom').mockImplementation(async options=>app=await actual({...options,port:0,clock:new FakeClock()}));
  let ready=false;const running=serve(['--next','--home',s.appHome,'--secret-authority',authorityFile,'--secret-writes',s.writes],
    {stdin:Readable.from([]),stdinIsTTY:false,env:{},stdout:()=>{},stderr:text=>{if(text.includes('next app on'))ready=true;}});
  let holder:Awaited<ReturnType<typeof startPersistentHolder>>|undefined;
  try {
    await expect.poll(()=>ready).toBe(true);holder=await startPersistentHolder(s.file);
    expect(start.mock.calls[0][0].secretWrites).toBeDefined();
    expect(await app!.operations.callAsync('http',owner,'secrets.set',{name:'API',writeId:randomUUID(),mode:'add',value:'CLI-ROOT-SENTINEL'},'cli')).toMatchObject({ok:true});
  } finally {await holder?.close();process.emit('SIGTERM');expect(await running).toBe(0);start.mockRestore();}
});
it('CLI rejects incomplete and malformed mutation config with fixed value-free diagnostics',async()=>{
  const s=await setup(),error:string[]=[];
  const io={stdin:Readable.from([]),stdinIsTTY:false,env:{},stdout:()=>{},stderr:(text:string)=>error.push(text)};
  expect(await serve(['--secret-writes',s.writes],io)).toBe(2);expect(error.splice(0)).toEqual(['--secret-writes requires --next\n']);
  expect(await serve(['--next','--secret-writes',s.writes],io)).toBe(2);expect(error.splice(0)).toEqual(['--secret-writes requires --secret-authority\n']);
  const file=join(s.home,'authority.json');writeFileSync(file,JSON.stringify(s.authority),{mode:0o600});
  const valid=JSON.parse(readFileSync(s.writes,'utf8'));
  for(const bad of [{...valid,extra:'PRIVATE-SENTINEL'},{...valid,holder:{...valid.holder,extra:'PRIVATE-SENTINEL'}},{...valid,retryKeys:{active:'relative',previous:[]}},{...valid,retryKeys:{...valid.retryKeys,extra:'PRIVATE-SENTINEL'}}]) {
    writeFileSync(s.writes,JSON.stringify(bad),{mode:0o600});
    expect(await serve(['--next','--secret-authority',file,'--secret-writes',s.writes],io)).toBe(2);
    expect(error.splice(0)).toEqual(['Invalid secret mutation configuration\n']);
  }
  writeFileSync(s.writes,JSON.stringify(valid),{mode:0o600});chmodSync(s.writes,0o644);
  expect(await serve(['--next','--secret-authority',file,'--secret-writes',s.writes],io)).toBe(2);
  expect(error.splice(0)).toEqual(['Invalid secret mutation configuration\n']);
});
it('configured root removal cancels its managed Attention ask atomically and retries after rollback',async()=>{
  const s=await setup();const app=await startLoom({home:s.appHome,next:true,clock:new FakeClock(),secretAuthority:s.authority,secretWrites:configuredSecretWrites(s.writes),stdout:()=>{}});stops.push(app.close);
  const holder=await startPersistentHolder(s.file);stops.push(holder.close);
  expect((await app.operations.callAsync('http',owner,'secrets.set',{name:'API',writeId:randomUUID(),mode:'add',value:'ATTENTION-ROOT-SENTINEL'},'add')).ok).toBe(true);
  const request=app.operations.call('direct',{kind:'agent',id:'art'},'secrets.requestHouse',{agent:'art',target:'API',scope:{house:'h-1'},why:'fixture',minutes:2},'request');
  expect(request.ok).toBe(true);if(!request.ok)throw Error('request refused');const id=(request.value as {id:string}).id;
  const ask=()=>app.operations.call('direct',owner,'attention.get',{id});
  expect(ask()).toMatchObject({ok:true,value:{state:'open'}});
  const before=app.db.prepare('SELECT * FROM secrets_names').all(),changed=vi.spyOn(app.live,'changed');
  app.db.exec("CREATE TRIGGER reject_cancel BEFORE UPDATE ON attention_asks BEGIN SELECT RAISE(ABORT,'fixture'); END");
  const input={name:'API',writeId:randomUUID()};
  expect(await app.operations.callAsync('http',owner,'secrets.remove',input,'remove')).toMatchObject({ok:false,code:'unavailable'});
  expect(ask()).toMatchObject({ok:true,value:{state:'open'}});expect(app.db.prepare('SELECT * FROM secrets_names').all()).toEqual(before);
  // The holder has committed removal, but metadata and Attention must roll back together.
  await expect(s.source.read('API')).rejects.toThrow();
  expect(changed.mock.calls.flatMap(c=>c[0]).filter(c=>c.type==='attention.ask'||c.type==='secret.name')).toEqual([]);
  app.db.exec('DROP TRIGGER reject_cancel');
  expect(await app.operations.callAsync('http',owner,'secrets.remove',input,'remove')).toMatchObject({ok:true,value:{removed:true}});
  expect(ask()).toMatchObject({ok:true,value:{state:'resolved'}});
});

it.each(['receipt','mutation'])('shutdown destroys an actually stalled authenticated %s request before database close',async stall=>{
  const s=await setup(),clock=new FakeClock(),serverConfig=JSON.parse(readFileSync(s.file,'utf8')).mutation;
  const sockets=new Set<Socket>();let received=false;
  const server=https.createServer({ca:readFileSync(serverConfig.ca),cert:readFileSync(serverConfig.cert),key:readFileSync(serverConfig.key),requestCert:true,rejectUnauthorized:true,minVersion:'TLSv1.3'},(req,res)=>{
    req.resume();
    if(stall==='mutation'&&req.url==='/v1/receipt'){res.writeHead(404,{'content-length':'0'});res.end();}
    else received=true;
  });
  server.on('connection',socket=>{sockets.add(socket);socket.on('error',()=>{});socket.once('close',()=>sockets.delete(socket));});
  await new Promise<void>(resolve=>server.listen(serverConfig.socket,resolve));
  // Fixture listener uses the same private protocol directory and permissions.
  chmodSync(serverConfig.socket,0o600);
  stops.push(async()=>{for(const socket of sockets)socket.destroy();await new Promise<void>(resolve=>server.close(()=>resolve()));});
  const config=configuredSecretWrites(s.writes),app=await startLoom({home:s.appHome,next:true,clock,secretAuthority:s.authority,secretWrites:config,stdout:()=>{}});stops.push(app.close);
  const actual=https.request,requests:ReturnType<typeof https.request>[]=[];
  const spy=vi.spyOn(https,'request').mockImplementation((...args:Parameters<typeof https.request>)=>{const req=actual(...args);requests.push(req);return req;});
  const pending=app.operations.callAsync('http',owner,'secrets.set',{name:'API',writeId:randomUUID(),mode:'add',value:'SOCKET-ROOT-SENTINEL'},'stall');
  await expect.poll(()=>received).toBe(true);await app.close();
  const db=vi.spyOn(app.db,'prepare');expect(await pending).toMatchObject({ok:false,code:'unavailable'});expect(db).not.toHaveBeenCalled();
  expect(requests.length).toBeGreaterThan(0);expect(requests.every(r=>r.destroyed)).toBe(true);
  await expect.poll(()=>sockets.size).toBe(0);db.mockRestore();spy.mockRestore();
  await expect(config.holder.hasReceipt({member:'jonathan',writeId:randomUUID()})).rejects.toThrow();
});

it('rejects a FIFO descriptor nonblocking before reading private mutation configuration',async()=>{
  const s=await setup();let flags=0;
  vi.mocked(openSync).mockImplementationOnce((path,mode,permissions)=>{flags=mode as number;return realFs.openSync(path,mode,permissions);});
  vi.mocked(fstatSync).mockImplementationOnce(fd=>Object.assign(realFs.fstatSync(fd),{isFile:()=>false,isFIFO:()=>true}));
  vi.mocked(readFileSync).mockClear();
  expect(()=>configuredSecretWrites(s.writes)).toThrow(/^Invalid secret mutation configuration$/);
  expect(readFileSync).not.toHaveBeenCalled();
  // Assert outside the production catch: dropping NONBLOCK must fail the test.
  expect(flags&constants.O_NONBLOCK).not.toBe(0);
});
