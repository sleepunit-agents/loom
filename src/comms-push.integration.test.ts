/**
 * Comms' push (docs/specs/comms.md, "Notifications"; criterion 11): a reply in a thread its member hasn't read, when
 * no app of theirs has had that thread in front for 2 minutes, pushes to that member's devices only, with no message
 * text; an untitled thread's says "replied in a new thread"; a thread in front pushes nothing. Needs age.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import BetterSqlite3 from 'better-sqlite3';
import { loadHousehold, type Household } from './household.js';
import { createConversationTables } from './backends/conversations.js';
import { adapterCall, markRead, openThread, setTitle, threadFor } from './comms.js';
import { commsAnnouncements } from './ui/handler.js';
import { SessionStore } from './ui/sessions.js';
import { watch } from './ui/push.js';

const hasAge = spawnSync('sh', ['-c', 'command -v age && command -v age-keygen'], { encoding: 'utf-8' }).status === 0;

describe.skipIf(!hasAge)('Comms push', () => {
  let h: Household;
  const saved = process.env.LOOM_HOME;
  beforeEach(() => {
    const home = mkdtempSync(join(tmpdir(), 'loom-comms-push-'));
    for (const a of ['art', 'pond-bot']) {
      mkdirSync(join(home, 'agents', a), { recursive: true });
      writeFileSync(join(home, 'agents', a, 'IDENTITY.md'), `# ${a === 'art' ? 'Art E Fish' : 'Pond'}\n`);
      const db = new BetterSqlite3(join(home, 'agents', a, 'memories.db'));
      createConversationTables(db);
      db.close();
    }
    writeFileSync(join(home, 'household.json'), JSON.stringify({ v: 1, agents: ['art', 'pond-bot'], default: 'art', members: [
      { person: 'jonathan', role: 'owner', agents: '*' }, { person: 'loren', role: 'owner', agents: ['pond-bot'] }] }));
    process.env.LOOM_HOME = home;
    h = loadHousehold(home)!;
  });
  afterEach(() => { if (saved === undefined) delete process.env.LOOM_HOME; else process.env.LOOM_HOME = saved; rmSync(h.home, { recursive: true, force: true }); });

  const thread = (text = 'hello') => openThread(h, process.env, h.members[0], { agent: 'art', id: `aaaaaaaaaaaaaaa${'abcdefg'[Math.floor(Math.random() * 7)]}`, text }).thread;

  it('a reply unread and not in front: one announcement, for its member, with no words', () => {
    const t = thread();
    adapterCall(h, process.env, { op: 'post', place: t.id, agent: 'art', text: 'the secret words of the reply' });
    const a = commsAnnouncements(h);
    expect(a).toHaveLength(1);
    expect(a[0]).toMatchObject({ member: 'jonathan', title: 'Art E Fish replied in a new thread', url: `/comms/${t.id}` });
    expect(JSON.stringify(a)).not.toMatch(/secret words/);
    setTitle(h, threadFor(h, h.members[0], t.id), 'The comm screen', 'agent');
    expect(commsAnnouncements(h)[0]).toMatchObject({ title: 'Art E Fish replied', body: 'The comm screen' });
  });

  it('in front in the last 2 minutes, or read: none', () => {
    const t = thread();
    adapterCall(h, process.env, { op: 'post', place: t.id, agent: 'art', text: 'x' });
    markRead(h, threadFor(h, h.members[0], t.id), 0);
    expect(commsAnnouncements(h)).toEqual([]);
    expect(commsAnnouncements(h, Date.now() + 3 * 60_000)).toHaveLength(1);
    markRead(h, threadFor(h, h.members[0], t.id), 99);
    expect(commsAnnouncements(h, Date.now() + 3 * 60_000)).toEqual([]);
  });

  it('the watch sends it only to its member\'s devices, never another member\'s', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'loom-comms-push-store-'));
    try {
      const store = new SessionStore(dir);
      const sub = (path: string) => ({ endpoint: `https://fcm.googleapis.com/fcm/send/${path}`, keys: { p256dh: 'p'.repeat(40), auth: 'a'.repeat(16) } });
      store.addPushSub(store.create(Buffer.alloc(32, 1)), sub('jon'), undefined, 'jonathan');
      store.addPushSub(store.create(Buffer.alloc(32, 2)), sub('loren'), undefined, 'loren');
      const sent: Array<{ to: string; payload: Record<string, unknown> }> = [];
      const send = async (s: { endpoint: string }, payload: string) => { sent.push({ to: s.endpoint, payload: JSON.parse(payload) }); return {} as never; };
      const fresh = () => { const f = JSON.parse(readFileSync(join(dir, 'ui-sessions.json'), 'utf8')); if (f.push) { delete f.push.tickAt; writeFileSync(join(dir, 'ui-sessions.json'), JSON.stringify(f)); } };
      // The first watch only records what's there.
      await watch(store, async () => commsAnnouncements(h), 'mailto:x', send, () => true, () => 'jonathan');
      const t = thread();
      adapterCall(h, process.env, { op: 'post', place: t.id, agent: 'art', text: 'words that never go' });
      fresh();
      await watch(store, async () => commsAnnouncements(h), 'mailto:x', send, () => true, () => 'jonathan');
      expect(sent.map((x) => x.to)).toEqual(['https://fcm.googleapis.com/fcm/send/jon']);
      expect(sent[0].payload).toMatchObject({ title: 'Art E Fish replied in a new thread', url: `/comms/${t.id}` });
      expect(JSON.stringify(sent)).not.toMatch(/never go/);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});
