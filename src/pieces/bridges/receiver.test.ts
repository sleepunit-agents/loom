import Database from 'better-sqlite3';
import { afterEach, expect, it, vi } from 'vitest';
import WebSocket from 'ws';
import { eq } from 'drizzle-orm';
import { FakeClock } from '../../core/clock.js';
import { createDataSchema } from '../../core/data/database.js';
import { agents, members, secrets, bridgeConnections, bridgeChannels, bridgePeople, bridgeIncoming, bridgeRawEvents, inbox, turns, conversations } from '../../core/data/schema.js';
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
  const expired: { events: number; held: number }[] = [];
  const receiver = new BridgeReceiver(db, clock, channels, lost => expired.push(lost));
  cleanups.push(() => { receiver.close(); client.close(); });
  const raw = () => db.select().from(bridgeRawEvents).all();
  const discord = (sequence = 1, message = 'm') => Buffer.from(JSON.stringify({ op: 0, t: 'MESSAGE_CREATE', s: sequence,
    d: { id: message, type: 0, channel_id: 'room', guild_id: 'w', author: { id: 'user' }, content: 'Friday?', timestamp: now(), mentions: [] },
  }, null, 2));
  const slack = (envelope = 'ack1', eventId = 'ev1', type = 'message') => Buffer.from(JSON.stringify({ type: 'events_api', envelope_id: envelope,
    payload: { type: 'event_callback', event_id: eventId, team_id: 'w', event: { type, channel: 'room', ts: '1794432000.000001', user: 'user', text: 'Friday?' } },
  }, null, 2));
  const checkpoint = (sequence = 1) => ({ session: 'session', sequence, resumeUrl: 'wss://gateway.discord.gg/', identity: 'identity' });
  return { client, db, clock, now, receiver, channels, raw, discord, slack, checkpoint, expired };
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

it.each(['discord', 'slack'] as const)('keeps a %s event it cannot read yet for a day, delivers it when it can, and says so if it never could', platform => {
  const f = fixture(), cached = f.channels[platform];
  f.channels[platform] = () => undefined;
  if (platform === 'discord') { f.receiver.discord(platform, f.discord(), f.checkpoint()); f.receiver.discord(platform, f.discord(2, 'never'), f.checkpoint(2)); }
  else { f.receiver.slack(platform, f.slack()); f.receiver.slack(platform, Buffer.from(f.slack('ack2', 'ev2').toString().replace('000001', '000002'))); }
  expect(f.receiver.drain(platform)).toBe(0);
  expect(f.db.select().from(inbox).all()).toEqual([]);
  // Hours later, well past the hour a recorded frame is kept, the channel can at last be read.
  f.clock.advance(5 * 3_600_000);
  expect(f.raw()).toHaveLength(2);
  expect(f.expired).toEqual([]);
  f.channels[platform] = (connection, channel) => f.raw().length === 2 ? cached(connection, channel) as never : undefined;
  expect(f.receiver.drain(platform)).toBe(1);
  expect(f.db.select().from(inbox).all()).toHaveLength(1);
  // The other stays unreadable for the whole day. Then it is gone for good, and that is said out loud, once.
  f.clock.advance(19 * 3_600_000 - 1);
  expect(f.raw()).toHaveLength(1);
  f.clock.advance(1);
  expect(f.raw()).toEqual([]);
  expect(f.receiver.drain(platform)).toBe(0);
  expect(f.expired).toEqual([{ events: 1, held: 0 }]);
});

it('sets aside what the bot hears from another guild, without asking about its channel or holding anything up', () => {
  const f = fixture();
  f.channels.discord = (_connection, channel) => channel === 'room' ? { id: channel, guild: 'w', kind: 'channel' } : undefined;
  const foreign = JSON.parse(f.discord(1, 'theirs').toString());
  foreign.d.guild_id = 'another-guild'; foreign.d.channel_id = 'their-room';
  f.receiver.discord('discord', Buffer.from(JSON.stringify(foreign)), f.checkpoint());
  f.receiver.discord('discord', f.discord(2, 'ours'), f.checkpoint(2));
  expect(f.receiver.missingChannels('discord')).toEqual([]);
  expect(f.receiver.drain('discord')).toBe(2);
  expect(f.raw()).toEqual([]);
  expect(f.db.select().from(bridgeIncoming).all().map(row => row.id)).toEqual(['bi:["discord","ours"]']);
});

