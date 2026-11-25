import Database from 'better-sqlite3';
import { afterEach, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { getRequestListener } from '@hono/node-server';
import { WebSocket } from 'ws';
import { eq, getTableColumns } from 'drizzle-orm';
import { talkVisibility } from './core/data/conversation-visibility.js';
import { FakeClock } from './core/clock.js';
import { createDataSchema,dataDatabase } from './core/data/database.js';
import { agents, members, memberAgents, projects, projectMembers, projectAgents, tokens, tasks, taskComments, taskLinks, inbox } from './core/data/schema.js';
import { sharedRoot } from './shared-root.js';
const cleanup: (() => void | Promise<void>)[] = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });
const raw = { owner: 'a'.repeat(64), sam: 'b'.repeat(64), lee: 'c'.repeat(64), art: 'd'.repeat(64) };
const hash = (s: string) => createHash('sha256').update(s).digest('hex');
function fixture() {
  const client = new Database(':memory:'); cleanup.push(() => { client.close(); });
  const clock = new FakeClock(), at = new Date(clock.now()).toISOString(), db = createDataSchema(client, () => new Date(clock.now()).toISOString());
  db.insert(members).values(['owner','sam','lee'].map(id => ({ id, role: id === 'owner' ? 'owner' as const : 'member' as const, joinedAt: at }))).run();
  db.insert(agents).values({ id: 'art', about: '', markBg: '#000', markFg: '#fff', faceShape: 'pebble', faceEyes: 'dot' }).run();
  db.insert(memberAgents).values({ member: 'sam', agent: 'art' }).run();
  db.insert(projects).values(['pond', 'other'].map(id => ({ id, name: id }))).run();
  db.insert(projectMembers).values({ project: 'pond', member: 'sam' }).run();
  db.insert(projectAgents).values({ project: 'pond', agent: 'art' }).run();
  db.insert(tokens).values(Object.entries(raw).map(([id, value]) => ({ fingerprint: hash(value), label: id, kind: id === 'art' ? 'agent' as const : 'owner' as const, member: id === 'art' ? null : id, agent: id === 'art' ? id : null, createdAt: at }))).run();
  const root = sharedRoot({ db, clock, originAllowed: () => true, reportError: () => {} }); cleanup.push(() => root.close());
  const input = { title: 'Pump', goal: 'Works', why: 'Pond', owner: { kind: 'member' as const, id: 'sam' } };
  const call = (command: unknown, who: keyof typeof raw = 'sam', id = 'command') => root.http.request('http://loom/api/tasks/command', {
    method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer '+raw[who] }, body: JSON.stringify({ input: command, id }),
  });
  return { client, db, clock, root, input, call };
}
it('mounts the typed command, derives actors from current credentials and replays exactly one effect', async () => {
  const f = fixture(), command = { action: 'create', input: f.input };
  const first = await (await f.call(command)).json();
  expect(first).toEqual({ ok: true, value: { id: 't-1' } });
  expect(await (await f.call(command)).json()).toEqual(first);
  expect(f.db.select().from(tasks).all()).toHaveLength(1);
  expect(f.db.select().from(tasks).get()).toMatchObject({ createdByKind: 'member', createdBy: 'sam' });
  expect((await f.call({ ...command, actor: { kind: 'member', id: 'owner' } }, 'sam', 'forged')).status).toBe(400);
  expect((await f.call({ ...command, input: { ...f.input, title: 'Changed' } })).status).toBe(409);
  const agent = f.root.services.tasks.create({ ...f.input, owner: { kind: 'agent', id: 'art' } }, { kind: 'member', id: 'owner' });
  expect((await f.call({ action: 'comment', id: agent.id, text: 'Ready' }, 'art', 'comment')).status).toBe(200);
  expect(f.db.select().from(taskComments).get()).toMatchObject({ actorKind: 'agent', actor: 'art', text: 'Ready' });
});
it('validates both relation ends, proposed sharing and private conversation source before effect or receipt', async () => {
  const f = fixture();
  const own = f.root.services.tasks.create(f.input, { kind: 'member', id: 'owner' });
  const hidden = f.root.services.tasks.create({ ...f.input, owner: { kind: 'member', id: 'lee' } }, { kind: 'member', id: 'owner' });
  const cv = f.root.services.conversations.open({ agent: 'art', member: 'lee', project: 'pond', venue: 'loom', place: 'private', label: 'Private' });
  for (const command of [
    { action: 'create', input: { ...f.input, parent: hidden.id } },
    { action: 'create', input: { ...f.input, source: { kind: 'conversation', id: cv.id } } },
    { action: 'link', id: own.id, dependsOn: hidden.id, type: 'blocks' },
    { action: 'unlink', id: hidden.id, dependsOn: own.id, type: 'blocks' },
    { action: 'edit', id: own.id, input: { project: 'other' } },
    { action: 'ask', id: own.id, input: { to: { kind: 'member', id: 'lee' }, ask: 'Spend?', ifYes: 'Buy', ifNo: 'Wait' } },
  ]) expect((await f.call(command)).status).toBe(403);
  expect(f.db.select().from(taskLinks).all()).toEqual([]);
  expect(f.db.select().from(tasks).all()).toHaveLength(2);
  expect(f.client.prepare('SELECT * FROM operation_results').all()).toEqual([]);
  // Another member's private conversation is no source for a household owner's task either; it is for its own member.
  expect((await f.call({ action: 'create', input: { ...f.input, source: { kind: 'conversation', id: cv.id } } }, 'owner')).status).toBe(403);
  expect((await f.call({ action: 'create', input: { ...f.input, owner: { kind: 'member', id: 'lee' }, source: { kind: 'conversation', id: cv.id } } }, 'lee')).status).toBe(200);
});
it('checks current sharing before cached receipts, then denies revoked credentials', async () => {
  const f = fixture(), command = { action: 'create', input: { ...f.input, project: 'pond', owner: { kind: 'member', id: 'lee' } } };
  expect((await f.call(command)).status).toBe(200);
  f.root.writes.run(() => f.db.delete(projectMembers).run());
  expect((await f.call(command)).status).toBe(403);
  f.root.writes.run(() => f.db.update(tokens).set({ revokedAt: new Date(f.clock.now()).toISOString() }).where(eq(tokens.fingerprint, hash(raw.sam))).run());
  expect((await f.call(command)).status).toBe(401);
  expect(f.db.select().from(tasks).all()).toHaveLength(1);
});
it('rolls task effects back when the shared receipt fails and permits the same-id retry', async () => {
  const f = fixture(), command = { action: 'create', input: f.input };
  f.client.exec("CREATE TRIGGER receipt_failure BEFORE INSERT ON operation_results BEGIN SELECT RAISE(ABORT,'fixture'); END");
  expect((await f.call(command)).status).toBe(503);
  expect(f.db.select().from(tasks).all()).toEqual([]);
  expect(f.client.prepare('SELECT * FROM operation_results').all()).toEqual([]);
  f.client.exec('DROP TRIGGER receipt_failure');
  expect(await (await f.call(command)).json()).toEqual({ ok: true, value: { id: 't-1' } });
});
it('publishes an actual task command to the same socket query and withdraws project access', async () => {
  const f = fixture();
  const server = createServer(getRequestListener(request => f.root.http.fetch(request))), detach = f.root.attach(server);
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  cleanup.push(async () => { detach(); await f.root.close(); await new Promise<void>(resolve => server.close(() => resolve())); });
  const address = server.address(); if (!address || typeof address === 'string') throw new Error('No port');
  const ws = new WebSocket('ws://127.0.0.1:'+address.port+'/graphql', 'graphql-transport-ws', { headers: { authorization: 'Bearer '+raw.sam } });
  cleanup.push(() => ws.terminate()); await once(ws, 'open');
  let next = once(ws, 'message'); ws.send(JSON.stringify({ type: 'connection_init' })); await next;
  next = once(ws, 'message'); ws.send(JSON.stringify({ type: 'subscribe', id: 'tasks', payload: { query: 'subscription { observe(query:"{ tasks { id title } }") { patches { path value removed } } }' } }));
  expect(JSON.parse(String((await next)[0])).payload.data.observe.patches[0].value).toEqual({ tasks: [] });
  next = once(ws, 'message');
  expect((await f.call({ action: 'create', input: { ...f.input, project: 'pond', owner: { kind: 'member', id: 'lee' } } })).status).toBe(200);
  expect(JSON.parse(String((await next)[0])).payload.data.observe.patches).toEqual([{ path: ['tasks', 0], value: { id: 't-1', title: 'Pump' }, removed: false }]);
  next = once(ws, 'message'); f.root.writes.run(() => f.db.delete(projectMembers).run());
  expect(JSON.parse(String((await next)[0])).payload.data.observe.patches).toEqual([{ path: ['tasks',0], value: null, removed: true }]);
});
it.each(['project', 'agent'] as const)('rechecks current conversation source %s access for replay and fresh commands', async grant => {
  const f = fixture();
  if (grant === 'project') f.db.delete(memberAgents).run();
  else f.db.delete(projectMembers).run();
  const cv = f.root.services.conversations.open({ agent: 'art', project: grant === 'project' ? 'pond' : 'other', venue: 'loom', place: 'shared-source', label: 'Pump' });
  const command = { action: 'create', input: { ...f.input, source: { kind: 'conversation', id: cv.id } } };
  expect((await f.call(command)).status).toBe(200);
  f.root.writes.run(() => { if (grant === 'project') f.db.delete(projectMembers).run(); else f.db.delete(memberAgents).run(); });
  expect((await f.call(command)).status).toBe(403);
  expect((await f.call(command, 'sam', 'fresh-after-withdrawal')).status).toBe(403);
  expect(f.db.select().from(tasks).all()).toHaveLength(1);
  expect(f.client.prepare('SELECT count(*) AS n FROM operation_results').get()).toEqual({ n: 1 });
});

