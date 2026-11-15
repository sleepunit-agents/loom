/** Retained legacy project-context readers. */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import BetterSqlite3 from 'better-sqlite3';
import { agentDir, loadHousehold, type Household } from './household.js';
import { createConversationTables, recordTurn, writeDigest } from './backends/conversations.js';
import { openThread } from './comms.js';
import { conversationsSection } from './conversations.js';

const hasAge = spawnSync('sh', ['-c', 'command -v age && command -v age-keygen'], { encoding: 'utf-8' }).status === 0;
const at = () => new Date().toISOString();

function household(): Household {
  const home = mkdtempSync(join(tmpdir(), 'loom-comms-project-'));
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

describe.skipIf(!hasAge)('Comms: legacy project fallback', () => {
  let h: Household;
  const saved = process.env.LOOM_HOME;
  const jonathan = () => h.members[0];
  beforeEach(() => { h = household(); process.env.LOOM_HOME = h.home; });
  afterEach(() => { if (saved === undefined) delete process.env.LOOM_HOME; else process.env.LOOM_HOME = saved; rmSync(h.home, { recursive: true, force: true }); });

  /** A thread with its conversation recorded (as the runtime's first turn would). */
  const thread = (n: number, project?: string, agent = 'art') => {
    const o = openThread(h, process.env, jonathan(), { agent, id: `aaaaaaaaaaaaaaa${'abcdefghijklmnop'[n]}`, text: 'hi', ...(project ? { project } : {}) });
    recordTurn(agentDir(h, agent), agent, { venue: 'loom', place: o.thread.id, at: at(), from: { kind: 'person', slug: 'jonathan' }, kind: 'message', label: 'New thread' } as never, 'runtime:runtime');
    return o.thread;
  };
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
