import Database from 'better-sqlite3';
import { afterEach, expect, it, vi } from 'vitest';
import WebSocket from 'ws';
import { eq } from 'drizzle-orm';
import { FakeClock } from '../../core/clock.js';
import { createDataSchema } from '../../core/data/database.js';
import { agents, members, secrets, bridgeConnections, bridgeChannels, bridgePeople, bridgeIncoming, bridgeRawEvents, inbox, turns } from '../../core/data/schema.js';
import { BridgeReceiver, type BridgeChannelCache } from './receiver.js';

const cleanups: (() => void)[] = [];
vi.mock('ws', () => ({ default: vi.fn(() => { throw Error('Unexpected receiver socket'); }) }));
afterEach(() => { for (const close of cleanups.splice(0)) close(); vi.unstubAllGlobals(); vi.clearAllMocks(); });
function fixture() {
  const client = new Database(':memory:');
  const clock = new FakeClock();
  const now = () => new Date(clock.now()).toISOString();
  const db = createDataSchema(client, now);
  db.insert(members).values({ id: 'owner', role: 'owner', joinedAt: now() }).run();
  db.insert(agents).values({ id: 'art', about: '', markBg: '#000', markFg: '#fff', faceShape: 'pebble', faceEyes: 'dot' }).run();
  db.insert(secrets).values({ name: 'bot', description: '', changedAt: now(), changedBy: 'owner' }).run();
  for (const platform of ['discord', 'slack'] as const) {
    db.insert(bridgeConnections).values({ id: platform, platform, agent: 'art', workspace: 'w', botUser: 'bot', tokenSecret: 'bot', enabled: true, state: 'connected', stateAt: now() }).run();
    db.insert(bridgeChannels).values({ platform, workspace: 'w', channel: 'room', answers: 'art', botsMayTalk: false }).run();
    db.insert(bridgePeople).values({ platform, workspace: 'w', user: 'user', member: 'owner' }).run();
  }
  const channels: BridgeChannelCache = {
    discord: (_connection, channel) => ({ id: channel, guild: 'w', kind: 'channel' }),
    slack: (_connection, channel) => ({ id: channel, kind: 'channel' }),
  };
  const receiver = new BridgeReceiver(db, clock, channels);
  cleanups.push(() => { receiver.close(); client.close(); });
  const raw = () => db.select().from(bridgeRawEvents).all();
  const discord = (sequence = 1, message = 'm') => Buffer.from(JSON.stringify({ op: 0, t: 'MESSAGE_CREATE', s: sequence,
    d: { id: message, type: 0, channel_id: 'room', guild_id: 'w', author: { id: 'user' }, content: 'Friday?', timestamp: now(), mentions: [] },
  }, null, 2));
  const slack = (envelope = 'ack1', eventId = 'ev1', type = 'message') => Buffer.from(JSON.stringify({ type: 'events_api', envelope_id: envelope,
    payload: { type: 'event_callback', event_id: eventId, team_id: 'w', event: { type, channel: 'room', ts: '1794432000.000001', user: 'user', text: 'Friday?' } },
  }, null, 2));
  const checkpoint = (sequence = 1) => ({ session: 'session', sequence, resumeUrl: 'wss://gateway.discord.gg/' });
  return { client, db, clock, now, receiver, channels, raw, discord, slack, checkpoint };
}

it.each(['discord', 'slack'] as const)('moves original %s frame into one conversation delivery atomically', platform => {
  const f = fixture(), bytes = f[platform]();
  if (platform === 'discord') f.receiver.discord(platform, bytes, f.checkpoint());
  else f.receiver.slack(platform, bytes);
  expect(f.raw()[0].event).toEqual(bytes);
  expect(f.db.select().from(inbox).all()).toEqual([]);
  expect(f.receiver.drain(platform)).toBe(1);
  expect(f.raw()).toEqual([]);
  expect(f.db.select().from(bridgeIncoming).get()).toMatchObject({ state: 'delivered', member: 'owner', text: 'Friday?' });
  expect(f.db.select().from(inbox).get()).toMatchObject({ source: platform, to: 'art', fromKind: 'person', fromId: 'owner', words: 'Friday?' });
  expect(f.db.select().from(turns).all()).toHaveLength(1);
});