it('sets aside a message in a kind of channel that carries no conversation', () => {
  const f = fixture();
  f.channels.discord = (_connection, channel) => ({ id: channel, guild: 'w', kind: 'other' });
  f.receiver.discord('discord', f.discord(), f.checkpoint());
  expect(f.receiver.missingChannels('discord')).toEqual([]);
  expect(f.receiver.drain('discord')).toBe(1);
  expect(f.raw()).toEqual([]);
  expect(f.db.select().from(bridgeIncoming).all()).toEqual([]);
  expect(f.expired).toEqual([]);
});

it('reads a Slack private channel the same whether Slack calls it a channel or a group', () => {
  const f = fixture();
  // conversations.info says is_channel for a private channel; its message events say channel_type group.
  const frame = JSON.parse(f.slack().toString());
  frame.payload.event.channel_type = 'group';
  f.receiver.slack('slack', Buffer.from(JSON.stringify(frame)));
  expect(f.receiver.drain('slack')).toBe(1);
  expect(f.db.select().from(bridgeIncoming).get()).toMatchObject({ state: 'delivered', isDm: false });
  // What must still never pass: the channel's details say it is not direct and the event says it is.
  frame.payload.event.channel_type = 'im'; frame.payload.event.ts = '1794432000.000002'; frame.payload.event_id = 'ev2';
  f.receiver.slack('slack', Buffer.from(JSON.stringify(frame)));
  expect(() => f.receiver.drain('slack')).toThrow('matching channel metadata');
  expect(f.db.select().from(bridgeIncoming).all()).toHaveLength(1);
});

it('goes on past a frame it cannot read, reports it once, and counts it lost only when its day is up', () => {
  const f = fixture();
  f.receiver.discord('discord', Buffer.from('{"op":0,"t":"MESSAGE_CREATE","s":1,"d":{}}'), f.checkpoint());
  f.receiver.discord('discord', f.discord(2), f.checkpoint(2));
  expect(f.receiver.missingChannels('discord')).toEqual([]);
  // The readable message behind it is delivered in the same pass.
  expect(() => f.receiver.drain('discord')).toThrow();
  expect(f.db.select().from(inbox).all()).toHaveLength(1);
  expect(f.raw()).toHaveLength(1);
  expect(f.receiver.drain('discord')).toBe(0);
  f.clock.advance(86_400_000);
  expect(f.raw()).toEqual([]);
  expect(f.expired).toEqual([{ events: 1, held: 0 }]);
});

