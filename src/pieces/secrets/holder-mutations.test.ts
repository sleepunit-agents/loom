import {afterEach,expect,it,vi} from 'vitest';
import {mkdtempSync,readFileSync,writeFileSync,rmSync,chmodSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {X509Certificate,randomUUID,randomBytes} from 'node:crypto';
import https from 'node:https';
import {IncomingMessage} from 'node:http';
import {connect as tlsConnect} from 'node:tls';
import {connect as netConnect} from 'node:net';
import {generateIdentity} from 'age-encryption';
import {listenHolderMutations,localHolderMutations} from './holder-mutations.js';
import {openHolderStore} from './holder-store.js';
import {localSecretSource,privateBytes} from './local-holder.js';
const homes:string[]=[],closes:(()=>Promise<void>)[]=[];
afterEach(async()=>{vi.useRealTimers();for(const close of closes.splice(0).reverse())await close();for(const home of homes.splice(0))rmSync(home,{recursive:true,force:true});vi.restoreAllMocks();});
function setup(){
  const home=mkdtempSync(join(tmpdir(),'holder-mutations-'));homes.push(home);
  const fixtures=fileURLToPath(new URL('./fixtures/holder-tls/',import.meta.url));
  for(const name of ['ca.pem','holder.pem','holder.key','daemon.pem','daemon.key','stranger.pem','stranger.key'])writeFileSync(join(home,name),readFileSync(join(fixtures,name)),{mode:0o600});
  const common={socket:join(home,'mutations.sock'),ca:join(home,'ca.pem')};
  const client={...common,cert:join(home,'daemon.pem'),key:join(home,'daemon.key'),servername:'holder.test'};
  const server={...common,cert:join(home,'holder.pem'),key:join(home,'holder.key')};
  const fingerprint=new X509Certificate(readFileSync(client.cert)).fingerprint256;
  const authority=vi.fn(async(peer:string,member:string)=>peer===fingerprint&&member==='asserted-owner'?'actual-owner':null);
  const who={member:'asserted-owner',writeId:randomUUID()};
  const raw=(path:string,body:Buffer,headers:Record<string,string>={})=>new Promise<number>((resolve,reject)=>{
    const request=https.request({socketPath:client.socket,servername:client.servername,ca:privateBytes(client.ca),cert:privateBytes(client.cert),key:privateBytes(client.key),agent:false,method:'POST',path,
      headers:{'content-type':'application/octet-stream','content-length':String(body.length),'x-holder-member':Buffer.from(who.member).toString('base64url'),'x-holder-write-id':who.writeId,...headers}},response=>{const chunks:Buffer[]=[];response.on('data',b=>chunks.push(b));response.on('end',()=>{expect(Buffer.concat(chunks).length).toBe(0);resolve(response.statusCode!);});});
    request.on('error',reject);request.end(body);
  });
  return {home,client,server,authority,who,raw};
}
it('awaits persistent mutations, resolves actual membership and survives restart without replaying obsolete writes',async()=>{
  const {home,client,server,authority,who}=setup();
  const identity=join(home,'identity'),key=join(home,'receipt-key');writeFileSync(identity,await generateIdentity(),{mode:0o600});writeFileSync(key,randomBytes(32),{mode:0o600});
  let store=await openHolderStore(home,identity,key);let holder=await listenHolderMutations(server,store,authority);
  closes.push(async()=>{await holder.close();store.close();});const api=localHolderMutations(client);
  const sentinel='MUTATION-TRANSPORT-SENTINEL';const bytes=Buffer.from(sentinel);const original=Buffer.from(bytes);
  const pending=api.set(who,'github',bytes,'add');bytes.fill(0);await expect(pending).resolves.toBeUndefined();
  expect(authority.mock.calls.every(c=>c[1]==='asserted-owner')).toBe(true);
  const value=await store.read('github');expect(Buffer.from(value)).toEqual(original);value.fill(0);
  await api.set({...who,writeId:randomUUID()},'github',Buffer.from('NEW'),'replace');
  await holder.close();store.close();store=await openHolderStore(home,identity,key);holder=await listenHolderMutations(server,store,authority);
  await api.set(who,'github',original,'add');const newer=await store.read('github');expect(Buffer.from(newer).toString()).toBe('NEW');newer.fill(0);
  await expect(api.set(who,'github',Buffer.from('CHANGED'),'add')).rejects.toThrow(/^Local secret mutation unavailable$/);
  const removal={...who,writeId:randomUUID()};await api.remove(removal,'github');await api.set({...who,writeId:randomUUID()},'github',Buffer.from('RE-ADDED'),'add');await api.remove(removal,'github');
  const readded=await store.read('github');expect(Buffer.from(readded).toString()).toBe('RE-ADDED');readded.fill(0);
  const Database=(await import('better-sqlite3')).default;const db=new Database(join(home,'holder.db'),{readonly:true});
  try{expect(db.prepare('SELECT DISTINCT member FROM holder_receipts').all()).toEqual([{member:'actual-owner'}]);expect(readFileSync(join(home,'holder.db')).includes(sentinel)).toBe(false);if(db.pragma('journal_mode',{simple:true})==='wal')expect(readFileSync(join(home,'holder.db-wal')).includes(sentinel)).toBe(false);}finally{db.close();}
});
it('rejects wrong peers, false membership and revoked permission even on exact retries',async()=>{
  const {home,client,server,authority,who}=setup();const set=vi.fn(async(_who:unknown,_name:string,_bytes:Uint8Array,_mode:string)=>{}),remove=vi.fn();const holder=await listenHolderMutations(server,{set,remove},authority);closes.push(holder.close);
  const api=localHolderMutations(client);
  await expect(localHolderMutations({...client,cert:join(home,'stranger.pem'),key:join(home,'stranger.key')}).set(who,'github',Buffer.from('X'),'add')).rejects.toThrow(/^Local secret mutation unavailable$/);
  await expect(localHolderMutations({...client,servername:'wrong.test'}).remove(who,'github')).rejects.toThrow();expect(authority).not.toHaveBeenCalled();
  await expect(api.set({...who,member:'actual-owner'},'github',Buffer.from('X'),'add')).rejects.toThrow();expect(set).not.toHaveBeenCalled();
  await api.set(who,'github',Buffer.from('X'),'add');expect(set.mock.calls[0][0]).toEqual({member:'actual-owner',writeId:who.writeId});
  authority.mockResolvedValue(null);await expect(api.set(who,'github',Buffer.from('X'),'add')).rejects.toThrow();await expect(api.remove(who,'github')).rejects.toThrow();expect(set).toHaveBeenCalledOnce();expect(remove).not.toHaveBeenCalled();
});
it('checks current permission again after input and before a mutation',async()=>{
  const {client,server,authority,who}=setup();authority.mockResolvedValueOnce('actual-owner').mockResolvedValue(null);
  const set=vi.fn(async(_who:unknown,_name:string,_bytes:Uint8Array,_mode:string)=>{}),remove=vi.fn();const holder=await listenHolderMutations(server,{set,remove},authority);closes.push(holder.close);
  await expect(localHolderMutations(client).set(who,'github',Buffer.from('VALUE'),'add')).rejects.toThrow();expect(authority).toHaveBeenCalledTimes(2);expect(set).not.toHaveBeenCalled();
});
it('acknowledges only completed work and erases owned provider input on success and failure',async()=>{
  const {client,server,authority,who}=setup();const owned:Uint8Array[]=[];let finish!:()=>void;
  const set=vi.fn(async(_who:unknown,_name:string,bytes:Uint8Array)=>{owned.push(bytes);await new Promise<void>(resolve=>{finish=resolve;});});
  const holder=await listenHolderMutations(server,{set,remove:()=>{}},authority);closes.push(holder.close);
  let done=false;const pending=localHolderMutations(client).set(who,'github',Buffer.from('VALUE'),'add').then(()=>{done=true;});
  await vi.waitFor(()=>expect(set).toHaveBeenCalledOnce());expect(done).toBe(false);expect(Buffer.from(owned[0]).toString()).toBe('VALUE');finish();await pending;expect(owned[0].every(v=>v===0)).toBe(true);
  set.mockImplementationOnce(async(_who,_name,bytes)=>{owned.push(bytes);throw Error('VALUE-MUST-NOT-LEAK');});
  const logs=[vi.spyOn(console,'log'),vi.spyOn(console,'warn'),vi.spyOn(console,'error')];
  await expect(localHolderMutations(client).set(who,'github',Buffer.from('VALUE'),'replace')).rejects.toThrow(/^Local secret mutation unavailable$/);expect(owned[1].every(v=>v===0)).toBe(true);expect(logs.every(s=>!s.mock.calls.length)).toBe(true);
  await expect(localSecretSource(client).read('github')).rejects.toThrow();
});
it('bounds input and rejects malformed framing or routes without touching storage',async()=>{
  const {client,server,authority,who,raw}=setup();const set=vi.fn(async(_who:unknown,_name:string,_bytes:Uint8Array,_mode:string)=>{}),remove=vi.fn();const holder=await listenHolderMutations(server,{set,remove},authority);closes.push(holder.close);
  for(const [path,body,headers] of [
    ['/v1/mutation/add/github',Buffer.alloc(0),{}],['/v1/mutation/add/github',Buffer.alloc(65537),{}],
    ['/v1/mutation/remove/github',Buffer.from('X'),{}],['/v1/mutation/rotate/github',Buffer.from('X'),{}],
    ['/v1/mutation/add/github',Buffer.from('X'),{'x-holder-write-id':'bad'}],
    ['/v1/mutation/add/github',Buffer.from('X'),{'x-holder-member':'***'}],
    ['/v1/mutation/add/github',Buffer.from('X'),{'content-type':'text/plain'}],
  ] as [string,Buffer,Record<string,string>][])expect(await raw(path,body,headers)).toBe(503);
  expect(set).not.toHaveBeenCalled();expect(remove).not.toHaveBeenCalled();
  await localHolderMutations(client).set(who,'github',Buffer.alloc(65536,65),'add');expect(set).toHaveBeenCalledOnce();
  chmodSync(client.socket,0o666);await expect(localHolderMutations(client).remove(who,'github')).rejects.toThrow();chmodSync(client.socket,0o600);
});
it('absolute deadline bounds a stalled authority and prevents late mutations',async()=>{
  const {client,server,authority,who}=setup();let finish!:(member:string)=>void;authority.mockImplementation(()=>new Promise(resolve=>{finish=resolve;}));
  const set=vi.fn(async()=>{});const holder=await listenHolderMutations(server,{set,remove:()=>{}},authority);closes.push(holder.close);
  vi.useFakeTimers();try{
    const pending=expect(localHolderMutations(client).set(who,'github',Buffer.from('VALUE'),'add')).rejects.toThrow(/^Local secret mutation unavailable$/);
    await vi.waitFor(()=>expect(authority).toHaveBeenCalledOnce());await vi.advanceTimersByTimeAsync(5000);await pending;finish('actual-owner');await Promise.resolve();expect(set).not.toHaveBeenCalled();
  }finally{vi.useRealTimers();}
});
it('erases the client snapshot and refuses holder-controlled acknowledgement bodies',async()=>{
  const {client,server,who}=setup();const sent:Buffer[]=[];const received:Buffer[]=[];
  const peer=https.createServer({ca:privateBytes(server.ca),cert:privateBytes(server.cert),key:privateBytes(server.key),requestCert:true,rejectUnauthorized:true,minVersion:'TLSv1.3'},(req,res)=>{
    req.resume();req.on('end',()=>{res.writeHead(200,{'content-length':26});res.end('SENTINEL-INVALID-ACK-BODY!!');});
  });
  await new Promise<void>(resolve=>peer.listen(server.socket,resolve));chmodSync(server.socket,0o600);
  closes.push(async()=>{peer.closeAllConnections();await new Promise<void>(resolve=>peer.close(()=>resolve()));});
  const real=https.request;
  vi.spyOn(https,'request').mockImplementation(((options:https.RequestOptions,callback:(r:import('node:http').IncomingMessage)=>void)=>{
    const request=real(options,response=>{response.on('data',(b:Buffer)=>received.push(b));callback(response);});
    const end=request.end.bind(request);
    request.end=((bytes:Buffer)=>{if(bytes)sent.push(bytes);return end(bytes);}) as typeof request.end;
    return request;
  }) as typeof https.request);
  const input=Buffer.from('CLIENT-OWNED-SENTINEL');
  await expect(localHolderMutations(client).set(who,'github',input,'add')).rejects.toThrow(/^Local secret mutation unavailable$/);
  expect(input.toString()).toBe('CLIENT-OWNED-SENTINEL');expect(sent).toHaveLength(1);expect(sent[0].every(v=>v===0)).toBe(true);
  // Invalid status is discarded before listening for or retaining response data.
  expect(received).toHaveLength(0);
});
it('client deadline also bounds an already started mutation and erases both copies after late completion',async()=>{
  const {client,server,authority,who}=setup();let finish!:()=>void;let provider:Uint8Array|undefined;
  const set=vi.fn(async(_who:unknown,_name:string,bytes:Uint8Array)=>{provider=bytes;await new Promise<void>(resolve=>{finish=resolve;});});
  const holder=await listenHolderMutations(server,{set,remove:()=>{}},authority);closes.push(holder.close);
  vi.useFakeTimers();try{
    const pending=expect(localHolderMutations(client).set(who,'github',Buffer.from('LATE-VALUE'),'add')).rejects.toThrow(/^Local secret mutation unavailable$/);
    await vi.waitFor(()=>expect(set).toHaveBeenCalledOnce());await vi.advanceTimersByTimeAsync(5000);await pending;
    // Storage owns an in-flight copy until the awaited operation has settled.
    expect(Buffer.from(provider!).toString()).toBe('LATE-VALUE');
    finish();await vi.waitFor(()=>expect(provider!.every(v=>v===0)).toBe(true));
  }finally{vi.useRealTimers();}
});

it('rejects changed actual identity at the second authority check',async()=>{
  const {client,server,authority,who}=setup();authority.mockResolvedValueOnce('actual-owner').mockResolvedValue('different-owner');
  const set=vi.fn(async()=>{}),remove=vi.fn();const holder=await listenHolderMutations(server,{set,remove},authority);closes.push(holder.close);
  await expect(localHolderMutations(client).remove(who,'github')).rejects.toThrow();expect(authority).toHaveBeenCalledTimes(2);expect(remove).not.toHaveBeenCalled();
});
it('does not consume request input while admission authority is pending',async()=>{
  const {client,server,authority,who}=setup();let admit!:(member:string)=>void;
  authority.mockImplementationOnce(()=>new Promise(resolve=>{admit=resolve;}));
  const reads=vi.spyOn(IncomingMessage.prototype,'read');
  const set=vi.fn(async()=>{}),remove=vi.fn();const holder=await listenHolderMutations(server,{set,remove},authority);closes.push(holder.close);
  const pending=localHolderMutations(client).set(who,'github',Buffer.alloc(65536,65),'add');
  await vi.waitFor(()=>expect(authority).toHaveBeenCalledOnce());
  const bodyReads=()=>reads.mock.contexts.filter(req=>req.url==='/v1/mutation/add/github');
  expect(bodyReads()).toHaveLength(0);expect(set).not.toHaveBeenCalled();
  admit('actual-owner');await pending;expect(bodyReads().length).toBeGreaterThan(0);expect(set).toHaveBeenCalledOnce();
});
it('refuses an occupied socket and leaves its original listener reachable',async()=>{
  const {client,server,authority,who}=setup();const original=vi.fn(async()=>{}),impostor=vi.fn(async()=>{});
  const holder=await listenHolderMutations(server,{set:original,remove:()=>{}},authority);closes.push(holder.close);
  await expect(listenHolderMutations(server,{set:impostor,remove:()=>{}},authority)).rejects.toThrow(/^Local secret mutation unavailable$/);
  await localHolderMutations(client).set(who,'github',Buffer.from('VALUE'),'add');expect(original).toHaveBeenCalledOnce();expect(impostor).not.toHaveBeenCalled();
});
it('bounds connections before TLS completion or complete HTTP headers arrive',async()=>{
  const {client,server,authority}=setup();const set=vi.fn(async()=>{}),remove=vi.fn();
  const holder=await listenHolderMutations(server,{set,remove},authority);closes.push(holder.close);
  for(const tls of [false,true]) {
    vi.useFakeTimers();let connected=false,closed=false;
    const peer=tls?tlsConnect({path:client.socket,servername:client.servername,ca:privateBytes(client.ca),cert:privateBytes(client.cert),key:privateBytes(client.key),minVersion:'TLSv1.3'},()=>{connected=true;peer.write('POST /v1/mutation/add/github HTTP/1.1\r\nHost: holder.test\r\n');})
      :netConnect(client.socket,()=>{connected=true;});
    peer.on('error',()=>{});peer.on('close',()=>{closed=true;});
    try {
      await vi.waitFor(()=>expect(connected).toBe(true));await vi.advanceTimersByTimeAsync(5000);
      await vi.waitFor(()=>expect(closed).toBe(true));expect(authority).not.toHaveBeenCalled();expect(set).not.toHaveBeenCalled();expect(remove).not.toHaveBeenCalled();
    } finally {peer.destroy();vi.useRealTimers();}
  }
});