it.each(['dim','mute'] as const)('a fresh named task ask lifts %s only for its recipient, while receipt replay preserves a later preference',async(level)=>{
 const f=fixture(),task=f.root.services.tasks.create(f.input,{kind:'member',id:'owner'});
 const ask={action:'ask',id:task.id,input:{to:{kind:'member',id:'sam'},ask:'Choose a pump?',ifYes:'Buy',ifNo:'Wait'}};
 expect((await f.call(ask,'sam','first')).status).toBe(200);
 const old=f.db.select().from(inbox).where(eq(inbox.waitsOnId,task.id)).get()!;
 const other=f.root.services.conversations.send({toKind:'person',to:'lee',source:'task',fromKind:'agent',words:'Other recipient',answers:'yes-no',waitsOnKind:'task',waitsOnId:task.id});
 f.root.services.tempo.volume.set({kind:'person',id:'sam'},old.id,level);
 f.root.services.tempo.volume.set({kind:'person',id:'lee'},other.id,'mute');
 const quiet=f.root.services.conversations.item(other.id).quietUntil;
 const beforeFailure=f.db.select().from(inbox).all();
 f.client.exec("CREATE TRIGGER refuse_named_question BEFORE INSERT ON inbox WHEN NEW.source='task' BEGIN SELECT RAISE(ABORT,'delivery failed'); END");
 expect((await f.call(ask,'sam','failed-named')).status).toBe(503);
 expect(f.db.select().from(inbox).all()).toEqual(beforeFailure);
 f.client.exec('DROP TRIGGER refuse_named_question');
 expect((await f.call({...ask,input:{...ask.input,to:{kind:'member',id:'lee'}}},'sam','refused')).status).toBe(403);
 expect(f.root.services.conversations.item(old.id).volume).toBe(level);
 expect((await f.call(ask,'sam','named-again')).status).toBe(200);
 expect(f.root.services.conversations.item(old.id)).toMatchObject({state:'resolved',volume:'full',quietUntil:null});
 expect(f.root.services.conversations.item(other.id)).toMatchObject({state:'resolved',volume:'mute',quietUntil:quiet});
 const current=f.db.select().from(inbox).all().find(row=>row.waitsOnId===task.id&&row.state==='waiting')!;
 expect(current).toMatchObject({to:'sam',volume:'full',quietUntil:null});
 f.root.services.tempo.volume.set({kind:'person',id:'sam'},current.id,'dim');
 const before=f.db.select().from(inbox).all();
 expect((await f.call(ask,'sam','named-again')).status).toBe(200);
 expect(f.db.select().from(inbox).all()).toEqual(before);
});

