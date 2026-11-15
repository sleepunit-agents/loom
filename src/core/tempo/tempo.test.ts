import { expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { eq } from 'drizzle-orm';
import { createDataSchema } from '../data/database.js';
import { agents, approvals, conversations, inbox, jobs, members, triggerLog, triggers } from '../data/schema.js';
import { FakeClock } from '../clock.js';
import { createTempo } from './tempo.js';
import { Conversations } from '../conversations/index.js';
import { tempoSettingsService } from './settings.js';

it('publishes committed dim and mute expiry to subscriptions without an unrelated trigger or inbox write', () => {
  const client = new Database(':memory:'), db = createDataSchema(client), clock = new FakeClock();
  const at = new Date(clock.now()).toISOString();
  db.insert(members).values({ id: 'jonathan', role: 'owner', joinedAt: at }).run();
  const mail = new Conversations(db, () => new Date(clock.now()).toISOString());
  const dimmed = mail.send({ toKind: 'person', to: 'jonathan', source: 'notice', fromKind: 'unknown', words: 'Dimmed' });
  const muted = mail.send({ toKind: 'person', to: 'jonathan', source: 'notice', fromKind: 'unknown', words: 'Muted' });
  const snapshots: string[][] = [];
  const notified: string[][] = [];
  const tempo = createTempo(db, clock, {
    conversations: mail,
    admit: (who, items) => { expect(who).toEqual({ kind: 'person', id: 'jonathan' }); notified.push(items.map(item => item.id)); return true; },
    operation: () => { throw new Error('No operation'); },
    changed: () => { snapshots.push(db.select().from(inbox).all().map(item => item.volume)); },
  });
  try {
    const who = { kind: 'person' as const, id: 'jonathan' };
    const until = new Date(clock.now() + 10_000).toISOString();
    tempo.volume.set(who, dimmed.id, 'dim', until);
    tempo.volume.set(who, muted.id, 'mute', until);
    tempo.start(); snapshots.length = 0;
    clock.advance(9_999); expect(snapshots).toEqual([]);
    clock.advance(1); expect(snapshots).toEqual([['full', 'full']]);
    expect(db.select().from(inbox).all().every(item => item.quietUntil === null && item.changedAt === at)).toBe(true);
    // The original dimmed notification remains one line; expiration makes a
    // new full-volume batch with the previously hidden item after settling.
    expect(notified).toEqual([[dimmed.id]]);
    clock.advance(4_999); expect(notified).toHaveLength(1);
    clock.advance(1); expect(notified).toHaveLength(2);
    expect(notified[1]).toEqual(expect.arrayContaining([dimmed.id, muted.id]));
    clock.advance(60_000); expect(snapshots).toHaveLength(1);
  } finally { tempo.close(); client.close(); }
});
it('composes trigger/sweep delivery through conversations and only admits a settled inbox', () => {
  const client = new Database(':memory:');
  const db = createDataSchema(client), clock = new FakeClock(), at = () => new Date(clock.now()).toISOString();
  db.insert(agents).values({ id: 'art', about: '', markBg: '#fff', markFg: '#000', faceShape: 'pebble', faceEyes: 'dot' }).run();
  const mail = new Conversations(db, at);
  const admitted: string[][] = [];
  const tempo = createTempo(db, clock, { conversations: mail, admit: (_, items) => { admitted.push(items.map(i => i.words!)); return true; }, operation: () => { throw new Error('Unknown operation'); } });
  try {
    tempo.sweep.register({ name: 'Tasks', open: () => [{ id: 't-1', words: 'Pick a pump', openedAt: at() }] });
    tempo.start(); clock.advance(10_000); expect(admitted).toEqual([]);
    tempo.triggers.set({ ownerKind: 'agent', owner: 'art', sourceKind: 'time', times: new Date(clock.now() + 1_000).toISOString(), lifespan: 'once', targetKind: 'operation', target: 'tempo.sweep', toKind: 'agent', to: 'art', note: 'Sweep' });
    clock.advance(1_000); expect(admitted).toEqual([]);
    expect(db.select().from(inbox).all()).toMatchObject([{ source: 'notice', state: 'waiting' }]);
    expect(db.select().from(conversations).all()).toMatchObject([{ agent: 'art', venue: 'wake', place: 'sweep:art' }]);
    expect(db.select().from(inbox).all()[0].conversation).toBe(db.select().from(conversations).all()[0].id);
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

it('settles real conversation mail, retries capacity, and takes only audible items after a committed timing change', () => {
  const client = new Database(':memory:'), db = createDataSchema(client), clock = new FakeClock();
  const at = () => new Date(clock.now()).toISOString();
  db.insert(agents).values({ id: 'art', about: '', markBg: '#fff', markFg: '#000', faceShape: 'pebble', faceEyes: 'dot' }).run();
  const mail = new Conversations(db, at), settings = tempoSettingsService(db, clock);
  const cv = mail.open({ agent: 'art', venue: 'loom', place: 'pump', label: 'Pump' });
  let capacity = false, attempts = 0;
  const taken: string[][] = [];
  const tempo = createTempo(db, clock, {
    conversations: mail,
    operation: () => { throw new Error('No operation'); },
    admit(who, items) {
      expect(who).toEqual({ kind: 'agent', id: 'art' });
      expect(items.every(item => item.conversation === cv.id)).toBe(true);
      attempts++;
      if (!capacity) return false;
      db.insert(jobs).values({ id: 'job', agent: 'art', conversation: cv.id, title: 'Pump', state: 'running', brief: '', model: 'test', startedByKind: 'agent', startedBy: 'art', houseRepository: '', houseFile: '', houseBranch: '', queuedAt: at() }).run();
      db.update(conversations).set({ job: 'job' }).where(eq(conversations.id, cv.id)).run();
      taken.push(mail.take(cv.id, 'job').map(item => item.id));
      // The root publishes claims after committing; this synchronous callback
      // also exercises settling's reentrant capacity notification boundary.
      tempo.changed();
      return true;
    },
  });
  try {
    const send = (words: string) => mail.send({ toKind: 'agent', to: 'art', conversation: cv.id, source: 'thread', fromKind: 'person', words });
    const dim = send('One line'), muted = send('Later');
    const who = { kind: 'agent' as const, id: 'art' };
    tempo.volume.set(who, dim.id, 'dim');
    tempo.volume.set(who, muted.id, 'mute', new Date(clock.now() + 20_000).toISOString());
    tempo.start(); clock.advance(1_000);
    const proposal = settings.prepare(who, { settleSeconds: 2 });
    expect(() => db.transaction(() => { settings.apply(proposal); throw new Error('Rollback'); })).toThrow('Rollback');
    expect(settings.read(who).settleSeconds).toBe(5);
    db.transaction(() => settings.apply(proposal)); tempo.changed();
    clock.advance(1_999); expect(attempts).toBe(0);
    clock.advance(1); expect(attempts).toBe(1); expect(taken).toEqual([]);
    capacity = true; tempo.changed();
    expect(taken).toEqual([[dim.id]]);
    expect(mail.item(muted.id)).toMatchObject({ state: 'waiting', job: null, volume: 'mute' });
    expect(mail.item(dim.id)).toMatchObject({ state: 'taken', job: 'job', volume: 'dim' });
    mail.confirm(dim.id, 'job'); tempo.changed();
    // A named ask breaks mute in the same transaction as the content change.
    db.transaction(() => {
      db.update(inbox).set({ words: 'Art, answer now', changedAt: at() }).where(eq(inbox.id, muted.id)).run();
      tempo.volume.changed(who, muted.id, true);
    });
    tempo.changed();
    expect(mail.item(muted.id)).toMatchObject({ volume: 'full', quietUntil: null });
    // The running job consumes the newly audible item through the real API.
    expect(mail.take(cv.id, 'job').map(item => item.id)).toEqual([muted.id]);
    tempo.changed(); clock.advance(30_000);
    expect(attempts).toBe(2); expect(taken).toHaveLength(1);
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
