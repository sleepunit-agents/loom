import Database from 'better-sqlite3';
import { afterEach, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { FakeClock } from './core/clock.js';
import { createDataSchema } from './core/data/database.js';
import { members, agents, tokens, sessions, projects, changes, approvals, approvalRecord, operationResults, inbox, projectMembers, memberAgents, approvalRules } from './core/data/schema.js';
import { sharedRoot } from './shared-root.js';
import { sharedSharing } from './shared-sharing.js';
import { mayAct, type RecordScope } from './policy.js';
import type { Approval } from './apps/approvals.js';

const cleanup: (() => void | Promise<void>)[] = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });
const hash = (value: string) => createHash('sha256').update(value).digest('hex');
const cookie = 'b'.repeat(64), token = 'a'.repeat(64), head = 'a'.repeat(40), changeId = 'github:house/pond#1';
function fixture(install = true, permissive = false, rawGates = false) {
  const client = new Database(':memory:'); cleanup.push(() => { client.close(); });
  const clock = new FakeClock(), at = new Date(clock.now()).toISOString();
  const db = createDataSchema(client, () => new Date(clock.now()).toISOString());
  db.insert(members).values({ id: 'sam', role: 'owner', joinedAt: at }).run();
  db.insert(agents).values({ id: 'art', about: '', markBg: '#000', markFg: '#fff', faceShape: 'pebble', faceEyes: 'dot' }).run();
  db.insert(projects).values({ id: 'pond', name: 'Pond' }).run();
  db.insert(tokens).values({ fingerprint: hash(token), label: 'Sam', kind: 'owner', member: 'sam', createdAt: at }).run();
  db.insert(sessions).values({ id: hash(cookie), token: hash(token), device: 'Browser', via: 'token', isAgent: false, issuedAt: at, seenAt: at, provedAt: at }).run();
  const restrictions = {approval:true,change:true};
  const scope = (row: Approval): RecordScope => ({ type: 'approval', agent: row.agent, project: row.project ?? undefined, member: row.member ?? undefined });
  // Optional fixture restrictions cannot broaden the built-in current-owner rule.
  const root = sharedRoot({ db, clock, originAllowed: () => true, reportError: () => {},
    approvedOperations: new Map([['fixture.change', () => {}]]),
    workAnswerAuthority: install ? {
      approval: (viewer, row) => rawGates ? restrictions.approval : restrictions.approval && (permissive || mayAct(viewer, scope(row), sharedSharing(db), 'household')),
      change: (viewer, row, approval) => rawGates ? restrictions.change : restrictions.change && (permissive || mayAct(viewer, { type: 'change', agent: row.agent ?? undefined, project: row.project ?? undefined }, sharedSharing(db), 'household') && mayAct(viewer, scope(approval), sharedSharing(db), 'household')),
    } : undefined,
  });
  cleanup.push(() => root.close());
  const request = () => root.writes.run(() => root.services.approvals.request({ kind: 'merge', target: `${changeId}@${head}`, agent: 'art', project: 'pond', what: 'Merge pump', why: 'Ready', askedFrom: 'loom', actingFor: 'owner', ask: 'Merge?', ifYes: 'Agent merges this head', ifNo: 'Wait' })).value;
  const send = (piece: string, input: unknown, id = 'answer') => root.http.request(`http://loom/api/${piece}/answer`, { method: 'POST', headers: { 'content-type': 'application/json', cookie: 'loom_ui=' + cookie }, body: JSON.stringify({ input, id }) });
  const seedChange = () => db.insert(changes).values({ id: changeId, repository: 'house/pond', number: 1, title: 'Pump', body: '', url: 'https://github.com/house/pond/pull/1', state: 'open', draft: false, authorLogin: 'art', project: 'pond', agent: 'art', branch: 'pump', headCommit: head, baseBranch: 'next', checks: 'passing', review: 'approved', mergeable: 'yes', waitingOn: 'you', openedAt: at, updatedAt: at }).onConflictDoNothing().run();
  seedChange();
  return { db, root, request, send, seedChange, restrictions };
}

