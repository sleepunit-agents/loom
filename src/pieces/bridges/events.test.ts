import Database from 'better-sqlite3';
import { afterEach, expect, it, vi } from 'vitest';
import { createDataSchema } from '../../core/data/database.js';
import { FakeClock } from '../../core/clock.js';
import { agents, members, secrets, bridgeConnections, bridgeIncoming, bridgeRawEvents, bridgeResume } from '../../core/data/schema.js';
import { BridgeEvents } from './events.js';

const stores: Database.Database[] = [];
afterEach(() => { for (const db of stores.splice(0)) db.close(); });
const HOUR = 3_600_000;
function fixture() {
  const client = new Database(':memory:'); stores.push(client);
  const clock = new FakeClock();
  const now = () => new Date(clock.now()).toISOString();
  const db = createDataSchema(client, now);
  db.insert(members).values({ id: 'jonathan', role: 'owner', joinedAt: now() }).run();
  db.insert(agents).values({ id: 'art', about: '', markBg: '#000', markFg: '#fff', faceShape: 'pebble', faceEyes: 'dot' }).run();
  db.insert(secrets).values({ name: 'bot', description: '', changedAt: now(), changedBy: 'jonathan' }).run();
  for (const platform of ['slack', 'discord'] as const) {
    db.insert(bridgeConnections).values({ id: platform, platform, agent: 'art', workspace: 'w', botUser: 'bot', tokenSecret: 'bot', enabled: true, state: 'connected', stateAt: now() }).run();
    db.insert(bridgeIncoming).values({ id: platform, connection: platform, channel: 'channel', isDm: false, user: 'person', text: 'file', postedAt: now(), receivedAt: now(), state: 'pending' }).run();
  }
  const input = Buffer.from('{"synthetic":true}');
  const rows = () => db.select().from(bridgeRawEvents).all();
  return { db, clock, now, input, rows };
}

const checkpoint = { session: 'session', sequence: 1, resumeUrl: 'wss://gateway.discord.gg/' };

it('commits Discord raw bytes with the resume cursor, and rolls both back on failure', () => {
  const f = fixture(), spool = new BridgeEvents(f.db, f.clock);
  spool.retain('discord', 'one', f.input, checkpoint);
  expect(spool.checkpoint('discord')).toEqual(checkpoint);
  expect(f.rows()[0].event).toEqual(f.input);
  expect(() => spool.retain('missing', 'two', f.input, { ...checkpoint, sequence: 2 })).toThrow();
  // Force receipt insertion to fail after the cursor update.
  f.db.$client.exec("CREATE TRIGGER reject_raw BEFORE INSERT ON bridge_raw_events WHEN NEW.id='bad' BEGIN SELECT RAISE(ABORT,'synthetic failure'); END");
  expect(() => spool.retain('discord', 'bad', f.input, { ...checkpoint, sequence: 2 })).toThrow('synthetic failure');
  expect(spool.checkpoint('discord')).toEqual(checkpoint);
  expect(f.rows()).toHaveLength(1);
  spool.close();
});

it('expires raw bytes at one hour, without extending duplicate deadlines or erasing cursors/history', () => {
  const f = fixture(), spool = new BridgeEvents(f.db, f.clock);
  spool.retain('discord', 'one', f.input, checkpoint);
  f.clock.advance(HOUR / 2);
  spool.retain('discord', 'one', Buffer.from('replacement'), { ...checkpoint, sequence: 2 });
  spool.retain('slack', 'one', f.input);
  expect(f.rows().find(r => r.connection === 'discord')?.event).toEqual(f.input);
  f.clock.advance(HOUR / 2 - 1);
  expect(f.rows()).toHaveLength(2);
  f.clock.advance(1);
  expect(f.rows().map(r => r.connection)).toEqual(['slack']);
  expect(spool.checkpoint('discord')?.sequence).toBe(2);
  expect(f.db.select().from(bridgeIncoming).all()).toHaveLength(2);
  f.clock.advance(HOUR / 2);
  expect(f.rows()).toEqual([]);
  spool.close();
});

it('consumes normalized writes and receipt atomically, retaining a failed event for retry', () => {
  const f = fixture(), spool = new BridgeEvents(f.db, f.clock);
  spool.retain('slack', 'one', f.input);
  expect(() => spool.drain('slack', () => {
    f.db.insert(bridgeIncoming).values({ id: 'normalized', connection: 'slack', channel: 'c', isDm: false,
      user: 'u', text: 'new', postedAt: f.now(), receivedAt: f.now(), state: 'pending' }).run();
    throw Error('normalization failed');
  })).toThrow('normalization failed');
  expect(f.db.select().from(bridgeIncoming).all()).toHaveLength(2);
  expect(f.rows()).toHaveLength(1);
  expect(spool.drain('slack', (id, bytes) => {
    expect(id).toBe('one'); expect(bytes).toEqual(f.input);
    f.db.insert(bridgeIncoming).values({ id: 'normalized', connection: 'slack', channel: 'c', isDm: false,
      user: 'u', text: 'new', postedAt: f.now(), receivedAt: f.now(), state: 'pending' }).run();
  })).toBe(1);
  expect(f.db.select().from(bridgeIncoming).all()).toHaveLength(3);
  expect(spool.drain('slack', () => { throw Error('already consumed'); })).toBe(0);
  expect(f.rows()).toEqual([]);
  spool.close();
});

