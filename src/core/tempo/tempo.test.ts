import { expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { and, eq } from 'drizzle-orm';
import { createDataSchema } from '../data/database.js';
import { agents, conversations, inbox } from '../data/schema.js';
import { FakeClock } from '../clock.js';
import { createTempo, type TempoConversations } from './tempo.js';
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