it('delivers a held message after its receipt has expired, once what held it is put right', () => {
  const f = fixture();
  f.channels.discord=(_connection,channel)=>({id:channel,guild:'w',kind:'thread',parent:'parent',name:'otters',parentName:'pond'});
  f.db.update(bridgeChannels).set({channel:'parent'}).where(eq(bridgeChannels.platform,'discord')).run();
  f.db.update(bridgeConnections).set({ enabled: false }).where(eq(bridgeConnections.id, 'discord')).run();
  f.receiver.discord('discord', f.discord(), f.checkpoint());
  f.receiver.drain('discord');
  expect(f.db.select().from(bridgeIncoming).get()).toMatchObject({ state: 'held', reason: 'Connection disabled' });
  // The raw receipt goes at the hour; the held row does not go with it, and nothing has been lost.
  f.clock.advance(3_600_000);
  expect(f.raw()).toEqual([]);
  expect(f.expired).toEqual([]);
  expect(f.db.select().from(bridgeIncoming).get()?.state).toBe('held');
  f.receiver.drain('discord');
  expect(f.db.select().from(bridgeIncoming).get()?.state).toBe('held');
  f.db.update(bridgeConnections).set({ enabled: true }).where(eq(bridgeConnections.id, 'discord')).run();
  f.receiver.drain('discord');
  expect(f.db.select().from(bridgeIncoming).get()).toMatchObject({ state: 'delivered', reason: null });
  expect(f.db.select().from(inbox).all()).toHaveLength(1);
  expect(f.db.select().from(conversations).get()?.label).toBe('Discord thread #otters under #pond');
  // Trying again delivers nothing twice.
  f.receiver.drain('discord');
  expect(f.db.select().from(inbox).all()).toHaveLength(1);
});
it('files the original human account and name after the raw frame expires and the receiver restarts',()=>{
  const f=fixture(), observed=vi.fn();
  const frame=JSON.parse(f.discord().toString());
  frame.d.author.global_name='Robin';
  f.db.update(bridgeConnections).set({enabled:false}).where(eq(bridgeConnections.id,'discord')).run();
  f.receiver.discord('discord',Buffer.from(JSON.stringify(frame)),f.checkpoint());
  f.receiver.drain('discord',64,undefined,observed);
  expect(observed).not.toHaveBeenCalled();
  f.clock.advance(3_600_000);
  expect(f.raw()).toEqual([]);
  f.receiver.close();
  const restarted=new BridgeReceiver(f.db,f.clock,f.channels);
  try {
    f.db.update(bridgeConnections).set({enabled:true}).where(eq(bridgeConnections.id,'discord')).run();
    restarted.drain('discord',64,undefined,observed);
    restarted.drain('discord',64,undefined,observed);
    expect(observed.mock.calls).toEqual([[{platform:'discord',workspace:'w',user:'user',postedAt:frame.d.timestamp,authorLabel:'Robin'}]]);
    expect(f.db.select().from(inbox).all()).toHaveLength(1);
  }finally{restarted.close();}
});

it('closes a message held for a day, and one whose row cannot say what a retry needs, so nothing stays held for ever', () => {
  const f = fixture();
  f.db.update(bridgeConnections).set({ enabled: false }).where(eq(bridgeConnections.id, 'discord')).run();
  f.receiver.discord('discord', f.discord(), f.checkpoint());
  f.receiver.drain('discord');
  f.clock.advance(86_399_999);
  const again = new BridgeReceiver(f.db, f.clock, { discord: () => undefined, slack: () => undefined });
  expect(f.db.select().from(bridgeIncoming).get()?.state).toBe('held');
  f.clock.advance(1); again.close();
  const lost: unknown[] = [];
  new BridgeReceiver(f.db, f.clock, { discord: () => undefined, slack: () => undefined }, expired => lost.push(expired)).close();
  expect(lost).toEqual([{ events: 0, held: 1 }]);
  expect(f.db.select().from(bridgeIncoming).get()).toMatchObject({ state: 'dropped', reason: 'Held too long to deliver: Connection disabled', conversation: null });
  // A row written before the admission fields existed has only its receipt to retry from.
  f.db.update(bridgeIncoming).set({ state: 'held', mentions: null, receivedAt: new Date(f.clock.now() - 3_600_000).toISOString() }).run();
  new BridgeReceiver(f.db, f.clock, { discord: () => undefined, slack: () => undefined }, expired => lost.push(expired)).close();
  expect(lost[1]).toEqual({ events: 0, held: 1 });
  expect(f.db.select().from(bridgeIncoming).get()?.state).toBe('dropped');
});

it('closes a message held for a day while it runs, before trying it, and keeps none of its words', () => {
  const f = fixture();
  f.db.update(bridgeConnections).set({ enabled: false }).where(eq(bridgeConnections.id, 'discord')).run();
  f.receiver.discord('discord', f.discord(), f.checkpoint());
  f.receiver.drain('discord');
  f.clock.advance(86_400_000);
  // Put right a moment too late: the message is a day old and is not delivered now.
  f.db.update(bridgeConnections).set({ enabled: true }).where(eq(bridgeConnections.id, 'discord')).run();
  f.receiver.drain('discord');
  expect(f.db.select().from(bridgeIncoming).get()).toMatchObject({ state: 'dropped', reason: 'Held too long to deliver: Connection disabled', text: '' });
  expect(f.db.select().from(inbox).all()).toEqual([]);
  expect(f.expired).toEqual([{ events: 0, held: 1 }]);
});

