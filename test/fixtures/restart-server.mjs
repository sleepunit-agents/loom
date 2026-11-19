// Separate process so a crash drops the listening socket, open requests, and every in-memory service.
import Database from 'better-sqlite3';
import {createServer} from 'node:http';
import {getRequestListener} from '@hono/node-server';
import {FakeClock} from '../../src/core/clock.ts';
import {dataDatabase, upgradeDataSchema} from '../../src/core/data/database.ts';
import {sharedRoot} from '../../src/shared-root.ts';
import {wordsKey} from '../../src/pieces/comms/crypto.ts';

const [file, port, time, version, hold] = process.argv.slice(2);
const sqlite = new Database(file);
const clock = new FakeClock(Number(time));
const now = () => new Date(clock.now()).toISOString();
if (version === 'upgrade') upgradeDataSchema(sqlite, now);
const db = dataDatabase(sqlite, now);
// Public fixture identity from conversation-body.ts.
const commsKey = wordsKey('AGE-SECRET-KEY-10SC5M7Q03WKNXKZHXZKY6JWHDV8MP7DS8USNSE64C674RN6TDGDSEKQNMR');
const root = sharedRoot({db, clock, commsKey, originAllowed: () => true,
  modelRoles: () => [{model:'fixture', provider:'fixture', harness:'fixture', series:'fixture'}],
  reportError: error => console.error(error)});
const listener = getRequestListener(async request => {
  const response = await root.http.fetch(request);
  if (hold === 'tool' && new URL(request.url).pathname === '/api/conversation/message' && response.ok) {
    process.send('committed');
    await new Promise(() => {}); // Crash here, after the receipt commits and before any reply bytes.
  }
  return response;
});
const server = createServer(listener);
server.listen(Number(port), '127.0.0.1', () => process.send(server.address().port));
process.on('message', ({advance}) => {
  clock.advance(advance);
  process.send('advanced');
});
