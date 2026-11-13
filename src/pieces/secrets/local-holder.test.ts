import { afterEach, expect, it, vi } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, chmodSync, symlinkSync, linkSync, unlinkSync, existsSync } from 'node:fs';
import https from 'node:https';
import fs from 'node:fs';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Decrypter, Encrypter, generateIdentity, identityToRecipient } from 'age-encryption';
import { localSecretSource, listenLocalHolder, privateBytes } from './local-holder.js';
import { ageSecretSource } from './age-source.js';
import { configuredSecretHolder } from './holder-config.js';
import { startLoom } from '../../foundation.js';
import { fixture } from '../../fixture.js';
import { SharingDatabase } from '../../core/household/sharing.js';
import { secretUseRole } from './service.js';
import { FakeClock } from '../../core/clock.js';
import { githubSecrets } from '../changes/secrets.js';
const homes: string[] = [], closes: (() => Promise<void>)[] = [];
afterEach(async () => { for (const close of closes.splice(0).reverse()) await close(); for (const home of homes.splice(0)) rmSync(home,{recursive:true,force:true}); vi.restoreAllMocks(); });
function setup() {
  const home=mkdtempSync(join(tmpdir(),'loom-holder-')); homes.push(home);
  const fixtures=fileURLToPath(new URL('./fixtures/holder-tls/',import.meta.url));
  for (const name of ['ca.pem','holder.pem','holder.key','daemon.pem','daemon.key','stranger.pem','stranger.key']) writeFileSync(join(home,name),readFileSync(join(fixtures,name)),{mode:0o600});
  const common={socket:join(home,'holder.sock'),ca:join(home,'ca.pem')};
  const client={...common,cert:join(home,'daemon.pem'),key:join(home,'daemon.key'),servername:'holder.test'};
  const server={...common,cert:join(home,'holder.pem'),key:join(home,'holder.key')};
  return {home,client,server};
}
it('decrypts persistent age ciphertext through real mutual TLS and current service grants in next/staging without leaks',async()=>{
  const {home,client,server}=setup(), directory=join(home,'values');mkdirSync(directory,{mode:0o700});
  const identity=await generateIdentity();writeFileSync(join(home,'identity'),identity,{mode:0o600});
  const encrypt=new Encrypter();encrypt.addRecipient(await identityToRecipient(identity));
  const sentinel='LOCAL-HOLDER-CREDENTIAL-SENTINEL';
  writeFileSync(join(directory,'github.age'),await encrypt.encrypt(sentinel),{mode:0o600});
  const source=ageSecretSource(directory,join(home,'identity'));
  const read=vi.spyOn(source,'read');
  let holder=await listenLocalHolder(server,source);
  closes.push(()=>holder.close());
  const configFile=join(home,'config.json');writeFileSync(configFile,JSON.stringify({...client,github:{acme:'github'}}),{mode:0o600});
  const changes=configuredSecretHolder(configFile);
  const appHome=join(home,'next');mkdirSync(appHome,{mode:0o700});fixture(appHome);
  const clock=new FakeClock();
  const app=await startLoom({home:appHome,next:true,staging:true,clock,changes,stdout:()=>{}});closes.push(app.close);
  const sharing=()=>new SharingDatabase(app.db,appHome).sharing();
  const role=githubSecrets(secretUseRole(app.db,changes.source,sharing,{kind:'service',id:'changes'},()=>clock.now(),app.live),changes.github);
  let seq=0;
  const call=(name:string,input:unknown)=>app.operations.call('direct',{kind:'member',id:'jonathan'},`secrets.${name}`,input,`local-${++seq}`);
  expect(call('describe',{name:'github',description:'GitHub'}).ok).toBe(true);
  const changed=vi.spyOn(app.live,'changed');
  const logs=[vi.spyOn(console,'log'),vi.spyOn(console,'warn'),vi.spyOn(console,'error')];
  const use=vi.fn(async(token:string)=>{expect(token).toBe(sentinel);return {ok:true};});
  await expect(role.withValue('github',use)).rejects.toMatchObject({code:'denied'});expect(read).not.toHaveBeenCalled();
  expect(call('grantService',{service:'changes',name:'github',expiresAt:clock.now()+1000}).ok).toBe(true);
  expect(await role.resolveGitHub('Acme')).toBe('github');
  await expect(role.withValue('github',use)).resolves.toEqual({ok:true});
  // Restart only the holder: ciphertext and the separate identity survive.
  await holder.close();holder=await listenLocalHolder(server,ageSecretSource(directory,join(home,'identity')));
  await expect(role.withValue('github',use)).resolves.toEqual({ok:true});
  await expect(role.withValue('github',async token=>{throw Error(token);})).rejects.toMatchObject({message:'Secret use failed'});
  expect(call('revokeService',{service:'changes',name:'github'}).ok).toBe(true);
  await expect(role.withValue('github',use)).rejects.toMatchObject({code:'denied'});
  call('grantService',{service:'changes',name:'github',expiresAt:clock.now()+1000});clock.advance(1000);
  await expect(role.withValue('github',use)).rejects.toMatchObject({code:'denied'});
  const tables=app.db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as {name:string}[];
  const dump=tables.map(t=>app.db.prepare(`SELECT * FROM "${t.name.replaceAll('"','""')}"`).all());
  expect(JSON.stringify([dump,changed.mock.calls,...logs.map(s=>s.mock.calls)])).not.toContain(sentinel);
  expect(logs.every(s=>!s.mock.calls.length)).toBe(true);
  expect(read.mock.results.filter(r=>r.type==='return').length).toBe(1);
});
it('authenticates both peers, rejects unsafe paths and returns only fixed errors',async()=>{
  const {home,client,server}=setup();const buffers:Uint8Array[]=[];
  const read=vi.fn(async()=>{const b=Buffer.from('TEST-VALUE');buffers.push(b);return b;});
  const holder=await listenLocalHolder(server,{read});closes.push(holder.close);
  await expect(localSecretSource({...client,cert:join(home,'stranger.pem'),key:join(home,'stranger.key')}).read('github')).rejects.toThrow('Local secret holder unavailable');
  await expect(localSecretSource({...client,servername:'wrong.test'}).read('github')).rejects.toThrow('Local secret holder unavailable');
  expect(read).not.toHaveBeenCalled();
  await expect(localSecretSource(client).read('../escape')).rejects.toThrow('Local secret holder unavailable');
  const bytes=await localSecretSource(client).read('github');expect(Buffer.from(bytes).toString()).toBe('TEST-VALUE');bytes.fill(0);
  expect(buffers[0].every(v=>v===0)).toBe(true);
  chmodSync(client.socket,0o666);await expect(localSecretSource(client).read('github')).rejects.toThrow('Local secret holder unavailable');chmodSync(client.socket,0o600);
  read.mockRejectedValueOnce(Error('SECRET-IN-ERROR'));
  await expect(localSecretSource(client).read('github')).rejects.toThrow(/^Local secret holder unavailable$/);
  for(const value of [Buffer.alloc(0),Buffer.alloc(65537,1)]) {read.mockResolvedValueOnce(value);await expect(localSecretSource(client).read('github')).rejects.toThrow();expect(value.every(v=>v===0)).toBe(true);}
  chmodSync(client.key,0o644);expect(()=>localSecretSource(client)).toThrow('Local secret holder unavailable');chmodSync(client.key,0o600);
  const link=join(home,'link');symlinkSync(client.key,link);expect(()=>privateBytes(link)).toThrow();
  expect(()=>configuredSecretHolder(join(home,'missing'))).toThrow(/^Invalid local secret holder configuration$/);
});
it('next-root Changes job acquires through the local holder; staging holds acquisition and forge',async()=>{
  const {home,client,server}=setup();const sentinel='JOB-HOLDER-SENTINEL';
  const read=vi.fn(async()=>Buffer.from(sentinel));const holder=await listenLocalHolder(server,{read});closes.push(holder.close);
  for(const staging of [true,false]) {
    const appHome=join(home,staging?'staging':'running');mkdirSync(appHome,{mode:0o700});fixture(appHome);
    const clock=new FakeClock();
    const request=vi.fn(async(_url:unknown,init?:RequestInit)=>{
      expect(new Headers(init?.headers).get('authorization')).toBe(`Bearer ${sentinel}`);
      return Response.json({data:{repository:{pullRequests:{nodes:[],pageInfo:{hasNextPage:false,endCursor:null}}}}});
    });
    const app=await startLoom({home:appHome,next:true,staging,clock,stdout:()=>{},changes:{source:localSecretSource(client),github:{acme:'github'},request:request as typeof fetch}});closes.push(app.close);
    app.db.transaction(()=>new SharingDatabase(app.db,appHome).create({slug:'holder-test',name:'Holder test',repositories:['acme/app'],members:[],agents:['art']}))();
    expect(app.operations.call('direct',{kind:'member',id:'jonathan'},'secrets.describe',{name:'github',description:''},'name').ok).toBe(true);
    expect(app.operations.call('direct',{kind:'member',id:'jonathan'},'secrets.grantService',{service:'changes',name:'github'},'grant').ok).toBe(true);
    clock.advance(1);
    await vi.waitFor(()=>expect(app.db.prepare("SELECT value FROM changes_meta WHERE key='sync-status'").get()).toBeDefined());
    const status=app.db.prepare("SELECT value FROM changes_meta WHERE key='sync-status'").get() as {value:string};
    expect(JSON.parse(status.value)).toMatchObject({error:false,held:staging});
    if(staging) {expect(read).not.toHaveBeenCalled();expect(request).not.toHaveBeenCalled();}
    else {expect(read).toHaveBeenCalled();expect(request).toHaveBeenCalled();}
  }
});
it('bounds an authenticated stalled read and erases a late provider response after disconnect',async()=>{
  const {client,server}=setup();let finish!:(bytes:Uint8Array)=>void;
  const read=vi.fn(()=>new Promise<Uint8Array>(resolve=>{finish=resolve;}));
  const holder=await listenLocalHolder(server,{read});closes.push(holder.close);
  vi.useFakeTimers();
  try {
    const result=localSecretSource(client).read('github');
    const rejected=expect(result).rejects.toThrow(/^Local secret holder unavailable$/);
    await vi.waitFor(()=>expect(read).toHaveBeenCalledOnce());
    await vi.advanceTimersByTimeAsync(5000);await rejected;
    // Allow socket close to propagate before completing the provider.
    vi.useRealTimers();
    const bytes=Buffer.from('LATE-CREDENTIAL');finish(bytes);
    await vi.waitFor(()=>expect(bytes.every(v=>v===0)).toBe(true));
  } finally { vi.useRealTimers(); }
});
it('serve composes an explicit authenticated source and public GitHub bindings',async()=>{
  const {home,client,server}=setup();const holder=await listenLocalHolder(server,{read:async()=>Buffer.from('CLI-FIXTURE-VALUE')});closes.push(holder.close);
  const file=join(home,'config.json');writeFileSync(file,JSON.stringify({...client,github:{acme:'github'}}),{mode:0o600});
  const foundation=await import('../../foundation.js');const {run}=await import('../../cli/serve.js');const {Readable}=await import('node:stream');
  const started=vi.spyOn(foundation,'startLoom').mockResolvedValue({url:'http://127.0.0.1:8788',close:async()=>{}} as never);
  let ready!:()=>void;const listening=new Promise<void>(resolve=>{ready=resolve;});
  const running=run(['--next','--secret-holder',file],{stdin:Readable.from([]),stdinIsTTY:false,env:{},stdout:()=>{},stderr:()=>ready()});
  try {
    await listening;const changes=started.mock.calls[0][0].changes!;
    expect(changes.github).toEqual({acme:'github'});
    const bytes=await changes.source.read('github');expect(Buffer.from(bytes).toString()).toBe('CLI-FIXTURE-VALUE');bytes.fill(0);
  } finally {process.emit('SIGTERM');expect(await running).toBe(0);started.mockRestore();}
});

