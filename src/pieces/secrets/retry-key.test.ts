import {afterEach,expect,it,vi} from 'vitest';
import fs, {constants,fstatSync,openSync,readSync,chmodSync,linkSync,mkdtempSync,readFileSync,rmSync,symlinkSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createHmac,randomUUID} from 'node:crypto';
import {startLoom} from '../../foundation.js';
import {fixture,fixtureSharing} from '../../fixture.js';
import {FakeClock,type Viewer} from '../../core/index.js';
import {installAsyncSecretValuesFromFile} from './retry-key.js';
vi.mock('node:fs',async importOriginal=>{
 const real=await importOriginal<typeof import('node:fs')>();
 return {...real,openSync:vi.fn(real.openSync),fstatSync:vi.fn(real.fstatSync),readSync:vi.fn(real.readSync),default:{...real.default,lstatSync:vi.fn(real.lstatSync)}};
});
const realFs=await vi.importActual<typeof import('node:fs')>('node:fs');
const owner:Viewer={kind:'member',id:'jonathan'}, key=Buffer.alloc(32,17);
const roots:string[]=[],closes:(()=>Promise<void>)[]=[];
afterEach(async()=>{for(const c of closes.splice(0).reverse())await c();for(const r of roots.splice(0))rmSync(r,{recursive:true,force:true});vi.restoreAllMocks();
 vi.mocked(openSync).mockReset().mockImplementation(realFs.openSync);
 vi.mocked(fstatSync).mockReset().mockImplementation(realFs.fstatSync);
 vi.mocked(readSync).mockReset().mockImplementation(realFs.readSync);
 vi.mocked(fs.lstatSync).mockReset().mockImplementation(realFs.lstatSync);
});
function home(){const root=mkdtempSync(join(tmpdir(),'retry-key-'));roots.push(root);fixture(root);const path=join(root,'daemon.key');writeFileSync(path,key,{mode:0o600});return {root,path};}
function holder(){const receipts=new Set<string>();return {receipts,set:vi.fn(async(who:{writeId:string})=>{receipts.add(who.writeId);}),remove:vi.fn(async()=>{}),hasReceipt:vi.fn(async(who:{writeId:string})=>receipts.has(who.writeId))};}
async function open(root:string,clock=new FakeClock()) {const app=await startLoom({home:root,next:true,staging:true,clock,stdout:()=>{}});closes.push(app.close);return app;}
const binding=(app:Awaited<ReturnType<typeof open>>)=>(app.db.prepare("SELECT value FROM secrets_meta WHERE key='daemon-retry-key-v1'").get() as {value:string}|undefined)?.value;
it('loads the same disk key after daemon restart and core expiry to reconcile a lost holder reply',async()=>{
 const {root,path}=home(),clock=new FakeClock(),h=holder();let app=await open(root,clock);
 const install=()=>installAsyncSecretValuesFromFile(app.db,app.operations,fixtureSharing,h,path);
 install();const expected=createHmac('sha256',key).update('loom-secrets-daemon-retry-key-v1\0').digest('hex');expect(binding(app)).toBe(expected);
 h.set.mockImplementationOnce(async who=>{h.receipts.add(who.writeId);throw Error('PRIVATE-HOLDER-DETAIL');});
 const input={name:'API',mode:'add',value:'FILE-RETRY-SENTINEL',writeId:randomUUID()};
 const call=()=>app.operations.callAsync('http',owner,'secrets.set',input,'stable');
 expect(await call()).toMatchObject({code:'unavailable'});expect(h.set).toHaveBeenCalledTimes(1);
 await app.close();clock.advance(31*86400_000);app=await open(root,clock);install();
 expect(await call()).toEqual({ok:true,value:{saved:true}});expect(h.set).toHaveBeenCalledTimes(1);
 // This second restart expires an actual saved core success result.
 await app.close();clock.advance(31*86400_000);app=await open(root,clock);install();
 expect(await call()).toEqual({ok:true,value:{saved:true}});expect(h.set).toHaveBeenCalledTimes(1);
 expect(binding(app)).toBe(expected);expect(readFileSync(path)).toEqual(key);
 const tables=app.db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as {name:string}[];
 for(const {name} of tables){const contents=JSON.stringify(app.db.prepare(`SELECT * FROM "${name}"`).all());expect(contents).not.toContain(input.value);expect(contents).not.toContain(key.toString('hex'));}
});
it.each([false,true])('rejects replacement keys at startup (completed journal: %s) before registration or holder calls and retains the original binding',async completed=>{
 const {root,path}=home(),h=holder();let app=await open(root);
 installAsyncSecretValuesFromFile(app.db,app.operations,fixtureSharing,h,path);
 if(completed)expect(await app.operations.callAsync('http',owner,'secrets.set',{name:'API',mode:'add',value:'COMPLETED-SYNTHETIC',writeId:randomUUID()},'done')).toMatchObject({ok:true});
 const pinned=binding(app);await app.close();
 writeFileSync(path,Buffer.alloc(32,18));app=await open(root);
 expect(()=>installAsyncSecretValuesFromFile(app.db,app.operations,fixtureSharing,h,path)).toThrow('Secret retry key unavailable');
 expect(app.operations.has('secrets.set')).toBe(false);expect(app.operations.has('secrets.remove')).toBe(false);expect(binding(app)).toBe(pinned);expect(h.hasReceipt).toHaveBeenCalledTimes(completed?1:0);
 writeFileSync(path,key);installAsyncSecretValuesFromFile(app.db,app.operations,fixtureSharing,h,path);expect(app.operations.has('secrets.set')).toBe(true);
});
it('refuses missing, relative, short, long, public, symbolic and hardlinked key files without changing the database',async()=>{
 const {root,path}=home(),app=await open(root),h=holder();
 const attempt=(p:string)=>{expect(()=>installAsyncSecretValuesFromFile(app.db,app.operations,fixtureSharing,h,p)).toThrow('Secret retry key unavailable');expect(binding(app)).toBeUndefined();expect(app.operations.has('secrets.set')).toBe(false);};
 attempt(join(root,'MISSING-PRIVATE-PATH'));attempt('relative');
 for(const n of [0,31,33,100000]){writeFileSync(path,Buffer.alloc(n));attempt(path);}
 writeFileSync(path,key);chmodSync(path,0o640);attempt(path);chmodSync(path,0o600);
 const alias=join(root,'alias');symlinkSync(path,alias);attempt(alias);rmSync(alias);linkSync(path,alias);attempt(path);attempt(alias);rmSync(alias);
 chmodSync(root,0o750);attempt(path);chmodSync(root,0o700);
 expect(h.set).not.toHaveBeenCalled();expect(h.hasReceipt).not.toHaveBeenCalled();
});
it.each(['pending','complete'])('refuses adopting an older unbound %s journal instead of guessing its key',async state=>{
 const {root,path}=home(),h=holder();let app=await open(root);
 installAsyncSecretValuesFromFile(app.db,app.operations,fixtureSharing,h,path);
 if(state==='pending')h.set.mockRejectedValueOnce(Error('lost'));
 await app.operations.callAsync('http',owner,'secrets.set',{name:'API',mode:'add',value:'OLD-SYNTHETIC',writeId:randomUUID()},'old');
 expect(app.db.prepare('SELECT state FROM secrets_write_intents').get()).toEqual({state});
 app.db.prepare("DELETE FROM secrets_meta WHERE key='daemon-retry-key-v1'").run();await app.close();app=await open(root);
 expect(()=>installAsyncSecretValuesFromFile(app.db,app.operations,fixtureSharing,h,path)).toThrow('Secret retry key unavailable');
 expect(binding(app)).toBeUndefined();expect(app.operations.has('secrets.set')).toBe(false);expect(app.db.prepare('SELECT state FROM secrets_write_intents').get()).toEqual({state});
});
it('refuses installation inside an outer transaction and leaves normal next mode disabled',async()=>{
 const {root,path}=home(),app=await open(root),h=holder();expect(app.operations.has('secrets.set')).toBe(false);
 app.db.transaction(()=>{expect(()=>installAsyncSecretValuesFromFile(app.db,app.operations,fixtureSharing,h,path)).toThrow('Secret retry key unavailable');})();
 expect(binding(app)).toBeUndefined();expect(app.operations.has('secrets.set')).toBe(false);
});

