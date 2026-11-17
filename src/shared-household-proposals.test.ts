import Database from 'better-sqlite3';
import { createHash } from 'node:crypto';
import { afterEach, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { FakeClock } from './core/clock.js';
import { createDataSchema } from './core/data/database.js';
import { agents, agentAccounts, agentBoxes, agentHouseSecrets, conversations, bridgeConnections, bridgeChannels, bridgePeople, household, measuringSettings, secretRuleAgents, secretRules, secrets, agentPeople, agentDeniedTools, agentRunSettings, approvals, boxAgents, boxes, memberAgents, members, sessions, tokens, projects } from './core/data/schema.js';
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
  expect((await look(f, first.body.value!.id)).problem).toBe('This has changed since the card was filed; ask for a fresh card');
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
  const filed = await propose('runSettings', run);
  expect(f.db.select().from(agentRunSettings).all()).toEqual([]);
  expect((await allow(filed.body.value!.id)).body.ok).toBe(true);
  expect(f.db.select().from(agentRunSettings).get()).toMatchObject({ agent: 'art', houseBranch: 'main', gpu: true });
  expect(f.db.select().from(agentBoxes).all()).toEqual([{ agent: 'art', box: 'box-1', position: 0 }]);
  await hopeless(f, await propose('runSettings', { ...run, boxes: ['no-such-box'] }));
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
  expect(f.db.select().from(bridgeChannels).all()).toEqual([{ platform: 'discord', workspace: 'pond', channel: 'general', answers: 'art', botsMayTalk: false }]);
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
  const root = sharedRoot({ db, clock, originAllowed: () => true, reportError: () => {} }); clean.push(() => root.close());
  for (const row of db.select().from(approvals).all()) {
    expect(row.details).not.toContain('before'); expect(row.what).not.toContain('→'); expect(row.changeSummary).not.toContain('→');
    expect(JSON.parse(row.details)).toMatchObject({ change: 'settings', after: expect.anything(), seal: { nonce: expect.any(String), digest: expect.any(String) } });
  }
  const answer = async (id: string) => (await (await root.http.request('http://loom/api/approvals/answer', { method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer '+credentials.sam }, body: JSON.stringify({ input: { id, answer: 'allow' }, id: 'allow-'+id }) })).json()) as { ok: boolean; code?: string };
  expect(await answer('a-moved')).toMatchObject({ ok: false, code: 'conflict' });
  expect(await answer('a-waiting')).toMatchObject({ ok: true });
  expect(db.select().from(household).get()).toMatchObject({ commsDays: 7 });
});
