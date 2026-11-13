import { afterEach, expect, it, vi } from 'vitest';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createLoomServer, type LoomServerConfig } from '../server.js';
import { closeAllBackends, createBackend } from '../backends/index.js';

vi.mock('../backends/fastembed.js', () => ({
  FastEmbedProvider: class {
    readonly dimensions = 384;
    async embed(text: string) {
      const vector = new Array(384).fill(0);
      for (let i = 0; i < text.length; i++) vector[i % 384] += text.charCodeAt(i) / 1000;
      return vector;
    }
    async embedBatch(texts: string[]) { return Promise.all(texts.map(text => this.embed(text))); }
  },
}));
const homes: string[] = [];
const closes: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of closes.splice(0)) await close();
  closeAllBackends();
  vi.unstubAllEnvs();
  for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true });
});
async function connect(contextDir: string, memorySelection: LoomServerConfig['memorySelection']) {
  const { server } = createLoomServer({ contextDir, memorySelection });
  const client = new Client({ name: 'continuity-test', version: '1' });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await server.connect(a); await client.connect(b);
  closes.push(async () => { await client.close(); await server.close(); });
  return async (name: string, args: Record<string, unknown> = {}) => {
    const result = await client.callTool({ name, arguments: args });
    expect(result.isError, JSON.stringify(result.content)).not.toBe(true);
    return (result.content as { text: string }[]).map(c => c.text).join('\n');
  };
}
it('routes concurrent MCP memory reads and writes to each selected context despite a global legacy override', async () => {
  const home = mkdtempSync(join(tmpdir(), 'loom-memory-context-')); homes.push(home);
  const dirs = ['art', 'mark', 'solo'].map(agent => {
    const dir = join(home, agent); mkdirSync(dir); writeFileSync(join(dir, 'IDENTITY.md'), `I am ${agent}.`); return dir;
  });
  const override = join(home, 'legacy.db');
  vi.stubEnv('LOOM_SQLITE_DB_PATH', override);
  const legacy = createBackend(dirs[0]);
  await legacy.remember({ category: 'reference', title: 'Legacy only', content: 'Legacy private' });
  closeAllBackends();
  const before = readFileSync(override);
  const calls = await Promise.all(dirs.map((dir, i) => connect(dir, i === 2 ? null : { agent: ['art', 'mark'][i] })));
  await Promise.all(calls.map((call, i) => call('remember', { category: 'reference', title: `Private ${i}`, content: `Unique private body ${i}` })));
  for (const [i, call] of calls.entries()) {
    const backend = createBackend(dirs[i], null);
    const [entry] = await backend.list({ limit: 20 });
    const ref = entry.ref;
    for (const name of ['memory_list', 'recall', 'find_similar']) {
      const text = await call(name, name === 'recall' ? { query: 'private' } : name === 'find_similar' ? { text: 'private', min_relevance: 0 } : {});
      expect(text).toContain(`Private ${i}`);
      for (let j = 0; j < 3; j++) if (j !== i) expect(text).not.toContain(`Private ${j}`);
      expect(text).not.toContain('Legacy only');
    }
    await call('update', { ref, content: `Revised body ${i}` });
    const [revision] = await backend.listRevisions(ref);
    expect(await call('memory_history', { ref, revision_id: revision.id })).toContain(`Unique private body ${i}`);
    await call('memory_revision_restore', { ref, revision_id: revision.id });
    expect((await backend.recall({ query: 'private', limit: 10 }))[0].content).toBe(`Unique private body ${i}`);
    await call('memory_archive', { ref }); expect(await backend.list({})).toHaveLength(0);
    await call('memory_restore', { ref }); expect(await backend.list({})).toHaveLength(1);
    await call('remember', { category: 'reference', title: `Loser ${i}`, content: `Merge source ${i}` });
    const loser = (await backend.list({})).find(row => row.title === `Loser ${i}`)!;
    await call('memory_merge', { source_refs: [loser.ref], target_ref: ref });
    expect(await backend.list({})).toHaveLength(1);
    expect(await call('memory_audit')).toContain('1');
    await call('memory_prune', { dry_run: true });
    expect(await backend.list({})).toHaveLength(1);
    await call('forget', { ref }); expect(await backend.list({ category: 'reference' })).toHaveLength(0);
  }
  closeAllBackends();
  expect(readFileSync(override)).toEqual(before);
  expect(process.env.LOOM_SQLITE_DB_PATH).toBe(override);
  // Omitted callers retain their existing override and cache key.
  expect((await createBackend(dirs[1]).list({})).map(row => row.title)).toEqual(['Legacy only']);
  expect(createBackend(dirs[0], null)).not.toBe(createBackend(dirs[1], { agent: 'mark' }));
  expect(createBackend(dirs[0], null)).toBe(createBackend(dirs[0], { agent: 'art' }));
});
