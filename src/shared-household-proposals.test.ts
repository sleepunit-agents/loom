import Database from 'better-sqlite3';
import { createHash } from 'node:crypto';
import { afterEach, expect, it } from 'vitest';
import { FakeClock } from './core/clock.js';
import { createDataSchema } from './core/data/database.js';
import { agents, agentPeople, agentDeniedTools, approvals, members, tokens, projects } from './core/data/schema.js';
import { sharedRoot } from './shared-root.js';
const clean: (() => void | Promise<void>)[] = [];
afterEach(async () => { for (const close of clean.splice(0).reverse()) await close(); });
const credentials = { sam: 'a'.repeat(64), lee: 'b'.repeat(64), art: 'c'.repeat(64) };
const hash = (value: string) => createHash('sha256').update(value).digest('hex');
const visual = { about: 'Fixture agent', markBg: '#000000', markFg: '#ffffff', faceShape: 'pebble' as const, faceEyes: 'dot' as const };
function fixture() {
  const client = new Database(':memory:'); clean.push(() => { client.close(); });
  const clock = new FakeClock(), at = new Date(clock.now()).toISOString(), db = createDataSchema(client, () => new Date(clock.now()).toISOString());
  db.insert(members).values([{ id: 'sam', role: 'owner', joinedAt: at }, { id: 'lee', role: 'member', joinedAt: at }]).run();
  db.insert(agents).values([{ id: 'art', ...visual }, { id: 'mark', ...visual }]).run();
  for (const member of ['sam', 'lee'] as const) db.insert(tokens).values({ fingerprint: hash(credentials[member]), label: member, kind: 'owner', member, createdAt: at }).run();
  db.insert(tokens).values({ fingerprint: hash(credentials.art), label: 'Art', kind: 'agent', agent: 'art', createdAt: at }).run();
  const root = sharedRoot({ db, clock, originAllowed: () => true, reportError: () => {} }); clean.push(() => root.close());
  let seq = 0;
  const call = async (path: string, input: unknown, actor: keyof typeof credentials, id = 'r'+(++seq)) => {
    const response = await root.http.request('http://loom/api/'+path, { method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer '+credentials[actor] }, body: JSON.stringify({ input, id }) });
    return { status: response.status, body: await response.json() as { ok?: boolean; code?: string; value?: { id: string } } };
  };
  return { db, root, call };
}
const pond = { id: 'pond', name: 'Pond', members: ['sam', 'lee'], agents: ['art'], repositories: [] };
it('lets an agent in a terminal session propose a project; nothing changes until an owner allows it', async () => {
  const f = fixture();
  const filed = await f.call('household/propose', { change: 'project', input: pond, why: 'Lee and I are fixing the pond' }, 'art');
  expect(filed).toMatchObject({ status: 200, body: { ok: true } });
  const id = filed.body.value!.id;
  expect(f.db.select().from(projects).all()).toEqual([]);
  expect(f.db.select().from(approvals).all()).toEqual([expect.objectContaining({ id, kind: 'setting', state: 'pending', agent: 'art', operation: 'household.change',
    target: 'household:project:pond', askedFrom: 'terminal', actingFor: 'unknown', conversation: null, member: null, why: 'Lee and I are fixing the pond' })]);
  expect(f.db.select().from(approvals).get()!.changeSummary).toContain('project pond: null → {"agents":["art"]');
  for (const actor of ['lee', 'art'] as const) expect((await f.call('approvals/answer', { id, answer: 'allow' }, actor)).status).toBe(403);
  expect(f.db.select().from(projects).all()).toEqual([]);
  expect(await f.call('approvals/answer', { id, answer: 'allow' }, 'sam')).toMatchObject({ status: 200, body: { ok: true } });
  expect(f.root.services.projects.read().projects).toEqual([expect.objectContaining({ id: 'pond', name: 'Pond', members: ['lee', 'sam'], agents: ['art'] })]);
  expect(f.db.select().from(approvals).get()).toMatchObject({ state: 'used', decidedBy: 'sam' });
});
it('proposes member, agent and settings changes, and a denied card changes nothing', async () => {
  const f = fixture();
  const propose = (change: string, input: unknown, actor: keyof typeof credentials = 'art') => f.call('household/propose', { change, input, why: 'Asked in chat' }, actor);
  const allow = async (id: string, answer = 'allow') => f.call('approvals/answer', { id, answer }, 'sam');
  const member = await propose('member', { id: 'pat', role: 'member', agents: ['mark'] });
  expect((await allow(member.body.value!.id)).body.ok).toBe(true);
  expect(f.root.services.household.members().find(row => row.id === 'pat')).toMatchObject({ role: 'member', agents: ['mark'] });
  const about = await propose('agent', { id: 'art', ...visual, about: 'Keeps the household running' });
  expect((await allow(about.body.value!.id)).body.ok).toBe(true);
  expect(f.db.select().from(agents).all().find(row => row.id === 'art')!.about).toBe('Keeps the household running');
  const zone = await propose('settings', { timezone: 'America/Chicago', commsDays: 7 });
  expect(f.db.select().from(approvals).all().find(row => row.id === zone.body.value!.id)!.changeSummary).toBe('Household settings: {"commsDays":14,"timezone":"'+f.root.services.household.settings().timezone+'"} → {"commsDays":7,"timezone":"America/Chicago"}');
  expect((await allow(zone.body.value!.id, 'deny')).body.ok).toBe(true);
  expect(f.root.services.household.settings().commsDays).toBe(14);
  // People cannot use the agent's door, and a change that changes nothing is refused.
  for (const actor of ['sam', 'lee'] as const) expect((await propose('settings', { commsDays: 7 }, actor)).status).toBe(403);
  expect((await propose('settings', { commsDays: 14 })).body).toMatchObject({ code: 'invalid' });
  expect((await propose('settings', { secretsDefault: 'auto' })).status).toBe(400);
  expect((await propose('member', { id: 'pat', role: 'owner', agents: [], actor: 'sam' })).status).toBe(400);
});
it('refuses a card when what it would replace has changed, or when the change is no longer allowed', async () => {
  const f = fixture();
  const first = await f.call('household/propose', { change: 'settings', input: { commsDays: 7 }, why: 'Keep less' }, 'art');
  expect((await f.call('household/setSettings', { commsDays: 10 }, 'sam')).status).toBe(200);
  expect((await f.call('approvals/answer', { id: first.body.value!.id, answer: 'allow' }, 'sam')).body).toMatchObject({ ok: false, code: 'conflict' });
  expect(f.root.services.household.settings().commsDays).toBe(10);
  // Demoting the only owner is refused by the same rule the owner's own command follows.
  const demote = await f.call('household/propose', { change: 'member', input: { id: 'sam', role: 'member', agents: [] }, why: 'Asked' }, 'art');
  expect((await f.call('approvals/answer', { id: demote.body.value!.id, answer: 'allow' }, 'sam')).body).toMatchObject({ ok: false, code: 'conflict' });
  expect(f.root.services.household.members().find(row => row.id === 'sam')).toMatchObject({ role: 'owner' });
  expect(f.db.select().from(approvals).all().every(row => row.state === 'pending')).toBe(true);
});
it('proposes a standing approval rule, recorded as set by the owner who allowed it, and its removal', async () => {
  const f = fixture();
  const rule = { kind: 'merge', scope: 'github:Owner/Repo', person: '', tier: 'tell' };
  const filed = await f.call('household/propose', { change: 'rule', input: rule, why: 'Merges here are routine' }, 'art');
  expect(filed.body.ok).toBe(true);
  expect(f.db.select().from(approvals).get()).toMatchObject({ target: 'household:rule:merge github:owner/repo', ask: 'Change approval rule merge github:owner/repo?' });
  expect(f.root.services.approvalRules.list()).toEqual([]);
  expect((await f.call('approvals/answer', { id: filed.body.value!.id, answer: 'allow' }, 'sam')).body.ok).toBe(true);
  expect(f.root.services.approvalRules.list()).toEqual([expect.objectContaining({ kind: 'merge', scope: 'github:owner/repo', person: '', tier: 'tell', setBy: 'sam' })]);
  expect((await f.call('household/propose', { change: 'rule', input: { ...rule, scope: 'github:other/none', tier: null }, why: 'Tidy' }, 'art')).body).toMatchObject({ code: 'invalid' });
  const removal = await f.call('household/propose', { change: 'rule', input: { ...rule, tier: null }, why: 'Ask me again' }, 'art');
  expect((await f.call('approvals/answer', { id: removal.body.value!.id, answer: 'allow' }, 'sam')).body.ok).toBe(true);
  expect(f.root.services.approvalRules.list()).toEqual([]);
});
it('proposes how an agent treats outside people and which tools its body is not given', async () => {
  const f = fixture();
  const policy = { agent: 'art', people: [{ platform: 'discord', workspace: 'pond', user: 'u1', tier: 2 }], deniedTools: [{ pattern: 'Bash(rm *)', guestsOnly: true }] };
  expect((await f.call('household/propose', { change: 'bodyPolicy', input: { ...policy, agent: 'nobody' }, why: 'x' }, 'art')).body).toMatchObject({ code: 'invalid' });
  const filed = await f.call('household/propose', { change: 'bodyPolicy', input: policy, why: 'Lee asks on Discord' }, 'art');
  expect(f.db.select().from(approvals).get()).toMatchObject({ target: 'household:bodyPolicy:art', ask: 'Change how art treats outside people and tools?' });
  expect(f.db.select().from(agentPeople).all()).toEqual([]);
  expect((await f.call('approvals/answer', { id: filed.body.value!.id, answer: 'allow' }, 'sam')).body.ok).toBe(true);
  expect(f.db.select().from(agentPeople).all()).toEqual([{ agent: 'art', person: '["discord","pond","u1"]', tier: 2 }]);
  expect(f.db.select().from(agentDeniedTools).all()).toEqual([{ agent: 'art', pattern: 'Bash(rm *)', guestsOnly: true }]);
});
it('proposes one dangerous action, revoking a token by its label, and it takes effect only on Allow', async () => {
  const f = fixture();
  expect((await f.call('household/propose', { change: 'tokenRevoke', input: { label: 'nobody' }, why: 'x' }, 'art')).body).toMatchObject({ code: 'not-found' });
  const filed = await f.call('household/propose', { change: 'tokenRevoke', input: { label: 'lee' }, why: 'Lee lost the laptop' }, 'art');
  expect(f.db.select().from(approvals).get()).toMatchObject({ kind: 'dangerous', state: 'pending', target: 'household:tokenRevoke:lee', ask: 'Revoke token lee?',
    changeSummary: 'Revoke token lee: {"for":"lee","kind":"owner","label":"lee"} → revoked', ifYes: 'The token stops working at once. This cannot be undone.' });
  expect((await f.call('household/setSettings', { commsDays: 9 }, 'lee')).status).toBe(403);
  expect((await f.call('approvals/answer', { id: filed.body.value!.id, answer: 'allow' }, 'sam')).body.ok).toBe(true);
  expect(f.db.select().from(tokens).all().find(row => row.label === 'lee')!.revokedAt).toBeTruthy();
  expect((await f.call('household/setSettings', { commsDays: 9 }, 'lee')).status).toBe(401);
  expect((await f.call('household/propose', { change: 'tokenRevoke', input: { label: 'lee' }, why: 'again' }, 'art')).body).toMatchObject({ code: 'not-found' });
});