it('installs the current-owner answer rule without custom authority callbacks', async () => {
  for (const piece of ['approvals','changes']) {
    const f = fixture(false), request = f.request();
    const input = piece === 'approvals' ? {id:request.id,answer:'allow'} : {id:changeId,head,approval:request.id,answer:'yes'};
    expect((await f.send(piece,input)).status).toBe(200);
    expect(f.root.services.approvals.get(request.id).decidedBy).toBe('sam');
  }
});

it('denies visible ordinary members for all kinds despite owned agents and execution grants, including replay after demotion', async () => {
  const f = fixture(true, true), at = '2026-11-14T00:00:00.000Z';
  const requests = [f.request(), ...(['command','setting','dangerous'] as const).map(kind => f.root.writes.run(() => f.root.services.approvals.request({kind,target:'fixture:target',agent:'art',project:'pond',what:'Fixture permission',why:'Proof',askedFrom:'loom',actingFor:'sam',ask:'Allow?',ifYes:'Apply',ifNo:'Wait',...((kind === 'setting' || kind === 'dangerous') ? {operation:'fixture.change',changeSummary:'Before: old; After: new'} : {})})).value)];
  f.root.writes.run(() => {
    f.db.insert(members).values({id:'lee',role:'owner',joinedAt:at}).run();
    f.db.insert(projectMembers).values({project:'pond',member:'sam'}).run();
    f.db.insert(memberAgents).values({member:'sam',agent:'art'}).run();
    f.db.insert(approvalRules).values((['merge','command','setting','dangerous'] as const).map(kind => ({kind,scope:'*',person:'sam',tier:'do' as const,setBy:'lee',setAt:at}))).run();
    f.db.update(members).set({role:'member'}).where(eq(members.id,'sam')).run();
  });
  const visible = await (await f.root.http.request('http://loom/graphql', {method:'POST',headers:{'content-type':'application/json',cookie:'loom_ui='+cookie},body:JSON.stringify({query:'{ approvals { id } }'})})).json();
  expect(visible.errors).toBeUndefined(); expect(visible.data.approvals).toHaveLength(4);
  for (const request of requests) expect((await f.send('approvals',{id:request.id,answer:'allow'},request.kind)).status).toBe(403);
  expect((await f.send('changes',{id:changeId,head,approval:requests[0].id,answer:'yes'})).status).toBe(403);
  expect(f.db.select().from(operationResults).all()).toEqual([]);
  f.root.writes.run(() => f.db.update(members).set({role:'owner'}).where(eq(members.id,'sam')).run());
  for (const request of requests) expect((await f.send('approvals',{id:request.id,answer:'allow'},request.kind)).status).toBe(200);
  f.root.writes.run(() => f.db.update(members).set({role:'member'}).where(eq(members.id,'sam')).run());
  for (const request of requests) expect((await f.send('approvals',{id:request.id,answer:'allow'},request.kind)).status).toBe(403);
  expect(f.db.select().from(operationResults).all()).toHaveLength(4);
});

it('binds approval answers to the current member, receipts and current supplied authority', async () => {
  const f = fixture(), request = f.request(), input = { id: request.id, answer: 'allow' };
  expect(await (await f.send('approvals', input)).json()).toEqual({ ok: true, value: { id: request.id } });
  expect((await f.send('approvals', input)).status).toBe(200);
  expect(f.root.services.approvals.get(request.id)).toMatchObject({ state: 'allowed', decidedBy: 'sam' });
  expect(f.db.select().from(approvalRecord).all().map(row => row.event)).toEqual(['request', 'allow']);
  expect((await f.send('approvals', { ...input, member: 'other' }, 'spoof')).status).toBe(400);
  f.root.writes.run(() => f.db.update(members).set({ role: 'member' }).where(eq(members.id, 'sam')).run());
  expect((await f.send('approvals', input)).status).toBe(403);
  expect(f.db.select().from(operationResults).all()).toHaveLength(1);
});

