import {afterEach,expect,it,vi} from 'vitest';
import {mkdtempSync,mkdirSync,readFileSync,writeFileSync,rmSync,existsSync,chmodSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {X509Certificate,randomBytes,randomUUID} from 'node:crypto';
import {generateIdentity} from 'age-encryption';
import {startPersistentHolder} from './holder-lifecycle.js';
import {localHolderMutations} from './holder-mutations.js';
import {localSecretSource} from './local-holder.js';
import https from 'node:https';
import {connect as tlsConnect} from 'node:tls';
import {connect as netConnect,createServer} from 'node:net';
import * as storage from './holder-store.js';
import {privateBytes} from './local-holder.js';
import {listenHolderAuthority,remoteHolderAuthority} from './holder-authority.js';
import * as foundation from '../../foundation.js';
import {Readable} from 'node:stream';
import {run as serve} from '../../cli/serve.js';
import {startLoom} from '../../foundation.js';
import {fixture} from '../../fixture.js';
import {HouseholdDatabase} from '../../core/household/document.js';
import {FakeClock} from '../../core/clock.js';
import {run} from '../../secret-holder.js';
const homes:string[]=[],closes:(()=>Promise<void>)[]=[];
afterEach(async()=>{vi.useRealTimers();for(const close of closes.splice(0).reverse())await close();for(const home of homes.splice(0))rmSync(home,{recursive:true,force:true});vi.restoreAllMocks();});
async function setup(){
  const home=mkdtempSync(join(tmpdir(),'holder-lifecycle-'));homes.push(home);
  const fixtures=fileURLToPath(new URL('./fixtures/lifecycle-tls/',import.meta.url));
  for(const name of ['ca.pem','holder.pem','holder.key','daemon.pem','daemon.key','stranger.pem','stranger.key'])writeFileSync(join(home,name),readFileSync(join(fixtures,name)),{mode:0o600});
  const ca=join(home,'ca.pem');
  const holder={ca,cert:join(home,'holder.pem'),key:join(home,'holder.key')};
  const daemon={ca,cert:join(home,'daemon.pem'),key:join(home,'daemon.key')};
  const daemonFingerprint=new X509Certificate(readFileSync(daemon.cert)).fingerprint256;
  const holderFingerprint=new X509Certificate(readFileSync(holder.cert)).fingerprint256;
  const authority={...daemon,socket:join(home,'authority.sock'),holderFingerprint};
  const directory=join(home,'store');mkdirSync(directory,{mode:0o700});
  const identity=join(home,'identity'),fingerprintKey=join(home,'receipt-key');
  writeFileSync(identity,await generateIdentity(),{mode:0o600});writeFileSync(fingerprintKey,randomBytes(32),{mode:0o600});
  const config={read:{...holder,socket:join(home,'read.sock')},mutation:{...holder,socket:join(home,'mutation.sock')},
    authority:{...holder,socket:authority.socket,servername:'daemon.test'},directory,identity,fingerprintKey,daemonFingerprint};
  const file=join(home,'holder.json');writeFileSync(file,JSON.stringify(config),{mode:0o600});
  const client={...daemon,socket:config.mutation.socket,servername:'holder.test'};
  const appHome=join(home,'app');mkdirSync(appHome,{mode:0o700});fixture(appHome);
  return {home,authority,config,file,client,appHome,daemonFingerprint};
}
it('composes persistent holder and actual current database authority across restart, revocation, and exact replay',async()=>{
  const s=await setup(),clock=new FakeClock();
  let app=await startLoom({home:s.appHome,next:true,staging:true,clock,secretAuthority:s.authority,stdout:()=>{}});
  let holder=await startPersistentHolder(s.file);
  closes.push(async()=>{await holder.close();await app.close();});
  const api=localHolderMutations(s.client),source=localSecretSource({...s.client,socket:s.config.read.socket});
  const who={member:'jonathan',writeId:randomUUID()},value='PERSISTENT-LIFECYCLE-SENTINEL';
  await expect(api.set({member:'pollock',writeId:randomUUID()},'API',Buffer.from(value),'add')).rejects.toThrow();
  await expect(api.set({member:'art',writeId:randomUUID()},'API',Buffer.from(value),'add')).rejects.toThrow();
  await expect(api.set({member:'missing',writeId:randomUUID()},'API',Buffer.from(value),'add')).rejects.toThrow();
  await expect(api.hasReceipt(who)).resolves.toBe(false);
  await api.set(who,'API',Buffer.from(value),'add');
  await expect(api.hasReceipt(who)).resolves.toBe(true);
  const first=await source.read('API');expect(Buffer.from(first).toString()).toBe(value);first.fill(0);
  await api.set({...who,writeId:randomUUID()},'API',Buffer.from('NEW'),'replace');
  await holder.close();await app.close();
  app=await startLoom({home:s.appHome,next:true,staging:true,clock,secretAuthority:s.authority,stdout:()=>{}});holder=await startPersistentHolder(s.file);
  await expect(api.hasReceipt(who)).resolves.toBe(true);
  await api.set(who,'API',Buffer.from(value),'add');
  const newer=await source.read('API');expect(Buffer.from(newer).toString()).toBe('NEW');newer.fill(0);
  await expect(api.set(who,'API',Buffer.from('CHANGED'),'add')).rejects.toThrow();
  const household=new HouseholdDatabase(app.db);
  app.db.transaction(()=>household.change(s.appHome,raw=>{raw.members=[...(raw.members as Array<{person:string}>).filter(m=>m.person!=='jonathan'),{person:'dana',role:'owner',agents:'*'}];}))();
  await expect(api.hasReceipt(who)).rejects.toThrow();
  // Exact durable receipt replay is still forbidden after current member removal.
  await expect(api.set(who,'API',Buffer.from(value),'add')).rejects.toThrow();
  await expect(api.remove({...who,writeId:randomUUID()},'API')).rejects.toThrow();
  // Reinstalling the daemon with an injected permissive policy cannot override the database authority.
  await app.close();app=await startLoom({home:s.appHome,next:true,staging:true,clock,secretAuthority:s.authority,
    sharing:()=>({members:{jonathan:{owner:true,agents:['art']}},projects:{},services:{}}),stdout:()=>{}});
  await expect(api.remove({...who,writeId:randomUUID()},'API')).rejects.toThrow();
  await expect(api.hasReceipt(who)).rejects.toThrow();
  for(const row of app.db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as {name:string}[])
    expect(JSON.stringify(app.db.prepare(`SELECT * FROM "${row.name.replaceAll('"','""')}"`).all())).not.toContain(value);
  expect(readFileSync(join(s.config.directory,'holder.db')).includes(value)).toBe(false);
  expect(readFileSync(join(s.config.directory,'holder.db-wal')).includes(value)).toBe(false);
});
it('pins both peers beyond the CA and fails closed when authority is absent',async()=>{
  const s=await setup();const app=await startLoom({home:s.appHome,next:true,staging:true,secretAuthority:s.authority,stdout:()=>{}});closes.push(app.close);
  const holder=await startPersistentHolder(s.file);closes.push(holder.close);
  const who={member:'jonathan',writeId:randomUUID()};
  await localHolderMutations(s.client).set(who,'API',Buffer.from('PINNED-READ'),'add');
  const stranger={...s.client,cert:join(s.home,'stranger.pem'),key:join(s.home,'stranger.key')};
  await expect(localHolderMutations(stranger).set(who,'API',Buffer.from('X'),'add')).rejects.toThrow();
  await expect(localSecretSource({...stranger,socket:s.config.read.socket}).read('API')).rejects.toThrow();
  await expect(remoteHolderAuthority({...s.config.authority,servername:'wrong.test'},s.daemonFingerprint)(s.daemonFingerprint,'jonathan')).resolves.toBeNull();
  const wrongHolder=remoteHolderAuthority({...s.config.authority,cert:stranger.cert,key:stranger.key},s.daemonFingerprint);
  await expect(wrongHolder(s.daemonFingerprint,'jonathan')).resolves.toBeNull();
  const badDaemon=remoteHolderAuthority(s.config.authority,new X509Certificate(readFileSync(stranger.cert)).fingerprint256);
  await expect(badDaemon(s.daemonFingerprint,'jonathan')).resolves.toBeNull();
  const wrongFingerprint=new X509Certificate(readFileSync(stranger.cert)).fingerprint256;
  await expect(badDaemon(wrongFingerprint,'jonathan')).resolves.toBeNull();
  await app.close();await expect(localHolderMutations(s.client).set(who,'API',Buffer.from('X'),'add')).rejects.toThrow();
});
it('cleans partially started sockets/store and refuses changed key, occupied sockets and mixed executable modes',async()=>{
  const s=await setup();writeFileSync(s.config.mutation.socket,'occupied',{mode:0o600});
  await expect(startPersistentHolder(s.file)).rejects.toThrow(/^Persistent secret holder could not start$/);
  expect(existsSync(s.config.read.socket)).toBe(false);expect(readFileSync(s.config.mutation.socket,'utf8')).toBe('occupied');
  rmSync(s.config.mutation.socket);
  const holder=await startPersistentHolder(s.file);await holder.close();
  writeFileSync(s.config.fingerprintKey,randomBytes(32),{mode:0o600});
  await expect(startPersistentHolder(s.file)).rejects.toThrow(/^Persistent secret holder could not start$/);
  expect(existsSync(s.config.read.socket)).toBe(false);expect(existsSync(s.config.mutation.socket)).toBe(false);
  const stderr=vi.fn();expect(await run(['--config',s.file,'--socket',s.config.read.socket],stderr)).toBe(2);
  expect(stderr).toHaveBeenCalledWith('Local secret holder could not start\n');
});
it('runs the packaged persistent entrypoint until signal and closes both sockets',async()=>{
  const s=await setup();const stderr=vi.fn();const pending=run(['--config',s.file],stderr);
  await vi.waitFor(()=>expect(existsSync(s.config.mutation.socket)).toBe(true));
  process.emit('SIGTERM');expect(await pending).toBe(0);expect(stderr).not.toHaveBeenCalled();
  expect(existsSync(s.config.read.socket)).toBe(false);expect(existsSync(s.config.mutation.socket)).toBe(false);
});

it('loads authority configuration through serve next and closes it with the real daemon',async()=>{
  const s=await setup();const file=join(s.home,'authority.json');writeFileSync(file,JSON.stringify(s.authority),{mode:0o600});
  const actual=foundation.startLoom;
  const start=vi.spyOn(foundation,'startLoom').mockImplementation(options=>actual({...options,port:0,clock:new FakeClock()}));
  let ready!:()=>void;const listening=new Promise<void>(resolve=>{ready=resolve;});
  const running=serve(['--next','--staging','--home',s.appHome,'--secret-authority',file],
    {stdin:Readable.from([]),stdinIsTTY:false,env:{},stdout:()=>{},stderr:text=>{if(text.includes('next app on'))ready();}});
  let holder:Awaited<ReturnType<typeof startPersistentHolder>>|undefined;
  try {
    await listening;expect(start.mock.calls[0][0].secretAuthority).toEqual(s.authority);
    holder=await startPersistentHolder(s.file);
    await localHolderMutations(s.client).set({member:'jonathan',writeId:randomUUID()},'API',Buffer.from('CLI-INTEGRATION'),'add');
  } finally {await holder?.close();process.emit('SIGTERM');expect(await running).toBe(0);start.mockRestore();}
  expect(existsSync(s.authority.socket)).toBe(false);
});
it('failed daemon authority startup preserves an occupied socket and releases the new home',async()=>{
  const s=await setup();writeFileSync(s.authority.socket,'occupied',{mode:0o600});
  await expect(startLoom({home:s.appHome,next:true,staging:true,secretAuthority:s.authority,stdout:()=>{}})).rejects.toThrow(/^Secret holder authority unavailable$/);
  expect(readFileSync(s.authority.socket,'utf8')).toBe('occupied');rmSync(s.authority.socket);
  const app=await startLoom({home:s.appHome,next:true,staging:true,secretAuthority:s.authority,stdout:()=>{}});closes.push(app.close);
  const authorize=remoteHolderAuthority(s.config.authority,s.daemonFingerprint);
  await expect(authorize(s.daemonFingerprint,'jonathan')).resolves.toBe('jonathan');
});

it('closes its owned store only after both sockets on failed startup and normal shutdown',async()=>{
  const s=await setup(),actual=storage.openHolderStore;const closed=vi.fn();
  vi.spyOn(storage,'openHolderStore').mockImplementation(async(...args)=>{
    const store=await actual(...args);
    return {...store,close(){expect(existsSync(s.config.read.socket)).toBe(false);expect(existsSync(s.config.mutation.socket)).toBe(false);closed();store.close();}};
  });
  // Missing listener parent fails after the reader and store have started.
  const broken={...s.config,mutation:{...s.config.mutation,socket:join(s.home,'missing','mutation.sock')}};
  writeFileSync(s.file,JSON.stringify(broken),{mode:0o600});
  await expect(startPersistentHolder(s.file)).rejects.toThrow();expect(closed).toHaveBeenCalledOnce();
  writeFileSync(s.file,JSON.stringify(s.config),{mode:0o600});
  const holder=await startPersistentHolder(s.file);await holder.close();await holder.close();expect(closed).toHaveBeenCalledTimes(2);
});
it('closes the authority socket when public listener startup fails after its bind',async()=>{
  const s=await setup(),occupied=createServer();await new Promise<void>(resolve=>occupied.listen(0,'127.0.0.1',resolve));
  const address=occupied.address();if(!address||typeof address==='string')throw Error('missing port');
  try {
    await expect(startLoom({home:s.appHome,next:true,staging:true,secretAuthority:s.authority,port:address.port,stdout:()=>{}})).rejects.toThrow();
    expect(existsSync(s.authority.socket)).toBe(false);
  } finally {await new Promise<void>(resolve=>occupied.close(()=>resolve()));}
  const app=await startLoom({home:s.appHome,next:true,staging:true,secretAuthority:s.authority,stdout:()=>{}});closes.push(app.close);
});
it('rejects unknown top-level and nested persistent and authority configuration fields',async()=>{
  const s=await setup();
  for(const bad of [{...s.config,extra:true},{...s.config,read:{...s.config.read,extra:true}},
    {...s.config,mutation:{...s.config.mutation,extra:true}},{...s.config,authority:{...s.config.authority,extra:true}}]) {
    writeFileSync(s.file,JSON.stringify(bad),{mode:0o600});await expect(startPersistentHolder(s.file)).rejects.toThrow();
    expect(existsSync(join(s.config.directory,'holder.db'))).toBe(false);
  }
  const file=join(s.home,'authority.json');writeFileSync(file,JSON.stringify({...s.authority,extra:true}),{mode:0o600});
  const stderr=vi.fn();expect(await serve(['--next','--secret-authority',file],{stdin:Readable.from([]),stdinIsTTY:false,env:{},stdout:()=>{},stderr})).toBe(2);
  expect(stderr).toHaveBeenCalledWith('Invalid secret holder authority configuration\n');expect(existsSync(s.authority.socket)).toBe(false);
});
it('bounds authority connections before TLS and incomplete HTTP headers',async()=>{
  const s=await setup(),current=vi.fn(()=>true);const authority=await listenHolderAuthority(s.authority,current);closes.push(authority.close);
  for(const tls of [false,true]) {
    vi.useFakeTimers();let connected=false,closed=false;
    const peer=tls?tlsConnect({path:s.authority.socket,servername:'daemon.test',ca:privateBytes(s.config.authority.ca),cert:privateBytes(s.config.authority.cert),key:privateBytes(s.config.authority.key),minVersion:'TLSv1.3'},()=>{connected=true;peer.write('POST /v1/authority HTTP/1.1\r\nHost: daemon.test\r\n');})
      :netConnect(s.authority.socket,()=>{connected=true;});
    peer.on('error',()=>{});peer.on('close',()=>{closed=true;});
    try {await vi.waitFor(()=>expect(connected).toBe(true));await vi.advanceTimersByTimeAsync(5000);await vi.waitFor(()=>expect(closed).toBe(true));expect(current).not.toHaveBeenCalled();}
    finally {peer.destroy();vi.useRealTimers();}
  }
});
it('independently bounds authority clients when a valid pinned peer never acknowledges',async()=>{
  const s=await setup();let received=false;
  const server=https.createServer({ca:privateBytes(s.authority.ca),cert:privateBytes(s.authority.cert),key:privateBytes(s.authority.key),requestCert:true,rejectUnauthorized:true,minVersion:'TLSv1.3'},req=>{req.resume();req.on('end',()=>{received=true;});});
  await new Promise<void>(resolve=>server.listen(s.authority.socket,resolve));chmodSync(s.authority.socket,0o600);
  closes.push(async()=>{server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()));});
  const authorize=remoteHolderAuthority(s.config.authority,s.daemonFingerprint);
  vi.useFakeTimers();try {
    let settled=false;const pending=authorize(s.daemonFingerprint,'jonathan').then(result=>{settled=true;return result;});
    await vi.waitFor(()=>expect(received).toBe(true));expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(5000);await expect(pending).resolves.toBeNull();
  }finally{vi.useRealTimers();}
});

