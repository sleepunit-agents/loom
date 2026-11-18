import { afterEach, expect, it } from 'vitest';
import { bodyCredentials, bodyFixture } from '../test/fixtures/conversation-body.js';
import { boxes } from './core/data/schema.js';

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
