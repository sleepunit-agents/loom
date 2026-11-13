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
  const generation=await source.generation();
  const first=await source.read('API');expect(Buffer.from(first).toString()).toBe(value);first.fill(0);
  await api.set({...who,writeId:randomUUID()},'API',Buffer.from('NEW'),'replace');
  const replacedGeneration=await source.generation();expect(replacedGeneration).not.toBe(generation);
  await holder.close();await app.close();
  app=await startLoom({home:s.appHome,next:true,staging:true,clock,secretAuthority:s.authority,stdout:()=>{}});holder=await startPersistentHolder(s.file);
  expect(await source.generation()).toBe(replacedGeneration);
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
  await expect(localSecretSource({...stranger,socket:s.config.read.socket}).generation()).rejects.toThrow(/^Local secret holder unavailable$/);
  expect(await localSecretSource({...s.client,socket:s.config.read.socket}).generation()).toMatch(/^[0-9a-f-]{36}$/);
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

it('opens storage only after binding sockets and closes it after sockets on shutdown',async()=>{
  const s=await setup(),actual=storage.openHolderStore;const closed=vi.fn();
  vi.spyOn(storage,'openHolderStore').mockImplementation(async(...args)=>{
    const store=await actual(...args);
    return {...store,close(){expect(existsSync(s.config.read.socket)).toBe(false);expect(existsSync(s.config.mutation.socket)).toBe(false);closed();store.close();}};
  });
  // Missing listener parent fails before storage opens or key history commits.
  const broken={...s.config,mutation:{...s.config.mutation,socket:join(s.home,'missing','mutation.sock')}};
  writeFileSync(s.file,JSON.stringify(broken),{mode:0o600});
  await expect(startPersistentHolder(s.file)).rejects.toThrow();expect(closed).not.toHaveBeenCalled();expect(storage.openHolderStore).not.toHaveBeenCalled();
  writeFileSync(s.file,JSON.stringify(s.config),{mode:0o600});
  const holder=await startPersistentHolder(s.file);await holder.close();await holder.close();expect(closed).toHaveBeenCalledOnce();
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
it('binds a next bridge lifetime to actual persistent holder generation and household-authorized identical replacement',async()=>{
  const s=await setup(),clock=new FakeClock();
  let app=await startLoom({home:s.appHome,next:true,clock,secretAuthority:s.authority,stdout:()=>{}});
  const holder=await startPersistentHolder(s.file);
  closes.push(async()=>{await holder.close();await app.close();});
  const api=localHolderMutations(s.client),source=localSecretSource({...s.client,socket:s.config.read.socket});
  const generation=vi.fn(()=>source.generation()),bridgeSource={...source,generation};
  await api.set({member:'jonathan',writeId:randomUUID()},'BRIDGE',Buffer.from('BRIDGE-PRIVATE'),'add');
  await app.close();
  const {EventEmitter}=await import('node:events');
  const {installSecrets}=await import('./index.js');
  const {installSecretServices}=await import('./service.js');
  const {installBridges}=await import('../bridges/index.js');
  const {put}=await import('../bridges/store.js');
  const {venueSchema}=await import('../bridges/model.js');
  const {fixtureSharing}=await import('../../fixture.js');
  const sockets:Array<EventEmitter & {readyState:number;terminate:ReturnType<typeof vi.fn>}>=[];
  const request=vi.fn<typeof fetch>(async url=>Response.json(String(url).endsWith('users/@me') ? {id:'200',bot:true}:{id:'100'}));
  const sharing=()=>({...fixtureSharing(),services:{bridges:{types:['bridges.venue','bridges.route','bridges.link','bridges.send'],operations:[]}}});
  app=await startLoom({home:s.appHome,next:true,clock,secretAuthority:s.authority,sharing,stdout:()=>{},
    bridges:{source:bridgeSource,name:()=>undefined,receive:async()=>{},request,discordSocket:()=>{
      const socket=Object.assign(new EventEmitter(),{readyState:1,terminate:vi.fn(()=>{socket.readyState=3;}),send:vi.fn(),ping:vi.fn()});sockets.push(socket);return socket as unknown as import('ws').WebSocket;
    }},
    install(a){
      installSecrets(a.db,a.operations,a.live,sharing);installSecretServices(a.db,a.operations,sharing);installBridges(a,sharing);
      expect(a.operations.call('direct',{kind:'member',id:'jonathan'},'secrets.describe',{name:'BRIDGE',description:'Bridge'},'bridge-name').ok).toBe(true);
      expect(a.operations.call('direct',{kind:'member',id:'jonathan'},'secrets.grantService',{service:'bridges',name:'BRIDGE'},'bridge-grant').ok).toBe(true);
      put(a.db,'venues',venueSchema.parse({id:'discord',platform:'discord',agent:'art',workspace:'100',bot:'200',tokenSecret:'BRIDGE'}));
    }});
  await vi.waitFor(()=>expect(sockets).toHaveLength(1));
  const before=await source.generation();
  await expect(api.set({member:'pollock',writeId:randomUUID()},'BRIDGE',Buffer.from('OTHER'),'replace')).rejects.toThrow();
  expect(await source.generation()).toBe(before);
  clock.advance(5000);await vi.waitFor(()=>expect(generation).toHaveBeenCalledTimes(2));
  await generation.mock.results[1].value;for(let i=0;i<30;i++)await Promise.resolve();
  expect(request).toHaveBeenCalledTimes(2);expect(sockets[0].terminate).not.toHaveBeenCalled();
  // Same bytes still create a new public lifetime, without hashing the value.
  await api.set({member:'jonathan',writeId:randomUUID()},'BRIDGE',Buffer.from('BRIDGE-PRIVATE'),'replace');
  expect(await source.generation()).not.toBe(before);
  clock.advance(5000);await vi.waitFor(()=>expect(sockets).toHaveLength(2));expect(sockets[0].terminate).toHaveBeenCalledOnce();
  await holder.close();clock.advance(5000);await vi.waitFor(()=>expect(sockets[1].terminate).toHaveBeenCalledOnce());
  for(const row of app.db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as {name:string}[])
    expect(JSON.stringify(app.db.prepare(`SELECT * FROM "${row.name.replaceAll('"','""')}"`).all())).not.toContain('BRIDGE-PRIVATE');
});
it('runs durable bridge inspection and split sends on the persistent holder, household authority and current service grants',async()=>{
  const s=await setup(),clock=new FakeClock(),app=await startLoom({home:s.appHome,next:true,clock,secretAuthority:s.authority,stdout:()=>{}});
  const holder=await startPersistentHolder(s.file);closes.push(async()=>{await holder.close();await app.close();});
  const mutation=localHolderMutations(s.client),source=localSecretSource({...s.client,socket:s.config.read.socket});
  const sentinel='ACTUAL-BRIDGE-ADAPTER-VALUE';
  await expect(mutation.set({member:'pollock',writeId:randomUUID()},'BRIDGE',Buffer.from(sentinel),'add')).rejects.toThrow();
  await mutation.set({member:'jonathan',writeId:randomUUID()},'BRIDGE',Buffer.from(sentinel),'add');
  const {SharingDatabase}=await import('../../core/household/sharing.js');
  const {installSecretServices,secretUseRole}=await import('./service.js');
  const {venueAdapters}=await import('../bridges/adapters.js');
  const {Bridges}=await import('../bridges/engine.js');
  const {venueSchema}=await import('../bridges/model.js');
  const {installEffects}=await import('../../core/effects.js');
  const sharing=()=>new SharingDatabase(app.db,s.appHome).sharing();
  installSecretServices(app.db,app.operations,sharing);
  const op=(name:string,input:unknown)=>app.operations.call('direct',{kind:'member',id:'jonathan'},name,input,randomUUID());
  const venue=venueSchema.parse({id:'adapter',platform:'discord',workspace:'100',bot:'200',agent:'art',tokenSecret:'BRIDGE'});
  expect(op('secrets.describe',{name:'BRIDGE',description:'Bridge'}).ok).toBe(true);
  expect(op('bridges.putVenues',venue).ok).toBe(true);
  expect(op('bridges.putLinks',{id:'owner',platform:'discord',workspace:'100',user:'300',person:'jonathan'}).ok).toBe(true);
  expect(op('bridges.putRoutes',{id:'route',platform:'discord',workspace:'100',channel:'400',primary:'art'}).ok).toBe(true);
  const requests:string[]=[],posts:string[]=[];
  let revoke=false;
  const request:typeof fetch=async(url,init)=>{
    expect(init?.headers).toMatchObject({Authorization:`Bot ${sentinel}`});requests.push(String(url));
    if(String(url).endsWith('/messages')) {posts.push(JSON.parse(String(init?.body)).content);if(revoke)expect(op('secrets.revokeService',{service:'bridges',name:'BRIDGE'}).ok).toBe(true);return Response.json({id:'500',channel_id:'400'});}
    return Response.json(String(url).endsWith('@me')?{id:'200',bot:true}:String(url).endsWith('guilds/100')?{id:'100'}:{id:'400',type:0,guild_id:'100'});
  };
  const marker=await source.generation();
  const adapters=venueAdapters(secretUseRole(app.db,source,sharing,{kind:'service',id:'bridges'},()=>clock.now(),app.live),{request,lifetime:()=>marker,beforeRead:()=>true});
  // Explicit fake only for the bridge runtime and its effect gate; platform IO is fake HTTP.
  const deliveries:string[]=[];let admission=0,expireAt:number|undefined;
  const effects:ReturnType<typeof installEffects>={status:()=>undefined,onReleased:()=>()=>{},beforeOutside:()=>true,finish:()=>{}};
  const engine=new Bridges(app,clock,{admit:async()=>{if(++admission===3 && expireAt!==undefined)clock.advance(expireAt-clock.now());return 'allow';},deliver:async i=>{deliveries.push(i.id);return 'delivered';},stop:async()=>{}},adapters,effects);
  try {
    await engine.receive(venue.id,{id:'600',channel:'400',user:'300',dm:false,at:'2026-11-13T18:00:00Z',text:'hello',mentions:[]});await engine.flush();expect(requests).toEqual([]);expect(deliveries).toEqual([]);
    expect(op('secrets.grantService',{service:'bridges',name:'BRIDGE'}).ok).toBe(true);
    await engine.flush();expect(deliveries).toHaveLength(1);
    engine.reply({id:'whole',incomingId:deliveries[0],text:'x'.repeat(2100)});await engine.flush();expect(posts.map(p=>p.length)).toEqual([2000,100]);
    expect(app.db.prepare('SELECT state,remote_id FROM bridges_outbox WHERE id=?').get('whole')).toEqual({state:'sent',remote_id:'500'});
    revoke=true;engine.reply({id:'partial',incomingId:deliveries[0],text:'y'.repeat(2100)});await engine.flush();expect(posts.map(p=>p.length)).toEqual([2000,100,2000]);
    expect(app.db.prepare('SELECT state FROM bridges_outbox WHERE id=?').get('partial')).toEqual({state:'uncertain'});await engine.flush();expect(posts).toHaveLength(3);
    revoke=false;expireAt=clock.now()+1000;admission=0;expect(op('secrets.grantService',{service:'bridges',name:'BRIDGE',expiresAt:expireAt}).ok).toBe(true);
    engine.reply({id:'expiry',incomingId:deliveries[0],text:'must not post after final admission expiry'});await engine.flush();expect(admission).toBe(3);expect(posts).toHaveLength(3);expect(app.db.prepare('SELECT state FROM bridges_outbox WHERE id=?').get('expiry')).toEqual({state:'uncertain'});
    // Expiry also ends inspected intake while runtime admission is pending.
    expireAt=clock.now()+1000;admission=2;expect(op('secrets.grantService',{service:'bridges',name:'BRIDGE',expiresAt:expireAt}).ok).toBe(true);
    await engine.receive(venue.id,{id:'601',channel:'400',user:'300',dm:false,at:'2026-11-13T18:01:00Z',text:'do not deliver after expiry',mentions:[]});await engine.flush();expect(deliveries).toHaveLength(1);expect(app.db.prepare("SELECT count(*) AS n FROM bridges_inbox WHERE state='pending'").get()).toEqual({n:1});
    for(const row of app.db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as {name:string}[])expect(JSON.stringify(app.db.prepare(`SELECT * FROM "${row.name.replaceAll('"','""')}"`).all())).not.toContain(sentinel);
  } finally {await engine.close();}
});

it('loads explicit retained holder identities and receipt keys through the persistent executable config',async()=>{
 const f=await setup();const app=await startLoom({home:f.appHome,next:true,staging:true,clock:new FakeClock(),secretAuthority:f.authority,stdout:()=>{}});closes.push(app.close);
 let holder=await startPersistentHolder(f.file);closes.push(async()=>holder.close());
 const client=localHolderMutations(f.client),source=localSecretSource({...f.client,socket:f.config.read.socket});
 const add={member:'jonathan',writeId:randomUUID()},remove={member:'jonathan',writeId:randomUUID()};
 await client.set(add,'API',Buffer.from('CONFIG-ROTATION-SYNTHETIC'),'add');const generation=await source.generation();await holder.close();
 const identity=join(f.home,'rotated-identity'),fingerprintKey=join(f.home,'rotated-receipt-key');
 writeFileSync(identity,await generateIdentity(),{mode:0o600});writeFileSync(fingerprintKey,randomBytes(32),{mode:0o600});
 writeFileSync(f.file,JSON.stringify({...f.config,identity,fingerprintKey}),{mode:0o600});
 await expect(startPersistentHolder(f.file)).rejects.toThrow(/^Persistent secret holder could not start$/);
 writeFileSync(f.file,JSON.stringify({...f.config,identity,fingerprintKey,previousIdentities:[f.config.identity],previousFingerprintKeys:[f.config.fingerprintKey]}),{mode:0o600});
 holder=await startPersistentHolder(f.file);expect(await source.generation()).toBe(generation);
 const old=await source.read('API');expect(Buffer.from(old).toString()).toBe('CONFIG-ROTATION-SYNTHETIC');old.fill(0);
 await client.set({...add,writeId:randomUUID()},'API',Buffer.from('REPLACED'),'replace');
 await client.set(add,'API',Buffer.from('CONFIG-ROTATION-SYNTHETIC'),'add');
 const newer=await source.read('API');expect(Buffer.from(newer).toString()).toBe('REPLACED');newer.fill(0);
 await client.remove(remove,'API');await client.set({...add,writeId:randomUUID()},'API',Buffer.from('RE-ADDED'),'add');
 await holder.close();holder=await startPersistentHolder(f.file);await client.remove(remove,'API');
 expect(await client.hasReceipt(add)).toBe(true);expect(await client.hasReceipt(remove)).toBe(true);
 const latest=await source.read('API');expect(Buffer.from(latest).toString()).toBe('RE-ADDED');latest.fill(0);
});
it('keeps rotation history unchanged on listener failure and refuses real requests before storage is ready',async()=>{
 const f=await setup(),app=await startLoom({home:f.appHome,next:true,staging:true,clock:new FakeClock(),secretAuthority:f.authority,stdout:()=>{}});closes.push(app.close);
 let holder=await startPersistentHolder(f.file);const client=localHolderMutations(f.client),source=localSecretSource({...f.client,socket:f.config.read.socket});
 const id={member:'jonathan',writeId:randomUUID()};await client.set(id,'API',Buffer.from('STARTUP-ROTATION-SYNTHETIC'),'add');await holder.close();
 const oldDatabase=readFileSync(join(f.config.directory,'holder.db'));
 const identity=join(f.home,'next-identity'),fingerprintKey=join(f.home,'next-receipt');writeFileSync(identity,await generateIdentity(),{mode:0o600});writeFileSync(fingerprintKey,randomBytes(32),{mode:0o600});
 writeFileSync(f.file,JSON.stringify({...f.config,identity,fingerprintKey,previousIdentities:[f.config.identity],previousFingerprintKeys:[f.config.fingerprintKey]}),{mode:0o600});
 for(const socket of [f.config.read.socket,f.config.mutation.socket]){
  writeFileSync(socket,'occupied',{mode:0o600});await expect(startPersistentHolder(f.file)).rejects.toThrow(/^Persistent secret holder could not start$/);rmSync(socket);
  expect(readFileSync(join(f.config.directory,'holder.db'))).toEqual(oldDatabase);
 }
 // A refused rotation never requires the replacement material on old-config restart.
 writeFileSync(f.file,JSON.stringify(f.config),{mode:0o600});holder=await startPersistentHolder(f.file);await holder.close();
 let release!:()=>void;const gate=new Promise<void>(resolve=>{release=resolve;});
 const actual=storage.openHolderStore,open=vi.spyOn(storage,'openHolderStore').mockImplementationOnce(async(...args)=>{await gate;return actual(...args);});
 const starting=startPersistentHolder(f.file);
 try{
  await vi.waitFor(()=>expect(open).toHaveBeenCalledOnce());
  await expect(source.read('API')).rejects.toThrow(/^Local secret holder unavailable$/);
  await expect(source.generation()).rejects.toThrow(/^Local secret holder unavailable$/);
  await expect(client.hasReceipt(id)).rejects.toThrow();
  await expect(client.set({...id,writeId:randomUUID()},'OTHER',Buffer.from('NOT-ADMITTED'),'add')).rejects.toThrow();
  await expect(client.remove({...id,writeId:randomUUID()},'API')).rejects.toThrow();
  expect(readFileSync(join(f.config.directory,'holder.db'))).toEqual(oldDatabase);
 }finally{release();holder=await starting;closes.push(holder.close);}
 const bytes=await source.read('API');expect(Buffer.from(bytes).toString()).toBe('STARTUP-ROTATION-SYNTHETIC');bytes.fill(0);expect(await client.hasReceipt(id)).toBe(true);
});
