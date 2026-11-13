import {afterEach,expect,it,vi} from 'vitest';
import {mkdtempSync,mkdirSync,readFileSync,writeFileSync,rmSync,existsSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {X509Certificate,randomBytes,randomUUID} from 'node:crypto';
import {generateIdentity} from 'age-encryption';
import {startPersistentHolder} from './holder-lifecycle.js';
import {localHolderMutations} from './holder-mutations.js';
import {localSecretSource} from './local-holder.js';
import {remoteHolderAuthority} from './holder-authority.js';
import {startLoom} from '../../foundation.js';
import {fixture} from '../../fixture.js';
import {HouseholdDatabase} from '../../core/household/document.js';
import {FakeClock} from '../../core/clock.js';
import {run} from '../../secret-holder.js';
const homes:string[]=[],closes:(()=>Promise<void>)[]=[];
afterEach(async()=>{for(const close of closes.splice(0).reverse())await close();for(const home of homes.splice(0))rmSync(home,{recursive:true,force:true});vi.restoreAllMocks();});
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
  await api.set(who,'API',Buffer.from(value),'add');
  const first=await source.read('API');expect(Buffer.from(first).toString()).toBe(value);first.fill(0);
  await api.set({...who,writeId:randomUUID()},'API',Buffer.from('NEW'),'replace');
  await holder.close();await app.close();
  app=await startLoom({home:s.appHome,next:true,staging:true,clock,secretAuthority:s.authority,stdout:()=>{}});holder=await startPersistentHolder(s.file);
  await api.set(who,'API',Buffer.from(value),'add');
  const newer=await source.read('API');expect(Buffer.from(newer).toString()).toBe('NEW');newer.fill(0);
  await expect(api.set(who,'API',Buffer.from('CHANGED'),'add')).rejects.toThrow();
  const household=new HouseholdDatabase(app.db);
  app.db.transaction(()=>household.change(s.appHome,raw=>{raw.members=[...(raw.members as Array<{person:string}>).filter(m=>m.person!=='jonathan'),{person:'dana',role:'owner',agents:'*'}];}))();
  // Exact durable receipt replay is still forbidden after current member removal.
  await expect(api.set(who,'API',Buffer.from(value),'add')).rejects.toThrow();
  await expect(api.remove({...who,writeId:randomUUID()},'API')).rejects.toThrow();
  // Reinstalling the daemon with an injected permissive policy cannot override the database authority.
  await app.close();app=await startLoom({home:s.appHome,next:true,staging:true,clock,secretAuthority:s.authority,
    sharing:()=>({members:{jonathan:{owner:true,agents:['art']}},projects:{},services:{}}),stdout:()=>{}});
  await expect(api.remove({...who,writeId:randomUUID()},'API')).rejects.toThrow();
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
