/** How an agent is set up to run is read by those who may change it, not by everyone who shares a project with it. */
import Database from 'better-sqlite3';
import { createHash } from 'node:crypto';
import { afterEach, expect, it } from 'vitest';
import { FakeClock } from './core/clock.js';
import { createDataSchema } from './core/data/database.js';
import { nextData } from './next-data.js';
import * as s from './core/data/schema.js';

const clean: (() => void | Promise<void>)[] = [];
afterEach(async () => { for (const close of clean.splice(0).reverse()) await close(); });
const hash = (value: string) => createHash('sha256').update(value).digest('hex');
const secretOf = (who: string) => createHash('sha256').update(`fixture ${who}`).digest('hex');
const setup = ['agentRunSettings', 'agentBoxes', 'agentHousePorts', 'agentHouseSecrets', 'agentPeople', 'agentDeniedTools'] as const;
// The roster and what goes with it: who the agent is, what it reports and which models it prefers.
const roster = ['agentStatus', 'agentModels'] as const;
function fixture() {
  const client = new Database(':memory:'), clock = new FakeClock(), at = new Date(clock.now()).toISOString();
  const db = createDataSchema(client, () => new Date(clock.now()).toISOString());
  db.insert(s.members).values([{ id: 'owner', role: 'owner', joinedAt: at }, { id: 'sam', role: 'member', joinedAt: at }, { id: 'lee', role: 'member', joinedAt: at }]).run();
  db.insert(s.agents).values(['art', 'mark'].map(id => ({ id, about: '', markBg: '#fff', markFg: '#000', faceShape: 'pebble' as const, faceEyes: 'dot' as const }))).run();
  // Sam owns art. Lee and the agent mark only share a project with it.
  db.insert(s.memberAgents).values({ member: 'sam', agent: 'art' }).run();
  db.insert(s.projects).values({ id: 'pond', name: 'Pond' }).run();
  db.insert(s.projectMembers).values([{ project: 'pond', member: 'sam' }, { project: 'pond', member: 'lee' }]).run();
  db.insert(s.projectAgents).values([{ project: 'pond', agent: 'art' }, { project: 'pond', agent: 'mark' }]).run();
  db.insert(s.boxes).values({ id: 'box', name: 'box', owner: 'sam', hostsAny: true, sameMachineAsLoom: false, reportOnly: false, alwaysOn: false, enrolledAt: at, lastSeenAt: at }).run();
  db.insert(s.secrets).values({ name: 'deploy-key', description: '', changedAt: at, changedBy: 'owner' }).run();
  db.insert(s.agentRunSettings).values({ agent: 'art', houseRepository: 'repo', houseFile: 'Housefile', houseBranch: 'next', nestedContainers: false, gpu: false }).run();
  db.insert(s.agentBoxes).values({ agent: 'art', box: 'box', position: 0 }).run();
  db.insert(s.agentHousePorts).values({ agent: 'art', address: '127.0.0.1', port: 8080 }).run();
  db.insert(s.agentHouseSecrets).values({ agent: 'art', alias: 'DEPLOY_KEY', secret: 'deploy-key' }).run();
  db.insert(s.agentPeople).values({ agent: 'art', person: JSON.stringify(['slack', 'T1', 'U1']), tier: 2 }).run();
  db.insert(s.agentDeniedTools).values({ agent: 'art', pattern: 'Bash(rm *)', guestsOnly: false }).run();
  db.insert(s.agentModels).values({ agent: 'art', model: 'model', position: 0 }).run();
  db.insert(s.agentStatus).values({ agent: 'art', state: 'idle', work: '', changedAt: at }).run();
  const until = new Date(clock.now() + 3600000).toISOString();
  for (const member of ['owner', 'sam', 'lee']) db.insert(s.tokens).values({ fingerprint: hash(secretOf(member)), label: member, kind: 'owner', member, createdAt: at, expiresAt: until }).run();
  for (const agent of ['art', 'mark']) db.insert(s.tokens).values({ fingerprint: hash(secretOf(agent)), label: agent, kind: 'agent', agent, createdAt: at, expiresAt: until }).run();
  const data = nextData(db, clock, () => true);
  clean.push(async () => { await data.close(); client.close(); });
  const read = async (who: string) => {
    const query = `{ agents { id } ${[...roster, ...setup].map(name => `${name} { agent }`).join(' ')} }`;
    const response = await data.http.request('/graphql', { method: 'POST', headers: { authorization: `Bearer ${secretOf(who)}`, 'content-type': 'application/json' }, body: JSON.stringify({ query }) });
    const body = await response.json() as { errors?: unknown; data: Record<string, { agent?: string; id?: string }[]> };
    expect(body.errors).toBeUndefined();
    return body.data;
  };
  return { read };
}
it('shows a project-mate that the agent exists and what it reports, but none of how it is set up', async () => {
  const f = fixture();
  for (const who of ['lee', 'mark']) {
    const seen = await f.read(who);
    expect(seen.agents.map(row => row.id)).toContain('art');
    for (const name of roster) expect(seen[name], `${name} for ${who}`).toEqual([{ agent: 'art' }]);
    for (const name of setup) expect(seen[name], `${name} for ${who}`).toEqual([]);
  }
});
it('shows the setup to the agent\'s own member, a household owner and the agent itself', async () => {
  const f = fixture();
  for (const who of ['sam', 'owner', 'art']) {
    const seen = await f.read(who);
    for (const name of setup) expect(seen[name], `${name} for ${who}`).toEqual([{ agent: 'art' }]);
  }
});