it.each(['yes','no','words'] as const)('answers a task question as its recipient, once, via the actual command door (%s)',async answer=>{
 const f=fixture(),s=f.root.services.tasks,task=s.create(f.input,{kind:'agent',id:'art'});
 s.ask(task.id,{to:{kind:'member',id:'sam'},ask:'Order the pump?',ifYes:'Buy it.',ifNo:'Wait.',answers:answer==='words'?'words':'yes-no'},{kind:'agent',id:'art'});
 const question=f.db.select().from(inbox).where(eq(inbox.waitsOnId,task.id)).get()!;
 const command={action:'answer',id:task.id,question:question.id,answer,...(answer==='words'?{text:'Choose the smaller pump.'}:{})};
 expect((await f.call(command,'owner','other-owner')).status).toBe(403);
 expect((await f.call(command,'art','asking-agent')).status).toBe(403);
 expect((await f.call(command,'sam','answer')).status).toBe(200);
 expect((await f.call(command,'sam','answer')).status).toBe(200);
 expect(s.get(task.id)).toMatchObject({ask:null,assigneeKind:'agent',assignee:'art'});
 expect(s.get(task.id).comments).toHaveLength(1);
 expect(s.get(task.id).comments[0]).toMatchObject({actorKind:'member',actor:'sam',at:new Date(f.clock.now()).toISOString(),text:answer==='words'?'Choose the smaller pump.':`${answer==='yes'?'Yes':'No'}, to: Order the pump?\n${answer==='yes'?'Buy it.':'Wait.'}`});
 expect(f.root.services.conversations.item(question.id).state).toBe('resolved');
 expect(f.db.select().from(inbox).all().filter(row=>row.source==='answer'&&row.sourceId===question.id)).toHaveLength(1);
 s.ask(task.id,{to:{kind:'member',id:'sam'},ask:'Order the pump?',ifYes:'Buy it.',ifNo:'Wait.'},{kind:'agent',id:'art'});
 expect((await f.call(command,'sam','stale-new-intent')).status).toBe(409);
 expect((await f.call(command,'sam','answer')).status).toBe(200);
 expect(s.get(task.id).ask).toBe('Order the pump?');
 expect(s.get(task.id).comments).toHaveLength(1);
});

 it('refuses the replaced delivery while its identical replacement is still waiting',async()=>{
 const f=fixture(),s=f.root.services.tasks,task=s.create(f.input,{kind:'agent',id:'art'});
 const input={to:{kind:'member' as const,id:'sam'},ask:'Order the pump?',ifYes:'Buy it.',ifNo:'Wait.'};
 s.ask(task.id,input,{kind:'agent',id:'art'});
 const old=f.db.select().from(inbox).where(eq(inbox.waitsOnId,task.id)).get()!;
 s.ask(task.id,input,{kind:'agent',id:'art'});
 expect((await f.call({action:'answer',id:task.id,question:old.id,answer:'yes'},'sam','old-card')).status).toBe(409);
 expect(s.get(task.id).ask).toBe(input.ask);expect(s.get(task.id).comments).toEqual([]);
 });
