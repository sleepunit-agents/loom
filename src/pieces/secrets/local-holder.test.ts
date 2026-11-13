import { afterEach, expect, it, vi } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, chmodSync, symlinkSync, linkSync, unlinkSync } from 'node:fs';
import https from 'node:https';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Encrypter, generateIdentity, identityToRecipient } from 'age-encryption';
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

async function rawPeer(handler:(req:IncomingMessage,res:ServerResponse)=>void) {
  const {home,client,server:config}=setup();
  const peer=https.createServer({key:privateBytes(config.key),cert:privateBytes(config.cert),ca:privateBytes(config.ca),requestCert:true,rejectUnauthorized:true,minVersion:'TLSv1.3'},handler);
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
