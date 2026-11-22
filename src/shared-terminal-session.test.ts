import { afterEach, expect, it } from 'vitest';
import { bodyCredentials, bodyFixture, credentialHash } from '../test/fixtures/conversation-body.js';
import { eq } from 'drizzle-orm';
import { boxes, memberAgents, members, tokens } from './core/data/schema.js';

const clean: (() => void | Promise<void>)[] = [];
afterEach(async () => { for (const close of clean.splice(0).reverse()) await close(); });

it('opens a private conversation only on a credential issued for the current machine owner', async () => {
  const f = await bodyFixture(clean);
  const open = { action: 'open', machine: 'box', sessionId: 'session', harness: 'claude', model: null, cwd: '/work' };
  const call = (token: string, input = open, id = 'open') => f.root.http.request('/api/terminal/session', {
    method: 'POST', headers: { authorization: 'Bearer ' + token, 'content-type': 'application/json' },
    body: JSON.stringify({ id, input }),
  });
  for (const token of Object.values(bodyCredentials))
    expect((await call(token)).ok).toBe(false);
  const { token } = f.root.services.signin.issue({ kind: 'agent', agent: 'art', label: 'Terminal', terminalMachine: 'box' });
  const first = await call(token);
  expect(first.status).toBe(200);
  const result = await first.json();
  expect(result.value.conversation).toBeTruthy();
  expect((await (await call(token, open, 'resume')).json()).value.conversation).toBe(result.value.conversation);
  expect((await call(token, {...open, machine: 'other'}, 'other')).ok).toBe(false);
  f.db.update(boxes).set({owner:'bob'}).run();
  expect((await call(token)).ok).toBe(false);
});

it('refuses steering an observed conversation through Comms, the runtime and worker controls', async () => {
  const f = await bodyFixture(clean);
  const { token } = f.root.services.signin.issue({ kind: 'agent', agent: 'art', label: 'Terminal', terminalMachine: 'box' });
  const post = (path:string, input:unknown, bearer = token) => f.root.http.request('/api/'+path, {
    method:'POST',headers:{authorization:'Bearer '+bearer,'content-type':'application/json'},
    body:JSON.stringify({id:'request-'+path.replace('/', '-'),input}),
  });
  const result = await (await post('terminal/session',{action:'open',machine:'box',sessionId:'s',harness:'claude',model:null,cwd:'/tmp'})).json();
  const {thread,job} = result.value;
  expect((await post('comms/send',{thread,clientId:'send',words:'do work'},bodyCredentials.member)).status).toBe(403);
  expect((await post('comms/change',{thread,change:'stop'},bodyCredentials.member)).status).toBe(403);
  expect((await post('runtime/jobStop',{job,reason:'reset'},bodyCredentials.member)).status).toBe(403);
  expect(() => f.root.services.signin.issue({kind:'agent',agent:'art',job,label:'Worker'})).toThrow();
});