async function rawPeer(handler:(req:IncomingMessage,res:ServerResponse)=>void, tls: https.ServerOptions = {}) {
  const {home,client,server:config}=setup();
  const peer=https.createServer({key:privateBytes(config.key),cert:privateBytes(config.cert),ca:privateBytes(config.ca),requestCert:true,rejectUnauthorized:true,minVersion:'TLSv1.3',...tls},handler);
  await new Promise<void>((resolve,reject)=>{peer.once('error',reject);peer.listen(config.socket,resolve);});chmodSync(config.socket,0o600);
  closes.push(async()=>{peer.closeAllConnections();await new Promise<void>(resolve=>peer.close(()=>resolve()));});
  const received:Buffer[]=[];const actual=https.request;
  const observed=(options:https.RequestOptions,callback?:(res:IncomingMessage)=>void)=>actual(options,response=>{response.on('data',(chunk:Buffer)=>received.push(chunk));callback?.(response);});
  vi.spyOn(https,'request').mockImplementation(observed as typeof https.request);
  return {home,client,received};
}
it('rejects an authenticated oversized response and erases accumulated client plaintext',async()=>{
  const {client,received}=await rawPeer((_req,res)=>{res.writeHead(200,{'content-type':'application/octet-stream'});res.end(Buffer.alloc(65537,65));});
  await expect(localSecretSource(client).read('github')).rejects.toThrow(/^Local secret holder unavailable$/);
  expect(received.reduce((n,b)=>n+b.length,0)).toBeGreaterThan(65536);
  expect(received.every(b=>b.every(v=>v===0))).toBe(true);
});
it('erases partially received client plaintext when an authenticated peer disconnects',async()=>{
  let disconnect!:()=>void;
  const {client,received}=await rawPeer((_req,res)=>{disconnect=()=>res.destroy();res.writeHead(200,{'content-type':'application/octet-stream','content-length':100});res.write('PARTIAL-PLAINTEXT');});
  const result=expect(localSecretSource(client).read('github')).rejects.toThrow(/^Local secret holder unavailable$/);
  await vi.waitFor(()=>expect(received.length).toBeGreaterThan(0));disconnect();await result;
  expect(received.every(b=>b.every(v=>v===0))).toBe(true);
});
it('refuses an occupied socket without disrupting the original authenticated holder',async()=>{
  const {client,server}=setup();const holder=await listenLocalHolder(server,{read:async()=>Buffer.from('ORIGINAL')});closes.push(holder.close);
  await expect(listenLocalHolder(server,{read:async()=>Buffer.from('IMPOSTOR')})).rejects.toThrow(/^Local secret holder unavailable$/);
  const bytes=await localSecretSource(client).read('github');expect(Buffer.from(bytes).toString()).toBe('ORIGINAL');bytes.fill(0);
});
it('rejects foreign ownership, hardlinks and malformed private TLS configuration',()=>{
  const {home,client}=setup();
  const uid=process.getuid!();const getuid=vi.spyOn(process,'getuid').mockReturnValue(uid+1);
  expect(()=>privateBytes(client.key)).toThrow(/^Local secret holder unavailable$/);getuid.mockRestore();
  const link=join(home,'hardlink');linkSync(client.key,link);
  expect(()=>privateBytes(client.key)).toThrow();expect(()=>privateBytes(link)).toThrow();unlinkSync(link);
  writeFileSync(client.cert,'NOT-A-CERTIFICATE');expect(()=>localSecretSource(client)).toThrow(/^Local secret holder unavailable$/);
});

