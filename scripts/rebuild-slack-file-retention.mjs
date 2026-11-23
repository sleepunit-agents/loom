import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { createDataSchema, dataDatabase } from '../dist/core/data/database.js';
import { DataWrites } from '../dist/core/data/writes.js';
import { FakeClock } from '../dist/core/clock.js';
import { SharedBridges } from '../dist/pieces/bridges/shared-daemon.js';
import * as s from '../dist/core/data/schema.js';

export async function slackFileRetention() {
  const dir = mkdtempSync(join(tmpdir(), 'fictional-slack-')),
    file = join(dir, 'fixture.db');
  let client,
    db,
    clock,
    daemon,
    transport,
    fetches = 0;
  const errors = [],
    day = 86400000,
    start = Date.parse('2026-11-20T00:00:00.000Z'),
    at = new Date(start).toISOString();
  const source = {
    generation: async () => '12345678-1234-4234-8234-123456789abc',
    read: async () => Buffer.from('fixture'),
  };
  async function open(t, seed = false) {
    client = new Database(file);
    clock = new FakeClock(t);
    db = seed ? createDataSchema(client) : dataDatabase(client);
    if (seed) {
      db.insert(s.members).values({ id: 'owner', role: 'owner', joinedAt: at }).run();
      db.insert(s.agents)
        .values({ id: 'art', about: '', markBg: '', markFg: '', faceShape: 'pebble', faceEyes: 'dot' })
        .run();
      for (const name of ['TOKEN', 'APP'])
        db.insert(s.secrets).values({ name, description: '', changedAt: at, changedBy: 'owner' }).run();
      db.insert(s.bridgeConnections)
        .values({
          id: 'connection',
          platform: 'slack',
          workspace: 'TWORK',
          botUser: 'UBOT',
          agent: 'art',
          tokenSecret: 'TOKEN',
          appSecret: 'APP',
          enabled: true,
          state: 'disconnected',
          stateAt: at,
        })
        .run();
      db.insert(s.bridgeChannels)
        .values({
          platform: 'slack',
          workspace: 'TWORK',
          channel: 'CROOM',
          answers: 'art',
          botsMayTalk: false,
        })
        .run();
      db.insert(s.bridgePeople)
        .values({ platform: 'slack', workspace: 'TWORK', user: 'UUSER', member: 'owner' })
        .run();
    }
    daemon = new SharedBridges({
      db,
      clock,
      writes: new DataWrites(db, { refreshAccess() {}, changed() {} }),
      source,
      effectsAllowed: () => true,
      changed() {},
      inboxCommitted() {},
      reportError: (e) => errors.push(e),
      slack: (options) => {
        transport = options;
        options.state?.('connected');
        return { async close() {} };
      },
      request: async (url) => {
        if (String(url).endsWith('/auth.test'))
          return Response.json({ ok: true, user_id: 'UBOT', team_id: 'TWORK', bot_id: 'BBOT' });
        if (String(url).endsWith('/bots.info'))
          return Response.json({
            ok: true,
            bot: { id: 'BBOT', user_id: 'UBOT', app_id: 'AAPP', deleted: false },
          });
        if (String(url).endsWith('/conversations.info'))
          return Response.json({
            ok: true,
            channel: { id: 'CROOM', context_team_id: 'TWORK', is_channel: true },
          });
        if (String(url) === 'https://files.slack.com/files-pri/TWORK-FABC/fixture') {
          assert.equal(client.inTransaction, false);
          fetches++;
          return new Response('DATA');
        }
        throw Error('Unexpected fixture request');
      },
    });
    await daemon.ready();
    await daemon.idle();
  }
  async function close() {
    if (daemon) {
      await daemon.close();
      daemon = null;
    }
    if (client?.open) client.close();
  }
  async function share(id, ts) {
    const frame = {
      type: 'events_api',
      envelope_id: id,
      payload: {
        type: 'event_callback',
        team_id: 'TWORK',
        event_id: id,
        event: {
          type: 'message',
          user: 'UUSER',
          channel: 'CROOM',
          ts,
          text: 'Example',
          files: [
            {
              id: 'FABC',
              name: 'example.txt',
              size: 4,
              url_private: 'https://files.slack.com/files-pri/TWORK-FABC/fixture',
            },
          ],
        },
      },
    };
    await transport.receive({}, Buffer.from(JSON.stringify(frame)));
    clock.advance(0);
    await daemon.idle();
    clock.advance(1);
    await daemon.idle();
  }
  const counts = () =>
    ['bridge_files', 'bridge_file_messages', 'bridge_incoming'].map((t) =>
      client
        .prepare('select count(*) from ' + t)
        .pluck()
        .get(),
    );
  try {
    await open(start, true);
    await share('first', '1795132800.000001');
    assert.deepEqual(counts(), [1, 1, 1]);
    await close();
    await open(start + day);
    await share('second', '1795219200.000002');
    assert.deepEqual(counts(), [1, 2, 2]);
    assert.equal(fetches, 1);
    await close();
    await open(start + 14 * day - 1);
    assert.deepEqual(counts(), [1, 2, 2]);
    assert.deepEqual(client.prepare('select contents from bridge_files').pluck().get(), Buffer.from('DATA'));
    clock.advance(1);
    await daemon.idle();
    assert.deepEqual(counts(), [0, 0, 2]);
    await close();
    await open(start + 14 * day + 1);
    assert.deepEqual(counts(), [0, 0, 2]);
    assert.equal(fetches, 1);
    assert.deepEqual(errors, []);
    return {
      ok: true,
      reason:
        'Two Slack shares fetched one file. Both links and its bytes expired at exactly 14 days, both messages survived, and reopening the household preserved the result.',
    };
  } finally {
    await close();
    rmSync(dir, { recursive: true, force: true });
  }
}