it('lets the agent read back, at its member\'s own terminal, what the two of them said there, and nobody else\'s talk', async () => {
  const f = await bodyFixture(clean);
  const { token } = f.root.services.signin.issue({ kind: 'agent', agent: 'art', label: 'Terminal', terminalMachine: 'box' }, 'alice');
  let n = 0;
  const post = (input: unknown, bearer = token) => f.root.http.request('/api/terminal/session', {
    method: 'POST', headers: { authorization: 'Bearer ' + bearer, 'content-type': 'application/json' }, body: JSON.stringify({ id: 'event-' + (++n), input }) });
  const key = { machine: 'box', sessionId: 's', harness: 'claude' };
  const { thread, conversation } = (await (await post({ ...key, action: 'open', model: null, cwd: '/home/alice/Code/pond' })).json()).value;
  expect((await post({ ...key, action: 'turn', role: 'member', eventId: 'm1', words: 'remember the fixture word heron' })).status).toBe(200);
  expect((await post({ ...key, action: 'turn', role: 'agent', eventId: 'a1', words: 'noted: heron' })).status).toBe(200);
  const ask = async (bearer: string, query: string) => (await (await f.root.http.request('/graphql', { method: 'POST',
    headers: { authorization: 'Bearer ' + bearer, 'content-type': 'application/json' }, body: JSON.stringify({ query }) })).json()).data;
  const threads = '{ commsThreads(agent: "art") { id title venue member } }', words = `{ commsMessages(thread: "${thread}") { seq kind sender words } }`;
  // The session is titled by the machine's name and the folder it began in, not by the machine's id.
  // It reads all of its private talk with this member: this session and the thread they already had.
  const mine = (await ask(token, threads)).commsThreads as { id: string; title: string; venue: string; member: string }[];
  expect(mine.find(row => row.id === thread)).toEqual({ id: thread, title: 'Box · claude · pond', venue: 'terminal', member: 'alice' });
  expect(mine.every(row => row.member === 'alice')).toBe(true);
  expect(mine.map(row => row.venue).sort()).toEqual(['loom', 'terminal']);
  expect((await ask(token, words)).commsMessages).toEqual([
    { seq: 1, kind: 'message', sender: 'alice', words: 'remember the fixture word heron' }, { seq: 2, kind: 'reply', sender: 'art', words: 'noted: heron' }]);
  expect((await ask(token, `{ conversations(where: { id: { eq: "${conversation}" } }) { id venue member } }`)).conversations).toEqual([{ id: conversation, venue: 'terminal', member: 'alice' }]);
  // The member reads their own, as before.
  expect((await ask(bodyCredentials.member, words)).commsMessages).toHaveLength(2);
  // The agent alone does not: its ordinary credential, and any body of it not doing this member's own work.
  for (const other of [bodyCredentials.agent]) {
    expect((await ask(other, threads)).commsThreads).toEqual([]);
    expect((await ask(other, words)).commsMessages).toEqual([]);
  }
  // Another member's private talk with the same agent is not read from this member's terminal.
  f.db.insert(memberAgents).values({ member: 'bob', agent: 'art' }).run();
  const theirs = f.root.writes.run(() => f.root.services.comms.threads.open({ agent: 'art', member: 'bob', venue: 'loom', title: 'Bob and Art' })).value;
  expect(((await ask(token, '{ commsThreads(agent: "art") { id member } }')).commsThreads as { id: string; member: string }[]).map(row => row.member).sort()).toEqual(['alice', 'alice']);
  expect((await ask(bodyCredentials.member, `{ commsMessages(thread: "${theirs.id}") { seq } }`)).commsMessages).toEqual([]);
  expect((await ask(token, `{ commsMessages(thread: "${theirs.id}") { seq } }`)).commsMessages).toEqual([]);
  // Once the machine is no longer this member's, the same credential reads none of it.
  f.root.writes.run(() => f.db.update(boxes).set({ owner: 'bob' }).run());
  expect((await ask(token, threads))?.commsThreads ?? []).toEqual([]);
});

it('puts an agent at a member\'s terminal only on a credential that member made for their own machine', async () => {
  const f = await bodyFixture(clean);
  // Two household owners. The machine is alice's.
  f.db.update(members).set({ role: 'owner' }).run();
  const bob = 'd'.repeat(64);
  f.db.insert(tokens).values({ fingerprint: credentialHash(bob), label: 'Bob', kind: 'owner', member: 'bob', createdAt: new Date(f.clock.now()).toISOString() }).run();
  const issue = async (bearer: string, label: string) => (await (await f.root.http.request('/api/signin/token', { method: 'POST',
    headers: { authorization: 'Bearer ' + bearer, 'content-type': 'application/json' }, body: JSON.stringify({ kind: 'agent', agent: 'art', label, terminalMachine: 'box' }) })).json()).value.token as string;
  const ask = async (bearer: string, query: string) => (await (await f.root.http.request('/graphql', { method: 'POST',
    headers: { authorization: 'Bearer ' + bearer, 'content-type': 'application/json' }, body: JSON.stringify({ query }) })).json()).data;
  const threads = '{ commsThreads(agent: "art") { member } }';
  const open = (bearer: string, sessionId: string) => f.root.http.request('/api/terminal/session', { method: 'POST', headers: { authorization: 'Bearer ' + bearer, 'content-type': 'application/json' },
    body: JSON.stringify({ id: 'open-' + sessionId, input: { action: 'open', machine: 'box', sessionId, harness: 'claude', model: null, cwd: '/work' } }) });
  // Another owner may still make a credential for her machine: it reports that machine's sessions, as it always
  // could, and that is all. It does not read her private talk with the agent.
  const his = await issue(bob, 'Made by bob for her machine');
  expect((await open(his, 'reported')).status).toBe(200);
  expect((await ask(his, threads))?.commsThreads ?? []).toEqual([]);
  // The one she made herself is the agent at her terminal.
  const hers = await issue(bodyCredentials.member, 'Made by alice');
  expect((await ask(hers, threads)).commsThreads.length).toBeGreaterThan(0);
  // A trusted caller inside the program that names nobody as the maker makes one that reports and no more.
  const unnamed = f.root.services.signin.issue({ kind: 'agent', agent: 'art', label: 'Unnamed', terminalMachine: 'box' }).token;
  expect((await ask(unnamed, threads))?.commsThreads ?? []).toEqual([]);
  // The reach ends with what it stands on: the member dropping the agent, leaving, or the machine being revoked.
  const ends = async (change: () => void, undo: () => void, why: string) => {
    f.root.writes.run(change);
    expect((await ask(hers, threads))?.commsThreads ?? [], why).toEqual([]);
    f.root.writes.run(undo);
    expect((await ask(hers, threads)).commsThreads.length, why + ' (undone)').toBeGreaterThan(0);
  };
  await ends(() => f.db.delete(memberAgents).where(eq(memberAgents.member, 'alice')).run(), () => f.db.insert(memberAgents).values({ member: 'alice', agent: 'art' }).run(), 'the member no longer has the agent');
  await ends(() => f.db.update(boxes).set({ revokedAt: new Date(f.clock.now()).toISOString() }).where(eq(boxes.id, 'box')).run(), () => f.db.update(boxes).set({ revokedAt: null }).where(eq(boxes.id, 'box')).run(), 'the machine was revoked');
  await ends(() => f.db.update(members).set({ removedAt: new Date(f.clock.now()).toISOString() }).where(eq(members.id, 'alice')).run(), () => f.db.update(members).set({ removedAt: null }).where(eq(members.id, 'alice')).run(), 'the member left');
});