it('reports a task rule that was broken in its own words, not as an outage', async () => {
  const f = fixture();
  const made = await (await f.call({ action: 'create', input: { title: 'Fix the pump', goal: 'It runs', why: 'Green water', owner: { kind: 'member', id: 'sam' } } }, 'sam', 'make')).json() as { value: { id: string } };
  const id = made.value.id;
  expect((await f.call({ action: 'claim', id }, 'sam', 'claim')).status).toBe(200);
  const again = await f.call({ action: 'claim', id }, 'sam', 'claim-again');
  expect(again.status).toBe(400);
  expect(await again.json()).toMatchObject({ ok: false, code: 'invalid', message: 'Only open work can be claimed' });
  const unclaimOpen = await f.call({ action: 'reopen', id: 't-999' }, 'sam', 'missing');
  expect(unclaimOpen.status).toBe(403);
});

it('files a question about a project task, and its answer, so that the person each is addressed to reads it, whoever owns the task', async () => {
  const f = fixture(), s = f.root.services.tasks;
  f.db.insert(projectMembers).values({ project: 'pond', member: 'lee' }).run();
  // What each person's Inbox shows: the inbox rule, as every reader of the Inbox asks it.
  const items = async (who: 'sam' | 'lee' | 'owner') => f.db.select({ id: inbox.id }).from(inbox).where(talkVisibility({ kind: 'member', id: who }).inbox(getTableColumns(inbox))).all().map(row => row.id);
  // Sam owns the task and it came from sam's private thread; the project shares it with lee.
  const cv = f.root.services.conversations.open({ agent: 'art', member: 'sam', project: 'pond', venue: 'loom', place: 'private', label: 'Private' });
  const task = s.create({ ...f.input, project: 'pond', source: { kind: 'conversation', id: cv.id } }, { kind: 'member', id: 'sam' });
  expect((await f.call({ action: 'ask', id: task.id, input: { to: { kind: 'member', id: 'lee' }, ask: 'Spend?', ifYes: 'Buy', ifNo: 'Wait' } }, 'sam', 'ask')).status).toBe(200);
  const question = f.db.select().from(inbox).where(eq(inbox.waitsOnId, task.id)).get()!;
  // A project task is not private to its owner, so its mail is not labelled as if it were.
  expect(question).toMatchObject({ to: 'lee', member: null, project: 'pond' });
  expect(await items('lee')).toEqual([question.id]);
  expect((await f.call({ action: 'answer', id: task.id, question: question.id, answer: 'yes' }, 'lee', 'answer')).status).toBe(200);
  // The other way round: lee asks sam, and sam's answer comes back to lee outside sam's private thread.
  expect((await f.call({ action: 'ask', id: task.id, input: { to: { kind: 'member', id: 'sam' }, ask: 'Which?', ifYes: 'Big', ifNo: 'Small' } }, 'lee', 'ask-back')).status).toBe(200);
  const back = f.db.select().from(inbox).all().find(row => row.to === 'sam' && row.state === 'waiting' && row.waitsOnId === task.id)!;
  expect((await f.call({ action: 'answer', id: task.id, question: back.id, answer: 'no' }, 'sam', 'answer-back')).status).toBe(200);
  const answer = f.db.select().from(inbox).all().find(row => row.source === 'answer' && row.to === 'lee')!;
  expect(answer).toMatchObject({ toKind: 'person', conversation: null, member: null, project: 'pond' });
  expect(await items('lee')).toContain(answer.id);
  // Asked of sam, whose thread the task came from, the question is in that thread.
  expect(back).toMatchObject({ conversation: cv.id, member: 'sam' });
  // A task in no project that an agent owns is read by the agent's owners: sam asks the household owner, and reads the answer.
  const own = s.create({ ...f.input, owner: { kind: 'agent', id: 'art' } }, { kind: 'member', id: 'sam' });
  expect((await f.call({ action: 'ask', id: own.id, input: { to: { kind: 'member', id: 'owner' }, ask: 'Agree?', ifYes: 'Go', ifNo: 'Stop' } }, 'sam', 'ask-owner')).status).toBe(200);
  const up = f.db.select().from(inbox).where(eq(inbox.waitsOnId, own.id)).get()!;
  expect((await f.call({ action: 'answer', id: own.id, question: up.id, answer: 'yes' }, 'owner', 'answer-owner')).status).toBe(200);
  expect(await items('sam')).toContain(f.db.select().from(inbox).all().find(row => row.source === 'answer' && row.sourceId === up.id)!.id);
  // Being addressed is not enough once the project is left.
  f.root.writes.run(() => f.db.delete(projectMembers).where(eq(projectMembers.member, 'lee')).run());
  expect(await items('lee')).not.toContain(answer.id);
});