it('rejects malformed and non-CA trust material during explicit configuration',()=>{
  const {home,client}=setup();const file=join(home,'config.json');
  writeFileSync(file,JSON.stringify({...client,servername:'not a dns name',github:{acme:'github'}}),{mode:0o600});
  expect(()=>configuredSecretHolder(file)).toThrow(/^Invalid local secret holder configuration$/);
  writeFileSync(file,JSON.stringify({...client,github:{acme:'github'}}));
  for(const ca of ['NOT A CA',readFileSync(client.cert,'utf8')]) {
    writeFileSync(client.ca,ca);
    expect(()=>configuredSecretHolder(file)).toThrow(/^Invalid local secret holder configuration$/);
  }
});
it('client refuses an authenticated holder limited to TLS 1.2',async()=>{
  const request=vi.fn((_req:IncomingMessage,res:ServerResponse)=>res.end('SHOULD-NOT-READ'));
  const {client}=await rawPeer(request,{minVersion:'TLSv1.2',maxVersion:'TLSv1.2'});
  await expect(localSecretSource(client).read('github')).rejects.toThrow(/^Local secret holder unavailable$/);
  expect(request).not.toHaveBeenCalled();
});
it('holder refuses a trusted client limited to TLS 1.2',async()=>{
  const {client,server}=setup();const read=vi.fn(async()=>Buffer.from('SHOULD-NOT-READ'));
  const holder=await listenLocalHolder(server,{read});closes.push(holder.close);
  await expect(new Promise<void>((resolve,reject)=>{
    const request=https.request({socketPath:client.socket,servername:client.servername,ca:privateBytes(client.ca),cert:privateBytes(client.cert),key:privateBytes(client.key),minVersion:'TLSv1.2',maxVersion:'TLSv1.2',agent:false},response=>{response.resume();resolve();});
    request.on('error',reject);request.end();
  })).rejects.toThrow();expect(read).not.toHaveBeenCalled();
});
it('enforces socket parent and ciphertext directory privacy and ownership',async()=>{
  const {home,client,server}=setup();const holder=await listenLocalHolder(server,{read:async()=>Buffer.from('TEST')});closes.push(holder.close);
  const source=localSecretSource(client);
  const second={...server,socket:join(home,'second.sock')};
  const rejectedListener=async()=>{
    const result=await listenLocalHolder(second,{read:async()=>Buffer.from('TEST')}).then(handle=>{closes.push(handle.close);return handle;},error=>error as unknown);
    expect(result).toBeInstanceOf(Error);
  };
  chmodSync(home,0o755);await expect(source.read('github')).rejects.toThrow();await rejectedListener();chmodSync(home,0o700);
  const foreignDirectory=()=>vi.spyOn(fs,'lstatSync').mockReturnValueOnce(Object.assign(fs.lstatSync(home),{uid:process.getuid!()+1}));
  let stat=foreignDirectory();await expect(source.read('github')).rejects.toThrow();stat.mockRestore();
  stat=foreignDirectory();await rejectedListener();stat.mockRestore();
  const directory=join(home,'values');mkdirSync(directory,{mode:0o700});const identity=join(home,'identity');writeFileSync(identity,await generateIdentity(),{mode:0o600});
  chmodSync(directory,0o755);expect(()=>ageSecretSource(directory,identity)).toThrow();chmodSync(directory,0o700);
  stat=foreignDirectory();expect(()=>ageSecretSource(directory,identity)).toThrow();stat.mockRestore();
  const age=ageSecretSource(directory,identity);chmodSync(directory,0o755);await expect(age.read('github')).rejects.toThrow();chmodSync(directory,0o700);
});
it('holder executable composes age and TLS, shuts down cleanly, and redacts startup failures',async()=>{
  const {home,client,server}=setup();const {run}=await import('../../secret-holder.js');
  const directory=join(home,'values');mkdirSync(directory,{mode:0o700});
  const identity=await generateIdentity(),file=join(home,'identity');writeFileSync(file,identity,{mode:0o600});
  const encrypt=new Encrypter();encrypt.addRecipient(await identityToRecipient(identity));writeFileSync(join(directory,'github.age'),await encrypt.encrypt('EXECUTABLE-FIXTURE'),{mode:0o600});
  const errors:string[]=[];
  const running=run(['--socket',server.socket,'--ca',server.ca,'--cert',server.cert,'--key',server.key,'--identity',file,'--values',directory],s=>errors.push(s));
  try {
    await vi.waitFor(()=>expect(existsSync(client.socket)).toBe(true));
    const bytes=await vi.waitFor(()=>localSecretSource(client).read('github'));expect(Buffer.from(bytes).toString()).toBe('EXECUTABLE-FIXTURE');bytes.fill(0);
  } finally {process.emit('SIGTERM');expect(await running).toBe(0);}
  expect(existsSync(client.socket)).toBe(false);expect(errors).toEqual([]);
  const early=run(['--socket',server.socket,'--ca',server.ca,'--cert',server.cert,'--key',server.key,'--identity',file,'--values',directory],s=>errors.push(s));
  process.emit('SIGINT');expect(await early).toBe(0);expect(existsSync(client.socket)).toBe(false);
  expect(await run(['--unknown','VALUE-MUST-NOT-LOG'],s=>errors.push(s))).toBe(2);
  expect(await run([],s=>errors.push(s))).toBe(2);
  writeFileSync(file,'VALUE-MUST-NOT-LOG');
  expect(await run(['--socket',server.socket,'--ca',server.ca,'--cert',server.cert,'--key',server.key,'--identity',file,'--values',directory],s=>errors.push(s))).toBe(2);
  expect(errors).toEqual(Array(3).fill('Local secret holder could not start\n'));
});