it('titles a terminal conversation by the last part of its folder, however the path is written, within sixty characters', async () => {
  const f = await bodyFixture(clean);
  const { token } = f.root.services.signin.issue({ kind: 'agent', agent: 'art', label: 'Terminal', terminalMachine: 'box' });
  const title = async (sessionId: string, cwd: string) => {
    const opened = await (await f.root.http.request('/api/terminal/session', { method: 'POST', headers: { authorization: 'Bearer ' + token, 'content-type': 'application/json' },
      body: JSON.stringify({ id: 'open-' + sessionId, input: { action: 'open', machine: 'box', sessionId, harness: 'claude', model: null, cwd } }) })).json();
    return f.root.services.comms.threads.thread(opened.value.thread).title;
  };
  expect(await title('a', '/home/alice/clients/acme/')).toBe('Box · claude · acme');
  expect(await title('b', 'C:\\Users\\alice\\clients\\acme')).toBe('Box · claude · acme');
  expect(await title('c', '/')).toBe('Box · claude');
  expect(await title('d', '/work/line\nbreak\u0007\u2028end')).toBe('Box · claude · linebreakend');
  expect([...(await title('e', '/work/' + 'x'.repeat(200)))]).toHaveLength(60);
});

it('keeps the hook in charge of words while a separate poller reports activity', async () => {
  const f = await bodyFixture(clean);
  const {token} = f.root.services.signin.issue({kind:'agent', agent:'art', label:'Example terminal', terminalMachine:'box'}, 'alice');
  const send = async (instanceId:string, action:string, extra:Record<string,unknown> = {}, status=200) => {
    const input = {harness:'codex', machine:'box', sessionId:'example', instanceId, action, ...extra};
    const res = await f.root.http.request('/api/terminal/session', {method:'POST',
      headers:{authorization:'Bearer '+token, 'content-type':'application/json'},
      body:JSON.stringify({id:crypto.randomUUID(), input})});
    expect(res.status).toBe(status);
    return (await res.json()).value?.job;
  };
  const state = () => f.db.$client.prepare('select state from jobs where id=?').pluck().get(job);
  const cwd = {cwd:'/example'};
  let notifications = 0;
  clean.push(f.root.writes.observe(() => { notifications++; }));
  const job = await send('first','present',cwd);
  expect(notifications).toBeGreaterThan(0);
  notifications = 0;
  await send('first','pulse',cwd);
  expect(notifications).toBe(0);
  expect(state()).toBe('running');
  await send('first','idle');
  expect(notifications).toBeGreaterThan(0);
  expect(await send('second','present',cwd)).toBe(job);
  await send('first','present',cwd,409);
  await send('first','pulse',cwd);
  await send('first','idle');
  expect(state()).toBe('running');
  await send('second','idle');
  expect(state()).toBe('done');
  await send('hook','open',{...cwd,model:'native-model'});
  expect(f.db.$client.prepare('select model from jobs where id=?').pluck().get(job)).toBe('native-model');
  await send('hook','present',cwd);
  await send('hook','idle');
  await send('second','present',cwd);
  await send('second','pulse',cwd);
  await send('second','idle');
  expect(state()).toBe('running');
  await send('hook','turn',{role:'member',eventId:'m1',words:'Fixture words.'});
  expect(f.db.$client.prepare('select count(*) from turns where conversation=(select conversation from jobs where id=?)').pluck().get(job)).toBe(1);
  await send('hook','end');
  expect(state()).toBe('done');
});

