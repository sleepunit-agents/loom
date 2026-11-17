import Database from 'better-sqlite3';
import { afterEach, expect, it } from 'vitest';
import { createDataSchema } from '../../core/data/database.js';
import { FakeClock } from '../../core/clock.js';
import { agents, members, secrets, bridgeConnections, bridgeIncoming, bridgeFiles, bridgeFileMessages } from '../../core/data/schema.js';
import { BridgeFiles } from './files.js';

const stores: Database.Database[] = [];
afterEach(() => { for (const db of stores.splice(0)) db.close(); });
const DAY = 86400_000;
function fixture() {
  const client = new Database(':memory:'); stores.push(client);
  const clock = new FakeClock();
  const now = () => new Date(clock.now()).toISOString();
  const db = createDataSchema(client, now);
  db.insert(members).values({ id: 'jonathan', role: 'owner', joinedAt: now() }).run();
  db.insert(agents).values({ id: 'art', about: '', markBg: '#000', markFg: '#fff', faceShape: 'pebble', faceEyes: 'dot' }).run();
  db.insert(secrets).values({ name: 'bot', description: '', changedAt: now(), changedBy: 'jonathan' }).run();
  for (const platform of ['slack', 'discord'] as const) {
    db.insert(bridgeConnections).values({ id: platform, platform, agent: 'art', workspace: 'w', botUser: 'bot', tokenSecret: 'bot', enabled: true, state: 'connected', stateAt: now() }).run();
    db.insert(bridgeIncoming).values({ id: platform, connection: platform, channel: 'channel', isDm: false, user: 'person', text: 'file', postedAt: now(), receivedAt: now(), state: 'pending' }).run();
  }
  const input = { connection: 'slack', incoming: 'slack', file: 'F1', name: 'report.txt', contents: Buffer.from('synthetic attachment') };
  const rows = () => db.select().from(bridgeFiles).all();
  const links = () => db.select().from(bridgeFileMessages).all().map(row => `${row.file}@${row.incoming}`).sort();
  return { db, clock, now, input, rows, links };
}

it('keeps Slack files for fourteen days, and duplicate fetches do not extend expiry', () => {
  const f = fixture(), files = new BridgeFiles(f.db, f.clock);
  files.store(f.input);
  f.clock.advance(DAY);
  files.store(f.input);
  files.store({ ...f.input, file: 'F2' });
  f.clock.advance(13 * DAY - 1);
  expect(f.rows().map(r => r.file)).toEqual(['F1', 'F2']);
  expect(f.rows()[0].contents.toString()).toBe('synthetic attachment');
  f.clock.advance(1);
  expect(f.rows().map(r => r.file)).toEqual(['F2']);
  f.clock.advance(DAY);
  expect(f.rows()).toEqual([]);
  expect(f.db.select().from(bridgeIncoming).all()).toHaveLength(2);
  files.close();
});

it('keeps a file shared in a second message once and lists it under both, without a second fetch', () => {
  const f = fixture(), files = new BridgeFiles(f.db, f.clock);
  f.db.insert(bridgeIncoming).values({ id: 'second', connection: 'slack', channel: 'channel', isDm: false, user: 'person', text: 'same file', postedAt: f.now(), receivedAt: f.now(), state: 'pending' }).run();
  files.store(f.input);
  f.clock.advance(DAY);
  // The second message carries F1, which is kept, and F2, which is not: only F2 is left to fetch.
  expect(files.carry({ connection: 'slack', incoming: 'second', files: ['F1', 'F2'] })).toEqual(['F2']);
  expect(f.links()).toEqual(['F1@second', 'F1@slack']);
  expect(f.rows()).toHaveLength(1);
  // Asked again (the frame is read again after a restart), nothing changes.
  expect(files.carry({ connection: 'slack', incoming: 'second', files: ['F1'] })).toEqual([]);
  expect(f.links()).toEqual(['F1@second', 'F1@slack']);
  expect(() => files.carry({ connection: 'slack', incoming: 'discord', files: ['F1'] })).toThrow('Slack connection');
  // The file goes fourteen days after its first fetch, with every listing of it.
  f.clock.advance(13 * DAY);
  expect(f.rows()).toEqual([]); expect(f.links()).toEqual([]);
  files.store(f.input); files.carry({ connection: 'slack', incoming: 'second', files: ['F1'] });
  files.remove('slack', 'F1');
  expect(f.rows()).toEqual([]); expect(f.links()).toEqual([]);
  files.close();
});

it('sweeps expired files on startup, including timestamps with whole seconds', () => {
  const f = fixture();
  f.db.insert(bridgeFiles).values({ connection: 'slack', file: 'F1', name: 'report.txt', contents: f.input.contents, fetchedAt: f.now().replace('.000Z', 'Z') }).run();
  f.db.insert(bridgeFileMessages).values({ connection: 'slack', file: 'F1', incoming: 'slack' }).run();
  f.clock.advance(14 * DAY);
  const files = new BridgeFiles(f.db, f.clock);
  expect(f.rows()).toEqual([]); expect(f.links()).toEqual([]);
  files.close();
});

it('rejects cross-connection references and Discord files', () => {
  const f = fixture(), files = new BridgeFiles(f.db, f.clock);
  expect(() => files.store({ ...f.input, incoming: 'discord' })).toThrow('Slack connection');
  expect(() => files.store({ ...f.input, incoming: 'discord', connection: 'discord' })).toThrow('Slack connection');
  expect(f.rows()).toEqual([]);
  files.close();
});

it('cancels retention on shutdown and sweeps on the next startup', () => {
  const f = fixture(), files = new BridgeFiles(f.db, f.clock);
  files.store(f.input);
  files.close();
  f.clock.advance(14 * DAY);
  expect(f.rows()).toHaveLength(1);
  expect(() => files.store(f.input)).toThrow('closed');
  const reopened = new BridgeFiles(f.db, f.clock);
  expect(f.rows()).toEqual([]);
  reopened.close();
});
