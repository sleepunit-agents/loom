import {afterEach,expect,it,vi} from 'vitest';
import Database from 'better-sqlite3';
import {mkdtempSync,mkdirSync,rmSync,writeFileSync,readFileSync,chmodSync,readdirSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createHmac,randomUUID} from 'node:crypto';
import {generateIdentity,Decrypter} from 'age-encryption';
import {startLoom} from '../../foundation.js';
import {fixture} from '../../fixture.js';
import {FakeClock} from '../../core/index.js';
import {openHolderStore,type HolderStore,type RetainedHolderKeys} from './holder-store.js';
const roots:string[]=[],closes:(()=>Promise<void>)[]=[];
afterEach(async()=>{for(const close of closes.splice(0).reverse())await close();for(const root of roots.splice(0))rmSync(root,{recursive:true,force:true});vi.restoreAllMocks();});
const sentinel='SYNTHETIC-HOLDER-ROTATION-VALUE';
const who=()=>({member:'jonathan',writeId:randomUUID()});
async function setup(){
 const home=mkdtempSync(join(tmpdir(),'holder-rotation-'));roots.push(home);fixture(home);
 const app=await startLoom({home,next:true,staging:true,clock:new FakeClock(),stdout:()=>{}});closes.push(app.close);
 const directory=join(home,'holder');mkdirSync(directory,{mode:0o700});
 const identities:string[]=[],keys:string[]=[];
 for(let i=0;i<3;i++){
  identities.push(join(home,`identity-${i}`));keys.push(join(home,`key-${i}`));
  writeFileSync(identities[i],await generateIdentity(),{mode:0o600});writeFileSync(keys[i],Buffer.alloc(32,71+i),{mode:0o600});
 }
 const open=async(i=0,previous:RetainedHolderKeys={})=>{const s=await openHolderStore(directory,identities[i],keys[i],previous);closes.push(async()=>s.close());return s;};
 return {home,app,directory,identities,keys,open};
}
async function text(s:HolderStore,name='API'){const bytes=await s.read(name);try{return Buffer.from(bytes).toString();}finally{bytes.fill(0);}}
function snapshot(directory:string){const db=new Database(join(directory,'holder.db'));try{return Object.fromEntries((db.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all() as {name:string}[]).map(({name})=>[name,db.prepare(`SELECT * FROM "${name}"`).all()]));}finally{db.close();}}
it('preserves old ciphertext, receipts and generation through two rotations; fresh writes use the active pair',async()=>{
 const f=await setup(),add=who(),replace=who(),remove=who();let s=await f.open();
 await s.set(add,'API',Buffer.from(sentinel),'add');const old=snapshot(f.directory),generation=s.generation();s.close();
 s=await f.open(1,{identities:[f.identities[0]],fingerprintKeys:[f.keys[0]]});
 const rotated=snapshot(f.directory);for(const table of ['holder_values','holder_receipts','holder_config','holder_generation'])expect(rotated[table]).toEqual(old[table]);
 expect(s.generation()).toBe(generation);expect(await text(s)).toBe(sentinel);
 await s.set(replace,'API',Buffer.from('NEW'),'replace');const replaced=s.generation();
 await s.set(add,'API',Buffer.from(sentinel),'add');expect(s.generation()).toBe(replaced);expect(await text(s)).toBe('NEW');
 await expect(s.set({...add},'API',Buffer.from('WRONG'),'add')).rejects.toThrow(/^Secret holder storage unavailable$/);
 expect(()=>s.remove(add,'API')).toThrow();s.remove(remove,'API');await s.set(who(),'API',Buffer.from('LATEST'),'add');
 const before=snapshot(f.directory);s.close();
 s=await f.open(2,{identities:[f.identities[0],f.identities[1]],fingerprintKeys:[f.keys[1],f.keys[0]]});
 expect(s.hasReceipt(add)).toBe(true);expect(s.hasReceipt(remove)).toBe(true);expect(s.hasReceipt({...add,member:'dana'})).toBe(false);
 await s.set(add,'API',Buffer.from(sentinel),'add');s.remove(remove,'API');expect(await text(s)).toBe('LATEST');
 expect(snapshot(f.directory).holder_receipts).toEqual(before.holder_receipts);
 const fresh=who();await s.set(fresh,'THIRD',Buffer.from(sentinel),'add');
 const expected=createHmac('sha256',readFileSync(f.keys[2])).update(JSON.stringify([1,fresh.member,fresh.writeId,'set','THIRD','add'])).update(sentinel).digest('hex');
 const db=new Database(join(f.directory,'holder.db'));try{
  expect(db.prepare('SELECT fingerprint FROM holder_receipts WHERE write_id=?').get(fresh.writeId)).toEqual({fingerprint:expected});
  const row=db.prepare("SELECT ciphertext FROM holder_values WHERE name='THIRD'").get() as {ciphertext:Buffer};
  const active=new Decrypter();active.addIdentity(readFileSync(f.identities[2],'utf8'));const bytes=await active.decrypt(row.ciphertext);expect(Buffer.from(bytes).toString()).toBe(sentinel);bytes.fill(0);
  const retired=new Decrypter();retired.addIdentity(readFileSync(f.identities[0],'utf8'));await expect(retired.decrypt(row.ciphertext)).rejects.toThrow();
 }finally{db.close();}
 const logs=[vi.spyOn(console,'log'),vi.spyOn(console,'warn'),vi.spyOn(console,'error')];await expect(s.set(add,'API',Buffer.from(sentinel+'bad'),'add')).rejects.toThrow(/^Secret holder storage unavailable$/);
 expect(logs.flatMap(l=>l.mock.calls)).toEqual([]);s.close();
 for(const file of readdirSync(f.directory))expect(readFileSync(join(f.directory,file)).includes(sentinel)).toBe(false);
 for(const {name} of f.app.db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as {name:string}[])expect(JSON.stringify(f.app.db.prepare(`SELECT * FROM "${name}"`).all())).not.toContain(sentinel);
});
it('requires every historically used identity and key, even without values; omission never changes state',async()=>{
 const f=await setup();let s=await f.open();await s.set(who(),'API',Buffer.from(sentinel),'add');s.remove(who(),'API');s.close();
 s=await f.open(1,{identities:[f.identities[0]],fingerprintKeys:[f.keys[0]]});s.close();const before=snapshot(f.directory);
 for(const previous of [{},{identities:[f.identities[0]]},{fingerprintKeys:[f.keys[0]]},
  {identities:[f.identities[0],f.identities[1]],fingerprintKeys:[f.keys[0]]},
  {identities:[f.identities[0]],fingerprintKeys:[f.keys[0],f.keys[1]]}]){
  await expect(f.open(2,previous)).rejects.toThrow(/^Secret holder storage unavailable$/);expect(snapshot(f.directory)).toEqual(before);
 }
 s=await f.open(2,{identities:[f.identities[0],f.identities[1]],fingerprintKeys:[f.keys[0],f.keys[1]]});expect(s.generation()).toEqual((before.holder_generation as {generation:string}[])[0].generation);
});
it('upgrades v1-only bindings atomically and permits explicit reactivation with the complete history',async()=>{
 const f=await setup(),add=who();let s=await f.open();await s.set(add,'API',Buffer.from(sentinel),'add');s.close();
 let db=new Database(join(f.directory,'holder.db'));db.exec('DROP TABLE holder_key_history');db.close();const before=snapshot(f.directory);
 await expect(f.open(1)).rejects.toThrow();expect(snapshot(f.directory)).toEqual(before);
 s=await f.open(1,{identities:[f.identities[0]],fingerprintKeys:[f.keys[0]]});s.close();
 s=await f.open(0,{identities:[f.identities[1]],fingerprintKeys:[f.keys[1]]});await s.set(add,'API',Buffer.from(sentinel),'add');expect(await text(s)).toBe(sentinel);
 const fresh=who();await s.set(fresh,'OTHER',Buffer.from('OLD-ACTIVE'),'add');
 db=new Database(join(f.directory,'holder.db'));try{expect(db.prepare('SELECT fingerprint FROM holder_receipts WHERE write_id=?').get(fresh.writeId)).toEqual({fingerprint:createHmac('sha256',readFileSync(f.keys[0])).update(JSON.stringify([1,fresh.member,fresh.writeId,'set','OTHER','add'])).update('OLD-ACTIVE').digest('hex')});}finally{db.close();}
});
it('refuses duplicate or unsafe retained material before touching storage',async()=>{
 const f=await setup();const s=await f.open();s.close();const before=snapshot(f.directory);
 for(const previous of [{identities:[f.identities[0]]},{fingerprintKeys:[f.keys[0]]}]){await expect(f.open(0,previous)).rejects.toThrow();expect(snapshot(f.directory)).toEqual(before);}
 chmodSync(f.keys[0],0o644);await expect(f.open(1,{identities:[f.identities[0]],fingerprintKeys:[f.keys[0]]})).rejects.toThrow();chmodSync(f.keys[0],0o600);expect(snapshot(f.directory)).toEqual(before);
 chmodSync(f.identities[0],0o644);await expect(f.open(1,{identities:[f.identities[0]],fingerprintKeys:[f.keys[0]]})).rejects.toThrow();chmodSync(f.identities[0],0o600);expect(snapshot(f.directory)).toEqual(before);
});
it('refuses malformed or inconsistent history and rolls back a failed rotation',async()=>{
 const f=await setup();const s=await f.open();s.close();const db=new Database(join(f.directory,'holder.db'));
 try{
  const old=(db.prepare('SELECT bindings FROM holder_key_history').get() as {bindings:string}).bindings;
  for(const raw of ['bad','{}','[]','["invalid"]',JSON.stringify(['0'.repeat(64)]),JSON.stringify([...JSON.parse(old),...JSON.parse(old)])]){
   db.prepare('UPDATE holder_key_history SET bindings=?').run(raw);const before=snapshot(f.directory);await expect(f.open()).rejects.toThrow();expect(snapshot(f.directory)).toEqual(before);
  }
  db.prepare('UPDATE holder_key_history SET bindings=?').run(old);const before=snapshot(f.directory);
  db.exec("CREATE TRIGGER fail_rotation BEFORE UPDATE ON holder_key_history BEGIN SELECT RAISE(ABORT,'PRIVATE'); END");
  await expect(f.open(1,{identities:[f.identities[0]],fingerprintKeys:[f.keys[0]]})).rejects.toThrow(/^Secret holder storage unavailable$/);expect(snapshot(f.directory)).toEqual(before);
  db.exec('DROP TRIGGER fail_rotation');const restored=await f.open();expect(restored.generation()).toBeDefined();
 }finally{db.close();}
});
