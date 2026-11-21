import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { bodyCredentials,bodyFixture } from '../test/fixtures/conversation-body.js';
import { PeopleStore } from './backends/people.js';
import type { SharedMemoryOptions } from './shared-memory.js';
import Database from 'better-sqlite3';
import { createHash } from 'node:crypto';
import { afterEach, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { FakeClock } from './core/clock.js';
import { createDataSchema } from './core/data/database.js';
import { agentKitProjects, agentKitOutsidePeople, projectOutsidePeople, jobs, agents, agentKits, agentKitMembers, agentAccounts, agentBoxes, agentHouseSecrets, conversations, bridgeConnections, bridgeChannels, bridgePeople, household, measuringSettings, secretRuleAgents, secretRules, secrets, agentPeople, agentDeniedTools, agentRunSettings, approvals, approvalRecord, boxAgents, boxes, memberAgents, members, sessions, tokens, projects, projectMembers, projectAgents, projectRepositories, tasks, inbox } from './core/data/schema.js';
import { OperationError } from './core/operations/index.js';
import { applyKitChange, kitBefore } from './shared-kit-cards.js';
import type { DataDatabase } from './core/data/database.js';
import { sharedRoot } from './shared-root.js';
const clean: (() => void | Promise<void>)[] = [];
afterEach(async () => { for (const close of clean.splice(0).reverse()) await close(); });
const credentials = { sam: 'a'.repeat(64), lee: 'b'.repeat(64), art: 'c'.repeat(64) };
const hash = (value: string) => createHash('sha256').update(value).digest('hex');
const visual = { about: 'Fixture agent', markBg: '#000000', markFg: '#ffffff', faceShape: 'pebble' as const, faceEyes: 'dot' as const };
function fixture(memory?: SharedMemoryOptions) {
  const client = new Database(':memory:'); clean.push(() => { client.close(); });
  const clock = new FakeClock(), at = new Date(clock.now()).toISOString(), db = createDataSchema(client, () => new Date(clock.now()).toISOString());
  db.insert(members).values([{ id: 'sam', role: 'owner', joinedAt: at }, { id: 'lee', role: 'member', joinedAt: at }]).run();
  db.insert(agents).values([{ id: 'art', ...visual }, { id: 'mark', ...visual }]).run();
  for (const member of ['sam', 'lee'] as const) db.insert(tokens).values({ fingerprint: hash(credentials[member]), label: member, kind: 'owner', member, createdAt: at }).run();
  db.insert(tokens).values({ fingerprint: hash(credentials.art), label: 'Art', kind: 'agent', agent: 'art', createdAt: at }).run();
  const root = sharedRoot({ db, clock, memory, originAllowed: () => true, reportError: () => {} }); clean.push(() => root.close());
  let seq = 0;
  const call = async (path: string, input: unknown, actor: keyof typeof credentials, id = 'r'+(++seq)) => {
    const response = await root.http.request('http://loom/api/'+path, { method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer '+credentials[actor] }, body: JSON.stringify({ input, id }) });
    return { status: response.status, body: await response.json() as { ok?: boolean; code?: string; message?: string; value?: { id: string; state?: string } } };
  };
  return { db, root, call, clock };
}
const pond = { id: 'pond', name: 'Pond', members: ['sam', 'lee'], agents: ['art'], repositories: [] };
type Fixture = ReturnType<typeof fixture>;
/** What a household owner is told about a waiting card: what it would replace, and what already stands against it. */
const look = async (f: Fixture, id: string, owner: keyof typeof credentials = 'sam') => (await f.call('household/proposal', { id }, owner)).body.value as unknown as { summary: string; problem: string | null };
/** What an owner is told as soon as they look: these are plain to see from what is there now. */
const plain = ['That is how it already is', 'Unknown agent', 'No live machine has that id', 'No live token has that label', 'No live machine has that name', 'No such signed-in browser', 'There is no such rule to remove'];
/** A change that cannot be made is filed like any other, and the asker is told nothing of why not. The
 * owner's Allow is refused in the words of the rule it breaks, the card stays, and they deny it. */
const hopeless = async (f: Fixture, filed: Awaited<ReturnType<Fixture['call']>>, problem?: string) => {
  expect(filed).toMatchObject({ status: 200, body: { ok: true, value: { state: 'pending' } } });
  const id = filed.body.value!.id;
  expect((await look(f, id)).problem).toBe(problem && plain.includes(problem) ? problem : null);
  expect((await f.call('approvals/answer', { id, answer: 'allow', confirm: true }, 'sam')).body).toMatchObject({ ok: false, ...(problem ? { message: problem } : {}) });
  expect(f.db.select().from(approvals).where(eq(approvals.id, id)).get()).toMatchObject({ state: 'pending' });
  expect((await f.call('approvals/answer', { id, answer: 'deny' }, 'sam')).body.ok).toBe(true);
};
it('lets an agent in a terminal session propose a project; nothing changes until an owner allows it', async () => {
  const f = fixture();
  const filed = await f.call('household/propose', { change: 'project', input: pond, why: 'Lee and I are fixing the pond' }, 'art');
  expect(filed).toMatchObject({ status: 200, body: { ok: true } });
  const id = filed.body.value!.id;
  expect(f.db.select().from(projects).all()).toEqual([]);
  expect(f.db.select().from(approvals).all()).toEqual([expect.objectContaining({ id, kind: 'setting', state: 'pending', agent: 'art', operation: 'household.change',
    target: 'household:project:pond', askedFrom: 'terminal', actingFor: 'unknown', conversation: null, member: null, why: 'Lee and I are fixing the pond' })]);
  // The card says what was asked for. What it would replace is for a household owner, who asks for it.
  expect(f.db.select().from(approvals).get()!.changeSummary).toContain('project pond: {"agents":["art"]');
  expect(await look(f, id)).toEqual({ summary: expect.stringContaining('project pond: null → {"agents":["art"]'), problem: null });
  for (const actor of ['lee', 'art'] as const) expect((await f.call('household/proposal', { id }, actor)).status).toBe(403);
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
  expect(f.db.select().from(approvals).all().find(row => row.id === zone.body.value!.id)!.changeSummary).toBe('Household settings: {"commsDays":7,"timezone":"America/Chicago"}');
  expect((await look(f, zone.body.value!.id)).summary).toBe('Household settings: {"commsDays":14,"timezone":"'+f.root.services.household.settings().timezone+'"} → {"commsDays":7,"timezone":"America/Chicago"}');
  expect((await allow(zone.body.value!.id, 'deny')).body.ok).toBe(true);
  expect(f.root.services.household.settings().commsDays).toBe(14);
  // People cannot use the agent's door. A change that changes nothing is the owner's to be told of.
  for (const actor of ['sam', 'lee'] as const) expect((await propose('settings', { commsDays: 7 }, actor)).status).toBe(403);
  await hopeless(f, await propose('settings', { commsDays: 14 }), 'That is how it already is');
  expect((await propose('settings', { secretsDefault: 'auto' })).status).toBe(400);
  expect((await propose('member', { id: 'pat', role: 'owner', agents: [], actor: 'sam' })).status).toBe(400);
});
it('refuses a card when what it would replace has changed, or when the change is no longer allowed', async () => {
  const f = fixture();
  const first = await f.call('household/propose', { change: 'settings', input: { commsDays: 7 }, why: 'Keep less' }, 'art');
  f.root.writes.run(() => f.root.services.setup.settings({ commsDays: 10 }));
  expect((await f.call('approvals/answer', { id: first.body.value!.id, answer: 'allow' }, 'sam')).body).toMatchObject({ ok: false, code: 'conflict' });
  expect(f.root.services.household.settings().commsDays).toBe(10);
  expect((await look(f, first.body.value!.id)).problem).toBe('This has changed since the card was filed. Open the updated card to review it.');
  // A change that could never be allowed is refused to the owner, in the words of the rule it breaks.
  await hopeless(f, await f.call('household/propose', { change: 'member', input: { id: 'sam', role: 'member', agents: [] }, why: 'Asked' }, 'art'), 'At least one household owner must remain');
  await hopeless(f, await f.call('household/propose', { change: 'project', input: { ...pond, members: ['nobody'] }, why: 'Asked' }, 'art'));
  await hopeless(f, await f.call('household/propose', { change: 'member', input: { id: 'pat', role: 'member', agents: ['no-agent'] }, why: 'Asked' }, 'art'));
  expect(f.root.services.household.members().find(row => row.id === 'sam')).toMatchObject({ role: 'owner' });
  expect(f.db.select().from(projects).all()).toEqual([]);
  // Only the stale card still waits, and the asker's second card for the same thing waits its turn.
  expect(f.db.select().from(approvals).all().filter(row => row.state === 'pending')).toHaveLength(1);
  expect((await f.call('household/propose', { change: 'settings', input: { commsDays: 8 }, why: 'Again' }, 'art')).body).toMatchObject({ ok: false, code: 'conflict', message: 'A card for this is already waiting for an answer' });
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
  await hopeless(f, await f.call('household/propose', { change: 'rule', input: { ...rule, scope: 'github:other/none', tier: null }, why: 'Tidy' }, 'art'), 'There is no such rule to remove');
  const removal = await f.call('household/propose', { change: 'rule', input: { ...rule, tier: null }, why: 'Ask me again' }, 'art');
  expect((await f.call('approvals/answer', { id: removal.body.value!.id, answer: 'allow' }, 'sam')).body.ok).toBe(true);
  expect(f.root.services.approvalRules.list()).toEqual([]);
});
it('proposes how an agent treats outside people and which tools its body is not given', async () => {
  const f = fixture();
  const policy = { agent: 'art', people: [{ platform: 'discord', workspace: 'pond', user: 'u1', tier: 2 }], deniedTools: [{ pattern: 'Bash(rm *)', guestsOnly: true }] };
  const filed = await f.call('household/propose', { change: 'bodyPolicy', input: policy, why: 'Lee asks on Discord' }, 'art');
  expect(f.db.select().from(approvals).get()).toMatchObject({ target: 'household:bodyPolicy:art', ask: 'Change how art treats outside people and tools?' });
  expect(f.db.select().from(agentPeople).all()).toEqual([]);
  expect((await f.call('approvals/answer', { id: filed.body.value!.id, answer: 'allow' }, 'sam')).body.ok).toBe(true);
  expect(f.db.select().from(agentPeople).all()).toEqual([{ agent: 'art', person: '["discord","pond","u1"]', tier: 2 }]);
  expect(f.db.select().from(agentDeniedTools).all()).toEqual([{ agent: 'art', pattern: 'Bash(rm *)', guestsOnly: true }]);
  await hopeless(f, await f.call('household/propose', { change: 'bodyPolicy', input: { ...policy, agent: 'nobody' }, why: 'x' }, 'art'), 'Unknown agent');
});
it('proposes one dangerous action, revoking a token by its label, and it takes effect only on Allow', async () => {
  const f = fixture();
  const filed = await f.call('household/propose', { change: 'tokenRevoke', input: { label: 'lee' }, why: 'Lee lost the laptop' }, 'art');
  expect(f.db.select().from(approvals).get()).toMatchObject({ kind: 'dangerous', state: 'pending', target: 'household:tokenRevoke:lee', ask: 'Revoke token lee?',
    changeSummary: 'Revoke token lee', what: 'Revoke token lee', ifYes: 'The token stops working at once. This cannot be undone.' });
  expect(await look(f, filed.body.value!.id)).toEqual({ summary: 'Revoke token lee: {"for":"lee","kind":"owner","label":"lee"} → revoked', problem: null });
  // Lee's token still works: the door knows Lee, and refuses only because Lee is not an owner.
  expect((await f.call('approvals/answer', { id: filed.body.value!.id, answer: 'deny' }, 'lee')).status).toBe(403);
  // Allowing a dangerous card takes a second, explicit yes. Without it nothing happens.
  expect((await f.call('approvals/answer', { id: filed.body.value!.id, answer: 'allow' }, 'sam')).body).toMatchObject({ ok: false, code: 'invalid', message: expect.stringContaining('cannot be undone') });
  expect(f.db.select().from(approvals).get()).toMatchObject({ state: 'pending' });
  expect(f.db.select().from(tokens).all().find(row => row.label === 'lee')!.revokedAt).toBeNull();
  expect((await f.call('approvals/answer', { id: filed.body.value!.id, answer: 'allow', confirm: true }, 'sam')).body.ok).toBe(true);
  expect(f.db.select().from(tokens).all().find(row => row.label === 'lee')!.revokedAt).toBeTruthy();
  expect((await f.call('approvals/answer', { id: filed.body.value!.id, answer: 'deny' }, 'lee')).status).toBe(401);
  // A label no live token has is asked for like any other: the asker cannot tell the two apart.
  await hopeless(f, await f.call('household/propose', { change: 'tokenRevoke', input: { label: 'lee' }, why: 'again' }, 'art'), 'No live token has that label');
  await hopeless(f, await f.call('household/propose', { change: 'tokenRevoke', input: { label: 'nobody' }, why: 'x' }, 'art'), 'No live token has that label');
  // A token that ran out is not live, however its expiry was written: here without milliseconds, in the same second.
  const ended = new Date(f.clock.now()).toISOString().replace('.000Z', 'Z'); expect(ended).toMatch(/:00Z$/);
  f.db.insert(tokens).values({ fingerprint: hash('x'.repeat(64)), label: 'Ended', kind: 'owner', member: 'sam', createdAt: new Date(0).toISOString(), expiresAt: ended }).run();
  await hopeless(f, await f.call('household/propose', { change: 'tokenRevoke', input: { label: 'Ended' }, why: 'x' }, 'art'), 'No live token has that label');
});
it('proposes revoking a machine and signing out a browser; a deny needs no confirmation and a setting card needs none either', async () => {
  const f = fixture(), at = new Date(0).toISOString();
  f.root.writes.run(() => {
    f.db.insert(boxes).values({ id: 'box-1', name: 'workshop', owner: 'sam', hostsAny: true, sameMachineAsLoom: false, reportOnly: false, alwaysOn: false, enrolledAt: at }).run();
    for (const id of ['s1', 's2']) f.db.insert(sessions).values({ id, token: hash(credentials.lee), device: 'Chrome on Mac', via: 'link', isAgent: false, issuedAt: at, seenAt: at, provedAt: at }).run();
    f.db.insert(sessions).values({ id: 's3', token: hash(credentials.lee), device: 'Safari on iPhone', via: 'link', isAgent: false, issuedAt: at, seenAt: at, provedAt: at }).run();
  });
  const propose = (change: string, input: unknown) => f.call('household/propose', { change, input, why: 'Asked in chat' }, 'art');
  await hopeless(f, await propose('boxRevoke', { name: 'attic' }), 'No live machine has that name');
  await hopeless(f, await propose('browserSignOut', { member: 'lee', device: 'Firefox' }), 'No such signed-in browser');
  const box = await propose('boxRevoke', { name: 'workshop' });
  expect(f.db.select().from(approvals).all().find(row => row.id === box.body.value!.id)).toMatchObject({ kind: 'dangerous', ask: 'Revoke machine workshop?', changeSummary: 'Revoke machine workshop' });
  expect((await look(f, box.body.value!.id)).summary).toBe('Revoke machine workshop: {"name":"workshop","owner":"sam"} → revoked');
  expect((await f.call('approvals/answer', { id: box.body.value!.id, answer: 'deny' }, 'sam')).body.ok).toBe(true);
  expect(f.db.select().from(boxes).get()!.revokedAt).toBeNull();
  const again = await propose('boxRevoke', { name: 'workshop' });
  expect((await f.call('approvals/answer', { id: again.body.value!.id, answer: 'allow' }, 'sam')).body.ok).toBe(false);
  expect((await f.call('approvals/answer', { id: again.body.value!.id, answer: 'allow', confirm: true }, 'sam')).body.ok).toBe(true);
  expect(f.db.select().from(boxes).get()!.revokedAt).toBeTruthy();
  const browser = await propose('browserSignOut', { member: 'lee', device: 'Chrome on Mac' });
  expect(f.db.select().from(approvals).all().find(row => row.id === browser.body.value!.id)).toMatchObject({ kind: 'dangerous', ask: 'Sign out browser Chrome on Mac of lee?', changeSummary: 'Sign out browser Chrome on Mac of lee' });
  expect((await look(f, browser.body.value!.id)).summary).toBe('Sign out browser Chrome on Mac of lee: {"browsers":2,"device":"Chrome on Mac","member":"lee"} → signed out');
  expect((await f.call('approvals/answer', { id: browser.body.value!.id, answer: 'allow', confirm: true }, 'sam')).body.ok).toBe(true);
  expect(f.db.select().from(sessions).all().map(row => row.id)).toEqual(['s3']);
  // An ordinary settings card is allowed with one answer.
  const setting = await propose('settings', { commsDays: 7 });
  expect((await f.call('approvals/answer', { id: setting.body.value!.id, answer: 'allow' }, 'sam')).body.ok).toBe(true);
});
it('proposes a machine\'s settings, how an agent runs, and its outside accounts', async () => {
  const f = fixture(), at = new Date(0).toISOString();
  f.root.writes.run(() => {
    f.db.insert(boxes).values({ id: 'box-1', name: 'workshop', owner: 'sam', hostsAny: false, sameMachineAsLoom: false, reportOnly: true, alwaysOn: false, enrolledAt: at }).run();
    f.db.insert(memberAgents).values({ member: 'sam', agent: 'art' }).run();
  });
  const propose = (change: string, input: unknown) => f.call('household/propose', { change, input, why: 'Asked in chat' }, 'art');
  const allow = (id: string) => f.call('approvals/answer', { id, answer: 'allow' }, 'sam');
  const machine = { box: 'box-1', name: 'workshop', hostsAny: false, reportOnly: false, alwaysOn: true, agents: [{ agent: 'art', lent: false }], facts: ['gpu:5090'] };
  await hopeless(f, await propose('boxSettings', { ...machine, box: 'no-such-box' }), 'No live machine has that id');
  await hopeless(f, await propose('boxSettings', { ...machine, agents: [{ agent: 'art', lent: true }] }), 'Lending must match current agent ownership');
  const settings = await propose('boxSettings', machine);
  expect(f.db.select().from(approvals).all().find(row => row.id === settings.body.value!.id)).toMatchObject({ kind: 'setting', ask: 'Change settings of machine workshop?', target: 'household:boxSettings:box-1' });
  expect((await allow(settings.body.value!.id)).body.ok).toBe(true);
  expect(f.db.select().from(boxes).get()).toMatchObject({ reportOnly: false, alwaysOn: true });
  expect(f.db.select().from(boxAgents).all()).toEqual([{ box: 'box-1', agent: 'art', lent: false }]);
  const run = { agent: 'art', houseRepository: 'https://example.invalid/house.git', houseFile: 'Housefile', houseBranch: 'main', nestedContainers: false, gpu: true, boxes: ['box-1'], ports: [] };
  for (const prefers of [[''], ['gpu', ' gpu '], ['broken\nname'], Array.from({ length: 129 }, (_, i) => String(i))]) {
    expect((await propose('runSettings', { ...run, prefers })).body.ok).toBe(false);
  }
  const filed = await propose('runSettings', { ...run, prefers: [' fast ', 'local'] });
  expect(filed.body.ok).toBe(true);
  expect(f.db.select().from(agentRunSettings).all()).toEqual([]);
  expect((await allow(filed.body.value!.id)).body.ok).toBe(true);
  expect(f.db.select().from(agentRunSettings).get()).toMatchObject({ agent: 'art', houseBranch: 'main', gpu: true, prefers: ['fast', 'local'] });
  expect(f.db.select().from(agentBoxes).all()).toEqual([{ agent: 'art', box: 'box-1', position: 0 }]);
  await hopeless(f, await propose('runSettings', { ...run, boxes: ['no-such-box'] }));
  // No Housefile: the agent runs in the core house loom provides. The card says so in words, to everyone who reads it.
  const core = await propose('runSettings', { ...run, houseFile: '' });
  expect(f.db.select().from(approvals).all().find(row => row.id === core.body.value!.id)).toMatchObject({ kind: 'setting', ask: 'Change how art runs, in the core house with no Housefile of its own?', target: 'household:runSettings:art' });
  expect((await allow(core.body.value!.id)).body.ok).toBe(true);
  expect(f.db.select().from(agentRunSettings).get()).toMatchObject({ agent: 'art', houseFile: '', houseRepository: 'https://example.invalid/house.git', prefers: ['fast', 'local'] });
  const clear = await propose('runSettings', { ...run, prefers: [] });
  expect((await look(f, clear.body.value!.id)).summary).toContain('"prefers":["fast","local"]');
  expect((await allow(clear.body.value!.id)).body.ok).toBe(true);
  expect(f.db.select().from(agentRunSettings).get()?.prefers).toEqual([]);
  // A path is still a path: one that climbs or is absolute is no Housefile, empty or not.
  for (const houseFile of ['../Housefile', '/Housefile', 'a\\b', '.', './Housefile', 'a//b', 'house/']) expect((await propose('runSettings', { ...run, houseFile })).body.ok).toBe(false);
  const accounts = await propose('agentAccounts', { agent: 'art', github: ['Art-E-Fish', 'art-e-fish'] });
  expect((await allow(accounts.body.value!.id)).body.ok).toBe(true);
  expect(f.db.select().from(agentAccounts).all()).toEqual([{ agent: 'art', service: 'github', login: 'art-e-fish' }]);
  // A model that is not configured for this household is refused to the owner.
  await hopeless(f, await propose('models', { agent: 'art', models: ['not-a-model'] }), 'Choose configured models');
});
it('proposes secret rules, the secrets default, bridge settings, tempo timings and measuring through the same path', async () => {
  const f = fixture(), at = new Date(0).toISOString();
  f.root.writes.run(() => f.db.insert(secrets).values({ name: 'github-token', description: '', changedAt: at, changedBy: 'sam' }).run());
  const propose = (change: string, input: unknown) => f.call('household/propose', { change, input, why: 'Asked in chat' }, 'art');
  const allow = async (filed: Awaited<ReturnType<typeof propose>>) => { expect(filed.body, JSON.stringify(filed.body)).toMatchObject({ ok: true }); return (await f.call('approvals/answer', { id: filed.body.value!.id, answer: 'allow' }, 'sam')).body; };
  expect(await allow(await propose('secretDefault', { answer: 'never' }))).toMatchObject({ ok: true });
  expect(f.db.select().from(household).get()?.secretsDefault).toBe('never');
  await hopeless(f, await propose('secretRule', { secret: 'no-such-secret', answer: 'auto', minutes: 30, agents: [] }));
  expect(await allow(await propose('secretRule', { secret: 'github-token', answer: 'auto', minutes: 30, agents: [{ agent: 'art', when: 'on_request' }] }))).toMatchObject({ ok: true });
  expect(f.db.select().from(secretRules).all()).toEqual([{ secret: 'github-token', answer: 'auto', minutes: 30 }]);
  expect(f.db.select().from(secretRuleAgents).all()).toEqual([{ secret: 'github-token', agent: 'art', when: 'on_request' }]);
  expect(await allow(await propose('houseSecrets', { agent: 'art', repository: null, secrets: [{ alias: 'GITHUB_TOKEN', secret: 'github-token' }] }))).toMatchObject({ ok: true });
  expect(f.db.select().from(agentHouseSecrets).all()).toEqual([{ agent: 'art', alias: 'GITHUB_TOKEN', secret: 'github-token' }]);
  expect(await allow(await propose('bridge', { action: 'channel', platform: 'discord', workspace: 'pond', channel: 'general', answers: 'art', botsMayTalk: false }))).toMatchObject({ ok: true });
  expect(f.db.select().from(bridgeChannels).all()).toEqual([{ platform: 'discord', workspace: 'pond', channel: 'general', answers: 'art', botsMayTalk: false, brief: null, reportsTo: null }]);
  expect(await allow(await propose('bridge', { action: 'person', platform: 'discord', workspace: 'pond', user: 'u1', member: 'lee' }))).toMatchObject({ ok: true });
  expect(f.db.select().from(bridgePeople).all()).toEqual([{ platform: 'discord', workspace: 'pond', user: 'u1', member: 'lee' }]);
  const timings = await propose('tempoTimings', { who: { kind: 'person', id: 'sam' }, settleSeconds: 60 });
  expect(f.db.select().from(approvals).all().find(row => row.id === timings.body.value!.id)).toMatchObject({ ask: 'Change Tempo timings for person sam?', changeSummary: 'Tempo timings for person sam: {"settleSeconds":60,"who":{"kind":"person","id":"sam"}}' });
  expect((await look(f, timings.body.value!.id)).summary).toBe('Tempo timings for person sam: {"settleSeconds":5,"who":{"kind":"person","id":"sam"}} → {"settleSeconds":60,"who":{"kind":"person","id":"sam"}}');
  expect(await allow(timings)).toMatchObject({ ok: true });
  expect(f.root.services.tempo.volume.timings({ kind: 'person', id: 'sam' })).toMatchObject({ settleSeconds: 60, dimDays: 1 });
  expect(await allow(await propose('measuring', { on: true, send_outside: false, outside_address: '', keep_days: 30 }))).toMatchObject({ ok: true });
  expect(f.db.select().from(measuringSettings).get()).toMatchObject({ on: true, keepDays: 30 });
  await (await f.root.measuring).settled(); expect((await f.root.measuring).enabled()).toBe(true);
  expect((await propose('measuring', { on: true, send_outside: false, outside_address: '', keep_days: 0 })).status).toBe(400);
});
it('proposes the order of people or agents, naming every one once, and what a secret is for', async () => {
  const f = fixture(), at = new Date().toISOString();
  const ask = (change: string, input: unknown) => f.call('household/propose', { change, input, why: 'Tidying' }, 'art');
  for (const ids of [['mark'], ['mark', 'mark'], ['mark', 'art', 'nobody']]) await hopeless(f, await ask('order', { of: 'agents', ids }), 'Name every one of the agents exactly once');
  await hopeless(f, await ask('order', { of: 'agents', ids: ['art', 'mark'] }), 'That is how it already is');
  const order = await ask('order', { of: 'agents', ids: ['mark', 'art'] });
  expect(order.status).toBe(200);
  expect(f.db.select().from(approvals).where(eq(approvals.id, order.body.value!.id)).get()).toMatchObject({ target: 'household:order:agents', kind: 'setting' });
  expect((await f.call('approvals/answer', { id: order.body.value!.id, answer: 'allow' }, 'sam')).status).toBe(200);
  expect(f.db.select({ id: agents.id, position: agents.position }).from(agents).all().sort((a, b) => a.position - b.position)).toEqual([{ id: 'mark', position: 0 }, { id: 'art', position: 1 }]);
  // Nobody has been placed yet, so people are listed by id: asking for that order changes nothing.
  await hopeless(f, await ask('order', { of: 'members', ids: ['lee', 'sam'] }), 'That is how it already is');
  const swapped = await ask('order', { of: 'members', ids: ['sam', 'lee'] });
  expect((await f.call('approvals/answer', { id: swapped.body.value!.id, answer: 'allow' }, 'sam')).status).toBe(200);
  expect(f.db.select({ id: members.id }).from(members).orderBy(members.position).all().map(row => row.id)).toEqual(['sam', 'lee']);

  await hopeless(f, await ask('secretDescription', { secret: 'FORGE', description: 'x' }), 'No secret has that name');
  f.db.insert(secrets).values({ name: 'FORGE', description: '', changedAt: at, changedBy: 'lee' }).run();
  const described = await ask('secretDescription', { secret: 'FORGE', description: 'The example forge token' });
  expect(described.status).toBe(200);
  expect(f.db.select().from(secrets).get()).toMatchObject({ description: '' });
  expect((await f.call('approvals/answer', { id: described.body.value!.id, answer: 'allow' }, 'sam')).status).toBe(200);
  expect(f.db.select().from(secrets).get()).toMatchObject({ name: 'FORGE', description: 'The example forge token', changedBy: 'sam' });
});
it('lets a standing rule answer a settings or dangerous card for a known person, and never a card that changes a rule', async () => {
  const f = fixture(), at = new Date().toISOString();
  f.db.insert(conversations).values({ id: 'cv-sam', agent: 'art', member: 'sam', venue: 'loom', place: 'th', label: 'Sam', startedAt: at, lastAt: at, turnCount: 0 }).run();
  const where = { conversation: 'cv-sam', member: 'sam', project: null };
  const ask = (change: string, input: unknown, known = true) => f.root.writes.run(() => f.root.services.setup.propose('art', { change, input, why: 'Asked in conversation' }, known ? where : undefined)).value;
  // No rule: it waits.
  expect(ask('settings', { commsDays: 9 })).toMatchObject({ state: 'pending', kind: 'setting' });
  f.root.writes.run(() => f.root.services.approvals.deny(f.db.select().from(approvals).get()!.id, 'sam'));
  f.root.writes.run(() => f.root.services.setup.rule({ kind: 'setting', scope: 'household:settings', person: '', tier: 'do' }, 'sam'));
  // The last answer to this same thing was a deny, so it still asks; a different target with no rule asks too.
  expect(ask('settings', { commsDays: 9 })).toMatchObject({ state: 'pending' });
  expect((await f.call('approvals/answer', { id: f.db.select().from(approvals).all().at(-1)!.id, answer: 'allow' }, 'sam')).status).toBe(200);
  expect(ask('agent', { id: 'mark', ...visual, about: 'Changed' })).toMatchObject({ state: 'pending' });
  // Now the rule answers: the change is made as the card is filed, on the word of whoever set the rule.
  const done = ask('settings', { commsDays: 8 });
  expect(done).toMatchObject({ state: 'used', decidedBy: 'sam' });
  expect(f.db.select().from(household).get()).toMatchObject({ commsDays: 8 });
  // Nobody known behind the card: it asks.
  expect(ask('settings', { commsDays: 7 }, false)).toMatchObject({ state: 'pending', actingFor: 'unknown' });
  // A rule cannot be widened by a rule, and one that answers dangerous cards is itself dangerous to set.
  f.root.writes.run(() => f.root.services.setup.rule({ kind: 'setting', scope: '*', person: '', tier: 'do' }, 'sam'));
  const wider = ask('rule', { kind: 'dangerous', scope: '*', person: '', tier: 'do' });
  expect(wider).toMatchObject({ state: 'pending', kind: 'dangerous' });
  expect((await f.call('approvals/answer', { id: wider.id, answer: 'allow' }, 'sam')).status).toBe(400);
  expect((await f.call('approvals/answer', { id: wider.id, answer: 'allow', confirm: true }, 'sam')).status).toBe(200);
  expect(ask('rule', { kind: 'setting', scope: 'household:order:*', person: '', tier: 'ask' })).toMatchObject({ state: 'pending', kind: 'setting' });
  // With the dangerous rule set, a dangerous card for a known person is answered at once.
  f.db.insert(tokens).values({ fingerprint: hash('z'.repeat(64)), label: 'Spare', kind: 'owner', member: 'lee', createdAt: at }).run();
  expect(ask('tokenRevoke', { label: 'Spare' })).toMatchObject({ state: 'used', kind: 'dangerous' });
  expect(f.db.select().from(tokens).all().find(row => row.label === 'Spare')!.revokedAt).not.toBeNull();
});
it('removes and restores a person, an agent and a project without deleting anything', async () => {
  const f = fixture(), at = new Date().toISOString();
  f.db.insert(household).values({ defaultAgent: 'art' }).run();
  f.db.insert(projects).values({ id: 'pond', name: 'Pond' }).run();
  const ask = (change: string, input: unknown) => f.call('household/propose', { change, input, why: 'Tidying' }, 'art');
  const allow = async (change: string, input: unknown) => { const filed = await ask(change, input); expect(filed.status).toBe(200); expect((await f.call('approvals/answer', { id: filed.body.value!.id, answer: 'allow' }, 'sam')).status).toBe(200); };
  // Refused to the owner: a stranger, the last owner, the default agent, restoring what is not removed.
  await hopeless(f, await ask('remove', { of: 'member', id: 'nobody' }));
  await hopeless(f, await ask('remove', { of: 'member', id: 'sam' }));
  await hopeless(f, await ask('remove', { of: 'agent', id: 'art' }));
  await hopeless(f, await ask('restore', { of: 'member', id: 'lee' }));
  // Lee can act now, and cannot once removed; the row and the token stay.
  const probe = () => f.call('household/setPreferences', {}, 'lee');
  const known = (await probe()).status; expect(known).not.toBe(401);
  await allow('remove', { of: 'member', id: 'lee' });
  expect(f.db.select().from(approvals).all().at(-1)).toMatchObject({ target: 'household:remove:member lee', kind: 'setting', ask: 'Remove member lee?' });
  expect(f.db.select().from(members).all().find(row => row.id === 'lee')!.removedAt).not.toBeNull();
  expect(f.db.select().from(tokens).all().find(row => row.label === 'lee')!.revokedAt).toBeNull();
  expect((await probe()).status).toBe(401);
  await hopeless(f, await ask('remove', { of: 'member', id: 'lee' }));
  await allow('restore', { of: 'member', id: 'lee' });
  expect(f.db.select().from(members).all().find(row => row.id === 'lee')!.removedAt).toBeNull();
  expect((await probe()).status).toBe(known);
  // An agent and a project.
  await allow('remove', { of: 'agent', id: 'mark' });
  expect(f.db.select().from(agents).all().find(row => row.id === 'mark')!.removedAt).not.toBeNull();
  await allow('remove', { of: 'project', id: 'pond' });
  expect(f.db.select().from(projects).get()).toMatchObject({ id: 'pond', name: 'Pond' });
  expect(f.db.select().from(projects).get()!.removedAt).not.toBeNull();
  await allow('restore', { of: 'project', id: 'pond' });
  expect(f.db.select().from(projects).get()!.removedAt).toBeNull();
  // The agent that asks is removed last: its own token then stops being recognised.
  f.db.update(household).set({ defaultAgent: 'mark' }).run();
  expect((await ask('remove', { of: 'agent', id: 'art' })).status).toBe(200);
  expect((await f.call('approvals/answer', { id: f.db.select().from(approvals).all().at(-1)!.id, answer: 'allow' }, 'sam')).status).toBe(200);
  expect((await ask('settings', { commsDays: 3 })).status).toBe(401);
  void at;
});
it('removing a bridge connection switches it off and keeps it; restoring leaves it off', async () => {
  const f = fixture(), at = new Date().toISOString();
  f.db.insert(secrets).values({ name: 'BOT', description: '', changedAt: at, changedBy: 'sam' }).run();
  f.db.insert(bridgeConnections).values({ id: 'daily', platform: 'discord', agent: 'art', workspace: 'W', botUser: 'B', tokenSecret: 'BOT', enabled: true, state: 'connected', stateAt: at }).run();
  const allow = async (change: string) => { const filed = await f.call('household/propose', { change, input: { of: 'bridge', id: 'daily' }, why: 'Tidying' }, 'art'); expect(filed.status).toBe(200); expect((await f.call('approvals/answer', { id: filed.body.value!.id, answer: 'allow' }, 'sam')).status).toBe(200); };
  await allow('remove');
  expect(f.db.select().from(bridgeConnections).get()).toMatchObject({ id: 'daily', enabled: false, state: 'disconnected' });
  expect(f.db.select().from(bridgeConnections).get()!.removedAt).not.toBeNull();
  await allow('restore');
  expect(f.db.select().from(bridgeConnections).get()).toMatchObject({ id: 'daily', enabled: false, removedAt: null });
});
it('removing an agent switches off its bridge connections and leaves another agent\'s alone; restoring leaves them off', async () => {
  const f = fixture(), at = new Date().toISOString();
  f.db.insert(secrets).values({ name: 'BOT', description: '', changedAt: at, changedBy: 'sam' }).run();
  f.db.insert(bridgeConnections).values([{ id: 'marks', agent: 'mark', botUser: 'M' }, { id: 'marks-slack', agent: 'mark', botUser: 'MS', platform: 'slack' as const }, { id: 'arts', agent: 'art', botUser: 'A' }]
    .map(row => ({ platform: 'discord' as const, workspace: 'W', tokenSecret: 'BOT', enabled: true, state: 'connected' as const, stateAt: at, ...row }))).run();
  const allow = async (change: string) => { const filed = await f.call('household/propose', { change, input: { of: 'agent', id: 'mark' }, why: 'Tidying' }, 'art'); expect(filed.status).toBe(200); expect((await f.call('approvals/answer', { id: filed.body.value!.id, answer: 'allow' }, 'sam')).status).toBe(200); };
  const state = () => Object.fromEntries(f.db.select().from(bridgeConnections).all().map(row => [row.id, [row.enabled, row.state, row.removedAt]]));
  await allow('remove');
  // The connections are switched off, not removed: they are still the agent's when it comes back.
  expect(state()).toEqual({ marks: [false, 'disconnected', null], 'marks-slack': [false, 'disconnected', null], arts: [true, 'connected', null] });
  await allow('restore');
  expect(state()).toMatchObject({ marks: [false, 'disconnected', null], 'marks-slack': [false, 'disconnected', null] });
});
it('rechecks the connections that removing an agent will switch off',async()=>{
 const f=fixture(),at=new Date(f.clock.now()).toISOString();
 const id=(await f.call('household/propose',{change:'remove',input:{of:'agent',id:'fern'},why:'Retire Fern'},'art')).body.value!.id;
 f.db.insert(agents).values({id:'fern',...visual}).run();
 const first=await preview(f,id);
 expect(JSON.parse(first.card!.exact).disconnect).toEqual([]);
 f.db.insert(secrets).values({name:'BOT',description:'',changedAt:at,changedBy:'sam'}).run();
 f.db.insert(bridgeConnections).values({id:'garden',platform:'discord',agent:'fern',workspace:'W',botUser:'B',tokenSecret:'BOT',enabled:true,state:'connected',stateAt:at}).run();
 expect((await f.call('approvals/answer',{id,answer:'allow',review:first.review},'sam')).body.code).toBe('conflict');
 expect(f.db.select().from(bridgeConnections).get()?.enabled).toBe(true);
 const second=await preview(f,id);
 expect(JSON.parse(second.card!.exact).disconnect[0].id).toBe('garden');
 expect((await f.call('approvals/answer',{id,answer:'allow',review:second.review},'sam')).body.ok).toBe(true);
});
it('answers a card for someone who is not an owner only by a rule an owner set naming that person', async () => {
  const f = fixture(), at = new Date().toISOString();
  f.db.insert(conversations).values({ id: 'cv-lee', agent: 'art', member: 'lee', venue: 'loom', place: 'th', label: 'Lee', startedAt: at, lastAt: at, turnCount: 0 }).run();
  const ask = (days: number) => f.root.writes.run(() => f.root.services.setup.propose('art', { change: 'settings', input: { commsDays: days }, why: 'Lee asked' }, { conversation: 'cv-lee', member: 'lee', project: null })).value;
  // A card that waits is then allowed by hand, so the next ask is not refused as a second card for the same
  // thing (and not remembered as denied, which would make every later one ask).
  const waits = (card: { id: string; state: string }, owner = 'sam') => { expect(card).toMatchObject({ state: 'pending', actingFor: 'lee' }); f.root.writes.run(() => f.root.services.approvals.allow(card.id, owner)); };
  // The household's own rules are the owners' advance yes for work done for an owner. They say nothing for lee.
  f.root.writes.run(() => { f.root.services.setup.rule({ kind: 'setting', scope: '*', person: '', tier: 'do' }, 'sam'); f.root.services.setup.rule({ kind: 'dangerous', scope: '*', person: '', tier: 'do' }, 'sam'); });
  waits(ask(9));
  // A rule naming lee, set by an owner, does: the change is made on that owner's word and the card says so.
  f.root.writes.run(() => f.root.services.setup.rule({ kind: 'setting', scope: 'household:settings', person: 'lee', tier: 'do' }, 'sam'));
  expect(ask(8)).toMatchObject({ state: 'used', decidedBy: 'sam', actingFor: 'lee' });
  expect(f.db.select().from(household).get()).toMatchObject({ commsDays: 8 });
  // It reaches no further than its scope: a dangerous card for lee still asks.
  f.db.insert(tokens).values({ fingerprint: hash('y'.repeat(64)), label: 'Spare', kind: 'owner', member: 'sam', createdAt: at }).run();
  expect(f.root.writes.run(() => f.root.services.setup.propose('art', { change: 'tokenRevoke', input: { label: 'Spare' }, why: 'Lee asked' }, { conversation: 'cv-lee', member: 'lee', project: null })).value).toMatchObject({ state: 'pending' });
  // And it lasts only while the one who set it is a household owner, and lee is in the household.
  f.db.insert(members).values({ id: 'olive', role: 'owner', joinedAt: at }).run();
  f.db.update(members).set({ role: 'member' }).run();
  f.db.update(members).set({ role: 'owner' }).where(eq(members.id, 'olive')).run();
  waits(ask(7), 'olive');
  f.db.update(members).set({ role: 'owner' }).where(eq(members.id, 'sam')).run();
  f.db.update(members).set({ removedAt: at }).where(eq(members.id, 'lee')).run();
  expect(ask(6)).toMatchObject({ state: 'pending' });
  expect(f.db.select().from(household).get()).toMatchObject({ commsDays: 7 });
});

it('tells the asking agent nothing it could not already read: not on the card, and not by how filing answers', async () => {
  const f = fixture();
  f.db.insert(memberAgents).values({ member: 'lee', agent: 'art' }).run();
  const propose = (change: string, input: unknown) => f.call('household/propose', { change, input, why: 'Curious' }, 'art');
  // Each pair is a guess that is right and one that is wrong, or a thing that is there and one that is not.
  // Filing answers both the same way, so the answer confirms nothing.
  const pairs: [string, unknown, unknown][] = [
    ['member', { id: 'sam', role: 'owner', agents: [] }, { id: 'sam', role: 'member', agents: ['mark'] }],
    ['member', { id: 'lee', role: 'member', agents: ['art'] }, { id: 'nobody-here', role: 'member', agents: [] }],
    ['tokenRevoke', { label: 'sam' }, { label: 'no-such-label' }],
    ['settings', { commsDays: 14 }, { commsDays: 9 }],
    ['secretDefault', { answer: 'ask' }, { answer: 'never' }],
    ['remove', { of: 'member', id: 'lee' }, { of: 'member', id: 'stranger' }],
  ];
  for (const [change, one, other] of pairs) {
    const answers = [];
    for (const input of [one, other]) {
      const filed = await propose(change, input); answers.push({ status: filed.status, ok: filed.body.ok, state: filed.body.value?.state, code: filed.body.code, message: filed.body.message });
      if (filed.body.value) expect((await f.call('approvals/answer', { id: filed.body.value.id, answer: 'deny' }, 'sam')).body.ok).toBe(true);
    }
    expect(answers[0], change).toEqual({ status: 200, ok: true, state: 'pending', code: undefined, message: undefined }); expect(answers[1], change).toEqual(answers[0]);
  }
  // What the agent, and a member who has the agent, can read of those cards holds only what the agent sent.
  // Sam's role, Lee's agents, who holds the token and the household's settings are an owner's to read.
  const cards = async (actor: keyof typeof credentials) => {
    const response = await f.root.http.request('http://loom/graphql', { method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer '+credentials[actor] }, body: JSON.stringify({ query: '{ approvals { id target what changeSummary details ask ifYes ifNo why } }' }) });
    return JSON.stringify(((await response.json()) as { data: { approvals: unknown[] } }).data.approvals);
  };
  for (const actor of ['art', 'lee'] as const) {
    const read = await cards(actor);
    expect(JSON.parse(read)).toHaveLength(12);
    expect(read).not.toContain('"before"'); expect(read).not.toContain('→');
    // Sent by the agent, so on the card; never sent, so nowhere: the token's kind and holder, the settings as they are.
    expect(read).toContain('no-such-label');
    for (const hidden of ['\\"kind\\":\\"owner\\"', '\\"for\\"', '\\"removed\\"']) expect(read).not.toContain(hidden);
  }
  // Neither may ask what a card would replace.
  const waiting = await propose('member', { id: 'lee', role: 'owner', agents: [] });
  for (const actor of ['art', 'lee'] as const) expect((await f.call('household/proposal', { id: waiting.body.value!.id }, actor)).status).toBe(403);
  expect((await look(f, waiting.body.value!.id)).summary).toContain('"agents":["art"]');
  // Another agent's waiting card for the same thing is not this agent's to learn of.
  f.root.writes.run(() => f.root.services.setup.propose('mark', { change: 'settings', input: { commsDays: 5 }, why: 'Mark asks' }));
  expect((await propose('settings', { commsDays: 6 })).body).toMatchObject({ ok: true, value: { state: 'pending' } });
});
it('makes a change as the owner who allows it, so a second owner changes neither what can be filed nor who can answer', async () => {
  const f = fixture(), at = new Date(0).toISOString();
  // Two owners. 'amy' sorts first and does not have the agent; sam does, and owns the machine.
  f.db.insert(members).values({ id: 'amy', role: 'owner', joinedAt: at }).run();
  f.db.insert(tokens).values({ fingerprint: hash('d'.repeat(64)), label: 'amy', kind: 'owner', member: 'amy', createdAt: at }).run();
  f.db.insert(boxes).values({ id: 'box-1', name: 'workshop', owner: 'sam', hostsAny: true, sameMachineAsLoom: false, reportOnly: false, alwaysOn: false, enrolledAt: at }).run();
  f.db.insert(memberAgents).values({ member: 'sam', agent: 'art' }).run();
  const answer = async (id: string, owner: 'sam' | 'amy') => { const response = await f.root.http.request('http://loom/api/approvals/answer', { method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer '+(owner === 'sam' ? credentials.sam : 'd'.repeat(64)) }, body: JSON.stringify({ input: { id, answer: 'allow' }, id: 'answer-'+owner+id }) }); return await response.json() as { ok: boolean; message?: string }; };
  const asks = async (id: string) => { const response = await f.root.http.request('http://loom/api/household/proposal', { method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer '+'d'.repeat(64) }, body: JSON.stringify({ input: { id } }) }); return (await response.json() as { value: { problem: string | null } }).value; };
  const run = { agent: 'art', houseRepository: 'https://example.invalid/house.git', houseFile: 'Housefile', houseBranch: 'main', nestedContainers: false, gpu: false, boxes: ['box-1'], ports: [] };
  const filed = await f.call('household/propose', { change: 'runSettings', input: run, why: 'A new house' }, 'art');
  expect(filed.body).toMatchObject({ ok: true, value: { state: 'pending' } });
  const id = filed.body.value!.id;
  // Either owner may look. Amy's Allow is refused, in the rule's words, and leaves the card for Sam.
  expect((await asks(id)).problem).toBeNull(); expect((await look(f, id)).problem).toBeNull();
  expect(await answer(id, 'amy')).toMatchObject({ ok: false, message: 'Current agent owner required' });
  expect(f.db.select().from(approvals).where(eq(approvals.id, id)).get()).toMatchObject({ state: 'pending' });
  expect(await answer(id, 'sam')).toMatchObject({ ok: true });
  expect(f.db.select().from(agentRunSettings).get()).toMatchObject({ agent: 'art', houseBranch: 'main' });
  // A standing rule set by an owner who may not make the change answers nothing: the card waits.
  f.db.insert(conversations).values({ id: 'cv-sam', agent: 'art', member: 'sam', venue: 'loom', place: 'th', label: 'Sam', startedAt: at, lastAt: at, turnCount: 0 }).run();
  f.root.writes.run(() => f.root.services.setup.rule({ kind: 'setting', scope: 'household:runSettings:art', person: '', tier: 'do' }, 'amy'));
  const again = f.root.writes.run(() => f.root.services.setup.propose('art', { change: 'runSettings', input: { ...run, gpu: true }, why: 'Asked' }, { conversation: 'cv-sam', member: 'sam', project: null })).value;
  expect(again).toMatchObject({ state: 'pending' });
  expect(f.db.select().from(agentRunSettings).get()).toMatchObject({ gpu: false });
  expect(await answer(again.id, 'sam')).toMatchObject({ ok: true });
  expect(f.db.select().from(agentRunSettings).get()).toMatchObject({ gpu: true });
});
it('takes what a card would replace off the cards an earlier version filed, and still refuses a waiting one whose ground has moved', async () => {
  const client = new Database(':memory:'); clean.push(() => { client.close(); });
  const clock = new FakeClock(), at = new Date(clock.now()).toISOString(), db = createDataSchema(client, () => at);
  db.insert(members).values({ id: 'sam', role: 'owner', joinedAt: at }).run();
  db.insert(agents).values({ id: 'art', ...visual }).run();
  db.insert(tokens).values({ fingerprint: hash(credentials.sam), label: 'sam', kind: 'owner', member: 'sam', createdAt: at }).run();
  const older = (id: string, state: 'pending' | 'used', before: unknown, after: unknown) => db.insert(approvals).values({ id, kind: 'setting', operation: 'household.change', target: 'household:settings', state, agent: 'art', askedFrom: 'terminal', actingFor: 'unknown', minutes: 30, askedAt: at,
    what: 'Household settings: '+JSON.stringify(before)+' → '+JSON.stringify(after), changeSummary: 'Household settings: '+JSON.stringify(before)+' → '+JSON.stringify(after), why: 'Asked', ask: 'Change Household settings?', ifYes: 'Make the change shown on this card.', ifNo: 'Leave it as it is.',
    details: JSON.stringify({ change: 'settings', before, after }) }).run();
  older('a-old', 'used', { commsDays: 30 }, { commsDays: 14 }); older('a-waiting', 'pending', { commsDays: 14 }, { commsDays: 7 }); older('a-moved', 'pending', { commsDays: 21 }, { commsDays: 5 });
  const notes: string[] = [];
  const root = sharedRoot({ db, clock, originAllowed: () => true, reportError: () => {}, startupNote: line => notes.push(line) }); clean.push(() => root.close());
  for (const row of db.select().from(approvals).all()) {
    expect(row.details).not.toContain('before'); expect(row.what).not.toContain('→'); expect(row.changeSummary).not.toContain('→');
    expect(JSON.parse(row.details)).toMatchObject({ change: 'settings', after: expect.anything(), seal: { nonce: expect.any(String), digest: expect.any(String) } });
  }
  // The rewrite is outside the upgrade steps, so it says what it did, in one line with no card's content,
  // and does nothing the second time.
  expect(notes).toEqual(['Household cards: removed the stored earlier value from 3 cards filed by an older version']);
  const answer = async (id: string) => (await (await root.http.request('http://loom/api/approvals/answer', { method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer '+credentials.sam }, body: JSON.stringify({ input: { id, answer: 'allow' }, id: 'allow-'+id }) })).json()) as { ok: boolean; code?: string };
  expect(await answer('a-moved')).toMatchObject({ ok: false, code: 'conflict' });
  expect(await answer('a-waiting')).toMatchObject({ ok: true });
  expect(db.select().from(household).get()).toMatchObject({ commsDays: 7 });
  const rewritten = db.select().from(approvals).all();
  await root.close();
  const second = sharedRoot({ db, clock, originAllowed: () => true, reportError: () => {}, startupNote: line => notes.push(line) }); clean.push(() => second.close());
  expect(notes).toHaveLength(1); expect(db.select().from(approvals).all()).toEqual(rewritten);
});
it('merges one project into another only when an owner allows the card, and the card is the record of it', async () => {
  const f = fixture(), at = new Date(f.clock.now()).toISOString();
  f.db.insert(projects).values([{ id: 'pond', name: 'Pond' }, { id: 'garden', name: 'Garden' }, { id: 'shut', name: 'Shut', removedAt: at }]).run();
  f.db.insert(projectMembers).values([{ project: 'pond', member: 'lee' }]).run();
  f.db.insert(projectAgents).values([{ project: 'pond', agent: 'art' }, { project: 'garden', agent: 'mark' }]).run();
  const task = f.root.services.tasks.create({ title: 'Clean filter', goal: 'Clean', why: 'Green water', owner: { kind: 'agent', id: 'art' }, project: 'pond' }, { kind: 'agent', id: 'art' });
  const ask = (input: unknown) => f.call('household/propose', { change: 'projectMerge', input, why: 'The first sort put pond work in two places' }, 'art');
  const filed = await ask({ from: 'pond', into: 'garden' });
  expect(filed).toMatchObject({ status: 200, body: { ok: true, value: { state: 'pending' } } });
  const id = filed.body.value!.id;
  expect((await preview(f, id)).card?.ifYes).toContain('Member-scoped approvals keep their member scope.');
  // The card says what is asked, in words that name both projects. Nothing has moved.
  expect(f.db.select().from(approvals).where(eq(approvals.id, id)).get()).toMatchObject({ kind: 'dangerous', state: 'pending', agent: 'art', target: 'household:projectMerge:pond into garden', ask: 'Merge project pond into garden?',
    changeSummary: 'Merge project pond into garden. Everything filed under the first is filed under the second, and the first is removed.', why: 'The first sort put pond work in two places', decidedBy: null });
  expect(JSON.parse(f.db.select().from(approvals).where(eq(approvals.id, id)).get()!.details)).toMatchObject({ change: 'projectMerge', after: { from: 'pond', into: 'garden' } });
  expect(f.db.select().from(tasks).get()).toMatchObject({ project: 'pond' });
  // An owner is shown both projects as they stand. Nobody else is, and nobody else allows it.
  expect(await look(f, id)).toEqual({ summary: expect.stringContaining('As they stand: {"from":{"id":"pond","name":"Pond","removed":false,"retired":false,"members":["lee"],"agents":["art"],"repositories":[]},"into":{"id":"garden"'), problem: null });
  for (const actor of ['lee', 'art'] as const) expect((await f.call('approvals/answer', { id, answer: 'allow' }, actor)).status).toBe(403);
  expect(f.db.select().from(tasks).get()).toMatchObject({ project: 'pond' });
  // It cannot be undone, so the card is a dangerous one: the owner's Allow must also confirm.
  expect((await f.call('approvals/answer', { id, answer: 'allow' }, 'sam')).body.ok).toBe(false);
  expect(f.db.select().from(tasks).get()).toMatchObject({ project: 'pond' });
  expect(await f.call('approvals/answer', { id, answer: 'allow', confirm: true }, 'sam')).toMatchObject({ status: 200, body: { ok: true } });
  // Made: the task is garden's, pond's people and agents are garden's, pond is kept and removed.
  expect(f.db.select().from(tasks).where(eq(tasks.id, task.id)).get()).toMatchObject({ project: 'garden' });
  expect(f.root.services.projects.describe('garden')).toMatchObject({ members: ['lee'], agents: ['art', 'mark'], removed: false });
  expect(f.db.select().from(projects).where(eq(projects.id, 'pond')).get()!.removedAt).not.toBeNull();
  // The record: the card, with who asked, who allowed it and what changed. No comment is left on the task.
  expect(f.db.select().from(approvals).where(eq(approvals.id, id)).get()).toMatchObject({ state: 'used', agent: 'art', decidedBy: 'sam', operation: 'household.change',
    changeSummary: 'Merge project pond into garden. Everything filed under the first is filed under the second, and the first is removed.' });
  expect(f.db.select().from(approvalRecord).where(eq(approvalRecord.approval, id)).all().map(row => row.event)).toEqual(expect.arrayContaining(['request', 'allow', 'use']));
  expect(f.root.services.tasks.get(task.id).comments).toEqual([]);

  // What cannot be merged is filed like anything else, and refused to the owner in plain words when they look and when they allow.
  for (const [input, problem] of [[{ from: 'garden', into: 'garden' }, 'A project cannot be merged into itself'], [{ from: 'pond', into: 'garden' }, 'Project pond is removed'],
    [{ from: 'garden', into: 'shut' }, 'Project shut is removed'], [{ from: 'nowhere', into: 'garden' }, 'No project has the id nowhere']] as const) {
    const hopeless = await ask(input);
    expect(hopeless).toMatchObject({ status: 200, body: { ok: true, value: { state: 'pending' } } });
    expect((await look(f, hopeless.body.value!.id)).problem).toBe(problem);
    expect((await f.call('approvals/answer', { id: hopeless.body.value!.id, answer: 'allow', confirm: true }, 'sam')).body).toMatchObject({ ok: false, message: problem });
    expect((await f.call('approvals/answer', { id: hopeless.body.value!.id, answer: 'deny' }, 'sam')).body.ok).toBe(true);
  }
  expect(f.db.select().from(tasks).where(eq(tasks.id, task.id)).get()).toMatchObject({ project: 'garden' });
  expect(f.db.select().from(projects).where(eq(projects.id, 'garden')).get()!.removedAt).toBeNull();
  // A stale merge requires both the current review and explicit confirmation.
  f.db.insert(projects).values({ id: 'shed', name: 'Shed' }).run();
  const stale = await ask({ from: 'shed', into: 'garden' });
  f.db.insert(projectMembers).values({ project: 'shed', member: 'lee' }).run();
  expect((await f.call('approvals/answer', { id: stale.body.value!.id, answer: 'allow', confirm: true }, 'sam')).body).toMatchObject({ ok: false, message: 'This has changed since the card was filed. Open the updated card to review it.' });
  const revised=await preview(f,stale.body.value!.id);
  expect(revised.review).toBeTruthy();
  expect((await f.call('approvals/answer',{id:stale.body.value!.id,answer:'allow',review:revised.review},'sam')).body).toMatchObject({ok:false,code:'invalid'});
  const late=f.root.services.tasks.create({title:'New shed work',goal:'Dry storage',why:'Rain',owner:{kind:'agent',id:'art'},project:'shed'},{kind:'agent',id:'art'});
  expect((await f.call('approvals/answer',{id:stale.body.value!.id,answer:'allow',confirm:true,review:revised.review},'sam')).body.code).toBe('conflict');
  expect(f.db.select().from(tasks).where(eq(tasks.id,late.id)).get()?.project).toBe('shed');
  expect(f.db.select().from(projects).where(eq(projects.id, 'shed')).get()!.removedAt).toBeNull();
});

it('lets no standing rule answer a merge card, not one for dangerous actions either: an owner allows and confirms it by hand', async () => {
  const f = fixture(), at = new Date(f.clock.now()).toISOString();
  f.db.insert(projects).values([{ id: 'pond', name: 'Pond' }, { id: 'garden', name: 'Garden' }]).run();
  f.db.insert(conversations).values({ id: 'cv-sam', agent: 'art', member: 'sam', venue: 'loom', place: 'th', label: 'Sam', startedAt: at, lastAt: at, turnCount: 0 }).run();
  const where = { conversation: 'cv-sam', member: 'sam', project: null };
  const ask = (change: string, input: unknown) => f.root.writes.run(() => f.root.services.setup.propose('art', { change, input, why: 'Asked in conversation' }, where)).value;
  // The widest rule there is for dangerous actions, set by the owner the agent is working for.
  f.root.writes.run(() => f.root.services.setup.rule({ kind: 'dangerous', scope: '*', person: '', tier: 'do' }, 'sam'));
  // It answers a revocation as the card is filed, as before. A merge waits to be seen.
  expect(ask('tokenRevoke', { label: 'lee' })).toMatchObject({ state: 'used', kind: 'dangerous', decidedBy: 'sam' });
  const card = ask('projectMerge', { from: 'pond', into: 'garden' });
  expect(card).toMatchObject({ state: 'pending', kind: 'dangerous', decidedBy: null });
  expect(f.db.select().from(projects).all().map(row => row.removedAt)).toEqual([null, null]);
  // By hand: Allow alone is refused, Allow with the confirmation makes it.
  expect((await f.call('approvals/answer', { id: card.id, answer: 'allow' }, 'sam')).body.ok).toBe(false);
  expect((await f.call('approvals/answer', { id: card.id, answer: 'allow', confirm: true }, 'sam')).body.ok).toBe(true);
  expect(f.db.select().from(projects).where(eq(projects.id, 'pond')).get()!.removedAt).not.toBeNull();
});

it('does not let a standing rule for settings answer a merge card', async () => {
  const f = fixture(), at = new Date(f.clock.now()).toISOString();
  f.db.insert(projects).values([{ id: 'pond', name: 'Pond' }, { id: 'garden', name: 'Garden' }]).run();
  f.db.insert(conversations).values({ id: 'cv-sam', agent: 'art', member: 'sam', venue: 'loom', place: 'th', label: 'Sam', startedAt: at, lastAt: at, turnCount: 0 }).run();
  const where = { conversation: 'cv-sam', member: 'sam', project: null };
  const ask = (change: string, input: unknown) => f.root.writes.run(() => f.root.services.setup.propose('art', { change, input, why: 'Asked in conversation' }, where)).value;
  // The widest rule there is for settings, set by an owner, for the owner the agent is working for.
  f.root.writes.run(() => f.root.services.setup.rule({ kind: 'setting', scope: '*', person: '', tier: 'do' }, 'sam'));
  // It answers a settings card as it is filed. A merge is not a setting: its card waits to be seen.
  expect(ask('settings', { commsDays: 9 })).toMatchObject({ state: 'used', kind: 'setting' });
  expect(ask('projectMerge', { from: 'pond', into: 'garden' })).toMatchObject({ state: 'pending', kind: 'dangerous' });
  expect(f.db.select().from(projects).all().map(row => row.removedAt)).toEqual([null, null]);
});

it('lets an agent ask to be let onto a project; allowing it adds that one agent and tells it so where it asked', async () => {
  const f = fixture(), at = new Date(f.clock.now()).toISOString();
  f.db.insert(projects).values([{ id: 'pond', name: 'Pond' }, { id: 'shut', name: 'Shut', removedAt: at }]).run();
  f.db.insert(projectMembers).values({ project: 'pond', member: 'lee' }).run();
  f.db.insert(projectAgents).values({ project: 'pond', agent: 'art' }).run();
  f.db.insert(projectRepositories).values({ project: 'pond', repository: 'github:fixture/pond' }).run();
  // Another project in use, with people, an agent and a repository of its own: it takes no part.
  f.db.insert(projects).values({ id: 'garden', name: 'Garden' }).run();
  f.db.insert(projectMembers).values({ project: 'garden', member: 'sam' }).run();
  f.db.insert(projectAgents).values({ project: 'garden', agent: 'art' }).run();
  f.db.insert(projectRepositories).values({ project: 'garden', repository: 'github:fixture/garden' }).run();
  const others = () => [f.root.services.projects.describe('garden'), f.root.services.projects.describe('shut')];
  const untouched = others();
  // mark is told in a shared place to work on pond, and asks from there.
  f.db.insert(conversations).values({ id: 'cv-room', agent: 'mark', venue: 'slack', place: 'room', label: 'Room', startedAt: at, lastAt: at, turnCount: 0 }).run();
  const card = f.root.writes.run(() => f.root.services.setup.propose('mark', { change: 'projectJoin', input: { project: 'pond', agent: 'mark' }, why: 'Sam asked me to work on pond and I am not on it' },
    { conversation: 'cv-room', member: null, project: null })).value;
  // The card says plainly who wants onto which project, and why. It is a setting, and nothing has changed.
  expect(card).toMatchObject({ kind: 'setting', state: 'pending', agent: 'mark', conversation: 'cv-room', target: 'household:projectJoin:mark onto project pond', ask: 'Let mark work on project pond?',
    changeSummary: 'Let mark work on project pond. Nothing else about the project changes.', why: 'Sam asked me to work on pond and I am not on it' });
  const before = f.root.services.projects.describe('pond');
  expect(before).toMatchObject({ agents: ['art'] });
  expect(await look(f, card.id)).toEqual({ summary: expect.stringContaining('Let mark work on project pond. As it stands: '), problem: null });
  expect((await f.call('approvals/answer', { id: card.id, answer: 'allow' }, 'lee')).status).toBe(403);
  expect(await f.call('approvals/answer', { id: card.id, answer: 'allow' }, 'sam')).toMatchObject({ status: 200, body: { ok: true } });
  // That one agent is on that one project. Its name, people, other agents and repositories are as they were.
  expect(f.root.services.projects.describe('pond')).toEqual({ ...before, agents: ['art', 'mark'] });
  expect(others()).toEqual(untouched);
  expect(f.db.select().from(projects).all().map(row => [row.id, row.name, row.removedAt === null])).toEqual([['pond', 'Pond', true], ['shut', 'Shut', false], ['garden', 'Garden', true]]);
  expect(f.db.select().from(approvals).where(eq(approvals.id, card.id)).get()).toMatchObject({ state: 'used', decidedBy: 'sam' });
  // The answer is mail to mark in the conversation it asked from, waiting for its next body there.
  expect(f.db.select().from(inbox).where(eq(inbox.toKind, 'agent')).all()).toMatchObject([{ to: 'mark', conversation: 'cv-room', source: 'answer', fromKind: 'person', fromId: 'sam', state: 'waiting',
    words: 'Allow\nLet mark work on project pond?\nmark is added to project pond and sees what is filed under it. Nothing else about the project changes.' }]);
  // A deny reaches it the same way, and changes nothing.
  const denied = f.root.writes.run(() => f.root.services.setup.propose('mark', { change: 'projectJoin', input: { project: 'shut', agent: 'mark' }, why: 'Again' }, { conversation: 'cv-room', member: null, project: null })).value;
  expect((await look(f, denied.id)).problem).toBe('Project shut is removed');
  expect((await f.call('approvals/answer', { id: denied.id, answer: 'allow' }, 'sam')).body).toMatchObject({ ok: false, message: 'Project shut is removed' });
  expect((await f.call('approvals/answer', { id: denied.id, answer: 'deny' }, 'sam')).body.ok).toBe(true);
  expect(f.db.select().from(inbox).where(eq(inbox.toKind, 'agent')).all().at(-1)).toMatchObject({ to: 'mark', conversation: 'cv-room', words: expect.stringMatching(/^Deny\nLet mark work on project shut\?\nmark stays off the project\.$/) });
  expect(f.db.select().from(projectAgents).all()).toHaveLength(3);
  expect(others()).toEqual(untouched);
});

it('never lets a standing rule answer a request to join a project: every one waits for an owner', async () => {
  const f = fixture(), at = new Date(f.clock.now()).toISOString();
  f.db.insert(projects).values({ id: 'pond', name: 'Pond' }).run();
  // mark's body is working in sam's own thread, and sam, a household owner, has the widest rule for settings.
  f.db.insert(conversations).values({ id: 'cv-sam', agent: 'mark', member: 'sam', venue: 'loom', place: 'th', label: 'Sam', startedAt: at, lastAt: at, turnCount: 0 }).run();
  const where = { conversation: 'cv-sam', member: 'sam', project: null };
  const ask = (change: string, input: unknown) => f.root.writes.run(() => f.root.services.setup.propose('mark', { change, input, why: 'Asked in conversation' }, where)).value;
  f.root.writes.run(() => f.root.services.setup.rule({ kind: 'setting', scope: '*', person: '', tier: 'do' }, 'sam'));
  // The rule answers a settings card as it is filed. Being let onto a project is not the rule's to give.
  expect(ask('settings', { commsDays: 9 })).toMatchObject({ state: 'used', kind: 'setting' });
  const card = ask('projectJoin', { project: 'pond', agent: 'mark' });
  expect(card).toMatchObject({ state: 'pending', kind: 'setting', decidedBy: null });
  expect(f.root.services.projects.describe('pond')).toMatchObject({ agents: [] });
  // Nor a rule that names this very card. The owner's own plain Allow, with nothing to confirm, is what lets it on.
  f.db.insert(projects).values({ id: 'garden', name: 'Garden' }).run();
  f.root.writes.run(() => f.root.services.setup.rule({ kind: 'setting', scope: 'household:projectJoin:*', person: '', tier: 'do' }, 'sam'));
  expect(ask('projectJoin', { project: 'garden', agent: 'mark' })).toMatchObject({ state: 'pending' });
  expect(f.root.services.projects.describe('garden')).toMatchObject({ agents: [] });
  expect(await f.call('approvals/answer', { id: card.id, answer: 'allow' }, 'sam')).toMatchObject({ status: 200, body: { ok: true } });
  expect(f.root.services.projects.describe('pond')).toMatchObject({ agents: ['mark'] });
});

it('allows two agents onto the same project in turn: one card does not make the other stale', async () => {
  const f = fixture();
  f.db.insert(projects).values({ id: 'pond', name: 'Pond' }).run();
  const ask = (agent: string) => f.root.writes.run(() => f.root.services.setup.propose(agent, { change: 'projectJoin', input: { project: 'pond', agent }, why: 'To work on it' })).value;
  const arts = ask('art'), marks = ask('mark');
  expect((await f.call('approvals/answer', { id: arts.id, answer: 'allow' }, 'sam')).body).toMatchObject({ ok: true });
  expect((await look(f, marks.id)).problem).toBeNull();
  expect((await f.call('approvals/answer', { id: marks.id, answer: 'allow' }, 'sam')).body).toMatchObject({ ok: true });
  expect(f.root.services.projects.describe('pond')).toMatchObject({ agents: ['art', 'mark'] });
  // What a card is about still makes it stale: the project is removed after the card is filed.
  f.db.insert(projects).values({ id: 'garden', name: 'Garden' }).run();
  const late = ask('art');
  expect(late).toMatchObject({ target: 'household:projectJoin:art onto project pond' });
  const gardens = f.root.writes.run(() => f.root.services.setup.propose('mark', { change: 'projectJoin', input: { project: 'garden', agent: 'mark' }, why: 'x' })).value;
  f.db.update(projects).set({ removedAt: new Date(f.clock.now()).toISOString() }).where(eq(projects.id, 'garden')).run();
  expect((await f.call('approvals/answer', { id: gardens.id, answer: 'allow' }, 'sam')).body).toMatchObject({ ok: false, message: 'This has changed since the card was filed. Open the updated card to review it.' });
  // And a card for an agent that is already on the project is refused as that.
  expect((await f.call('approvals/answer', { id: late.id, answer: 'allow' }, 'sam')).body).toMatchObject({ ok: false, message: 'art is already on project pond' });
});

it('takes a request to join a project from the agent itself or a household owner, and from nobody else', async () => {
  const f = fixture(), at = new Date(f.clock.now()).toISOString();
  f.db.insert(projects).values([{ id: 'pond', name: 'Pond' }, { id: 'garden', name: 'Garden' }, { id: 'shut', name: 'Shut', removedAt: at }]).run();
  f.db.insert(projectAgents).values({ project: 'pond', agent: 'art' }).run();
  f.db.insert(agents).values({ id: 'old', ...visual, removedAt: at }).run();
  const ask = (input: unknown, actor: keyof typeof credentials) => f.call('household/propose', { change: 'projectJoin', input, why: 'To work on it' }, actor);
  const cards = () => f.db.select().from(approvals).all().length;
  // An agent asks for itself. Not for another agent; and a member who is not a household owner asks for nobody.
  expect((await ask({ project: 'garden', agent: 'mark' }, 'art')).status).toBe(403);
  expect((await ask({ project: 'garden', agent: 'art' }, 'lee')).status).toBe(403);
  expect(cards()).toBe(0);
  // Already on it: said so, and no card is filed.
  expect((await ask({ project: 'pond', agent: 'art' }, 'art')).body).toMatchObject({ ok: false, code: 'invalid', message: 'art is already on project pond' });
  expect(cards()).toBe(0);
  // What an agent may not read is not told to it: a project that is removed or not there is filed like any
  // other, and the owner is told why it cannot be allowed.
  for (const [project, problem] of [['shut', 'Project shut is removed'], ['nowhere', 'No project has the id nowhere']] as const) {
    const filed = await ask({ project, agent: 'art' }, 'art');
    expect(filed).toMatchObject({ status: 200, body: { ok: true, value: { state: 'pending' } } });
    expect((await look(f, filed.body.value!.id)).problem).toBe(problem);
    expect((await f.call('approvals/answer', { id: filed.body.value!.id, answer: 'allow' }, 'sam')).body).toMatchObject({ ok: false, message: problem });
    expect((await f.call('approvals/answer', { id: filed.body.value!.id, answer: 'deny' }, 'sam')).body.ok).toBe(true);
  }
  expect(await ask({ project: 'garden', agent: 'art' }, 'art')).toMatchObject({ status: 200, body: { ok: true, value: { state: 'pending' } } });
  expect(f.db.select().from(approvals).all().at(-1)).toMatchObject({ agent: 'art', askedFrom: 'terminal', actingFor: 'unknown' });
  // A household owner asks for any agent, is told at once what stands against it, and the card is the agent's.
  for (const [input, message] of [[{ project: 'pond', agent: 'art' }, 'art is already on project pond'], [{ project: 'shut', agent: 'mark' }, 'Project shut is removed'],
    [{ project: 'nowhere', agent: 'mark' }, 'No project has the id nowhere'], [{ project: 'pond', agent: 'nobody' }, 'No agent has the id nobody'], [{ project: 'pond', agent: 'old' }, 'Agent old is removed']] as const)
    expect((await ask(input, 'sam')).body).toMatchObject({ ok: false, message });
  const before = cards();
  const owners = await ask({ project: 'pond', agent: 'mark' }, 'sam');
  expect(owners).toMatchObject({ status: 200, body: { ok: true, value: { state: 'pending' } } });
  expect(cards()).toBe(before + 1);
  expect(f.db.select().from(approvals).where(eq(approvals.id, owners.body.value!.id)).get()).toMatchObject({ agent: 'mark', kind: 'setting', actingFor: 'sam', askedFrom: 'household owner', ask: 'Let mark work on project pond?' });
  expect((await f.call('approvals/answer', { id: owners.body.value!.id, answer: 'allow' }, 'sam')).status).toBe(200);
  expect(f.root.services.projects.describe('pond')).toMatchObject({ agents: ['art', 'mark'] });
  // Only projectJoin is an owner's to file: every other change is still asked by an agent.
  expect((await f.call('household/propose', { change: 'settings', input: { commsDays: 9 }, why: 'x' }, 'sam')).status).toBe(403);
});

it('retires and revives a project by a card an owner answers; its tasks leave every list of work and come back as they were', async () => {
  const f = fixture(), at = new Date(f.clock.now()).toISOString();
  f.db.insert(projects).values([{ id: 'phasecraft', name: 'Phasecraft' }, { id: 'pond', name: 'Pond' }, { id: 'shut', name: 'Shut', removedAt: at }]).run();
  f.db.insert(projectMembers).values([{ project: 'phasecraft', member: 'lee' }, { project: 'pond', member: 'lee' }]).run();
  f.db.insert(projectAgents).values([{ project: 'phasecraft', agent: 'art' }, { project: 'pond', agent: 'art' }]).run();
  const make = (title: string, project: string) => f.root.writes.run(() => f.root.services.tasks.create({ title, goal: 'Done', why: 'Needed', owner: { kind: 'agent', id: 'art' }, project }, { kind: 'agent', id: 'art' })).value;
  const open = make('Open', 'phasecraft'), held = make('Held', 'phasecraft'), asked = make('Asked', 'phasecraft'), other = make('Other', 'pond');
  f.root.writes.run(() => { f.root.services.tasks.claim(held.id, { kind: 'agent', id: 'art' }); f.root.services.tasks.ask(asked.id, { to: { kind: 'member', id: 'lee' }, ask: 'Spend?', ifYes: 'Buy', ifNo: 'Wait' }, { kind: 'agent', id: 'art' }); });
  const read = async (query: string, actor: keyof typeof credentials) => { const reply = (await (await f.root.http.request('http://loom/graphql', { method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer ' + credentials[actor] }, body: JSON.stringify({ query }) })).json() as { data: Record<string, unknown>; errors?: unknown }); expect(reply.errors, JSON.stringify(reply.errors)).toBeUndefined(); return reply.data; };
  const work = async (actor: keyof typeof credentials = 'art') => {
    const data = await read('{ readyTasks { id } tasks(orderBy: {id: {direction: asc, priority: 0}}) { id status isReady isShelved } }', actor) as { readyTasks: { id: string }[]; tasks: { id: string; status: string; isReady: boolean; isShelved: boolean }[] };
    return { ready: data.readyTasks.map(row => row.id).sort(), tasks: data.tasks.map(row => [row.id, row.status, row.isReady, row.isShelved]) };
  };
  const before = { work: await work(), lee: await work('lee') };
  expect(before.work).toEqual({ ready: [open.id, asked.id, other.id].sort(), tasks: [[open.id, 'open', true, false], [held.id, 'in_progress', false, false], [asked.id, 'open', true, false], [other.id, 'open', true, false]] });

  const ask = (change: string, input: unknown) => f.call('household/propose', { change, input, why: 'Set aside for now' }, 'art');
  const filed = await ask('projectRetire', { project: 'phasecraft' });
  const id = filed.body.value!.id;
  expect(f.db.select().from(approvals).where(eq(approvals.id, id)).get()).toMatchObject({ kind: 'setting', state: 'pending', target: 'household:projectRetire:phasecraft', ask: 'Retire project phasecraft?',
    changeSummary: 'Retire project phasecraft. Everything in it stays and stays readable; its unfinished tasks are shelved until it is revived.' });
  expect(await work()).toEqual(before.work);
  expect((await f.call('approvals/answer', { id, answer: 'allow' }, 'lee')).status).toBe(403);
  expect((await f.call('approvals/answer', { id, answer: 'allow' }, 'sam')).body.ok).toBe(true);
  // Retired: everything is still read by who read it, each task as it was stored, marked shelved; none is ready.
  const retired = await work();
  expect(retired.ready).toEqual([other.id]);
  expect(retired.tasks).toEqual([[open.id, 'open', false, true], [held.id, 'in_progress', false, true], [asked.id, 'open', false, true], [other.id, 'open', true, false]]);
  expect((await work('lee')).tasks.map(row => row[0])).toEqual(before.lee.tasks.map(row => row[0]));
  // Nothing is claimed, created in it or moved into it; a task is moved out.
  expect((await f.call('tasks/command', { action: 'claim', id: open.id }, 'art')).body).toMatchObject({ ok: false, message: 'Project phasecraft is retired: its tasks are shelved until it is revived' });
  expect((await f.call('tasks/command', { action: 'create', input: { title: 'New', goal: 'Done', why: 'Needed', owner: { kind: 'agent', id: 'art' }, project: 'phasecraft' } }, 'art')).status).toBe(403);
  expect((await f.call('tasks/command', { action: 'moveToProject', ids: [other.id], project: 'phasecraft' }, 'art')).status).toBe(403);
  // Refused to the owner in plain words: already retired, removed, not there; and reviving what is not retired.
  for (const [change, project, problem] of [['projectRetire', 'phasecraft', 'Project phasecraft is already retired'], ['projectRetire', 'shut', 'Project shut is removed'], ['projectRetire', 'nowhere', 'No project has the id nowhere'], ['projectRevive', 'pond', 'Project pond is not retired']] as const) {
    const hopeless = await ask(change, { project });
    expect(hopeless).toMatchObject({ status: 200, body: { ok: true, value: { state: 'pending' } } });
    expect((await look(f, hopeless.body.value!.id)).problem).toBe(problem);
    expect((await f.call('approvals/answer', { id: hopeless.body.value!.id, answer: 'allow' }, 'sam')).body).toMatchObject({ ok: false, message: problem });
    expect((await f.call('approvals/answer', { id: hopeless.body.value!.id, answer: 'deny' }, 'sam')).body.ok).toBe(true);
  }
  // Revived by the mirror card: everything is work again exactly as it was, the claim and the question included.
  const revive = await ask('projectRevive', { project: 'phasecraft' });
  expect(f.db.select().from(approvals).where(eq(approvals.id, revive.body.value!.id)).get()).toMatchObject({ kind: 'setting', ask: 'Revive project phasecraft?' });
  expect((await f.call('approvals/answer', { id: revive.body.value!.id, answer: 'allow' }, 'sam')).body.ok).toBe(true);
  expect(await work()).toEqual(before.work);
  expect(f.root.services.tasks.get(held.id)).toMatchObject({ status: 'in_progress', assignee: 'art' });
});

it('lets a standing rule for settings answer a retire and a revive: each is undone by the other', async () => {
  const f = fixture(), at = new Date(f.clock.now()).toISOString();
  f.db.insert(projects).values({ id: 'phasecraft', name: 'Phasecraft' }).run();
  f.db.insert(conversations).values({ id: 'cv-sam', agent: 'art', member: 'sam', venue: 'loom', place: 'th', label: 'Sam', startedAt: at, lastAt: at, turnCount: 0 }).run();
  const where = { conversation: 'cv-sam', member: 'sam', project: null };
  const ask = (change: string) => f.root.writes.run(() => f.root.services.setup.propose('art', { change, input: { project: 'phasecraft' }, why: 'Asked in conversation' }, where)).value;
  f.root.writes.run(() => f.root.services.setup.rule({ kind: 'setting', scope: '*', person: '', tier: 'do' }, 'sam'));
  expect(ask('projectRetire')).toMatchObject({ state: 'used', kind: 'setting', decidedBy: 'sam' });
  expect(f.root.services.projects.describe('phasecraft')).toMatchObject({ retired: true });
  expect(ask('projectRevive')).toMatchObject({ state: 'used', kind: 'setting' });
  expect(f.root.services.projects.describe('phasecraft')).toMatchObject({ retired: false });
});

it('requires owner cards for kit definitions, their grants and outside project membership', async () => {
  const f = fixture();
  const propose = (change: string, input: unknown) => f.call('household/propose', { change, input, why: 'Configure the project kit' }, 'art');
  const apply = async (change: string, input: unknown) => {
    const filed = await propose(change, input);
    expect(filed.body).toMatchObject({ok:true,value:{state:'pending'}});
    const id = filed.body.value!.id;
    if (change==='kit' && (input as {tools?:unknown}).tools) {
      const preview=await look(f,id);
      expect(preview.summary).toContain('Run forecast with program "tools/forecast" {city}');
      expect(preview.summary).toContain('weather-key as KIT_WEATHER');
    }
    if (change==='projectOutsidePerson') expect((await look(f,id)).summary).toContain('Project kits: art/tools.');

    expect((await f.call('approvals/answer', {id, answer:'allow'}, 'lee')).status).toBe(403);
    expect((await f.call('approvals/answer', {id, answer:'allow'}, 'sam')).body.ok).toBe(true);
  };
  await apply('project', pond);
  f.db.insert(agentPeople).values({agent:'art',person:JSON.stringify(['discord','server','person']),tier:1}).run();
  const tool={name:'forecast',description:'Get the weather',program:'tools/forecast',repository:'https://example.com/house.git',
    commit:'a'.repeat(40),image:'sha256:'+'b'.repeat(64),parameters:{city:{type:'string',description:'City'}},
    args:[{parameter:'city'}],secrets:{KIT_WEATHER:'weather-key'}};
  await apply('kit', {agent:'art',kit:'tools',tools:[tool]});
  await apply('kitGrant', {agent:'art',kit:'tools',to:{project:'pond'},grant:true});
  await apply('projectOutsidePerson', {project:'pond',platform:'discord',workspace:'server',user:'person',on:true});
  await apply('kitGrant', {agent:'art',kit:'tools',to:{project:'pond'},grant:false});
  await apply('kit', {agent:'art',kit:'tools',tools:null});
});

it('reserves kit grants and membership changes on kit-bearing projects for an owner', async () => {
  const f=fixture(),at=new Date(f.clock.now()).toISOString();
  f.db.insert(conversations).values({id:'cv-kits',agent:'art',member:'sam',venue:'loom',place:'th',label:'Sam',startedAt:at,lastAt:at,turnCount:0}).run();
  f.root.writes.run(()=>f.root.services.setup.rule({kind:'setting',scope:'*',person:'',tier:'do'},'sam'));
  const ask=(change:string,input:unknown)=>f.root.writes.run(()=>f.root.services.setup.propose('art',{change,input,why:'Configure project access'},{conversation:'cv-kits',member:'sam',project:null})).value;
  const approve=async(change:string,input:unknown)=>{
    const card=ask(change,input);
    expect(card.state).toBe('pending');
    expect((await f.call('approvals/answer',{id:card.id,answer:'allow'},'sam')).body).toMatchObject({ok:true});
  };
  f.db.insert(agentPeople).values({agent:'art',person:JSON.stringify(['slack','W','U']),tier:1}).run();
  expect(ask('project',pond).state).toBe('used');
  await approve('kit',{agent:'art',kit:'tools',tools:[]});
  await approve('kitGrant',{agent:'art',kit:'tools',to:{project:'pond'},grant:true});
  await approve('project',{...pond,members:['sam']});
  await approve('projectOutsidePerson',{project:'pond',platform:'slack',workspace:'W',user:'U',on:true});
  await approve('kitGrant',{agent:'art',kit:'tools',to:{platform:'slack',workspace:'W',user:'U'},grant:true});
  await approve('kitGrant',{agent:'art',kit:'tools',to:{member:'lee'},grant:true});
});

it('lets the owner file a kit or outside roster card and seals project grants on that roster card',async()=>{
  const f=fixture();
  const ask=(change:string,input:unknown)=>f.call('household/propose',{change,input,why:'Review kit access'},'sam');
  const allow=(id:string)=>f.call('approvals/answer',{id,answer:'allow'},'sam');
  const key={agent:'art',kit:'tools'};
  f.db.insert(projects).values({id:'pond',name:'Pond'}).run();
  const kit=await ask('kit',{...key,tools:[]});
  expect(kit.body).toMatchObject({ok:true,value:{state:'pending'}});
  expect((await allow(kit.body.value!.id)).body).toMatchObject({ok:true});
  const person={project:'pond',platform:'slack',workspace:'W',user:'U',on:true};
  const unknown=await ask('projectOutsidePerson',person);
  expect((await allow(unknown.body.value!.id)).body.message).toContain('already known');
  await f.call('approvals/answer',{id:unknown.body.value!.id,answer:'deny'},'sam');
  f.db.insert(agentPeople).values({agent:'mark',person:JSON.stringify(['slack','W','U']),tier:1}).run();
  const waiting=await ask('projectOutsidePerson',person);
  expect(waiting.body).toMatchObject({ok:true,value:{state:'pending'}});
  const grant=await ask('kitGrant',{...key,to:{project:'pond'},grant:true});
  expect((await allow(grant.body.value!.id)).body).toMatchObject({ok:true});
  expect((await allow(waiting.body.value!.id)).body.message).toContain('changed since');
});

it('adds a single colleague tier and optional project kit roster together on the owner’s answer',async()=>{
  const f=fixture(),account={platform:'slack' as const,workspace:'TWORK',user:'UROBIN'};
  const proposed={...account,agent:'art',tier:2},person=JSON.stringify(['slack','TWORK','UROBIN']);
  f.db.insert(projects).values({id:'pond',name:'Pond'}).run();
  f.db.insert(agentKits).values({agent:'art',kit:'field',tools:[]}).run();
  f.db.insert(agentKitProjects).values({agent:'art',kit:'field',project:'pond'}).run();
  f.db.insert(agentDeniedTools).values({agent:'art',pattern:'Bash',guestsOnly:true}).run();
  f.db.insert(agentPeople).values({agent:'mark',person,tier:1}).run();
  const unrelated={agent:'art',person:JSON.stringify(['slack','TOTHER','UROBIN']),tier:3 as const};
  f.root.writes.run(()=>f.root.services.setup.rule({kind:'setting',scope:'*',person:'',tier:'do'},'sam'));
  const offer={change:'colleague',input:{...proposed,project:'pond'},why:'Let Robin discuss field work'};
  const filed=await f.call('household/propose',offer,'art','file-robin'),id=filed.body.value!.id;
  expect(filed.body.value).toMatchObject({state:'pending'});
  expect(await f.call('household/propose',offer,'art','file-robin')).toEqual(filed);
  expect((await f.call('household/propose',{...offer,input:{...offer.input,agent:'mark'}},'art')).status).toBe(403);
  expect((await f.call('household/proposalPreview',{id},'art')).status).toBe(403);
  expect(await preview(f,id)).toMatchObject({blocked:null,card:{facts:expect.arrayContaining([
    {label:'Interaction tier',value:'New contact → Tier 2'},
    {label:'Project kit roster',value:'Pond'},
    {label:'Direct messages',value:expect.stringContaining('can initiate a Slack DM')},
    {label:'Kits granted through this project',value:'Art’s field kit'},
  ])}});
  expect((await f.call('approvals/answer',{id,answer:'allow'},'lee')).body.ok).toBe(false);
  expect(f.db.select().from(projectOutsidePeople).all()).toEqual([]);
  expect(f.db.select().from(agentPeople).all()).toEqual([{agent:'mark',person,tier:1}]);
  // An unrelated, concurrent contact change survives Allow without invalidating the card.
  f.db.insert(agentPeople).values(unrelated).run();
  const allowed=await f.call('approvals/answer',{id,answer:'allow'},'sam','allow-robin');
  expect(allowed.body.ok).toBe(true);
  expect(await f.call('approvals/answer',{id,answer:'allow'},'sam','allow-robin')).toEqual(allowed);
  const people=f.db.select().from(agentPeople).all();
  expect(people).toHaveLength(3);
  expect(people).toEqual(expect.arrayContaining([unrelated,{agent:'mark',person,tier:1},{agent:'art',person,tier:2}]));
  expect(f.db.select().from(projectOutsidePeople).all()).toEqual([{...account,project:'pond'}]);
  expect(f.db.select().from(projectMembers).all()).toEqual([]);
  expect(f.db.select().from(projectAgents).all()).toEqual([]);
  expect(f.db.select().from(agentDeniedTools).all()).toEqual([{agent:'art',pattern:'Bash',guestsOnly:true}]);
  const update=await f.call('household/propose',{...offer,input:{...proposed,tier:1}},'art');
  expect((await preview(f,update.body.value!.id)).card!.facts).toContainEqual({label:'Direct messages',value:expect.stringContaining('can reply')});
  expect((await f.call('approvals/answer',{id:update.body.value!.id,answer:'allow'},'sam')).body.ok).toBe(true);
  expect(f.db.select().from(agentPeople).all()).toContainEqual({agent:'art',person,tier:1});
  expect(f.db.select().from(projectOutsidePeople).all()).toEqual([{...account,project:'pond'}]);
});

it('isolates pending colleague proposals and their receipts between private conversations',async()=>{
  const f=await bodyFixture(clean);
  f.db.update(members).set({role:'owner'}).where(eq(members.id,'alice')).run();
  f.db.insert(memberAgents).values({member:'bob',agent:'art'}).run();
  f.db.insert(projectMembers).values({member:'bob',project:'pond'}).run();
  const second=f.root.services.comms!.threads.open({member:'bob',agent:'art',project:'pond',title:'Another private conversation'});
  const input={change:'colleague',input:{agent:'art',platform:'slack',workspace:'TWORK',user:'UROBIN',tier:2},why:'Introduce the field contact'};
  const ask=async(id:string)=>{
    const response=await f.root.http.request('/api/household/propose',{method:'POST',headers:{authorization:'Bearer '+bodyCredentials.body,'content-type':'application/json'},body:JSON.stringify({input,id})});
    return await response.json();
  };
  const first=await ask('same-receipt');
  expect(first).toMatchObject({ok:true,value:{state:'pending'}});
  expect(await ask('same-receipt')).toEqual(first);
  expect(await ask('repeat-alice')).toMatchObject({ok:false,message:'A card for this is already waiting for an answer'});
  f.root.writes.run(()=>f.db.update(jobs).set({member:'bob',conversation:second.conversation}).where(eq(jobs.id,'job')).run());
  expect(await ask('same-receipt')).toMatchObject({ok:false,code:'conflict',message:'Operation id already used for different input'});
  const theirs=await ask('bob-receipt');
  expect(theirs).toMatchObject({ok:true,value:{state:'pending'}});
  expect(theirs.value.id).not.toBe(first.value.id);
  expect(await ask('bob-receipt')).toEqual(theirs);
  const third=f.root.services.comms!.threads.open({member:'bob',agent:'art',project:'pond',title:'Separate thread for the same member'});
  f.root.writes.run(()=>f.db.update(jobs).set({conversation:third.conversation}).where(eq(jobs.id,'job')).run());
  expect(await ask('bob-receipt')).toMatchObject({ok:false,code:'conflict'});
  expect(await ask('third-receipt')).toMatchObject({ok:true,value:{state:'pending'}});
});

it('shows owners every consequential colleague kit definition and its immutable pins beyond the summary limit',async()=>{
  const f=fixture(),who={platform:'slack' as const,workspace:'TWORK',user:'UROBIN'},input={agent:'art',...who,tier:2,project:'pond'};
  f.db.insert(projects).values([{id:'pond',name:'Pond'},{id:'lab',name:'Lab'}]).run();
  const tool={name:'status',description:'Inspect fictional fixtures',program:'bin/field-status',repository:'https://example.org/fixtures.git',
    commit:'a'.repeat(40),image:'sha256:'+'b'.repeat(64),args:['status'],parameters:{},secrets:{FIELD_TOKEN:'field-token'}};
  const definitions=Array.from({length:100},(_,i)=>({agent:'art',kit:'field-instrument-'+String(i).padStart(3,'0'),tools:[tool]}));
  f.db.insert(agentKits).values(definitions).run();
  f.db.insert(agentKitProjects).values(definitions.map(row=>({agent:row.agent,kit:row.kit,project:'pond'}))).run();
  f.db.insert(agentKitProjects).values({agent:'art',kit:definitions[99].kit,project:'lab'}).run();
  f.db.insert(projectOutsidePeople).values({...who,project:'lab'}).run();
  f.db.insert(agentKitOutsidePeople).values({...who,agent:'art',kit:definitions[0].kit}).run();
  const filed=await f.call('household/propose',{change:'colleague',input,why:'Review the instrument kits'},'art'),id=filed.body.value!.id;
  const record=f.db.select().from(approvals).where(eq(approvals.id,id)).get()!;
  expect(record.details).not.toContain(tool.program);
  expect(record.details).not.toContain('field-instrument');
  for(const viewer of ['lee','art'] as const)expect((await f.call('household/proposalPreview',{id},viewer)).status).toBe(403);
  const shown=await preview(f,id);
  expect(shown.summary).not.toContain(definitions[98].kit);
  expect(shown.card!.exact.length).toBeGreaterThan(40_000);
  expect(JSON.parse(shown.card!.exact)).toEqual({request:input,effects:'Match the state sealed when filed',projectKitRoster:{project:'pond',kits:definitions},
    reactivatedKitGrants:{agent:'art',direct:[{kit:definitions[0].kit,tools:[tool]}],inherited:[{kit:definitions[99].kit,project:'lab',tools:[tool]}]}});
  const changed={...tool,commit:'c'.repeat(40)};
  f.db.update(agentKits).set({tools:[changed]}).where(eq(agentKits.kit,definitions[99].kit)).run();
  const stale=await preview(f,id);
  expect(stale.blocked).toBeNull();
  expect(stale.review).toMatch(/^[a-f0-9]{64}$/);
  expect(stale.card!.exact).toContain(changed.commit);
  expect((await f.call('approvals/answer',{id,answer:'allow'},'sam')).body.ok).toBe(false);
});

it('rechecks linked identities, live projects and every kit that a new colleague would gain before Allow',async()=>{
  const f=fixture(),who={platform:'slack' as const,workspace:'TWORK',user:'UROBIN'},input={agent:'art',...who,tier:2};
  f.db.insert(projects).values([{id:'pond',name:'Pond'},{id:'lab',name:'Lab'}]).run();
  f.db.insert(agentKits).values(['field','bench'].map(kit=>({agent:'art',kit,tools:[]}))).run();
  f.db.insert(agentKitProjects).values({agent:'art',kit:'bench',project:'lab'}).run();
  f.db.insert(projectOutsidePeople).values({...who,project:'lab'}).run();
  const ask=async(project?:string)=>{const row=await f.call('household/propose',{change:'colleague',input:{...input,project},why:'Review this contact'},'art');return row.body.value!.id;};
  const answer=(id:string,word:'allow'|'deny')=>f.call('approvals/answer',{id,answer:word},'sam');
  const stale=await ask('pond');
  expect((await preview(f,stale)).card!.facts).toContainEqual({label:'Existing kit grants that become available',value:'bench (via Lab)'});
  f.db.insert(agentKitProjects).values({agent:'art',kit:'field',project:'pond'}).run();
  expect((await answer(stale,'allow')).body.message).toContain('changed since');
  await answer(stale,'deny');
  const direct=await ask();
  f.db.insert(agentKitOutsidePeople).values({agent:'art',kit:'field',...who}).run();
  expect((await answer(direct,'allow')).body.message).toContain('changed since');
  await answer(direct,'deny');
  const already=await ask('lab');
  const onRoster=await preview(f,already);
  expect(onRoster.card?.title).toContain('keep them on the Lab kit roster');
  expect(onRoster.card?.ifYes).toContain('remains on the Lab kit roster');
  expect(onRoster.card?.facts).toContainEqual({label:'Existing kit grants that become available',value:expect.stringContaining('bench (via Lab)')});
  await answer(already,'deny');
  const missing=await ask('missing');
  expect((await preview(f,missing)).blocked).toContain('not in use');
  expect((await answer(missing,'allow')).body.ok).toBe(false);
  await answer(missing,'deny');
  f.db.insert(bridgePeople).values({...who,member:'lee'}).run();
  const linked=await ask('pond');
  expect((await preview(f,linked)).blocked).toContain('household member lee');
  expect((await answer(linked,'allow')).body.ok).toBe(false);
  expect(f.db.select().from(agentPeople).all()).toEqual([]);
  expect(f.db.select().from(projectOutsidePeople).all()).toEqual([{...who,project:'lab'}]);
});

it('requires the current machine owner to approve each explicit reader and revocation', async () => {
 const f=fixture(), at=new Date(f.clock.now()).toISOString();
 f.db.insert(boxes).values({id:'work',name:'Workshop',owner:'lee',sameMachineAsLoom:false,hostsAny:false,reportOnly:true,alwaysOn:false,enrolledAt:at}).run();
 for(const allow of [true,false]){
  const input={box:'work',agent:'art',allow};
  expect((await f.call('machine/proposeReader',input,'sam')).status).toBe(403);
  const filed=await f.call('machine/proposeReader',input,'lee');
  expect(filed.body.value?.state).toBe('pending');
  const id=filed.body.value!.id;
  expect(f.db.select().from(inbox).where(eq(inbox.sourceId,id)).all().map(row=>row.to)).toEqual(['lee']);
  expect((await f.call('approvals/answer',{id,answer:'allow'},'sam')).status).toBe(403);
  expect((await f.call('machine/readerCards',{machine:'work'},'lee')).body.value).toEqual([expect.objectContaining({id,ask:expect.stringContaining(allow?'Grant':'Revoke')})]);
  expect((await f.call('machine/answerReader',{id,answer:'allow'},'sam')).status).toBe(403);
  expect((await f.call('machine/answerReader',{id,answer:'allow'},'lee')).body.ok).toBe(true);
  expect(f.db.select().from(boxes).get()!.readers).toEqual(allow?['art']:[]);
 }
});

it('shows an agent-proposed change to explicit readers on the machine owner’s pending cards',async()=>{
 const f=fixture(),at=new Date(f.clock.now()).toISOString();
 const settings={box:'work',name:'Workshop',hostsAny:false,reportOnly:true,alwaysOn:false,agents:[],facts:[],readers:['mark']};
 f.db.insert(boxes).values({id:'work',name:'Workshop',owner:'lee',sameMachineAsLoom:false,hostsAny:false,reportOnly:true,alwaysOn:false,enrolledAt:at}).run();
 const result=await f.call('household/propose',{change:'boxSettings',input:settings,why:'Read load and disk'},'art');
 const id=result.body.value!.id;
 expect((await f.call('approvals/answer',{id,answer:'allow'},'sam')).status).toBe(403);
 expect((await f.call('machine/readerCards',{machine:'work'},'lee')).body.value).toEqual([{id,ask:'Grant machine reads to mark.'}]);
 f.db.update(boxes).set({readers:['art']}).where(eq(boxes.id,'work')).run();
 const [updated]=(await f.call('machine/readerCards',{machine:'work'},'lee')).body.value as unknown as {review:string;ask:string}[];
 expect(updated.ask).toContain('Revoke the explicit machine read grant for art');
 expect((await f.call('machine/answerReader',{id,answer:'allow'},'lee')).body.ok).toBe(false);
 expect((await f.call('machine/answerReader',{id,answer:'allow',review:updated.review},'lee')).body.ok).toBe(true);
 expect(f.db.select().from(boxes).get()?.readers).toEqual(['mark']);
});

const preview = async (f: Fixture, id: string) => (await f.call('household/proposalPreview', { id }, 'sam')).body.value as unknown as {
  summary: string; review?:string; exact?: string; blocked: string | null; card: { title: string; facts: { label: string; value: string; small?: boolean }[]; exact: string; ifYes?: string } | null;
};

it('tells a household owner who a card is for, and nobody else: the names loom holds are read for the owner when the card is read', async () => {
  const f = fixture(), at = new Date(f.clock.now()).toISOString();
  const gage = { platform: 'slack', workspace: 'T02AYL3QM', user: 'U07V8CZUC1J' };
  await f.call('household/propose', { change: 'kit', input: { agent: 'art', kit: 'pond-et-livonia', tools: [] }, why: 'Field scope' }, 'art').then(filed => f.call('approvals/answer', { id: filed.body.value!.id, answer: 'allow' }, 'sam'));
  f.db.insert(agentPeople).values({ agent: 'art', person: JSON.stringify([gage.platform, gage.workspace, gage.user]), tier: 2 }).run();
  const id = (await f.call('household/propose', { change: 'kitGrant', input: { agent: 'art', kit: 'pond-et-livonia', to: gage, grant: true }, why: 'Restore the recorded Pond field scope.' }, 'art')).body.value!.id;
  // The card itself, which the asking agent and others read, says only what was asked: the id, and no name.
  const stored = f.db.select().from(approvals).where(eq(approvals.id, id)).get()!;
  expect(stored).toMatchObject({
    ask: 'Grant art kit pond-et-livonia to slack user U07V8CZUC1J in T02AYL3QM?',
    ifYes: 'Grant art kit pond-et-livonia to slack user U07V8CZUC1J in T02AYL3QM.',
    ifNo: 'Keep the current access.',
  });
  // loom holds no name yet: the owner is told so in words.
  expect((await preview(f, id)).card).toMatchObject({ title: 'Let an unnamed Slack account use Art’s pond-et-livonia kit' });
  // A person link names the account for the owner. It is read when the card is read, so the same card now says it.
  f.db.insert(members).values({ id: 'gage', role: 'member', joinedAt: at }).run();
  f.db.insert(bridgePeople).values({ ...gage, workspace: 'T0OTHER', member: 'gage' }).run();
  expect((await preview(f, id)).card!.title).toContain('unnamed Slack account');
  f.db.delete(bridgePeople).run();
  f.db.insert(secrets).values({ name: 'slack-token', description: 'Bot token', changedAt: at, changedBy: 'sam' }).run();
  f.db.insert(bridgeConnections).values({ id: 'art-slack', platform: 'slack', agent: 'art', workspace: gage.workspace, botUser: 'UBOT', tokenSecret: 'slack-token', enabled: true, state: 'connected', stateAt: at }).run();
  const told = await preview(f, id);
  expect(told.card!.facts).toContainEqual({ label: 'Workspace', value: 'Slack connection art-slack' });
  expect(told.card!.facts.at(-1)).toEqual({ label: 'Account id', value: 'U07V8CZUC1J', small: true });
  expect(told.summary).not.toContain('{"');
  expect(JSON.parse(told.card!.exact)).toMatchObject({ to: gage });
  expect(told.blocked).toBeNull();
  // Neither the asking agent nor a member who is not an owner may ask for the owner's reading, and the card
  // they do read through the data door still holds no name and nothing of what is there now.
  for (const actor of ['lee', 'art'] as const) expect((await f.call('household/proposalPreview', { id }, actor)).status).toBe(403);
  f.db.insert(memberAgents).values({ member: 'lee', agent: 'art' }).run();
  f.db.insert(bridgePeople).values({ ...gage, member: 'gage' }).run();
  expect((await preview(f, id)).card!.title).toContain('gage (Slack)');
  const titles = async (actor: keyof typeof credentials, ids=[id]) => {
    const response = await f.root.http.request('http://loom/graphql', {method:'POST',
      headers:{'content-type':'application/json',authorization:'Bearer '+credentials[actor]},
      body:JSON.stringify({query:'query Titles($ids:[String!]!){inboxProposalTitles(ids:$ids){approval title}}',variables:{ids}})});
    const result=await response.json();expect(result.errors).toBeUndefined();return result.data.inboxProposalTitles;
  };
  expect(await titles('sam')).toEqual([{approval:id,title:expect.stringContaining('gage (Slack)')}]);
  const colleague=(await f.call('household/propose',{change:'colleague',input:{agent:'art',...gage,tier:3},why:'Review the contact tier'},'art')).body.value!.id;
  const colleagueTitle=(await preview(f,colleague)).card!.title;
  expect(colleagueTitle).toBe('Set gage (Slack) to tier 3 with Art');
  expect(await titles('sam',[colleague])).toEqual([{approval:colleague,title:colleagueTitle}]);
  expect(await titles('lee',[colleague])).toEqual([]);
  expect(await titles('art',[colleague])).toEqual([]);
  await f.call('approvals/answer',{id:colleague,answer:'deny'},'sam');
  expect(await titles('sam',[colleague])).toEqual([{approval:colleague,title:colleagueTitle}]);
  expect(await titles('lee')).toEqual([]);
  expect(await titles('art')).toEqual([]);
  for (const actor of ['lee', 'art'] as const) {
    const response = await f.root.http.request('http://loom/graphql', { method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer ' + credentials[actor] }, body: JSON.stringify({ query: '{ approvals { id what ask changeSummary ifYes ifNo details } }' }) });
    const read = JSON.stringify(await response.json());
    expect(read).toContain(id);
    expect(read).toContain('slack user U07V8CZUC1J in T02AYL3QM');
    expect(read).not.toMatch(/gage|art-slack|loom has no name/i);
  }
  const disconnect=(await f.call('household/propose',{change:'bridge',input:{action:'disconnect',id:'art-slack'},why:'Disconnect Slack'},'art')).body.value!.id;
  const unrelated=(await f.call('household/propose',{change:'kit',input:{agent:'art',kit:'second-kit',tools:[]},why:'Add kit'},'art')).body.value!.id;
  const disconnectedTitle=(await preview(f,disconnect)).card!.title;
  expect(disconnectedTitle).toContain('Slack connection');
  expect(await titles('sam',[disconnect,unrelated])).toEqual([{approval:disconnect,title:disconnectedTitle}]);
  expect((await f.call('approvals/answer',{id:disconnect,answer:'allow'},'sam')).body.ok).toBe(true);
  expect(await titles('sam',[disconnect])).toEqual([{approval:disconnect,title:disconnectedTitle}]);
});

it('names an outside account from its exact directory record only for the owner', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'approval-people-'));
  clean.push(() => rmSync(directory, { recursive: true, force: true }));
  const people = join(directory, 'people.db'), knowledge = join(directory, 'knowledge.db');
  const store = new PeopleStore({ dbPath: people });
  try {
    store.write({ slug: 'field-contact', name: 'Casey Field', where: {
      slack: { value: ['UCASEY', 'UCASEYTWO'] }, slack_workspace: { value: 'TFIELD' },
    } });
    store.write({ slug: 'bare-handle', name: 'Unscoped Name', where: { slack: { value: 'UCASEY' } } });
  } finally { store.close(); }
  const f = fixture({ checkingAgent: 'art', sources: { commons: { directory, people, knowledge }, agents: [] } });
  const file = async (platform: string, workspace: string, user: string) => {
    const input = { agent: 'art', kit: 'field', to: { platform, workspace, user }, grant: true };
    return (await f.call('household/propose', { change: 'kitGrant', input, why: 'Set field access' }, 'art')).body.value!.id;
  };
  const id = await file('slack', 'TFIELD', 'UCASEY');
  const named = await preview(f, id);
  expect((await preview(f, await file('slack','TFIELD','UCASEYTWO'))).card!.title).toContain('Casey Field (Slack)');
  expect(named.card!.title).toContain('Casey Field (Slack)');
  expect(named.card!.facts).toContainEqual({ label: 'Name from', value: 'People directory record for this account' });
  for (const [platform, workspace, user] of [['slack', 'TOTHER', 'UCASEY'], ['discord', 'TFIELD', 'UCASEY'], ['slack', 'TFIELD', 'UOTHER']]) {
    expect((await preview(f, await file(platform, workspace, user))).card!.title).toContain(platform === 'slack' ? 'unnamed Slack account' : 'Discord account loom has no name for');
  }
  for (const actor of ['lee', 'art'] as const) expect((await f.call('household/proposalPreview', { id }, actor)).status).toBe(403);
});

it('says on the card, before anyone presses Allow, why it cannot be allowed and what would fix it; Allow refuses the same', async () => {
  const f = fixture(), at = new Date(f.clock.now()).toISOString();
  const outside = { platform: 'slack', workspace: 'T1', user: 'U1' };
  const file = async (change: string, input: unknown, by: 'art' | 'sam' = 'art') => { const filed = await f.call('household/propose', { change, input, why: 'Asked' }, by); expect(filed.body, change + ' ' + JSON.stringify(input)).toMatchObject({ ok: true }); return filed.body.value!.id; };
  const allow = (id: string) => f.call('approvals/answer', { id, answer: 'allow', confirm: true }, 'sam');
  const blocked = async (id: string) => (await preview(f, id)).blocked;
  /** Blocked on the card in these words, refused by Allow, and still there to deny. */
  const stands = async (id: string, words: RegExp) => {
    expect(await blocked(id)).toMatch(words);
    expect((await allow(id)).body.ok).toBe(false);
    expect(f.db.select().from(approvals).where(eq(approvals.id, id)).get()).toMatchObject({ state: 'pending' });
  };
  const deny = async (id: string) => expect((await f.call('approvals/answer', { id, answer: 'deny' }, 'sam')).body.ok).toBe(true);
  expect((await allow(await file('project', pond))).body.ok).toBe(true);
  expect((await allow(await file('kit', { agent: 'art', kit: 'tools', tools: [] }))).body.ok).toBe(true);
  const grant = { agent: 'art', kit: 'tools', to: outside, grant: true };

  // The account is not placed with the agent: no owner has given it a tier.
  const unplaced = await file('kitGrant', grant);
  const kitState = f.db.select().from(agentKits).where(eq(agentKits.kit,'tools')).get()!;
  f.db.delete(agentKits).where(eq(agentKits.kit,'tools')).run();
  expect(await blocked(unplaced)).toMatch(/does not know this account as an outside contact/);
  f.db.insert(agentKits).values(kitState).run();
  await stands(unplaced, /^This cannot be allowed yet: Art does not know this account as an outside contact\./);
  expect((await allow(unplaced)).body.message).toBe('Choose an outside account already known to the agent or household');
  f.db.insert(agentPeople).values({ agent: 'art', person: JSON.stringify(['slack', 'T1', 'U1']), tier: 2 }).run();
  const records=()=>JSON.stringify([f.db.select().from(approvals).all(),f.db.select().from(approvalRecord).all(),f.db.select().from(inbox).all()]);
  const initial=records();
  const refreshed=await preview(f,unplaced);
  expect(await preview(f,unplaced)).toEqual(refreshed);
  expect(records()).toBe(initial);
  for(const actor of ['art','lee'] as const)expect((await f.call('approvals/answer',{id:unplaced,answer:'allow',review:refreshed.review},actor)).status).toBe(403);
  expect(refreshed.blocked).toBeNull();
  expect(refreshed.review).toMatch(/^[a-f0-9]{64}$/);
  expect((await allow(unplaced)).body.message).toMatch(/changed since the card was filed/);
  const reviewed=(review:string)=>f.call('approvals/answer',{id:unplaced,answer:'allow',review},'sam');
  expect((await reviewed('0'.repeat(64))).body.ok).toBe(false);
  f.db.delete(agentPeople).run();
  expect((await reviewed(refreshed.review!)).body.ok).toBe(false);
  expect((await preview(f,unplaced)).review).toBeUndefined();
  f.db.insert(agentPeople).values({agent:'art',person:JSON.stringify(['slack','T1','U1']),tier:2}).run();
  const input={id:unplaced,answer:'allow',review:(await preview(f,unplaced)).review};
  expect((await f.call('approvals/answer',input,'sam','owner-review-retry')).body.ok).toBe(true);
  const settled=records();
  expect((await f.call('approvals/answer',input,'sam','owner-review-retry')).body.ok).toBe(true);
  expect(records()).toBe(settled);
  expect(f.db.select().from(approvals).where(eq(approvals.id,unplaced)).get()?.state).toBe('used');
  expect((await allow(await file('kitGrant', { ...grant, grant: false }))).body.ok).toBe(true);

  // The account is linked to a member: the member should be named instead. With the link gone a fresh card is clear.
  f.db.insert(bridgePeople).values({ ...outside, member: 'lee' }).run();
  const linked = await file('kitGrant', grant);
  await stands(linked, /^This cannot be allowed: this account is linked to the household member lee\. Deny this card, and ask for the kit to be granted to the member lee instead\.$/);
  await deny(linked);
  const roster = await file('projectOutsidePerson', { project: 'pond', ...outside, on: true });
  await stands(roster, /linked to the household member lee\. Deny this card, and ask for lee to be put on the project as a member instead\.$/);
  await deny(roster);
  f.db.delete(bridgePeople).run();
  const clear = await file('kitGrant', grant);
  expect(await blocked(clear)).toBeNull();
  expect((await allow(clear)).body.ok).toBe(true);

  // Already so.
  await stands(await file('kitGrant', grant), /^This cannot be allowed: it is already so, and nothing would change\. Deny it\.$/);
  // No such kit, a project that is not in use, a person who is no member, an agent that is removed.
  await stands(await file('kitGrant', { agent: 'art', kit: 'missing', to: { member: 'lee' }, grant: true }), /Art has no kit called missing\. The kit would have to be defined first\./);
  await stands(await file('kitGrant', { agent: 'art', kit: 'tools', to: { project: 'nowhere' }, grant: true }), /the project nowhere is not in use/);
  await stands(await file('kitGrant', { agent: 'art', kit: 'tools', to: { member: 'ghost' }, grant: true }), /Ghost is not a member of the household now/);
  const marks = await file('kit', { agent: 'mark', kit: 'tools', tools: [] }, 'sam');
  expect(await blocked(marks)).toBeNull();
  f.db.update(agents).set({ removedAt: at }).where(eq(agents.id, 'mark')).run();
  expect(await blocked(marks)).toMatch(/not an agent in the household/);
  await deny(marks);
  // Filed while the agent is removed, it says so; restored, a fresh card is clear.
  const removed = await file('kit', { agent: 'mark', kit: 'tools', tools: [] }, 'sam');
  await stands(removed, /^This cannot be allowed: Mark is not an agent in the household now\./);
  await deny(removed);
  f.db.update(agents).set({ removedAt: null }).where(eq(agents.id, 'mark')).run();
  expect(await blocked(await file('kit', { agent: 'mark', kit: 'tools', tools: [] }, 'sam'))).toBeNull();

  // Other kinds: what Allow would refuse, where reading alone can tell.
  await stands(await file('remove', { of: 'project', id: 'nowhere' }), /^This cannot be allowed as it stands: loom has no project by that name\.$/);
  await stands(await file('restore', { of: 'agent', id: 'art' }), /it is already so/);
  await stands(await file('models', { agent: 'art', models: ['no-such-model'] }), /^This cannot be allowed as it stands: Choose configured models\.$/);
  await stands(await file('bridge', { action: 'disconnect', id: 'nothing' }), /Unknown connection/);
  const already = await file('settings', { commsDays: f.root.services.household.settings().commsDays });
  await stands(already, /it is already so/);
  await deny(already);
  // A card that can be allowed says nothing against itself.
  expect(await blocked(await file('settings', { commsDays: 3 }))).toBeNull();
});

it.each([
  { action: 'removeChannel', platform: 'discord', workspace: 'G1', channel: 'C1' },
  { action: 'removePerson', platform: 'discord', workspace: 'G1', user: 'U1' },
])('accepts a bridge removal with no matching rule or link ($action)', async input => {
  const f = fixture();
  const id = (await f.call('household/propose', { change: 'bridge', input, why: 'Clean up' }, 'art')).body.value!.id;
  expect(await preview(f, id)).toMatchObject({ blocked: null, card: { nothing: true } });
  expect((await f.call('approvals/answer', { id, answer: 'allow' }, 'sam')).body.ok).toBe(true);
});

it('puts serialized older summaries in owner-only Exact request, including after the answer', async () => {
  const f = fixture();
  const id = (await f.call('household/propose', { change: 'settings', input: { commsDays: 7 }, why: 'Keep less' }, 'art')).body.value!.id;
  const summary = '{"saved":"private settings"}';
  f.db.update(approvals).set({ what: 'Saved title', changeSummary: summary, details: JSON.stringify({ change: 'fromTheFuture', after: {} }) }).where(eq(approvals.id,id)).run();
  const expected = { summary: '', problem: null, card: null, blocked: null, exact: JSON.stringify({ summary, input: {} }, null, 2) };
  expect(await preview(f, id)).toEqual(expected);
  expect((await f.call('household/proposalPreview', { id }, 'lee')).status).toBe(403);
  await f.call('approvals/answer', { id, answer: 'deny' }, 'sam');
  expect(await preview(f, id)).toEqual(expected);
});

it('shows the same full-owner roster that Allow assigns', async () => {
  const f = fixture();
  const input = { id: 'pat', role: 'owner', fullOwner: true, agents: [] };
  const id = (await f.call('household/propose', { change: 'member', input, why: 'Share ownership' }, 'art')).body.value!.id;
  expect((await preview(f,id)).card!.facts).toContainEqual({ label: 'Their agents', value: 'As a full owner they have every agent: Art, Mark' });
  f.db.insert(members).values({id:'pat',role:'member',joinedAt:new Date(f.clock.now()).toISOString()}).run();
  const first=(await preview(f,id)).review;
  expect(first).toBeTruthy();
  f.db.insert(agents).values({id:'fern',...visual}).run();
  expect((await f.call('approvals/answer',{id,answer:'allow',review:first},'sam')).body.ok).toBe(false);
  const updated=await preview(f,id);
  expect(JSON.parse(updated.card!.exact).allAgents).toEqual(['art','fern','mark']);
  expect((await f.call('approvals/answer',{id,answer:'allow',review:updated.review},'sam')).body.ok).toBe(true);
  expect(f.root.services.household.members().find(row=>row.id==='pat')?.agents).toEqual(['art','fern','mark']);
});

it.each(['projectRevive','restore'] as const)('holds a refreshed %s to the beneficiaries and definitions it reactivates',async change=>{
 const f=fixture(),at=new Date(f.clock.now()).toISOString();
 f.db.insert(projects).values({id:'garden',name:'Garden'}).run();
 f.db.insert(agentKits).values({agent:'art',kit:'garden-tools',tools:[]}).run();
 f.db.insert(agentKitProjects).values({agent:'art',kit:'garden-tools',project:'garden'}).run();
 const input=change==='restore'?{of:'project',id:'garden'}:{project:'garden'};
 const id=(await f.call('household/propose',{change,input,why:'Bring back the garden'},'art')).body.value!.id;
 f.db.update(projects).set(change==='restore'?{removedAt:at}:{retiredAt:at}).where(eq(projects.id,'garden')).run();
 const first=await preview(f,id);
 expect(JSON.parse(first.card!.exact).projectKitAccess.kits).toEqual([{agent:'art',kit:'garden-tools',tools:[]}]);
 const answer=(review:string)=>f.call('approvals/answer',{id,answer:'allow',review},'sam');
 f.db.insert(projectMembers).values({project:'garden',member:'lee'}).run();
 expect((await answer(first.review!)).body.code).toBe('conflict');
 const second=await preview(f,id);
 expect(JSON.parse(second.card!.exact).projectKitAccess.roster.members).toEqual(['lee']);
 f.db.delete(agentKitProjects).where(eq(agentKitProjects.project,'garden')).run();
 expect((await answer(second.review!)).body.code).toBe('conflict');
 expect(f.root.services.approvals.get(id).state).toBe('pending');
 expect((await answer((await preview(f,id)).review!)).body.ok).toBe(true);
});

it('caps the whole Exact request even when individual values fit', async () => {
  const f = fixture();
  const input = { ...pond, members: ['lee', 'sam'], repositories: Array.from({ length: 30 }, (_, i) => 'github:house/' + String(i).padStart(2, '0') + 'x'.repeat(1700)) };
  const id = (await f.call('household/propose', { change: 'project', input, why: 'Track repositories' }, 'art')).body.value!.id;
  const exact = (await preview(f, id)).card!.exact;
  expect(exact.length).toBeLessThanOrEqual(40_000);
  expect(exact).toContain('Display clipped.');
  expect(JSON.parse(f.db.select().from(approvals).where(eq(approvals.id, id)).get()!.details).after).toEqual(input);
});

it('files, reads, previews and answers a project card with a 5,000-character repository reference', async () => {
  const f = fixture();
  const input = { ...pond, members: ['lee', 'sam'], repositories: ['github:house/' + 'x'.repeat(4987)] };
  const file = () => f.call('household/propose', { change: 'project', input, why: 'Track repository' }, 'art');
  const answer = (id: string, answer: 'allow' | 'deny') => f.call('approvals/answer', { id, answer }, 'sam');
  const filed = await file();
  expect(filed.body.ok).toBe(true);
  const id = filed.body.value!.id;
  expect((await look(f, id)).problem).toBeNull();
  const pending = await preview(f, id);
  expect(pending.card!.facts.find(fact => fact.label === 'Repositories')?.value).toMatch(/…\(\+\d+ more characters\)$/u);
  const [display, notice] = pending.card!.exact.split('\n\n');
  expect(notice).toContain('Display clipped.');
  const [repository] = JSON.parse(display!).repositories as string[];
  expect(repository.length).toBeLessThanOrEqual(2_000);
  const suffix = repository.match(/…\(\+(\d+) more characters\)$/u)!;
  expect(suffix.index! + Number(suffix[1])).toBe(5_000);
  expect(JSON.parse(f.db.select().from(approvals).where(eq(approvals.id, id)).get()!.details).after).toEqual(input);
  expect((await answer(id, 'allow')).body.ok).toBe(true);
  const done = await preview(f, id);
  expect(done).toMatchObject({ exact: pending.card!.exact, card: null, blocked: null });
  expect((await f.call('household/proposalPreview', { id }, 'lee')).status).toBe(403);
  const next = await file();
  expect((await answer(next.body.value!.id, 'deny')).body.ok).toBe(true);
});

it('rewrites a pre-digest project card with a 5,000-character repository reference', async () => {
  const f = fixture(), at = new Date(f.clock.now()).toISOString();
  const input = { ...pond, members: ['lee', 'sam'], repositories: ['github:house/' + 'x'.repeat(4987)] };
  f.db.insert(approvals).values({ id: 'old-project', kind: 'setting', operation: 'household.change',
    target: 'household:project:pond', state: 'pending', agent: 'art', askedFrom: 'terminal', actingFor: 'unknown',
    minutes: 30, askedAt: at, what: 'Change Pond', changeSummary: 'Old roster', why: 'Track repository',
    ask: 'Change Pond?', ifYes: 'Apply it', ifNo: 'Keep it', details: JSON.stringify({ change: 'project', before: { members: ['private-roster'] }, after: input }),
  }).run();
  await f.root.close();
  const second = sharedRoot({ db: f.db, clock: f.clock, originAllowed: () => true, reportError: () => {} });
  clean.push(() => second.close());
  const row = f.db.select().from(approvals).where(eq(approvals.id, 'old-project')).get()!;
  expect(JSON.parse(row.details)).toEqual({ change: 'project', after: input, seal: { nonce: expect.any(String), digest: expect.any(String) } });
  expect(row.changeSummary).not.toContain('Old roster');
});

it.each(['','empty'])('shows the exact stored secret description %j', async description => {
  const f = fixture();
  const id = (await f.call('household/propose', { change: 'secretDescription', input: { secret: 'key', description }, why: 'Update description' }, 'art')).body.value!.id;
  expect(JSON.parse((await preview(f,id)).card!.exact)).toEqual({ secret: 'key', description });
});

it('refuses the owner preview to a body working on a conversation card', async () => {
  const { bodyFixture, bodyCredentials } = await import('../test/fixtures/conversation-body.js');
  const f = await bodyFixture(clean);
  const at = new Date(f.clock.now()).toISOString();
  f.db.insert(members).values({ id: 'sam', role: 'owner', joinedAt: at }).run();
  const card = f.root.writes.run(() => f.root.services.setup.propose('art', {
    change: 'settings', input: { commsDays: 7 }, why: 'Keep less',
  }, { conversation: f.thread.conversation, member: null, project: 'pond' })).value;
  const headers = { 'content-type': 'application/json', authorization: 'Bearer ' + bodyCredentials.body };
  const visible = await f.root.http.request('/graphql', { method: 'POST', headers,
    body: JSON.stringify({ query: '{ approvals { id } }' }) });
  expect(await visible.json()).toMatchObject({ data: { approvals: [{ id: card.id }] } });
  const preview = await f.root.http.request('/api/household/proposalPreview', { method: 'POST', headers,
    body: JSON.stringify({ input: { id: card.id } }) });
  expect(preview.status).toBe(403);
});

it('reads a filed repeating schedule in plain facts and keeps the arrays in Exact request', async () => {
  const f = fixture();
  const trigger = { id: 'daily', ownerKind: 'agent', owner: 'art', sourceKind: 'time', targetKind: 'inbox',
    toKind: 'agent', to: 'art', conversation: 'cv-pond', times: '09:00', lifespan: 'until-stopped',
    note: 'Daily reading', needs: ['gpu', 'local'], prefers: ['fast'] };
  const ask = { action: 'set', agent: 'art', conversation: 'cv-pond', place: '#pond', asker: { kind: 'member', id: 'lee' }, trigger };
  const card = f.root.writes.run(() => f.root.services.setup.propose('art', { change: 'placeSchedule', input: ask, why: 'Daily check' })).value;
  const given = await preview(f, card.id);
  expect(given.card!.title).toBe('Set a repeating schedule for Art in conversation cv-pond');
  expect(given.card!.facts).toEqual(expect.arrayContaining([
    { label: 'Machine needs', value: 'gpu, local' },
    { label: 'Machine preferences', value: 'fast' },
  ]));
  expect(JSON.parse(given.card!.exact)).toEqual(ask);
});


// The origin/next apply guard. Supply the same database state and observe whether it reaches the write.
type Change = Parameters<typeof applyKitChange>[1];
function upstreamApplyKitChange(db:DataDatabase,value:Change,rows:(db:DataDatabase,value:Change)=>{state:ReturnType<typeof kitBefore>;apply():void}) {
  const {state,apply}=rows(db,value);
  const adding=value.change==='kit'?value.input.tools!==null:value.change==='kitGrant'?value.input.grant:value.input.on;
  if(adding){
    if('agentLive' in state && !state.agentLive)throw new OperationError('invalid','Choose a live agent');
    if('project' in state && (!state.project || state.project.removed || state.project.retired))throw new OperationError('invalid','Choose a project in use');
    if('memberLive' in state && !state.memberLive)throw new OperationError('invalid','Choose a live member');
    if('linked' in state && state.linked)throw new OperationError('invalid','This account is linked to a member. Name the member instead.');
    if('known' in state && !state.known)throw new OperationError('invalid','Choose an outside account already known to the agent or household');
    if(value.change==='kitGrant' && 'tools' in state && !state.tools)throw new OperationError('invalid','No such kit');
  }
  if(('on' in state && state.on===adding)||(value.change==='kit' && 'tools' in state && JSON.stringify(state.tools)===JSON.stringify(value.input.tools)))
    throw new OperationError('conflict','That is how it already is');
  apply();
}

it('matches the upstream kit apply guard for every refusal and allowed change', () => {
  const f = fixture(), at = new Date(f.clock.now()).toISOString();
  const key = { agent: 'art', kit: 'tools' };
  const to = { platform: 'slack' as const, workspace: 'T1', user: 'U1' };
  f.root.services.projects.save({ ...pond, id: 'live' });
  f.root.services.projects.save({ ...pond, id: 'retired' });
  f.root.services.projects.setRetired({ project: 'retired' }, true);
  f.db.update(agents).set({ removedAt: at }).where(eq(agents.id, 'mark')).run();
  f.db.insert(agentKits).values({ ...key, tools: [] }).run();
  f.db.insert(agentKitMembers).values({ ...key, member: 'lee' }).run();
  f.db.insert(bridgePeople).values({ ...to, member: 'lee' }).run();
  const grant = (recipient: Extract<Change, {change:'kitGrant'}>['input']['to'], adding = true): Change =>
    ({ change: 'kitGrant', input: { ...key, to: recipient, grant: adding } });
  const rows: [string, Change, string | null][] = [
    ['dead agent', { change: 'kit', input: { ...key, agent: 'mark', tools: [] } }, 'invalid'],
    ['missing project', grant({ project: 'missing' }), 'invalid'],
    ['retired project', grant({ project: 'retired' }), 'invalid'],
    ['missing member', grant({ member: 'missing' }), 'invalid'],
    ['linked account takes precedence over unknown', grant(to), 'invalid'],
    ['unknown account', grant({ ...to, user: 'U2' }), 'invalid'],
    ['missing kit', { change: 'kitGrant', input: { ...key, kit: 'missing', to: { member: 'lee' }, grant: true } }, 'invalid'],
    ['existing grant', grant({ member: 'lee' }), 'conflict'],
    ['absent grant', grant({ member: 'sam' }, false), 'conflict'],
    ['unchanged tools', { change: 'kit', input: { ...key, tools: [] } }, 'conflict'],
    ['new grant', grant({ project: 'live' }), null],
    ['withdraw existing grant', grant({ member: 'lee' }, false), null],
    ['define kit', { change: 'kit', input: { ...key, kit: 'new', tools: [] } }, null],
    ['remove kit', { change: 'kit', input: { ...key, tools: null } }, null],
    ['add outside project person', { change: 'projectOutsidePerson', input: { ...to, user: 'known', project: 'live', on: true } }, null],
  ];
  f.db.insert(agentPeople).values({ agent: 'art', person: JSON.stringify(['slack', 'T1', 'known']), tier: 1 }).run();
  function outcome(apply: () => void) {
    try { apply(); return null; }
    catch (error) {
      if (!(error instanceof OperationError)) throw error;
      return { code: error.code, message: error.message };
    }
  }
  for (const [label, value, expectedCode] of rows) {
    let reachedWrite = false;
    const rows = (db: DataDatabase, change: Change) => ({ state: kitBefore(db, change), apply: () => { reachedWrite = true; } });
    const expected = outcome(() => upstreamApplyKitChange(f.db, value, rows));
    expect(expected?.code ?? null, label).toBe(expectedCode);
    expect(reachedWrite, label).toBe(expectedCode === null);
    expect(outcome(() => applyKitChange(f.db, value)), label).toEqual(expected);
  }
});
