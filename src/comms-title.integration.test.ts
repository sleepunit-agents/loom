/**
 * Comms, step 3 (docs/specs/comms.md, "Title" and "Project"; criteria 6 and 7): the comms_title tool, the title as the
 * conversation's label, a thread's project as its digests' fallback, and the hub counting a thread filed under a
 * project before its first digest. Needs the `age` programs (CI installs age).
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
import { createConversationTables, getConversation, recordTurn, writeDigest } from './backends/conversations.js';
import { openThread, setTitle, threadFor } from './comms.js';
import { conversationsSection } from './conversations.js';
import { isCoreMcpTool } from './offers.js';

const hasAge = spawnSync('sh', ['-c', 'command -v age && command -v age-keygen'], { encoding: 'utf-8' }).status === 0;
const at = () => new Date().toISOString();

function household(): Household {
  const home = mkdtempSync(join(tmpdir(), 'loom-comms-title-'));
  for (const a of ['art', 'mark']) {
    mkdirSync(join(home, 'agents', a), { recursive: true });
    writeFileSync(join(home, 'agents', a, 'IDENTITY.md'), `# ${a}\n`);
    const db = new BetterSqlite3(join(home, 'agents', a, 'memories.db'));
    createConversationTables(db);
    db.exec(`CREATE TABLE IF NOT EXISTS projects (slug TEXT PRIMARY KEY, name TEXT NOT NULL, status TEXT, card_json TEXT NOT NULL, archived_at TEXT, archived_by TEXT, archive_reason TEXT, updated TEXT, synthesized_at TEXT);
             CREATE TABLE IF NOT EXISTS project_names (name TEXT PRIMARY KEY, slug TEXT NOT NULL, kind TEXT NOT NULL);`);
    for (const [slug, venues] of [['hocket', []], ['pond', ['loom:VENUE']]] as const) {
      db.prepare('INSERT INTO projects (slug, name, status, card_json, archived_at, updated) VALUES (?, ?, ?, ?, NULL, ?)').run(slug, slug, 'active', JSON.stringify({ slug, name: slug, links: { aliases: [], venues } }), at());
      db.prepare('INSERT INTO project_names VALUES (?, ?, ?)').run(slug, slug, 'slug');
    }
    db.close();
  }
  writeFileSync(join(home, 'household.json'), JSON.stringify({ v: 1, agents: ['art', 'mark'], default: 'art', members: [{ person: 'jonathan', role: 'owner', agents: '*' }] }));
  return loadHousehold(home)!;
}

describe.skipIf(!hasAge)('Comms: the title and the project', () => {
  let h: Household;
  const saved = process.env.LOOM_HOME;
  const jonathan = () => h.members[0];
  beforeEach(() => { h = household(); process.env.LOOM_HOME = h.home; });
  afterEach(() => { if (saved === undefined) delete process.env.LOOM_HOME; else process.env.LOOM_HOME = saved; rmSync(h.home, { recursive: true, force: true }); });

  /** A thread with its conversation recorded (as the runtime's first turn would). */
  const thread = (n: number, project?: string) => {
    const o = openThread(h, process.env, jonathan(), { agent: 'art', id: `aaaaaaaaaaaaaaa${'abcdefgh'[n]}`, text: 'hi', ...(project ? { project } : {}) });
    recordTurn(agentDir(h, 'art'), 'art', { venue: 'loom', place: o.thread.id, at: at(), from: { kind: 'person', slug: 'jonathan' }, kind: 'message', label: 'New thread' } as never, 'runtime:runtime');
    return o.thread;
  };
  const call = async (conversation: string | null, title: unknown) => {
    const { server } = createLoomServer({ contextDir: agentDir(h, 'art') });
    const client = new Client({ name: 'comms-title-test', version: '1' });
    const [c, s] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(s), client.connect(c)]);
    try {
      if (conversation) await client.callTool({ name: 'identity', arguments: { conversation, run: 'run-1' } });
      const r = await client.callTool({ name: 'comms_title', arguments: { title } }) as { content: Array<{ text: string }>; isError?: boolean };
      let body: Record<string, unknown>;
      try { body = JSON.parse(r.content[0].text) as Record<string, unknown>; } catch { body = { error: r.content[0].text }; }
      return { error: r.isError === true, body };
    } finally { await client.close(); }
  };

  describe('criterion 6: comms_title', () => {
    it('names the thread, and the name becomes the conversation\'s label', async () => {
      const t = thread(0);
      const r = await call(t.conversation, 'Hocket pairing flow');
      expect(r).toMatchObject({ error: false, body: { ok: true, title: 'Hocket pairing flow' } });
      expect(threadFor(h, jonathan(), t.id)).toMatchObject({ title: 'Hocket pairing flow', titled_by: 'agent' });
      expect(getConversation(agentDir(h, 'art'), t.conversation)?.label).toBe('Hocket pairing flow');
    });

    it('refuses outside a loom conversation, over 60, a line break, and after the owner\'s own name', async () => {
      const slack = recordTurn(agentDir(h, 'art'), 'art', { venue: 'slack', place: 'dm:U1', at: at(), from: { kind: 'person', slug: 'jonathan' }, kind: 'message' } as never, 'runtime:runtime');
      expect((await call(slack.conversation, 'A title')).body.error).toMatch(/isn't one/);
      expect((await call(null, 'A title')).body.error).toMatch(/identity/);
      const t = thread(1);
      expect((await call(t.conversation, 'x'.repeat(61))).error).toBe(true);
      expect((await call(t.conversation, 'two\nlines')).body.error).toMatch(/one line/);
      setTitle(h, threadFor(h, jonathan(), t.id), 'Mine', 'member');
      expect((await call(t.conversation, 'The agent\'s')).body.error).toMatch(/owner named this thread/);
      expect(threadFor(h, jonathan(), t.id).title).toBe('Mine');
      expect(getConversation(agentDir(h, 'art'), t.conversation)?.label).toBe('Mine');
    });

    it('is a core tool name, so no piece may offer one by it', () => {
      expect(isCoreMcpTool('comms_title')).toBe(true);
    });
  });

  describe('criterion 7: the project', () => {
    it('a thread\'s project is a digest\'s fallback, ahead of a project whose links.venues names the place', () => {
      const t = thread(2, 'hocket');
      // pond's links.venues names this very place: the thread's own project still wins.
      const db = new BetterSqlite3(join(agentDir(h, 'art'), 'memories.db'));
      db.prepare('UPDATE projects SET card_json = ? WHERE slug = ?').run(JSON.stringify({ slug: 'pond', name: 'pond', links: { aliases: [], venues: [`loom:${t.id}`] } }), 'pond');
      db.close();
      const d = writeDigest(agentDir(h, 'art'), { conversation: t.conversation, run: 'run-1' }, { summary: 'Planned the pairing.' }, new Date(), 'hocket');
      expect(d.projects).toEqual(['hocket']);
      const named = writeDigest(agentDir(h, 'art'), { conversation: t.conversation, run: 'run-2' }, { summary: 'About pond, really.', projects: ['pond'] }, new Date(), 'hocket');
      expect(named.projects).toEqual(['pond']);
    });

    it('the hub lists a thread filed under the project before its first digest', () => {
      const t = thread(3, 'hocket');
      thread(4);
      const s = conversationsSection(agentDir(h, 'art'), 'hocket', new Date(0).toISOString());
      expect(s?.items.map((i) => i.id)).toEqual([t.conversation]);
      expect(conversationsSection(agentDir(h, 'art'), 'pond', new Date(0).toISOString())?.items).toEqual([]);
    });

    it('a project that isn\'t one of the agent\'s live ones is refused', () => {
      expect(() => openThread(h, process.env, jonathan(), { agent: 'art', id: 'aaaaaaaaaaaaaaaz', text: 'x', project: 'nope' })).toThrow(/live projects/);
    });
  });
});
