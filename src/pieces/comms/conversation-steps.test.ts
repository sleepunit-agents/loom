import { afterEach, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startLoom } from '../../foundation.js';
import { FakeClock, type Sharing, type Viewer } from '../../core/index.js';
import { installComms } from './index.js';
import { loadKey, type WordsKey } from './crypto.js';

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });
const member: Viewer = { kind: 'member', id: 'jonathan' };
async function setup(wrap?: (key: WordsKey) => WordsKey, configured = true) {
 const home = mkdtempSync(join(tmpdir(), 'comms-steps-'));
 const clock = new FakeClock(), base = await loadKey(home);
 let sharing: Sharing = { members: { jonathan: { owner: false, agents: ['art'] }, owner: { owner: true, agents: [] }, other: { owner: false, agents: [] } }, projects: {}, services: {} };
 const conversations = new Map([['cv-public', { agent: 'art', venue: 'discord', version: 'original' }]]);
 const key = wrap?.(base) ?? base;
 let close: () => Promise<void> = async () => {};
 const app = await startLoom({ home, clock, install: a => {
  const comms = installComms({ ...a, clock, key, days: 1, sharing: () => sharing,
   runtime: { deliver: async () => {}, end: async () => {} }, hold: async f => f(), attention: { answer: () => ({ ok: true, value: {} }) },
   ...{ conversation: configured ? (id: string) => conversations.get(id) : undefined },
  }); close = () => comms.close();
 } });
 cleanups.push(async () => { await close(); await app.close(); rmSync(home, { recursive: true, force: true }); });
 const seed = async (seq: number, conversation = 'cv-public', at = clock.now()) => {
  app.db.prepare('INSERT INTO comms_conversation_steps VALUES (?,?,?,?,?)').run(seq, conversation, at,
   await base.seal(`private label ${seq}`), await base.seal(JSON.stringify({ run: 'private-run', id: `card-${seq}`, tool: 'Shell', state: 'done', body: 'must never be exposed' })));
 };
 const read = (input: unknown = { conversation: 'cv-public' }, viewer = member, window = true, valid = () => true) => app.operations.callAsync('socket', viewer, 'comms.conversationSteps', input, undefined, window, valid);
 return { app, clock, conversations, base, read, seed, close: () => close(), revoke: () => { sharing = { ...sharing, members: { ...sharing.members, jonathan: { owner: false, agents: [] } } }; } };
}

it('reads retained encrypted conversation labels in pages of one hundred without persisting words', async () => {
 const s = await setup();
 for (let seq = 1; seq <= 103; seq++) await s.seed(seq);
 const first = await s.read();
 expect(first.ok).toBe(true);
 const steps = (first as { ok: true; value: { steps: { seq: number; text: string }[] } }).value.steps;
 expect(steps).toHaveLength(100); expect(steps[0]).toMatchObject({ seq: 4, text: 'private label 4', run: 'private-run', tool: 'Shell', state: 'done', keepUntil: s.clock.now() + 86400_000 });
 expect(steps[99].seq).toBe(103);
 expect(await s.read({ conversation: 'cv-public', before: 4 })).toMatchObject({ ok: true, value: { steps: [{ seq: 1 }, { seq: 2 }, { seq: 3 }] } });
 expect(JSON.stringify(first)).not.toContain('must never be exposed');
 expect(JSON.stringify(s.app.db.prepare('SELECT * FROM comms_conversation_steps').all())).not.toContain('private');
 expect(s.app.db.prepare("SELECT 1 FROM core_operations WHERE name='comms.conversationSteps'").get()).toBeUndefined();
});

it('denies other members, tokens, other doors and missing conversation metadata before decrypting', async () => {
 let opens = 0;
 const s = await setup(k => ({ ...k, open: async words => { opens++; return k.open(words); } }));
 await s.seed(1);
 for (const viewer of [{ kind: 'member', id: 'other' }, { kind: 'agent', id: 'art' }, { kind: 'service', id: 'runtime' }, { kind: 'runner', id: 'box' }] as Viewer[])
  expect(await s.read(undefined, viewer)).toMatchObject({ ok: false, code: 'denied' });
 expect(await s.read(undefined, member, false)).toMatchObject({ ok: false, code: 'denied' });
 for (const door of ['http', 'direct', 'mcp'] as const)
  expect(await s.app.operations.callAsync(door, member, 'comms.conversationSteps', { conversation: 'cv-public' }, undefined, true)).toMatchObject({ ok: false, code: 'denied' });
 expect(await s.read({ conversation: 'missing' })).toMatchObject({ ok: false, code: 'denied' });
 const unbound = await setup(undefined, false); await unbound.seed(1);
 expect(await unbound.read()).toMatchObject({ ok: false, code: 'denied' });
 expect(opens).toBe(0);
 // Household owners retain the ordinary non-private conversation viewer gate.
 expect(await s.read(undefined, { kind: 'member', id: 'owner' })).toMatchObject({ ok: true });
});

