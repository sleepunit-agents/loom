import Database from 'better-sqlite3';
import { afterEach, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import { createDataSchema } from '../core/data/database.js';
import { Conversations } from '../core/conversations/index.js';
import { agents, members, boxes, agentModels, agentBoxes, agentRunSettings, agentHousePorts, memberAgents, modelAccounts, modelAccountWindows, modelAccountBoxes, jobs, jobNeeds, boxFacts, agentPeople, agentDeniedTools, secrets, bridgeConnections } from '../core/data/schema.js';
import { BridgeIncoming } from '../pieces/bridges/incoming.js';
import { Dispatcher } from './dispatcher.js';
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
  const runtime = new Dispatcher(db, now, () => roles), comms = new Conversations(db, now);
  const conversation = comms.open({ agent: 'art', venue: 'loom', place: 'thread', label: 'Reply', member: 'owner' });
  const mail = comms.send({ toKind: 'agent', to: 'art', conversation: conversation.id, source: 'thread', fromKind: 'person', fromId: 'owner', words: 'Private brief' });
  const job = runtime.jobs.admit(conversation.id)!;
  const tick = (ms: number) => { at = new Date(Date.parse(at) + ms).toISOString(); };
  return { client, db, now, tick, runtime, comms, conversation, mail, job, roles };
}
it('claims only on the selected worker and delivers an execution-ready snapshot once', () => {
  const f = fixture();
  expect(f.runtime.next('second')).toBeUndefined();
  expect(f.runtime.next('first')).toEqual({ thread:null, run: { nestedContainers: false, gpu: false, ports: [], policy: { deniedTools: [], people: [{ kind: 'person', person: 'owner', tier: null }] } }, id: f.job.id, box: 'first', agent: 'art', conversation: f.conversation.id,
    model: 'primary', account: 'account', harness: 'codex', brief: '', house: { repository: 'repo', file: 'Housefile', branch: 'main' } });
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
  const runtime = new Dispatcher(f.db, f.now, () => { expect(f.client.inTransaction).toBe(true); return f.roles; });
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
  f.db.insert(agentHousePorts).values([
    { agent: 'art', address: '127.0.0.1', port: 9000 },
    { agent: 'art', address: '127.0.0.1', port: 8000 },
  ]).run();
  const assignment = f.runtime.next('first')!;
  expect(assignment.run).toEqual({ nestedContainers: true, gpu: true,
    ports: [{ address: '127.0.0.1', port: 8000 }, { address: '127.0.0.1', port: 9000 }], policy: { deniedTools: [], people: [{ kind: 'person', person: 'owner', tier: null }] } });
  f.db.update(agentRunSettings).set({ nestedContainers: false }).run();
  expect(assignment.run.nestedContainers).toBe(true);
});

it('hands the configured outside tier and tool rules to the runner on actual claim', () => {
  const f = fixture(); f.runtime.jobs.stop(f.job.id, 'owner', 'write-off');
  f.db.insert(secrets).values({ name: 'bot', description: '', changedAt: f.now(), changedBy: 'owner' }).run();
  f.db.insert(bridgeConnections).values({ id: 'c', platform: 'discord', agent: 'art', workspace: 'w', botUser: 'bot-art', tokenSecret: 'bot', enabled: true, state: 'connected', stateAt: f.now() }).run();
  const incoming = new BridgeIncoming(f.db, f.now).receive({ id: 'm', connection: 'c', channel: 'room', isDm: true, user: 'outside', text: 'Work', postedAt: f.now(), mentions: [] });
  const job = f.runtime.jobs.admit(incoming.conversation!)!;
  const person = JSON.stringify(['discord', 'w', 'outside']);
  f.db.insert(agentPeople).values({ agent: 'art', person, tier: 2 }).run();
  f.db.insert(agentDeniedTools).values([{ agent: 'art', pattern: 'always', guestsOnly: false }, { agent: 'art', pattern: 'guests', guestsOnly: true }]).run();
  const assignment = f.runtime.next('first')!;
  expect(assignment.id).toBe(job.id);
  expect(assignment.run.policy).toEqual({ people: [{ kind: 'outside', person, tier: 2 }], deniedTools: [{ pattern: 'always', guestsOnly: false }, { pattern: 'guests', guestsOnly: true }] });
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
  expect(policyReads).toBeGreaterThanOrEqual(2);
});

it('never hands a legacy private brief to the worker while preserving the old record', () => {
  const f = fixture(); f.db.update(jobs).set({ brief: 'LEGACY_PRIVATE_WORDS' }).where(eq(jobs.id, f.job.id)).run();
  const assignment = f.runtime.next('first')!;
  expect(assignment.id).toBe(f.job.id); expect(assignment.brief).toBe('');
  expect(f.runtime.jobs.get(f.job.id).brief).toBe('LEGACY_PRIVATE_WORDS');
});

it('passes ordinary handoff instructions through the worker assignment', () => {
  const f = fixture(); f.runtime.jobs.stop(f.job.id, 'owner', 'write-off');
  const conversation = f.comms.open({ agent: 'art', venue: 'handoff', place: f.job.id, label: 'Handoff' });
  f.comms.send({ toKind: 'agent', to: 'art', conversation: conversation.id, source: 'handoff', fromKind: 'agent', fromId: 'art', words: 'Public handoff instructions' });
  const job = f.runtime.jobs.admit(conversation.id)!;
  expect(f.runtime.next('first')).toMatchObject({ id: job.id, brief: 'Public handoff instructions' });
});
it('passes unbound instructions through the worker assignment', () => {
  const f = fixture(); f.db.update(jobs).set({ conversation: null, brief: 'Unbound instructions' }).where(eq(jobs.id, f.job.id)).run();
  expect(f.runtime.next('first')).toMatchObject({ id: f.job.id, conversation: null, brief: 'Unbound instructions' });
});

it('keeps explicit body waiting status across worker liveness pulses until a body resumes it', () => {
  const f = fixture(); f.runtime.next('first'); f.runtime.started('first', f.job.id, 'image');
  f.runtime.jobs.heartbeat(f.job.id, 'first', 'waiting'); f.tick(15_000);
  expect(f.runtime.heartbeat('first', f.job.id, 'running')).toEqual({ active: true });
  expect(f.runtime.jobs.get(f.job.id)).toMatchObject({ state: 'waiting', heardAt: f.now() });
  expect(f.db.select().from(boxes).where(eq(boxes.id, 'first')).get()?.lastSeenAt).toBe(f.now());
  expect(f.runtime.heartbeat('second', f.job.id, 'running')).toEqual({ active: false });
  expect(f.runtime.jobs.get(f.job.id).state).toBe('waiting');
  // A body status report, rather than the worker's process phase, resumes work.
  f.runtime.jobs.heartbeat(f.job.id, 'first', 'running');
  expect(f.runtime.heartbeat('first', f.job.id, 'running')).toEqual({ active: true });
  expect(f.runtime.jobs.get(f.job.id).state).toBe('running');
});
