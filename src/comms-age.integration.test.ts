/**
 * Comms words are decrypted in loom's own process with the age library (t-1926), and stay readable by the age program
 * both ways: the encrypted audit log and backup restores go through the program, so what either writes, the other reads.
 * Needs the `age` and `age-keygen` programs (CI installs age).
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import BetterSqlite3 from 'better-sqlite3';
import { Decrypter, Encrypter, armor, generateX25519Identity, identityToRecipient } from 'age-encryption';
import { agentDir, loadHousehold, type Household } from './household.js';
import { createConversationTables } from './backends/conversations.js';
import { COMMS_DB, COMMS_KEY, CommsError, adapterCall, memberWords, messagesOf, openThread } from './comms.js';

const hasAge = spawnSync('sh', ['-c', 'command -v age && command -v age-keygen'], { encoding: 'utf-8' }).status === 0;

/** The identity line of an age-keygen file. */
const secretOf = (path: string) => readFileSync(path, 'utf-8').split('\n').find((l) => l.startsWith('AGE-SECRET-KEY-1'))!.trim();
/** An environment with no age program at all: not on PATH, and no LOOM_AGE / LOOM_AGE_KEYGEN override. */
const noAge = (): NodeJS.ProcessEnv => { const e = { ...process.env, PATH: '/nonexistent' }; delete e.LOOM_AGE; delete e.LOOM_AGE_KEYGEN; return e; };
/** Puts `blob` in place of a stored message's text. */
function storeBlob(home: string, thread: string, seq: number, blob: Uint8Array): void {
  const db = new BetterSqlite3(join(home, COMMS_DB));
  try { db.prepare('UPDATE comms_messages SET text = ? WHERE thread = ? AND seq = ?').run(Buffer.from(blob), thread, seq); } finally { db.close(); }
}

/** A fresh age-keygen identity file: its secret line and its recipient. */
function keygen(dir: string, name: string): { path: string; secret: string; recipient: string } {
  const path = join(dir, name);
  const r = spawnSync('age-keygen', ['-o', path], { encoding: 'utf-8' });
  expect(r.status).toBe(0);
  const secret = secretOf(path);
  const recipient = spawnSync('age-keygen', ['-y', path], { encoding: 'utf-8' }).stdout.trim();
  return { path, secret, recipient };
}

describe.skipIf(!hasAge)('age: the library and the program read each other', () => {
  let dir: string;
  beforeAll(() => { dir = mkdtempSync(join(tmpdir(), 'loom-age-interop-')); });
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  it('what the library encrypts, the age program decrypts', async () => {
    const k = keygen(dir, 'a.key');
    const words = 'Grüße — the deploy box, `code`, and an emoji 🧵\n'.repeat(400);
    const e = new Encrypter();
    e.addRecipient(k.recipient);
    const blob = await e.encrypt(words);
    const r = spawnSync('age', ['-d', '-i', k.path], { input: Buffer.from(blob) });
    expect(r.status).toBe(0);
    expect(r.stdout.toString('utf-8')).toBe(words);
  });

  it('what the age program encrypts, the library decrypts with the key age-keygen wrote', async () => {
    const k = keygen(dir, 'b.key');
    const words = 'one thread, forty messages, ünïcödé ✓\n'.repeat(1000);
    const r = spawnSync('age', ['-e', '-r', k.recipient], { input: Buffer.from(words, 'utf-8') });
    expect(r.status).toBe(0);
    const d = new Decrypter();
    d.addIdentity(k.secret);
    expect(await d.decrypt(r.stdout, 'text')).toBe(words);
  });

  it('the library refuses a file for another key, as the program does', async () => {
    const a = keygen(dir, 'c.key');
    const b = keygen(dir, 'd.key');
    const blob = spawnSync('age', ['-e', '-r', a.recipient], { input: 'x' }).stdout;
    const d = new Decrypter();
    d.addIdentity(b.secret);
    await expect(d.decrypt(blob, 'text')).rejects.toThrow();
  });
});

