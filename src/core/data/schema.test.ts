import { afterEach, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { readFileSync } from 'node:fs';
import { getTableColumns, getTableName, eq } from 'drizzle-orm';
import { generateSQLiteDrizzleJson, generateSQLiteMigration } from 'drizzle-kit/api';
import { buildSchema } from 'drizzle-graphql';
import { graphql } from 'graphql/index.js';
import { createDataSchema } from './database.js';
import { referenceStatements } from './references.js';
import { clockScheduleNameIndex, schema, tables, plumbing, tasks, taskComments, members, projects, projectMembers, measuringSettings, timingDays, agents, conversations, threads, messages, threadRefs, inbox, tokens, triggers, approvals, approvalRules, taskLinks, jobs, modelAccounts, modelAccountWindows, digests, migrations, operationResults, household as householdSettings, secrets, secretRules, secretRuleAgents, deletedThreads, approvalRecord, agentAccounts, boxes } from './schema.js';

const opened: Database.Database[] = [];
function fresh() {
  const client = new Database(':memory:'); opened.push(client);
  return { client, db: createDataSchema(client, () => '2026-11-14T00:00:00.000Z') };
}
afterEach(() => { for (const client of opened.splice(0)) client.close(); });

describe('the approved data model', () => {
  it('covers every table and expanded column in the approved model, plus its internal bookkeeping', () => {
    // Read the approved source directly. No fixture copying the implementation,
    // Python subprocess or change to the site is needed to check coverage.
    const model = readFileSync(new URL('../../../docs/how-it-works/model.py', import.meta.url), 'utf8');
    const expected: Record<string, string[]> = {};
    let current: string | undefined;
    for (const line of model.split('\n')) {
      const table = line.match(/T\("([a-z_]+)"/);
      if (table) { current = table[1]; expected[current] = []; }
      const column = line.match(/^    \("([a-z_, ]+)", "/);
      if (column && current) expected[current].push(...column[1].split(', '));
      if (line.trim().endsWith(')]),')) current = undefined;
    }
    expect(Object.keys(expected)).toHaveLength(87);
    const columnsOf = (table: Parameters<typeof getTableColumns>[0]) => Object.values(getTableColumns(table)).map(c => c.name)
      .filter(n => n !== 'singleton' || getTableName(table) === 'box_alert_settings');
    const actual = Object.fromEntries(Object.values(tables).map(table => [getTableName(table), columnsOf(table)]));
    // The schema keeps these three with its plumbing; the approved model describes each column by column.
    const described = [plumbing.modelAccountLogins, plumbing.jobUsage, plumbing.programFirings];
    for (const table of described) actual[getTableName(table)] = columnsOf(table);
    // Delivery bookkeeping is recorded by the mail service.
    actual.inbox = actual.inbox.filter(n => !['taken_volume','first_accepted_at'].includes(n));
    // The provider read outcome is internal bookkeeping for handoff diagnostics.
    actual.model_accounts = actual.model_accounts.filter(n => n !== 'usage_read_succeeded');
    expect(actual.threads.pop()).toBe('source_channel');
    // Retained v1 card and delivery details are importer bookkeeping on native messages.
    expect(actual.messages.filter(n=>n.startsWith('archived_'))).toEqual(['archived_step_meta','archived_step_words','archived_notice']);
    actual.messages=actual.messages.filter(n=>!n.startsWith('archived_'));
    expect(actual.deleted_threads.slice(-3)).toEqual(['source_member','source_agent','source_channel']);
    actual.deleted_threads=actual.deleted_threads.slice(0,-3);
    expect(actual).toEqual(expected);
    const names = [...model.matchAll(/^ \("([a-z_]+)", /gm)].map(m => m[1]);
    expect(Object.values(plumbing).filter(table => !described.includes(table)).map(getTableName).sort()).toEqual([...names,'bridge_person_sightings','job_session_limits','agent_post_names','agent_post_threads','agent_posts','guest_io_readings','worker_join_requests','archived_questions','account_week_readings','change_review_rounds','imported_task_sequence','bridge_send_jobs','agent_kits','agent_kit_projects','agent_kit_members','agent_kit_outside_people','project_outside_people','kit_uses','program_tokens','program_record_grants','program_operation_grants'].sort());
    const { client } = fresh();
    for (const table of [...Object.values(tables), ...Object.values(plumbing)]) {
      const columns = client.prepare(`PRAGMA table_info("${getTableName(table)}")`).all() as { name: string }[];
      expect(columns.map(c => c.name)).toEqual(Object.values(getTableColumns(table)).map(c => c.name));
    }
    expect(client.pragma('foreign_key_check')).toEqual([]);
  });

  it('keeps generated installation SQL exactly in step with the sole Drizzle definition', async () => {
    const statements = await generateSQLiteMigration(await generateSQLiteDrizzleJson({}), await generateSQLiteDrizzleJson(schema));
    const checkedIn = readFileSync(new URL('../../../assets/data/schema.sql', import.meta.url), 'utf8');
    expect(checkedIn.slice(checkedIn.indexOf('\n') + 1)).toBe([...statements, clockScheduleNameIndex, ...referenceStatements(), 'INSERT INTO box_alert_settings (singleton) VALUES (1);'].join('\n') + '\n');
  });

  it('refuses an existing database and leaves its records intact', () => {
    const client = new Database(':memory:'); opened.push(client);
    client.exec("CREATE TABLE sqliteXprecious (words TEXT); INSERT INTO sqliteXprecious VALUES ('keep me')");
    expect(() => createDataSchema(client)).toThrow('requires an empty database');
    expect(client.prepare('SELECT words FROM sqliteXprecious').get()).toEqual({ words: 'keep me' });
    expect(client.prepare("SELECT name FROM sqlite_schema WHERE type='table'").all()).toEqual([{ name: 'sqliteXprecious' }]);
  });

  it('joins connected records through the typed schema and rejects invalid rows', () => {
    const { client, db } = fresh();
    db.insert(projects).values({ id: 'pond', name: 'Pond' }).run();
    db.insert(members).values({ id: 'jonathan', role: 'owner', joinedAt: '2026-11-14T00:00:00Z' }).run();
    db.insert(projectMembers).values({ project: 'pond', member: 'jonathan' }).run();
    const task = { id: 't-1', title: 'Pick a pump', ownerKind: 'member' as const, owner: 'jonathan', project: 'pond', createdByKind: 'member' as const, createdBy: 'jonathan', createdAt: '2026-11-14T00:00:00Z', changedAt: '2026-11-14T00:00:00Z' };
    db.insert(tasks).values(task).run();
    db.insert(taskComments).values({ task: task.id, seq: 1, actorKind: 'member', actor: 'jonathan', at: task.createdAt, text: 'Fits the old hose' }).run();
    const row = db.query.tasks.findFirst({ where: eq(tasks.id, task.id), with: { projectRow: true, taskCommentsByTask: true } }).sync();
    expect(row?.projectRow?.name).toBe('Pond');
    expect(row?.taskCommentsByTask.map(c => c.text)).toEqual(['Fits the old hose']);
    expect(() => db.insert(tasks).values({ ...task, id: 'bad', priority: 5 }).run()).toThrow();
    expect(() => db.insert(tasks).values({ ...task, id: 'bad', owner: null }).run()).toThrow();
    expect(() => db.insert(projectMembers).values({ project: 'missing', member: 'jonathan' }).run()).toThrow();
    expect(() => client.prepare("UPDATE tasks SET status = 'invented'").run()).toThrow();
    expect(() => db.insert(taskComments).values({ task: task.id, seq: 1, actorKind: 'member', actor: 'jonathan', at: task.createdAt, text: 'duplicate' }).run()).toThrow();
  });

  it('keeps Measuring off by default and accumulates fractional milliseconds in real columns', () => {
    const { db } = fresh();
    db.insert(measuringSettings).values({}).run();
    expect(db.select().from(measuringSettings).get()).toMatchObject({ singleton: 1, on: false, sendOutside: false, keepDays: 90 });
    expect(() => db.insert(measuringSettings).values({}).run()).toThrow();
    db.insert(timingDays).values({ day: '2026-11-14', kind: 'request', name: 'graphql', count: 2, totalMs: 1.75, slowestMs: 1.25, typicalMs: 0.875 }).run();
    expect(db.select().from(timingDays).get()?.typicalMs).toBe(0.875);
  });

  it('can generate GraphQL reads for the entire schema without hand-written table reads', async () => {
    const { db, at } = household();
    db.insert(projects).values({ id: 'pond', name: 'Pond' }).run();
    db.update(tasks).set({ project: 'pond' }).run();
    db.insert(taskComments).values({ task: 't-1', seq: 1, actorKind: 'member', actor: 'jonathan', at, text: 'Fits the hose' }).run();
    const generated = buildSchema(db, { relationsDepthLimit: 2 });
    const result = await graphql({ schema: generated.schema, source: '{ tasks { id title projectRow { name } taskCommentsByTask { text } } timingDays { day totalMs } }' });
    expect(result.errors).toBeUndefined();
    expect(result.data).toEqual({ tasks: [{ id: 't-1', title: 'Pick a pump', projectRow: { name: 'Pond' }, taskCommentsByTask: [{ text: 'Fits the hose' }] }], timingDays: [] });
  });

  function household() {
    const store = fresh(); const { db } = store;
    const at = '2026-11-14T00:00:00Z';
    db.insert(members).values({ id: 'jonathan', role: 'owner', joinedAt: at }).run();
    db.insert(agents).values({ id: 'art', about: 'Art', markBg: '#000', markFg: '#fff', faceShape: 'pebble', faceEyes: 'dot' }).run();
    db.insert(conversations).values({ id: 'cv-1', agent: 'art', venue: 'loom', place: 'test', label: 'Test', startedAt: at, lastAt: at, turnCount: 0 }).run();
    const task = { id: 't-1', title: 'Pick a pump', ownerKind: 'member' as const, owner: 'jonathan', createdByKind: 'member' as const, createdBy: 'jonathan', createdAt: at, changedAt: at };
    db.insert(tasks).values(task).run();
    return { ...store, at, task };
  }

  it('shares provider windows across agents and records actual job account placement', () => {
    const { db, client, at } = household();
    const account = { id: 'ma-1', owner: 'jonathan', provider: 'test', label: 'Test', hasRoom: false };
    db.insert(modelAccounts).values(account).run();
    db.insert(modelAccounts).values({ ...account, id: 'ma-2' }).run();
    const window = { account: 'ma-1', window: 'five-hour', durationMs: 18_000_000 };
    db.insert(modelAccountWindows).values(window).run();
    db.insert(modelAccountWindows).values({ ...window, window: 'weekly', durationMs: 604_800_000, usage: 0.8, usageReadAt: at, resetsAt: '2026-11-21T00:00:00Z', reserve: 0.1 }).run();
    db.insert(modelAccountWindows).values({ ...window, account: 'ma-2' }).run();
    expect(db.select().from(modelAccountWindows).all()).toHaveLength(3);
    expect(db.select().from(modelAccountWindows).get()).toMatchObject({ usage: null, usageReadAt: null, resetsAt: null, reserve: 0.05 });
    expect(() => db.insert(modelAccountWindows).values(window).run()).toThrow();
    for (const bad of [{ usage: -0.1 }, { usage: 1.1 }, { reserve: -0.01 }, { reserve: 1.01 }, { durationMs: 0 }, { durationMs: -1 }, { durationMs: Infinity }, { window: ' ' }, { usageReadAt: 'yesterday' }, { resetsAt: '2026-11-21T00:00:00+01:00' }, { account: 'missing' }]) {
      expect(() => db.insert(modelAccountWindows).values({ ...window, window: 'invalid', ...bad }).run()).toThrow();
    }
    const job = { id: 'j-placed', agent: 'art', conversation: 'cv-1', title: 'Test', state: 'queued' as const, brief: 'Test', model: 'test', startedByKind: 'member', startedBy: 'jonathan', houseRepository: 'repo', houseFile: 'house', houseBranch: 'main', queuedAt: at };
    db.insert(jobs).values(job).run();
    expect(db.select().from(jobs).get()).toMatchObject({ account: null, harness: null });
    expect(() => db.update(jobs).set({ account: 'missing' }).run()).toThrow();
    db.update(jobs).set({ account: 'ma-1', harness: 'claude-code' }).run();
    const placed = db.query.jobs.findFirst({ with: { accountRow: { with: { modelAccountWindowsByAccount: true } } } }).sync();
    expect(placed?.accountRow?.modelAccountWindowsByAccount.map(w => w.window).sort()).toEqual(['five-hour', 'weekly']);
    expect(placed?.harness).toBe('claude-code');
    expect(() => db.delete(modelAccounts).where(eq(modelAccounts.id, 'ma-1')).run()).toThrow();
    expect(client.pragma('foreign_key_check')).toEqual([]);
  });

  it('requires one matching token identity and valid polymorphic references on writes and parent changes', () => {
    const { db, client, at, task } = household();
    const token = { fingerprint: 'fp', label: 'browser', kind: 'owner' as const, createdAt: at };
    expect(() => db.insert(tokens).values(token).run()).toThrow();
    expect(() => db.insert(tokens).values({ ...token, member: 'jonathan', agent: 'art' }).run()).toThrow();
    db.insert(tokens).values({ ...token, member: 'jonathan' }).run();
    expect(() => db.insert(tasks).values({ ...task, id: 'bad', owner: 'nobody' }).run()).toThrow();
    expect(() => db.update(tasks).set({ ownerKind: 'agent', owner: 'jonathan' }).run()).toThrow();
    expect(() => db.insert(taskComments).values({ task: task.id, seq: 1, actorKind: 'agent', actor: 'nobody', at, text: 'bad' }).run()).toThrow();
    expect(() => db.update(tasks).set({ assignee: 'art', assigneeKind: null }).run()).toThrow();
    expect(() => client.prepare("DELETE FROM members WHERE id = 'jonathan'").run()).toThrow();
    expect(() => client.prepare("UPDATE members SET id = 'other' WHERE id = 'jonathan'").run()).toThrow();
    db.insert(approvalRules).values({ kind: 'merge', scope: '*', tier: 'ask', setBy: 'jonathan', setAt: at }).run();
    expect(() => db.insert(approvalRules).values({ kind: 'merge', scope: '*', person: 'nobody', tier: 'ask', setBy: 'jonathan', setAt: at }).run()).toThrow();
    db.insert(members).values({ id: 'mark', role: 'member', joinedAt: at }).run();
    db.insert(approvalRules).values({ kind: 'merge', scope: '*', person: 'mark', tier: 'ask', setBy: 'jonathan', setAt: at }).run();
    expect(() => client.prepare("DELETE FROM members WHERE id = 'mark'").run()).toThrow();
  });

  it('enforces trigger owners and a usable target', () => {
    const { db, at } = household();
    const trigger = { id: 'tr-1', ownerKind: 'member' as const, sourceKind: 'time' as const, lifespan: 'once' as const, targetKind: 'inbox' as const, note: 'Test', enabled: true, state: 'standing' as const, createdAt: at, changedAt: at };
    expect(() => db.insert(triggers).values(trigger).run()).toThrow();
    expect(() => db.insert(triggers).values({ ...trigger, owner: 'jonathan' }).run()).toThrow();
    expect(() => db.insert(triggers).values({ ...trigger, owner: 'jonathan', toKind: 'agent', to: 'missing' }).run()).toThrow();
    expect(() => db.insert(triggers).values({ ...trigger, owner: 'jonathan', targetKind: 'operation' }).run()).toThrow();
    db.insert(triggers).values({ ...trigger, owner: 'jonathan', toKind: 'agent', to: 'art' }).run();
  });

  it('checks documented length limits and rejects non-UTC or invalid timestamps', () => {
    const { db, at } = household();
    expect(() => db.update(agents).set({ about: 'x'.repeat(601) }).run()).toThrow();
    db.update(agents).set({ about: 'x'.repeat(600) }).run();
    expect(() => db.insert(digests).values({ id: 'dg-1', conversation: 'cv-1', run: 'r-1', revision: 1, at, summary: 'x'.repeat(601) }).run()).toThrow();
    for (const invalid of ['yesterday', '2026-11-14T00:00:00+01:00', '2026-02-30T00:00:00Z']) {
      expect(() => db.update(members).set({ joinedAt: invalid }).run()).toThrow();
    }
    db.update(members).set({ joinedAt: '2026-11-14T00:00:00.123Z' }).run();
    const thread = { id: 'th-1', conversation: 'cv-1', title: 'x'.repeat(61), titledBy: 'member' as const, pinned: false, openedAt: at, lastAt: at, readSeq: 0, working: false, stopRequested: false };
    expect(() => db.insert(threads).values(thread).run()).toThrow();
    db.insert(threads).values({ ...thread, title: 'x'.repeat(60) }).run();
  });

  it('enforces one parent, one active job per conversation, usage ranges and thread deletion', () => {
    const { db, client, at, task } = household();
    for (const id of ['t-2', 't-3']) db.insert(tasks).values({ ...task, id }).run();
    db.insert(taskLinks).values({ task: 't-1', dependsOn: 't-2', type: 'parent-child' }).run();
    expect(() => db.insert(taskLinks).values({ task: 't-1', dependsOn: 't-3', type: 'parent-child' }).run()).toThrow();
    const job = { id: 'j-1', agent: 'art', conversation: 'cv-1', title: 'Test', state: 'running' as const, brief: 'Test', model: 'test', startedByKind: 'member', startedBy: 'jonathan', houseRepository: 'repo', houseFile: 'house', houseBranch: 'main', queuedAt: at };
    db.insert(jobs).values(job).run();
    expect(() => db.insert(jobs).values({ ...job, id: 'j-2' }).run()).toThrow();
    db.update(jobs).set({ state: 'done' }).run();
    db.insert(jobs).values({ ...job, id: 'j-2' }).run();
    expect(() => db.insert(modelAccounts).values({ id: 'ma-1', owner: 'jonathan', provider: 'test', label: 'Test', usage: 1.1, hasRoom: false }).run()).toThrow();
    db.insert(threads).values({ id: 'th-1', conversation: 'cv-1', title: 'Test', titledBy: 'member', pinned: false, openedAt: at, lastAt: at, readSeq: 0, working: false, stopRequested: false }).run();
    db.insert(messages).values({ thread: 'th-1', seq: 1, kind: 'message', sender: 'jonathan', at }).run();
    db.insert(threadRefs).values({ thread: 'th-1', ref: 't-1', messageSeq: 1 }).run();
    const item = { id: 'i-1', toKind: 'person' as const, to: 'jonathan', source: 'notice' as const, fromKind: 'agent' as const, fromId: 'art', at, state: 'waiting' as const, changedAt: at, thread: 'th-1', messageSeq: 2 };
    expect(() => db.insert(inbox).values(item).run()).toThrow();
    db.insert(inbox).values({ ...item, messageSeq: 1 }).run();
    db.delete(inbox).run();
    db.delete(threads).run();
    expect(db.select().from(messages).all()).toEqual([]);
    expect(db.select().from(threadRefs).all()).toEqual([]);
    expect(client.pragma('foreign_key_check')).toEqual([]);
  });


  it('also refuses a database containing only SQLite analysis state', () => {
    const client = new Database(':memory:'); opened.push(client);
    client.exec('CREATE TABLE old(a); ANALYZE; DROP TABLE old;');
    const before = client.prepare('SELECT * FROM sqlite_schema').all();
    expect(before).not.toEqual([]);
    expect(() => createDataSchema(client)).toThrow('requires an empty database');
    expect(client.prepare('SELECT * FROM sqlite_schema').all()).toEqual(before);
  });

  it('keeps spec lines unique and rule-agent assignments attached to an actual standing rule', () => {
    const { db, at, task } = household();
    db.update(tasks).set({ specItem: 'spec/pump', criterion: 'fits' }).run();
    expect(() => db.insert(tasks).values({ ...task, id: 't-2', specItem: 'spec/pump', criterion: 'fits' }).run()).toThrow();
    db.insert(secrets).values({ name: 'github', description: 'Test', changedAt: at, changedBy: 'jonathan' }).run();
    expect(() => db.insert(secretRuleAgents).values({ secret: 'github', agent: 'art', when: 'on_request' }).run()).toThrow();
    db.insert(secretRules).values({ secret: 'github', answer: 'ask', minutes: 10 }).run();
    db.insert(secretRuleAgents).values({ secret: 'github', agent: 'art', when: 'on_request' }).run();
    expect(() => db.delete(secretRules).run()).toThrow();
  });

  it('checks UTC timestamps in internal bookkeeping as well', () => {
    const { db, at } = household();
    expect(() => db.insert(migrations).values({ number: 2, appliedAt: 'yesterday' }).run()).toThrow();
    expect(() => db.insert(operationResults).values({ caller: 'art', id: 'retry-1', operation: 'tasks.close', inputHash: 'fingerprint', result: Buffer.from('done'), expiresAt: '2026-11-14T00:00:00+01:00' }).run()).toThrow();
  });

  it('enforces household ranges, live token labels and secret rule choices', () => {
    const { db, client, at } = household();
    expect(() => db.insert(householdSettings).values({ commsDays: 15 }).run()).toThrow();
    expect(() => db.insert(householdSettings).values({ backupKeep: 91 }).run()).toThrow();
    db.insert(householdSettings).values({ commsDays: 14, backupKeep: 90 }).run();
    const token = { fingerprint: 'fp', label: 'browser', kind: 'owner' as const, member: 'jonathan', createdAt: at };
    db.insert(tokens).values(token).run();
    expect(() => db.insert(tokens).values({ ...token, fingerprint: 'fp2' }).run()).toThrow();
    db.update(tokens).set({ revokedAt: at }).run();
    db.insert(tokens).values({ ...token, fingerprint: 'fp2' }).run();
    db.insert(secrets).values({ name: 'github', description: 'Test', changedAt: at, changedBy: 'jonathan' }).run();
    db.insert(secretRules).values({ secret: 'github', answer: 'ask', minutes: 10 }).run();
    expect(() => client.prepare("UPDATE secret_rules SET answer = 'sometimes'").run()).toThrow();
  });


  it('reuses expired token labels but refuses two live credentials or reviving a conflicting one', () => {
    const { db, at } = household();
    const token = { fingerprint: 'expired', label: 'browser', kind: 'owner' as const, member: 'jonathan', createdAt: at, expiresAt: '2026-11-13T00:00:00Z' };
    db.insert(tokens).values(token).run();
    db.insert(tokens).values({ ...token, fingerprint: 'current', expiresAt: '2026-11-15T00:00:00Z' }).run();
    db.insert(tokens).values({ ...token, fingerprint: 'at-boundary', expiresAt: '2026-11-14T00:00:00Z' }).run();
    expect(() => db.insert(tokens).values({ ...token, fingerprint: 'conflict', expiresAt: null }).run()).toThrow();
    expect(() => db.update(tokens).set({ expiresAt: null }).where(eq(tokens.fingerprint, 'expired')).run()).toThrow();
  });

  it('records thread deletion permanently and never reuses a deleted id', () => {
    const { db, at } = household();
    const thread = { id: 'th-1', conversation: 'cv-1', title: 'Test', titledBy: 'member' as const, pinned: false, openedAt: at, lastAt: at, readSeq: 0, working: false, stopRequested: false };
    db.insert(threads).values(thread).run();
    db.delete(threads).run();
    expect(db.select().from(deletedThreads).get()).toEqual({ id: 'th-1', conversation: 'cv-1', at: '2026-11-14T00:00:00.000Z', sourceAgent:null,sourceMember:null,sourceChannel:null });
    expect(() => db.insert(threads).values(thread).run()).toThrow();
    expect(() => db.delete(deletedThreads).run()).toThrow();
    expect(() => db.update(deletedThreads).set({ id: 'changed' }).run()).toThrow();
    db.insert(approvals).values({ id: 'a-1', kind: 'merge', target: 'repo#1', what: 'Merge', why: 'Test', agent: 'art', askedFrom: 'test', actingFor: 'owner', state: 'pending', minutes: 10, ask: 'Merge?', ifYes: 'Merge', ifNo: 'Leave', details: 'Test', askedAt: at }).run();
    db.insert(approvalRecord).values({ seq: 1, at, event: 'request', approval: 'a-1', agent: 'art', note: 'Asked' }).run();
    expect(() => db.update(approvalRecord).set({ note: 'Rewritten' }).run()).toThrow();
    expect(() => db.delete(approvalRecord).run()).toThrow();
  });

  it('makes outside service logins exclusive to one agent and live machine names unique', () => {
    const { db, at } = household();
    db.insert(agents).values({ id: 'mark', about: 'Mark', markBg: '#000', markFg: '#fff', faceShape: 'pebble', faceEyes: 'dot' }).run();
    db.insert(agentAccounts).values({ agent: 'art', service: 'github', login: 'art-e-fish' }).run();
    expect(() => db.insert(agentAccounts).values({ agent: 'mark', service: 'github', login: 'art-e-fish' }).run()).toThrow();
    const box = { id: 'box-1', name: 'worker', owner: 'jonathan', sameMachineAsLoom: false, hostsAny: true, reportOnly: false, alwaysOn: true, enrolledAt: at };
    db.insert(boxes).values(box).run();
    expect(() => db.insert(boxes).values({ ...box, id: 'box-2' }).run()).toThrow();
    db.update(boxes).set({ revokedAt: at }).run();
    db.insert(boxes).values({ ...box, id: 'box-2' }).run();
  });

});
