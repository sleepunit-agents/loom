import {afterEach,expect,it,vi} from 'vitest';
import {mkdtempSync,rmSync,writeFileSync,readFileSync,chmodSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createHmac,randomUUID} from 'node:crypto';
import {generateIdentity} from 'age-encryption';
import {startLoom} from '../../foundation.js';
import {fixture,fixtureSharing} from '../../fixture.js';
import {FakeClock,type Viewer} from '../../core/index.js';
import {installAsyncSecretValues,type AsyncSecretMutations} from './async-values.js';
import {installAsyncSecretValuesFromFile,type SecretRetryKeyMaterial} from './retry-key.js';
import {openHolderStore} from './holder-store.js';
const owner:Viewer={kind:'member',id:'jonathan'}, dana:Viewer={kind:'member',id:'dana'};
const keys=[Buffer.alloc(32,41),Buffer.alloc(32,42),Buffer.alloc(32,43)];
const roots:string[]=[],closes:(()=>Promise<void>)[]=[];
afterEach(async()=>{for(const close of closes.splice(0).reverse())await close();for(const root of roots.splice(0))rmSync(root,{recursive:true,force:true});vi.restoreAllMocks();});
function home(){const root=mkdtempSync(join(tmpdir(),'retry-rotation-'));roots.push(root);fixture(root);return root;}
function fake(){const receipts=new Set<string>();return {set:vi.fn(async(w:{writeId:string})=>{receipts.add(w.writeId);}),remove:vi.fn(async(w:{writeId:string})=>{receipts.add(w.writeId);}),hasReceipt:vi.fn(async(w:{writeId:string})=>receipts.has(w.writeId))};}
async function open(root:string,clock=new FakeClock()) {const app=await startLoom({home:root,next:true,staging:true,clock,stdout:()=>{}});closes.push(app.close);return app;}
type App=Awaited<ReturnType<typeof open>>;
const sharing=()=>({...fixtureSharing(),members:{...fixtureSharing().members,dana:{owner:true,agents:['art']}}});
function install(app:App,h:AsyncSecretMutations,material:SecretRetryKeyMaterial){installAsyncSecretValues(app.db,app.operations,sharing,h,material);}
const input=(name='API')=>({name,mode:'add' as const,value:'ROTATION-SYNTHETIC-VALUE',writeId:randomUUID()});
const call=(app:App,body:unknown,id:string,v=owner,name='secrets.set')=>app.operations.callAsync('http',v,name,body,id);
const intents=(app:App)=>app.db.prepare('SELECT * FROM secrets_write_intents ORDER BY sequence').all();
const meta=(app:App)=>app.db.prepare('SELECT * FROM secrets_meta ORDER BY key').all();
function hash(key:Uint8Array,body:object){return createHmac('sha256',key).update('loom-secrets-operation-v1\0').update(JSON.stringify(Object.fromEntries(Object.entries(body).sort(([a],[b])=>a.localeCompare(b))))).digest('hex');}
it('preserves pending and completed identities through two rotations and core expiry; fresh writes use only the active key',async()=>{
 const root=home(),clock=new FakeClock(),h=fake(),first=input();let app=await open(root,clock);install(app,h,keys[0]);
 h.set.mockImplementationOnce(async w=>{throw Error(w.writeId);});
 expect(await call(app,first,'pending')).toMatchObject({code:'unavailable'});const pending=intents(app);
 await app.close();app=await open(root,clock);install(app,h,{active:keys[1],previous:[keys[0]]});
 expect(intents(app)).toEqual(pending);
 expect(await call(app,{...first,value:'CHANGED'},'pending')).toMatchObject({code:'conflict'});
 expect(await call(app,{...first,mode:'replace'},'pending')).toMatchObject({code:'conflict'});
 expect(await call(app,{...first,writeId:randomUUID()},'pending')).toMatchObject({code:'conflict'});
 expect(await call(app,first,'pending',dana)).toMatchObject({code:'unavailable'}); // different viewer cannot borrow the reservation
 expect(await call(app,first,'pending')).toEqual({ok:true,value:{saved:true}});
 const second=input('NEXT');expect(await call(app,second,'fresh')).toMatchObject({ok:true});
 expect(app.db.prepare('SELECT input_hash FROM secrets_write_intents ORDER BY sequence').all()).toEqual([{input_hash:hash(keys[0],first)},{input_hash:hash(keys[1],second)}]);
 const completed=intents(app),sets=h.set.mock.calls.length;
 await app.close();clock.advance(31*86400_000);app=await open(root,clock);install(app,h,{active:keys[2],previous:[keys[1],keys[0]]});
 expect(intents(app)).toEqual(completed);
 expect(await call(app,first,'pending')).toEqual({ok:true,value:{saved:true}});
 expect(await call(app,second,'fresh')).toEqual({ok:true,value:{saved:true}});expect(h.set).toHaveBeenCalledTimes(sets);
 // Identical canonical input under another viewer/core id still selects active.
 const removal={name:first.name,writeId:randomUUID()};expect(await call(app,removal,'remove',owner,'secrets.remove')).toMatchObject({ok:true});
 expect(await call(app,first,'another',dana)).toMatchObject({ok:true});
 expect(app.db.prepare("SELECT input_hash FROM secrets_write_intents WHERE id='another'").get()).toEqual({input_hash:hash(keys[2],first)});
 expect(await call(app,{name:first.name,writeId:first.writeId},'pending',owner,'secrets.remove')).toMatchObject({code:'conflict'});
 for(const {name} of app.db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as {name:string}[]){const rows=JSON.stringify(app.db.prepare(`SELECT * FROM "${name}"`).all());expect(rows).not.toContain(first.value);for(const key of keys)expect(rows).not.toContain(key.toString('hex'));}
});
it('recovers a real encrypted-holder lost acknowledgement after rotation and never replays an obsolete removal',async()=>{
 const root=home(),holderRoot=home(),identity=join(holderRoot,'age.key'),receipt=join(holderRoot,'receipt.key');
 writeFileSync(identity,await generateIdentity(),{mode:0o600});writeFileSync(receipt,Buffer.alloc(32,61),{mode:0o600});
 let store=await openHolderStore(holderRoot,identity,receipt);const clock=new FakeClock();let app=await open(root,clock);
 const h={set:vi.fn(async(...args:Parameters<typeof store.set>)=>{await store.set(...args);throw Error('LOST');}),remove:vi.fn(async(...args:Parameters<typeof store.remove>)=>{store.remove(...args);}),hasReceipt:async(...args:Parameters<typeof store.hasReceipt>)=>store.hasReceipt(...args)};
 closes.push(async()=>store.close());install(app,h,keys[0]);const first=input();expect(await call(app,first,'lost')).toMatchObject({code:'unavailable'});
 const before=intents(app);await app.close();store.close();store=await openHolderStore(holderRoot,identity,receipt);app=await open(root,clock);install(app,h,{active:keys[1],previous:[keys[0]]});
 expect(intents(app)).toEqual(before);expect(await call(app,first,'lost')).toMatchObject({ok:true});expect(h.set).toHaveBeenCalledTimes(1);
 const removal={name:'API',writeId:randomUUID()};expect(await call(app,removal,'remove',owner,'secrets.remove')).toMatchObject({ok:true});
 h.set.mockImplementation(async(...args)=>{await store.set(...args);});const next=input();expect(await call(app,next,'new')).toMatchObject({ok:true});
 await app.close();clock.advance(31*86400_000);app=await open(root,clock);install(app,h,{active:keys[2],previous:[keys[0],keys[1]]});
 expect(await call(app,removal,'remove',owner,'secrets.remove')).toMatchObject({ok:true});expect(h.remove).toHaveBeenCalledTimes(1);
 const bytes=await store.read('API');try{expect(Buffer.from(bytes).toString()).toBe(next.value);}finally{bytes.fill(0);}
});
it('requires all historical keys even with only completed writes; rejects malformed or duplicate material atomically',async()=>{
 const root=home(),h=fake();let app=await open(root);install(app,h,keys[0]);expect(await call(app,input(),'done')).toMatchObject({ok:true});await app.close();
 app=await open(root);install(app,h,{active:keys[1],previous:[keys[0]]});await app.close();
 for(const bad of [keys[0],keys[1],{active:keys[2],previous:[keys[0]]},{active:keys[2],previous:[keys[1]]},{active:keys[2],previous:[keys[0],keys[0],keys[1]]},{active:Buffer.alloc(31),previous:[keys[0],keys[1]]},null]){
  app=await open(root);const before=meta(app),rows=intents(app);
  expect(()=>install(app,h,bad as SecretRetryKeyMaterial)).toThrow('Secret retry key unavailable');expect(meta(app)).toEqual(before);expect(intents(app)).toEqual(rows);expect(app.operations.has('secrets.set')).toBe(false);await app.close();
 }
 app=await open(root);install(app,h,{active:keys[2],previous:[keys[1],keys[0]]});expect(app.operations.has('secrets.set')).toBe(true);
});
it('upgrades an existing v1-only binding without rewriting any old intent or core receipt',async()=>{
 const root=home(),h=fake(),body=input();let app=await open(root);install(app,h,keys[0]);expect(await call(app,body,'old')).toMatchObject({ok:true});
 app.db.prepare("DELETE FROM secrets_meta WHERE key='daemon-retry-keys-v1'").run();const before=intents(app),receipts=app.db.prepare('SELECT * FROM core_operations').all();await app.close();
 app=await open(root);const bindings=meta(app);expect(()=>install(app,h,keys[1])).toThrow('Secret retry key unavailable');expect(meta(app)).toEqual(bindings);expect(app.operations.has('secrets.set')).toBe(false);
 install(app,h,{active:keys[1],previous:[keys[0]]});expect(intents(app)).toEqual(before);expect(app.db.prepare('SELECT * FROM core_operations').all()).toEqual(receipts);
 expect(await call(app,body,'old')).toMatchObject({ok:true});expect(h.set).toHaveBeenCalledTimes(1);
});
it('loads a ring from explicit private files and refuses an unsafe historical file before binding or registration',async()=>{
 const root=home(),h=fake(),paths=keys.map((key,i)=>{const path=join(root,`key-${i}`);writeFileSync(path,key,{mode:0o600});return path;});
 let app=await open(root);installAsyncSecretValuesFromFile(app.db,app.operations,sharing,h,paths[0]);await app.close();
 app=await open(root);const before=meta(app);chmodSync(paths[0],0o640);
 expect(()=>installAsyncSecretValuesFromFile(app.db,app.operations,sharing,h,{active:paths[1],previous:[paths[0]]})).toThrow('Secret retry key unavailable');expect(meta(app)).toEqual(before);expect(app.operations.has('secrets.set')).toBe(false);
 chmodSync(paths[0],0o600);installAsyncSecretValuesFromFile(app.db,app.operations,sharing,h,{active:paths[1],previous:[paths[0]]});
 expect(await call(app,input(),'file')).toMatchObject({ok:true});for(const [i,path] of paths.entries())expect(readFileSync(path)).toEqual(keys[i]);
});