it('erases the actual file-read buffer after success and a key mismatch while retaining the correct crypto copy',async()=>{
 const {root,path}=home(),h=holder();let app=await open(root);const captured:Buffer[]=[];
 vi.mocked(readSync).mockImplementation((...args:Parameters<typeof realFs.readSync>)=>{captured.push(args[1] as Buffer);return realFs.readSync(...args);});
 installAsyncSecretValuesFromFile(app.db,app.operations,fixtureSharing,h,path);
 expect(captured.length).toBeGreaterThan(0);for(const b of captured)expect([...b]).toEqual(Array(33).fill(0));
 const input={name:'API',mode:'add',value:'COPIED-KEY-SENTINEL',writeId:randomUUID()};
 expect(await app.operations.callAsync('http',owner,'secrets.set',input,'copy')).toMatchObject({ok:true});
 const canonical=JSON.stringify(Object.fromEntries(Object.entries(input).sort(([a],[b])=>a.localeCompare(b))));
 const row=app.db.prepare('SELECT input_hash FROM secrets_write_intents').get() as {input_hash:string};
 expect(row.input_hash).toBe(createHmac('sha256',key).update('loom-secrets-operation-v1\0').update(canonical).digest('hex'));
 await app.close();app=await open(root);writeFileSync(path,Buffer.alloc(32,19));captured.length=0;
 expect(()=>installAsyncSecretValuesFromFile(app.db,app.operations,fixtureSharing,h,path)).toThrow('Secret retry key unavailable');
 expect(captured.length).toBeGreaterThan(0);for(const b of captured)expect([...b]).toEqual(Array(33).fill(0));
});
it('refuses wrong ownership of the file and parent and a nonregular FIFO before reading',async()=>{
 const {root,path}=home(),app=await open(root),h=holder();
 const attempt=()=>{expect(()=>installAsyncSecretValuesFromFile(app.db,app.operations,fixtureSharing,h,path)).toThrow('Secret retry key unavailable');expect(binding(app)).toBeUndefined();expect(app.operations.has('secrets.set')).toBe(false);};
 vi.mocked(fstatSync).mockImplementationOnce(fd=>{const stat=realFs.fstatSync(fd);return Object.assign(stat,{uid:stat.uid+1});});attempt();expect(readSync).not.toHaveBeenCalled();
 vi.mocked(fs.lstatSync).mockImplementationOnce(p=>{const stat=realFs.lstatSync(p);return Object.assign(stat,{uid:stat.uid+1});});attempt();expect(readSync).not.toHaveBeenCalled();
 // Fake a FIFO at the opened descriptor; no child process or blocking FIFO open.
 // Opening a real FIFO without O_NONBLOCK would wait before fstat could reject it.
 let fifoFlags=0;
 vi.mocked(openSync).mockImplementationOnce((p,flags,mode)=>{fifoFlags=flags as number;return realFs.openSync(p,flags,mode);});
 vi.mocked(fstatSync).mockImplementationOnce(fd=>{const stat=realFs.fstatSync(fd);return Object.assign(stat,{isFile:()=>false,isFIFO:()=>true});});attempt();expect(fifoFlags&constants.O_NONBLOCK).not.toBe(0);expect(readSync).not.toHaveBeenCalled();
});
it('caps reads and erases the bounded buffer when the file grows after fstat',async()=>{
 const {root,path}=home(),app=await open(root),h=holder();const captured:Buffer[]=[];let total=0;
 vi.mocked(fstatSync).mockImplementationOnce(fd=>{const stat=realFs.fstatSync(fd);writeFileSync(path,Buffer.alloc(100000,23));return stat;});
 vi.mocked(readSync).mockImplementation((...args:Parameters<typeof realFs.readSync>)=>{captured.push(args[1] as Buffer);expect((args[1] as Buffer).length).toBe(33);const n=realFs.readSync(...args);total+=n;return n;});
 expect(()=>installAsyncSecretValuesFromFile(app.db,app.operations,fixtureSharing,h,path)).toThrow('Secret retry key unavailable');
 expect(total).toBe(33);expect(captured.length).toBeGreaterThan(0);for(const b of captured)expect([...b]).toEqual(Array(33).fill(0));
 expect(binding(app)).toBeUndefined();expect(app.operations.has('secrets.set')).toBe(false);expect(h.hasReceipt).not.toHaveBeenCalled();
});