it('deduplicates Slack retries with changed ACK ids and app_mention duplicates', () => {
  const f = fixture();
  f.receiver.slack('slack', f.slack());
  f.receiver.slack('slack', f.slack('ack2'));
  expect(f.raw()).toHaveLength(1);
  expect(f.raw()[0].event).toEqual(f.slack());
  f.receiver.drain('slack');
  f.receiver.slack('slack', f.slack('ack3', 'ev2', 'app_mention'));
  f.receiver.drain('slack');
  expect(f.db.select().from(bridgeIncoming).all()).toHaveLength(1);
  expect(f.db.select().from(turns).all()).toHaveLength(1);
});

it.each(['discord', 'slack'] as const)('preserves %s receipt time across a delayed drain', platform => {
  const f = fixture(), receivedAt = f.now();
  if (platform === 'discord') f.receiver.discord(platform, f.discord(), f.checkpoint());
  else f.receiver.slack(platform, f.slack());
  f.clock.advance(15 * 60_000);
  f.receiver.drain(platform);
  expect(f.db.select().from(bridgeIncoming).get()).toMatchObject({ receivedAt, deliveredAt: f.now() });
});

it('retains a held receipt and retries current rules without blocking later events', () => {
  const f = fixture();
  f.db.update(bridgeConnections).set({ enabled: false }).where(eq(bridgeConnections.id, 'discord')).run();
  f.receiver.discord('discord', f.discord(), f.checkpoint());
  const notice = Buffer.from(JSON.stringify({ op: 0, t: 'RESUMED', s: 2, d: {} }));
  f.receiver.discord('discord', notice, f.checkpoint(2));
  expect(f.receiver.drain('discord')).toBe(1);
  expect(f.raw()).toHaveLength(1);
  expect(f.db.select().from(bridgeIncoming).get()).toMatchObject({ state: 'held', reason: 'Connection disabled' });
  f.db.update(bridgeConnections).set({ enabled: true }).where(eq(bridgeConnections.id, 'discord')).run();
  expect(f.receiver.drain('discord')).toBe(1);
  expect(f.raw()).toEqual([]);
  expect(f.db.select().from(bridgeIncoming).get()?.state).toBe('delivered');
  expect(f.db.select().from(turns).all()).toHaveLength(1);
});

it.each(['discord', 'slack'] as const)('waits for trusted %s channel metadata and expires missing metadata at one hour', platform => {
  const f = fixture();
  f.channels[platform] = () => undefined;
  if (platform === 'discord') f.receiver.discord(platform, f.discord(), f.checkpoint());
  else f.receiver.slack(platform, f.slack());
  expect(f.receiver.drain(platform)).toBe(0);
  expect(f.raw()).toHaveLength(1);
  expect(f.db.select().from(inbox).all()).toEqual([]);
  f.clock.advance(3_600_000);
  expect(f.raw()).toEqual([]);
  expect(f.receiver.drain(platform)).toBe(0);
});

it.each(['discord', 'slack'] as const)('delivers later %s events while metadata is missing, then recovers the deferred message', platform => {
  const f = fixture(), resolve = { ...f.channels };
  f.channels.discord = (connection, channel) => channel === 'room' ? undefined : resolve.discord(connection, channel);
  f.channels.slack = (connection, channel) => channel === 'room' ? undefined : resolve.slack(connection, channel);
  const first = f[platform]();
  const later = Buffer.from((platform === 'discord' ? f.discord(2, 'later') : f.slack('ack2', 'ev2')).toString().replace('"room"', '"other"'));
  // Direct mentions let the later channel deliver without a default route.
  const parsed = JSON.parse(later.toString());
  if (platform === 'discord') parsed.d.mentions = [{ id: 'bot' }];
  else parsed.payload.event.text = '<@bot> Friday?';
  if (platform === 'discord') {
    f.receiver.discord(platform, first, f.checkpoint());
    f.receiver.discord(platform, Buffer.from(JSON.stringify(parsed)), f.checkpoint(2));
  } else {
    f.receiver.slack(platform, first);
    f.receiver.slack(platform, Buffer.from(JSON.stringify(parsed)));
  }
  expect(f.receiver.drain(platform)).toBe(1);
  expect(f.raw().map(row => row.event)).toEqual([first]);
  expect(f.db.select().from(bridgeIncoming).all().map(row => row.channel)).toEqual(['other']);
  Object.assign(f.channels, resolve);
  expect(f.receiver.drain(platform)).toBe(1);
  expect(f.raw()).toEqual([]);
  expect(f.db.select().from(inbox).all()).toHaveLength(2);
});