it('keeps an exact-head merge answer atomic and refuses stale replay after the head moves', async () => {
  const f = fixture(); f.seedChange(); const request = f.request();
  const input = { id: changeId, head, approval: request.id, answer: 'yes' };
  expect((await f.send('changes', { ...input, member: 'other' }, 'spoof')).status).toBe(400);
  expect(f.root.services.approvals.get(request.id).state).toBe('pending');
  expect(f.db.select().from(operationResults).all()).toEqual([]);
  expect(await (await f.send('changes', input)).json()).toEqual({ ok: true, value: { id: changeId } });
  expect(f.db.select().from(changes).get()?.waitingOn).toBe('agent');
  expect(f.root.services.approvals.get(request.id).decidedBy).toBe('sam');
  expect(f.db.select().from(inbox).all()).toEqual(expect.arrayContaining([expect.objectContaining({ toKind: 'agent', to: 'art', source: 'answer', fromKind: 'person', fromId: 'sam' })]));
  expect((await f.send('changes', input)).status).toBe(200);
  f.root.writes.run(() => f.db.update(members).set({ role: 'member' }).where(eq(members.id, 'sam')).run());
  expect((await f.send('changes', input)).status).toBe(403);
  f.root.writes.run(() => f.db.update(members).set({ role: 'owner' }).where(eq(members.id, 'sam')).run());
  f.root.writes.run(() => f.db.update(changes).set({ headCommit: 'c'.repeat(40) }).run());
  expect((await f.send('changes', input)).status).toBe(409);
  expect((await f.send('changes', input, 'fresh-stale')).status).toBe(409);
  expect(f.root.services.approvals.get(request.id).target).toBe(`${changeId}@${head}`);
  expect(f.db.select().from(operationResults).all()).toHaveLength(1);
});

it('denies through the shared HTTP door, revokes the earlier allowance and never reapplies a cached Allow', async () => {
  const f = fixture(), first = f.request();
  const allow = { id: first.id, answer: 'allow' };
  expect((await f.send('approvals', allow, 'allow')).status).toBe(200);
  const denial = f.request();
  expect((await f.send('approvals', { id: denial.id, answer: 'deny' }, 'deny')).status).toBe(200);
  expect(f.root.services.approvals.get(first.id)).toMatchObject({ state: 'denied', overriddenBy: denial.id });
  expect(f.root.services.approvals.get(denial.id)).toMatchObject({ state: 'denied', decidedBy: 'sam' });
  expect((await f.send('approvals', allow, 'allow')).status).toBe(200);
  expect(f.root.services.approvals.get(first.id).state).toBe('denied');
  expect(f.db.select().from(operationResults).all()).toHaveLength(2);
});

it('rolls a failed merge answer and its audit and receipt back without leaking the storage failure', async () => {
  const f = fixture(); f.seedChange(); const request = f.request();
  f.db.$client.exec("CREATE TRIGGER broken_change BEFORE UPDATE ON changes BEGIN SELECT RAISE(ABORT, 'private storage failure'); END");
  const response = await f.send('changes', { id: changeId, head, approval: request.id, answer: 'yes' });
  expect(response.status).toBe(503);
  expect(await response.text()).not.toContain('private storage failure');
  expect(f.root.services.approvals.get(request.id).state).toBe('pending');
  expect(f.db.select().from(approvalRecord).all().map(row => row.event)).toEqual(['request']);
  expect(f.db.select().from(operationResults).all()).toEqual([]);
  expect(f.db.select().from(changes).get()?.waitingOn).toBe('you');
});

