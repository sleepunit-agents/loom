import { afterEach, expect, it, vi } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createFoundation } from '../../core/app.js';
import { HouseholdDatabase } from '../../core/household/document.js';
import { migrateHouseholdTables } from '../../core/household/schema.js';
import { startLoom } from '../../foundation.js';
import { FakeClock, type Viewer } from '../../core/index.js';
import { ProjectsStore } from '../../backends/projects.js';
import { conversationId } from './conversations.js';
const owner: Viewer = { kind: 'member', id: 'owner' };
const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => { for (const close of cleanup.splice(0)) await close(); });
async function setup() {
  const home = mkdtempSync(join(tmpdir(), 'attention-projects-next-'));
  const metadata = createFoundation({ home }); migrateHouseholdTables(metadata.db);
  metadata.db.transaction(() => new HouseholdDatabase(metadata.db).replace(home, { v: 1, agents: ['art', 'mark'], default: 'art', owner: 'owner', members: [{ person: 'owner', role: 'owner', agents: '*' }, { person: 'guest', role: 'member', agents: ['art'] }] }))(); metadata.close();
  for (const agent of ['art', 'mark']) mkdirSync(join(home, 'agents', agent), { recursive: true });
  const art = new ProjectsStore({ dbPath: join(home, 'agents/art/memories.db') });
  const mark = new ProjectsStore({ dbPath: join(home, 'agents/mark/memories.db') });
  art.write({ slug: 'pond', name: 'Pond', links: { aliases: ['on-pond'], venues: ['loom:thread-1'] } });
  art.write({ slug: 'old', name: 'Old' }); art.archive({ slug: 'old', reason: 'Finished', actor: 'owner' });
  mark.write({ slug: 'other', name: 'Other', links: { aliases: ['on-pond'], venues: ['loom:thread-1'] } });
  const app = await startLoom({ home, next: true, clock: new FakeClock() });
  cleanup.push(async () => { await app.close(); art.close(); mark.close(); rmSync(home, { recursive: true, force: true }); });
  let seq = 0;
  const call = (verb: string, input: unknown, viewer = owner, id = `next-project-${++seq}`) => app.operations.call('direct', viewer, `attention.${verb}`, input, id);
  const conversation = conversationId('art', 'loom', 'thread-1');
  expect(call('recordTurn', { agent: 'art', turn: { venue: 'loom', place: 'thread-1', at: '2026-11-12T00:00:00Z', from: { kind: 'person', slug: 'owner' }, kind: 'message' } })).toMatchObject({ ok: true });
  const write = (projects: string[] = [], viewer = owner, id?: string) => call('writeDigest', { conversation, run: 'run-1', digest: { summary: 'Progress.', projects, needs_owner: 'Which direction?' } }, viewer, id);
  const snapshot = () => ['attention_conversations', 'attention_digests', 'attention_asks', 'core_operations'].map(table => app.db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all());
  return { app, art, mark, call, write, snapshot, conversation };
}
it('composes the real Projects role for agent-local aliases and exactly one live venue match', async () => {
  const { write, art } = await setup();
  expect(write(['on-pond', 'pond'])).toMatchObject({ ok: true, value: { projects: ['pond'] } });
  expect(write()).toMatchObject({ ok: true, value: { projects: ['pond'] } });
  art.write({ slug: 'second', name: 'Second', links: { venues: ['loom:thread-1'] } });
  expect(write()).toMatchObject({ ok: true, value: { projects: [] } });
  art.archive({ slug: 'second', reason: 'Finished', actor: 'owner' });
  expect(write()).toMatchObject({ ok: true, value: { projects: ['pond'] } });
  art.archive({ slug: 'pond', reason: 'Finished', actor: 'owner' });
  expect(write()).toMatchObject({ ok: true, value: { projects: [] } });
});
it('refuses unknown, archived and other-agent names atomically without superseding an ask', async () => {
  const { app, write, snapshot } = await setup(); expect(write(['pond'])).toMatchObject({ ok: true });
  const before = snapshot(), changed = vi.spyOn(app.live, 'changed');
  for (const name of ['missing', 'old', 'other']) expect(write([name])).toMatchObject({ ok: false, code: 'invalid' });
  expect(snapshot()).toEqual(before); expect(changed).not.toHaveBeenCalled();
});
it('uses the original caller visibility and retains the original resolution on committed retry', async () => {
  const { write, art } = await setup(); const guest: Viewer = { kind: 'member', id: 'guest' };
  const first = write(['on-pond'], guest, 'stable-project'); expect(first).toMatchObject({ ok: true, value: { projects: ['pond'] } });
  art.archive({ slug: 'pond', reason: 'Finished', actor: 'owner' });
  expect(write(['on-pond'], guest, 'stable-project')).toEqual(first);
  expect(write(['on-pond'], guest)).toMatchObject({ ok: false, code: 'invalid' });
});
