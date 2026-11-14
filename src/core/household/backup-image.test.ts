import { afterEach, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import { Decrypter, Encrypter, generateX25519Identity, identityToRecipient } from 'age-encryption';
import { encryptDatabaseImage } from './backup-image.js';
import { registerExportFilter } from '../db/export.js';

const closers: (() => void)[] = [];
afterEach(() => { vi.restoreAllMocks(); for (const close of closers.splice(0).reverse()) close(); });
function source() {
  const db = new Database(':memory:'); closers.push(() => db.close());
  db.exec("CREATE TABLE core_migrations(piece TEXT, number INTEGER, sql TEXT); CREATE TABLE records(id INTEGER PRIMARY KEY, words TEXT, bytes BLOB); CREATE TABLE comms_words(words TEXT); INSERT INTO comms_words VALUES ('COMMS_SECRET');");
  db.prepare('INSERT INTO records VALUES (?,?,?)').run(7,'SURVIVING_WORDS',Buffer.from([0,255,1]));
  db.prepare('INSERT INTO records VALUES (?,?,?)').run(8,'FILTERED_WORDS',null);
  registerExportFilter(db,'fixture',(table,row) => table !== 'records' || row.id === 7);
  return db;
}
async function keys() {
  const owner = await generateX25519Identity(), drill = await generateX25519Identity();
  return { owner, drill, recipient: await identityToRecipient(owner) };
}
it('encrypts only filtered fresh pages; independent owner and drill can restore actual ciphertext', async () => {
  const db=source(), original=db.serialize(), k=await keys();
  const result=await encryptDatabaseImage(db,[k.recipient,k.recipient],k.drill);
  expect(db.serialize()).toEqual(original);
  expect(result).toMatchObject({coverage:'database-only',drill:{database:true}});
  expect(result.bytes.toString('ascii',0,21)).toBe('age-encryption.org/v1');
  for (const word of ['SURVIVING_WORDS','FILTERED_WORDS','COMMS_SECRET',k.owner,k.drill]) expect(result.bytes.includes(Buffer.from(word))).toBe(false);
  for (const identity of [k.owner,k.drill]) {
    const decrypt=new Decrypter(); decrypt.addIdentity(identity);
    const plain=await decrypt.decrypt(result.bytes);
    expect(Buffer.from(plain).includes(Buffer.from('COMMS_SECRET'))).toBe(false);
    expect(Buffer.from(plain).includes(Buffer.from('FILTERED_WORDS'))).toBe(false);
    const restored=new Database(Buffer.from(plain)); closers.push(()=>restored.close());
    expect(restored.prepare('SELECT * FROM records').all()).toEqual([{id:7,words:'SURVIVING_WORDS',bytes:Buffer.from([0,255,1])}]);
    expect(restored.prepare("SELECT name FROM sqlite_master WHERE name LIKE 'comms_%'").all()).toEqual([]);
    expect(restored.pragma('integrity_check',{simple:true})).toBe('ok');
    plain.fill(0);
  }
  const wrong=new Decrypter(); wrong.addIdentity(await generateX25519Identity());
  await expect(wrong.decrypt(result.bytes)).rejects.toThrow();
});
it('refuses missing/invalid/SSH/drill-only recipients, bad identity and a missing owning filter without echoing inputs', async () => {
  const db=source(), k=await keys();
  for (const recipients of [[],['BAD_SECRET'],['ssh-ed25519 AAAA'],[await identityToRecipient(k.drill)],[...Array(101)].map(()=>k.recipient)]) {
    await expect(encryptDatabaseImage(db,recipients,k.drill)).rejects.toThrow('Encrypted database export or restore drill failed');
  }
  await expect(encryptDatabaseImage(db,[k.recipient],'PRIVATE_IDENTITY_SENTINEL')).rejects.toThrow(/^Encrypted database export or restore drill failed$/);
  const reopened=new Database(db.serialize()); closers.push(()=>reopened.close());
  await expect(encryptDatabaseImage(reopened,[k.recipient],k.drill)).rejects.toThrow(/^Encrypted database export or restore drill failed$/);
});
it('refuses encryption failure, failed decryption and changed plaintext, and clears owned plaintext buffers', async () => {
  const db=source(), k=await keys(); let owned: Uint8Array | undefined;
  const encrypt=vi.spyOn(Encrypter.prototype,'encrypt').mockImplementationOnce(async bytes=>{owned=bytes as Uint8Array;throw Error('CRYPTO_SECRET');});
  await expect(encryptDatabaseImage(db,[k.recipient],k.drill)).rejects.toThrow(/^Encrypted database export or restore drill failed$/);
  expect(owned?.length).toBeGreaterThan(0); expect(owned?.every(byte=>byte===0)).toBe(true);
  encrypt.mockRestore();
  const decrypt=vi.spyOn(Decrypter.prototype,'decrypt').mockRejectedValueOnce(Error('PRIVATE_DIAGNOSTIC'));
  await expect(encryptDatabaseImage(db,[k.recipient],k.drill)).rejects.toThrow(/^Encrypted database export or restore drill failed$/);
  const corrupted=Buffer.from('WRONG_PLAINTEXT'); decrypt.mockResolvedValueOnce(corrupted);
  await expect(encryptDatabaseImage(db,[k.recipient],k.drill)).rejects.toThrow(/^Encrypted database export or restore drill failed$/);
  expect(corrupted.every(byte=>byte===0)).toBe(true);
});
it('clears encryption and decryption plaintext on success without clearing returned ciphertext', async () => {
  const db=source(), k=await keys(); let captured:Uint8Array|undefined,opened:Uint8Array|undefined;
  const encrypt=Encrypter.prototype.encrypt, decrypt=Decrypter.prototype.decrypt;
  vi.spyOn(Encrypter.prototype,'encrypt').mockImplementation(async function(this:Encrypter,bytes){captured=bytes as Uint8Array;return encrypt.call(this,bytes);});
  vi.spyOn(Decrypter.prototype,'decrypt').mockImplementation(async function(this:Decrypter,bytes){opened=await decrypt.call(this,bytes);return opened;});
  const result=await encryptDatabaseImage(db,[k.recipient],k.drill);
  expect(captured?.length).toBeGreaterThan(0); expect(captured?.every(byte=>byte===0)).toBe(true);
  expect(opened?.length).toBeGreaterThan(0); expect(opened?.every(byte=>byte===0)).toBe(true);
  expect(result.bytes.some(byte=>byte!==0)).toBe(true);
});
