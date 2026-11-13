import { afterEach, expect, it, vi } from 'vitest';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createLoomServer, type LoomServerConfig } from '../server.js';
import BetterSqlite3 from 'better-sqlite3';
import { episodeRows, tapeForContext } from '../backends/episodes.js';
import { digestData, digestForContext } from '../backends/salience.js';
import { getProposal, listProposals, propose } from '../backends/proposals.js';
import { recordTurn, writeDigest } from '../backends/conversations.js';
import { openProjectsStore } from '../backends/projects.js';
import { projectHubOf, readProject, projectHistoryOf, listProjects, projectOrphans } from '../tools/project.js';
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
async function connect(contextDir: string, memorySelection: LoomServerConfig['memorySelection'], extra: Partial<LoomServerConfig> = {}) {
  const { server } = createLoomServer({ contextDir, memorySelection, ...extra });
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
// Three MCP clients exercise complete lifecycles on real SQLite stores;
// the five-second unit-test default is too short on a loaded CI runner.
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
}, 30_000);

it('isolates raw tape, identity, salience and proposal operations for two agents and standalone beside a legacy override', async () => {
  const home = mkdtempSync(join(tmpdir(), 'loom-memory-readers-')); homes.push(home);
  const dirs = ['art', 'mark', 'solo', 'legacy'].map(agent => {
    const dir = join(home, agent); mkdirSync(dir); writeFileSync(join(dir, 'IDENTITY.md'), `I am ${agent}.`); return dir;
  });
  // Seed independent stores before poisoning the process-wide legacy selector.
  for (const [i, dir] of dirs.entries()) {
    const backend = createBackend(dir, null);
    await backend.remember({ category: 'reference', title: `Canon ${i}`, content: `Private authored body ${i}` });
    await backend.remember({ category: 'episode', title: `Episode ${i}`, content: `Private tape body ${i}` });
    propose(dir, { category: 'reference', title: `Draft ${i}`, content: `Private draft body ${i}` });
    const { conversation } = recordTurn(dir, ['art', 'mark', 'solo', 'legacy'][i], {
      venue: 'terminal', place: `place-${i}`, at: new Date().toISOString(), from: { kind: 'agent', id: `agent-${i}` }, kind: 'message',
    }, 'test');
    writeDigest(dir, { conversation, run: `run-${i}` }, { summary: `Digest ${i}` });
    const projects = openProjectsStore(dir)!;
    projects.write({ slug: 'loom', name: `Project ${i}` }); projects.close();
  }
  closeAllBackends();
  const override = join(dirs[3], 'memories.db');
  const before = readFileSync(override);
  vi.stubEnv('LOOM_SQLITE_DB_PATH', override);
  vi.stubEnv('LOOM_IDENTITY', 'legacy');
  const calls = await Promise.all(dirs.slice(0, 3).map((dir, i) => connect(dir, i === 2 ? null : { agent: ['art', 'mark'][i] })));
  for (const [i, call] of calls.entries()) {
    const selection = i === 2 ? null : { agent: ['art', 'mark'][i] };
    expect(episodeRows(dirs[i], { memorySelection: selection }).map(r => r.title)).toEqual([`Episode ${i}`]);
    expect(digestData(dirs[i], 40, Date.now(), selection)?.atoms.map(r => r.title)).toEqual([`Canon ${i}`]);
    for (const text of [
      tapeForContext(dirs[i], { memorySelection: selection }),
      await call('episodes'),
      await call('identity', { pieces: ['last-24h', 'top-of-mind'] }),
    ]) {
      expect(text).toContain(`Episode ${i}`); expect(text).toContain(`Digest ${i}`);
      for (let j = 0; j < 4; j++) if (j !== i) {
        expect(text).not.toContain(`Episode ${j}`); expect(text).not.toContain(`Digest ${j}`); expect(text).not.toContain(`Canon ${j}`);
      }
    }
    // House filtering still applies independently of the selected private store.
    expect(tapeForContext(dirs[i], { memorySelection: selection, onlyConversation: null })).not.toContain(`Digest ${i}`);
    expect(tapeForContext(dirs[i], { memorySelection: selection, onlyConversation: 'cv-000000000000' })).not.toContain(`Digest ${i}`);
    const identity = await call('identity', { project: 'loom' });
    expect(identity).toContain(`Canon ${i}`); expect(identity).toContain(`Project ${i}`);
    expect(identity).not.toContain('Canon 3'); expect(identity).not.toContain('Project 3');
    // Recompute must write the selected DB, not just read the right digest.
    const db = new BetterSqlite3(join(dirs[i], 'memories.db'));
    db.prepare('UPDATE memories SET salience = -1').run(); db.close();
    expect(await call('memory_recompute_salience')).toContain('recomputed salience for 2 memories');
    const checked = new BetterSqlite3(join(dirs[i], 'memories.db'), { readonly: true });
    expect(checked.prepare('SELECT 1 FROM memories WHERE salience = -1').get()).toBeUndefined(); checked.close();
    expect(await call('memory_proposals')).toContain(`Draft ${i}`);
    expect(await call('memory_proposals')).not.toContain('Draft 3');
    expect(await call('memory_ratify', { id: 1 })).toContain('ratified');
    expect(getProposal(dirs[i], 1, selection)).toBeNull();
    expect((await createBackend(dirs[i], selection).list({})).map(r => r.title)).toContain(`Draft ${i}`);
    expect(await call('memory_propose', { category: 'reference', title: `Reject ${i}`, content: 'discard me' })).toContain('Proposal staged');
    const [draft] = listProposals(dirs[i], selection);
    expect(draft.title).toBe(`Reject ${i}`);
    expect(await call('memory_reject', { id: draft.id })).toContain('rejected and removed');
    expect(listProposals(dirs[i], selection)).toEqual([]);
  }
  closeAllBackends();
  expect(readFileSync(override)).toEqual(before);
  expect(process.env.LOOM_SQLITE_DB_PATH).toBe(override);
  expect(process.env.LOOM_IDENTITY).toBe('legacy');
  // Omission still selects the legacy store, including the old tape/digest helpers.
  expect(episodeRows(dirs[0]).map(r => r.title)).toEqual(['Episode 3']);
  expect(tapeForContext(dirs[0])).toContain('Digest 3');
  expect(digestForContext(dirs[0])).toContain('Canon 3');
  expect(listProposals(dirs[0]).map(r => r.title)).toEqual(['Draft 3']);
}, 30_000);