it('requires explicit cursor reset for session changes and rejects Slack checkpoints', () => {
  const f = fixture(), spool = new BridgeEvents(f.db, f.clock);
  spool.retain('discord', 'one', f.input, checkpoint);
  expect(() => spool.retain('discord', 'two', f.input, { ...checkpoint, sequence: 0 })).toThrow('Reset');
  expect(() => spool.retain('discord', 'two', f.input, { ...checkpoint, session: 'new' })).toThrow('Reset');
  expect(() => spool.retain('slack', 'two', f.input, checkpoint)).toThrow('Invalid Discord');
  expect(f.rows()).toHaveLength(1);
  spool.reset('discord');
  spool.retain('discord', 'two', f.input, { ...checkpoint, session: 'new', sequence: 0 });
  expect(spool.checkpoint('discord')?.session).toBe('new');
  spool.close();
});

it('sweeps expired rows on startup, cancels timers on close, and never drains expired bytes', () => {
  const f = fixture();
  const cancel = vi.fn();
  const at = f.clock.at.bind(f.clock);
  vi.spyOn(f.clock, 'at').mockImplementation((time, fn) => {
    const stop = at(time, fn); return () => { cancel(); stop(); };
  });
  const spool = new BridgeEvents(f.db, f.clock);
  spool.retain('slack', 'one', f.input);
  spool.close();
  expect(cancel).toHaveBeenCalledTimes(1);
  f.clock.advance(HOUR);
  expect(f.rows()).toHaveLength(1);
  expect(() => spool.retain('slack', 'two', f.input)).toThrow('closed');
  const reopened = new BridgeEvents(f.db, f.clock);
  expect(f.rows()).toEqual([]);
  expect(reopened.drain('slack', () => { throw Error('expired'); })).toBe(0);
  expect(f.rows()).toEqual([]);
  reopened.close();
});

it('bounds each drain and isolates receiving connections', () => {
  const f = fixture(), spool = new BridgeEvents(f.db, f.clock);
  for (let i = 0; i < 65; i++) spool.retain('slack', String(i).padStart(2, '0'), f.input);
  spool.retain('discord', 'one', f.input, checkpoint);
  const delivered: string[] = [];
  expect(spool.drain('slack', id => { delivered.push(id); })).toBe(64);
  expect(delivered).toEqual(Array.from({ length: 64 }, (_, i) => String(i).padStart(2, '0')));
  expect(f.rows().find(r => r.connection === 'discord')?.id).toBe('one');
  expect(f.rows()).toHaveLength(2);
  expect(() => spool.drain('slack', () => {}, 100)).toThrow('limit');
  expect(f.db.select().from(bridgeResume).all()).toHaveLength(1);
  spool.close();
});

it('allows an updated resume URL without changing session or rewinding', () => {
  const f = fixture(), spool = new BridgeEvents(f.db, f.clock);
  spool.retain('discord', 'one', f.input, checkpoint);
  const next = { ...checkpoint, sequence: 2, resumeUrl: 'wss://gateway-us-east1-b.discord.gg/' };
  spool.retain('discord', 'two', f.input, next);
  expect(spool.checkpoint('discord')).toEqual(next);
  spool.close();
});

it('requires its own transaction, including rejecting reentrant drain', () => {
  const f = fixture(), spool = new BridgeEvents(f.db, f.clock);
  expect(() => f.db.transaction(() => spool.retain('slack', 'one', f.input))).toThrow('own transaction');
  expect(f.rows()).toEqual([]);
  spool.retain('slack', 'one', f.input);
  expect(() => spool.drain('slack', () => { spool.drain('slack', () => {}); })).toThrow('own transaction');
  expect(f.rows()).toHaveLength(1);
  spool.close();
});

it('cleans at the same clock time after a synchronous transaction rolls back', async () => {
  const f = fixture(), spool = new BridgeEvents(f.db, f.clock);
  spool.retain('slack', 'one', f.input);
  f.db.$client.exec('BEGIN');
  f.clock.advance(HOUR);
  f.db.$client.exec('ROLLBACK');
  await Promise.resolve();
  expect(f.rows()).toEqual([]);
  spool.close();
});

it('keeps earlier successful normalization when the next event fails', () => {
  const f = fixture(), spool = new BridgeEvents(f.db, f.clock);
  spool.retain('slack', 'one', f.input);
  spool.retain('slack', 'two', f.input);
  expect(() => spool.drain('slack', id => {
    f.db.insert(bridgeIncoming).values({ id, connection: 'slack', channel: 'c', isDm: false,
      user: 'u', text: 'new', postedAt: f.now(), receivedAt: f.now(), state: 'pending' }).run();
    if (id === 'two') throw Error('second failed');
  })).toThrow('second failed');
  expect(f.db.select().from(bridgeIncoming).all().map(r => r.id)).toEqual(['slack', 'discord', 'one']);
  expect(f.rows().map(r => r.id)).toEqual(['two']);
  spool.close();
});