it('denies authenticated agents even when supplied authority callbacks allow every caller', async () => {
  const f = fixture(true, true); f.seedChange(); const request = f.request(), agentToken = 'c'.repeat(64);
  f.db.insert(tokens).values({ fingerprint: hash(agentToken), label: 'Art', kind: 'agent', agent: 'art', createdAt: f.db.select().from(members).get()!.joinedAt }).run();
  for (const [piece, input] of [
    ['approvals', { id: request.id, answer: 'allow' }],
    ['changes', { id: changeId, head, approval: request.id, answer: 'yes' }],
  ] as const) {
    const response = await f.root.http.request(`http://loom/api/${piece}/answer`, { method: 'POST',
      headers: { 'content-type': 'application/json', authorization: 'Bearer ' + agentToken }, body: JSON.stringify({ input, id: 'agent-answer' }) });
    expect(response.status).toBe(403);
  }
  expect(f.root.services.approvals.get(request.id).state).toBe('pending');
  expect(f.db.select().from(changes).get()?.waitingOn).toBe('you');
  expect(f.db.select().from(operationResults).all()).toEqual([]);
});

it('rolls the answer, audit, Inbox delivery and change back when saving the outer receipt fails', async () => {
  const f = fixture(); f.seedChange(); const request = f.request(), before = f.db.select().from(inbox).all();
  f.db.$client.exec("CREATE TRIGGER broken_receipt BEFORE INSERT ON operation_results BEGIN SELECT RAISE(ABORT, 'private receipt failure'); END");
  const response = await f.send('changes', { id: changeId, head, approval: request.id, answer: 'yes' });
  expect(response.status).toBe(503);
  expect(await response.text()).not.toContain('private receipt failure');
  expect(f.root.services.approvals.get(request.id).state).toBe('pending');
  expect(f.db.select().from(changes).get()?.waitingOn).toBe('you');
  expect(f.db.select().from(approvalRecord).all().map(row => row.event)).toEqual(['request']);
  expect(f.db.select().from(inbox).all()).toEqual(before);
  expect(f.db.select().from(operationResults).all()).toEqual([]);
});

it('binds the No merge reply, revokes the allowance and preserves a current CI blocker', async () => {
  const f = fixture(); f.seedChange(); const first = f.request();
  expect((await f.send('changes', { id: changeId, head, approval: first.id, answer: 'yes' }, 'allow')).status).toBe(200);
  f.root.writes.run(() => f.db.update(changes).set({ waitingOn: 'ci', checks: 'running' }).run());
  const denial = f.request();
  expect((await f.send('changes', { id: changeId, head, approval: denial.id, answer: 'no' }, 'deny')).status).toBe(200);
  expect(f.root.services.approvals.get(denial.id)).toMatchObject({ state: 'denied', decidedBy: 'sam' });
  expect(f.root.services.approvals.get(first.id)).toMatchObject({ state: 'denied', overriddenBy: denial.id });
  expect(f.db.select().from(changes).get()).toMatchObject({ waitingOn: 'ci', checks: 'running' });
  expect(f.db.select().from(operationResults).all()).toHaveLength(2);
});

it('refuses stale merge heads through the Approvals door for fresh calls and cached replay', async () => {
  const f = fixture(), first = f.request(), second = f.request();
  const input = { id: first.id, answer: 'allow' };
  expect((await f.send('approvals', input)).status).toBe(200);
  f.root.writes.run(() => f.db.update(changes).set({ headCommit: 'c'.repeat(40) }).run());
  expect((await f.send('approvals', input)).status).toBe(409);
  expect((await f.send('approvals', { id: second.id, answer: 'allow' }, 'fresh-stale')).status).toBe(409);
  expect(f.root.services.approvals.get(second.id).state).toBe('pending');
  expect(f.root.services.approvals.get(first.id).target).toBe(`${changeId}@${head}`);
  expect(f.db.select().from(operationResults).all()).toHaveLength(1);
});