it('isolates project cards, hub memories, counts, revisions and writes beside a poisoned legacy selector', async () => {
  const home = mkdtempSync(join(tmpdir(), 'loom-project-context-')); homes.push(home);
  const dirs = ['art', 'mark', 'solo', 'legacy'].map(agent => {
    const dir = join(home, agent); mkdirSync(dir); writeFileSync(join(dir, 'IDENTITY.md'), `I am ${agent}.`); return dir;
  });
  for (const [i, dir] of dirs.entries()) {
    const backend = createBackend(dir, null);
    await backend.remember({ category: 'project', title: `Hub private ${i}`, content: `Selected memory ${i}`, project: 'alias' });
    await backend.remember({ category: 'reference', title: `Orphan private ${i}`, content: 'unfiled', project: `orphan-${i}` });
    const projects = openProjectsStore(dir, { selection: null })!;
    projects.write({ slug: 'loom', name: `Project ${i}`, links: { aliases: ['alias'] }, where: { now: { value: `Work ${i}` } } });
    projects.close();
  }
  closeAllBackends();
  const override = join(dirs[3], 'memories.db');
  const before = readFileSync(override);
  vi.stubEnv('LOOM_SQLITE_DB_PATH', override);
  vi.stubEnv('LOOM_IDENTITY', 'legacy');
  const calls = await Promise.all(dirs.slice(0, 3).map((dir, i) => connect(dir, i === 2 ? null : { agent: ['art', 'mark'][i] }, {
    peopleSelection: null, conversationSelection: null,
  })));
  for (const [i, call] of calls.entries()) {
    const hub = JSON.parse(await call('project_hub', { slug: 'alias' }));
    expect(hub).toMatchObject({ found: true, resolved_from: 'alias', card: { name: `Project ${i}` } });
    expect(hub.sections.find((s: { key: string }) => s.key === 'memories')).toMatchObject({ total: 1, counts: { project: 1 }, items: [{ snippet: `Hub private ${i} — Selected memory ${i}` }] });
    for (let j = 0; j < 4; j++) if (j !== i) expect(JSON.stringify(hub)).not.toContain(`Hub private ${j}`);
    expect(JSON.parse(await call('project_list'))).toMatchObject([{ name: `Project ${i}`, memories_since_synthesis: 1 }]);
    expect(JSON.parse(await call('project_orphans'))).toEqual([{ tag: `orphan-${i}`, count: 1 }]);
    expect(JSON.parse(await call('project', { slug: 'alias' })).card.name).toBe(`Project ${i}`);
    await call('project_write', { slug: 'alias', name: `Changed ${i}` });
    const history = JSON.parse(await call('project_history', { slug: 'loom' }));
    expect(history.revisions).toHaveLength(1);
    expect(history.revisions[0].actor).toBe(['art', 'mark', 'solo'][i]);
    await call('project_revision_restore', { slug: 'loom', revision_id: history.revisions[0].id });
    expect(JSON.parse(await call('project', { slug: 'loom' })).card.name).toBe(`Project ${i}`);
    await call('project_verify', { slug: 'loom', fields: ['now'], source: `Witness ${i}` });
    expect(JSON.parse(await call('project', { slug: 'loom' })).card.where.now.source).toBe(`Witness ${i}`);
    await call('project_archive', { slug: 'loom', reason: 'retired for test' });
    expect(JSON.parse(await call('project_list'))).toEqual([]);
    const store = openProjectsStore(dirs[i], { readonly: true, selection: null })!;
    expect(store.resolve('loom')!.row.archived_by).toBe(['art', 'mark', 'solo'][i]); store.close();
    await call('project_restore', { slug: 'loom' });
    expect(JSON.parse(await call('project_list'))).toMatchObject([{ name: `Project ${i}` }]);
  }
  closeAllBackends();
  expect(readFileSync(override)).toEqual(before);
  expect(process.env.LOOM_SQLITE_DB_PATH).toBe(override);
  expect(process.env.LOOM_IDENTITY).toBe('legacy');
  // Existing callers still follow the old override when selection is omitted.
  const legacyCall = await connect(dirs[0], undefined, { peopleSelection: null, conversationSelection: null });
  expect(JSON.parse(await legacyCall('project', { slug: 'loom' })).card.name).toBe('Project 3');
  expect(await legacyCall('project_hub', { slug: 'loom' })).toContain('Hub private 3');
}, 30_000);


it('does not fall back to a legacy project store when an explicitly selected private database is absent', async () => {
  const home = mkdtempSync(join(tmpdir(), 'loom-project-absent-')); homes.push(home);
  const selected = join(home, 'selected'); mkdirSync(selected);
  const legacy = join(home, 'legacy'); mkdirSync(legacy);
  const store = openProjectsStore(legacy, { selection: null })!;
  store.write({ slug: 'loom', name: 'Legacy project' }); store.close();
  vi.stubEnv('LOOM_SQLITE_DB_PATH', join(legacy, 'memories.db'));
  for (const selection of [null, { agent: 'selected' }]) {
    expect(readProject(selected, 'loom', false, selection)).toEqual({ found: false });
    expect(projectHistoryOf(selected, 'loom', selection)).toEqual({ revisions: [] });
    expect(listProjects(selected, {}, selection)).toEqual([]);
    expect(projectOrphans(selected, selection)).toEqual([]);
    expect(await projectHubOf(selected, { slug: 'loom' }, { memorySelection: selection })).toEqual({ found: false });
  }
  expect(readProject(selected, 'loom')).toMatchObject({ found: true, card: { name: 'Legacy project' } });
});
