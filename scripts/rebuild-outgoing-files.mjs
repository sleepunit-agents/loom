import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {mkdtempSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import Database from 'better-sqlite3';
import {createDataSchema, dataDatabase} from '../dist/core/data/database.js';
import * as s from '../dist/core/data/schema.js';
import {BridgeSends, reviewReply} from '../dist/pieces/bridges/sends.js';

const now = () => '2026-11-20T12:00:00.000Z';
const attachment = id => ({name: 'reading.bin', contents: Buffer.concat([Buffer.from([0, 255]), Buffer.from(id)])});
const held = ['review', 'dismiss'];
const pending = ['interrupted', 'waiting'];

function state(client, id) {
  return client.prepare('select state from bridge_sends where id = ?').pluck().get(id);
}

function files(client, id) {
  return client.prepare('select name, contents from bridge_send_files where send = ? order by position').all(id);
}

async function interruptSend(path) {
  const client = new Database(path);
  const db = createDataSchema(client, now);
  db.insert(s.members).values({id:'owner', role:'owner', joinedAt:now()}).run();
  db.insert(s.agents).values({id:'fern', about:'', markBg:'', markFg:'', faceShape:'pebble', faceEyes:'dot'}).run();
  db.insert(s.secrets).values({name:'fixture', description:'', changedAt:now(), changedBy:'owner'}).run();
  db.insert(s.bridgeConnections).values({id:'orchard', platform:'discord', agent:'fern', workspace:'garden',
    botUser:'bot', tokenSecret:'fixture', enabled:true, state:'connected', stateAt:now()}).run();
  db.insert(s.bridgeIncoming).values({id:'incoming', connection:'orchard', channel:'channel', thread:null,
    isDm:false, user:'member', text:'Fictional question', postedAt:now(), receivedAt:now(), state:'delivered'}).run();

  const queue = new BridgeSends(db, {async post(_connection, _address, text, attachments) {
    assert.equal(text, 'interrupted');
    assert.equal(state(client, text), 'sending');
    assert.deepEqual(attachments, [attachment(text)]);
    db.transaction(() => reviewReply(db, 'waiting', 'release'));
    // Exit inside the transport after the claim commits and before it can return a receipt.
    process.exit(47);
  }}, now);
  // Queue only the interrupted send as eligible. Release the waiting control just as we claim
  // the first, so the fixture does not depend on the drain query's unspecified row order.
  for (const id of [...held, ...pending]) {
    queue.queue({id, incoming:'incoming', text:id, held:id !== 'interrupted', files:[attachment(id)]});
  }
  await queue.flush();
  throw new Error('The interrupted send never entered the fictional transport');
}

const self = fileURLToPath(import.meta.url);
if (process.argv[1] === self && process.argv[2] === 'interrupt-send') {
  await interruptSend(process.argv[3]);
}

export async function outgoingFileRetention() {
  const dir = mkdtempSync(join(tmpdir(), 'loom-fictional-send-files-'));
  const path = join(dir, 'queue.db');
  let client;
  try {
    const child = spawnSync(process.execPath, [self, 'interrupt-send', path], {encoding:'utf8', timeout:20000});
    assert.ifError(child.error);
    assert.equal(child.status, 47, child.stderr);
    client = new Database(path, {fileMustExist:true});
    assert.equal(state(client, 'interrupted'), 'sending');
    assert.equal(state(client, 'waiting'), 'pending');
    for (const id of [...held, ...pending]) assert.deepEqual(files(client, id), [attachment(id)]);

    const attempts = [];
    const transport = {async post(_connection, _address, text, attachments) {
      attempts.push({text, attachments});
      return {id:'receipt-' + text};
    }};
    const db = dataDatabase(client);
    const queue = new BridgeSends(db, transport, now);
    assert.equal(state(client, 'interrupted'), 'uncertain');
    assert.deepEqual(files(client, 'interrupted'), []);
    for (const id of [...held, 'waiting']) assert.deepEqual(files(client, id), [attachment(id)]);

    db.transaction(() => reviewReply(db, 'dismiss', 'dismiss'));
    assert.equal(state(client, 'dismiss'), 'dismissed');
    assert.deepEqual(files(client, 'dismiss'), []);
    await queue.flush();
    assert.equal(state(client, 'waiting'), 'sent');
    assert.deepEqual(files(client, 'waiting'), []);
    assert.deepEqual(files(client, 'review'), [attachment('review')]);
    db.transaction(() => reviewReply(db, 'review', 'release'));
    assert.deepEqual(files(client, 'review'), [attachment('review')]);
    await queue.flush();
    await queue.close();
    client.close();

    client = new Database(path, {fileMustExist:true});
    const reopened = new BridgeSends(dataDatabase(client), transport, now);
    await reopened.flush();
    await reopened.close();
    assert.deepEqual(attempts, ['waiting', 'review'].map(text => ({text, attachments:[attachment(text)]})));
    assert.deepEqual(client.prepare('select id, state from bridge_sends order by id').raw().all(),
      [['dismiss','dismissed'], ['interrupted','uncertain'], ['review','sent'], ['waiting','sent']]);
    assert.deepEqual(client.prepare('select send, posted_id from bridge_send_parts order by send').raw().all(),
      [['review','receipt-review'], ['waiting','receipt-waiting']]);
    assert.equal(client.prepare('select count(*) from bridge_send_files').pluck().get(), 0);
    return {ok:true, reason:'Queued and held files survived a process exit during another send. The interrupted send lost its file when it became uncertain. Dismissal and confirmed delivery removed their files, and reopening the queue repeated no delivery.'};
  } finally {
    if (client?.open) client.close();
    rmSync(dir, {recursive:true, force:true});
  }
}