it('keeps non-merge approvals independent of the Changes cache', async () => {
  const f = fixture();
  const request = f.root.writes.run(() => f.root.services.approvals.request({ kind: 'command', target: 'runner:fixture:command', agent: 'art', what: 'Run a command', why: 'Needed', askedFrom: 'loom', actingFor: 'owner', ask: 'Run it?', ifYes: 'The agent may run it', ifNo: 'Wait' })).value;
  f.root.writes.run(() => f.db.delete(changes).run());
  expect((await f.send('approvals', { id: request.id, answer: 'allow' })).status).toBe(200);
  expect(f.root.services.approvals.get(request.id)).toMatchObject({ state: 'allowed', decidedBy: 'sam' });
});

it('honors restrictive approval and change callbacks for fresh answers and cached replay through both merge doors', async () => {
  for (const piece of ['approvals','changes']) for (const gate of ['approval','change'] as const) {
    const f = fixture(true,true), request = f.request();
    const input = piece === 'approvals' ? {id:request.id,answer:'allow'} : {id:changeId,head,approval:request.id,answer:'yes'};
    f.restrictions[gate] = false;
    expect((await f.send(piece,input,'restricted-fresh')).status).toBe(403);
    expect(f.db.select().from(operationResults).all()).toEqual([]);
    f.restrictions[gate] = true;
    expect((await f.send(piece,input,'confirmed')).status).toBe(200);
    const receipts = f.db.select().from(operationResults).all();
    f.restrictions[gate] = false;
    expect((await f.send(piece,input,'confirmed')).status).toBe(403);
    expect((await f.send(piece,input,'restricted-after-confirmation')).status).toBe(403);
    expect(f.db.select().from(operationResults).all()).toEqual(receipts);
  }
});

it('projects only the current caller owner status through the real query door and observes role changes', async () => {
  const f = fixture(true,true);
  f.root.writes.run(() => f.db.insert(members).values({id:'lee',role:'owner',joinedAt:'2026-11-14T00:00:00.000Z'}).run());
  const read = async () => (await (await f.root.http.request('http://loom/graphql',{method:'POST',headers:{'content-type':'application/json',cookie:'loom_ui='+cookie},body:JSON.stringify({query:'{ workAnswerOwner }'})})).json());
  expect(await read()).toEqual({data:{workAnswerOwner:true}});
  f.restrictions.approval=false; f.restrictions.change=false;
  expect(await read()).toEqual({data:{workAnswerOwner:true}});
  const request=f.request();
  expect((await f.send('approvals',{id:request.id,answer:'allow'})).status).toBe(403);
  expect((await f.send('changes',{id:changeId,head,approval:request.id,answer:'yes'})).status).toBe(403);
  f.root.writes.run(() => f.db.update(members).set({role:'member'}).where(eq(members.id,'sam')).run());
  expect(await read()).toEqual({data:{workAnswerOwner:false}});
  f.root.writes.run(() => f.db.update(members).set({role:'owner'}).where(eq(members.id,'sam')).run());
  expect(await read()).toEqual({data:{workAnswerOwner:true}});
});

it.each(['approvals','changes'])('requires explicit true from configured %s answer gates, including receipt replay',async piece=>{
 for(const gate of ['approval','change'] as const)for(const value of [undefined,null,1,'yes'] as const){
  const f=fixture(true,true,true),card=f.request(),input=piece==='approvals'?{id:card.id,answer:'allow'}:{id:changeId,head,approval:card.id,answer:'yes'};
  const snapshot=()=>({cards:f.db.select().from(approvals).all(),changes:f.db.select().from(changes).all(),audit:f.db.select().from(approvalRecord).all(),rules:f.db.select().from(approvalRules).all(),receipts:f.db.select().from(operationResults).all(),inbox:f.db.select().from(inbox).all()});
  (f.restrictions as Record<string,unknown>)[gate]=value;const before=snapshot();
  expect((await f.send(piece,input)).status).toBe(403);expect(snapshot()).toEqual(before);
  f.restrictions[gate]=true;expect((await f.send(piece,input)).status).toBe(200);
  const committed=snapshot();(f.restrictions as Record<string,unknown>)[gate]=value;expect((await f.send(piece,input)).status).toBe(403);expect(snapshot()).toEqual(committed);
 }
});