it('moves tasks between projects through the one command: all of them or none, with a record on each', async () => {
  const f = fixture(), make = (patch: object = {}) => f.root.services.tasks.create({ ...f.input, ...patch }, { kind: 'member', id: 'owner' });
  const own = make(), inPond = make({ owner: { kind: 'member', id: 'lee' }, project: 'pond' }), hidden = make({ owner: { kind: 'member', id: 'lee' } });
  const projectsOf = () => f.db.select({ id: tasks.id, project: tasks.project }).from(tasks).all().map(row => row.project);
  // One task sam may not act on refuses the whole move, and so does a project sam is not in. Nothing changes and nothing is kept.
  for (const command of [{ action: 'moveToProject', ids: [own.id, hidden.id], project: 'pond' }, { action: 'moveToProject', ids: [own.id, inPond.id], project: 'other' },
    { action: 'moveToProject', ids: [inPond.id], project: null }, { action: 'moveToProject', ids: [own.id, 't-999'], project: 'pond' }]) expect((await f.call(command, 'sam', 'refused')).status).toBe(403);
  expect(projectsOf()).toEqual([null, 'pond', null]);
  expect(f.db.select().from(taskComments).all()).toEqual([]);
  expect(f.client.prepare('SELECT * FROM operation_results').all()).toEqual([]);
  // `move` is the order and takes no project; a move to a project names at least one task and where to.
  for (const command of [{ action: 'move', ids: [own.id], project: 'pond' }, { action: 'move', id: own.id, project: 'pond' }, { action: 'moveToProject', ids: [], project: 'pond' }, { action: 'moveToProject', ids: [own.id] }])
    expect((await f.call(command, 'sam', 'shape')).status).toBe(400);
  // sam moves his own task into his project. The task already there is left alone and is not in the answer.
  const moved = await f.call({ action: 'moveToProject', ids: [own.id, inPond.id], project: 'pond' }, 'sam', 'move');
  expect(await moved.json()).toEqual({ ok: true, value: { moved: [own.id] } });
  expect(projectsOf()).toEqual(['pond', 'pond', null]);
  expect(f.db.select().from(taskComments).all()).toMatchObject([{ task: own.id, actorKind: 'member', actor: 'sam', text: 'Moved from no project to project pond' }]);
  // A household owner moves anything anywhere that is in use; a removed project is refused to them too.
  expect(await (await f.call({ action: 'moveToProject', ids: [own.id, inPond.id, hidden.id], project: 'other' }, 'owner', 'owner-move')).json()).toEqual({ ok: true, value: { moved: [own.id, inPond.id, hidden.id] } });
  f.db.update(projects).set({ removedAt: new Date(f.clock.now()).toISOString() }).where(eq(projects.id, 'pond')).run();
  expect((await f.call({ action: 'moveToProject', ids: [own.id], project: 'pond' }, 'owner', 'removed')).status).toBe(403);
  expect(projectsOf()).toEqual(['other', 'other', 'other']);
  // `move` is as it was: a place in the hand-kept order.
  expect(await (await f.call({ action: 'move', id: hidden.id, before: own.id }, 'owner', 'order')).json()).toEqual({ ok: true, value: { id: hidden.id } });
  expect(f.root.services.tasks.list().map(task => task.id)).toEqual([hidden.id, own.id, inPond.id]);
});

