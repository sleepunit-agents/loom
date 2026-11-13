import { afterEach, expect, it, vi } from 'vitest';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { openDb } from '../core/db/index.js';
import { migrateHouseholdTables } from '../core/household/schema.js';
import { HouseholdDatabase } from '../core/household/document.js';
import { createLoomServer } from '../server.js';
import { readContinuityHousehold } from './household.js';
import { personEnsure, personMergeRun, readPerson } from '../tools/person.js';

const homes: string[] = [];
const closes: (() => Promise<void>)[] = [];
afterEach(async () => {
  vi.unstubAllEnvs();
  for (const close of closes.splice(0)) await close();
  for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true });
});
function fixture() {
  const home = mkdtempSync(join(tmpdir(), 'loom-people-context-')); homes.push(home);
  for (const agent of ['art', 'mark']) {
    mkdirSync(join(home, 'agents', agent), { recursive: true });
    writeFileSync(join(home, 'agents', agent, 'IDENTITY.md'), `I am ${agent}.`);
  }
  const lease = openDb(home);
  migrateHouseholdTables(lease.db);
  lease.db.transaction(() => new HouseholdDatabase(lease.db).replace(home, { v: 1, agents: ['art', 'mark'], default: 'mark', members: [
    { person: 'jonathan', role: 'owner', agents: '*' },
    { person: 'pollock', role: 'owner', agents: ['mark'] },
  ] }))();
  lease.close();
  return home;
}
async function connect(contextDir: string, peopleSelection: Parameters<typeof createLoomServer>[0]['peopleSelection']) {
  const { server } = createLoomServer({ contextDir, peopleSelection });
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

it('keeps concurrent MCP agents owners, shared cards and private relationships with no legacy JSON', async () => {
  const home = fixture();
  const art = readContinuityHousehold(home, 'art'), mark = readContinuityHousehold(home);
  const appBytes = readFileSync(join(home, 'loom.db'));
  const a = await connect(art.contextDir, art), m = await connect(mark.contextDir, mark);
  await a('person_write', { slug: 'jonathan', name: 'Jonathan', summary: 'Art private relationship' });
  await m('person_write', { slug: 'jonathan', name: 'Jonathan', summary: 'Mark private relationship' });
  const ai = await a('identity', { people: ['jonathan'] });
  const mi = await m('identity', { people: ['jonathan'] });
  expect(ai).toContain('I am art.'); expect(mi).toContain('I am mark.');
  expect(ai).toContain('Jonathan (`jonathan`): owns the household');
  expect(ai).not.toContain('`pollock`'); expect(mi).toContain('`pollock`');
  expect(ai).toContain('Art private relationship'); expect(ai).not.toContain('Mark private relationship');
  expect(mi).toContain('Mark private relationship'); expect(mi).not.toContain('Art private relationship');
  await a('person_write', { slug: 'shared-person', name: 'Shared Name', summary: 'Art only' });
  expect(await m('person', { slug: 'shared-person' })).toContain('Shared Name');
  expect(await m('person', { slug: 'shared-person' })).not.toContain('Art only');
  expect(await m('person_list')).toContain('shared-person');
  // Card writes never touch the app metadata database.
  expect(readFileSync(join(home, 'loom.db'))).toEqual(appBytes);
});

it('explicit standalone ignores a neighbouring legacy household while omitted selection retains it', async () => {
  const home = fixture(), art = readContinuityHousehold(home, 'art');
  writeFileSync(join(home, 'household.json'), JSON.stringify({ v: 1, agents: ['art', 'mark'], default: 'art', members: [
    { person: 'legacy-owner', role: 'owner', agents: '*' },
  ] }));
  const explicit = await connect(art.contextDir, art);
  const standalone = await connect(art.contextDir, null);
  const legacy = await connect(art.contextDir, undefined);
  expect(await explicit('identity')).toContain('`jonathan`');
  expect(await explicit('identity')).not.toContain('legacy-owner');
  expect(await standalone('identity')).not.toContain('# Owners');
  expect(await legacy('identity')).toContain('`legacy-owner`');
  await standalone('person_write', { slug: 'local-only', name: 'Local Person' });
  expect(await standalone('person', { slug: 'local-only' })).toContain('Local Person');
  expect(await explicit('person', { slug: 'local-only' })).toContain('"found": false');
});

it('explicit ensure and merge keep the selected household and only the named agents relationship', () => {
  const home = fixture(), art = readContinuityHousehold(home, 'art'), mark = readContinuityHousehold(home, 'mark');
  for (const selected of [art, mark]) personEnsure(selected.contextDir, {
    slug: 'alias', name: 'Alias', source: 'test', role: `${selected.agent} relationship`,
  }, selected.agent, selected);
  personEnsure(art.contextDir, { slug: 'canonical', name: 'Canonical', source: 'test' }, 'art', art);
  expect(JSON.stringify(readPerson(art.contextDir, 'alias', false, art))).toContain('art relationship');
  const markBytes = readFileSync(join(mark.contextDir, 'memories.db'));
  const out = personMergeRun(art.contextDir, { from: 'alias', into: 'canonical' }, 'art', { onlyOwnAgent: true, selection: art });
  expect(out).toMatchObject({ from: 'alias', into: 'canonical' });
  expect(JSON.stringify(readPerson(art.contextDir, 'canonical', false, art))).toContain('Merged alias (Alias)');
  expect(readFileSync(join(mark.contextDir, 'memories.db'))).toEqual(markBytes);
  expect(JSON.stringify(readPerson(mark.contextDir, 'canonical', false, mark))).not.toContain('art relationship');
});

it('keeps explicit private stores and actors local despite global legacy overrides', async () => {
  const home = fixture();
  const art = readContinuityHousehold(home, 'art'), mark = readContinuityHousehold(home, 'mark');
  const override = join(home, 'legacy.db');
  vi.stubEnv('LOOM_SQLITE_DB_PATH', override);
  vi.stubEnv('LOOM_IDENTITY', 'unrelated-service');
  // The omitted-selection contract still uses the legacy database.
  personEnsure(art.contextDir, { slug: 'legacy-only', name: 'Legacy', source: 'test' }, 'legacy');
  const legacyBytes = readFileSync(override);
  const a = await connect(art.contextDir, art), m = await connect(mark.contextDir, mark);
  await a('person_write', { slug: 'jonathan', name: 'Jonathan', summary: 'Art private' });
  await m('person_write', { slug: 'jonathan', name: 'Jonathan', summary: 'Mark private' });
  expect(await a('person', { slug: 'jonathan' })).toContain('Art private');
  expect(await a('person', { slug: 'jonathan' })).not.toContain('Mark private');
  expect(await m('identity', { people: ['jonathan'] })).toContain('Mark private');
  expect(await m('identity', { people: ['jonathan'] })).not.toContain('Art private');
  for (const selected of [art, mark]) personEnsure(selected.contextDir, {
    slug: 'alias', name: 'Alias', source: 'test', role: `${selected.agent} relationship`,
  }, selected.agent, selected);
  personEnsure(art.contextDir, { slug: 'canonical', name: 'Canonical', source: 'test' }, 'art', art);
  const markBytes = readFileSync(join(mark.contextDir, 'memories.db'));
  const artBytes = readFileSync(join(art.contextDir, 'memories.db'));
  expect(JSON.stringify(readPerson(art.contextDir, 'alias', false, art))).toContain('art relationship');
  expect(personEnsure(art.contextDir, { slug: 'alias', name: 'Alias', source: 'test', dry_run: true }, 'art', art)).toBeTruthy();
  expect(readFileSync(join(art.contextDir, 'memories.db'))).toEqual(artBytes);
  const merged = JSON.parse(await a('person_merge', { from: 'alias', into: 'canonical' }));
  expect(merged.merged_by).toBe('art');
  expect(JSON.stringify(readPerson(art.contextDir, 'canonical', false, art))).toContain('Merged alias');
  expect(readFileSync(join(mark.contextDir, 'memories.db'))).toEqual(markBytes);
  const archived = await a('person_archive', { slug: 'canonical', reason: 'test' });
  expect(archived).not.toContain('Error:');
  const directory = new Database(art.peoplePath, { readonly: true });
  try { expect(directory.prepare('SELECT archived_by FROM people WHERE slug = ?').get('canonical')).toEqual({ archived_by: 'art' }); }
  finally { directory.close(); }
  const standalone = join(home, 'solo'); mkdirSync(standalone);
  const local = await connect(standalone, null);
  await local('person_write', { slug: 'one', name: 'One' });
  await local('person_write', { slug: 'two', name: 'Two' });
  expect(JSON.parse(await local('person_merge', { from: 'one', into: 'two' })).merged_by).toBe('solo');
  expect(await local('person_list')).not.toContain('legacy-only');
  expect(readFileSync(override)).toEqual(legacyBytes);
  expect(process.env.LOOM_SQLITE_DB_PATH).toBe(override);
  expect(process.env.LOOM_IDENTITY).toBe('unrelated-service');
});