it('tries every held message in turn, however many stay held', () => {
  const f = fixture();
  f.db.insert(agents).values({ id: 'mark', about: '', markBg: '#000', markFg: '#fff', faceShape: 'pebble', faceEyes: 'dot' }).run();
  f.db.update(bridgeConnections).set({ enabled: false }).where(eq(bridgeConnections.id, 'discord')).run();
  for (const [index, message] of ['a', 'b', 'c'].entries()) {
    f.receiver.discord('discord', f.discord(index + 1, message), f.checkpoint(index + 1));
    f.clock.advance(1);
  }
  f.receiver.drain('discord');
  f.clock.advance(3_600_000);
  expect(f.raw()).toEqual([]);
  // Enabled again, but the same bot now also stands for a second agent, so all three stay held.
  f.db.update(bridgeConnections).set({ enabled: true }).where(eq(bridgeConnections.id, 'discord')).run();
  f.db.insert(bridgeConnections).values({ id: 'twin', platform: 'discord', agent: 'mark', workspace: 'w', botUser: 'bot', tokenSecret: 'bot', enabled: true, state: 'disconnected', stateAt: f.now() }).run();
  const states = () => f.db.select().from(bridgeIncoming).all().map(row => row.state);
  f.receiver.drain('discord', 1);
  f.receiver.drain('discord', 1);
  expect(states()).toEqual(['held', 'held', 'held']);
  // That is put right. The next pass of one row goes on to the third message, not back to the first.
  // By the door the program has: the second connection is switched off, and its row stays.
  f.db.update(bridgeConnections).set({ enabled: false }).where(eq(bridgeConnections.id, 'twin')).run();
  f.receiver.drain('discord', 1);
  expect(states()).toEqual(['held', 'held', 'delivered']);
  f.receiver.drain('discord', 1); f.receiver.drain('discord', 1);
  expect(states()).toEqual(['delivered', 'delivered', 'delivered']);
});

it.each(['discord', 'slack'] as const)('delivers later %s events while metadata is missing, then recovers the deferred message', platform => {
  const f = fixture(), resolve = { ...f.channels };
  f.channels.discord = (connection, channel) => channel === 'room' ? undefined : resolve.discord(connection, channel);
  f.channels.slack = (connection, channel) => channel === 'room' ? undefined : resolve.slack(connection, channel);
  const first = f[platform]();
  const later = Buffer.from((platform === 'discord' ? f.discord(2, 'later') : f.slack('ack2', 'ev2')).toString().replace('"room"', '"other"'));
  // Direct mentions let the later channel deliver without a default route.
  const parsed = JSON.parse(later.toString());
  if (platform === 'discord') { parsed.d.mentions = [{ id: 'bot' }]; parsed.d.content = '<@bot> ' + parsed.d.content; }
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
  f.clock.advance(86_400_000);
  expect(f.raw()).toEqual([]);
  expect(request).not.toHaveBeenCalled();
  expect(WebSocket).not.toHaveBeenCalled();
});

it('recovers a retained Discord message after reopening and uses the durable resume cursor', () => {
  const f = fixture();
  f.receiver.discord('discord', f.discord(), f.checkpoint());
  f.receiver.close();
  const next = new BridgeReceiver(f.db, f.clock, f.channels);
  expect(next.checkpoint('discord', 'identity')).toEqual(f.checkpoint());
  expect(next.drain('discord')).toBe(1);
  // Replayed platform message in the same/new dispatch still has one delivery.
  next.discord('discord', f.discord(2), f.checkpoint(2));
  next.drain('discord');
  expect(f.db.select().from(turns).all()).toHaveLength(1);
  next.reset('discord');
  expect(next.checkpoint('discord', 'identity')).toBeUndefined();
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
  expect(f.receiver.checkpoint('discord', 'identity')).toBeUndefined();
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
  expect(f.receiver.checkpoint('discord', 'identity')).toEqual(f.checkpoint(4));
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
  f.clock.advance(86_400_000);
  expect(f.receiver.missingChannels('slack')).toEqual([]);
  expect(() => f.receiver.missingChannels('unknown')).toThrow('Unknown');
  f.receiver.close();
  expect(() => f.receiver.missingChannels('slack')).toThrow('closed');
});