it('makes an edit that names another project the same move: the rule, the record and the mail', async () => {
  const f = fixture(), make = (patch: object = {}) => f.root.services.tasks.create({ ...f.input, ...patch }, { kind: 'member', id: 'owner' });
  const own = make(), lees = make({ owner: { kind: 'member', id: 'lee' }, project: 'pond' });
  // sam asks himself about his own task, outside any thread, and answers: both items are private to him.
  expect((await f.call({ action: 'ask', id: own.id, input: { to: { kind: 'member', id: 'sam' }, ask: 'Spend?', ifYes: 'Buy', ifNo: 'Wait' } }, 'sam', 'ask')).status).toBe(200);
  const question = f.db.select().from(inbox).where(eq(inbox.waitsOnId, own.id)).get()!;
  expect((await f.call({ action: 'answer', id: own.id, question: question.id, answer: 'yes' }, 'sam', 'answer')).status).toBe(200);
  const mail = () => f.db.select({ project: inbox.project, member: inbox.member }).from(inbox).all();
  expect(mail()).toEqual([{ project: null, member: 'sam' }, { project: null, member: 'sam' }]);
  // Refused as the move would be: a project sam is not on, and a task that is not his made private to its owner.
  expect((await f.call({ action: 'edit', id: own.id, input: { project: 'other', title: 'Never' } }, 'sam', 'edit-other')).status).toBe(403);
  expect((await f.call({ action: 'edit', id: lees.id, input: { project: null } }, 'sam', 'edit-private')).status).toBe(403);
  expect(f.db.select().from(tasks).where(eq(tasks.id, own.id)).get()).toMatchObject({ project: null, title: 'Pump' });
  // Allowed: the task moves with the rest of the edit, its mail goes with it, and the comment says who and where.
  expect(await (await f.call({ action: 'edit', id: own.id, input: { project: 'pond', priority: 0 } }, 'sam', 'edit-pond')).json()).toEqual({ ok: true, value: { id: own.id } });
  expect(f.db.select().from(tasks).where(eq(tasks.id, own.id)).get()).toMatchObject({ project: 'pond', priority: 0 });
  expect(mail()).toEqual([{ project: 'pond', member: null }, { project: 'pond', member: null }]);
  expect(f.db.select().from(taskComments).where(eq(taskComments.task, own.id)).all().at(-1)).toMatchObject({ actorKind: 'member', actor: 'sam', text: 'Moved from no project to project pond' });
  // Nothing readable is left under the old labels: lee, who is not on pond, reads none of it; sam still does.
  const visible = (who: 'sam' | 'lee') => f.db.select().from(inbox).where(talkVisibility({ kind: 'member', id: who }).inbox(getTableColumns(inbox))).all().length;
  expect([visible('sam'), visible('lee')]).toEqual([2, 0]);
});

