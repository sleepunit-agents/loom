import Database from 'better-sqlite3';
import { afterEach, expect, it } from 'vitest';
import { createDataSchema } from './core/data/database.js';
import { agents, bridgeConnections, bridgePeople, conversations, members, secrets } from './core/data/schema.js';
import { outsideNames, type NamedCard } from './shared-outside-names.js';

const clean: (() => void)[] = [];
afterEach(() => { for (const close of clean.splice(0)) close(); });
const at = '2026-11-19T00:00:00.000Z';
function fixture(cards: NamedCard[] = []) {
  const client = new Database(':memory:'); clean.push(() => client.close());
  const db = createDataSchema(client, () => at);
  db.insert(members).values({ id: 'gage', role: 'member', joinedAt: at }).run();
  db.insert(agents).values({ id: 'art', about: '', markBg: '#000000', markFg: '#ffffff', faceShape: 'pebble', faceEyes: 'dot' }).run();
  let reads = 0;
  return { db, names: outsideNames(db, () => { reads++; return cards; }), reads: () => reads };
}

it('names an outside account from a person card that lists exactly that account, and from nothing less', () => {
  const f = fixture([{ name: 'Gage Taylor', agent: 'art', fields: [{ key: 'slack', value: 'U07V8CZUC1J' }, { key: 'pond', value: 'field' }] },
    { name: 'Sam Reed', fields: [{ key: 'discord_id', value: '<@4455>, @7788' }] },
    { name: 'Wrong Field', fields: [{ key: 'github', value: 'U0GITHUB' }] }]);
  expect(f.names.person('slack', 'T1', 'U07V8CZUC1J')).toEqual({ name: 'Gage Taylor', source: 'Art’s person card, which lists this account' });
  expect(f.names.person('discord', 'G1', '4455')).toEqual({ name: 'Sam Reed', source: 'The household’s people directory, which lists this account' });
  expect(f.names.person('discord', 'G1', '7788')?.name).toBe('Sam Reed');
  // Part of an id, another platform's field, or a field that is not the platform's own names nobody.
  expect(f.names.person('slack', 'T1', 'U07V8CZUC1')).toBeNull();
  expect(f.names.person('discord', 'G1', 'U07V8CZUC1J')).toBeNull();
  expect(f.names.person('slack', 'T1', 'U0GITHUB')).toBeNull();
  // The cards are read once for one card, however many accounts it names.
  expect(f.reads()).toBe(1);
});
it('does not guess between two cards that name the same account differently, and survives an unreadable directory', () => {
  const two = fixture([{ name: 'Gage Taylor', agent: 'art', fields: [{ key: 'slack', value: 'U1' }] }, { name: 'G. Taylor', fields: [{ key: 'slack', value: 'U1' }] }]);
  expect(two.names.person('slack', 'T1', 'U1')).toBeNull();
  const agree = fixture([{ name: 'Gage Taylor', agent: 'art', fields: [{ key: 'slack', value: 'U1' }] }, { name: 'Gage Taylor', fields: [{ key: 'slack', value: 'U1' }] }]);
  expect(agree.names.person('slack', 'T1', 'U1')?.name).toBe('Gage Taylor');
  const client = new Database(':memory:'); clean.push(() => client.close());
  expect(outsideNames(createDataSchema(client, () => at), () => { throw new Error('People source unavailable'); }).person('slack', 'T1', 'U1')).toBeNull();
});
it('names an account by its person link first: the link says who somebody is', () => {
  const f = fixture([{ name: 'Somebody Else', agent: 'art', fields: [{ key: 'slack', value: 'U1' }] }]);
  f.db.insert(bridgePeople).values({ platform: 'slack', workspace: 'T1', user: 'U1', member: 'gage' }).run();
  expect(f.names.person('slack', 'T1', 'U1')).toEqual({ name: 'Gage', source: 'A person link: this account is the household member gage' });
  // The link is for one workspace.
  expect(f.names.person('slack', 'T2', 'U1')?.name).toBe('Somebody Else');
  expect(f.reads()).toBe(1);
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
