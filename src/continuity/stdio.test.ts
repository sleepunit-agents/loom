import { afterEach, expect, it, vi } from 'vitest';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createStdioServer, isCliInvocation } from '../index.js';
import { nextStdioConfig, isNextStdioInvocation } from './stdio.js';
import { openDb } from '../core/db/index.js';
import { migrateHouseholdTables } from '../core/household/schema.js';
import { HouseholdDatabase } from '../core/household/document.js';
import { closeAllBackends } from '../backends/index.js';

vi.mock('../backends/fastembed.js', () => ({ FastEmbedProvider: class {
  readonly dimensions = 384;
  async embed(text: string) { const v = new Array(384).fill(0); for (let i = 0; i < text.length; i++) v[i % 384] += text.charCodeAt(i) / 1000; return v; }
  async embedBatch(texts: string[]) { return Promise.all(texts.map(t => this.embed(t))); }
} }));
const homes: string[] = [], closes: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of closes.splice(0)) await close();
  closeAllBackends(); vi.unstubAllEnvs();
  for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true });
});
function fixture() {
  const home = mkdtempSync(join(tmpdir(), 'loom-stdio-')); homes.push(home);
  for (const agent of ['art', 'mark']) {
    const dir = join(home, 'agents', agent); mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'IDENTITY.md'), `I am ${agent}.`);
  }
  const lease = openDb(home); migrateHouseholdTables(lease.db);
  lease.db.transaction(() => new HouseholdDatabase(lease.db).replace(home, { v: 1, agents: ['art', 'mark'], default: 'mark', members: [
    { person: 'jonathan', role: 'owner', agents: '*' }, { person: 'pollock', role: 'owner', agents: ['mark'] },
  ] }))();
  lease.close();
  return home;
}
async function connect(args: string[]) {
  const { server } = createStdioServer(args);
  const client = new Client({ name: 'stdio-acceptance', version: '1' });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await server.connect(a); await client.connect(b);
  closes.push(async () => { await client.close(); await server.close(); });
  return async (name: string, input: Record<string, unknown> = {}) => {
    const r = await client.callTool({ name, arguments: input });
    expect(r.isError, JSON.stringify(r.content)).not.toBe(true);
    return (r.content as { text: string }[]).map(c => c.text).join('\n');
  };
}
const page = { slug: 'shared-fact', title: 'Shared fact', domain: 'software', body: 'Household knowledge',
  citations: [{ claim: 'Supported', source_kind: 'repo', source_locator: 'fixture', excerpt: 'Evidence' }] };