it('passes over malformed discovery frames while preserving their bytes and refusing foreign transactions', () => {
  const f = fixture();
  f.channels.discord = () => undefined;
  f.receiver.discord('discord', Buffer.from('{"op":0,"t":"MESSAGE_CREATE","s":1,"d":{}}'), f.checkpoint());
  f.receiver.discord('discord', f.discord(2), f.checkpoint(2));
  const before = f.raw();
  // The frame that cannot be read does not keep the channel behind it from being looked up.
  expect(f.receiver.missingChannels('discord')).toEqual(['room']);
  expect(f.raw()).toEqual(before);
  f.db.transaction(() => {
    expect(() => f.receiver.missingChannels('discord')).toThrow('own transaction');
  });
  expect(f.db.select().from(inbox).all()).toEqual([]);
});

it('takes a second event for a delivered message with other words as an edit: nothing new, the frame read, the pass unbroken', () => {
  const f = fixture();
  f.receiver.slack('slack', f.slack());
  expect(f.receiver.drain('slack')).toBe(1);
  // Slack sends an app_mention when a posted message is edited to mention the bot: the same ts, new text.
  const edited = JSON.parse(f.slack('ack2', 'ev2', 'app_mention').toString());
  edited.payload.event.text = 'Friday? <@bot>';
  f.receiver.slack('slack', Buffer.from(JSON.stringify(edited)));
  const later = JSON.parse(f.slack('ack3', 'ev3').toString());
  later.payload.event.ts = '1794432000.000002'; later.payload.event.text = 'And Saturday?';
  f.receiver.slack('slack', Buffer.from(JSON.stringify(later)));
  // Two passes: a pass starts after the last frame the one before it read, and comes round to the rest.
  expect(f.receiver.drain('slack') + f.receiver.drain('slack')).toBe(2);
  // The edit left the first message as it was, and the message behind it was delivered in the same pass.
  expect(f.db.select().from(bridgeIncoming).all().map(row => row.text)).toEqual(['Friday?', 'And Saturday?']);
  expect(f.db.select().from(inbox).all().map(row => row.words)).toEqual(['Friday?', 'And Saturday?']);
  expect(f.db.select().from(turns).all()).toHaveLength(2);
  expect(f.raw()).toEqual([]);
  expect(f.receiver.drain('slack')).toBe(0);
});
it('goes on past a message intake refuses, and keeps its frame to try again', () => {
  const f = fixture();
  f.receiver.slack('slack', f.slack());
  f.receiver.drain('slack');
  // The same id from another user is not an edit. It is refused, and must not stop the frame behind it.
  const reused = JSON.parse(f.slack('ack2', 'ev2').toString());
  reused.payload.event.user = 'someone-else';
  f.receiver.slack('slack', Buffer.from(JSON.stringify(reused)));
  const later = JSON.parse(f.slack('ack3', 'ev3').toString());
  later.payload.event.ts = '1794432000.000002';
  f.receiver.slack('slack', Buffer.from(JSON.stringify(later)));
  // Over the passes that reach both frames, the refusal is reported once and the other message is delivered.
  const passes = [1, 2, 3, 4].map(() => { try { return f.receiver.drain('slack'); } catch (error) { return (error as Error).message; } });
  expect(passes.filter(pass => typeof pass === 'string')).toEqual(['Incoming id reused for a different message']);
  expect(passes.filter(pass => typeof pass === 'number').reduce((sum, pass) => sum + (pass as number), 0)).toBe(1);
  expect(f.db.select().from(bridgeIncoming).all()).toHaveLength(2);
  expect(f.raw()).toHaveLength(1);
});