it('refuses a move that would leave a waiting question with someone who could not read the task there', async () => {
  const f = fixture(), make = (patch: object = {}) => f.root.services.tasks.create({ ...f.input, ...patch }, { kind: 'member', id: 'owner' });
  f.db.insert(projectMembers).values([{ project: 'pond', member: 'lee' }, { project: 'other', member: 'sam' }]).run();
  const asked = make({ project: 'pond' }), plain = make({ project: 'pond' });
  // lee is on pond, so sam may ask lee about a pond task. lee is not on other.
  expect((await f.call({ action: 'ask', id: asked.id, input: { to: { kind: 'member', id: 'lee' }, ask: 'Spend?', ifYes: 'Buy', ifNo: 'Wait' } }, 'sam', 'ask')).status).toBe(200);
  const words = `Task ${asked.id} has an unanswered question for someone who could not read it there. Have it answered, or put the question to someone who can, first`;
  const projectsOf = () => f.db.select({ project: tasks.project }).from(tasks).all().map(row => row.project);
  // To a project lee is not on, and out of every project (it is sam's task): refused in words, by a move and by an edit, and nothing moves.
  for (const [command, id] of [[{ action: 'moveToProject', ids: [plain.id, asked.id], project: 'other' }, 'move'], [{ action: 'moveToProject', ids: [asked.id], project: null }, 'private'],
    [{ action: 'edit', id: asked.id, input: { project: 'other', title: 'Never' } }, 'edit']] as const) {
    const refused = await f.call(command, 'sam', id);
    expect(refused.status, id).toBe(409);
    expect(await refused.json()).toMatchObject({ ok: false, code: 'conflict', message: words });
  }
  // A household owner is refused the same: the question is lee's to read wherever the task is.
  expect((await f.call({ action: 'moveToProject', ids: [asked.id], project: 'other' }, 'owner', 'owner-move')).status).toBe(409);
  expect(projectsOf()).toEqual(['pond', 'pond']);
  expect(f.db.select().from(tasks).where(eq(tasks.id, asked.id)).get()).toMatchObject({ title: 'Pump', ask: 'Spend?' });
  expect(f.db.select().from(taskComments).all()).toEqual([]);
  // The task with no question moves; and once lee has answered, so does the other.
  expect((await f.call({ action: 'moveToProject', ids: [plain.id], project: 'other' }, 'sam', 'plain')).status).toBe(200);
  const question = f.db.select().from(inbox).where(eq(inbox.waitsOnId, asked.id)).get()!;
  expect((await f.call({ action: 'answer', id: asked.id, question: question.id, answer: 'yes' }, 'lee', 'answer')).status).toBe(200);
  expect((await f.call({ action: 'moveToProject', ids: [asked.id], project: 'other' }, 'sam', 'after')).status).toBe(200);
  expect(projectsOf()).toEqual(['other', 'other']);
  // A question to a household owner goes anywhere: an owner reads every project.
  expect((await f.call({ action: 'ask', id: asked.id, input: { to: { kind: 'member', id: 'owner' }, ask: 'Sure?', ifYes: 'Go', ifNo: 'Stop' } }, 'sam', 'ask-owner')).status).toBe(200);
  expect((await f.call({ action: 'moveToProject', ids: [asked.id], project: 'pond' }, 'owner', 'back')).status).toBe(200);
  // And nobody is asked about a task they could not read: lee is not on other.
  expect((await f.call({ action: 'ask', id: plain.id, input: { to: { kind: 'member', id: 'lee' }, ask: 'Spend?', ifYes: 'Buy', ifNo: 'Wait' } }, 'sam', 'ask-outside')).status).toBe(403);
});


