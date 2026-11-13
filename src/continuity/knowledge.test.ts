import { afterEach, expect, it, vi } from 'vitest';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync, existsSync, linkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { openDb } from '../core/db/index.js';
import { migrateHouseholdTables } from '../core/household/schema.js';
import { HouseholdDatabase } from '../core/household/document.js';
import { createLoomServer, type LoomServerConfig } from '../server.js';
import { readContinuityHousehold } from './household.js';
import { assertKnowledgePathsNotCoLocated, resolveKnowledgeDbPath } from '../config.js';

const homes: string[] = [];
const closes: (() => Promise<void>)[] = [];
afterEach(async () => {
  vi.unstubAllEnvs();
  for (const close of closes.splice(0)) await close();
  for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true });
});
function fixture() {
  const home = mkdtempSync(join(tmpdir(), 'loom-knowledge-context-')); homes.push(home);
  for (const agent of ['art', 'mark']) mkdirSync(join(home, 'agents', agent), { recursive: true });
  const lease = openDb(home); migrateHouseholdTables(lease.db);
  lease.db.transaction(() => new HouseholdDatabase(lease.db).replace(home, {
    v: 1, agents: ['art', 'mark'], default: 'mark', members: [{ person: 'jonathan', role: 'owner', agents: '*' }],
  }))(); lease.close();
  return home;
}
async function connect(config: LoomServerConfig) {
  const { server } = createLoomServer(config);
  const client = new Client({ name: 'continuity-test', version: '1' });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await server.connect(a); await client.connect(b);
  closes.push(async () => { await client.close(); await server.close(); });
  return async (name: string, args: Record<string, unknown> = {}) => {
    const r = await client.callTool({ name, arguments: args });
    expect(r.isError).not.toBe(true);
    return (r.content as { text: string }[]).map(c => c.text).join('\n');
  };
}
const page = (slug: string, body = 'Original body') => ({ slug, title: slug, domain: 'software', body,
  citations: [{ claim: 'Supported', source_kind: 'repo', source_locator: 'test', excerpt: 'Evidence' }],
});

it('routes every MCP knowledge tool to the explicit commons while the app is stopped', async () => {
  const home = fixture();
  const art = readContinuityHousehold(home, 'art'), mark = readContinuityHousehold(home, 'mark');
  const appBytes = readFileSync(join(home, 'loom.db'));
  const a = await connect({ contextDir: art.contextDir, peopleSelection: art, knowledgeSelection: art });
  const m = await connect({ contextDir: mark.contextDir, peopleSelection: mark, knowledgeSelection: mark });
  expect(await a('person_write', { slug: 'jane', name: 'Jane', summary: 'Private relationship' })).not.toContain('Error:');
  await m('person_write', { slug: 'other', name: 'Other' });
  expect(await a('knowledge_write', page('jane'))).not.toContain('Error:');
  expect(await m('knowledge_recall', { slug: 'jane' })).toContain('Original body');
  expect(await m('knowledge_list')).toContain('jane');
  expect(await m('knowledge_maintain')).toContain('names card `jane`');
  expect(await m('knowledge_maintain')).not.toContain('Private relationship');
  expect(await m('knowledge_verify', { slug: 'jane', freshness_anchor: 'fixture' })).not.toContain('Error:');
  expect(await m('knowledge_list')).toContain('fixture');
  await a('knowledge_write', page('jane', 'Replacement body'));
  expect(await m('knowledge_history', { slug: 'jane' })).toContain('jane');
  expect(await m('knowledge_history', { slug: 'jane', revision_id: 1, restore: true })).not.toContain('Error:');
  expect(await a('knowledge_recall', { slug: 'jane' })).toContain('Original body');
  expect(await m('knowledge_move', { slug: 'jane', new_slug: 'renamed' })).not.toContain('Error:');
  expect(await a('knowledge_recall', { slug: 'renamed' })).toContain('Original body');
  await a('knowledge_write', page('target'));
  expect(await m('knowledge_supersede', { old_slug: 'renamed', new_slug: 'target' })).not.toContain('Error:');
  expect(await m('knowledge_list')).not.toContain('renamed');
  expect(await a('knowledge_restore', { slug: 'renamed' })).not.toContain('Error:');
  expect(await m('knowledge_merge', { source_slugs: ['renamed'], target_slug: 'target' })).not.toContain('Error:');
  expect(await a('knowledge_purge', { slugs: ['renamed'], confirm: true })).not.toContain('Error:');
  expect(await a('knowledge_history', { slug: 'renamed' })).not.toContain('Original body');
  expect(await m('knowledge_archive', { slug: 'target' })).not.toContain('Error:');
  expect(await a('knowledge_list')).not.toContain('target');
  expect(await a('knowledge_restore', { slug: 'target' })).not.toContain('Error:');
  expect(await m('knowledge_list')).toContain('target');
  expect(readFileSync(join(home, 'loom.db'))).toEqual(appBytes);
  for (const selected of [art, mark]) expect(existsSync(join(selected.contextDir, 'knowledge.db'))).toBe(false);
});