it.each([false, true])('serves two agents and standalone with the daemon stopped (contradictory old JSON: %s)', async poisoned => {
  const home = fixture();
  const solo = join(home, 'standalone'); mkdirSync(solo); writeFileSync(join(solo, 'IDENTITY.md'), 'I am solo.');
  // The old files existed and have been removed before the continuity run.
  for (const file of ['household.json', 'tokens.json', 'tokens.used.json', 'ui-sessions.json']) {
    writeFileSync(join(home, file), '{}'); rmSync(join(home, file));
  }
  if (poisoned) {
    writeFileSync(join(home, 'household.json'), JSON.stringify({ v: 1, agents: ['art', 'mark'], default: 'art', members: [{ person: 'wrong-owner', role: 'owner', agents: '*' }] }));
    writeFileSync(join(home, 'tokens.json'), 'invalid legacy tokens');
  }
  const appBytes = readFileSync(join(home, 'loom.db'));
  mkdirSync(join(home, 'wrong-context')); writeFileSync(join(home, 'wrong-context', 'IDENTITY.md'), 'Wrong legacy identity.');
  const override = join(home, 'wrong-memory.db'), wrongKnowledge = join(home, 'wrong-knowledge.db');
  vi.stubEnv('LOOM_SQLITE_DB_PATH', override); vi.stubEnv('LOOM_KNOWLEDGE_DB_PATH', wrongKnowledge);
  vi.stubEnv('LOOM_IDENTITY', 'wrong-agent'); vi.stubEnv('LOOM_HOME', join(home, 'wrong-home'));
  vi.stubEnv('LOOM_AGENT', 'wrong-agent'); vi.stubEnv('LOOM_CONTEXT_DIR', join(home, 'wrong-context'));
  const a = await connect(['mcp', '--next', '--home', home, '--agent', 'art']);
  const m = await connect(['--next', '--home', home]);
  const s = await connect(['mcp', '--next', '--context-dir', solo]);
  const calls = [a, m, s];
  for (const [i, call] of calls.entries()) {
    await call('remember', { category: 'reference', title: `Private ${i}`, content: `Private body ${i}` });
    await call('person_write', { slug: 'jonathan', name: 'Jonathan', summary: `Relationship ${i}` });
  }
  await a('knowledge_write', page);
  await s('knowledge_write', { ...page, body: 'Standalone knowledge' });
  for (const [i, call] of calls.entries()) {
    const identity = await call('identity', { people: ['jonathan'] });
    expect(identity).toContain(`I am ${['art', 'mark', 'solo'][i]}.`);
    expect(identity).toContain(`Relationship ${i}`);
    expect(identity).not.toContain('wrong-owner');
    if (i < 2) expect(identity).toContain('Jonathan (`jonathan`): owns the household');
    else expect(identity).not.toContain('# Owners');
    if (i === 1) expect(identity).toContain('`pollock`'); else expect(identity).not.toContain('`pollock`');
    const memories = await call('memory_list');
    expect(memories).toContain(`Private ${i}`);
    expect(await call('recall', { query: 'private' })).toContain(`Private ${i}`);
    for (let j = 0; j < 3; j++) if (j !== i) {
      expect(memories).not.toContain(`Private ${j}`); expect(identity).not.toContain(`Relationship ${j}`);
    }
    expect(await call('knowledge_recall', { slug: page.slug })).toContain(i === 2 ? 'Standalone knowledge' : 'Household knowledge');
    expect(await call('person', { slug: 'jonathan' })).toContain(`Relationship ${i}`);
  }
  await a('person_write', { slug: 'shared-person', name: 'Shared Name', summary: 'Art private' });
  const shared = await m('person', { slug: 'shared-person' });
  expect(shared).toContain('Shared Name'); expect(shared).not.toContain('Art private');
  expect(await s('person', { slug: 'shared-person' })).toContain('"found": false');
  expect(readFileSync(join(home, 'loom.db'))).toEqual(appBytes);
  expect(existsSync(override)).toBe(false); expect(existsSync(wrongKnowledge)).toBe(false);
  expect(process.env.LOOM_IDENTITY).toBe('wrong-agent');
}, 30_000);

it('requires explicit opt-in and target, keeps serve and legacy routing, and refuses malformed selections', () => {
  expect(isNextStdioInvocation([])).toBe(false);
  expect(isNextStdioInvocation(['serve', '--next'])).toBe(false);
  expect(isCliInvocation(['node', 'loom', 'serve', '--next'])).toBe(true);
  expect(() => nextStdioConfig(['mcp'])).toThrow('requires --next');
  expect(() => nextStdioConfig(['--next'])).toThrow('explicit');
  expect(() => nextStdioConfig(['--next', '--home'])).toThrow();
  expect(() => nextStdioConfig(['--next', '--bogus'])).toThrow();
  const home = fixture();
  expect(() => nextStdioConfig(['--next', '--home', home, '--agent', 'ghost'])).toThrow('not in the household');
  expect(nextStdioConfig(['--next', '--home', home]).memorySelection).toEqual({ agent: 'mark' });
});

it('leaves the unflagged stdio entrypoint on its existing environment and JSON configuration', async () => {
  const home = fixture();
  writeFileSync(join(home, 'household.json'), JSON.stringify({ v: 1, agents: ['art', 'mark'], default: 'art', members: [{ person: 'legacy-owner', role: 'owner', agents: '*' }] }));
  vi.stubEnv('LOOM_CONTEXT_DIR', join(home, 'agents/art'));
  const legacy = await connect([]);
  const identity = await legacy('identity');
  expect(identity).toContain('I am art.');
  expect(identity).toContain('`legacy-owner`');
  expect(identity).not.toContain('`jonathan`');
});