for (const hidden of ['loom', 'comms', 'spawn', 'thread', 'deleted'] as const) it(`denies a private conversation even to household owners (${hidden})`, async () => {
 let opens = 0;
 const s = await setup(k => ({ ...k, open: async words => { opens++; return k.open(words); } })); await s.seed(1);
 if (hidden === 'loom' || hidden === 'comms' || hidden === 'spawn') s.conversations.get('cv-public')!.venue = hidden;
 else if (hidden === 'deleted') s.app.db.prepare('INSERT INTO comms_deleted VALUES (?,?,?,?,?)').run('private', 'other', 'art', 'cv-public', s.clock.now());
 else s.app.db.prepare('INSERT INTO comms_threads VALUES (?,?,?,?,?)').run('private', 'other', 'art', null, JSON.stringify({ conversation: 'cv-public' }));
 expect(await s.read()).toMatchObject({ ok: false, code: 'denied' });
 expect(await s.read(undefined, { kind: 'member', id: 'owner' })).toMatchObject({ ok: false, code: 'denied' });
 expect(opens).toBe(0);
});

for (const boundary of ['ownership', 'deleted', 'replaced', 'private', 'row', 'session', 'closed'] as const)
 it(`rejects a conversation page changed during decryption (${boundary})`, async () => {
  let release = () => {}, started = () => {}, valid = true;
  const waiting = new Promise<void>(r => { release = r; }), began = new Promise<void>(r => { started = r; });
  const s = await setup(k => ({ ...k, open: async words => { expect(s.app.db.inTransaction).toBe(false); started(); await waiting; return k.open(words); } }));
  await s.seed(1);
  const result = s.read(undefined, member, true, () => valid); await began;
  if (boundary === 'ownership') s.revoke();
  if (boundary === 'deleted') s.conversations.delete('cv-public');
  if (boundary === 'replaced') s.conversations.get('cv-public')!.version = 'replacement';
  if (boundary === 'private') s.app.db.prepare('INSERT INTO comms_deleted VALUES (?,?,?,?,?)').run('private', 'other', 'art', 'cv-public', s.clock.now());
  if (boundary === 'row') s.app.db.prepare('UPDATE comms_conversation_steps SET record=? WHERE seq=1').run(await s.base.seal(JSON.stringify({ run: 'replacement' })));
  if (boundary === 'session') valid = false;
  if (boundary === 'closed') await s.close();
  release();
  const answer = await result;
  expect(answer).toMatchObject({ ok: false, code: boundary === 'row' ? 'conflict' : 'denied' });
  expect(JSON.stringify(answer)).not.toContain('private');
 });

it('strips every private field at the exact deadline after a later row decrypts, without relying on a sweep', async () => {
 let opens = 0, release = () => {}, started = () => {};
 const waiting = new Promise<void>(r => { release = r; }), began = new Promise<void>(r => { started = r; });
 const s = await setup(k => ({ ...k, open: async words => { if (++opens === 2) { started(); await waiting; } return k.open(words); } }));
 const now = s.clock.now(); await s.seed(1); await s.seed(2, 'cv-public', now + 1000);
 const page = s.read(); await began;
 s.clock.now = () => now + 86400_000; release();
 const answer = await page;
 expect(answer).toMatchObject({ ok: true, value: { steps: [
  { seq: 1, text: null }, { seq: 2, text: 'private label 2' },
 ] } });
 const steps = (answer as { ok: true; value: { steps: unknown[] } }).value.steps;
 expect(steps[0]).toEqual({ seq: 1, conversation: 'cv-public', at: now, keepUntil: now + 86400_000, text: null });
 // A fresh page excludes expired rows even while their ciphertext is still present.
 expect(s.app.db.prepare('SELECT words IS NOT NULL AS kept FROM comms_conversation_steps WHERE seq=1').get()).toEqual({ kept: 1 });
 expect(await s.read()).toMatchObject({ ok: true, value: { steps: [{ seq: 2 }] } });
});

it('returns routing facts for already swept words, bounds input, and hides crypto diagnostics', async () => {
 const s = await setup(); await s.seed(1); await s.seed(2, 'another-conversation');
 s.app.db.prepare('UPDATE comms_conversation_steps SET words=NULL,record=NULL WHERE seq=1').run();
 expect(await s.read()).toEqual({ ok: true, value: { steps: [{ seq: 1, conversation: 'cv-public', at: s.clock.now(), keepUntil: s.clock.now() + 86400_000, text: null }] } });
 for (const before of [0, -1, 1.2, Number.MAX_SAFE_INTEGER + 1]) expect(await s.read({ conversation: 'cv-public', before })).toMatchObject({ ok: false, code: 'invalid' });
 expect(await s.read({ conversation: 'cv-public', limit: 1000 })).toMatchObject({ ok: false, code: 'invalid' });
 const broken = await setup(k => ({ ...k, open: async () => { throw new Error('private crypto diagnostics'); } })); await broken.seed(1);
 expect(await broken.read()).toEqual({ ok: false, code: 'unavailable', message: 'Operation could not complete' });
});

it('never projects body text cards from a non-thread step envelope', async () => {
 const s = await setup(); await s.seed(1);
 s.app.db.prepare('UPDATE comms_conversation_steps SET record=?').run(await s.base.seal(JSON.stringify({ run: 'private-run', id: 'body', tool: 'text', state: 'done' })));
 expect(await s.read()).toEqual({ ok: true, value: { steps: [{ seq: 1, conversation: 'cv-public', at: s.clock.now(), keepUntil: s.clock.now() + 86400_000, text: null }] } });
});
