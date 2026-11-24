import assert from 'node:assert/strict';
import {mkdtempSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import Database from 'better-sqlite3';
import {createDataSchema, dataDatabase} from '../dist/core/data/database.js';
import * as s from '../dist/core/data/schema.js';
import {BridgeIncoming} from '../dist/pieces/bridges/incoming.js';
import {BridgeSends} from '../dist/pieces/bridges/sends.js';
import {BridgeReplyNotSent} from '../dist/pieces/bridges/outbound.js';
const now = () => '2026-11-20T12:00:00.000Z';
export async function bridgeSendParts(platform) {
  assert.ok(['discord', 'slack'].includes(platform));
  const dir = mkdtempSync(join(tmpdir(), 'loom-multipart-')),
    path = join(dir, 'queue.db');
  let client = new Database(path),
    db = createDataSchema(client);
  try {
    db.insert(s.members).values({id: 'owner', role: 'owner', joinedAt: now()}).run();
    db.insert(s.secrets)
      .values({name: 'fixture', description: '', changedAt: now(), changedBy: 'owner'})
      .run();
    for (const id of ['fern', 'moss']) {
      db.insert(s.agents)
        .values({id, about: '', markBg: '', markFg: '', faceShape: 'pebble', faceEyes: 'dot'})
        .run();
      db.insert(s.memberAgents).values({member: 'owner', agent: id}).run();
      db.insert(s.bridgeConnections)
        .values({
          id,
          platform,
          agent: id,
          workspace: 'garden',
          botUser: 'bot-' + id,
          tokenSecret: 'fixture',
          enabled: true,
          state: 'connected',
          stateAt: now(),
        })
        .run();
    }
    db.insert(s.bridgePeople).values({platform, workspace: 'garden', user: 'human', member: 'owner'}).run();
    db.insert(s.bridgeChannels)
      .values({platform, workspace: 'garden', channel: 'orchard', answers: 'fern', botsMayTalk: false})
      .run();
    const base = {
      channel: 'orchard',
      isDm: false,
      user: 'human',
      text: 'Example question',
      postedAt: now(),
      mentions: [],
    };
    const opening = new BridgeIncoming(db, now).receive({
      ...base,
      id: 'asked',
      connection: 'moss',
      mentions: ['bot-moss'],
    });
    assert.equal(opening.state, 'delivered');
    const limit = platform === 'discord' ? 2000 : 3900,
      chunks = ['A'.repeat(limit), 'B'.repeat(limit), 'Last part.'];
    const attempts = [],
      receipts = [];
    let paused = false;
    const transport = {
      async post(conn, address, text) {
        assert.equal(conn.id, 'moss');
        assert.equal(address.channel, 'orchard');
        attempts.push(chunks.indexOf(text));
        assert.notEqual(attempts.at(-1), -1);
        if (text === chunks[1] && !paused) {
          paused = true;
          throw new BridgeReplyNotSent(true);
        }
        const id = 'provider-' + chunks.indexOf(text);
        receipts.push(id);
        return {id};
      },
    };
    let queue = new BridgeSends(db, transport, now);
    queue.queue({id: 'answer', incoming: opening.id, text: chunks.join('')});
    await queue.flush();
    const parts = () =>
      client
        .prepare('select part,posted_id from bridge_send_parts where send=? order by part')
        .raw()
        .all('answer');
    assert.deepEqual(parts(), [[0, 'provider-0']]);
    assert.equal(client.prepare("select state from bridge_sends where id='answer'").pluck().get(), 'pending');
    await queue.close();
    client.close();
    client = new Database(path, {fileMustExist: true});
    db = dataDatabase(client);
    queue = new BridgeSends(db, transport, now);
    await queue.flush();
    await queue.flush();
    await queue.close();
    assert.deepEqual(parts(), [
      [0, 'provider-0'],
      [1, 'provider-1'],
      [2, 'provider-2'],
    ]);
    assert.deepEqual(attempts, [0, 1, 1, 2]);
    assert.deepEqual(receipts, ['provider-0', 'provider-1', 'provider-2']);
    assert.equal(client.prepare("select state from bridge_sends where id='answer'").pluck().get(), 'sent');
    const incoming = new BridgeIncoming(db, now);
    for (const [index, thread] of [...receipts, 'unrelated-root'].entries()) {
      const delivered = [];
      for (const connection of ['fern', 'moss']) {
        const location = platform === 'discord' ? {channel: thread, parent: 'orchard'} : {channel: 'orchard'};
        const row = incoming.receive({...base, ...location, connection, id: 'child-' + index, thread});
        if (row.state === 'delivered') delivered.push(connection);
      }
      assert.deepEqual(delivered, index === 3 ? ['fern'] : ['moss']);
    }
    return {
      ok: true,
      reason:
        platform +
        ' recorded three confirmed parts in order. After a definite refusal and restart it resumed at the first unsent part. Replies beneath any of the three receipts reached the posting agent, while an unrelated root reached the room agent.',
    };
  } finally {
    if (client.open) client.close();
    rmSync(dir, {recursive: true, force: true});
  }
}
