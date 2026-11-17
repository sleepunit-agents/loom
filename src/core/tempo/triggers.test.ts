import { afterEach, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { eq } from 'drizzle-orm';
import { createDataSchema } from '../data/database.js';
import { agents, household, inbox, members, triggerEdits, triggerLog, triggers } from '../data/schema.js';
import { FakeClock } from '../clock.js';
import { MISSED_GRACE_MS, TriggerEngine, type NewTrigger, type TriggerEffects } from './triggers.js';
import { nextTime } from './calendar.js';
const stops: (() => void)[] = [];
afterEach(() => { for (const stop of stops.splice(0).reverse()) stop(); });
function fixture(override: Partial<TriggerEffects> = {}) {
  const client = new Database(':memory:'); stops.push(() => client.close());
  const clock = new FakeClock(Date.parse('2026-11-14T18:00:00Z')), db = createDataSchema(client);
  db.insert(household).values({ timezone: 'America/Chicago' }).run();
  db.insert(members).values({ id: 'jonathan', role: 'owner', joinedAt: new Date(clock.now()).toISOString() }).run();
  db.insert(agents).values({ id: 'art', about: '', markBg: '#fff', markFg: '#000', faceShape: 'pebble', faceEyes: 'dot' }).run();
  const operations: string[] = [];
  const effects: TriggerEffects = {
    inbox(t, deliveryId, words) {
      const at = new Date(clock.now()).toISOString();
      db.insert(inbox).values({ id: deliveryId, toKind: t.toKind!, to: t.to!, source: 'trigger', sourceId: deliveryId, fromKind: 'schedule', words, at, changedAt: at, state: 'waiting' }).onConflictDoNothing().run();
    },
    operation: name => { operations.push(name); }, instructions: file => `Read ${file}`, ...override,
  };
  const engine = new TriggerEngine(db, clock, effects); stops.push(() => engine.close());
  const base: NewTrigger = { ownerKind: 'agent', owner: 'art', sourceKind: 'time', times: '2026-11-14T18:00:10Z', lifespan: 'once', targetKind: 'inbox', toKind: 'agent', to: 'art', instructions: 'Do the work', note: 'Test' };
  return { db, clock, effects, engine, base, operations, items: () => db.select().from(inbox).all(), row: (id: string) => db.select().from(triggers).where(eq(triggers.id, id)).get()! };
}
it('fires a one-off time to an inbox without starting a body, once across restart', () => {
  const { db, clock, engine, effects, base, items, row } = fixture();
  const t = engine.set(base);
  clock.advance(9_999); expect(items()).toEqual([]);
  clock.advance(1); expect(items()).toMatchObject([{ source: 'trigger', state: 'waiting', words: 'Do the work', to: 'art' }]);
  expect(row(t.id)).toMatchObject({ enabled: false, state: 'fired', nextDueAt: null });
  engine.close(); const reopened = new TriggerEngine(db, clock, effects); stops.push(() => reopened.close());
  reopened.tick(); clock.advance(60_000); expect(items()).toHaveLength(1);
});
it('holds a due trigger while paused and fires once on resume', () => {
  const { engine, clock, base, items, row } = fixture();
  const t = engine.set(base); engine.pause('art');
  clock.advance(30_000); expect(items()).toEqual([]); expect(row(t.id).state).toBe('held');
  engine.resume('art'); expect(items()).toHaveLength(1); expect(row(t.id).state).toBe('fired');
});
it('retains an answer received while paused and deduplicates source events after reopening', () => {
  const { db, engine, clock, effects, base, items } = fixture();
  const t = engine.set({ ...base, sourceKind: 'answer', times: null, watches: 'approval:a-1' });
  engine.pause('art'); engine.event('answer', 'approval:a-1', 'answer-1');
  expect(items()).toEqual([]); engine.close();
  const reopened = new TriggerEngine(db, clock, effects); stops.push(() => reopened.close());
  reopened.resume('art'); expect(items()).toHaveLength(1);
  reopened.event('answer', 'approval:a-1', 'answer-1'); expect(items()).toHaveLength(1);
  expect(db.select().from(triggerLog).where(andTrigger(t.id)).all().filter(l => l.event === 'fired')).toHaveLength(1);
});
function andTrigger(id: string) { return eq(triggerLog.trigger, id); }
it('runs a named operation without an inbox, repeats standing PR/job events only when new', () => {
  const { engine, base, items, operations } = fixture();
  for (const kind of ['pull-request', 'job'] as const) {
    engine.set({ ...base, sourceKind: kind, watches: kind + ':1', lifespan: 'until-stopped', targetKind: 'operation', target: 'tasks.reconcile' });
    engine.event(kind, kind + ':1', 'v1'); engine.event(kind, kind + ':1', 'v1'); engine.event(kind, kind + ':1', 'v2');
  }
  expect(items()).toEqual([]); expect(operations).toEqual(Array(4).fill('tasks.reconcile'));
});
it('repeats a lane in household time and stops a today trigger when today ends', () => {
  const { engine, clock, base, row, items } = fixture();
  const lane = engine.set({ ...base, lifespan: 'until-stopped', times: '12:01', days: 'daily', instructions: null, file: 'routines/check.md' });
  const today = engine.set({ ...base, sourceKind: 'answer', watches: 'question:1', times: null, lifespan: 'today' });
  clock.advance(60_000); expect(items()[0].words).toBe('Read routines/check.md');
  expect(row(lane.id).nextDueAt).toBe('2026-11-15T18:01:00.000Z');
  clock.advance(12 * 3_600_000); expect(row(today.id)).toMatchObject({ enabled: false, state: 'stopped' });
});
it('rolls back a failed target write and records failure without retrying it', () => {
  const f = fixture();
  f.effects.inbox = (t, id, words) => {
    f.db.insert(inbox).values({ id, toKind: 'agent', to: 'art', source: 'trigger', words, fromKind: 'schedule', state: 'waiting', at: new Date(f.clock.now()).toISOString(), changedAt: new Date(f.clock.now()).toISOString() }).run();
    throw new Error('target failed');
  };
  const t = f.engine.set(f.base); f.clock.advance(10_000);
  expect(f.items()).toEqual([]); expect(f.row(t.id)).toMatchObject({ state: 'failed', enabled: false });
  f.engine.tick(); expect(f.items()).toEqual([]);
});
it('cancels future work and validates time, owner and file inputs before recording a trigger', () => {
  const { engine, clock, base, items, db } = fixture();
  const t = engine.set(base); engine.stop(t.id); clock.advance(20_000); expect(items()).toEqual([]);
  for (const patch of [{ owner: null }, { times: '25:00' }, { file: '../private', instructions: null }, { to: null }]) expect(() => engine.set({ ...base, ...patch })).toThrow();
  expect(db.select().from(triggers).all()).toHaveLength(1);
});
it('skips missing DST wall times and runs a repeated time at its first instant only', () => {
  expect(new Date(nextTime('02:30', null, Date.parse('2026-03-08T00:00:00Z'), 'America/Chicago')).toISOString()).toBe('2026-03-09T07:30:00.000Z');
  expect(new Date(nextTime('01:30', null, Date.parse('2026-11-01T06:31:00Z'), 'America/Chicago')).toISOString()).toBe('2026-11-02T07:30:00.000Z');
});
it('holds an agent-owned operation with no inbox recipient, and skips the times it was held through', () => {
  const { engine, clock, base, operations, row, db } = fixture();
  const t = engine.set({ ...base, targetKind: 'operation', target: 'tasks.reconcile', toKind: null, to: null, times: '12:01', lifespan: 'until-stopped' });
  engine.pause('art'); clock.advance(2 * 86_400_000); expect(operations).toEqual([]);
  engine.resume('art'); expect(operations).toEqual([]);
  expect(row(t.id)).toMatchObject({ state: 'standing', enabled: true, nextDueAt: '2026-11-16T18:01:00.000Z', lastFiredAt: null });
  expect(db.select().from(triggerLog).where(andTrigger(t.id)).all().map(l => [l.event, l.note])).toContainEqual(['missed', 'time:2026-11-14T18:01:00.000Z']);
  clock.advance(60_000); expect(operations).toEqual(['tasks.reconcile']);
});
// The missed-time rule (stated on TriggerEngine): a standing trigger's time fires at most MISSED_GRACE_MS late,
// however it came to be late; a once-only trigger fires late, however late, and is never dropped.
it.each(['pause', 'restart', 'slow clock'] as const)('fires a time up to the grace late after a %s; beyond that skips a standing time and still fires a once-only one', how => {
  for (const late of [MISSED_GRACE_MS, MISSED_GRACE_MS + 1]) {
    const f = fixture(), due = f.clock.now() + 60_000;
    const lane = f.engine.set({ ...f.base, times: '12:01', days: null, lifespan: 'until-stopped' });
    const once = f.engine.set({ ...f.base, times: new Date(due).toISOString(), instructions: 'Once' });
    let engine = f.engine;
    if (how === 'pause') f.engine.pause('art'); else f.engine.close();
    if (how === 'slow clock') {
      // The timer that should have woken the engine never ran; the next scan finds the time already behind it.
      const stuck = new FakeClock(due + late); engine = new TriggerEngine(f.db, stuck, f.effects); stops.push(() => engine.close());
    } else f.clock.advance(60_000 + late);
    expect(f.items()).toEqual([]);
    if (how === 'pause') f.engine.resume('art');
    else if (how === 'restart') { engine = new TriggerEngine(f.db, f.clock, f.effects); stops.push(() => engine.close()); }
    engine.tick();
    const events = (id: string) => f.db.select().from(triggerLog).where(andTrigger(id)).all().map(l => l.event);
    if (late <= MISSED_GRACE_MS) {
      expect(f.items().map(i => i.words).sort()).toEqual(['Do the work', 'Once']);
      expect(f.row(once.id)).toMatchObject({ state: 'fired', enabled: false });
      expect(events(lane.id)).not.toContain('missed');
    } else {
      expect(f.items().map(i => i.words)).toEqual(['Once']);
      expect(f.row(once.id)).toMatchObject({ state: 'fired', enabled: false, nextDueAt: null });
      expect(events(lane.id).at(-1)).toBe('missed'); expect(events(once.id)).not.toContain('missed');
    }
    // Either way the lane stands for tomorrow, and nothing fires a second time to catch up.
    expect(f.row(lane.id)).toMatchObject({ state: 'standing', enabled: true, nextDueAt: '2026-11-15T18:01:00.000Z' });
    engine.tick(); expect(f.items()).toHaveLength(late <= MISSED_GRACE_MS ? 2 : 1);
  }
});
it.each(['pause', 'restart'] as const)('fires a once-only trigger exactly once after a %s of days, and skips every standing time that passed meanwhile', how => {
  const f = fixture();
  const lane = f.engine.set({ ...f.base, times: '12:01', days: null, lifespan: 'until-stopped' });
  const once = f.engine.set({ ...f.base, instructions: 'Once' }), wall = f.engine.set({ ...f.base, times: '12:02', instructions: 'Once by wall time' });
  let engine = f.engine;
  if (how === 'pause') f.engine.pause('art'); else f.engine.close();
  f.clock.advance(9 * 86_400_000); expect(f.items()).toEqual([]);
  if (how === 'pause') f.engine.resume('art');
  else { engine = new TriggerEngine(f.db, f.clock, f.effects); stops.push(() => engine.close()); engine.tick(); }
  expect(f.items().map(i => i.words).sort()).toEqual(['Once', 'Once by wall time']);
  for (const id of [once.id, wall.id]) {
    expect(f.row(id)).toMatchObject({ state: 'fired', enabled: false, nextDueAt: null });
    expect(f.db.select().from(triggerLog).where(andTrigger(id)).all().map(l => l.event).filter(e => e === 'fired' || e === 'missed')).toEqual(['fired']);
  }
  expect(f.row(lane.id)).toMatchObject({ state: 'standing', enabled: true, nextDueAt: '2026-11-23T18:01:00.000Z' });
  // Nothing fires again: not at the next scan, not after another restart.
  engine.tick(); engine.close(); const again = new TriggerEngine(f.db, f.clock, f.effects); stops.push(() => again.close()); again.tick();
  expect(f.items()).toHaveLength(2);
});
it('says which step of a firing failed', () => {
  const failures = (f: ReturnType<typeof fixture>) => f.db.select().from(triggerLog).all().filter(l => l.event === 'failure').map(l => l.note);
  const file = fixture({ instructions: () => { throw new Error('ENOENT: routines/check.md\nstack line'); } });
  file.engine.set({ ...file.base, instructions: null, file: 'routines/check.md' }); file.clock.advance(10_000);
  expect(failures(file)).toEqual(['instructions: ENOENT: routines/check.md']);
  const inboxWrite = fixture({ inbox: () => { throw new Error('inbox is full'); } });
  inboxWrite.engine.set(inboxWrite.base); inboxWrite.clock.advance(10_000);
  expect(failures(inboxWrite)).toEqual(['inbox: inbox is full']);
  const operation = fixture({ operation: () => { throw new Error('x'.repeat(500)); } });
  const t = operation.engine.set({ ...operation.base, targetKind: 'operation', target: 'tasks.reconcile' }); operation.clock.advance(10_000);
  expect(failures(operation)).toEqual(['operation: ' + 'x'.repeat(200)]);
  // The failed row still carries the event id alone, so the same event is not tried again.
  expect(operation.db.select().from(triggerLog).where(andTrigger(t.id)).all().filter(l => l.event === 'failed').map(l => l.note)).toEqual(['time:2026-11-14T18:00:10.000Z']);
});
it.each(['stop', 'pause'] as const)('honors an operation that will %s another due trigger without reentering itself', action => {
  const f = fixture();
  const calls: string[] = [];
  f.effects.operation = name => {
    calls.push(name);
    if (name === 'first' && calls.length === 1) {
      if (action === 'stop') f.engine.stop('second');
      else f.engine.pause('art');
    }
  };
  f.engine.set({ ...f.base, id: 'first', targetKind: 'operation', target: 'first' });
  f.engine.set({ ...f.base, id: 'second', targetKind: 'operation', target: 'second' });
  f.clock.advance(10_000);
  expect(calls).toEqual(['first']);
  expect(f.row('second').state).toBe(action === 'stop' ? 'stopped' : 'held');
  if (action === 'pause') {
    f.engine.resume('art');
    expect(calls).toEqual(['first', 'second']);
  }
});

it('defers a nested source scan until the firing operation commits, then publishes committed rows', () => {
  const f = fixture();
  const calls: string[] = [], snapshots: string[][] = [];
  f.engine.set({ ...f.base, id: 'first', targetKind: 'operation', target: 'first' });
  f.engine.set({ ...f.base, id: 'answer', sourceKind: 'answer', watches: 'question:q', targetKind: 'operation', target: 'answer' });
  f.effects.changed = () => { snapshots.push(f.db.select().from(triggers).all().map(t => t.state)); };
  f.effects.operation = name => {
    calls.push(name);
    if (name === 'first' && calls.length === 1) f.engine.event('answer', 'question:q', 'answered');
    if (name === 'answer') expect(f.row('first').state).toBe('fired');
  };
  f.clock.advance(10_000);
  expect(calls).toEqual(['first', 'answer']);
  expect(f.row('answer').state).toBe('fired');
  expect(snapshots.length).toBeGreaterThan(0);
  expect(snapshots.every(states => states.every(state => state === 'fired'))).toBe(true);
});

it('holds remaining queued events when an operation pauses its own agent', () => {
  const f = fixture();
  const calls: string[] = [];
  f.effects.operation = (_name, _trigger, occurrence) => {
    calls.push(occurrence);
    if (calls.length === 1) f.engine.pause('art');
  };
  f.engine.set({ ...f.base, id: 'events', sourceKind: 'answer', watches: 'question:q', lifespan: 'until-stopped', targetKind: 'operation', target: 'work' });
  f.engine.pause('art');
  f.engine.event('answer', 'question:q', 'one');
  f.engine.event('answer', 'question:q', 'two');
  f.engine.resume('art');
  expect(calls).toEqual(['events:one']);
  expect(f.row('events').state).toBe('held');
  f.engine.resume('art');
  expect(calls).toEqual(['events:one', 'events:two']);
  f.engine.tick();
  expect(calls).toHaveLength(2);
});

it('keeps a standing operation stopped when it stops its own trigger', () => {
  const f = fixture();
  let calls = 0;
  f.effects.operation = () => { calls++; if (calls === 1) f.engine.stop('self'); };
  f.engine.set({ ...f.base, id: 'self', targetKind: 'operation', target: 'work', lifespan: 'until-stopped', times: '12:01' });
  f.clock.advance(60_000);
  expect(calls).toBe(1);
  expect(f.row('self')).toMatchObject({ state: 'stopped', enabled: false, nextDueAt: null });
  f.clock.advance(86_400_000);
  expect(calls).toBe(1);
});

it.each(['time', 'answer'] as const)('stops a %s scan when its first operation closes Tempo', kind => {
  const f = fixture();
  const calls: string[] = [];
  let changed = 0;
  for (const id of ['first', 'second']) f.engine.set({ ...f.base, id,
    sourceKind: kind, watches: kind === 'answer' ? 'question:q' : undefined,
    lifespan: 'until-stopped', times: kind === 'time' ? '12:01' : undefined,
    targetKind: 'operation', target: id });
  f.effects.changed = () => { changed++; };
  f.effects.operation = name => { calls.push(name); f.engine.close(); };
  if (kind === 'time') f.clock.advance(60_000);
  else f.engine.event('answer', 'question:q', 'one');
  expect(calls).toEqual(['first']);
  expect(changed).toBe(0);
  expect(f.row('second').lastFiredAt).toBeNull();
  f.clock.advance(86_400_000);
  expect(calls).toEqual(['first']);
});
it('rejects half-specified operation recipients and holds a recipient-free operation for its owning agent',()=>{
 const f=fixture();
 for(const pair of [{toKind:null,to:'art'},{toKind:'agent' as const,to:null}]){
  expect(()=>f.engine.set({...f.base,targetKind:'operation',target:'test',...pair})).toThrow('both kind and id');
 }
 expect(()=>f.engine.set({...f.base,toKind:null,to:null})).toThrow('Inbox target needs a recipient');
 expect(f.db.select().from(triggers).all()).toEqual([]);
 const t=f.engine.set({...f.base,targetKind:'operation',target:'test',toKind:null,to:null});
 f.engine.pause('art');expect(f.row(t.id).state).toBe('held');
 f.engine.resume('art');expect(f.row(t.id).state).toBe('standing');
});
it('keeps a standing lane alive after one failed firing, and fires it again at its next time', () => {
  const f = fixture(); let broken = true;
  const send = f.effects.inbox;
  f.effects.inbox = (t, id, words) => { if (broken) throw new Error('could not read the instructions'); send(t, id, words); };
  const lane = f.engine.set({ ...f.base, times: '12:05', days: null, lifespan: 'until-stopped' });
  f.clock.advance(5 * 60_000);
  expect(f.items()).toEqual([]);
  expect(f.row(lane.id)).toMatchObject({ state: 'standing', enabled: true });
  expect(Date.parse(f.row(lane.id).nextDueAt!)).toBeGreaterThan(f.clock.now());
  expect(f.db.select().from(triggerLog).all().map(row => row.event)).toContain('failed');
  broken = false; f.clock.advance(24 * 3600_000);
  expect(f.items()).toHaveLength(1);
  expect(f.row(lane.id)).toMatchObject({ state: 'standing', enabled: true });
});
it('refuses an operation target the program cannot run, when the trigger is set', () => {
  const f = fixture({ knows: name => name === 'tempo.sweep' });
  expect(() => f.engine.set({ ...f.base, targetKind: 'operation', target: 'nothing.here', toKind: undefined, to: undefined, instructions: undefined })).toThrow('Unknown operation');
  expect(f.engine.set({ ...f.base, targetKind: 'operation', target: 'tempo.sweep', instructions: undefined }).state).toBe('standing');
});
it('turns one stopped lane back on from now, without firing what it missed, and leaves the agent\'s others alone', () => {
  const { engine, clock, base, items, row, db } = fixture();
  const lane = engine.set({ ...base, times: '12:10', lifespan: 'until-stopped', instructions: 'Triage' });
  const other = engine.set({ ...base, times: '12:20', lifespan: 'until-stopped', instructions: 'Tend' });
  engine.stop(lane.id); expect(row(lane.id)).toMatchObject({ enabled: false, state: 'stopped', nextDueAt: null });
  clock.advance(15 * 60_000); expect(items()).toEqual([]);
  expect(() => engine.start(other.id)).toThrow('already on');
  engine.start(lane.id);
  expect(row(lane.id)).toMatchObject({ enabled: true, state: 'standing', nextDueAt: '2026-11-15T18:10:00.000Z' });
  expect(items()).toEqual([]);
  clock.advance(5 * 60_000); expect(items().map(i => i.words)).toEqual(['Tend']);
  expect(db.select().from(triggerLog).where(eq(triggerLog.trigger, lane.id)).all().map(l => l.event)).toEqual(['set', 'stopped', 'started']);
  engine.stop(lane.id); engine.pause('art'); engine.start(lane.id); expect(row(lane.id).state).toBe('held');
});
it('refuses to start a one-off whose time has passed or a trigger that has fired', () => {
  const { engine, clock, base, row } = fixture();
  const passed = engine.set(base), fired = engine.set({ ...base, times: '2026-11-14T18:00:05Z' });
  engine.stop(passed.id); clock.advance(60_000);
  expect(() => engine.start(passed.id)).toThrow('Time is in the past'); expect(row(passed.id).enabled).toBe(false);
  expect(() => engine.start(fired.id)).toThrow('Only a stopped trigger');
});
it('edits a lane\'s words and times, keeps what they said before and who changed them, and fires the new words', () => {
  const { engine, clock, base, items, row, db } = fixture();
  const lane = engine.set({ ...base, times: '12:10', lifespan: 'until-stopped', instructions: 'Triage' });
  const edits = () => db.select().from(triggerEdits).all().map(e => ({ ...e, before: JSON.parse(e.before) }));
  engine.edit(lane.id, { instructions: 'Triage' }, { kind: 'agent', id: 'art' }); expect(edits()).toEqual([]);
  engine.edit(lane.id, { instructions: 'Triage carefully', times: '12:05' }, { kind: 'member', id: 'jonathan' });
  expect(row(lane.id)).toMatchObject({ instructions: 'Triage carefully', times: '12:05', nextDueAt: '2026-11-14T18:05:00.000Z', state: 'standing' });
  clock.advance(60_000);
  engine.edit(lane.id, { note: 'Nightly triage' }, { kind: 'agent', id: 'art' });
  expect(edits()).toEqual([
    { seq: 1, trigger: lane.id, at: '2026-11-14T18:00:00.000Z', byKind: 'member', by: 'jonathan', before: { instructions: 'Triage', times: '12:10' } },
    { seq: 2, trigger: lane.id, at: '2026-11-14T18:01:00.000Z', byKind: 'agent', by: 'art', before: { note: 'Test' } }]);
  expect(db.select().from(triggerLog).where(eq(triggerLog.event, 'edited')).all().map(l => l.note)).toEqual(['instructions, times', 'note']);
  clock.advance(4 * 60_000); expect(items().map(i => i.words)).toEqual(['Triage carefully']);
  engine.edit(lane.id, { file: 'routines/triage.md' }, { kind: 'agent', id: 'art' });
  expect(row(lane.id)).toMatchObject({ instructions: null, file: 'routines/triage.md' });
  expect(() => engine.edit(lane.id, { file: '../x', instructions: null }, { kind: 'agent', id: 'art' })).toThrow('relative repository file');
  expect(() => engine.edit(lane.id, { file: 'a.md', instructions: 'b' }, { kind: 'agent', id: 'art' })).toThrow('Give instructions or a file');
  expect(() => engine.edit(lane.id, { times: 'never' }, { kind: 'agent', id: 'art' })).toThrow();
  expect(row(lane.id)).toMatchObject({ times: '12:05', file: 'routines/triage.md' });
  engine.stop(lane.id); engine.edit(lane.id, { times: '12:30' }, { kind: 'agent', id: 'art' });
  expect(row(lane.id)).toMatchObject({ times: '12:30', enabled: false, nextDueAt: null });
  // What the lane wants to run on is set with it, edited like its words, and kept in the history.
  const tagged = engine.set({ ...base, times: '12:40', lifespan: 'until-stopped', wantsModel: 'best' }); expect(row(tagged.id).wantsModel).toBe('best');
  engine.edit(tagged.id, { wantsModel: 'normal' }, { kind: 'agent', id: 'art' }); engine.edit(tagged.id, { wantsModel: null }, { kind: 'agent', id: 'art' });
  expect(row(tagged.id).wantsModel).toBeNull(); expect(edits().filter(e => e.trigger === tagged.id).map(e => e.before)).toEqual([{ wantsModel: 'best' }, { wantsModel: 'normal' }]);
  const answer = engine.set({ ...base, sourceKind: 'answer', watches: 'approval:a', times: undefined });
  expect(() => engine.edit(answer.id, { times: '12:00' }, { kind: 'agent', id: 'art' })).toThrow('Only a time trigger');
});
