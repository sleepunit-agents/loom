/** The exact registered-app selections against the generated schema and the
 * existing Comms member field. Root's outside policy/transport is separate. */
import Database from 'better-sqlite3';
import { afterEach, expect, it } from 'vitest';
import { graphql } from 'graphql/index.js';
import { sql } from 'drizzle-orm';
import { createDataSchema } from '../../core/data/database.js';
import { dataQueries } from '../../core/data/queries.js';
import { withQueryFields } from '../../core/data/http.js';
import { CommsQueries, commsQueryFields } from '../../core/conversations/comms-query.js';
import { members, agents, secrets, household, bridgeConnections, bridgeChannelFilters, bridgeChannels, bridgePeople, bridgeIncoming, bridgeSends, jobs, secretGrants, secretRequests, secretRules, secretRuleAgents, secretUses, secretChanges } from '../../core/data/schema.js';
import { bridgesQuery, bridgesSnapshot, type BridgesData } from '../../../web/src/pieces/bridges/data';
import { settingsQuery, settingsSnapshot, type SettingsData } from '../../../web/src/pieces/settings/data';
const opened: Database.Database[] = [];
afterEach(() => { for (const client of opened.splice(0)) client.close(); });
const now = () => '2026-11-14T12:00:00.000Z';
function fixture() {
  const client = new Database(':memory:'); opened.push(client); const db = createDataSchema(client, now);
  db.insert(members).values({ id: 'owner', role: 'owner', joinedAt: now() }).run();
  db.insert(agents).values({ id: 'art', about: '', markBg: '#000', markFg: '#fff', faceShape: 'pebble', faceEyes: 'dot' }).run();
  db.insert(household).values({ secretsDefault: 'ask' }).run();
  db.insert(secrets).values({ name: 'API', description: 'Stored credential', changedBy: 'owner', changedAt: now() }).run();
  db.insert(secretChanges).values({ id: 'add', secret: 'API', action: 'add', by: 'owner', at: now() }).run();
  db.insert(bridgeConnections).values({ id: 'c', platform: 'slack', agent: 'art', workspace: 'workspace', botUser: 'bot', tokenSecret: 'API', appSecret: 'API', enabled: true, state: 'connected', stateAt: now() }).run();
  db.insert(bridgeChannelFilters).values({ connection: 'c', channel: 'room', rule: 'only' }).run();
  db.insert(bridgeChannels).values({ platform: 'slack', workspace: 'workspace', channel: 'room', answers: 'art', botsMayTalk: false }).run();
  db.insert(bridgePeople).values({ platform: 'slack', workspace: 'workspace', user: 'outside', member: 'owner' }).run();
  db.insert(bridgeIncoming).values({ id: 'in', connection: 'c', channel: 'room', isDm: false, user: 'outside', member: 'owner', text: 'Hello', postedAt: now(), receivedAt: now(), state: 'delivered' }).run();
  db.insert(bridgeSends).values({ id: 'out', incoming: 'in', connection: 'c', channel: 'room', text: 'Held reply', state: 'held', createdAt: now() }).run();
  db.insert(jobs).values({ id: 'job', agent: 'art', title: '', brief: '', model: 'test', state: 'running', startedByKind: 'agent', startedBy: 'art', houseRepository: '', houseFile: '', houseBranch: '', queuedAt: now() }).run();
  db.insert(secretRequests).values({ id: 'request', secret: 'API', agent: 'art', job: 'job', why: 'Use it', state: 'allowed', minutes: 5, always: true, askedAt: now(), answeredAt: now(), answeredBy: 'owner' }).run();
  db.insert(secretGrants).values({ id: 'grant', secret: 'API', agent: 'art', job: 'job', request: 'request', grantedBy: 'owner', grantedAt: now(), expiresAt: '2026-11-14T12:05:00.000Z' }).run();
  db.insert(secretRules).values({ secret: 'API', answer: 'auto', minutes: 5 }).run();
  db.insert(secretRuleAgents).values({ secret: 'API', agent: 'art', when: 'at_start' }).run();
  db.insert(secretUses).values({ id: 'use', secret: 'API', agent: 'art', job: 'job', at: now(), state: 'released' }).run();
  const unreachable = () => { throw Error('Metadata query touched private words'); };
  const comms = new CommsQueries(db, { seal: unreachable, open: unreachable, hash: unreachable }, () => sql`true`, now);
  const tables = ['household', 'secrets', 'secretGrants', 'secretRequests', 'secretRules', 'secretRuleAgents', 'secretUses', 'secretChanges', 'bridgeConnections', 'bridgeChannelFilters', 'bridgeChannels', 'bridgePeople', 'bridgeSends'] as const;
  const schema = withQueryFields(dataQueries(client, { tables: [...tables], visibility: Object.fromEntries(tables.map(table => [table, () => sql`true`])) }), commsQueryFields(comms));
  return { schema };
}
it('executes the actual Bridges app query without legacy records or a guessed member', async () => {
  const { schema } = fixture(), result = await graphql({ schema, source: bridgesQuery, contextValue: { viewer: { kind: 'member', id: 'owner' } } });
  expect(result.errors).toBeUndefined();
  const snapshot = bridgesSnapshot({ status: 'live', data: result.data as unknown as BridgesData });
  expect(snapshot).toMatchObject({ status: 'live', member: 'owner', connections: [{ id: 'c', state: 'connected', tokenSecret: 'API' }], filters: [{ channel: 'room', rule: 'only' }], channels: [{ answers: 'art' }], people: [{ member: 'owner' }], sends: [{ id: 'out', state: 'held' }] });
});
it('executes the actual Settings app query including job use/audit and household default, with no value field', async () => {
  const { schema } = fixture(), result = await graphql({ schema, source: settingsQuery, contextValue: { viewer: { kind: 'member', id: 'owner' } } });
  expect(result.errors).toBeUndefined();
  const snapshot = settingsSnapshot({ status: 'live', data: result.data as unknown as SettingsData });
  expect(snapshot).toMatchObject({ status: 'live', member: 'owner', defaultAnswer: 'ask', secrets: [{ name: 'API' }], grants: [{ id: 'grant', job: 'job' }], requests: [{ id: 'request', state: 'allowed' }], rules: [{ answer: 'auto' }], ruleAgents: [{ when: 'at_start' }], uses: [{ job: 'job', state: 'released' }], changes: [{ action: 'add' }] });
  const forbidden = await graphql({ schema, source: '{ secrets { value } }' }); expect(forbidden.errors?.[0].message).toContain('Cannot query field');
});