it('rejects oversized age payloads before invoking plaintext decryption, accepting exactly 64 KiB',async()=>{
  const {home}=setup();const directory=join(home,'values');mkdirSync(directory,{mode:0o700});
  const identity=await generateIdentity(),file=join(home,'identity');writeFileSync(file,identity,{mode:0o600});
  const encrypt=new Encrypter();encrypt.addRecipient(await identityToRecipient(identity));
  const source=ageSecretSource(directory,file),decrypt=vi.spyOn(Decrypter.prototype,'decrypt');
  for(const length of [0,65537,102400]) {
    writeFileSync(join(directory,'github.age'),await encrypt.encrypt(new Uint8Array(length)),{mode:0o600});
    await expect(source.read('github')).rejects.toThrow(/^Secret decryption unavailable$/);
    expect(decrypt).not.toHaveBeenCalled();
  }
  writeFileSync(join(directory,'github.age'),await encrypt.encrypt(new Uint8Array(65536).fill(65)),{mode:0o600});
  const bytes=await source.read('github');expect(bytes.length).toBe(65536);expect(bytes.every(v=>v===65)).toBe(true);bytes.fill(0);expect(decrypt).toHaveBeenCalledOnce();
});
it('recognizes the npm symlink entrypoint without starting the executable on import',async()=>{
  const {home}=setup();const {isHolderEntrypoint}=await import('../../secret-holder.js');
  const module=fileURLToPath(new URL('../../secret-holder.ts',import.meta.url)),link=join(home,'loom-secret-holder');symlinkSync(module,link);
  expect(isHolderEntrypoint(module)).toBe(true);expect(isHolderEntrypoint(link)).toBe(true);
  expect(isHolderEntrypoint(undefined)).toBe(false);expect(isHolderEntrypoint(join(home,'missing'))).toBe(false);expect(isHolderEntrypoint(join(home,'ca.pem'))).toBe(false);
});
it('absolute deadline ends a response that keeps streaming below each inactivity cutoff',async()=>{
  let interval:ReturnType<typeof setInterval>|undefined;
  const {client,received}=await rawPeer((_req,res)=>{res.writeHead(200,{'content-type':'application/octet-stream'});res.write('X');interval=setInterval(()=>res.write('X'),1000);});
  vi.useFakeTimers();
  try {
    const result=expect(localSecretSource(client).read('github')).rejects.toThrow(/^Local secret holder unavailable$/);
    await vi.waitFor(()=>expect(received.length).toBeGreaterThan(0));
    for(let n=0;n<3;n++) {const before=received.length;await vi.advanceTimersByTimeAsync(1000);await vi.waitFor(()=>expect(received.length).toBeGreaterThan(before));}
    await vi.advanceTimersByTimeAsync(2000);await result;
    expect(received.every(b=>b.every(v=>v===0))).toBe(true);
  } finally {clearInterval(interval);vi.useRealTimers();}
});
it('absolute deadline also bounds a peer that never completes TLS',async()=>{
  const {client,server:config}=setup();const {createServer}=await import('node:net');
  let connected=false;const sockets:import('node:net').Socket[]=[];
  const peer=createServer(socket=>{connected=true;sockets.push(socket);});
  await new Promise<void>((resolve,reject)=>{peer.once('error',reject);peer.listen(config.socket,resolve);});chmodSync(config.socket,0o600);
  closes.push(async()=>{for(const socket of sockets)socket.destroy();await new Promise<void>(resolve=>peer.close(()=>resolve()));});
  vi.useFakeTimers();
  try {
    const result=expect(localSecretSource(client).read('github')).rejects.toThrow(/^Local secret holder unavailable$/);
    await vi.waitFor(()=>expect(connected).toBe(true));await vi.advanceTimersByTimeAsync(5000);await result;
  } finally {vi.useRealTimers();}
});

