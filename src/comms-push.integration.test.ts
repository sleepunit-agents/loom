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
import { agentDir, loadHousehold, type Household } from './household.js';
import { createConversationTables } from './backends/conversations.js';
import { adapterCall, markRead, openThread, setTitle, threadFor } from './comms.js';
import { commsAnnouncements, pushWatch } from './ui/handler.js';
import { SessionStore, sessionStore } from './ui/sessions.js';
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

  /** The real wiring: pushWatch (Your call and Comms in one minute's watch), its own hears, the store loom keeps. */
  const minute = async (sent: Array<{ to: string; payload: Record<string, unknown> }>) => {
    const f = join(h.home, 'ui-sessions.json');
    try { const j = JSON.parse(readFileSync(f, 'utf8')); if (j.push) { delete j.push.tickAt; writeFileSync(f, JSON.stringify(j)); } } catch { /* first */ }
    const send = async (sub: { endpoint: string }, payload: string) => { sent.push({ to: sub.endpoint, payload: JSON.parse(payload) }); return {} as never; };
    return pushWatch({ contextDir: agentDir(h, 'art'), auth: { enabled: true, check: () => null, live: () => false }, env: process.env, household: () => h } as never, send as never);
  };
  const sub = (path: string) => ({ endpoint: `https://fcm.googleapis.com/fcm/send/${path}`, keys: { p256dh: 'p'.repeat(40), auth: 'a'.repeat(16) } });

  it("through pushWatch: the first owner's device (no member, as loom stores it) and an agent owner's, each only its own", async () => {
    const store = sessionStore(h.home);
    store.addPushSub(store.create(Buffer.alloc(32, 1)), sub('jon'));                       // the first owner's: no member
    store.addPushSub(store.create(Buffer.alloc(32, 2)), sub('loren'), undefined, 'loren');
    const sent: Array<{ to: string; payload: Record<string, unknown> }> = [];
    await minute(sent);                                                                     // the first watch records only
    const t = thread();
    adapterCall(h, process.env, { op: 'post', place: t.id, agent: 'art', text: 'words that never go' });
    const lt = openThread(h, process.env, h.members[1], { agent: 'pond-bot', id: 'bbbbbbbbbbbbbbbb', text: 'hi pond' }).thread;
    adapterCall(h, process.env, { op: 'post', place: lt.id, agent: 'pond-bot', text: 'pond words' });
    await minute(sent);
    const to = (who: string) => sent.filter((x) => x.to.endsWith(who)).map((x) => x.payload.url);
    expect(to('jon')).toEqual([`/comms/${t.id}`]);
    expect(to('loren')).toEqual([`/comms/${lt.id}`]);
    expect(JSON.stringify(sent)).not.toMatch(/never go|pond words/);
  });

  it('a read on another thread doesn\'t hold a thread\'s push back', () => {
    const a = thread('one');
    const b = openThread(h, process.env, h.members[0], { agent: 'art', id: 'cccccccccccccccc', text: 'two' }).thread;
    adapterCall(h, process.env, { op: 'post', place: a.id, agent: 'art', text: 'x' });
    adapterCall(h, process.env, { op: 'post', place: b.id, agent: 'art', text: 'y' });
    markRead(h, threadFor(h, h.members[0], a.id), 0);
    expect(commsAnnouncements(h).map((x) => x.url)).toEqual([`/comms/${b.id}`]);
  });

  it('past five in a minute, the rest wait for the next minute: none is dropped', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'loom-comms-push-store-'));
    try {
      const store = new SessionStore(dir);
      store.addPushSub(store.create(Buffer.alloc(32, 1)), sub('one'));
      const sent: string[] = [];
      const send = async (_s: unknown, payload: string) => { sent.push(JSON.parse(payload).tag); return {} as never; };
      const fresh = () => { const f = JSON.parse(readFileSync(join(dir, 'ui-sessions.json'), 'utf8')); if (f.push) { delete f.push.tickAt; writeFileSync(join(dir, 'ui-sessions.json'), JSON.stringify(f)); } };
      const asks = (n: number) => async () => Array.from({ length: n }, (_, i) => ({ key: `k${i}`, title: 't', body: '' }));
      await watch(store, asks(0), 'mailto:x', send);
      fresh(); await watch(store, asks(6), 'mailto:x', send);
      expect(sent).toHaveLength(5);
      fresh(); await watch(store, asks(6), 'mailto:x', send);
      expect(sent).toEqual(['ask-k0', 'ask-k1', 'ask-k2', 'ask-k3', 'ask-k4', 'ask-k5']);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});
