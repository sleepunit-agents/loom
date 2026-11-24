import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { createDataSchema, dataDatabase } from '../dist/core/data/database.js';
import { randomUUID } from 'node:crypto';
import { FakeClock } from '../dist/core/clock.js';
import { sharedRoot } from '../dist/shared-root.js';
import * as s from '../dist/core/data/schema.js';

export async function bridgeAttachments(platform) {
  assert.ok(['slack', 'discord'].includes(platform));
  const discord = platform === 'discord';
  const workspace = discord ? '100000000000000001' : 'TWORK';
  const botUser = discord ? '200000000000000002' : 'UBOT';
  const channel = discord ? '300000000000000003' : 'CROOM';
  const user = discord ? '400000000000000004' : 'UUSER';
  const attachment = discord ? '500000000000000005' : 'FABC';
  const download = discord
    ? 'https://cdn.discordapp.com/attachments/' + channel + '/' + attachment + '/example.txt'
    : 'https://files.slack.com/files-pri/TWORK-FABC/fixture';
  const messages = new Map();
  const receipts = [];
  const dir = mkdtempSync(join(tmpdir(), 'fictional-attachments-')),
    file = join(dir, 'fixture.db');
  let client,
    db,
    clock,
    app,
    ownerToken,
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
      db.insert(s.memberAgents).values({ member: 'owner', agent: 'art' }).run();
      for (const name of ['TOKEN', 'APP'])
        db.insert(s.secrets).values({ name, description: '', changedAt: at, changedBy: 'owner' }).run();
      db.insert(s.bridgeConnections)
        .values({
          id: 'connection',
          platform,
          workspace,
          botUser,
          agent: 'art',
          tokenSecret: 'TOKEN',
          appSecret: discord ? null : 'APP',
          enabled: true,
          state: 'disconnected',
          stateAt: at,
        })
        .run();
      db.insert(s.bridgeChannels)
        .values({
          platform,
          workspace,
          channel,
          answers: 'art',
          botsMayTalk: false,
        })
        .run();
      db.insert(s.bridgePeople).values({ platform, workspace, user, member: 'owner' }).run();
    }
    app = sharedRoot({
      db,
      clock,
      originAllowed: () => true,
      reportError: (e) => errors.push(e),
      bridges: {
        source,
        effectsAllowed: () => true,

        [platform]: (options) => {
          transport = options;
          options.state?.('connected');
          return { async close() {} };
        },
        request: async (url) => {
          const path = new URL(url).pathname;
          if (path.endsWith('/users/@me')) return Response.json({ id: botUser, bot: true });
          if (path.endsWith('/guilds/' + workspace)) return Response.json({ id: workspace });
          if (path.endsWith('/roles')) return Response.json([]);
          if (path.endsWith('/channels/' + channel))
            return Response.json({ id: channel, guild_id: workspace, type: 0 });
          if (messages.has(path)) return Response.json(messages.get(path));
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
          if (String(url) === download) {
            assert.equal(client.inTransaction, false);
            fetches++;
            return new Response('DATA');
          }
          throw Error('Unexpected fixture request');
        },
      },
    });
    daemon = app.services.bridges.daemon;
    if (seed)
      ownerToken = app.writes.run(() =>
        app.services.signin.issue({ kind: 'owner', member: 'owner', label: 'Attachment fixture' }),
      ).value.token;
    await daemon.ready();
    await daemon.idle();
  }
  async function close() {
    if (app) {
      await app.close();
      app = null;
    }
    if (client?.open) client.close();
  }
  async function shareSlack(id, ts) {
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
              url_private: download,
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
  async function share(index) {
    let messageId;
    if (discord) {
      messageId = String(600000000000000000n + BigInt(index));
      const data = {
        type: 0,
        id: messageId,
        guild_id: workspace,
        channel_id: channel,
        author: { id: user, bot: false },
        content: 'Example',
        mentions: [],
        timestamp: new Date(clock.now()).toISOString(),
        attachments: [
          { id: attachment, filename: 'example.txt', content_type: 'text/plain', size: 4, url: download },
        ],
      };
      messages.set('/api/v10/channels/' + channel + '/messages/' + messageId, data);
      await transport.commit(
        { type: 'MESSAGE_CREATE', data, seq: index },
        { session: 'fixture', url: 'wss://gateway.discord.gg', seq: index },
        Buffer.from(JSON.stringify({ op: 0, t: 'MESSAGE_CREATE', s: index, d: data })),
      );
      clock.advance(0);
      await daemon.idle();
    } else {
      const ts = index === 1 ? '1795132800.000001' : '1795219200.000002';
      await shareSlack('event-' + index, ts);
      messageId = JSON.stringify([channel, ts]);
    }
    const incoming = 'bi:' + JSON.stringify(['connection', messageId]);
    assert.equal(
      client.prepare('SELECT state FROM bridge_incoming WHERE id=?').pluck().get(incoming),
      'delivered',
    );
    if (discord) {
      const commit = await daemon.prepareDiscordFile(incoming, () => true, 0, 1024);
      assert.deepEqual(commit(), { state: 'saved', count: 1, bytes: 4 });
    }
    receipts.push(incoming);
  }
  async function checkListings(expired = false) {
    for (const incoming of receipts) {
      async function read(input) {
        const response = await app.http.request('http://loom/api/bridges/file', {
          method: 'POST',
          headers: { authorization: 'Bearer ' + ownerToken, 'content-type': 'application/json' },
          body: JSON.stringify({ id: randomUUID(), input: { incoming, ...input } }),
        });
        assert.equal(response.status, 200);
        const result = await response.json();
        assert.equal(result.ok, true);
        return result.value.files;
      }
      const metadata = { file: attachment, name: 'example.txt', bytes: 4, fetchedAt: at };
      assert.deepEqual(await read({}), expired ? [] : [metadata]);
      if (!expired)
        assert.deepEqual(await read({ file: attachment }), [
          { ...metadata, contents: Buffer.from('DATA').toString('base64') },
        ]);
    }
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
    await share(1);
    await checkListings();
    assert.deepEqual(counts(), [1, 1, 1]);
    await close();
    await open(start + day);
    await checkListings();
    await share(2);
    await checkListings();
    assert.deepEqual(counts(), [1, 2, 2]);
    assert.equal(fetches, 1);
    await close();
    await open(start + 14 * day - 1);
    await checkListings();
    assert.deepEqual(counts(), [1, 2, 2]);
    assert.deepEqual(client.prepare('select contents from bridge_files').pluck().get(), Buffer.from('DATA'));
    clock.advance(1);
    await daemon.idle();
    assert.deepEqual(counts(), [0, 0, 2]);
    await close();
    await open(start + 14 * day + 1);
    await checkListings(true);
    assert.deepEqual(counts(), [0, 0, 2]);
    assert.equal(fetches, 1);
    assert.deepEqual(errors, []);
    return {
      ok: true,
      reason:
        platform +
        ' fetched one file and listed the original bytes under both delivered messages after restart. Both links and the bytes expired at fourteen days, while the two messages survived reopening.',
    };
  } finally {
    await close();
    rmSync(dir, { recursive: true, force: true });
  }
}