describe.skipIf(!hasAge)('Comms decrypts a thread\'s words in-process (t-1926)', () => {
  let h: Household;
  const saved = process.env.LOOM_HOME;
  beforeAll(() => {
    const home = mkdtempSync(join(tmpdir(), 'loom-comms-age-'));
    mkdirSync(join(home, 'agents', 'art'), { recursive: true });
    writeFileSync(join(home, 'agents', 'art', 'IDENTITY.md'), '# art\n');
    const db = new BetterSqlite3(join(home, 'agents', 'art', 'memories.db'));
    createConversationTables(db);
    db.close();
    writeFileSync(join(home, 'household.json'), JSON.stringify({ v: 1, agents: ['art'], default: 'art', members: [{ person: 'jonathan', role: 'owner', agents: '*' }] }));
    process.env.LOOM_HOME = home;
    h = loadHousehold(home)!;
    expect(agentDir(h, 'art')).toBeTruthy();
  });
  afterAll(() => {
    if (saved === undefined) delete process.env.LOOM_HOME; else process.env.LOOM_HOME = saved;
    rmSync(h.home, { recursive: true, force: true });
  });

  it('reads a thread without spawning age, and the words are the ones sent', async () => {
    const o = openThread(h, process.env, h.members[0], { agent: 'art', id: 'aaaaaaaaaaaaaaaa', text: 'first words, ünïcödé' });
    for (let i = 0; i < 39; i++) adapterCall(h, process.env, { op: 'post', place: o.thread.id, agent: 'art', text: `reply ${i} 🧵` });
    // No program at all: a read that needed one would come back without words.
    const env = noAge();
    const said = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    try {
      const msgs = await messagesOf(h, env, o.thread);
      expect(msgs).toHaveLength(40);
      expect(msgs[0].text).toBe('first words, ünïcödé');
      expect(msgs.slice(1).map((m) => m.text)).toEqual(Array.from({ length: 39 }, (_, i) => `reply ${i} 🧵`));
      expect(await memberWords(h, env, o.thread, msgs[0].seq)).toBe('first words, ünïcödé');
      expect(said).not.toHaveBeenCalled();
    } finally { said.mockRestore(); }
  });

  it('falls back to the age program for a message the library can\'t read, and logs that without its words or the key', async () => {
    const o = openThread(h, process.env, h.members[0], { agent: 'art', id: 'baaaaaaaaaaaaaaa', text: 'plain to start' });
    // An armored age file: the program reads it, the library's binary decrypt doesn't.
    const recipient = spawnSync('age-keygen', ['-y', join(h.home, COMMS_KEY)], { encoding: 'utf-8' }).stdout.trim();
    const e = new Encrypter();
    e.addRecipient(recipient);
    const armored = armor.encode(await e.encrypt('the secret words'));
    storeBlob(h.home, o.thread.id, 1, Buffer.from(armored, 'utf-8'));
    // And two more like it: the log says it once a read, not once a message.
    for (let i = 0; i < 2; i++) adapterCall(h, process.env, { op: 'post', place: o.thread.id, agent: 'art', text: 'x' });
    storeBlob(h.home, o.thread.id, 2, Buffer.from(armored, 'utf-8'));
    storeBlob(h.home, o.thread.id, 3, Buffer.from(armored, 'utf-8'));
    const lines: string[] = [];
    const said = vi.spyOn(process.stderr, 'write').mockImplementation((c: string | Uint8Array) => { lines.push(String(c)); return true; });
    try {
      const msgs = await messagesOf(h, process.env, o.thread);
      expect(msgs.map((m) => m.text)).toEqual(['the secret words', 'the secret words', 'the secret words']);
    } finally { said.mockRestore(); }
    expect(lines.join('')).toMatch(/age library couldn't read th:[a-z2-7]{10} #1 .*trying the age program/);
    expect(lines).toHaveLength(1);
    const key = secretOf(join(h.home, COMMS_KEY));
    expect(lines.join('')).not.toContain('the secret words');
    expect(lines.join('')).not.toContain(key);
  });

  it('a message neither can read has no words, and the thread still reads', async () => {
    const o = openThread(h, process.env, h.members[0], { agent: 'art', id: 'caaaaaaaaaaaaaaa', text: 'kept' });
    adapterCall(h, process.env, { op: 'post', place: o.thread.id, agent: 'art', text: 'also kept' });
    storeBlob(h.home, o.thread.id, 1, Buffer.from('not an age file'));
    const said = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    try {
      const msgs = await messagesOf(h, process.env, o.thread);
      expect(msgs.map((m) => m.text)).toEqual([null, 'also kept']);
    } finally { said.mockRestore(); }
  });
  it('keeps no decrypted words between reads: a message changed under it reads as it is now', async () => {
    const o = openThread(h, process.env, h.members[0], { agent: 'art', id: 'daaaaaaaaaaaaaaa', text: 'before' });
    expect((await messagesOf(h, process.env, o.thread))[0].text).toBe('before');
    expect(await memberWords(h, process.env, o.thread, 1)).toBe('before');
    const recipient = spawnSync('age-keygen', ['-y', join(h.home, COMMS_KEY)], { encoding: 'utf-8' }).stdout.trim();
    const e = new Encrypter();
    e.addRecipient(recipient);
    storeBlob(h.home, o.thread.id, 1, await e.encrypt('after'));
    expect((await messagesOf(h, process.env, o.thread))[0].text).toBe('after');
    expect(await memberWords(h, process.env, o.thread, 1)).toBe('after');
  });

  it('keeps no identity between reads: comms.key is read again for each one', async () => {
    const o = openThread(h, process.env, h.members[0], { agent: 'art', id: 'eaaaaaaaaaaaaaaa', text: 'old key' });
    expect((await messagesOf(h, noAge(), o.thread))[0].text).toBe('old key');
    const keyPath = join(h.home, COMMS_KEY);
    const saved = readFileSync(keyPath, 'utf-8');
    const fresh = await generateX25519Identity();
    const e = new Encrypter();
    e.addRecipient(await identityToRecipient(fresh));
    storeBlob(h.home, o.thread.id, 1, await e.encrypt('new key'));
    try {
      writeFileSync(keyPath, `# created: test\n${fresh}\n`);
      expect((await messagesOf(h, noAge(), o.thread))[0].text).toBe('new key');
    } finally { writeFileSync(keyPath, saved); }
  });

  it('a read with no key the library can take and no age program is the 503 a send is', async () => {
    const o = openThread(h, process.env, h.members[0], { agent: 'art', id: 'faaaaaaaaaaaaaaa', text: 'locked' });
    const keyPath = join(h.home, COMMS_KEY);
    const saved = readFileSync(keyPath, 'utf-8');
    try {
      writeFileSync(keyPath, '# not a key\n');
      const err = await messagesOf(h, noAge(), o.thread).catch((x: unknown) => x);
      expect(err).toBeInstanceOf(CommsError);
      expect(err).toMatchObject({ status: 503, message: expect.stringMatching(/^no-age:/) });
    } finally { writeFileSync(keyPath, saved); }
  });
  it('a comms.key that is missing or a link is refused with a 503, not read as swept words', async () => {
    const o = openThread(h, process.env, h.members[0], { agent: 'art', id: 'gaaaaaaaaaaaaaaa', text: 'guarded' });
    const keyPath = join(h.home, COMMS_KEY);
    const aside = join(h.home, 'key-aside');
    renameSync(keyPath, aside);
    try {
      await expect(messagesOf(h, process.env, o.thread)).rejects.toMatchObject({ status: 503, message: expect.stringMatching(/comms\.key is missing or isn't a plain file/) });
      symlinkSync(aside, keyPath);
      await expect(messagesOf(h, process.env, o.thread)).rejects.toMatchObject({ status: 503 });
      await expect(memberWords(h, process.env, o.thread, 1)).rejects.toMatchObject({ status: 503 });
    } finally { rmSync(keyPath, { force: true }); renameSync(aside, keyPath); }
    expect((await messagesOf(h, process.env, o.thread))[0].text).toBe('guarded');
  });
  it('reads with every identity in comms.key, as age -i does', async () => {
    const o = openThread(h, process.env, h.members[0], { agent: 'art', id: 'haaaaaaaaaaaaaaa', text: 'first key' });
    adapterCall(h, process.env, { op: 'post', place: o.thread.id, agent: 'art', text: 'placeholder' });
    const keyPath = join(h.home, COMMS_KEY);
    const saved = readFileSync(keyPath, 'utf-8');
    const second = await generateX25519Identity();
    const e = new Encrypter();
    e.addRecipient(await identityToRecipient(second));
    storeBlob(h.home, o.thread.id, 2, await e.encrypt('second key'));
    const said = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    try {
      writeFileSync(keyPath, `${saved}${second}\n`);
      expect((await messagesOf(h, noAge(), o.thread)).map((m) => m.text)).toEqual(['first key', 'second key']);
      expect(said).not.toHaveBeenCalled();
    } finally { said.mockRestore(); writeFileSync(keyPath, saved); }
  });
});
