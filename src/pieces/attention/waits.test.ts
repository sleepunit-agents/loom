import { afterEach, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { startLoom } from '../../foundation.js';
import { fixture } from '../../fixture.js';
import { FakeClock, failure, type Viewer } from '../../core/index.js';
import { installAttention } from './index.js';
import type { WaitsOn } from './role.js';
import type { AttentionWaits } from './waits.js';
const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => { vi.restoreAllMocks(); for (const close of cleanups.splice(0)) await close(); });
const owner: Viewer = { kind: 'member', id: 'jonathan' }, guest: Viewer = { kind: 'member', id: 'pollock' };
async function setup(waits?: AttentionWaits) {
  const home = mkdtempSync(join(tmpdir(), 'attention-waits-')); fixture(home);
  const app = await startLoom({ home, next: true, stdout: () => {}, clock: new FakeClock(), ...(waits ? { install: app => installAttention(app.db, app.operations, app.live, () => ({members:{jonathan:{owner:true,agents:['art']},pollock:{owner:false,agents:['pond-bot']}},projects:{},services:{}}), {}, waits) } : {}) });
  cleanups.push(async () => { await app.close(); rmSync(home, { recursive: true, force: true }); });
  let n = 0;
  const call = (name: string, input: unknown, viewer = owner, id = `wait-${++n}`) => app.operations.call('direct', viewer, name, input, id);
  const raise = (id: string, on: WaitsOn = { task: 't-1' }, extra = {}) => call('attention.raise', { id, agent: 'art', ask: 'Check the work?', source: {kind:'conversation',id:'cv-test'}, waits_on:on, ...extra });
  const check = (id: string, viewer = owner, op?: string) => call('attention.checkWait', {id}, viewer, op);
  return {app,call,raise,check};
}
it('next mode resolves only closed visible tasks, emits one central change and preserves retry receipts', async () => {
  const {app, call, raise, check} = await setup();
  expect(raise('waiting')).toMatchObject({ok:true});
  expect(check('waiting')).toMatchObject({ok:true,value:{state:'open'}});
  expect(call('tasks.close',{id:'t-1',actor:'jonathan',at:'2026-11-13T12:00:00Z'})).toMatchObject({ok:true,value:{result:{ok:true}}});
  const changes = vi.spyOn(app.live,'changed');
  const first = check('waiting',owner,'stable-check');
  expect(first).toMatchObject({ok:true,value:{state:'resolved',resolution:'t-1 is closed'}});
  if(first.ok) expect(first.value).not.toHaveProperty('answer');
  expect(changes).toHaveBeenCalledExactlyOnceWith([{type:'attention.ask',id:'waiting'}]);
  expect(check('waiting',owner,'stable-check')).toEqual(first);
  expect(check('waiting')).toEqual(first);
  expect(call('attention.answer',{id:'waiting',answer:{kind:'yes'}})).toMatchObject({code:'conflict'});
});
it('does not confuse missing or hidden tasks with completion, even for a project-visible ask', async () => {
  const {call,raise,check}=await setup();
  raise('missing',{task:'t-999'}); expect(check('missing')).toMatchObject({value:{state:'open'}});
  call('tasks.close',{id:'t-2',actor:'jonathan',at:'2026-11-13T12:00:00Z'});
  raise('hidden',{task:'t-2'},{project:'pond'});
  expect(check('hidden',guest)).toMatchObject({ok:true,value:{state:'open'}});
  expect(check('hidden')).toMatchObject({ok:true,value:{state:'resolved'}});
  raise('private',{task:'t-1'},{member:'jonathan'});
  expect(check('private',guest)).toMatchObject({code:'denied'});
});
it.each(['allowed','used','denied','expired','withdrawn'])('resolves terminal approval state %s with the original viewer and no human answer',async state=>{
  const approval=vi.fn(()=>({state})); const {raise,check}=await setup({approval});
  raise('approval',{approval:'a-12345678'});
  expect(check('approval')).toMatchObject({ok:true,value:{state:'resolved'}});
  expect(approval).toHaveBeenCalledExactlyOnceWith('a-12345678',owner);
});
it('keeps pending, unreadable, missing, throwing and unknown approval facts open',async()=>{
  let fact: {state:string}|undefined={state:'pending'};
  const {raise,check}=await setup({approval:()=>{if(fact?.state==='throw')throw Error('PRIVATE');return fact;}});
  raise('approval',{approval:'a-12345678'});
  for(const state of ['pending','unknown','__proto__','throw',undefined]) {fact=state?{state}:undefined;expect(check('approval')).toMatchObject({ok:true,value:{state:'open'}});}
});
it('does not overwrite answers, and nested resolution refusal rolls back changes and receipts',async()=>{
  const {app,call,raise,check}=await setup({task:()=>({status:'closed'})});
  raise('answered'); call('attention.answer',{id:'answered',answer:{kind:'done'}});
  expect(check('answered')).toMatchObject({value:{state:'answered',answer:{kind:'done'}}});
  raise('refused'); const before=app.db.prepare('SELECT * FROM core_operations ORDER BY rowid').all();
  const original=app.operations.call.bind(app.operations);
  vi.spyOn(app.operations,'call').mockImplementation((door,viewer,name,input,id)=>name==='attention.resolve'?failure('denied','No longer authorized'):original(door,viewer,name,input,id));
  expect(check('refused',owner,'retry')).toMatchObject({code:'denied'});
  expect(app.db.prepare('SELECT * FROM core_operations ORDER BY rowid').all()).toEqual(before);
  expect(call('attention.get',{id:'refused'})).toMatchObject({value:{state:'open'}});
  vi.restoreAllMocks(); expect(check('refused',owner,'retry')).toMatchObject({value:{state:'resolved'}});
});
it('next mode reads real approvals without spending an Allow or leaking a private state',async()=>{
  const {call,raise,check}=await setup();
  const request=call('approvals.request',{kind:'merge',target:`github:acme/app#12@${'a'.repeat(40)}`,ask:'Merge the fix?',why:'Fix the page.',if_yes:'I merge it.',if_no:'I leave it open.'},{kind:'agent',id:'art'});
  expect(request).toMatchObject({ok:true});
  const id=(request as {ok:true,value:{id:string}}).value.id;
  raise('real-approval',{approval:id},{project:'pond'});
  expect(check('real-approval')).toMatchObject({value:{state:'open'}});
  expect(call('approvals.answer',{id,action:'allow'})).toMatchObject({ok:true});
  expect(check('real-approval',guest)).toMatchObject({ok:true,value:{state:'open'}});
  expect(check('real-approval')).toMatchObject({ok:true,value:{state:'resolved',resolution:'the approval was allowed'}});
  expect(call('approvals.check',{id},{kind:'agent',id:'art'})).toMatchObject({ok:true,value:{state:'allowed'}});
});
it('has no hidden default checker, and source-managed notices cannot be reconciled',async()=>{
  const {app,raise,check}=await setup({}); raise('unconfigured');
  expect(check('unconfigured')).toMatchObject({ok:true,value:{state:'open'}});
  const {attentionSources}=await import('./index.js');
  const source=attentionSources(app.operations)!.register('example',()=>{});
  const {operation}=await import('../../core/index.js'); const {z}=await import('zod');
  app.operations.register(operation({name:'test.notice',write:true,input:z.object({}),output:z.unknown(),may:()=>true,run(ctx){source.raise(ctx,{id:'notice',ask:'Notice'});}}));
  expect(app.operations.call('direct',owner,'test.notice',{},'notice')).toMatchObject({ok:true});
  expect(check('notice')).toMatchObject({code:'denied'});
});
