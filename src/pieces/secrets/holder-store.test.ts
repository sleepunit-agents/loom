import { afterEach, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import { mkdtempSync, writeFileSync, readFileSync, readdirSync, rmSync, chmodSync, linkSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHmac, randomBytes, randomUUID } from 'node:crypto';
import { generateIdentity, Encrypter, Decrypter, identityToRecipient } from 'age-encryption';
import { openHolderStore, type HolderStore } from './holder-store.js';

vi.mock('node:crypto', async importOriginal => {
  const actual=await importOriginal<typeof import('node:crypto')>();
  return {...actual,randomUUID:vi.fn(actual.randomUUID)};
});
const homes: string[] = [], stores: HolderStore[] = [];
afterEach(() => { for (const s of stores.splice(0)) s.close(); for (const h of homes.splice(0)) rmSync(h, {recursive:true, force:true}); vi.restoreAllMocks(); });
const who = (member = 'jonathan') => ({member, writeId:randomUUID()});
const value = (text = 'HOLDER-STORE-VALUE-SENTINEL') => Buffer.from(text);
async function setup() {
  const home = mkdtempSync(join(tmpdir(), 'holder-store-')); homes.push(home);
  const identity = join(home, 'identity'), key = join(home, 'fingerprint-key');
  writeFileSync(identity, await generateIdentity(), {mode:0o600}); writeFileSync(key, randomBytes(32), {mode:0o600});
  const open = async () => { const s = await openHolderStore(home, identity, key); stores.push(s); return s; };
  return {home, identity, key, open, s:await open()};
}
async function text(s: HolderStore, name = 'api-key') {
  const b = await s.read(name); try {return Buffer.from(b).toString();} finally {b.fill(0);}
}

it('restarts with atomic receipts; old retries never overwrite a later replacement or remove a re-addition', async () => {
  const f = await setup(); let s = f.s;
  const add = who(), replace = who(), remove = who();
  await s.set(add, 'api-key', value(), 'add'); s.close(); s = await f.open();
  await s.set(add, 'api-key', value(), 'add'); expect(await text(s)).toBe(value().toString());
  await s.set(replace, 'api-key', value('replacement'), 'replace');
  await s.set(add, 'api-key', value(), 'add'); expect(await text(s)).toBe('replacement');
  s.remove(remove, 'api-key'); s.close(); s = await f.open();
  s.remove(remove, 'api-key'); await expect(s.read('api-key')).rejects.toThrow('Secret holder storage unavailable');
  await s.set(who(), 'api-key', value('new'), 'add'); s.remove(remove, 'api-key');
  expect(await text(s)).toBe('new');
  await s.set(replace, 'api-key', value('replacement'), 'replace'); expect(await text(s)).toBe('new');
});
it('binds full input, action and member, independent of registry operation IDs', async () => {
  const {s} = await setup(), id = who();
  await s.set(id, 'api-key', value(), 'add');
  for (const [name, bytes, mode] of [
    ['other', value(), 'add'], ['api-key', value('changed'), 'add'], ['api-key', value(), 'replace'],
  ] as const) await expect(s.set(id, name, bytes, mode)).rejects.toThrow(/^Secret holder storage unavailable$/);
  expect(() => s.remove(id, 'api-key')).toThrow(/^Secret holder storage unavailable$/);
  // Same UUID from a different authenticated member is a distinct operation.
  await s.set({...id,member:'amelia'}, 'api-key', value('other-member'), 'replace');
  expect(await text(s)).toBe('other-member');
  const remove = who(); s.remove(remove, 'api-key');
  expect(() => s.remove(remove, 'other')).toThrow();
  await expect(s.set(remove, 'api-key', value(), 'add')).rejects.toThrow();
});
it('rolls back ciphertext and receipt together on storage failure, then permits the exact retry', async () => {
  const {s, home} = await setup(), id = who();
  const db = new Database(join(home, 'holder.db'));
  try {
    db.exec("CREATE TRIGGER fail_receipt BEFORE INSERT ON holder_receipts BEGIN SELECT RAISE(ABORT, 'PRIVATE-ERROR'); END");
    await expect(s.set(id, 'api-key', value(), 'add')).rejects.toThrow(/^Secret holder storage unavailable$/);
    expect(db.prepare('SELECT * FROM holder_values').all()).toEqual([]);
    expect(db.prepare('SELECT * FROM holder_receipts').all()).toEqual([]);
    db.exec('DROP TRIGGER fail_receipt'); await s.set(id, 'api-key', value(), 'add');
    db.exec("CREATE TRIGGER fail_receipt BEFORE INSERT ON holder_receipts BEGIN SELECT RAISE(ABORT, 'PRIVATE-ERROR'); END");
    const remove = who(); expect(() => s.remove(remove, 'api-key')).toThrow(/^Secret holder storage unavailable$/);
    expect(await text(s)).toBe(value().toString());
    expect(db.prepare('SELECT count(*) AS n FROM holder_receipts').get()).toEqual({n:1});
    db.exec('DROP TRIGGER fail_receipt'); s.remove(remove, 'api-key');
    expect(db.prepare('SELECT * FROM holder_values').all()).toEqual([]);
  } finally {db.close();}
});
it('snapshots caller input before awaiting and resolves concurrent identical writes only once across handles', async () => {
  const f = await setup(), other = await f.open(), id = who(), input = value();
  const original=Encrypter.prototype.encrypt;
  let release!:()=>void;const gate=new Promise<void>(resolve=>{release=resolve;});
  vi.spyOn(Encrypter.prototype,'encrypt')
    .mockImplementationOnce(function(this:Encrypter,bytes:Uint8Array|string){return original.call(this,bytes);})
    .mockImplementationOnce(async function(this:Encrypter,bytes:Uint8Array|string){await gate;return original.call(this,bytes);});
  const caller = {...id}; const first = f.s.set(caller, 'api-key', input, 'add');
  input.fill(0); caller.member = 'changed'; caller.writeId = randomUUID();
  const second=other.set(id,'api-key',value(),'add');
  await first;const committed=f.s.generation();release();await second;
  expect(other.generation()).toBe(committed);
  expect(await text(f.s)).toBe(value().toString());
  const db = new Database(join(f.home, 'holder.db'));
  try {expect(db.prepare('SELECT member,write_id FROM holder_receipts').all()).toEqual([{member:id.member,write_id:id.writeId}]);}
  finally {db.close();}
});
it('keeps plaintext out of disk, receipts and console output on success and failure; erases its input copy', async () => {
  const {s,home} = await setup();
  const logs = [vi.spyOn(console,'log'),vi.spyOn(console,'error'),vi.spyOn(console,'warn')];
  const encrypt = vi.spyOn(Encrypter.prototype,'encrypt'); const input=value();
  await s.set(who(), 'api-key', input, 'add');
  const owned = encrypt.mock.calls[0][0] as Uint8Array;
  expect(owned).not.toBe(input); expect([...owned].every(n=>n===0)).toBe(true);
  expect(input.toString()).toBe(value().toString());
  await expect(s.set(who(), 'api-key', value(), 'add')).rejects.toThrow();
  expect(logs.flatMap(l=>l.mock.calls)).toEqual([]);
  for (const file of readdirSync(home)) expect(readFileSync(join(home,file)).includes(value())).toBe(false);
  s.close(); for (const file of readdirSync(home)) expect(readFileSync(join(home,file)).includes(value())).toBe(false);
});
it('enforces add/replace, input limits and close without retaining successful receipts for failed operations', async () => {
  const {s} = await setup();
  await expect(s.set(who(), 'missing', value(), 'replace')).rejects.toThrow();
  for(const bytes of [Buffer.alloc(0),Buffer.alloc(65537)]) await expect(s.set(who(), 'api-key', bytes, 'add')).rejects.toThrow();
  await expect(s.set(who(), '../bad', value(), 'add')).rejects.toThrow();
  await expect(s.set({...who(),writeId:'bad'}, 'api-key', value(), 'add')).rejects.toThrow();
  const max=Buffer.alloc(65536,65); await s.set(who(), 'api-key', max, 'add');
  const read=await s.read('api-key');expect(Buffer.from(read)).toEqual(max);read.fill(0);
  s.close();s.close(); await expect(s.read('api-key')).rejects.toThrow();
  await expect(s.set(who(),'api-key',value(),'add')).rejects.toThrow();expect(()=>s.remove(who(),'api-key')).toThrow();
});
it('refuses changed identity or fingerprint key on restart', async () => {
  const f=await setup();await f.s.set(who(),'api-key',value(),'add');f.s.close();
  const key=readFileSync(f.key), identity=readFileSync(f.identity);
  writeFileSync(f.key,randomBytes(32));await expect(f.open()).rejects.toThrow();writeFileSync(f.key,key);
  writeFileSync(f.identity,await generateIdentity());await expect(f.open()).rejects.toThrow();writeFileSync(f.identity,identity);
  expect(await text(await f.open())).toBe(value().toString());
});
it('rejects oversized age payload before decrypt and clears owned input on encryption failure', async () => {
  const f=await setup();
  const encrypt=new Encrypter();encrypt.addRecipient(await identityToRecipient(readFileSync(f.identity,'utf8')));
  const oversized=await encrypt.encrypt(Buffer.alloc(65537,65));
  const db=new Database(join(f.home,'holder.db'));
  try {db.prepare('INSERT INTO holder_values VALUES (?,?)').run('oversized',oversized);} finally {db.close();}
  const decrypt=vi.spyOn(Decrypter.prototype,'decrypt');
  await expect(f.s.read('oversized')).rejects.toThrow();expect(decrypt).not.toHaveBeenCalled();
  let owned:Uint8Array|undefined;
  vi.spyOn(Encrypter.prototype,'encrypt').mockImplementationOnce(async bytes=>{owned=bytes as Uint8Array;throw Error(value().toString());});
  await expect(f.s.set(who(),'api-key',value(),'add')).rejects.toThrow(/^Secret holder storage unavailable$/);
  expect(owned).toBeDefined();expect([...owned!].every(n=>n===0)).toBe(true);
});
it('erases decrypted plaintext when the holder closes before an awaited read resumes', async () => {
  const {s}=await setup();await s.set(who(),'api-key',value(),'add');
  let complete!:(bytes:Uint8Array)=>void;
  const pending=new Promise<Uint8Array>(resolve=>{complete=resolve;});
  const decrypt=vi.spyOn(Decrypter.prototype,'decrypt').mockReturnValueOnce(pending);
  const read=s.read('api-key');expect(decrypt).toHaveBeenCalledOnce();
  s.close();const bytes=value();complete(bytes);
  await expect(read).rejects.toThrow(/^Secret holder storage unavailable$/);
  expect([...bytes].every(n=>n===0)).toBe(true);
});
it('refuses public, symlinked or hardlinked database files and public key or directory', async () => {
  const f=await setup();f.s.close();const path=join(f.home,'holder.db');
  chmodSync(path,0o644);await expect(f.open()).rejects.toThrow(/^Secret holder storage unavailable$/);chmodSync(path,0o600);
  const link=join(f.home,'db-link');linkSync(path,link);await expect(f.open()).rejects.toThrow();rmSync(link);
  const saved=readFileSync(path);rmSync(path);writeFileSync(link,saved,{mode:0o600});symlinkSync(link,path);
  await expect(f.open()).rejects.toThrow();rmSync(path);writeFileSync(path,saved,{mode:0o600});
  chmodSync(f.key,0o644);await expect(f.open()).rejects.toThrow();chmodSync(f.key,0o600);
  chmodSync(f.home,0o755);await expect(f.open()).rejects.toThrow();chmodSync(f.home,0o700);
});
it('sets effective FULL durability even if the connection starts at NORMAL', async () => {
  const original=Database.prototype.pragma;
  let connection:Database.Database|undefined;
  vi.spyOn(Database.prototype,'pragma').mockImplementation(function(this:Database.Database,source:string,options?:Database.PragmaOptions) {
    const result=original.call(this,source,options); connection=this;
    // Emulate a different connection default; the holder must explicitly reset it.
    if(source==='journal_mode = WAL') original.call(this,'synchronous = NORMAL');
    return result;
  });
  await setup();
  expect(connection).toBeDefined();expect(original.call(connection!,'synchronous',{simple:true})).toBe(2);
});
it('stores a keyed full-input fingerprint, independently calculated from the separate key', async () => {
  const f=await setup(), id=who();await f.s.set(id,'api-key',value(),'add');
  const expected=createHmac('sha256',readFileSync(f.key))
    .update(JSON.stringify([1,id.member,id.writeId,'set','api-key','add'])).update(value()).digest('hex');
  const db=new Database(join(f.home,'holder.db'));
  try {expect(db.prepare('SELECT fingerprint FROM holder_receipts').get()).toEqual({fingerprint:expected});}
  finally {db.close();}
});
it.each(['-wal','-shm','-journal'])('refuses unsafe existing %s sidecars before SQLite opens them', async suffix => {
  const f=await setup();f.s.close();const side=join(f.home,'holder.db'+suffix), target=join(f.home,'side-target');
  writeFileSync(side,'UNSAFE',{mode:0o644});await expect(f.open()).rejects.toThrow();rmSync(side);
  writeFileSync(target,'UNSAFE',{mode:0o600});symlinkSync(target,side);await expect(f.open()).rejects.toThrow();rmSync(side);
  linkSync(target,side);await expect(f.open()).rejects.toThrow();rmSync(side);rmSync(target);
  const reopened=await f.open();await reopened.set(who(),'api-key',value(),'add');expect(await text(reopened)).toBe(value().toString());
});
it('checks add/replace existence inside the transaction after gated encryption races', async () => {
  const f=await setup(), other=await f.open();const original=Encrypter.prototype.encrypt;
  let release!:()=>void; const gate=new Promise<void>(resolve=>{release=resolve;});
  vi.spyOn(Encrypter.prototype,'encrypt').mockImplementationOnce(async function(this:Encrypter,bytes:Uint8Array|string){
    await gate;return original.call(this,bytes);
  });
  const delayed=f.s.set(who(),'api-key',value('late'),'add');
  await other.set(who(),'api-key',value('first'),'add');release();
  await expect(delayed).rejects.toThrow();expect(await text(f.s)).toBe('first');
  let resume!:()=>void;const next=new Promise<void>(resolve=>{resume=resolve;});
  vi.spyOn(Encrypter.prototype,'encrypt').mockImplementationOnce(async function(this:Encrypter,bytes:Uint8Array|string){
    await next;return original.call(this,bytes);
  });
  const replacement=f.s.set(who(),'api-key',value('late-replace'),'replace');
  other.remove(who(),'api-key');resume();await expect(replacement).rejects.toThrow();
  await expect(f.s.read('api-key')).rejects.toThrow();
});

it('reports only committed member/id receipts across restart, rollback and later writes', async () => {
  const f=await setup(),add=who(),remove=who(),failed=who();
  expect(f.s.hasReceipt(add)).toBe(false);
  await f.s.set(add,'api-key',value(),'add');
  expect(f.s.hasReceipt(add)).toBe(true);
  expect(f.s.hasReceipt({...add,member:'another-member'})).toBe(false);
  await expect(f.s.set(failed,'api-key',value(),'add')).rejects.toThrow();
  expect(f.s.hasReceipt(failed)).toBe(false);
  const db=new Database(join(f.home,'holder.db'));
  try {
    db.exec("CREATE TRIGGER fail_receipt BEFORE INSERT ON holder_receipts BEGIN SELECT RAISE(ABORT, 'PRIVATE'); END");
    expect(()=>f.s.remove(remove,'api-key')).toThrow();expect(f.s.hasReceipt(remove)).toBe(false);
    db.exec('DROP TRIGGER fail_receipt');f.s.remove(remove,'api-key');
  } finally {db.close();}
  f.s.close();const restarted=await f.open();
  await restarted.set(who(),'api-key',value('new'),'add');
  const decrypt=vi.spyOn(Decrypter.prototype,'decrypt');
  expect(restarted.hasReceipt(add)).toBe(true);expect(restarted.hasReceipt(remove)).toBe(true);
  expect(restarted.hasReceipt(who())).toBe(false);expect(decrypt).not.toHaveBeenCalled();
  expect(()=>restarted.hasReceipt({...add,writeId:'invalid'})).toThrow(/^Secret holder storage unavailable$/);
  restarted.close();expect(()=>restarted.hasReceipt(add)).toThrow(/^Secret holder storage unavailable$/);
});
it('an absent receipt does not rule out a concurrently encrypting write committing later', async () => {
  const f=await setup(),other=await f.open(),id=who(),encrypt=Encrypter.prototype.encrypt;
  let resume!:()=>void;const gate=new Promise<void>(resolve=>{resume=resolve;});
  vi.spyOn(Encrypter.prototype,'encrypt').mockImplementationOnce(async function(this:Encrypter,bytes:Uint8Array|string){await gate;return encrypt.call(this,bytes);});
  const pending=f.s.set(id,'api-key',value(),'add');
  expect(other.hasReceipt(id)).toBe(false);resume();await pending;
  expect(other.hasReceipt(id)).toBe(true);expect(await text(other)).toBe(value().toString());
});

it('publishes an independent durable generation only when a mutation commits', async () => {
  const f=await setup(), add=who(), remove=who();
  const initial=f.s.generation();expect(initial).toMatch(/^[0-9a-f-]{36}$/);
  const decrypt=vi.spyOn(Decrypter.prototype,'decrypt');
  const other=await f.open();expect(other.generation()).toBe(initial);
  await f.s.set(add,'api-key',value(),'add');
  const added=f.s.generation();expect(added).not.toBe(initial);expect(other.generation()).toBe(added);
  await f.s.set(add,'api-key',value(),'add');expect(f.s.generation()).toBe(added);
  await expect(f.s.set(who(),'api-key',value(),'add')).rejects.toThrow();expect(f.s.generation()).toBe(added);
  // Replacing with identical bytes still ends the previous receiving lifetime.
  await f.s.set(who(),'api-key',value(),'replace');const replaced=f.s.generation();expect(replaced).not.toBe(added);
  const db=new Database(join(f.home,'holder.db'));
  try {
    db.exec("CREATE TRIGGER fail_receipt BEFORE INSERT ON holder_receipts BEGIN SELECT RAISE(ABORT, 'PRIVATE'); END");
    expect(()=>f.s.remove(remove,'api-key')).toThrow();expect(f.s.generation()).toBe(replaced);
    await expect(f.s.set(who(),'api-key',value('new'),'replace')).rejects.toThrow();expect(f.s.generation()).toBe(replaced);
    db.exec('DROP TRIGGER fail_receipt');
  } finally {db.close();}
  f.s.remove(remove,'api-key');const removed=f.s.generation();expect(removed).not.toBe(replaced);
  f.s.remove(remove,'api-key');expect(f.s.generation()).toBe(removed);
  f.s.close();expect(()=>f.s.generation()).toThrow(/^Secret holder storage unavailable$/);
  const restarted=await f.open();expect(restarted.generation()).toBe(removed);
  await restarted.set(who(),'api-key',value(),'add');expect(restarted.generation()).not.toBe(removed);
  expect(decrypt).not.toHaveBeenCalled();
});
it('initializes generation for an existing holder without rewriting values or receipts', async () => {
  const f=await setup(),id=who();await f.s.set(id,'api-key',value(),'add');f.s.close();
  const db=new Database(join(f.home,'holder.db'));
  const values=db.prepare('SELECT * FROM holder_values').all(),receipts=db.prepare('SELECT * FROM holder_receipts').all();
  db.exec('DROP TABLE holder_generation');db.close();
  const s=await f.open();expect(s.generation()).toMatch(/^[0-9a-f-]{36}$/);
  const verify=new Database(join(f.home,'holder.db'));
  try {
    expect(verify.prepare('SELECT * FROM holder_values').all()).toEqual(values);
    expect(verify.prepare('SELECT * FROM holder_receipts').all()).toEqual(receipts);
  } finally {verify.close();}
  expect(await text(s)).toBe(value().toString());
});

it('rolls back values and receipts when generation publication fails', async () => {
  const f=await setup();await f.s.set(who(),'api-key',value(),'add');
  const marker=f.s.generation(), db=new Database(join(f.home,'holder.db'));
  const values=db.prepare('SELECT * FROM holder_values').all(),receipts=db.prepare('SELECT * FROM holder_receipts').all();
  try {
    db.exec("CREATE TRIGGER fail_generation BEFORE UPDATE ON holder_generation BEGIN SELECT RAISE(ABORT, 'PRIVATE'); END");
    await expect(f.s.set(who(),'api-key',value('new'),'replace')).rejects.toThrow();
    await expect(f.s.set(who(),'other',value(),'add')).rejects.toThrow();
    expect(()=>f.s.remove(who(),'api-key')).toThrow();
    expect(f.s.generation()).toBe(marker);
    expect(db.prepare('SELECT * FROM holder_values').all()).toEqual(values);
    expect(db.prepare('SELECT * FROM holder_receipts').all()).toEqual(receipts);
  } finally {db.close();}
});
it('stores the independently generated random UUID rather than a value-derived marker', async () => {
  const first='12345678-1234-4234-8234-123456789abc',second='87654321-4321-4321-8321-cba987654321';
  const random=vi.mocked(randomUUID).mockReturnValueOnce(first);
  const f=await setup();expect(f.s.generation()).toBe(first);
  const id=who();random.mockReturnValueOnce(second);
  await f.s.set(id,'api-key',value(),'add');expect(f.s.generation()).toBe(second);
});
