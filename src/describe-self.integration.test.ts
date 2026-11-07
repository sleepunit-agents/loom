/**
 * An agent's description (t-1925 D): what the household sees in its window, in plain words. Its owner writes it
 * (about-set), or asks the agent to (about-ask, the window's Regenerate), and only then may the agent write its own,
 * once, with the describe_self tool. Never written by anything the caller sends: the agent is the server's own.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createLoomServer } from './server.js';
import { aboutAskOf, aboutOf, ABOUT_ASK_MS, agentDir, loadHousehold, setAboutAsk, type Household } from './household.js';
import { householdAct } from './ui/household-pages.js';

function household(): Household {
  const home = mkdtempSync(join(tmpdir(), 'loom-describe-self-'));
  for (const a of ['art', 'mark']) {
    mkdirSync(join(home, 'agents', a), { recursive: true });
    writeFileSync(join(home, 'agents', a, 'IDENTITY.md'), `# ${a}\n\nYou are ${a}, a creed.\n`);
  }
  writeFileSync(join(home, 'household.json'), JSON.stringify({ v: 1, agents: ['art', 'mark'], default: 'art', members: [{ person: 'jonathan', role: 'owner', agents: '*' }] }));
  return loadHousehold(home)!;
}

describe('an agent\'s description', () => {
  let h: Household;
  const saved = process.env.LOOM_HOME;
  beforeEach(() => { h = household(); process.env.LOOM_HOME = h.home; });
  afterEach(() => { if (saved === undefined) delete process.env.LOOM_HOME; else process.env.LOOM_HOME = saved; rmSync(h.home, { recursive: true, force: true }); });

  const describeSelf = async (text: string, agent = 'art') => {
    const { server } = createLoomServer({ contextDir: agentDir(h, agent) });
    const client = new Client({ name: 'describe-self-test', version: '1' });
    const [c, s] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(s), client.connect(c)]);
    try {
      const r = await client.callTool({ name: 'describe_self', arguments: { text } }) as { content: Array<{ text: string }>; isError?: boolean };
      let body: Record<string, string>;
      try { body = JSON.parse(r.content[0].text) as Record<string, string>; } catch { body = { error: r.content[0].text }; }
      return { error: !!r.isError, body };
    } finally { await client.close(); }
  };

  it('the owner writes it (about-set) and clears it; no creed stands in for it', async () => {
    expect(aboutOf(h, 'art')).toBeUndefined();
    expect((await householdAct(h, 'about-set', { agent: 'art', about: '  Art keeps the house running.  ' })).ok).toBe(true);
    expect(aboutOf(h, 'art')).toBe('Art keeps the house running.');
    expect((await householdAct(h, 'about-set', { agent: 'art', about: 'x'.repeat(601) })).ok).toBe(false);
    expect(aboutOf(h, 'art')).toBe('Art keeps the house running.');
    expect((await householdAct(h, 'about-set', { agent: 'nobody', about: 'hi' })).ok).toBe(false);
    expect((await householdAct(h, 'about-set', { agent: 'art', about: '' })).ok).toBe(true);
    expect(aboutOf(h, 'art')).toBeUndefined();
  });

  it('describe_self is refused until the owner asks, writes once when asked, and the ask closes', async () => {
    expect((await describeSelf('I keep the house running.')).body.error).toMatch(/nobody asked/);
    expect(aboutOf(h, 'art')).toBeUndefined();
    expect((await householdAct(h, 'about-ask', { agent: 'art' })).ok).toBe(true);
    expect(aboutAskOf(h, 'art')).toBeTruthy();
    // Mark wasn't asked: his body can't write his, and Art's ask isn't his.
    expect((await describeSelf('I am Mark.', 'mark')).error).toBe(true);
    const r = await describeSelf('I keep the house running: backups, machines and the task list, for Jonathan.');
    expect(r).toEqual({ error: false, body: { ok: true, description: 'I keep the house running: backups, machines and the task list, for Jonathan.' } });
    expect(aboutOf(h, 'art')).toBe('I keep the house running: backups, machines and the task list, for Jonathan.');
    expect(aboutAskOf(h, 'art')).toBeUndefined();
    // Once: a second write needs a second ask.
    expect((await describeSelf('Something else.')).error).toBe(true);
    expect(aboutOf(h, 'art')).toBe('I keep the house running: backups, machines and the task list, for Jonathan.');
  });

  it('describe_self keeps it short (300 characters, a sentence or two) and an ask lapses after a day', async () => {
    setAboutAsk(h, 'art', new Date().toISOString());
    expect((await describeSelf('x'.repeat(301))).error).toBe(true);
    expect((await describeSelf('One. Two. Three. Four.')).body.error).toMatch(/one or two sentences/);
    expect(aboutOf(h, 'art')).toBeUndefined();
    setAboutAsk(h, 'art', new Date(Date.now() - ABOUT_ASK_MS - 1000).toISOString());
    expect(aboutAskOf(h, 'art')).toBeUndefined();
    expect((await describeSelf('I keep the house running.')).body.error).toMatch(/nobody asked/);
  });

  it('the owner\'s own words close an open ask', async () => {
    await householdAct(h, 'about-ask', { agent: 'art' });
    await householdAct(h, 'about-set', { agent: 'art', about: 'Mine.' });
    expect(aboutAskOf(h, 'art')).toBeUndefined();
    expect((await describeSelf('Theirs.')).error).toBe(true);
    expect(aboutOf(h, 'art')).toBe('Mine.');
  });
});