it('reads only a bounded public generation through the authenticated holder, without obtaining a value',async()=>{
  const {home,client,server}=setup();const {randomUUID}=await import('node:crypto');
  let marker=randomUUID();const read=vi.fn(async()=>Buffer.from('MUST-NOT-READ'));
  const generation=vi.fn(()=>marker);
  const holder=await listenLocalHolder(server,{read,generation});closes.push(holder.close);
  const source=localSecretSource(client);
  expect(await source.generation()).toBe(marker);marker=randomUUID();expect(await source.generation()).toBe(marker);
  expect(read).not.toHaveBeenCalled();
  await expect(localSecretSource({...client,cert:join(home,'stranger.pem'),key:join(home,'stranger.key')}).generation()).rejects.toThrow(/^Local secret holder unavailable$/);
  expect(generation).toHaveBeenCalledTimes(2);
  generation.mockReturnValueOnce('CREDENTIAL-INSTEAD-OF-GENERATION');
  await expect(source.generation()).rejects.toThrow(/^Local secret holder unavailable$/);
  generation.mockImplementationOnce(()=>{throw Error('PRIVATE');});
  await expect(source.generation()).rejects.toThrow(/^Local secret holder unavailable$/);
  expect(read).not.toHaveBeenCalled();
});
it.each(['X'.repeat(37),'a'.repeat(36),'00000000-0000-4000-8000-00000000000\u00b0'])('rejects malformed holder generation responses without reflecting them',async body=>{
  const {client}=await rawPeer((_req,res)=>{res.writeHead(200,{'content-type':'application/octet-stream'});res.end(body);});
  await expect(localSecretSource(client).generation()).rejects.toThrow(/^Local secret holder unavailable$/);
});
