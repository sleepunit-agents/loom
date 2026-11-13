/** Only the age library: no program, plaintext cache, or logged crypto error. */
import { Encrypter, Decrypter, generateX25519Identity, identityToRecipient } from 'age-encryption';
import { constants, closeSync, fstatSync, openSync, readFileSync, writeFileSync, fsyncSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { createHmac } from 'node:crypto';
export interface WordsKey {
 seal(words: string): Promise<Buffer>;
 open(blob: Uint8Array): Promise<string>;
 hash(words: string): string;
}
export function readKey(path: string): string {
 const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
 try {
  const stat = fstatSync(fd);
  if (!stat.isFile() || (stat.mode & 0o077)) throw new Error('Comms key must be a private regular file');
  const identities = readFileSync(fd, 'utf8').split('\n').map(s => s.trim()).filter(s => s.startsWith('AGE-SECRET-KEY-'));
  if (identities.length !== 1) throw new Error('Comms requires one X25519 key');
  return identities[0];
 } finally { closeSync(fd); }
}
export function wordsKey(identity: string): WordsKey {
 return {
  async seal(words) { const e = new Encrypter(); e.addRecipient(await identityToRecipient(identity)); return Buffer.from(await e.encrypt(words)); },
  async open(blob) { const d = new Decrypter(); d.addIdentity(identity); return d.decrypt(blob, 'text'); },
  hash(words) { return createHmac('sha256', identity).update(words).digest('hex'); },
 };
}
export async function loadKey(home: string): Promise<WordsKey> {
 mkdirSync(home, { recursive: true, mode: 0o700 });
 const path = join(home, 'comms.key');
 const fromDisk = (): WordsKey => ({
  seal: words => wordsKey(readKey(path)).seal(words),
  open: blob => wordsKey(readKey(path)).open(blob),
  hash: words => wordsKey(readKey(path)).hash(words),
 });
 try { readKey(path); return fromDisk(); }
 catch (error) {
  if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  const identity = await generateX25519Identity();
  let fd: number;
  try { fd = openSync(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'EEXIST') return fromDisk(); throw error; }
  try { writeFileSync(fd, identity + '\n'); fsyncSync(fd); } finally { closeSync(fd); }
  return fromDisk();
 }
}