it('orders retirement against both deliveries of an old presence open', async () => {
  const f = await bodyFixture(clean);
  const {token} = f.root.services.signin.issue({kind:'agent',agent:'art',label:'Terminal',terminalMachine:'box'},'alice');
  for (const arrived of [false,true]) {
    const id = crypto.randomUUID();
    const base = {sessionId:id,instanceId:id,machine:'box',harness:'codex'};
    const call = (method:string,input:unknown) => f.root.http.request('/api/terminal/'+method,{
      method:'POST',headers:{authorization:'Bearer '+token,'content-type':'application/json'},body:JSON.stringify({id,input}),
    });
    const unauthorized = await f.root.http.request('/api/terminal/retireOpen',{method:'POST',
      headers:{authorization:'Bearer '+bodyCredentials.agent,'content-type':'application/json'},body:JSON.stringify({id,input:base})});
    expect(unauthorized.status).toBe(403);
    const open = () => call('session',{...base,action:'open',cwd:'/fixture',model:null});
    if(arrived)expect((await open()).status).toBe(200);
    for(let attempt=0;attempt<2;attempt++)
      expect((await call('retireOpen',base)).status).toBe(arrived?409:200);
    expect((await open()).status).toBe(arrived?200:409);
    expect(f.db.$client.prepare('select count(*) from terminal_sessions where session_id=?').pluck().get(id)).toBe(arrived?1:0);
  }
});

it('restores a displaced live hook and preserves a deleted terminal thread through adoption', async () => {
  const f = await bodyFixture(clean);
  const {token} = f.root.services.signin.issue({kind:'agent',agent:'art',label:'Terminal',terminalMachine:'box'},'alice');
  const native = 'a'.repeat(64), legacy = crypto.randomUUID();
  const send = async (action:string,instanceId:string,extra:Record<string,unknown> = {}, status=200) => {
    const res=await f.root.http.request('/api/terminal/session',{method:'POST',
      headers:{authorization:'Bearer '+token,'content-type':'application/json'},
      body:JSON.stringify({id:crypto.randomUUID(),input:{action,instanceId,machine:'box',harness:'codex',sessionId:'legacy',...extra}})});
    expect(res.status).toBe(status);
    return (await res.json()).value;
  };
  const meta = {cwd:'/test',model:null};
  const {thread,job,conversation} = await send('open',native,meta);
  await send('usage',native,{runId:'child',description:'Test',revision:1,report:{source:'none'}});
  await send('open',legacy,meta);
  await send('adopt',legacy,{native});
  await send('idle',legacy);
  await send('turn',native,{role:'member',eventId:'one',words:'Fixture words'});
  expect(f.db.$client.prepare('select count(*) from turns where conversation=?').pluck().get(conversation)).toBe(1);
  expect(f.db.$client.prepare('select j.state from terminal_runs r join jobs j on j.id=r.job where r.parent=?').pluck().all(job)).toEqual(['running','running']);
  await send('usage',native,{runId:'finished',description:'Finished',revision:1,completed:true,report:{source:'none'}});
  await send('open',legacy,meta);
  await send('end',legacy);
  await send('adopt',legacy,{native,resume:{children:['child']}});
  const runs=f.db.$client.prepare('select r.run_id,j.state from terminal_runs r join jobs j on j.id=r.job where r.parent=? order by r.run_id').all(job);
  expect(runs).toEqual([{run_id:'child',state:'running'},{run_id:'finished',state:'done'},{run_id:'main',state:'running'}]);
  await send('turn',native,{role:'agent',eventId:'two',words:'Fixture reply'});
  f.root.services.comms!.delete(thread);
  await send('adopt',legacy,{native:null});
  await send('present',legacy,{cwd:'/test'},409);
  await send('pulse',legacy,{cwd:'/test'},409);
  await send('end',native);
  expect(f.db.$client.prepare('select thread from terminal_sessions where job=?').pluck().get(job)).toBeNull();
});

it('requires fresh confirmation before replacing a silent observer', async () => {
  const f=await bodyFixture(clean);
  const {token}=f.root.services.signin.issue({kind:'agent',agent:'art',label:'Terminal',terminalMachine:'box'},'alice');
  const post=(instanceId:string,action:string,fields:Record<string,unknown>={})=>f.root.http.request('/api/terminal/session',{
    method:'POST',headers:{authorization:'Bearer '+token,'content-type':'application/json'},
    body:JSON.stringify({id:crypto.randomUUID(),input:{sessionId:'stale',machine:'box',harness:'codex',instanceId,action,...fields}})});
  const cwd={cwd:'/test'};
  const first=await post('newer','present',cwd),{value}=await first.json();
  f.clock.advance(16*60_000);
  expect((await post('late','present',cwd)).status).toBe(409);
  await post('late','idle');
  expect(f.db.$client.prepare('select state from jobs where id=?').pluck().get(value.job)).not.toBe('done');
  expect((await post('fresh','present',{...cwd,replace:'newer'})).status).toBe(200);
  await post('newer','idle');
  expect(f.db.$client.prepare('select state from jobs where id=?').pluck().get(value.job)).toBe('running');
});
