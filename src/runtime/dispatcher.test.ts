import {testProgramPin} from './pinned-program.fixture.js';
import Database from 'better-sqlite3';
import { afterEach, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import { createDataSchema } from '../core/data/database.js';
import { Conversations } from '../core/conversations/index.js';
import { agents, members, triggers, programFirings, boxes, agentModels, agentBoxes, agentRunSettings, agentHousePorts, memberAgents, modelAccounts, modelAccountWindows, modelAccountBoxes, jobs, jobNeeds, boxFacts, agentPeople, agentDeniedTools, secrets, bridgeConnections, bridgeChannels, bridgePeople, conversations, inbox, threads } from '../core/data/schema.js';
import { BridgeIncoming } from '../pieces/bridges/incoming.js';
import { Dispatcher, UNHELD_NOTE } from './dispatcher.js';
import { LOOM_EXIT } from './job-exit.js';
import { harnessCannotRun } from './body-harnesses.js';
const opened: Database.Database[] = [];
afterEach(() => { for (const db of opened.splice(0)) db.close(); });
function fixture() {
  const client = new Database(':memory:'); opened.push(client);
  let at = '2026-11-14T20:00:00.000Z';
  const now = () => at, db = createDataSchema(client, now);
  db.insert(members).values({ id: 'owner', role: 'owner', joinedAt: at }).run();
  db.insert(agents).values({ id: 'art', about: '', markBg: '#000', markFg: '#fff', faceShape: 'pebble', faceEyes: 'dot' }).run();
  db.insert(memberAgents).values({ member: 'owner', agent: 'art' }).run();
  for (const id of ['first', 'second']) {
    db.insert(boxes).values({ id, name: id, owner: 'owner', sameMachineAsLoom: id === 'first', hostsAny: true, reportOnly: false, alwaysOn: false, enrolledAt: at, lastSeenAt: at }).run();
    db.insert(agentBoxes).values({ agent: 'art', box: id, position: id === 'first' ? 0 : 1 }).run();
  }
  db.insert(agentModels).values({ agent: 'art', model: 'primary', position: 0 }).run();
  db.insert(agentRunSettings).values({ agent: 'art', houseRepository: 'repo', houseFile: 'Housefile', houseBranch: 'main', nestedContainers: false, gpu: false }).run();
  db.insert(modelAccounts).values({ id: 'account', owner: 'owner', provider: 'provider', label: 'Subscription', hasRoom: true }).run();
  db.insert(modelAccountWindows).values({ account: 'account', window: 'week', usage: 0.2, usageReadAt: at, resetsAt: '2026-11-14T21:00:00.000Z', durationMs: 7 * 86400_000 }).run();
  db.insert(modelAccountBoxes).values([{ account: 'account', box: 'first' }, { account: 'account', box: 'second' }]).run();
  const roles = [{ model: 'primary', provider: 'provider', harness: 'codex', series: 'series' }];
  const runtime = new Dispatcher(db, now, () => roles, harnessCannotRun), comms = new Conversations(db, now);
  const conversation = comms.open({ agent: 'art', venue: 'loom', place: 'thread', label: 'Reply', member: 'owner' });
  const mail = comms.send({ toKind: 'agent', to: 'art', conversation: conversation.id, source: 'thread', fromKind: 'person', fromId: 'owner', words: 'Private brief' });
  const job = runtime.jobs.admit(conversation.id)!;
  const tick = (ms: number) => { at = new Date(Date.parse(at) + ms).toISOString(); };
  return { client, db, now, tick, runtime, comms, conversation, mail, job, roles };
}
it('claims only on the selected worker and delivers an execution-ready snapshot once', () => {
  const f = fixture();
  expect(f.runtime.next('second')).toBeUndefined();
  expect(f.runtime.next('first')).toEqual({ venue:'loom', thread:null, run: { nestedContainers: false, gpu: false, ports: [], policy: { deniedTools: [], people: [{ kind: 'person', person: 'owner', tier: null }], mail: [f.mail.id], word: 'owners' } }, id: f.job.id, box: 'first', agent: 'art', conversation: f.conversation.id,
    model: 'primary', account: 'account', accountChoices: 1, harness: 'codex', brief: '', house: { repository: 'repo', file: 'Housefile', branch: 'main' } });
  expect(f.runtime.next('first')).toBeUndefined();
  expect(f.runtime.next('second')).toBeUndefined();
  expect(f.runtime.jobs.get(f.job.id).state).toBe('starting');
});
it('connects worker acknowledgements and reports to receipts and terminal lifecycle', () => {
  const f = fixture(); f.runtime.next('first');
  expect(f.runtime.heartbeat('first', f.job.id, 'starting')).toEqual({ active: true });
  expect(f.runtime.started('first', f.job.id, 'image')).toEqual({ ok: true });
  expect(f.runtime.heartbeat('first', f.job.id, 'starting')).toEqual({ active: false });
  expect(f.runtime.heartbeat('first', f.job.id, 'running')).toEqual({ active: true });
  f.comms.take(f.conversation.id, f.job.id); f.comms.confirm(f.mail.id, f.job.id);
  expect(f.runtime.finish('first', f.job.id, 0, 'done').job).toMatchObject({ state: 'done', build: 'image', exitCode: 0 });
  expect(f.runtime.heartbeat('first', f.job.id, 'running')).toEqual({ active: false });
});
it('foreign worker reports cannot change the assigned job', () => {
  const f = fixture(); f.runtime.next('first');
  expect(f.runtime.heartbeat('second', f.job.id, 'starting')).toEqual({ active: false });
  expect(() => f.runtime.started('second', f.job.id, 'wrong')).toThrow();
  expect(() => f.runtime.finish('second', f.job.id, 0, 'wrong')).toThrow();
  expect(f.runtime.jobs.get(f.job.id)).toMatchObject({ state: 'starting', box: 'first', build: null });
});
it('polls refresh health while idle/report-only and revoked workers cannot claim', () => {
  const f = fixture(); f.tick(30_000);
  f.db.update(boxes).set({ reportOnly: true }).where(eq(boxes.id, 'first')).run();
  expect(f.runtime.next('first')).toBeUndefined();
  expect(f.db.select().from(boxes).where(eq(boxes.id, 'first')).get()?.lastSeenAt).toBe(f.now());
  expect(f.runtime.jobs.get(f.job.id).state).toBe('queued');
  f.db.update(boxes).set({ revokedAt: f.now() }).where(eq(boxes.id, 'first')).run();
  expect(() => f.runtime.next('first')).toThrow('Machine not available');
});
it('start retries respect backoff and preserve house snapshots through the dispatcher', () => {
  const f = fixture(); f.runtime.next('first');
  const retry = f.runtime.finish('first', f.job.id, 1, 'launch failed').retry!;
  f.db.update(agentRunSettings).set({ houseFile: 'Changed' }).run();
  expect(f.runtime.next('first')).toBeUndefined();
  f.tick(1_000);
  expect(f.runtime.next('first')).toMatchObject({ id: retry.id, house: { file: 'Housefile' } });
});
it('current capacity can select the next allowed model and records that worker request', () => {
  const f = fixture();
  f.db.update(modelAccounts).set({ hasRoom: false }).run();
  f.db.insert(agentModels).values({ agent: 'art', model: 'fallback', position: 1 }).run();
  f.roles.push({ model: 'fallback', provider: 'other', harness: 'claude', series: 'other-series' });
  f.db.insert(modelAccounts).values({ id: 'other', owner: 'owner', provider: 'other', label: 'Other subscription', hasRoom: true }).run();
  f.db.insert(modelAccountWindows).values({ account: 'other', window: 'week', usage: 0.2, usageReadAt: f.now(), resetsAt: '2026-11-14T21:00:00.000Z', durationMs: 7 * 86400_000 }).run();
  f.db.insert(modelAccountBoxes).values({ account: 'other', box: 'first' }).run();
  expect(f.runtime.next('first')).toMatchObject({ model: 'fallback', account: 'other', harness: 'claude' });
  expect(f.db.select().from(jobs).where(eq(jobs.id, f.job.id)).get()?.model).toBe('fallback');
});
it('a failed placement leaves the job queued and never releases its brief', () => {
  const f = fixture(); f.db.update(modelAccounts).set({ hasRoom: false }).run();
  expect(f.runtime.next('first')).toBeUndefined();
  expect(f.runtime.jobs.get(f.job.id)).toMatchObject({ box: null, state: 'queued', claimedAt: null });
});
it('keeps machine health when a report rejects, without changing the foreign or ended job', () => {
  const f = fixture(); f.runtime.next('first'); f.tick(10_000);
  expect(() => f.runtime.started('second', f.job.id, 'wrong')).toThrow();
  expect(f.db.select().from(boxes).where(eq(boxes.id, 'second')).get()?.lastSeenAt).toBe(f.now());
  f.runtime.started('first', f.job.id, 'image'); f.runtime.finish('first', f.job.id, 0, 'done'); f.tick(10_000);
  expect(() => f.runtime.finish('first', f.job.id, 0, 'duplicate')).toThrow();
  expect(f.db.select().from(boxes).where(eq(boxes.id, 'first')).get()?.lastSeenAt).toBe(f.now());
  expect(f.runtime.jobs.get(f.job.id)).toMatchObject({ state: 'done', logTail: null });
});
it('refreshes health on every successful phase report', () => {
  const f = fixture(); f.runtime.next('first');
  const health = () => f.db.select().from(boxes).where(eq(boxes.id, 'first')).get()?.lastSeenAt;
  f.tick(10_000); f.runtime.started('first', f.job.id, 'image'); expect(health()).toBe(f.now());
  f.tick(10_000); f.runtime.heartbeat('first', f.job.id, 'running'); expect(health()).toBe(f.now());
  f.tick(10_000); f.runtime.finish('first', f.job.id, 0, 'done'); expect(health()).toBe(f.now());
});
it('holds the same transaction across placement reads and claim', () => {
  const f = fixture();
  const runtime = new Dispatcher(f.db, f.now, () => { expect(f.client.inTransaction).toBe(true); return f.roles; }, harnessCannotRun);
  const claim = runtime.jobs.claim.bind(runtime.jobs);
  const observed = vi.spyOn(runtime.jobs, 'claim').mockImplementation((...args) => { expect(f.client.inTransaction).toBe(true); return claim(...args); });
  expect(runtime.next('first')?.id).toBe(f.job.id);
  expect(observed).toHaveBeenCalledOnce();
});
it('forwards required capabilities and bypasses an ineligible preferred worker', () => {
  const f = fixture();
  f.db.insert(jobNeeds).values({ job: f.job.id, need: 'gpu:5090' }).run();
  f.db.insert(boxFacts).values({ box: 'second', fact: 'gpu:5090', fromOwner: false }).run();
  expect(f.runtime.next('first')).toBeUndefined();
  expect(f.runtime.next('second')?.id).toBe(f.job.id);
});
it('revocation rejects all phase reports for an already assigned worker', () => {
  const f = fixture(); f.runtime.next('first');
  f.db.update(boxes).set({ revokedAt: f.now() }).where(eq(boxes.id, 'first')).run();
  expect(() => f.runtime.started('first', f.job.id, 'image')).toThrow('Machine not available');
  expect(() => f.runtime.heartbeat('first', f.job.id, 'starting')).toThrow('Machine not available');
  expect(() => f.runtime.finish('first', f.job.id, 1, 'stop')).toThrow('Machine not available');
  expect(f.runtime.jobs.get(f.job.id).state).toBe('starting');
});
it('keeps the trusted dispatch import graph free of process and credential I/O', async () => {
  const { readFile } = await import('node:fs/promises');
  const { dirname, resolve } = await import('node:path');
  const { fileURLToPath } = await import('node:url');
  const { init, parse } = await import('es-module-lexer');
  await init();
  const seen = new Set<string>();
  const walk = async (path: string): Promise<void> => {
    if (seen.has(path)) return; seen.add(path);
    const source = await readFile(path, 'utf8');
    expect(source).not.toMatch(/\b(?:require|eval|fetch)\s*\(|\bprocess\s*\.\s*(?:env|getBuiltinModule|loadEnvFile|binding)\b/);
    for (const entry of parse(source)[0]) {
      if ('typeOnly' in entry && entry.typeOnly) continue;
      expect(entry.type).toBe('static');
      const name = entry.specifier!;
      if (name.startsWith('.')) await walk(resolve(dirname(path), name.replace(/\.js$/, '.ts')));
      else expect(['drizzle-orm', 'drizzle-orm/sqlite-core', 'node:crypto', 'zod']).toContain(name);
    }
  };
  await walk(fileURLToPath(new URL('./dispatcher.ts', import.meta.url)));
  expect(seen.size).toBeGreaterThan(1);
});

it('persists the selected account and harness on each attempt and clears them for queued retry', () => {
  const f = fixture();
  expect(f.runtime.jobs.get(f.job.id)).toMatchObject({ account: null, harness: null });
  const assignment = f.runtime.next('first')!;
  expect(f.runtime.jobs.get(f.job.id)).toMatchObject({ account: assignment.account, harness: assignment.harness });
  const result = f.runtime.finish('first', f.job.id, 1, 'start failed');
  expect(result.job).toMatchObject({ account: 'account', harness: 'codex' });
  expect(result.retry).toMatchObject({ account: null, harness: null });
  f.tick(1000); f.roles[0]!.harness = 'configured-next-runner';
  expect(f.runtime.next('first')?.harness).toBe('configured-next-runner');
  expect(f.runtime.jobs.get(result.retry!.id)).toMatchObject({ account: 'account', harness: 'configured-next-runner' });
  expect(f.runtime.jobs.get(f.job.id).harness).toBe('codex');
});

it('projects current agent capabilities and only its configured ports at claim', () => {
  const f = fixture();
  f.db.update(agentRunSettings).set({ nestedContainers: true, gpu: true }).run();
  f.db.insert(boxFacts).values({box:'first',fact:'gpu:5090',fromOwner:false}).run();
  f.db.insert(agentHousePorts).values([
    { agent: 'art', address: '127.0.0.1', port: 9000 },
    { agent: 'art', address: '127.0.0.1', port: 8000 },
  ]).run();
  const assignment = f.runtime.next('first')!;
  expect(assignment.run).toEqual({ nestedContainers: true, gpu: true,
    ports: [{ address: '127.0.0.1', port: 8000 }, { address: '127.0.0.1', port: 9000 }], policy: { deniedTools: [], people: [{ kind: 'person', person: 'owner', tier: null }], mail: [f.mail.id], word: 'owners' } });
  f.db.update(agentRunSettings).set({ nestedContainers: false }).run();
  expect(assignment.run.nestedContainers).toBe(true);
});

it('hands the configured outside tier and tool rules to the runner on actual claim', () => {
  const f = fixture();
  f.db.update(agentRunSettings).set({ nestedContainers: true }).run();
  f.runtime.jobs.stop(f.job.id, 'owner', 'write-off');
  f.db.insert(secrets).values({ name: 'bot', description: '', changedAt: f.now(), changedBy: 'owner' }).run();
  f.db.insert(bridgeConnections).values({ id: 'c', platform: 'discord', agent: 'art', workspace: 'w', botUser: 'bot-art', tokenSecret: 'bot', enabled: true, state: 'connected', stateAt: f.now() }).run();
  const person = JSON.stringify(['discord', 'w', 'outside']);
  f.db.insert(agentPeople).values({ agent: 'art', person, tier: 2 }).run();
  const incoming = new BridgeIncoming(f.db, f.now).receive({ id: 'm', connection: 'c', channel: 'room', isDm: true, user: 'outside', text: 'Work', postedAt: f.now(), mentions: [] });
  const job = f.runtime.jobs.admit(incoming.conversation!)!;
  f.db.insert(agentDeniedTools).values([{ agent: 'art', pattern: 'always', guestsOnly: false }, { agent: 'art', pattern: 'guests', guestsOnly: true }]).run();
  // The job works on anybody else's word, so it runs with loom's tools only. The fixture's model runs on Codex,
  // which always has a shell, and the agent has no other: the job is ended at once and says why, rather than
  // wait a day for a machine that will never take it.
  expect(f.runtime.next('first')).toBeUndefined();
  expect(f.runtime.jobs.get(job.id)).toMatchObject({ state: 'failed', exitCode: LOOM_EXIT.unplaced, exitBy: 'loom', endedNote: UNHELD_NOTE });
  expect(UNHELD_NOTE).toBe('Never started: this job is not working for the agent\'s owners, so it runs with loom\'s tools only, and every model the agent has runs on a harness that always has a shell. Give the agent a model that runs on Claude Code.');
  // Its mail is closed with that reason, so it starts nothing again; the next message does, and on a harness that can be held the job is claimed with the rules.
  expect(f.db.select().from(inbox).where(eq(inbox.job, job.id)).all()).toMatchObject([{ state: 'resolved', resolution: UNHELD_NOTE }]);
  expect(f.runtime.jobs.admit(incoming.conversation!)).toBeUndefined();
  f.roles[0].harness = 'claude';
  new BridgeIncoming(f.db, f.now).receive({ id: 'm2', connection: 'c', channel: 'room', isDm: true, user: 'outside', text: 'Again', postedAt: f.now(), mentions: [] });
  f.db.update(conversations).set({label:'Discord channel #old-title'}).where(eq(conversations.id,incoming.conversation!)).run();
  const second = f.runtime.jobs.admit(incoming.conversation!)!, assignment = f.runtime.next('first')!;
  expect(assignment.id).toBe(second.id);
  expect(assignment.venueDescription).toBe('Discord direct message with outside');
  expect(assignment.run.nestedContainers).toBe(true);
  expect(assignment.run.policy).toEqual({ people: [{ kind: 'outside', person, tier: 2 }], deniedTools: [{ pattern: 'always', guestsOnly: false }, { pattern: 'guests', guestsOnly: true }], mail: f.db.select().from(inbox).where(eq(inbox.job, second.id)).all().map(item => item.id).sort(), word: 'others' });
  // The message the ended job never answered was closed with it, and is not carried into this one.
  expect(assignment.run.policy!.mail).toHaveLength(1);
  // An owners' job that no harness can run for another reason (a denied tool, on Codex) waits as before: a setting may change.
  f.roles[0].harness = 'codex'; f.runtime.jobs.stop(second.id, 'owner', 'write-off');
  const thread = f.comms.open({ agent: 'art', venue: 'loom', place: 'owners-thread', label: 'thread', member: 'owner' });
  f.comms.send({ toKind: 'agent', to: 'art', conversation: thread.id, source: 'thread', fromKind: 'person', fromId: 'owner', words: 'Owner work' });
  const own = f.runtime.jobs.admit(thread.id)!;
  expect(f.runtime.next('first')).toBeUndefined(); expect(f.runtime.jobs.get(own.id).state).toBe('queued');
});
it('settles the mail of a job no harness can hold, so an owner\'s next message there starts an owners\' job that runs', () => {
  const f = fixture(); f.runtime.jobs.stop(f.job.id, 'owner', 'write-off');
  f.db.insert(secrets).values({ name: 'bot', description: '', changedAt: f.now(), changedBy: 'owner' }).run();
  f.db.insert(bridgeConnections).values({ id: 'c', platform: 'discord', agent: 'art', workspace: 'w', botUser: 'bot-art', tokenSecret: 'bot', enabled: true, state: 'connected', stateAt: f.now() }).run();
  f.db.insert(bridgeChannels).values({ platform: 'discord', workspace: 'w', channel: 'room', answers: 'art', botsMayTalk: false }).run();
  f.db.insert(bridgePeople).values({ platform: 'discord', workspace: 'w', user: 'owner-there', member: 'owner' }).run();
  f.db.insert(agentPeople).values({ agent: 'art', person: JSON.stringify(['discord', 'w', 'outside']), tier: 2 }).run();
  const hear = (id: string, user: string) => new BridgeIncoming(f.db, f.now).receive({ id, connection: 'c', channel: 'room', isDm: false, user, text: 'Work', postedAt: f.now(), mentions: ['bot-art'] });
  // The agent's only model runs on Codex. A guest writes in a shared place: no harness can hold the job, and it is ended with the plain note.
  const guest = hear('m1', 'outside'); expect(guest.state).toBe('delivered');
  const first = f.runtime.jobs.admit(guest.conversation!)!;
  expect(f.runtime.next('first')).toBeUndefined();
  expect(f.runtime.jobs.get(first.id)).toMatchObject({ state: 'failed', endedNote: UNHELD_NOTE });
  // The mail that made it anybody else's is closed with that reason: it is carried into no later job.
  expect(f.db.select().from(inbox).where(eq(inbox.conversation, guest.conversation!)).all()).toMatchObject([{ state: 'resolved', resolution: UNHELD_NOTE }]);
  // An owner writes in the same conversation: that job works on owners' word and is placed.
  const owner = hear('m2', 'owner-there'); expect(owner.conversation).toBe(guest.conversation);
  const second = f.runtime.jobs.admit(owner.conversation!)!, assignment = f.runtime.next('first')!;
  expect(assignment).toMatchObject({ id: second.id, harness: 'codex' });
  expect(assignment.run.policy.word).toBe('owners');
  expect(assignment.run.policy.mail).toHaveLength(1);
});
it('passes over a model whose harness would refuse the job for the agent\'s next allowed model', () => {
  const f = fixture();
  f.db.insert(agentModels).values({ agent: 'art', model: 'second-choice', position: 1 }).run();
  f.roles.push({ model: 'second-choice', provider: 'provider', harness: 'claude', series: 'series' });
  f.db.insert(agentDeniedTools).values({ agent: 'art', pattern: 'Bash(*)', guestsOnly: false }).run();
  expect(f.runtime.next('first')).toMatchObject({ id: f.job.id, model: 'second-choice', harness: 'claude' });
});

it('reads tool and person policy within the same placement and claim transaction', () => {
  const f = fixture(), prepare = f.client.prepare.bind(f.client);
  let policyReads = 0;
  vi.spyOn(f.client, 'prepare').mockImplementation((sql: string) => {
    if (sql.includes('"agent_denied_tools"') || sql.includes('"agent_people"')) {
      policyReads++; expect(f.client.inTransaction).toBe(true);
    }
    return prepare(sql);
  });
  expect(f.runtime.next('first')?.id).toBe(f.job.id);
  // The tool list is always read; a tier is read only for mail from an outside account, and this mail has none.
  expect(policyReads).toBeGreaterThanOrEqual(1);
});

it('never hands a legacy private brief to the worker while preserving the old record', () => {
  const f = fixture(); f.db.update(jobs).set({ brief: 'LEGACY_PRIVATE_WORDS' }).where(eq(jobs.id, f.job.id)).run();
  const assignment = f.runtime.next('first')!;
  expect(assignment.id).toBe(f.job.id); expect(assignment.brief).toBe('');
  expect(f.runtime.jobs.get(f.job.id).brief).toBe('LEGACY_PRIVATE_WORDS');
});

it('passes ordinary wake instructions through the worker assignment', () => {
  const f = fixture(); f.runtime.jobs.stop(f.job.id, 'owner', 'write-off');
  const conversation = f.comms.open({ agent: 'art', venue: 'wake', place: f.job.id, label: 'Wake' });
  f.comms.send({ toKind: 'agent', to: 'art', conversation: conversation.id, source: 'trigger', fromKind: 'schedule', words: 'Public wake instructions' });
  const job = f.runtime.jobs.admit(conversation.id)!;
  expect(f.runtime.next('first')).toMatchObject({ id: job.id, brief: 'Public wake instructions' });
});
it('passes unbound instructions through the worker assignment', () => {
  const f = fixture(); f.db.update(jobs).set({ conversation: null, brief: 'Unbound instructions' }).where(eq(jobs.id, f.job.id)).run();
  expect(f.runtime.next('first')).toMatchObject({ id: f.job.id, conversation: null, brief: 'Unbound instructions' });
});

it('takes a running job\'s pulse only from the machine that holds it, and moves the job nowhere', () => {
  const f = fixture(); f.runtime.next('first'); f.runtime.started('first', f.job.id, 'image');
  f.tick(15_000);
  expect(f.runtime.heartbeat('first', f.job.id, 'running')).toEqual({ active: true });
  expect(f.runtime.jobs.get(f.job.id)).toMatchObject({ state: 'running', heardAt: f.now() });
  expect(f.db.select().from(boxes).where(eq(boxes.id, 'first')).get()?.lastSeenAt).toBe(f.now());
  expect(f.runtime.heartbeat('second', f.job.id, 'running')).toEqual({ active: false });
  // A pulse that names a state the job is not in is not this job's pulse.
  expect(f.runtime.heartbeat('first', f.job.id, 'starting')).toEqual({ active: false });
  expect(f.runtime.jobs.get(f.job.id).state).toBe('running');
});

it.each(['discord','slack'] as const)('includes the saved %s receiving venue without pretending it is a Comms thread',venue=>{
 const f=fixture();f.db.update(conversations).set({venue}).where(eq(conversations.id,f.conversation.id)).run();const claimed=f.runtime.next('first');expect(claimed).toMatchObject({venue,thread:null,conversation:f.conversation.id});
});
it('places a lane\'s work on what its trigger wants, read when the job is placed', () => {
  const f = fixture();
  f.db.insert(agentModels).values({ agent: 'art', model: 'clever', position: 1 }).run();
  f.roles.splice(0, 1, { model: 'primary', provider: 'provider', harness: 'codex', series: 'series', tag: 'normal' } as never, { model: 'clever', provider: 'provider', harness: 'claude', series: 'series', tag: 'best' } as never);
  f.db.insert(triggers).values({ id: 'tr-lane', ownerKind: 'agent', owner: 'art', sourceKind: 'time', times: '03:13', lifespan: 'until-stopped', targetKind: 'inbox', toKind: 'agent', to: 'art', note: 'Lane', enabled: true, state: 'standing', createdAt: f.now(), changedAt: f.now(), wantsModel: 'low' }).run();
  const wake = f.comms.open({ agent: 'art', venue: 'wake', place: 'tr-lane', label: 'Lane' });
  f.comms.send({ toKind: 'agent', to: 'art', conversation: wake.id, source: 'trigger', sourceId: 'tr-lane:1', fromKind: 'schedule', words: 'Do the lane' });
  const lane = f.runtime.jobs.admit(wake.id)!;
  // The ordinary conversation's job goes first, on the agent's own order.
  expect(f.runtime.next('first')).toMatchObject({ id: f.job.id, model: 'primary' });
  // Nothing the agent may use carries "low": the lane's work waits, it does not run on something else.
  expect(f.runtime.next('first')).toBeUndefined(); expect(f.runtime.jobs.get(lane.id).state).toBe('queued');
  // The lane is edited to want the best model: the waiting job is placed on it.
  f.db.update(triggers).set({ wantsModel: 'best' }).where(eq(triggers.id, 'tr-lane')).run();
  expect(f.runtime.next('first')).toMatchObject({ id: lane.id, model: 'clever', harness: 'claude', venue: 'wake' });
});

it('ends a job it is still preparing when a Comms Stop is waiting at its heartbeat, and leaves a running body\'s Stop to the body', () => {
  const stop = (f: ReturnType<typeof fixture>) => f.db.insert(threads).values({ id: 'th', conversation: f.conversation.id, title: 'Reply', titledBy: 'member', pinned: false, openedAt: f.now(), lastAt: f.now(), readSeq: 0, working: true, workingSince: f.now(), workingBeat: f.now(), stopRequested: true }).run();
  const f = fixture(); f.runtime.next('first'); stop(f);
  expect(f.runtime.heartbeat('first', f.job.id, 'starting')).toEqual({ active: false, stopped: true });
  expect(f.runtime.jobs.get(f.job.id)).toMatchObject({ state: 'stopped', endedBy: 'owner', endedReason: 'stop' });
  expect(f.db.select().from(threads).get()).toMatchObject({ stopRequested: false, working: false });
  expect(f.db.select().from(inbox).get()).toMatchObject({ state: 'waiting', job: f.job.id });
  expect(f.runtime.jobs.admit(f.conversation.id)).toBeUndefined();
  const running = fixture(); running.runtime.next('first'); running.runtime.started('first', running.job.id, 'image'); stop(running);
  expect(running.runtime.heartbeat('first', running.job.id, 'running')).toEqual({ active: true });
  expect(running.runtime.jobs.get(running.job.id).state).toBe('running');
  expect(running.db.select().from(threads).get()?.stopRequested).toBe(true);
  // The body notices, leaves with the stopped exit, and the worker's report ends the job the same way.
  expect(running.runtime.finish('first', running.job.id, 10, '').job).toMatchObject({ state: 'stopped', endedBy: 'owner', endedReason: 'stop' });
  expect(running.db.select().from(threads).get()?.stopRequested).toBe(false);
});
it('takes the facts a worker reports with its poll, keeps them when a poll names none, and clears them on an empty list', () => {
  const f = fixture(); f.runtime.jobs.stop(f.job.id, 'owner', 'reset'); f.tick(1000);
  expect(f.runtime.next('first', ['gpu:5090'])).toBeUndefined();
  expect(f.db.select().from(boxFacts).all()).toEqual([{ box: 'first', fact: 'gpu:5090', fromOwner: false }]);
  expect(f.db.select().from(boxes).where(eq(boxes.id, 'first')).get()?.lastSeenAt).toBe(f.now());
  f.runtime.next('first'); expect(f.db.select().from(boxFacts).all()).toHaveLength(1);
  f.runtime.next('first', []); expect(f.db.select().from(boxFacts).all()).toEqual([]);
});

it('tells the worker how many accounts of the placed provider are signed in on its machine', () => {
  const f = fixture();
  f.db.insert(modelAccounts).values([{ id: 'second-account', owner: 'owner', provider: 'provider', label: 'Second', hasRoom: true }, { id: 'elsewhere', owner: 'owner', provider: 'another', label: 'Other', hasRoom: true }]).run();
  f.db.insert(modelAccountBoxes).values([{ account: 'second-account', box: 'first' }, { account: 'elsewhere', box: 'first' }]).run();
  expect(f.runtime.next('first')).toMatchObject({ account: 'account', accountChoices: 2 });
});
it('names to its caller each job a poll ended as one no harness can hold', () => {
  const f = fixture(); f.runtime.jobs.stop(f.job.id, 'owner', 'write-off');
  const room = f.comms.open({ agent: 'art', venue: 'slack', place: JSON.stringify(['T', 'C', null]), label: 'room' });
  f.comms.send({ toKind: 'agent', to: 'art', conversation: room.id, source: 'notice', fromKind: 'unknown', words: 'Work' });
  const job = f.runtime.jobs.admit(room.id)!, ended: string[] = [];
  expect(f.runtime.next('first', undefined, ended)).toBeUndefined();
  expect(ended).toEqual([job.id]); expect(f.runtime.jobs.get(job.id).endedNote).toBe(UNHELD_NOTE);
});

it('records the facts and ordering behind the claim even after machine facts change', () => {
  const f = fixture();
  f.db.update(jobs).set({ prefers: ['large'] }).where(eq(jobs.id, f.job.id)).run();
  f.db.insert(boxFacts).values({ box: 'second', fact: 'large', fromOwner: true }).run();
  expect(f.runtime.next('first')).toBeUndefined();
  expect(f.runtime.next('second')?.id).toBe(f.job.id);
  f.db.delete(boxFacts).run();
  expect(f.runtime.jobs.get(f.job.id).placementDecision).toEqual([
    { box: 'first', outcome: 'passed', reason: expect.stringContaining('large') },
    { box: 'second', outcome: 'taken', reason: expect.stringContaining('large') },
  ]);
});

it('passes a preferred machine whose reported slots are occupied', () => {
  const f = fixture();
  f.db.update(boxes).set({ slots: 1 }).where(eq(boxes.id, 'first')).run();
  f.db.insert(jobs).values({ ...f.job, id: 'occupying', conversation: null, state: 'starting', box: 'first' }).run();
  expect(f.runtime.next('second')?.id).toBe(f.job.id);
  expect(f.runtime.jobs.get(f.job.id).placementDecision).toContainEqual({
    box: 'first', outcome: 'passed', reason: expect.stringContaining('1/1'),
  });
});


it('worker slots are free after completion and terminal sessions do not occupy them', () => {
  const f = fixture();
  f.db.insert(jobs).values([
    { ...f.job, id: 'ended', conversation: null, state: 'done', box: 'first' },
    { ...f.job, id: 'terminal', conversation: null, state: 'running', box: 'first', startedByKind: 'terminal' },
  ]).run();
  expect(f.runtime.next('first', undefined, undefined, 1)?.id).toBe(f.job.id);
  expect(f.db.select().from(boxes).where(eq(boxes.id, 'first')).get()?.slots).toBe(1);
});

it('keeps a program off legacy pollers even when the box has the right facts', () => {
  const f = fixture();
  f.db.update(jobs).set({startedByKind:'program'}).where(eq(jobs.id,f.job.id)).run();
  expect(f.runtime.next('first', ['program-step:v1'])).toBeUndefined();
  expect(f.runtime.jobs.get(f.job.id).state).toBe('queued');
});

it('claims the frozen program through a capable poll with no account or model', () => {
  const f=fixture(), program={ ...testProgramPin, name:'watch',args:['--now'],timeoutMs:2000,secrets:{},state:{previous:2}};
  f.db.insert(triggers).values({id:'watch',ownerKind:'agent',owner:'art',sourceKind:'time',times:'09:07',lifespan:'until-stopped',
    targetKind:'inbox',toKind:'agent',to:'art',enabled:true,state:'standing',note:'Watch',createdAt:f.now(),changedAt:f.now()}).run();
  f.db.update(jobs).set({startedByKind:'program',startedBy:'watch'}).where(eq(jobs.id,f.job.id)).run();
  expect(f.runtime.next('first', [], undefined, 1, true)).toBeUndefined();
  // Its new diagnostics-only process still reports health, with zero job slots.
  f.runtime.machines.heartbeat('first', [], 0);
  f.db.insert(programFirings).values({id:'watch:1',trigger:'watch',job:f.job.id,at:f.now(),program,status:'pending'}).run();
  f.db.delete(modelAccountBoxes).run();
  f.db.insert(boxFacts).values({box:'first', fact:'program-step:v1', fromOwner:true}).run();
  expect(f.runtime.next('second',[],undefined,1,true)).toMatchObject({program,box:'second',model:'',account:'',harness:'house-program'});
  expect(f.runtime.next('second',[],undefined,1,true)).toBeUndefined();
});
