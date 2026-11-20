import Database from 'better-sqlite3';
import { afterEach, expect, it } from 'vitest';
import { createDataSchema } from './core/data/database.js';
import { agents, bridgeConnections, bridgePeople, conversations, members, secrets } from './core/data/schema.js';
import { outsideNames } from './shared-outside-names.js';

const clean: (() => void)[] = [];
afterEach(() => { for (const close of clean.splice(0)) close(); });
const at = '2026-11-19T00:00:00.000Z';
function fixture() {
  const client = new Database(':memory:'); clean.push(() => client.close());
  const db = createDataSchema(client, () => at);
  db.insert(members).values({ id: 'gage', role: 'member', joinedAt: at }).run();
  db.insert(agents).values({ id: 'art', about: '', markBg: '#000000', markFg: '#ffffff', faceShape: 'pebble', faceEyes: 'dot' }).run();
  return { db, names: outsideNames(db) };
}

it('names only an exact indexed person link', () => {
  const f = fixture();
  f.db.insert(bridgePeople).values({ platform: 'slack', workspace: 'T1', user: 'U1', member: 'gage' }).run();
  expect(f.names.person('slack', 'T1', 'U1')).toEqual({ name: 'gage', source: 'Household person link for this account' });
  expect(f.names.person('slack', 'T2', 'U1')).toBeNull();
  expect(f.names.person('discord', 'T1', 'U1')).toBeNull();
  expect(f.names.person('slack', 'T1', 'U2')).toBeNull();
});
it('names a Discord channel from its conversation label, never a thread, a direct message or a Slack channel', () => {
  const f = fixture();
  const talk = (id: string, venue: 'discord' | 'slack', place: unknown[], label: string, more: { member?: string; direct?: boolean } = {}) =>
    f.db.insert(conversations).values({ id, agent: 'art', venue, place: JSON.stringify(place), label, member: more.member ?? null, direct: more.direct ?? false, startedAt: at, lastAt: at, turnCount: 0 }).run();
  talk('c1', 'discord', ['G1', 'C9', null], 'Discord channel #pond');
  talk('c2', 'discord', ['G1', 'T7', 'T7'], 'Discord thread #plans under #pond');
  talk('c3', 'discord', ['G1', 'D5', null, ['member', 'gage']], 'Discord direct message with gage', { member: 'gage', direct: true });
  talk('c4', 'discord', ['G1', 'C8', null], 'Discord channel #C8');
  talk('c5', 'slack', ['T1', 'C1', null], 'C1');
  expect(f.names.channel('discord', 'G1', 'C9')).toEqual({ name: '#pond', source: 'The name Discord gave with a message from there' });
  expect(f.names.channel('discord', 'G2', 'C9')).toBeNull();
  expect(f.names.channel('discord', 'G1', 'T7')).toBeNull();
  expect(f.names.channel('discord', 'G1', 'D5')).toBeNull();
  // A label that only repeats the id is no name.
  expect(f.names.channel('discord', 'G1', 'C8')).toBeNull();
  expect(f.names.channel('slack', 'T1', 'C1')).toBeNull();
});
it('holds no name for a workspace: it says the connection that reaches it, or nothing', () => {
  const f = fixture();
  f.db.insert(secrets).values({ name: 'token', description: 'Bot token', changedAt: at, changedBy: 'gage' }).run();
  f.db.insert(bridgeConnections).values([{ id: 'art-slack', platform: 'slack', agent: 'art', workspace: 'T1', botUser: 'B', tokenSecret: 'token', enabled: true, state: 'connected', stateAt: at },
    { id: 'old-slack', platform: 'slack', agent: 'art', workspace: 'T1', botUser: 'B2', tokenSecret: 'token', enabled: false, state: 'disconnected', stateAt: at, removedAt: at }]).run();
  expect(f.names.workspace('slack', 'T1')).toEqual({ name: 'art-slack', source: 'reached by the connection' });
  expect(f.names.workspace('slack', 'T2')).toBeNull();
  expect(f.names.workspace('discord', 'T1')).toBeNull();
});