it('does not fetch or open sockets during receipt, drain, held retry or expiry', () => {
  const request = vi.fn(() => { throw Error('Unexpected receiver request'); });
  vi.stubGlobal('fetch', request);
  const f = fixture();
  f.db.update(bridgeConnections).set({ enabled: false }).where(eq(bridgeConnections.id, 'discord')).run();
  f.receiver.discord('discord', f.discord(), f.checkpoint());
  f.receiver.slack('slack', f.slack());
  f.receiver.missingChannels('discord'); f.receiver.missingChannels('slack');
  f.receiver.drain('discord'); f.receiver.drain('slack');
  f.db.update(bridgeConnections).set({ enabled: true }).where(eq(bridgeConnections.id, 'discord')).run();
  f.receiver.drain('discord');
  f.receiver.slack('slack', f.slack('ack2', 'ev2'));
  f.clock.advance(3_600_000);
  expect(f.raw()).toEqual([]);
  expect(request).not.toHaveBeenCalled();
  expect(WebSocket).not.toHaveBeenCalled();
});

it('recovers a retained Discord message after reopening and uses the durable resume cursor', () => {
  const f = fixture();
  f.receiver.discord('discord', f.discord(), f.checkpoint());
  f.receiver.close();
  const next = new BridgeReceiver(f.db, f.clock, f.channels);
  expect(next.checkpoint('discord')).toEqual(f.checkpoint());
  expect(next.drain('discord')).toBe(1);
  // Replayed platform message in the same/new dispatch still has one delivery.
  next.discord('discord', f.discord(2), f.checkpoint(2));
  next.drain('discord');
  expect(f.db.select().from(turns).all()).toHaveLength(1);
  next.reset('discord');
  expect(next.checkpoint('discord')).toBeUndefined();
  next.close();
});

it('rolls back delivery and preserves receipt on database failure', () => {
  const f = fixture();
  f.receiver.slack('slack', f.slack());
  f.client.exec("CREATE TRIGGER fail_inbox BEFORE INSERT ON inbox BEGIN SELECT RAISE(ABORT, 'inbox unavailable'); END");
  expect(() => f.receiver.drain('slack')).toThrow('inbox unavailable');
  expect(f.raw()).toHaveLength(1);
  expect(f.db.select().from(bridgeIncoming).all()).toEqual([]);
  expect(f.db.select().from(turns).all()).toEqual([]);
  f.client.exec('DROP TRIGGER fail_inbox');
  expect(f.receiver.drain('slack')).toBe(1);
});

it('rejects mismatched source/checkpoint, oversized and malformed receipts before committing', () => {
  const f = fixture();
  expect(() => f.receiver.discord('slack', f.discord(), f.checkpoint())).toThrow('mismatched');
  expect(() => f.receiver.discord('discord', f.discord(), f.checkpoint(2))).toThrow('checkpoint');
  expect(() => f.receiver.slack('slack', Buffer.from(f.slack().toString().replace('"w"', '"other"')))).toThrow('workspace');
  expect(() => f.receiver.slack('slack', Buffer.alloc(1024 * 1024 + 1))).toThrow('size');
  expect(() => f.receiver.slack('slack', Buffer.from('{'))).toThrow();
  expect(f.raw()).toEqual([]);
  expect(f.receiver.checkpoint('discord')).toBeUndefined();
});

it('fails malformed messages without consuming their retained bytes or writing a delivery', () => {
  const f = fixture();
  f.receiver.discord('discord', Buffer.from('{"op":0,"t":"MESSAGE_CREATE","s":1,"d":{}}'), f.checkpoint());
  expect(() => f.receiver.drain('discord')).toThrow();
  expect(f.raw()).toHaveLength(1);
  expect(f.db.select().from(inbox).all()).toEqual([]);
});

