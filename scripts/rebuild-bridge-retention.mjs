import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { FakeClock } from '../dist/core/clock.js';
import { createDataSchema, dataDatabase } from '../dist/core/data/database.js';
import * as s from '../dist/core/data/schema.js';
import { BridgeReceiver } from '../dist/pieces/bridges/receiver.js';

const HOUR = 3600000;
function checkPlatform(platform) {
  const dir = mkdtempSync(join(tmpdir(), 'loom-raw-expiry-')),
    clock = new FakeClock();
  const now = () => new Date(clock.now()).toISOString();
  const open = () => new Database(join(dir, 'fixture.db'));
  let client = open(),
    receiver;
  const lost = [];
  try {
    let db = createDataSchema(client, now);
    db.insert(s.members).values({ id: 'owner', role: 'owner', joinedAt: now() }).run();
    db.insert(s.agents)
      .values({
        id: 'art',
        about: '',
        markBg: '#000',
        markFg: '#fff',
        faceShape: 'pebble',
        faceEyes: 'dot',
      })
      .run();
    db.insert(s.secrets)
      .values({ name: 'fixture', description: '', changedAt: now(), changedBy: 'owner' })
      .run();
    db.insert(s.bridgeConnections)
      .values({
        id: platform,
        platform,
        agent: 'art',
        workspace: 'w',
        botUser: 'bot',
        tokenSecret: 'fixture',
        enabled: false,
        state: 'connected',
        stateAt: now(),
      })
      .run();
    db.insert(s.bridgeChannels)
      .values({ platform, workspace: 'w', channel: 'known', answers: 'art', botsMayTalk: false })
      .run();
    db.insert(s.bridgePeople)
      .values({ platform, workspace: 'w', user: 'person', member: 'owner' })
      .run();
    const metadata = (_connection, id) =>
      id === 'known' ? { id, guild: 'w', kind: 'channel' } : undefined;
    const start = () =>
      new BridgeReceiver(db, clock, { discord: metadata, slack: metadata }, (e) => lost.push(e));
    receiver = start();
    const frames = ['known', 'missing'].map((channel, i) => {
      const frame =
        platform === 'discord'
          ? {
              op: 0,
              t: 'MESSAGE_CREATE',
              s: i + 1,
              d: {
                id: 'm' + i,
                type: 0,
                channel_id: channel,
                guild_id: 'w',
                author: { id: 'person' },
                content: 'fixture',
                timestamp: now(),
                mentions: [],
              },
            }
          : {
              type: 'events_api',
              envelope_id: 'ack' + i,
              payload: {
                type: 'event_callback',
                event_id: 'ev' + i,
                team_id: 'w',
                event: {
                  type: 'message',
                  channel,
                  ts: '1794432000.00000' + i,
                  user: 'person',
                  text: 'fixture',
                },
              },
            };
      return Buffer.from(JSON.stringify(frame, null, 2));
    });
    function receive(i) {
      if (platform === 'discord')
        receiver.discord(platform, frames[i], {
          session: 'session',
          sequence: i + 1,
          resumeUrl: 'wss://example.invalid',
          identity: 'fixture',
        });
      else receiver.slack(platform, frames[i]);
    }
    const rows = () =>
      db
        .select()
        .from(s.bridgeRawEvents)
        .all()
        .map((r) => r.event);
    receive(0);
    receive(1);
    assert.deepEqual(rows(), frames);
    clock.advance(HOUR / 2);
    receive(1);
    receiver.drain(platform);
    assert.deepEqual(rows(), frames);
    assert.equal(db.select().from(s.bridgeIncoming).get().state, 'held');
    receiver.close();
    client.close();
    client = open();
    db = dataDatabase(client, now);
    receiver = start();
    clock.advance(HOUR / 2 - 1);
    assert.deepEqual(rows(), frames);
    clock.advance(1);
    assert.deepEqual(rows(), [frames[1]]);
    db.update(s.bridgeConnections).set({ enabled: true }).run();
    receiver.drain(platform);
    receiver.drain(platform);
    assert.equal(db.select().from(s.bridgeIncoming).get().state, 'delivered');
    assert.equal(db.select().from(s.inbox).all().length, 1);
    clock.advance(23 * HOUR - 1);
    assert.deepEqual(rows(), [frames[1]]);
    clock.advance(1);
    assert.deepEqual(rows(), []);
    assert.deepEqual(lost, [{ events: 1, held: 0 }]);
  } finally {
    receiver?.close();
    if (client.open) client.close();
    rmSync(dir, { recursive: true, force: true });
  }
}

export function bridgeRetention() {
  for (const platform of ['discord', 'slack']) checkPlatform(platform);
  return {
    ok: true,
    inconclusive: true,
    reason:
      'Both bridges kept the original bytes. Across restart and retry, recorded frames expired one hour after arrival and unread frames after one day. Each held message was delivered once. This does not establish which other tables may store opaque data.',
    proof: 'walkthrough.json#actions.bridgeRetention',
  };
}