it('finishes active work and preserves a scoped claim pause for a restarted program',async()=>{
  const f=fixture(), actor={kind:'agent' as const,id:'art'};
  f.db.insert(projectAgents).values({project:'other',agent:'art'}).run();
  const make=(project:string)=>f.root.services.tasks.create({...f.input,project,owner:actor},actor);
  const active=make('pond'),next=make('pond'),elsewhere=make('other');
  expect((await f.call({action:'claim',id:active.id},'art','first')).status).toBe(200);
  const pause={project:'pond',agent:'art',paused:true,expectedRevision:0};
  const write=(root:typeof f.root,path:string,input:object,id:string,who:keyof typeof raw)=>root.http.request('/api/'+path,{
    method:'POST',headers:{'content-type':'application/json',authorization:'Bearer '+raw[who]},body:JSON.stringify({id,input})});
  expect((await write(f.root,'work/setProjectClaims',pause,'from-lee','lee')).status).toBe(403);
  expect((await write(f.root,'work/setProjectClaims',pause,'from-terminal','art')).status).toBe(403);
  const applied=await(await write(f.root,'work/setProjectClaims',pause,'pause','sam')).json();
  expect(applied).toMatchObject({ok:true,value:{paused:true,revision:1}});
  expect(await(await write(f.root,'work/setProjectClaims',pause,'pause','sam')).json()).toEqual(applied);
  const restarted=new Database(f.client.serialize());cleanup.push(()=>restarted.close());
  const second=sharedRoot({db:dataDatabase(restarted),clock:f.clock,originAllowed:()=>true,reportError:()=>{}});
  cleanup.push(()=>second.close());await second.ready;
  const ready=async(who:keyof typeof raw)=>(await(await second.http.request('/graphql',{method:'POST',headers:{
    'content-type':'application/json',authorization:'Bearer '+raw[who]},body:JSON.stringify({query:'{readyTasks{ id }}'})})).json()).data.readyTasks;
  expect(await ready('art')).toEqual([{id:elsewhere.id}]);
  expect(await ready('sam')).toEqual([{id:next.id}]);
  const command=(input:object,id:string)=>write(second,'tasks/command',input,id,'art');
  expect((await command({action:'close',id:active.id,reason:'Verified'},'finish')).status).toBe(200);
  expect(await(await command({action:'claim',id:next.id},'held')).json()).toMatchObject({ok:false});
  expect(second.services.tasks.get(next.id).status).toBe('open');
  expect((await command({action:'claim',id:elsewhere.id},'other')).status).toBe(200);
  expect((await write(second,'work/setProjectClaims',{...pause,paused:false},'stale','sam')).status).toBe(409);
  expect(await(await write(second,'work/setProjectClaims',{...pause,paused:false,expectedRevision:1},'resume','sam')).json()).toMatchObject({ok:true,value:{paused:false,revision:2}});
  expect((await command({action:'claim',id:next.id},'next')).status).toBe(200);
});
