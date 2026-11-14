import Database from 'better-sqlite3';
import { afterEach, expect, it } from 'vitest';
import { createDataSchema } from '../data/database.js';
import { agents, household, members, messages } from '../data/schema.js';
import { CommsMessages } from './messages.js';
const clients: Database.Database[] = [];
afterEach(() => { for (const client of clients.splice(0)) client.close(); });
it('withholds decrypted words if ciphertext or its retained deadline changes while opening', async () => {
  for (const change of ['ciphertext', 'deadline', 'household'] as const) {
    const client = new Database(':memory:'); clients.push(client);
    const now = '2026-11-14T18:00:00.000Z', db = createDataSchema(client, () => now);
    db.insert(members).values({ id: 'alice', role: 'member', joinedAt: now }).run();
    db.insert(agents).values({ id: 'art', about: '', markBg: '#000', markFg: '#fff', faceShape: 'pebble', faceEyes: 'dot' }).run();
    const key = { seal: async (s: string) => Buffer.from(s), hash: (s: string) => s, open: async (b: Uint8Array) => {
      if (change === 'ciphertext') db.update(messages).set({ words: Buffer.from('Replaced') }).run();
      if (change === 'deadline') db.update(messages).set({ keepUntil: '2026-11-16T18:00:00.000Z' }).run();
      if (change === 'household') db.insert(household).values({ commsDays: 1 }).run();
      return Buffer.from(b).toString();
    } };
    const service = new CommsMessages(db, key, () => now);
    const thread = service.threads.open({ member: 'alice', agent: 'art', title: 'Pump' });
    const row = await service.send({ thread: thread.id, sender: 'art', kind: 'reply', words: 'Original' });
    expect(await service.words(thread.id, row.seq), change).toBeNull();
  }
});
it('applies the current household keep time to existing words before decrypting', async () => {
  const client = new Database(':memory:'); clients.push(client);
  let now = '2026-11-14T18:00:00.000Z', opened = false;
  const db = createDataSchema(client, () => now);
  db.insert(members).values({ id: 'alice', role: 'member', joinedAt: now }).run();
  db.insert(agents).values({ id: 'art', about: '', markBg: '#000', markFg: '#fff', faceShape: 'pebble', faceEyes: 'dot' }).run();
  const service = new CommsMessages(db, { seal: async s => Buffer.from(s), hash: s => s, open: async b => { opened = true; return Buffer.from(b).toString(); } }, () => now);
  const thread = service.threads.open({ member: 'alice', agent: 'art', title: 'Pump' });
  const row = await service.send({ thread: thread.id, sender: 'art', kind: 'reply', words: 'Original' });
  db.insert(household).values({ commsDays: 1 }).run();
  now = '2026-11-15T18:00:00.000Z';
  expect(await service.words(thread.id, row.seq)).toBeNull();
  expect(opened).toBe(false);
  expect(service.expire()).toBe(1);
  expect(db.select().from(messages).get()?.words).toBeNull();
  expect(service.expire()).toBe(0);
});
