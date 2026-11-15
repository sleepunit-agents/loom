import { Conversations } from '../conversations/index.js';
import { expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { and, eq } from 'drizzle-orm';
import { createDataSchema } from '../data/database.js';
import { agents, approvals, conversations, inbox, members, triggerLog, triggers } from '../data/schema.js';
import { FakeClock } from '../clock.js';
import { createTempo, type TempoConversations } from './tempo.js';

it('publishes committed dim and mute expiry to subscriptions without an unrelated trigger or inbox write', () => {
  const client = new Database(':memory:'), db = createDataSchema(client), clock = new FakeClock();
  const at = new Date(clock.now()).toISOString();
  db.insert(members).values({ id: 'jonathan', role: 'owner', joinedAt: at }).run();
  for (const id of ['dimmed', 'muted']) db.insert(inbox).values({ id, toKind: 'person', to: 'jonathan', source: 'notice', fromKind: 'unknown', words: id, at, changedAt: at, state: 'waiting' }).run();
  const snapshots: string[][] = [];
  const tempo = createTempo(db, clock, {
    conversations: { open: () => { throw new Error('No trigger'); }, send: () => { throw new Error('No trigger'); } },
    admit: () => true, operation: () => { throw new Error('No operation'); },
    changed: () => { snapshots.push(db.select().from(inbox).all().map(item => item.volume)); },
  });
  try {
    const who = { kind: 'person' as const, id: 'jonathan' };
    const until = new Date(clock.now() + 10_000).toISOString();
    tempo.volume.set(who, 'dimmed', 'dim', until);
    tempo.volume.set(who, 'muted', 'mute', until);
    tempo.start(); snapshots.length = 0;
    clock.advance(9_999); expect(snapshots).toEqual([]);
    clock.advance(1); expect(snapshots).toEqual([['full', 'full']]);
    expect(db.select().from(inbox).all().every(item => item.quietUntil === null && item.changedAt === at)).toBe(true);
    clock.advance(60_000); expect(snapshots).toHaveLength(1);
  } finally { tempo.close(); client.close(); }
});
it('composes trigger/sweep delivery through conversations and only admits a settled inbox', () => {
  const client = new Database(':memory:');
  const db = createDataSchema(client), clock = new FakeClock(), at = () => new Date(clock.now()).toISOString();
  db.insert(agents).values({ id: 'art', about: '', markBg: '#fff', markFg: '#000', faceShape: 'pebble', faceEyes: 'dot' }).run();
  // Persistence-only adapter: the Conversations implementation owns these writes.
  const mail: TempoConversations = {
    open(input) {
      const old = db.select().from(conversations).where(eq(conversations.place, input.place)).get();
      if (old) return old;
      return db.insert(conversations).values({ ...input, id: input.place, turnCount: 0, startedAt: at(), lastAt: at() }).returning().get();
    },
    send(input) {
      const old = db.select().from(inbox).where(and(eq(inbox.source, input.source), eq(inbox.sourceId, input.sourceId))).get();
      if (old) return old;
      const { refs: _, ...values } = input;
      return db.insert(inbox).values({ ...values, id: input.sourceId, state: 'waiting', at: at(), changedAt: at() }).returning().get();
    },
  };
  const admitted: string[][] = [];
  const tempo = createTempo(db, clock, { conversations: mail, admit: (_, items) => { admitted.push(items.map(i => i.words!)); return true; }, operation: () => { throw new Error('Unknown operation'); } });
  try {
    tempo.sweep.register({ name: 'Tasks', open: () => [{ id: 't-1', words: 'Pick a pump', openedAt: at() }] });
    tempo.start(); clock.advance(10_000); expect(admitted).toEqual([]);
    tempo.triggers.set({ ownerKind: 'agent', owner: 'art', sourceKind: 'time', times: new Date(clock.now() + 1_000).toISOString(), lifespan: 'once', targetKind: 'operation', target: 'tempo.sweep', toKind: 'agent', to: 'art', note: 'Sweep' });
    clock.advance(1_000); expect(admitted).toEqual([]);
    expect(db.select().from(inbox).all()).toMatchObject([{ source: 'notice', conversation: 'sweep:art', state: 'waiting' }]);
    clock.advance(5_000); expect(admitted).toHaveLength(1); expect(admitted[0][0]).toContain('Pick a pump');
    tempo.triggers.set({ ownerKind: 'agent', owner: 'art', sourceKind: 'answer', watches: 'approval:1', lifespan: 'once', targetKind: 'inbox', toKind: 'agent', to: 'art', instructions: 'Continue', note: 'Approved work' });
    tempo.triggers.event('answer', 'approval:1', 'allowed'); clock.advance(4_999); expect(admitted).toHaveLength(1);
    clock.advance(1); expect(admitted).toHaveLength(2); expect(admitted[1]).toContain('Continue');
    expect(db.select().from(conversations).all()).toHaveLength(2);
  } finally { tempo.close(); client.close(); }
});

it('recovers a committed answer missed by its callback, holds it while paused, and never repeats it after restart', () => {
  const client = new Database(':memory:'), db = createDataSchema(client), clock = new FakeClock();
  const at = () => new Date(clock.now()).toISOString();
  db.insert(agents).values({ id: 'art', about: '', markBg: '#fff', markFg: '#000', faceShape: 'pebble', faceEyes: 'dot' }).run();
  db.insert(approvals).values({ id: 'a', kind: 'command', target: 'test', what: 'test', why: 'test', agent: 'art', askedFrom: 'test', actingFor: 'art', state: 'pending', minutes: 1, ask: 'Run?', ifYes: 'Run', ifNo: 'Stop', details: '', askedAt: at() }).run();
  const deliveries: string[] = [];
  const options = {
    conversations: { open: () => { throw new Error('Operation needs no conversation'); }, send: () => { throw new Error('Operation needs no inbox'); } },
    admit: () => true,
    operation: (_: string, _trigger: unknown, occurrence: string) => { deliveries.push(occurrence); },
  };
  let tempo = createTempo(db, clock, options);
  try {
    tempo.triggers.set({ id: 'wait', ownerKind: 'agent', owner: 'art', sourceKind: 'answer', watches: 'approval:a', lifespan: 'until-stopped', targetKind: 'operation', target: 'test', note: 'Wait for approval' });
    tempo.triggers.pause('art');
    tempo.close();
    // Source commits, then the process dies before sources.approval can run.
    db.update(approvals).set({ state: 'allowed', decidedAt: at() }).where(eq(approvals.id, 'a')).run();
    tempo = createTempo(db, clock, options);
    tempo.start(); tempo.start();
    expect(deliveries).toEqual([]);
    expect(db.select().from(triggerLog).all().filter(row => row.event === 'observed')).toHaveLength(1);
    tempo.triggers.resume('art');
    expect(deliveries).toHaveLength(1);
    tempo.sources.approval('a');
    tempo.close();
    tempo = createTempo(db, clock, options);
    tempo.start(); tempo.sources.approval('a');
    expect(deliveries).toHaveLength(1);
    expect(db.select().from(triggerLog).all().filter(row => row.event === 'fired')).toHaveLength(1);
  } finally { tempo.close(); client.close(); }
});

it('stops recovery when the first source callback closes Tempo and its shared database', () => {
  const client = new Database(':memory:'), db = createDataSchema(client), clock = new FakeClock();
  const at = new Date(clock.now()).toISOString();
  db.insert(agents).values({ id: 'art', about: '', markBg: '#fff', markFg: '#000', faceShape: 'pebble', faceEyes: 'dot' }).run();
  for (const id of ['first', 'second']) {
    db.insert(approvals).values({ id, kind: 'command', target: 'test', what: 'test', why: 'test', agent: 'art', askedFrom: 'test', actingFor: 'art', state: 'allowed', decidedAt: at, minutes: 1, ask: 'Run?', ifYes: 'Run', ifNo: 'Stop', details: '', askedAt: at }).run();
    db.insert(inbox).values({ id, toKind: 'agent', to: 'art', source: 'notice', fromKind: 'unknown', state: 'waiting', at, changedAt: at }).run();
    db.insert(triggers).values({ id, sourceKind: 'answer', watches: `approval:${id}`, ownerKind: 'household', targetKind: 'operation', target: 'test', lifespan: 'once', note: id, enabled: true, state: 'standing', createdAt: at, changedAt: at }).run();
  }
  let publications = 0;
  const delivered: string[] = [];
  const tempo = createTempo(db, clock, {
    conversations: { open: () => { throw new Error('No conversation'); }, send: () => { throw new Error('No delivery'); } },
    admit: () => true,
    operation: (_, trigger) => { delivered.push(trigger.id); },
    changed: () => { publications++; tempo.close(); client.close(); },
  });
  try {
    expect(() => tempo.start()).not.toThrow();
    expect(delivered).toEqual(['first']);
    expect(publications).toBe(1);
    expect(() => tempo.start()).not.toThrow();
    expect(() => tempo.changed()).not.toThrow();
    for (const id of ['first', 'second']) {
      expect(() => tempo.sources.approval(id)).not.toThrow();
      expect(() => tempo.sources.question(id)).not.toThrow();
      expect(() => tempo.sources.secret(id)).not.toThrow();
      expect(() => tempo.sources.job(id)).not.toThrow();
      expect(() => tempo.sources.change(id, 'revision')).not.toThrow();
    }
    expect(() => tempo.sources.recover(() => { throw new Error('Closed reader'); })).not.toThrow();
    clock.advance(60_000);
    expect(publications).toBe(1);
  } finally { tempo.close(); if (client.open) client.close(); }
});

it('never starts recovery or publishes after close before startup', () => {
  const client = new Database(':memory:'), db = createDataSchema(client), clock = new FakeClock();
  let publications = 0;
  const tempo = createTempo(db, clock, {
    conversations: { open: () => { throw new Error('Closed'); }, send: () => { throw new Error('Closed'); } },
    admit: () => { throw new Error('Closed'); }, operation: () => { throw new Error('Closed'); },
    changed: () => { publications++; },
  });
  tempo.close(); client.close();
  expect(() => tempo.start()).not.toThrow();
  expect(() => tempo.changed()).not.toThrow();
  expect(publications).toBe(0);
});

it.each(['changed', 'start'] as const)('suppresses publication when %s admission synchronously closes Tempo', entry => {
  const client = new Database(':memory:'), db = createDataSchema(client), clock = new FakeClock();
  const at = new Date(clock.now()).toISOString();
  db.insert(members).values({ id: 'jonathan', role: 'owner', joinedAt: at }).run();
  db.insert(inbox).values({ id: 'waiting', toKind: 'person', to: 'jonathan', source: 'notice', fromKind: 'unknown', state: 'waiting', at, changedAt: at }).run();
  let publications = 0, admissions = 0;
  const tempo = createTempo(db, clock, {
    conversations: { open: () => { throw new Error('No trigger'); }, send: () => { throw new Error('No trigger'); } },
    admit: () => { admissions++; tempo.close(); client.close(); return true; },
    operation: () => { throw new Error('No trigger'); },
    changed: () => { publications++; db.select().from(inbox).all(); },
  });
  tempo.volume.setTimings({ kind: 'person', id: 'jonathan' }, { settleSeconds: 0 });
  try {
    expect(() => tempo[entry]()).not.toThrow();
    expect(admissions).toBe(1);
    expect(publications).toBe(0);
    clock.advance(60_000);
    expect(admissions).toBe(1);
  } finally { tempo.close(); if (client.open) client.close(); }
});

it('does not admit or publish provisional trigger writes before the shared receipt transaction commits', () => {
  const client = new Database(':memory:'), clock = new FakeClock(), db = createDataSchema(client);
  const now = () => new Date(clock.now()).toISOString();
  db.insert(agents).values({ id: 'art', about: '', markBg: '#fff', markFg: '#000', faceShape: 'pebble', faceEyes: 'dot' }).run();
  const admissions: string[][] = [], published: number[] = [];
  const tempo = createTempo(db, clock, { conversations: new Conversations(db, now),
    admit(_, items) { expect(client.inTransaction).toBe(false); admissions.push(items.map(i => i.words!)); return true; },
    operation() {}, changed() { expect(client.inTransaction).toBe(false); published.push(1); } });
  const trigger = { ownerKind: 'agent' as const, owner: 'art', sourceKind: 'time' as const, times: now(), lifespan: 'once' as const,
    targetKind: 'inbox' as const, toKind: 'agent' as const, to: 'art', instructions: 'Committed work', note: 'Receipt' };
  try {
    tempo.volume.setTimings({ kind: 'agent', id: 'art' }, { settleSeconds: 0 });
    tempo.start(); published.length = 0;
    expect(() => db.transaction(() => {
      tempo.triggers.set({ ...trigger, id: 'rollback' });
      expect(db.select().from(inbox).all()).toEqual([]);
      expect(admissions).toEqual([]); expect(published).toEqual([]);
      throw new Error('receipt failed');
    })).toThrow('receipt failed');
    clock.advance(0);
    expect(db.select().from(inbox).all()).toEqual([]); expect(admissions).toEqual([]);
    db.transaction(() => {
      tempo.triggers.set({ ...trigger, id: 'commit' });
      expect(db.select().from(inbox).all()).toEqual([]);
      expect(admissions).toEqual([]); expect(published).toEqual([]);
    });
    tempo.committed();
    expect(admissions).toEqual([['Committed work']]);
    expect(published.length).toBeGreaterThan(0);
    expect(db.select().from(triggers).all()).toMatchObject([{ id: 'commit', state: 'fired' }]);
    tempo.committed();
    expect(admissions).toHaveLength(1);
    expect(() => db.transaction(() => tempo.committed())).toThrow('after commit');
  } finally { tempo.close(); client.close(); }
});

it('refreshes watched answers after shared commits without repeating a durable occurrence', () => {
  const client = new Database(':memory:'), db = createDataSchema(client), clock = new FakeClock();
  const now = () => new Date(clock.now()).toISOString();
  db.insert(agents).values({ id: 'art', about: '', markBg: '#fff', markFg: '#000', faceShape: 'pebble', faceEyes: 'dot' }).run();
  db.insert(approvals).values({ id: 'a', kind: 'command', target: 'test', what: 'test', why: 'test', agent: 'art', askedFrom: 'test', actingFor: 'art', state: 'pending', minutes: 1, ask: 'Run?', ifYes: 'Run', ifNo: 'Stop', details: '', askedAt: now() }).run();
  const occurrences: string[] = [];
  const tempo = createTempo(db, clock, { conversations: new Conversations(db, now), admit: () => false,
    operation(_, _trigger, occurrence) { expect(client.inTransaction).toBe(true); occurrences.push(occurrence); } });
  try {
    tempo.triggers.set({ id: 'wait', ownerKind: 'agent', owner: 'art', sourceKind: 'answer', watches: 'approval:a', lifespan: 'until-stopped', targetKind: 'operation', target: 'test', note: 'Answer' });
    tempo.start();
    expect(() => db.transaction(() => {
      db.update(approvals).set({ state: 'allowed', decidedAt: now() }).where(eq(approvals.id, 'a')).run();
      tempo.sources.approval('a');
      expect(occurrences).toEqual([]);
      throw new Error('rollback');
    })).toThrow('rollback');
    tempo.committed(); expect(occurrences).toEqual([]);
    db.transaction(() => db.update(approvals).set({ state: 'allowed', decidedAt: now() }).where(eq(approvals.id, 'a')).run());
    tempo.committed(); expect(occurrences).toHaveLength(1);
    tempo.committed(); expect(occurrences).toHaveLength(1);
  } finally { tempo.close(); client.close(); }
});
