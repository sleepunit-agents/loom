import assert from 'node:assert/strict';
import {once} from 'node:events';
import {mkdtempSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {setTimeout as delay} from 'node:timers/promises';
import Database from 'better-sqlite3';
import WebSocket, {WebSocketServer} from 'ws';
import {FakeClock} from '../dist/core/clock.js';
import {createDataSchema, dataDatabase} from '../dist/core/data/database.js';
import * as s from '../dist/core/data/schema.js';
import {DataWrites} from '../dist/core/data/writes.js';
import {SharedBridges} from '../dist/pieces/bridges/shared-daemon.js';
import {discordGateway} from '../dist/pieces/bridges/discord-gateway.js';

export async function discordResume() {
  const dir = mkdtempSync(join(tmpdir(), 'loom-discord-resume-'));
  const server = new WebSocketServer({host: '127.0.0.1', port: 0});
  const clock = new FakeClock(), at = new Date(clock.now()).toISOString();
  const bots = ['123', '234'];
  const tokens = new Map(bots.map(bot => [bot, 'fictional-' + bot]));
  const requests = new Map(), sockets = new Map(), targets = new Map();
  let client, daemon, db;
  function open() {
    client = new Database(join(dir, 'house.db'));
  }
  async function stop() {
    await daemon?.close();
    daemon = undefined;
    client?.close();
    client = undefined;
  }
  async function until(check) {
    const deadline = Date.now() + 5000;
    while (!check()) {
      if (Date.now() > deadline) throw Error('Fictional Discord gateway did not reach the expected state');
      await delay(5);
    }
  }
  async function start() {
    requests.clear();
    daemon = new SharedBridges({
      db, clock, writes: new DataWrites(db, {refreshAccess(){}, changed(){}}),
      effectsAllowed: () => true, changed(){},
      source: {
        generation: async () => '12345678-1234-4234-8234-123456789abc',
        read: async name => Buffer.from(tokens.get(name)),
      },
      request: async (url, options) => {
        const auth = new Headers(options.headers).get('authorization');
        const bot = bots.find(id => auth === 'Bot ' + tokens.get(id));
        assert.ok(bot);
        if (String(url).endsWith('/users/@me')) return Response.json({id: bot, bot: true});
        if (String(url).endsWith('/roles')) return Response.json([]);
        return Response.json({id: '456'});
      },
      discord: options => discordGateway({...options, socket: url => {
        targets.set(options.bot, url);
        return new WebSocket('ws://127.0.0.1:' + server.address().port + '/' + options.bot);
      }}),
    });
    await daemon.ready();
    await until(() => requests.size === bots.length);
  }
  function dispatch(bot, type, seq, data) {
    sockets.get(bot).send(JSON.stringify({op: 0, t: type, s: seq, d: data}));
  }
  function cursor(bot) {
    return client.prepare('select session, sequence from bridge_resume where connection=?').get(bot);
  }
  try {
    await once(server, 'listening');
    server.on('connection', (socket, request) => {
      const bot = request.url.slice(1);
      sockets.set(bot, socket);
      socket.on('message', data => requests.set(bot, JSON.parse(data.toString())));
      socket.send(JSON.stringify({op: 10, d: {heartbeat_interval: 60000}}));
    });
    open();
    db = createDataSchema(client);
    db.insert(s.members).values({id:'owner', role:'owner', joinedAt:at}).run();
    db.insert(s.agents).values({id:'fern', about:'', markBg:'', markFg:'', faceShape:'pebble', faceEyes:'dot'}).run();
    for (const bot of bots) {
      db.insert(s.secrets).values({name:bot, description:'Fixture', changedAt:at, changedBy:'owner'}).run();
      db.insert(s.bridgeConnections).values({id:bot, platform:'discord', agent:'fern', workspace:'456',
        botUser:bot, tokenSecret:bot, enabled:true, state:'disconnected', stateAt:at}).run();
    }
    await start();
    for (const [index, bot] of bots.entries()) {
      assert.equal(requests.get(bot).op, 2);
      dispatch(bot, 'READY', 1, {session_id:'garden-'+bot, resume_gateway_url:'wss://gateway-us-east1.discord.gg', user:{id:bot}});
      dispatch(bot, 'GUILD_CREATE', 17+index, {id:'456',roles:[]});
    }
    await until(() => bots.every((bot,i) => cursor(bot)?.sequence === 17+i));
    await stop();
    open();
    db = dataDatabase(client);
    await start();
    for (const [index, bot] of bots.entries()) {
      assert.equal(targets.get(bot), 'wss://gateway-us-east1.discord.gg/?v=10&encoding=json');
      assert.deepEqual(requests.get(bot), {op:6,d:{token:tokens.get(bot),session_id:'garden-'+bot,seq:17+index}});
      dispatch(bot, 'RESUMED', 25+index, {});
    }
    await until(() => bots.every((bot,i) => cursor(bot)?.sequence === 25+i));
    await stop();
    open();
    db = dataDatabase(client);
    db.insert(s.secretChanges).values({id:'replaced',secret:'123',action:'replace',by:'owner',at}).run();
    tokens.set('123','fictional-replacement');
    await start();
    assert.equal(requests.get('123').op, 2);
    assert.equal(requests.get('123').d.token, tokens.get('123'));
    assert.equal(targets.get('123'), 'wss://gateway.discord.gg/?v=10&encoding=json');
    assert.deepEqual(requests.get('234'), {op:6,d:{token:tokens.get('234'),session_id:'garden-234',seq:26}});
    return {ok:true,reason:'Two Discord connections resumed their own saved sessions and sequence numbers after reopening the database. Both advanced on the resumed connections. After replacing one credential while stopped, that connection identified afresh and the other resumed from its newer position.'};
  } finally {
    try {await stop();} finally {
      for (const socket of server.clients) socket.terminate();
      await new Promise(resolve => server.close(resolve));
      rmSync(dir,{recursive:true,force:true});
    }
  }
}
