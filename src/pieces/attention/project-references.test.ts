import { afterEach, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fixture, fixtureSharing } from '../../fixture.js';
import { startLoom } from '../../foundation.js';
import { FakeClock, failure, type Viewer } from '../../core/index.js';
import { installAttention } from './index.js';
import { conversationId } from './conversations.js';
import type { DigestReferences } from './project-references.js';
const owner: Viewer = { kind: 'member', id: 'jonathan' };
const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => { for (const close of cleanup.splice(0)) await close(); });
function roles() {
  const names = new Map([['pond', 'pond'], ['on-pond', 'pond'], ['hockey', 'hockey']]);
  const projects = {
    resolve: vi.fn((_viewer: Viewer, name: string) => ({ ok: true as const, value: names.get(name) ?? null })),
    byVenue: vi.fn((_viewer: Viewer, _venue: string) => ({ ok: true as const, value: ['hockey'] })),
  };
  const threadProject = vi.fn(() => ({ ok: true as const, value: 'pond' as string | null }));
  return { projects, threadProject };
}
async function setup(references: DigestReferences = {}) {
  const home = mkdtempSync(join(tmpdir(), 'attention-projects-')); fixture(home);
  const app = await startLoom({ home, next: true, clock: new FakeClock(), sharing: fixtureSharing,
    install: app => installAttention(app.db, app.operations, app.live, fixtureSharing, references) });
  cleanup.push(async () => { await app.close(); rmSync(home, { recursive: true, force: true }); });
  let seq = 0;
  const call = (name: string, input: unknown, id = `project-${++seq}`) => app.operations.call('direct', owner, `attention.${name}`, input, id);
  expect(call('recordTurn', { agent: 'art', member: 'jonathan', turn: { venue: 'loom', place: 'thread-1', at: '2026-11-12T00:00:00Z', from: { kind: 'person', slug: 'jonathan' }, kind: 'message' } })).toMatchObject({ ok: true });
  const conversation = conversationId('art', 'loom', 'thread-1');
  const write = (projects: string[] = [], id?: string, run = 'run-1') => call('writeDigest', { conversation, run, digest: { summary: 'Progress.', projects, needs_owner: 'Which direction?' } }, id);
  const snapshot = () => ['attention_conversations', 'attention_digests', 'attention_asks', 'core_operations'].map(table => app.db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all());
  return { app, call, write, conversation, snapshot };
}
it('resolves aliases, deduplicates canonical names, preserves reference union and immutable private audience', async () => {
  const refs = roles(), { write, call, conversation } = await setup(refs);
  expect(write(['on-pond', 'pond', 'hockey'])).toMatchObject({ ok: true, value: { projects: ['pond', 'hockey'], member: 'jonathan', agent: 'art' } });
  expect(refs.projects.resolve).toHaveBeenCalledWith(owner, 'on-pond');
  expect(refs.threadProject).not.toHaveBeenCalled(); expect(refs.projects.byVenue).not.toHaveBeenCalled();
  expect(write(['hockey'], undefined, 'run-2')).toMatchObject({ ok: true });
  expect(write(['pond'])).toMatchObject({ ok: true });
  expect(call('conversation', { id: conversation })).toMatchObject({ value: { projects: ['hockey', 'pond'], member: 'jonathan' } });
});
it('uses the visible thread canonical project before venue fallback, without a caller input for it', async () => {
  const refs = roles(), { write, conversation } = await setup(refs);
  expect(write()).toMatchObject({ value: { projects: ['pond'] } });
  expect(refs.threadProject).toHaveBeenCalledWith(owner, expect.objectContaining({ id: conversation, member: 'jonathan' }));
  expect(refs.projects.byVenue).not.toHaveBeenCalled();
});
it('falls back from missing, archived or noncanonical thread projects to exactly one live venue match', async () => {
  const refs = roles(), { write } = await setup(refs);
  for (const project of [null, 'archived', 'on-pond']) {
    refs.threadProject.mockReturnValue({ ok: true, value: project });
    expect(write()).toMatchObject({ value: { projects: ['hockey'] } });
  }
  expect(refs.projects.byVenue).toHaveBeenCalledWith(owner, 'loom:thread-1');
  for (const value of [[], ['pond', 'hockey']]) {
    refs.projects.byVenue.mockReturnValue({ ok: true, value });
    expect(write()).toMatchObject({ value: { projects: [] } });
  }
});
it('keeps names and has no fallbacks when the Projects role is absent', async () => {
  const threadProject = vi.fn(() => ({ ok: true as const, value: 'pond' }));
  const { write } = await setup({ threadProject });
  expect(write(['on-pond', 'on-pond'])).toMatchObject({ value: { projects: ['on-pond'] } });
  expect(write()).toMatchObject({ value: { projects: [] } });
  expect(threadProject).not.toHaveBeenCalled();
});
it('refuses unknown names before superseding asks and preserves rows, receipts and notifications', async () => {
  const refs = roles(), { app, write, snapshot } = await setup(refs);
  expect(write(['pond'])).toMatchObject({ ok: true });
  const before = snapshot(), changed = vi.spyOn(app.live, 'changed');
  expect(write(['missing'])).toMatchObject({ code: 'invalid' });
  expect(snapshot()).toEqual(before); expect(changed).not.toHaveBeenCalled();
});
it('propagates lookup refusals without fallback or partial writes, and retries retain original resolution', async () => {
  const refs: DigestReferences = roles(), { app, write, snapshot } = await setup(refs);
  const first = write(['pond'], 'stable'); expect(first).toMatchObject({ ok: true });
  refs.projects!.resolve = () => failure('denied', 'Lookup refused');
  expect(write(['pond'], 'stable')).toEqual(first);
  const before = snapshot(), changed = vi.spyOn(app.live, 'changed');
  expect(write(['pond'])).toMatchObject({ code: 'denied' });
  refs.threadProject = () => failure('unavailable', 'Thread unavailable');
  expect(write()).toMatchObject({ code: 'unavailable' });
  refs.threadProject = () => ({ ok: true, value: 'pond' });
  const byVenue = vi.spyOn(refs.projects!, 'byVenue');
  expect(write()).toMatchObject({ code: 'denied' });
  expect(byVenue).not.toHaveBeenCalled();
  refs.threadProject = () => ({ ok: true, value: null });
  refs.projects!.byVenue = () => failure('denied', 'Venue refused');
  expect(write()).toMatchObject({ code: 'denied' });
  expect(snapshot()).toEqual(before); expect(changed).not.toHaveBeenCalled();
});
