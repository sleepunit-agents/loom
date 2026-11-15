import { afterEach, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { createHash } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { FakeClock } from './core/clock.js';
import { createDataSchema } from './core/data/database.js';
import { agents, household, members, tokens } from './core/data/schema.js';
import { serveShared } from './shared-serve.js';
import { deskMemoryFixture } from './ui/desk-memory.fixture.js';
import { deskAgentDirectory, deskAgentDirectoryQuery, type DeskAgentDirectoryData } from '../web/src/pieces/attention/agent-directory';
import { deskRecentActivity, deskRecentActivitySelection } from '../web/src/pieces/attention/recent-activity';

const closes: Array<() => unknown> = [];
afterEach(async () => { for (const close of closes.splice(0).reverse()) await close(); });

it('feeds Home directory and recent steps from the actual shared Memory listener and withdraws current access', async () => {
  const memory = deskMemoryFixture(['art']); closes.push(memory.close);
  const client = new Database(':memory:'); closes.push(() => client.close());
  const clock = new FakeClock(Date.parse('2026-11-15T12:00:00Z'));
  const now = () => new Date(clock.now()).toISOString(), db = createDataSchema(client, now);
  db.insert(members).values([{ id: 'owner', role: 'owner', joinedAt: now() }, { id: 'peer', role: 'member', joinedAt: now() }]).run();
  db.insert(agents).values({ id: 'art', about: '', markBg: '', markFg: '', faceShape: 'pebble', faceEyes: 'dot' }).run();
  db.insert(household).values({ timezone: 'America/Chicago' }).run();
  const bearer = 'fictional-desk-memory-'.repeat(4);
  db.insert(tokens).values({ fingerprint: createHash('sha256').update(bearer).digest('hex'), label: 'Fictional reader', kind: 'owner', member: 'owner', createdAt: now() }).run();
  const app = await serveShared({ db, clock, memory: { sources: memory.sources, checkingAgent: 'art' }, originAllowed: () => true, reportError: error => { throw error; } });
  closes.push(() => app.close());
  const { value: digest } = app.writes.run(() => {
    const conversation = app.services.conversations.open({ agent: 'art', member: 'peer', venue: 'wake', place: 'desk-fixture', label: 'Actual Home step' });
    app.services.conversations.turn({ conversation: conversation.id, kind: 'reply', fromKind: 'agent', fromId: 'art' });
    return app.services.conversations.digest({ conversation: conversation.id, run: 'fictional-step', summary: 'The shared Activity source supplied this step.' });
  });
  const read = async (query: string, variables = {}) => {
    const response = await fetch(app.url + '/graphql', { method: 'POST', headers: { authorization: 'Bearer ' + bearer, 'content-type': 'application/json' }, body: JSON.stringify({ query, variables }) });
    expect(response.status).toBe(200);
    const result = await response.json(); expect(result.errors).toBeUndefined();
    return result.data;
  };
  const directory = async () => deskAgentDirectory({ status: 'live', data: await read(deskAgentDirectoryQuery) as DeskAgentDirectoryData });
  const activity = async () => deskRecentActivity({ status: 'live', data: deskRecentActivitySelection.decode(await read(deskRecentActivitySelection.query, deskRecentActivitySelection.variables)) });
  expect((await directory()).records).toEqual([{ id: 'commons:art', slug: 'art', name: memory.name, kind: 'agent' }]);
  expect((await activity()).records[0].entries).toContainEqual(expect.objectContaining({ id: `d~art~${digest.id}`, agent: 'art', title: 'Actual Home step', line: 'The shared Activity source supplied this step.' }));
  app.writes.run(() => db.update(members).set({ role: 'member' }).where(eq(members.id, 'owner')).run());
  expect(await directory()).toEqual({ status: 'denied', records: [] });
  expect(await activity()).toEqual({ status: 'denied', records: [] });
});
