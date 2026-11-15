import Database from 'better-sqlite3';
import { afterEach, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { FakeClock } from '../clock.js';
import { Conversations } from '../conversations/index.js';
import { createDataSchema } from '../data/database.js';
import { OperationResults } from '../data/operation-results.js';
import { DataWrites } from '../data/writes.js';
import { agents, approvals, inbox, members, operationResults, triggers } from '../data/schema.js';
import { Operations } from '../operations/index.js';
import { conversationWork } from '../../apps/conversation-work.js';
import { approvalService } from '../../apps/approvals.js';
import { createTempo } from './tempo.js';
import { registerTempoOperations, type TempoAccess } from './operations.js';
import { tempoSettingsProposals } from './proposal.js';

const closes: Array<() => void> = [];
afterEach(() => closes.splice(0).reverse().forEach(close => close()));
function fixture() {
  const client = new Database(':memory:'), clock = new FakeClock(), now = () => new Date(clock.now()).toISOString();
  const db = createDataSchema(client, now);
  db.insert(members).values({ id: 'jonathan', role: 'owner', joinedAt: now() }).run();
  db.insert(agents).values({ id: 'art', about: '', markBg: '#fff', markFg: '#000', faceShape: 'pebble', faceEyes: 'dot' }).run();
  const mail = new Conversations(db, now);
  const conversation = mail.open({ agent: 'art', venue: 'loom', place: 'thread:test', label: 'Tempo settings' });
  const admissions: string[][] = [], accesses: TempoAccess[] = [];
  const tempo = createTempo(db, clock, { conversations: mail,
    admit(_, items) { expect(client.inTransaction).toBe(false); admissions.push(items.map(i => i.id)); return true; }, operation(name) {
      if (name !== 'test.operation') throw new Error('Unknown operation');
      db.insert(inbox).values({ id: 'operation-result', state: 'waiting', toKind: 'person', to: 'jonathan', source: 'notice', fromKind: 'schedule', words: 'Operation committed', at: now(), changedAt: now() }).run();
    } });
  const writes = new DataWrites(db, { refreshAccess() {}, changed: () => tempo.committed() });
  const operations = new Operations(client, clock, () => {}, { receipts: new OperationResults(db), writes, reportError(error) { throw error; } });
  const proposals = tempoSettingsProposals(db, clock), approval = approvalService(db, new Map([proposals.operation]), now);
  let allowed = true;
  registerTempoOperations(operations, db, tempo, {
    authorize(viewer, access) { accesses.push(access); return allowed && viewer.kind === 'agent' && viewer.id === 'art'; },
    settings(viewer, who, patch) {
      expect(viewer).toEqual({ kind: 'agent', id: 'art' });
      return proposals.request(approval, who, patch, { agent: 'art', askedFrom: conversation.id, conversation: conversation.id, actingFor: 'jonathan', why: 'Requested in chat' });
    },
  });
  tempo.start();
  closes.push(() => { tempo.close(); operations.close(); client.close(); });
  const call = (name: string, input: unknown, id: string) => operations.call('mcp', { kind: 'agent', id: 'art' }, name, input, id);
  const trigger = { id: 'tr', ownerKind: 'agent', owner: 'art', sourceKind: 'time', times: now(), lifespan: 'once', targetKind: 'inbox', toKind: 'agent', to: 'art', note: 'Work', instructions: 'Check delivery' };
  return { client, db, clock, now, tempo, writes, operations, approval, call, trigger, conversation, accesses, admissions, mail, allow(value: boolean) { allowed = value; } };
}

it('dispatches a due trigger atomically with its receipt, admits after commit and rechecks authority on replay', () => {
  const f = fixture();
  f.tempo.volume.setTimings({ kind: 'agent', id: 'art' }, { settleSeconds: 0 });
  f.client.exec("CREATE TRIGGER fail_receipt BEFORE INSERT ON operation_results BEGIN SELECT RAISE(ABORT, 'receipt failed'); END");
  expect(f.call('tempo.set', f.trigger, 'set')).toMatchObject({ ok: false, code: 'unavailable' });
  expect(f.db.select().from(triggers).all()).toEqual([]);
  expect(f.db.select().from(inbox).all()).toEqual([]); expect(f.admissions).toEqual([]);
  f.client.exec('DROP TRIGGER fail_receipt');
  expect(f.call('tempo.set', f.trigger, 'set')).toEqual({ ok: true, value: { id: 'tr' } });
  expect(f.admissions).toHaveLength(1);
  expect(f.db.select().from(operationResults).all()).toHaveLength(1);
  expect(f.call('tempo.set', f.trigger, 'set')).toEqual({ ok: true, value: { id: 'tr' } });
  expect(f.admissions).toHaveLength(1);
  f.allow(false);
  expect(f.call('tempo.set', f.trigger, 'set')).toMatchObject({ ok: false, code: 'denied' });
});

it('pauses triggers, resumes held work after commit, and authorizes actions against their current row', () => {
  const f = fixture();
  expect(f.call('tempo.pause', { agent: 'art' }, 'pause').ok).toBe(true);
  expect(f.call('tempo.set', f.trigger, 'set').ok).toBe(true);
  expect(f.db.select().from(triggers).get()?.state).toBe('held');
  expect(f.call('tempo.runNow', { id: 'tr' }, 'run-held')).toMatchObject({ ok: false });
  expect(f.db.select().from(inbox).all()).toEqual([]);
  expect(f.call('tempo.resume', { agent: 'art' }, 'resume').ok).toBe(true);
  f.clock.advance(5_000); expect(f.admissions).toHaveLength(1);
  expect(f.accesses).toContainEqual(expect.objectContaining({ action: 'runNow', trigger: expect.objectContaining({ id: 'tr', state: 'held' }) }));
  expect(f.call('tempo.stop', { id: 'tr' }, 'stop').ok).toBe(true);
  expect(f.db.select().from(triggers).get()?.state).toBe('stopped');
});

it('uses the stored recipient for volume and denies unauthorized writes before any edit', () => {
  const f = fixture(), item = f.mail.send({ toKind: 'person', to: 'jonathan', source: 'notice', fromKind: 'unknown', words: 'Notice' });
  expect(f.call('inbox.volume', { item: item.id, volume: 'mute' }, 'mute').ok).toBe(true);
  expect(f.mail.item(item.id)).toMatchObject({ volume: 'mute', quietUntil: new Date(f.clock.now() + 7 * 86_400_000).toISOString() });
  f.allow(false);
  expect(f.call('inbox.volume', { item: item.id, volume: 'full' }, 'full')).toMatchObject({ ok: false, code: 'denied' });
  expect(f.mail.item(item.id).volume).toBe('mute');
  expect(f.call('inbox.volume', { item: item.id, volume: 'mute', who: { kind: 'person', id: 'other' } }, 'spoof')).toMatchObject({ ok: false, code: 'invalid' });
});

it('files exact settings before/after without applying until the shared approval is allowed', () => {
  const f = fixture(), who = { kind: 'person' as const, id: 'jonathan' };
  const input = { who, patch: { settleSeconds: 60 } };
  const result = f.call('tempo.proposeSettings', input, 'settings');
  expect(result).toMatchObject({ ok: true, value: { id: expect.any(String) } });
  expect(f.tempo.volume.timings(who).settleSeconds).toBe(5);
  const card = f.db.select().from(approvals).get()!;
  expect(card.conversation).toBe(f.conversation.id);
  const inline = conversationWork(f.db).read(f.conversation.id).approvals;
  expect(inline).toMatchObject([{ id: card.id, changeSummary: card.changeSummary, details: card.details }]);
  expect(f.db.select().from(inbox).where(eq(inbox.sourceId, card.id)).get()).toMatchObject({ conversation: f.conversation.id, to: 'jonathan', words: card.ask });
  expect(JSON.parse(card.details)).toMatchObject({ who, before: { settleSeconds: 5 }, after: { settleSeconds: 60 } });
  expect(f.call('tempo.proposeSettings', input, 'settings')).toEqual(result);
  expect(f.db.select().from(approvals).all()).toHaveLength(1);
  f.writes.run(() => f.approval.allow(card.id, 'jonathan'));
  expect(f.tempo.volume.timings(who).settleSeconds).toBe(60);
  expect(f.db.select().from(approvals).where(eq(approvals.id, card.id)).get()?.state).toBe('used');
});

it('runs an enabled future trigger now and cancellation prevents a future delivery', () => {
  const f = fixture(), future = new Date(f.clock.now() + 60_000).toISOString();
  expect(f.call('tempo.set', { ...f.trigger, times: future }, 'future').ok).toBe(true);
  expect(f.call('tempo.runNow', { id: 'tr' }, 'run-now').ok).toBe(true);
  expect(f.db.select().from(inbox).all()).toHaveLength(1);
  expect(f.call('tempo.runNow', { id: 'tr' }, 'run-now').ok).toBe(true);
  expect(f.db.select().from(inbox).all()).toHaveLength(1);
  expect(f.call('tempo.set', { ...f.trigger, id: 'cancel', times: future }, 'cancel-future').ok).toBe(true);
  expect(f.call('tempo.stop', { id: 'cancel' }, 'cancel').ok).toBe(true);
  f.clock.advance(60_000);
  expect(f.db.select().from(inbox).all()).toHaveLength(1);
});

it('refuses forged settings provenance before filing any card', () => {
  const f = fixture(), input = { who: { kind: 'person', id: 'jonathan' }, patch: { settleSeconds: 60 } };
  for (const key of ['agent', 'actingFor', 'askedFrom', 'conversation', 'member', 'operation', 'details'])
    expect(f.call('tempo.proposeSettings', { ...input, [key]: 'forged' }, `forged-${key}`)).toMatchObject({ ok: false, code: 'invalid' });
  expect(f.db.select().from(approvals).all()).toEqual([]);
});

it('never accepts an internal-looking caller name as installed authority', () => {
  const f = fixture(); f.allow(false);
  const input = { agent: 'art' };
  expect(f.operations.call('direct', { kind: 'service', id: 'tempo' }, 'tempo.pause', input, 'fake')).toMatchObject({ ok: false, code: 'denied' });
  const builtIn = f.operations.internal('tempo');
  expect(builtIn.call('tempo.pause', input, 'real')).toMatchObject({ ok: true });
  // A proved handle still cannot be presented on an outside transport.
  expect(f.operations.call('mcp', builtIn.viewer, 'tempo.resume', input, 'outside')).toMatchObject({ ok: false, code: 'denied' });
});


it('runs a synchronous operation target in the receipt transaction and rolls it back on receipt failure', () => {
  const f = fixture(), future = new Date(f.clock.now() + 60_000).toISOString();
  const input = { ...f.trigger, targetKind: 'operation', target: 'test.operation', times: future };
  expect(f.call('tempo.set', input, 'set-operation').ok).toBe(true);
  f.client.exec("CREATE TRIGGER fail_receipt BEFORE INSERT ON operation_results BEGIN SELECT RAISE(ABORT, 'receipt failed'); END");
  expect(f.call('tempo.runNow', { id: 'tr' }, 'run-operation')).toMatchObject({ ok: false, code: 'unavailable' });
  expect(f.db.select().from(inbox).all()).toEqual([]);
  expect(f.db.select().from(triggers).get()?.state).toBe('standing');
  f.client.exec('DROP TRIGGER fail_receipt');
  expect(f.call('tempo.runNow', { id: 'tr' }, 'run-operation').ok).toBe(true);
  expect(f.db.select().from(inbox).all()).toMatchObject([{ id: 'operation-result', words: 'Operation committed' }]);
  expect(f.call('tempo.runNow', { id: 'tr' }, 'run-operation').ok).toBe(true);
  expect(f.db.select().from(inbox).all()).toHaveLength(1);
});
