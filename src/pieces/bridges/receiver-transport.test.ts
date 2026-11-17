/** Exercise the actual transport callbacks against the shared SQLite receiver.
 * No live socket, HTTP request, credential, or household database is used. */
import Database from 'better-sqlite3';
import { EventEmitter } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { FakeClock } from '../../core/clock.js';
import { createDataSchema, dataDatabase } from '../../core/data/database.js';
import { agents, members, secrets, bridgeConnections, bridgeChannels, bridgePeople, bridgeRawEvents, bridgeIncoming, inbox, turns } from '../../core/data/schema.js';
import { BridgeReceiver, type BridgeChannelCache } from './receiver.js';
import { discordGateway, type DiscordGatewayOptions } from './discord-gateway.js';
import { slackSocket, type SlackSocketOptions } from './slack-socket.js';

class Socket extends EventEmitter {
  readyState = 1;
  send = vi.fn((_text: string, callback: (error?: Error) => void) => callback());
  ping = vi.fn();
  terminate = vi.fn(() => { this.readyState = 3; this.emit('close', 1006); });
  frame(value: unknown) {
    const bytes = Buffer.from(JSON.stringify(value, null, 2));
    this.emit('message', bytes, false);
    return bytes;
  }
  sent() { return this.send.mock.calls.map(([text]) => JSON.parse(text)); }
}

const cleanups: (() => void | Promise<void>)[] = [];
afterEach(async () => { for (const close of cleanups.splice(0).reverse()) await close(); });
// Bounded microtask settling, with no wall-clock sleep or child process.
async function settled() { for (let n = 0; n < 100; n++) await Promise.resolve(); }
const fixtureSecrets = { withValue: async <T>(_name: string, use: (value: string) => Promise<T>) => use('fixture-only') };

function fixture(platform: 'discord' | 'slack') {
  const dir = mkdtempSync(join(tmpdir(), 'loom-receiver-transport-'));
  const path = join(dir, 'fixture.db'), clock = new FakeClock();
  const now = () => new Date(clock.now()).toISOString();
  let client = new Database(path), db = createDataSchema(client, now);
  db.insert(members).values({ id: 'owner', role: 'owner', joinedAt: now() }).run();
  db.insert(agents).values({ id: 'art', about: '', markBg: '#000', markFg: '#fff', faceShape: 'pebble', faceEyes: 'dot' }).run();
  db.insert(secrets).values({ name: 'bot', description: '', changedAt: now(), changedBy: 'owner' }).run();
  db.insert(bridgeConnections).values({ id: platform, platform, agent: 'art', workspace: 'w', botUser: '123', tokenSecret: 'bot', enabled: true, state: 'connected', stateAt: now() }).run();
  db.insert(bridgeChannels).values({ platform, workspace: 'w', channel: 'room', answers: 'art', botsMayTalk: false }).run();
  db.insert(bridgePeople).values({ platform, workspace: 'w', user: 'user', member: 'owner' }).run();
  let metadata = false;
  const channels: BridgeChannelCache = {
    discord: (_connection, channel) => metadata ? { id: channel, guild: 'w', kind: 'channel' } : undefined,
    slack: (_connection, channel) => metadata ? { id: channel, kind: 'channel' } : undefined,
  };
  let receiver = new BridgeReceiver(db, clock, channels);
  cleanups.push(() => { receiver.close(); client.close(); rmSync(dir, { recursive: true, force: true }); });
  const sockets: Socket[] = [];
  function socket() { const s = new Socket(); sockets.push(s); return s; }
  function reopen() {
    receiver.close(); client.close();
    client = new Database(path); client.pragma('foreign_keys = ON');
    db = dataDatabase(client, now); receiver = new BridgeReceiver(db, clock, channels);
  }
  function discord() {
    const transport = discordGateway({
      bot: '123', tokenSecret: 'bot', secrets: fixtureSecrets, clock, beforeConnect: () => true,
      socket: socket as unknown as NonNullable<DiscordGatewayOptions['socket']>, random: () => 0.5,
      load: () => {
        const c = receiver.checkpoint('discord', 'identity');
        return c && { session: c.session, seq: c.sequence, url: c.resumeUrl };
      },
      commit: async (_event, c, raw) => {
        receiver.discord('discord', raw, { session: c.session, sequence: c.seq, resumeUrl: c.url, identity: 'identity' });
      },
      reset: async () => receiver.reset('discord'),
    });
    cleanups.push(transport.close); return transport;
  }
  function slack() {
    const transport = slackSocket({
      appSecret: 'bot', secrets: fixtureSecrets, clock, beforeConnect: () => true,
      request: async () => Response.json({ ok: true, url: 'wss://wss.slack.com/fixture' }),
      socket: socket as unknown as NonNullable<SlackSocketOptions['socket']>,
      receive: async (_payload, raw) => receiver.slack('slack', raw),
    });
    cleanups.push(transport.close); return transport;
  }
  return {
    clock, sockets, reopen, discord, slack, now,
    get client() { return client; }, get db() { return db; }, get receiver() { return receiver; },
    metadata() { metadata = true; }, raw: () => db.select().from(bridgeRawEvents).all(),
  };
}
const hello = { op: 10, d: { heartbeat_interval: 10_000 } };
const ready = { op: 0, t: 'READY', s: 1, d: { user: { id: '123' }, session_id: 'fixture-session', resume_gateway_url: 'wss://gateway.discord.gg/' } };
function message(now: string, sequence = 2) {
  return { op: 0, t: 'MESSAGE_CREATE', s: sequence, d: {
    id: '777', type: 0, channel_id: 'room', guild_id: 'w', author: { id: 'user' }, content: 'Friday?', timestamp: now, mentions: [],
  } };
}
function envelope(ack = 'ack-1') {
  return { type: 'events_api', envelope_id: ack, payload: { type: 'event_callback', event_id: 'event-1', team_id: 'w',
    event: { type: 'message', channel: 'room', user: 'user', text: 'Friday?', ts: '1794432000.000001' } } };
}

