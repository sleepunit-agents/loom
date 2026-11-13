import { afterEach, expect, it, vi } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createFoundation } from '../../core/app.js';
import { HouseholdDatabase } from '../../core/household/document.js';
import { SharingDatabase } from '../../core/household/sharing.js';
import { migrateHouseholdTables } from '../../core/household/schema.js';
import { startLoom } from '../../foundation.js';
import { FakeClock, type Viewer } from '../../core/index.js';
import { ProjectsStore } from '../../backends/projects.js';
import { installComms } from '../comms/index.js';
import { loadKey } from '../comms/crypto.js';
import { commsMetadata } from '../comms/role.js';
import { attentionRole } from './role.js';
import { conversationId } from './conversations.js';
const owner: Viewer = {kind: 'member', id: 'owner'};
const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });
async function setup() {
  const home = mkdtempSync(join(tmpdir(), 'attention-comms-next-'));
  const metadata = createFoundation({home}); migrateHouseholdTables(metadata.db);
  metadata.db.transaction(() => new HouseholdDatabase(metadata.db).replace(home, {v: 1, agents: ['art'], owner: 'owner', members: [
    {person: 'owner', role: 'owner', agents: '*'}, {person: 'guest', role: 'member', agents: ['art']},
  ]}))();
  metadata.db.transaction(() => {
    for (const slug of ['pond', 'other']) new SharingDatabase(metadata.db, home).create({slug, name: slug, repositories: [], members: ['owner'], agents: ['art']});
  })(); metadata.close();
  mkdirSync(join(home, 'agents/art'), {recursive: true});
  const projects = new ProjectsStore({dbPath: join(home, 'agents/art/memories.db')});
  projects.write({slug: 'pond', name: 'Pond'}); projects.write({slug: 'other', name: 'Other'});
  const app = await startLoom({home, next: true, clock: new FakeClock(), stdout: () => {}});
  cleanup.push(async () => { await app.close(); projects.close(); rmSync(home, {recursive: true, force: true}); });
  const key = await loadKey(home), decrypt = vi.spyOn(key, 'open');
  const sharing = () => new SharingDatabase(app.db, home).sharing();
  // Install the real arrived role after next mode: no default key or delivery is added.
  const comms = installComms({...app, clock: app.operations.clock, key, sharing,
    runtime: {async deliver() { throw new Error('Held'); }, async end() {}},
    hold: async () => { throw new Error('Held'); }, attention: attentionRole(app.operations)});
  cleanup.push(() => comms.close());
  let seq = 0;
  const call = (verb: string, input: unknown, viewer = owner, id = `attention-comms-${++seq}`) => app.operations.call('direct', viewer, `attention.${verb}`, input, id);
  const socket = (verb: string, input: unknown) => app.operations.callAsync('socket', owner, `comms.${verb}`, input, `comms-${++seq}`, true);
  const opened = await socket('open', {agent: 'art', id: 'aaaaaaaaaaaaaaaa', text: 'Private message sentinel', project: 'pond'});
  expect(opened).toMatchObject({ok: true});
  const thread = (opened as {ok: true; value: {thread: string}}).value.thread;
  await comms.deliver('art', thread, 1); decrypt.mockClear();
  const conversation = conversationId('art', 'loom', thread);
  const record = (member?: string) => call('recordTurn', {agent: 'art', ...(member ? {member} : {}), turn: {venue: 'loom', place: thread, at: '2026-11-12T00:00:00Z', from: {kind: 'person', slug: 'owner'}, kind: 'message'}});
  const write = (id?: string, names: string[] = []) => call('writeDigest', {conversation, run: 'run-comms', digest: {summary: 'Progress.', projects: names}}, owner, id);
  const role = commsMetadata(app.operations)!;
  const scope = {id: conversation, agent: 'art', member: 'owner'};
  return {home, app, projects, comms, role, scope, thread, conversation, record, write, socket, decrypt};
}
it('uses real late-installed Comms filing before venue fallback, without decrypting words', async () => {
  const s = await setup(); expect(s.record('owner')).toMatchObject({ok: true});
  s.projects.write({slug: 'other', name: 'Other', links: {venues: [`loom:${s.thread}`]}});
  expect(s.write('stable-filing')).toMatchObject({ok: true, value: {projects: ['pond']}});
  expect(await s.socket('change', {thread: s.thread, action: 'project', project: 'other'})).toMatchObject({ok: true});
  expect(s.write('stable-filing')).toMatchObject({ok: true, value: {projects: ['pond']}});
  expect(s.write()).toMatchObject({ok: true, value: {projects: ['other']}});
  expect(s.write(undefined, ['pond'])).toMatchObject({ok: true, value: {projects: ['pond']}});
  expect(s.decrypt).not.toHaveBeenCalled();
  for (const table of ['attention_conversations', 'attention_digests', 'attention_asks', 'core_operations']) {
    expect(JSON.stringify(s.app.db.prepare(`SELECT * FROM ${table}`).all())).not.toContain('Private message sentinel');
  }
});
it('requires the exact private member and agent binding plus current thread visibility', async () => {
  const s = await setup();
  expect(s.role.threadProject(owner, s.scope)).toBe('pond');
  for (const viewer of [{kind: 'member', id: 'guest'}, {kind: 'agent', id: 'art'}, {kind: 'service', id: 'attention'}] as Viewer[]) {
    expect(s.role.threadProject(viewer, s.scope)).toBeNull();
  }
  for (const scope of [{...s.scope, member: undefined}, {...s.scope, member: 'guest'}, {...s.scope, agent: 'mark'}, {...s.scope, id: 'cv-missing'}]) {
    expect(s.role.threadProject(owner, scope)).toBeNull();
  }
  expect(s.record()).toMatchObject({ok: true});
  expect(s.write()).toMatchObject({ok: true, value: {projects: []}});
  s.app.db.transaction(() => new HouseholdDatabase(s.app.db).replace(s.home, {v: 1, agents: ['art'], owner: 'guest', members: [
    {person: 'guest', role: 'owner', agents: '*'}, {person: 'owner', role: 'member', agents: []},
  ]}))();
  expect(s.role.threadProject(owner, s.scope)).toBeNull();
  expect(s.decrypt).not.toHaveBeenCalled();
});
it('keeps archived filing, drops deleted/closed roles, and resolves only a live canonical project', async () => {
  const s = await setup(); expect(s.record('owner')).toMatchObject({ok: true});
  expect(await s.socket('change', {thread: s.thread, action: 'archive'})).toMatchObject({ok: true});
  expect(s.write()).toMatchObject({ok: true, value: {projects: ['pond']}});
  s.projects.archive({slug: 'pond', reason: 'Finished', actor: 'owner'});
  expect(s.write()).toMatchObject({ok: true, value: {projects: []}});
  expect(await s.socket('change', {thread: s.thread, action: 'delete'})).toMatchObject({ok: true});
  expect(s.role.threadProject(owner, s.scope)).toBeNull();
  await s.comms.close(); expect(s.role.threadProject(owner, s.scope)).toBeNull();
});
it('rolls back digest, asks and receipts if the metadata role fails, then permits a fresh retry', async () => {
  const s = await setup(); expect(s.record('owner')).toMatchObject({ok: true});
  const tables = ['attention_conversations', 'attention_digests', 'attention_asks', 'core_operations'];
  const snapshot = () => tables.map(table => s.app.db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all());
  const before = snapshot(), changed = vi.spyOn(s.app.live, 'changed');
  const read = vi.spyOn(s.role, 'threadProject').mockImplementationOnce(() => { throw new Error('Unavailable'); });
  expect(s.write('failed-filing')).toMatchObject({ok: false});
  expect(snapshot()).toEqual(before); expect(changed).not.toHaveBeenCalled();
  read.mockRestore();
  expect(s.write('failed-filing')).toMatchObject({ok: true, value: {projects: ['pond']}});
});
