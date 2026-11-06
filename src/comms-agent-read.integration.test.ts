/**
 * Comms, an agent's own threads (docs/specs/comms.md, "An agent reading its own threads" and "Tracing a reply";
 * t-1896, t-1895): the comms_thread tool, bound to the session's own agent, and the runtime's read-only `trace` op on
 * the adapter route, which carries a thread's delivery facts and never its words. Needs the `age` programs.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import BetterSqlite3 from 'better-sqlite3';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createLoomServer } from './server.js';
import { agentDir, loadHousehold, type Household } from './household.js';
import { createConversationTables, recordTurn } from './backends/conversations.js';
import { adapterCall, openThread, recordDelivery, sweepComms, threadFor } from './comms.js';
import { isCoreMcpTool } from './offers.js';

const hasAge = spawnSync('sh', ['-c', 'command -v age && command -v age-keygen'], { encoding: 'utf-8' }).status === 0;
const at = () => new Date().toISOString();

function household(): Household {
  const home = mkdtempSync(join(tmpdir(), 'loom-comms-agent-read-'));
  for (const a of ['art', 'mark']) {
    mkdirSync(join(home, 'agents', a), { recursive: true });
    writeFileSync(join(home, 'agents', a, 'IDENTITY.md'), `# ${a}\n`);
    const db = new BetterSqlite3(join(home, 'agents', a, 'memories.db'));
    createConversationTables(db);
    db.close();
  }
  writeFileSync(join(home, 'household.json'), JSON.stringify({ v: 1, agents: ['art', 'mark'], default: 'art', members: [{ person: 'jonathan', role: 'owner', agents: '*' }] }));
  return loadHousehold(home)!;
}

describe.skipIf(!hasAge)('Comms: an agent reads its own threads', () => {
  let h: Household;
  const saved = process.env.LOOM_HOME;
  const jonathan = () => h.members[0];
  beforeEach(() => { h = household(); process.env.LOOM_HOME = h.home; });
  afterEach(() => { if (saved === undefined) delete process.env.LOOM_HOME; else process.env.LOOM_HOME = saved; rmSync(h.home, { recursive: true, force: true }); });

  const thread = (n: number, agent = 'art', text = 'is the build green?') => {
    const o = openThread(h, process.env, jonathan(), { agent, id: `aaaaaaaaaaaaaaa${'abcdefghijklmnop'[n]}`, text });
    recordTurn(agentDir(h, agent), agent, { venue: 'loom', place: o.thread.id, at: at(), from: { kind: 'person', slug: 'jonathan' }, kind: 'message', label: 'New thread' } as never, 'runtime:runtime');
    return o.thread;
  };
  const read = async (agent: string, conversation: string | null, args: Record<string, unknown> = {}) => {
    const { server } = createLoomServer({ contextDir: agentDir(h, agent) });
    const client = new Client({ name: 'comms-thread-test', version: '1' });
    const [c, s] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(s), client.connect(c)]);
    try {
      if (conversation) await client.callTool({ name: 'identity', arguments: { conversation, run: 'run-1' } });
      const r = await client.callTool({ name: 'comms_thread', arguments: args }) as { content: Array<{ text: string }>; isError?: boolean };
      return { error: r.isError === true, body: JSON.parse(r.content[0].text) as Record<string, unknown> };
    } finally { await client.close(); }
  };

  describe('comms_thread (t-1896)', () => {
    it('reads its own thread as the member sees it: the words, its replies and an error card in its fixed words', async () => {
      const t = thread(0);
      adapterCall(h, process.env, { op: 'post', place: t.id, agent: 'art', text: 'Yes, all green.', run: 'run-1' });
      recordDelivery(h, threadFor(h, jonathan(), t.id), 1, { delivered: false, error: { code: 'post-failed', reason: 'the venue was down' } });
      const r = await read('art', t.conversation);
      expect(r.error).toBe(false);
      const msgs = r.body.messages as Array<{ kind: string; from: string; text: string | null }>;
      expect(msgs.map((m) => [m.kind, m.from, m.text])).toEqual([
        ['message', 'jonathan', 'is the build green?'],
        ['reply', 'art', 'Yes, all green.'],
        ['error', 'loom', 'Art\'s reply couldn\'t be shown: the venue was down.'],
      ]);
      expect(r.body.thread).toMatchObject({ id: t.id, archived: null });
    });

    it('names another thread of its own agent\'s by id, from any session; never another agent\'s, whatever it claims', async () => {
      const arts = thread(1);
      const marks = thread(2, 'mark', 'did my reply show?');
      // Mark, from a later session with no identity, reads his own thread by its id.
      const own = await read('mark', null, { thread: marks.id });
      expect(own.error).toBe(false);
      expect((own.body.messages as Array<{ text: string }>)[0].text).toBe('did my reply show?');
      // Mark naming Art's thread, by id or by claiming Art's conversation at identity: the same refusal, no words.
      for (const r of [await read('mark', null, { thread: arts.id }), await read('mark', arts.conversation), await read('mark', null, { thread: 'th:aaaaaaaaaa' })]) {
        expect(r.error).toBe(true);
        expect(String(r.body.error)).toMatch(/isn't one/);
        expect(JSON.stringify(r.body)).not.toMatch(/build green/);
      }
      // No identity and no thread: it says what it needs.
      expect(String((await read('art', null)).body.error)).toMatch(/identity/);
    });

    it('keeps the 14-day rule: swept words are gone, the message stays', async () => {
      const t = thread(3);
      sweepComms(h, new Date(Date.now() + 15 * 86_400_000));
      const r = await read('art', t.conversation);
      expect((r.body.messages as Array<{ kind: string; text: string | null }>)[0]).toMatchObject({ kind: 'message', text: null });
    });

    it('is a core tool name, so no piece may offer one by it', () => {
      expect(isCoreMcpTool('comms_thread')).toBe(true);
    });
  });

  describe('the runtime\'s trace op (t-1895)', () => {
    it('answers a thread\'s delivery facts without its words, archived too, and never another agent\'s', () => {
      const t = thread(4);
      adapterCall(h, process.env, { op: 'post', place: t.id, agent: 'art', text: 'All green, merging.', run: 'run-9' });
      const r = adapterCall(h, process.env, { op: 'trace', place: t.id, agent: 'art' });
      expect(r).toMatchObject({ ok: true, trace: { thread: t.id, conversation: t.conversation, last_failed: false } });
      const tr = (r as { trace: { messages: Array<Record<string, unknown>> } }).trace;
      expect(tr.messages.map((m) => [m.kind, m.from, m.run, m.delivery])).toEqual([['message', 'jonathan', null, 'sending'], ['reply', 'art', 'run-9', undefined]]);
      expect(JSON.stringify(r)).not.toMatch(/green|merging/);
      expect(adapterCall(h, process.env, { op: 'trace', place: t.id, agent: 'mark' })).toMatchObject({ ok: false, permanent: true });
      expect(adapterCall(h, process.env, { op: 'trace', place: 'not-a-thread', agent: 'art' })).toMatchObject({ ok: false, permanent: true });
    });
  });
});