it('rolls back both initial binding and rotation if manifest persistence fails',async()=>{
 const root=home(),h=fake();let app=await open(root);
 app.db.exec("CREATE TRIGGER fail_ring BEFORE INSERT ON secrets_meta WHEN NEW.key='daemon-retry-keys-v1' BEGIN SELECT RAISE(ABORT,'synthetic'); END");
 expect(()=>install(app,h,keys[0])).toThrow('Secret retry key unavailable');expect(meta(app)).toEqual([]);expect(app.operations.has('secrets.set')).toBe(false);
 app.db.exec('DROP TRIGGER fail_ring');install(app,h,keys[0]);await app.close();app=await open(root);
 const before=meta(app);app.db.exec("CREATE TRIGGER fail_ring BEFORE UPDATE ON secrets_meta WHEN NEW.key='daemon-retry-keys-v1' BEGIN SELECT RAISE(ABORT,'synthetic'); END");
 expect(()=>install(app,h,{active:keys[1],previous:[keys[0]]})).toThrow('Secret retry key unavailable');expect(meta(app)).toEqual(before);expect(app.operations.has('secrets.set')).toBe(false);
 app.db.exec('DROP TRIGGER fail_ring');install(app,h,keys[0]);expect(app.operations.has('secrets.set')).toBe(true);
});
it('snapshots all supplied key buffers before the caller erases them',async()=>{
 const root=home(),h=fake(),active=Buffer.from(keys[1]),previous=Buffer.from(keys[0]),body=input();let app=await open(root);
 install(app,h,keys[0]);expect(await call(app,body,'old')).toMatchObject({ok:true});await app.close();app=await open(root);
 install(app,h,{active,previous:[previous]});active.fill(0);previous.fill(0);
 expect(await call(app,body,'old')).toMatchObject({ok:true});const next=input('NEXT');expect(await call(app,next,'new')).toMatchObject({ok:true});
 expect(app.db.prepare("SELECT input_hash FROM secrets_write_intents WHERE id='new'").get()).toEqual({input_hash:hash(keys[1],next)});
});