it('Slack ACK observes committed original bytes; reopen and changed ACK replay deliver once', async () => {
  const f = fixture('slack'), first = f.slack(); await settled();
  const s = f.sockets[0]; s.emit('open'); s.frame({ type: 'hello' });
  const frame = envelope(), bytes = Buffer.from(JSON.stringify(frame, null, 2));
  const observed: unknown[] = [];
  s.send.mockImplementation((_text, callback) => {
    // A second connection sees the receipt at the exact point ACK is sent.
    const observer = new Database(f.client.name, { readonly: true });
    try { observed.push(observer.prepare('SELECT event FROM bridge_raw_events').get()); }
    finally { observer.close(); }
    callback();
  });
  s.emit('message', bytes, false); await settled();
  expect(s.sent()).toEqual([{ envelope_id: 'ack-1' }]);
  expect(observed).toEqual([{ event: bytes }]);
  expect(s.terminate).not.toHaveBeenCalled();
  expect(f.receiver.drain('slack')).toBe(0);
  expect(f.db.select().from(inbox).all()).toEqual([]);
  await first.close(); f.reopen();
  f.slack(); await settled(); const next = f.sockets[1]; next.emit('open'); next.frame({ type: 'hello' });
  next.frame(envelope('ack-2')); await settled();
  expect(next.sent()).toEqual([{ envelope_id: 'ack-2' }]);
  expect(f.raw().map(row => row.event)).toEqual([bytes]);
  f.metadata(); expect(f.receiver.drain('slack')).toBe(1);
  expect(f.db.select().from(inbox).all()).toHaveLength(1);
  expect(f.db.select().from(turns).all()).toHaveLength(1);
});

it('Slack failed SQLite commit sends no ACK and retry on the replacement socket remains deliverable', async () => {
  const f = fixture('slack'); f.slack(); await settled();
  const s = f.sockets[0]; s.emit('open'); s.frame({ type: 'hello' });
  f.client.exec("CREATE TRIGGER fail_receipt BEFORE INSERT ON bridge_raw_events BEGIN SELECT RAISE(ABORT, 'fixture write failure'); END");
  s.frame(envelope()); await settled();
  expect(s.send).not.toHaveBeenCalled(); expect(s.terminate).toHaveBeenCalledOnce(); expect(f.raw()).toEqual([]);
  f.client.exec('DROP TRIGGER fail_receipt'); f.clock.advance(1000); await settled();
  const next = f.sockets[1]; next.emit('open'); next.frame({ type: 'hello' }); next.frame(envelope('ack-retry')); await settled();
  expect(next.sent()).toEqual([{ envelope_id: 'ack-retry' }]);
  f.metadata(); expect(f.receiver.drain('slack')).toBe(1);
  expect(f.db.select().from(bridgeIncoming).get()?.state).toBe('delivered');
  expect(f.db.select().from(inbox).all()).toHaveLength(1);
});

it('Discord resumes the SQLite cursor after reopen while missing metadata retains original bytes', async () => {
  const f = fixture('discord'), first = f.discord(); await settled();
  const s = f.sockets[0]; s.frame(hello); await settled(); s.frame(ready); await settled();
  const receivedAt = f.now(), bytes = s.frame(message(f.now())); await settled();
  expect(f.receiver.drain('discord')).toBe(1); // READY only; message awaits metadata.
  expect(f.raw().map(row => row.event)).toEqual([bytes]);
  await first.close(); f.reopen(); f.clock.advance(60_000);
  f.discord(); await settled(); const next = f.sockets[1]; next.frame(hello); await settled();
  expect(next.sent()[0]).toMatchObject({ op: 6, d: { session_id: 'fixture-session', seq: 2 } });
  next.frame(message(receivedAt, 3)); await settled();
  f.metadata(); expect(f.receiver.drain('discord')).toBe(2);
  expect(f.raw()).toEqual([]);
  expect(f.db.select().from(inbox).all()).toHaveLength(1);
  expect(f.db.select().from(turns).all()).toHaveLength(1);
  expect(f.db.select().from(bridgeIncoming).get()).toMatchObject({ receivedAt, deliveredAt: f.now(), state: 'delivered' });
});

it('Discord failed raw insert rolls its cursor back and reconnect resumes the preceding committed sequence', async () => {
  const f = fixture('discord'); f.discord(); await settled();
  const s = f.sockets[0]; s.frame(hello); await settled(); s.frame(ready); await settled();
  f.client.exec("CREATE TRIGGER fail_receipt BEFORE INSERT ON bridge_raw_events BEGIN SELECT RAISE(ABORT, 'fixture write failure'); END");
  s.frame(message(f.now())); await settled();
  expect(s.terminate).toHaveBeenCalledOnce();
  expect(f.receiver.checkpoint('discord', 'identity')?.sequence).toBe(1);
  expect(f.raw()).toHaveLength(1); // READY, with no failed message receipt.
  f.client.exec('DROP TRIGGER fail_receipt'); f.clock.advance(1000); await settled();
  const next = f.sockets[1]; next.frame(hello); await settled();
  expect(next.sent()[0]).toMatchObject({ op: 6, d: { seq: 1 } });
  next.frame(message(f.now())); await settled(); f.metadata();
  expect(f.receiver.drain('discord')).toBe(2);
  expect(f.db.select().from(inbox).all()).toHaveLength(1);
  expect(f.db.select().from(turns).all()).toHaveLength(1);
});
