/**
 * Comms words are decrypted in loom's own process with the age library (t-1926), and stay readable by the age program
 * both ways: the encrypted audit log and backup restores go through the program, so what either writes, the other reads.
 * Needs the `age` and `age-keygen` programs (CI installs age).
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import BetterSqlite3 from 'better-sqlite3';
import { Decrypter, Encrypter, armor } from 'age-encryption';
import { agentDir, loadHousehold, type Household } from './household.js';
import { createConversationTables } from './backends/conversations.js';
import { COMMS_DB, COMMS_KEY, adapterCall, memberWords, messagesOf, openThread } from './comms.js';

const hasAge = spawnSync('sh', ['-c', 'command -v age && command -v age-keygen'], { encoding: 'utf-8' }).status === 0;

/** A fresh age-keygen identity file: its secret line and its recipient. */
function keygen(dir: string, name: string): { path: string; secret: string; recipient: string } {
  const path = join(dir, name);
  const r = spawnSync('age-keygen', ['-o', path], { encoding: 'utf-8' });
  expect(r.status).toBe(0);
  const secret = spawnSync('grep', ['^AGE-SECRET-KEY-1', path], { encoding: 'utf-8' }).stdout.trim();
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
    const env = { ...process.env, PATH: '/nonexistent' };
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
    const db = new BetterSqlite3(join(h.home, COMMS_DB));
    try { db.prepare('UPDATE comms_messages SET text = ? WHERE thread = ? AND seq = 1').run(Buffer.from(armored, 'utf-8'), o.thread.id); } finally { db.close(); }
    const lines: string[] = [];
    const said = vi.spyOn(process.stderr, 'write').mockImplementation((c: string | Uint8Array) => { lines.push(String(c)); return true; });
    try {
      const msgs = await messagesOf(h, process.env, o.thread);
      expect(msgs[0].text).toBe('the secret words');
    } finally { said.mockRestore(); }
    expect(lines.join('')).toMatch(/age library couldn't read th:[a-z2-7]{10} #1 .*trying the age program/);
    const key = spawnSync('grep', ['^AGE-SECRET-KEY-1', join(h.home, COMMS_KEY)], { encoding: 'utf-8' }).stdout.trim();
    expect(lines.join('')).not.toContain('the secret words');
    expect(lines.join('')).not.toContain(key);
  });

  it('a message neither can read has no words, and the thread still reads', async () => {
    const o = openThread(h, process.env, h.members[0], { agent: 'art', id: 'caaaaaaaaaaaaaaa', text: 'kept' });
    adapterCall(h, process.env, { op: 'post', place: o.thread.id, agent: 'art', text: 'also kept' });
    const db = new BetterSqlite3(join(h.home, COMMS_DB));
    try { db.prepare('UPDATE comms_messages SET text = ? WHERE thread = ? AND seq = 1').run(Buffer.from('not an age file'), o.thread.id); } finally { db.close(); }
    const said = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    try {
      const msgs = await messagesOf(h, process.env, o.thread);
      expect(msgs.map((m) => m.text)).toEqual([null, 'also kept']);
    } finally { said.mockRestore(); }
  });
});