it.each(['not-json','null','{}','[]','[1]','["bad"]','duplicate','missing-original','missing-history'])('refuses malformed persisted history (%s) without changing bindings or registering values',async corruption=>{
 const root=home(),h=fake();let app=await open(root);install(app,h,keys[0]);await app.close();app=await open(root);install(app,h,{active:keys[1],previous:[keys[0]]});
 const original=(app.db.prepare("SELECT value FROM secrets_meta WHERE key='daemon-retry-key-v1'").get() as {value:string}).value;
 const verifiers=JSON.parse((app.db.prepare("SELECT value FROM secrets_meta WHERE key='daemon-retry-keys-v1'").get() as {value:string}).value) as string[];
 const changed=corruption==='duplicate'?JSON.stringify([...verifiers,verifiers[0]]):corruption==='missing-original'?JSON.stringify(verifiers.filter(v=>v!==original)):corruption==='missing-history'?JSON.stringify([...verifiers,'0'.repeat(64)]):corruption;
 app.db.prepare("UPDATE secrets_meta SET value=? WHERE key='daemon-retry-keys-v1'").run(changed);const before=meta(app);await app.close();app=await open(root);
 expect(()=>install(app,h,{active:keys[2],previous:[keys[1],keys[0]]})).toThrow('Secret retry key unavailable');expect(meta(app)).toEqual(before);expect(app.operations.has('secrets.set')).toBe(false);expect(app.operations.has('secrets.remove')).toBe(false);
});
it('can explicitly reactivate a retained key while preserving all history and old identities',async()=>{
 const root=home(),h=fake(),body=input();let app=await open(root);install(app,h,keys[0]);expect(await call(app,body,'old')).toMatchObject({ok:true});await app.close();
 app=await open(root);install(app,h,{active:keys[1],previous:[keys[0]]});const second=input('SECOND');expect(await call(app,second,'second')).toMatchObject({ok:true});const before=intents(app),bindings=meta(app);await app.close();
 app=await open(root);install(app,h,{active:keys[0],previous:[keys[1]]});expect(intents(app)).toEqual(before);expect(meta(app)).toEqual(bindings);expect(await call(app,second,'second')).toMatchObject({ok:true});
 const third=input('THIRD');expect(await call(app,third,'reactivated')).toMatchObject({ok:true});expect(app.db.prepare("SELECT input_hash FROM secrets_write_intents WHERE id='reactivated'").get()).toEqual({input_hash:hash(keys[0],third)});expect(h.set).toHaveBeenCalledTimes(3);
});
