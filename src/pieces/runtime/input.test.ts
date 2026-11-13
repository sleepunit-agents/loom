import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { afterEach, expect, it, vi } from 'vitest';
import { startLoom } from '../../foundation.js';
import { FakeClock, type Viewer } from '../../core/index.js';
import { fixture } from '../../fixture.js';
import { signin, hash } from '../../core/signin/index.js';
import { runtimeStore } from './store.js';
const cleanups: Array<() => void | Promise<void>> = [];
afterEach(async () => { for (const close of cleanups.splice(0).reverse()) await close(); });
async function setup(staging = false) {
  const home = mkdtempSync(join(tmpdir(), 'runtime-input-'));
  cleanups.push(() => rmSync(home, { recursive: true, force: true })); fixture(home);
  const clock = new FakeClock(), app = await startLoom({ home, clock, next: true, staging, stdout: () => {} }); cleanups.push(app.close);
  const store = runtimeStore(app.db), auth = signin(app);
  app.db.transaction(() => {
    auth.tokens.replace({ v: 1, tokens: [] }, {});
    store.put('settings', { id: 'art', agent: 'art', boxes: [], house: { repo: '/fixture/art', houseFile: 'house/house.json' } }, 1);
    for (const id of ['a', 'b']) store.put('box', { id, name: id, owner: 'jonathan', local: false, mayHost: '*', lentTo: [], facts: [], labels: [], alwaysOn: false, reportOnly: false, createdAt: 1 }, 1);
    for (const id of ['j', 'other', 'private', 'terminal']) store.put('job', {
      id, agent: 'art', box: id === 'other' ? 'b' : 'a', runner: id === 'other' ? 'b' : 'a', title: id,
      state: id === 'terminal' ? 'done' : 'queued', createdAt: 1,
      ...(id === 'private' ? { member: 'jonathan' } : {}), ...(id === 'terminal' ? { endedAt: 2 } : {}),
    }, 1);
  })();
  let seq = 0;
  const call = (op: string, input: unknown, viewer: Viewer = { kind: 'runner', id: 'a' }, id = `op-${++seq}`) => app.operations.call('direct', viewer, `runtime.${op}`, input, id);
  const bearer = (runner: string) => {
    app.operations.call('direct', { kind: 'member', id: 'jonathan' }, 'signin.setPrincipal', { kind: 'runner', id: runner, active: true }, `principal-${++seq}`);
    const token = randomBytes(32).toString('hex');
    auth.tokens.change(tokens => tokens.push({ role: `runner:${runner}`, label: `test-${++seq}`, sha256: hash(token), created: new Date(clock.now()).toISOString() }));
    return token;
  };
  const post = async (token: string, op: string, input: unknown, id = `http-${++seq}`) => (await fetch(`${app.url}/api/runtime/${op}`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` }, body: JSON.stringify({ input, id }) })).json();
  const box = (set: object) => app.db.transaction(() => { const { changedAt: _, ...before } = store.read('box', 'a')!; store.put('box', { ...before, ...set }, clock.now()); })();
  return { app, home, clock, store, call, bearer, post, box };
}
it('runs the real queue/claim/input/report protocol through the next staging hold', async () => {
  const f = await setup(true), token = f.bearer('a');
  const queued = f.app.operations.call('direct', {kind:'member',id:'jonathan'}, 'runtime.queueBody',
    {agent:'art',box:'a',title:'Fixture body',brief:'private input'}, 'queue');
  expect(queued.ok).toBe(true);
  const job = (queued as {ok:true;value:{job:string}}).value.job;
  expect(await f.post(token,'claimJob',{job})).toEqual({ok:true,value:{job,state:'starting'}});
  expect(await f.post(token,'takeInput',{job})).toMatchObject({ok:false,code:'conflict'});
  expect(f.store.read('job',job)?.state).toBe('starting'); // A claim is not confirmation.
  expect(f.app.db.prepare('SELECT state FROM core_effects WHERE id=?').get(`runtime:input:${job}`)).toEqual({state:'due'});
  expect(f.app.operations.call('direct',{kind:'member',id:'jonathan'},'core.releaseEffect',{id:`runtime:input:${job}`},'release').ok).toBe(true);
  const input = await f.post(token,'takeInput',{job});
  expect(input).toEqual({ok:true,value:{job,agent:'art',brief:'private input',needs:[],house:{repo:'/fixture/art',houseFile:'house/house.json'}}});
  expect(f.store.read('job',job)?.state).toBe('starting');
  expect(await f.post(token,'takeInput',{job})).toMatchObject({ok:false,code:'conflict'});
  expect(await f.post(token,'reportJob',{job,state:'running'})).toEqual({ok:true,value:{job,state:'running'}});
  expect(await f.post(token,'finishJob',{job,state:'done',exit:0,log:'body replied'})).toEqual({ok:true,value:{job,state:'done'}});
  expect(f.store.read('job',job)?.state).toBe('done');
  expect(JSON.stringify(f.app.db.prepare('SELECT result FROM core_operations').all())).not.toContain('private input');
});
it('never discloses inputs to other runners, other caller kinds, unclaimed or private jobs', async () => {
  const f = await setup(), a = f.bearer('a'), b = f.bearer('b');
  expect(await f.post(a,'takeInput',{job:'j'})).toMatchObject({ok:false,code:'conflict'});
  expect(await f.post(a,'claimJob',{job:'j'})).toMatchObject({ok:true});
  for(const job of ['j','private','missing']) expect(await f.post(b,'takeInput',{job})).toMatchObject({ok:false,code:'denied'});
  for(const viewer of [{kind:'member',id:'jonathan'},{kind:'agent',id:'art'},{kind:'service',id:'runtime'}] as Viewer[])
    expect(await f.app.operations.callAsync('direct',viewer,'runtime.takeInput',{job:'j'})).toMatchObject({ok:false,code:'denied'});
  expect(await f.post(a,'takeInput',{job:'private'})).toMatchObject({ok:false,code:'denied'});
  expect(f.app.db.prepare('SELECT * FROM core_effects').all()).toEqual([]);
});
it('rechecks revoked boxes, hosting and house identity before releasing anything', async () => {
  const f = await setup(), token = f.bearer('a');
  expect(await f.post(token,'claimJob',{job:'j'})).toMatchObject({ok:true});
  f.app.db.prepare('INSERT INTO runtime_inputs VALUES (?,?,?)').run('j','private input','[]');
  f.box({mayHost:[]});
  expect(await f.post(token,'takeInput',{job:'j'})).toMatchObject({ok:false,code:'denied'});
  f.box({mayHost:'*'});
  expect(f.app.operations.call('direct',{kind:'member',id:'jonathan'},'runtime.configureHouse',{agent:'art',house:{repo:'/different'}},'house').ok).toBe(true);
  expect(await f.post(token,'takeInput',{job:'j'})).toMatchObject({ok:false,code:'denied'});
  f.box({revokedAt:1});
  expect(await f.post(token,'takeInput',{job:'j'})).toMatchObject({ok:false,code:'denied'});
  expect(f.app.db.prepare('SELECT * FROM core_effects').all()).toEqual([]);
});
it('normal next mode releases input once and does not offer it through synchronous or MCP calls', async () => {
  const f = await setup(), token = f.bearer('a');
  expect(await f.post(token,'claimJob',{job:'j'})).toMatchObject({ok:true});
  f.app.db.prepare('INSERT INTO runtime_inputs VALUES (?,?,?)').run('j','private input','[]');
  expect(f.call('takeInput',{job:'j'})).toMatchObject({ok:false,code:'unavailable'});
  expect(f.app.operations.offered('mcp').some(op=>op.name==='runtime.takeInput')).toBe(false);
  expect(await f.post(token,'takeInput',{job:'j',runner:'a'})).toMatchObject({ok:false,code:'invalid'});
  expect(await f.post(token,'takeInput',{job:'j'})).toMatchObject({ok:true,value:{brief:'private input'}});
  expect(await f.post(token,'takeInput',{job:'j'})).toMatchObject({ok:false,code:'conflict'});
  expect(f.app.db.prepare("SELECT * FROM core_operations WHERE name='runtime.takeInput'").all()).toEqual([]);
});
it('does not send a prepared brief after bearer revocation at the asynchronous boundary', async () => {
  const f = await setup(), token = f.bearer('a');
  expect(await f.post(token,'claimJob',{job:'j'})).toMatchObject({ok:true});
  f.app.db.prepare('INSERT INTO runtime_inputs VALUES (?,?,?)').run('j','private input','[]');
  const finish = f.app.effects!.finish;
  vi.spyOn(f.app.effects!, 'finish').mockImplementation((id, certain) => {
    finish(id,certain);
    signin(f.app).tokens.change(tokens => { for(const t of tokens) if(t.sha256===hash(token)) t.revoked = new Date(f.clock.now()).toISOString(); });
  });
  const answer = await f.post(token,'takeInput',{job:'j'});
  expect(answer).toMatchObject({ok:false,code:'denied'});
  expect(JSON.stringify(answer)).not.toContain('private input');
});
it('preserves consumed release across restart and refuses changed capabilities before creating an effect', async () => {
  const f = await setup(), token = f.bearer('a');
  expect(await f.post(token,'claimJob',{job:'j'})).toMatchObject({ok:true});
  f.app.db.prepare('INSERT INTO runtime_inputs VALUES (?,?,?)').run('j','private input','["gpu"]');
  expect(await f.post(token,'takeInput',{job:'j'})).toMatchObject({ok:false,code:'denied'});
  expect(f.app.db.prepare('SELECT * FROM core_effects').all()).toEqual([]);
  f.box({facts:['gpu:5090']});
  expect(await f.post(token,'takeInput',{job:'j'})).toMatchObject({ok:true});
  await f.app.close();
  const app = await startLoom({home:f.home,clock:f.clock,next:true,stdout:()=>{}});cleanups.push(app.close);
  expect(await app.operations.callAsync('direct',{kind:'runner',id:'a'},'runtime.takeInput',{job:'j'})).toMatchObject({ok:false,code:'conflict'});
});
it.each(['hosting','revoked','capabilities','house','policy'] as const)('rechecks %s after preparation instead of sending stale input', async kind => {
  const f = await setup(), token = f.bearer('a');
  expect(await f.post(token,'claimJob',{job:'j'})).toMatchObject({ok:true});
  f.app.db.prepare('INSERT INTO runtime_inputs VALUES (?,?,?)').run('j','private input','[]');
  const finish = f.app.effects!.finish;
  vi.spyOn(f.app.effects!, 'finish').mockImplementation((id,certain)=>{
    finish(id,certain);
    if(kind==='hosting') f.box({mayHost:[]});
    if(kind==='revoked') f.box({revokedAt:0});
    if(kind==='capabilities') f.app.db.prepare('UPDATE runtime_inputs SET needs=? WHERE job=?').run('["gpu"]','j');
    if(kind==='house') f.app.db.transaction(()=>{
      const {changedAt:_,...settings}=f.store.read('settings','art')!;
      f.store.put('settings',{...settings,house:{repo:'/changed',houseFile:'house/house.json'}},f.clock.now());
    })();
    if(kind==='policy') f.app.db.transaction(()=>{
      const {changedAt:_,...job}=f.store.read('job','j')!;
      f.store.put('job',{...job,member:'jonathan'},f.clock.now());
    })();
  });
  expect(await f.post(token,'takeInput',{job:'j'})).toMatchObject({ok:false,code:'denied'});
});
