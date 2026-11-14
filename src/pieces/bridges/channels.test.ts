import { describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { FakeClock } from '../../core/clock.js';
import { createDataSchema } from '../../core/data/database.js';
import { agents, members, secrets, bridgeConnections, bridgeChannels, bridgePeople, bridgeIncoming, inbox } from '../../core/data/schema.js';
import { BridgeReceiver } from './receiver.js';
import { BridgeChannels } from './channels.js';

const slack = (kind: string) => ({ id: 'channel', is_im: kind === 'im', is_mpim: kind === 'mpim', is_channel: kind === 'channel', is_group: kind === 'group' });

describe('authenticated bridge channel metadata', () => {
  it.each([0, 5])('classifies Discord text channel type %s', type => {
    const cache = new BridgeChannels(), writer = cache.bind('c', { platform: 'discord', workspace: 'guild' });
    expect(writer.put('channel', { id: 'channel', guild_id: 'guild', type })).toBe(true);
    expect(cache.discord('c', 'channel')).toEqual({ id: 'channel', guild: 'guild', kind: 'channel' });
    expect(cache.slack('c', 'channel')).toBeUndefined();
  });
  it.each([10, 11, 12])('preserves Discord thread parent for type %s', type => {
    const cache = new BridgeChannels(), writer = cache.bind('c', { platform: 'discord', workspace: 'guild' });
    writer.put('thread', { id: 'thread', guild_id: 'guild', type, parent_id: 'forum' });
    expect(cache.discord('c', 'thread')).toEqual({ id: 'thread', guild: 'guild', kind: 'thread', parent: 'forum' });
    expect(() => writer.put('thread', { id: 'thread', guild_id: 'guild', type })).toThrow('parent');
    expect(cache.discord('c', 'thread')).toBeUndefined();
  });
  it.each([1, 3])('classifies Discord direct/group DM type %s without a guild', type => {
    const cache = new BridgeChannels(), writer = cache.bind('c', { platform: 'discord', workspace: 'guild' });
    writer.put('dm', { id: 'dm', type, guild_id: null });
    expect(cache.discord('c', 'dm')).toEqual({ id: 'dm', kind: 'dm' });
    expect(() => writer.put('dm', { id: 'dm', type, guild_id: 'guild' })).toThrow('guild');
    expect(cache.discord('c', 'dm')).toBeUndefined();
  });
  it('rejects mismatched ids/workspaces, malformed updates and unsupported Discord types', () => {
    const cache = new BridgeChannels(), writer = cache.bind('c', { platform: 'discord', workspace: 'guild' });
    const good = { id: 'channel', guild_id: 'guild', type: 0 };
    for (const bad of [{ ...good, id: 'other' }, { ...good, guild_id: 'other' }, { ...good, type: '0' }, { ...good, type: 11, parent_id: 'channel' }]) {
      writer.put('channel', good);
      expect(() => writer.put('channel', bad)).toThrow();
      expect(cache.discord('c', 'channel')).toBeUndefined();
    }
    writer.put('channel', good);
    expect(writer.put('channel', { ...good, type: 2 })).toBe(false);
    expect(cache.discord('c', 'channel')).toBeUndefined();
  });
  it.each(['im', 'mpim', 'channel', 'group'])('classifies Slack %s from evidence, never the id prefix', kind => {
    const cache = new BridgeChannels(), writer = cache.bind('c', { platform: 'slack', workspace: 'team' });
    writer.put('channel', slack(kind));
    expect(cache.slack('c', 'channel')).toEqual({ id: 'channel', kind });
    expect(cache.discord('c', 'channel')).toBeUndefined();
  });
  it('accepts sparse Slack DMs and legacy MPIMs without downgrading them to groups', () => {
    const cache = new BridgeChannels(), writer = cache.bind('c', { platform: 'slack', workspace: 'team' });
    writer.put('channel', { id: 'channel', is_im: true });
    expect(cache.slack('c', 'channel')?.kind).toBe('im');
    writer.put('channel', { id: 'channel', is_mpim: true, is_group: true });
    expect(cache.slack('c', 'channel')?.kind).toBe('mpim');
    expect(() => writer.put('channel', { id: 'channel', is_group: true })).toThrow('ambiguous');
    expect(cache.slack('c', 'channel')).toBeUndefined();
  });
  it('clears Slack evidence on missing/contradictory flags and id mismatch', () => {
    const cache = new BridgeChannels(), writer = cache.bind('c', { platform: 'slack', workspace: 'team' });
    for (const bad of [{ id: 'channel' }, { id: 'channel', is_im: 'true' }, { ...slack('im'), is_channel: true }, slack('unknown'), { ...slack('im'), id: 'other' }, { ...slack('im'), context_team_id: 'other' }]) {
      writer.put('channel', slack('im'));
      expect(() => writer.put('channel', bad)).toThrow();
      expect(cache.slack('c', 'channel')).toBeUndefined();
    }
  });
  it('isolates connections, snapshots caller input and returns copies', () => {
    const cache = new BridgeChannels(), binding = { platform: 'slack' as const, workspace: 'team' };
    const a = cache.bind('a', binding), b = cache.bind('b', binding), raw = slack('im');
    a.put('channel', raw); b.put('channel', slack('channel'));
    raw.is_im = false; binding.workspace = 'changed';
    const returned = cache.slack('a', 'channel')!; returned.kind = 'channel';
    expect(cache.slack('a', 'channel')?.kind).toBe('im');
    expect(cache.slack('b', 'channel')?.kind).toBe('channel');
    a.remove('channel'); expect(cache.slack('a', 'channel')).toBeUndefined();
    expect(cache.slack('b', 'channel')?.kind).toBe('channel');
  });
  it('fences late fetches, deletes and closes across replacement lifetimes', () => {
    const cache = new BridgeChannels(), old = cache.bind('c', { platform: 'slack', workspace: 'old' });
    old.put('channel', slack('im'));
    const current = cache.bind('c', { platform: 'slack', workspace: 'new' });
    expect(cache.slack('c', 'channel')).toBeUndefined();
    current.put('channel', slack('channel'));
    expect(old.put('channel', slack('im'))).toBe(false);
    old.remove('channel'); old.close();
    expect(cache.slack('c', 'channel')?.kind).toBe('channel');
    current.close(); expect(current.put('channel', slack('im'))).toBe(false);
    expect(cache.slack('c', 'channel')).toBeUndefined();
  });
  it('clears all connections and fences their writers on shutdown', () => {
    const cache = new BridgeChannels(), a = cache.bind('a', { platform: 'slack', workspace: 'team' });
    a.put('channel', slack('im')); cache.close();
    expect(cache.slack('a', 'channel')).toBeUndefined();
    expect(a.put('channel', slack('im'))).toBe(false);
    const b = cache.bind('a', { platform: 'discord', workspace: 'guild' });
    b.put('channel', { id: 'channel', type: 0, guild_id: 'guild' }); a.close();
    expect(cache.discord('a', 'channel')?.kind).toBe('channel');
  });
});


it.each(['discord', 'slack'] as const)('feeds deferred %s socket receipts into shared conversations after metadata arrives', platform => {
  const sql = new Database(':memory:'), clock = new FakeClock(), now = () => new Date(clock.now()).toISOString();
  const db = createDataSchema(sql, now), channels = new BridgeChannels();
  const receiver = new BridgeReceiver(db, clock, channels);
  try {
    db.insert(members).values({ id: 'owner', role: 'owner', joinedAt: now() }).run();
    db.insert(agents).values({ id: 'art', about: '', markBg: '#000', markFg: '#fff', faceShape: 'pebble', faceEyes: 'dot' }).run();
    db.insert(secrets).values({ name: 'bot', description: '', changedAt: now(), changedBy: 'owner' }).run();
    db.insert(bridgeConnections).values({ id: 'c', platform, agent: 'art', workspace: 'w', botUser: 'bot', tokenSecret: 'bot', enabled: true, state: 'connected', stateAt: now() }).run();
    db.insert(bridgeChannels).values({ platform, workspace: 'w', channel: 'channel', answers: 'art', botsMayTalk: false }).run();
    db.insert(bridgePeople).values({ platform, workspace: 'w', user: 'user', member: 'owner' }).run();
    const writer = channels.bind('c', { platform, workspace: 'w' });
    if (platform === 'discord') receiver.discord('c', Buffer.from(JSON.stringify({ op: 0, t: 'MESSAGE_CREATE', s: 1,
      d: { id: 'm', type: 0, channel_id: 'channel', guild_id: 'w', author: { id: 'user' }, content: 'Hello', timestamp: now(), mentions: [] },
    })), { session: 's', sequence: 1, resumeUrl: 'wss://gateway.discord.gg/' });
    else receiver.slack('c', Buffer.from(JSON.stringify({ type: 'events_api', payload: { type: 'event_callback', team_id: 'w', event_id: 'e',
      event: { type: 'message', channel: 'channel', user: 'user', text: 'Hello', ts: '1794432000.000001' },
    } })));
    expect(receiver.drain('c')).toBe(0);
    expect(db.select().from(inbox).all()).toEqual([]);
    writer.put('channel', platform === 'discord' ? { id: 'channel', type: 0, guild_id: 'w' } : slack('channel'));
    expect(receiver.drain('c')).toBe(1);
    expect(db.select().from(bridgeIncoming).get()).toMatchObject({ state: 'delivered', isDm: false, member: 'owner' });
    expect(db.select().from(inbox).get()).toMatchObject({ source: platform, to: 'art', words: 'Hello' });
    expect(receiver.drain('c')).toBe(0);
  } finally { receiver.close(); channels.close(); sql.close(); }
});