it('explicit standalone and household selection ignore contradictory legacy discovery', async () => {
  const home = fixture(), selected = readContinuityHousehold(home, 'art');
  writeFileSync(join(home, 'household.json'), JSON.stringify({ v: 1, agents: ['art', 'mark'], default: 'art', members: [{ person: 'jonathan', role: 'owner', agents: '*' }] }));
  const local = await connect({ contextDir: selected.contextDir, knowledgeSelection: null, peopleSelection: null });
  const shared = await connect({ contextDir: selected.contextDir, knowledgeSelection: selected, peopleSelection: selected });
  const legacy = await connect({ contextDir: selected.contextDir });
  await local('knowledge_write', page('local-only'));
  await shared('knowledge_write', page('commons-only'));
  expect(await local('knowledge_list')).toContain('local-only');
  expect(await local('knowledge_list')).not.toContain('commons-only');
  expect(await shared('knowledge_list')).not.toContain('local-only');
  expect(await legacy('knowledge_list')).toContain('commons-only');
  expect(resolveKnowledgeDbPath(selected.contextDir, null)).toBe(join(selected.contextDir, 'knowledge.db'));
});

it('applies isolation checks to the selected path including hard links', () => {
  const home = fixture(), selected = readContinuityHousehold(home, 'art');
  mkdirSync(join(home, 'commons'), { recursive: true });
  writeFileSync(join(selected.contextDir, 'memories.db'), 'same inode');
  linkSync(join(selected.contextDir, 'memories.db'), selected.knowledgePath);
  expect(() => assertKnowledgePathsNotCoLocated(selected.contextDir, selected)).toThrow('hard-linked');
  expect(() => assertKnowledgePathsNotCoLocated(selected.contextDir, null)).not.toThrow();
});

it('explicit knowledge selection bypasses the legacy environment override', () => {
  const home = fixture(), selected = readContinuityHousehold(home, 'art');
  const override = join(home, 'legacy-override.db');
  vi.stubEnv('LOOM_KNOWLEDGE_DB_PATH', override);
  expect(resolveKnowledgeDbPath(selected.contextDir)).toBe(override);
  expect(resolveKnowledgeDbPath(selected.contextDir, selected)).toBe(selected.knowledgePath);
  expect(resolveKnowledgeDbPath(selected.contextDir, null)).toBe(join(selected.contextDir, 'knowledge.db'));
});

it('explicit isolation cannot be bypassed by a memory environment override', () => {
  const home = fixture(), selected = readContinuityHousehold(home, 'art');
  mkdirSync(join(home, 'commons'), { recursive: true });
  writeFileSync(join(selected.contextDir, 'memories.db'), 'same inode');
  linkSync(join(selected.contextDir, 'memories.db'), selected.knowledgePath);
  vi.stubEnv('LOOM_SQLITE_DB_PATH', join(home, 'unrelated.db'));
  expect(() => assertKnowledgePathsNotCoLocated(selected.contextDir, selected)).toThrow('hard-linked');
  linkSync(join(selected.contextDir, 'memories.db'), join(selected.contextDir, 'knowledge.db'));
  expect(() => assertKnowledgePathsNotCoLocated(selected.contextDir, null)).toThrow('hard-linked');
});

it('explicit isolation still protects the active legacy memory override', () => {
  const home = fixture(), selected = readContinuityHousehold(home, 'art');
  vi.stubEnv('LOOM_SQLITE_DB_PATH', selected.knowledgePath);
  expect(() => assertKnowledgePathsNotCoLocated(selected.contextDir, selected)).toThrow('same as memory');
  vi.stubEnv('LOOM_KNOWLEDGE_DB_PATH', selected.knowledgePath);
  expect(() => assertKnowledgePathsNotCoLocated(selected.contextDir)).toThrow('same as memory');
});

it('attributes explicit MCP knowledge activity to selected agents despite a global identity', async () => {
  const home = fixture();
  const art = readContinuityHousehold(home, 'art'), mark = readContinuityHousehold(home, 'mark');
  vi.stubEnv('LOOM_IDENTITY', 'unrelated-service');
  const a = await connect({ contextDir: art.contextDir, knowledgeSelection: art });
  const m = await connect({ contextDir: mark.contextDir, knowledgeSelection: mark });
  await a('knowledge_write', page('attributed'));
  await m('knowledge_write', page('attributed', 'Updated by Mark'));
  await m('knowledge_verify', { slug: 'attributed', freshness_anchor: 'fixture' });
  await a('knowledge_recall', { slug: 'attributed' });
  const db = new Database(art.knowledgePath, { readonly: true });
  try {
    expect(db.prepare('SELECT author FROM pages WHERE slug = ?').get('attributed')).toEqual({ author: 'art' });
    expect(db.prepare('SELECT actor FROM page_revisions').all()).toEqual([{ actor: 'mark' }]);
    expect(db.prepare('SELECT verifier FROM verifications').all()).toEqual([{ verifier: 'mark' }]);
    expect(db.prepare('SELECT identity FROM knowledge_access').all()).toEqual([{ identity: 'art' }]);
  } finally { db.close(); }
  const local = await connect({ contextDir: art.contextDir, knowledgeSelection: null });
  await local('knowledge_write', page('local-attributed'));
  const localDb = new Database(join(art.contextDir, 'knowledge.db'), { readonly: true });
  try {
    expect(localDb.prepare('SELECT author FROM pages').all()).toEqual([{ author: 'art' }]);
  } finally { localDb.close(); }
});