it.each(['discord', 'slack'] as const)('discovers retained %s metadata targets after restart without consuming receipts', platform => {
  const f = fixture(), cached = f.channels[platform];
  f.channels[platform] = () => undefined;
  if (platform === 'discord') f.receiver.discord(platform, f.discord(), f.checkpoint());
  else f.receiver.slack(platform, f.slack());
  const before = f.raw();
  f.receiver.close();
  const next = new BridgeReceiver(f.db, f.clock, f.channels);
  try {
    expect(next.missingChannels(platform)).toEqual(['room']);
    expect(next.missingChannels(platform)).toEqual(['room']);
    expect(f.raw()).toEqual(before);
    expect(f.db.select().from(inbox).all()).toEqual([]);
    expect(f.db.select().from(bridgeIncoming).all()).toEqual([]);
    // Root fetches authenticated evidence and populates its disposable cache.
    f.channels[platform] = cached;
    expect(next.missingChannels(platform)).toEqual([]);
    expect(next.drain(platform)).toBe(1);
    expect(f.db.select().from(inbox).all()).toHaveLength(1);
  } finally { next.close(); }
});

it('bounds discovery by receipts examined and deduplicates targets in arrival order', () => {
  const f = fixture();
  f.channels.discord = (_connection, channel) => channel === 'cached'
    ? { id: channel, guild: 'w', kind: 'channel' } : undefined;
  for (const [index, channel] of ['cached', 'room', 'room', 'other'].entries()) {
    const frame = JSON.parse(f.discord(index + 1, String(index)).toString());
    frame.d.channel_id = channel;
    f.receiver.discord('discord', Buffer.from(JSON.stringify(frame)), f.checkpoint(index + 1));
  }
  expect(f.receiver.missingChannels('discord', 1)).toEqual([]);
  expect(f.receiver.missingChannels('discord', 3)).toEqual(['room']);
  expect(f.receiver.missingChannels('discord', 4)).toEqual(['room', 'other']);
  expect(f.raw()).toHaveLength(4);
  expect(f.receiver.checkpoint('discord')).toEqual(f.checkpoint(4));
  for (const limit of [0, 65, 1.5, NaN]) expect(() => f.receiver.missingChannels('discord', limit)).toThrow('limit');
});

it('ignores non-message dispatches and Slack messages already carrying a channel type', () => {
  const f = fixture();
  f.channels.slack = () => undefined;
  f.receiver.discord('discord', Buffer.from('{"op":0,"t":"RESUMED","s":1,"d":{}}'), f.checkpoint());
  const frame = JSON.parse(f.slack().toString());
  frame.payload.event.channel_type = 'im';
  f.receiver.slack('slack', Buffer.from(JSON.stringify(frame)));
  f.receiver.slack('slack', f.slack('ack2', 'ev2', 'reaction_added'));
  expect(f.receiver.missingChannels('discord')).toEqual([]);
  expect(f.receiver.missingChannels('slack')).toEqual([]);
  expect(f.raw()).toHaveLength(3);
});

it('does not return expired metadata targets, and rejects closed or unknown sources', () => {
  const f = fixture();
  f.channels.slack = () => undefined;
  f.receiver.slack('slack', f.slack());
  expect(f.receiver.missingChannels('slack')).toEqual(['room']);
  f.clock.advance(3_600_000);
  expect(f.receiver.missingChannels('slack')).toEqual([]);
  expect(() => f.receiver.missingChannels('unknown')).toThrow('Unknown');
  f.receiver.close();
  expect(() => f.receiver.missingChannels('slack')).toThrow('closed');
});

it('surfaces malformed discovery frames while preserving their bytes and refusing foreign transactions', () => {
  const f = fixture();
  f.receiver.discord('discord', Buffer.from('{"op":0,"t":"MESSAGE_CREATE","s":1,"d":{}}'), f.checkpoint());
  const before = f.raw();
  expect(() => f.receiver.missingChannels('discord')).toThrow();
  expect(f.raw()).toEqual(before);
  f.db.transaction(() => {
    expect(() => f.receiver.missingChannels('discord')).toThrow('own transaction');
  });
  expect(f.db.select().from(inbox).all()).toEqual([]);
});
