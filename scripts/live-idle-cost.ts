/** What open windows cost an idle household: how often their live selections are read again while a
 * worker with no work polls. An in-memory household on a simulated clock and a listener on a free
 * loopback port; it touches no running loom. Run before and after a change:
 *
 *   npx tsx scripts/live-idle-cost.ts [--selections 8] [--polls 120]
 *
 * Each poll is one `runtime.next` with no work, one simulated second after the last, so 120 polls
 * also cross four runtime sweeps. The count is of executions of a field every selection asks for. */
import Database from 'better-sqlite3';
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { GraphQLInt } from 'graphql/index.js';
import { WebSocket } from 'ws';
import { FakeClock } from '../src/core/clock.js';
import { createDataSchema } from '../src/core/data/database.js';
import { boxes, members, tokens } from '../src/core/data/schema.js';
import { sharedRoot } from '../src/shared-root.js';

const flag = (name: string, fallback: number) => { const at = process.argv.indexOf(`--${name}`); return at < 0 ? fallback : Number(process.argv[at + 1]); };
const selections = flag('selections', 8), polls = flag('polls', 120);
const hash = (text: string) => createHash('sha256').update(text).digest('hex');
const runner = 'a'.repeat(64), owner = 'c'.repeat(64);

const client = new Database(':memory:'), clock = new FakeClock(), now = () => new Date(clock.now()).toISOString();
const db = createDataSchema(client, now);
db.insert(members).values({ id: 'owner', role: 'owner', joinedAt: now() }).run();
db.insert(boxes).values({ id: 'worker', name: 'worker', owner: 'owner', hostsAny: true, sameMachineAsLoom: false, reportOnly: false, alwaysOn: false, enrolledAt: now(), lastSeenAt: now() }).run();
db.insert(tokens).values({ fingerprint: hash(runner), label: 'worker', kind: 'runner', box: 'worker', createdAt: now() }).run();
db.insert(tokens).values({ fingerprint: hash(owner), label: 'Owner', kind: 'owner', member: 'owner', createdAt: now() }).run();
let reads = 0;
const root = sharedRoot({ db, clock, originAllowed: () => true, reportError: error => { console.error(error); },
  modelRoles: () => [], fields: { probe: { type: GraphQLInt, resolve: () => { reads++; return 0; } } } });
const server = createServer(), detach = root.attach(server);
server.listen(0, '127.0.0.1'); await once(server, 'listening');
const address = server.address(); if (!address || typeof address === 'string') throw new Error('No listener');
const settle = async () => { for (let i = 0; i < 20; i++) await new Promise(resolve => setImmediate(resolve)); };

// Two windows of one person, the selections divided between them.
const sockets: WebSocket[] = [];
let frames = 0;
for (let window = 0; window < 2; window++) {
  const ws = new WebSocket(`ws://127.0.0.1:${address.port}/graphql`, 'graphql-transport-ws', { headers: { authorization: 'Bearer ' + owner } });
  await once(ws, 'open'); const ack = once(ws, 'message'); ws.send(JSON.stringify({ type: 'connection_init' })); await ack;
  ws.on('message', () => { frames++; });
  sockets.push(ws);
}
for (let i = 0; i < selections; i++) {
  const query = `{ probe boxes { id name revokedAt } members { id role } q${i}: boxFacts { box fact } }`;
  sockets[i % 2]!.send(JSON.stringify({ type: 'subscribe', id: `s${i}`, payload: { query: `subscription { observe(query:${JSON.stringify(query)}) { revision patches { path value removed } } }` } }));
}
for (let i = 0; i < 50 && frames < selections; i++) await new Promise(resolve => setTimeout(resolve, 20));
if (frames < selections) throw new Error(`Only ${frames} of ${selections} selections opened`);
const opened = reads, sent = frames;

for (let i = 0; i < polls; i++) {
  clock.advance(1000);
  const response = await root.http.request('http://loom/api/runtime/next', { method: 'POST',
    headers: { 'content-type': 'application/json', authorization: 'Bearer ' + runner },
    body: JSON.stringify({ input: { execution: 'container', facts: ['os:linux'], slots: 2 }, id: `poll-${i}` }) });
  const body = await response.json() as { ok?: boolean; value?: unknown };
  if (!body.ok || body.value !== null) throw new Error(`Poll ${i} was not an idle poll: ${JSON.stringify(body)}`);
  await settle();
}
await new Promise(resolve => setTimeout(resolve, 50));
console.log(JSON.stringify({ selections, polls, simulatedSeconds: polls, initialReads: opened, rereads: reads - opened,
  rereadsPerSelectionPerPoll: Number(((reads - opened) / selections / polls).toFixed(3)), framesSentAfterOpening: frames - sent }));

for (const ws of sockets) ws.terminate();
await root.close(); detach(); server.close(); client.close();