it('bounds persistent reader connections before TLS and incomplete HTTP headers',async()=>{
  const s=await setup(),holder=await startPersistentHolder(s.file);closes.push(holder.close);
  for(const tls of [false,true]) {
    vi.useFakeTimers();let connected=false,closed=false;
    const peer=tls?tlsConnect({path:s.config.read.socket,servername:'holder.test',ca:privateBytes(s.client.ca),cert:privateBytes(s.client.cert),key:privateBytes(s.client.key),minVersion:'TLSv1.3'},()=>{connected=true;peer.write('GET /v1/value/API HTTP/1.1\r\nHost: holder.test\r\n');})
      :netConnect(s.config.read.socket,()=>{connected=true;});
    peer.on('error',()=>{});peer.on('close',()=>{closed=true;});
    try {await vi.waitFor(()=>expect(connected).toBe(true));await vi.advanceTimersByTimeAsync(5000);await vi.waitFor(()=>expect(closed).toBe(true));}
    finally {peer.destroy();vi.useRealTimers();}
  }
});

it('denies authority methods, paths and bodies before looking up current membership',async()=>{
  const s=await setup(),current=vi.fn(()=>true);const authority=await listenHolderAuthority(s.authority,current);closes.push(authority.close);
  const request=(method:string,path:string,body:string,framing:Record<string,string>)=>new Promise<number>((resolve,reject)=>{
    const req=https.request({socketPath:s.authority.socket,servername:'daemon.test',ca:privateBytes(s.config.authority.ca),cert:privateBytes(s.config.authority.cert),key:privateBytes(s.config.authority.key),agent:false,method,path,
      headers:{'x-holder-member':Buffer.from('jonathan').toString('base64url'),...framing}},res=>{res.resume();res.on('end',()=>resolve(res.statusCode!));res.on('error',reject);});
    req.on('error',reject);req.end(body);
  });
  expect(await request('GET','/v1/authority','',{'content-length':'0'})).toBe(503);
  expect(await request('POST','/wrong','',{'content-length':'0'})).toBe(503);
  expect(await request('POST','/v1/authority','X',{'content-length':'1'})).toBe(503);
  expect(await request('POST','/v1/authority','X',{'transfer-encoding':'chunked'})).toBe(503);
  expect(current).not.toHaveBeenCalled();
  expect(await request('POST','/v1/authority','',{'content-length':'0'})).toBe(204);expect(current).toHaveBeenCalledExactlyOnceWith('jonathan');
});
