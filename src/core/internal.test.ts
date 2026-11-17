import { z } from 'zod';
import { afterEach, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createFoundation, type Foundation } from './app.js';
import { FakeClock } from './clock.js';
import { mayAct, mayCreate, maySee, type Viewer } from '../policy.js';

const homes: string[] = [], apps: Foundation[] = [];
afterEach(() => {
  for (const app of apps.splice(0)) app.close();
  for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true });
});
function fixture() {
  const home = mkdtempSync(join(tmpdir(), 'loom-internal-')); homes.push(home);
  const app = createFoundation({ home, clock: new FakeClock() }); apps.push(app); return app;
}
const sharing = { members: {}, projects: {}, services: {} };
it('lets an installed module call another without permission, including private projections', () => {
  const app = fixture(), module = app.operations.internal('changes'), may = vi.fn(() => false);
  app.operations.register({ name: 'tasks.private', input: z.object({}), output: z.boolean(), may,
    run: ctx => maySee(ctx.viewer, { type: 'task', member: 'sam' }, sharing) });
  expect(module.call('tasks.private', {})).toEqual({ ok: true, value: true });
  expect(may).not.toHaveBeenCalled();
  expect(mayAct(module.viewer, {member:'sam'}, sharing, 'household')).toBe(true);
  expect(mayCreate(module.viewer, {member:'sam'}, sharing)).toBe(true);
});
it('does not trust names, copies, JSON, other registries, external doors or ended handles', async () => {
  const app = fixture(), other = fixture(), module = app.operations.internal('changes');
  for (const a of [app, other]) a.operations.register({ name:'tasks.private', input:z.object({}), output:z.null(), may:()=>false, run:()=>null });
  for (const viewer of [{kind:'service',id:'changes'}, {...module.viewer}, JSON.parse(JSON.stringify(module.viewer))] as Viewer[]) {
    expect(app.operations.call('direct', viewer, 'tasks.private', {})).toMatchObject({code:'denied'});
    expect(maySee(viewer, {member:'sam'}, sharing)).toBe(false);
  }
  for (const door of ['http', 'socket'] as const) {
    expect(app.operations.call(door, module.viewer, 'tasks.private', {})).toMatchObject({code:'denied'});
    expect(await app.operations.callAsync(door, module.viewer, 'tasks.private', {})).toMatchObject({code:'denied'});
  }
  expect(other.operations.call('direct', module.viewer, 'tasks.private', {})).toMatchObject({code:'denied'});
  app.operations.close();
  expect(module.call('tasks.private', {})).toMatchObject({code:'denied'});
  expect(maySee(module.viewer, {member:'sam'}, sharing)).toBe(false);
});
it('separates internal write receipts from a same-name outside caller', () => {
  const app = fixture(), module = app.operations.internal('changes'); let writes = 0;
  app.operations.register({name:'tasks.write',write:true,input:z.object({}),output:z.number(),may:()=>false,run:()=>++writes});
  expect(module.call('tasks.write', {}, 'same-id')).toEqual({ok:true,value:1});
  expect(module.call('tasks.write', {}, 'same-id')).toEqual({ok:true,value:1});
  expect(app.operations.call('http',{kind:'service',id:'changes'},'tasks.write',{},'same-id')).toMatchObject({code:'denied'});
  expect(app.operations.retryDeadline({kind:'service',id:'changes'},'same-id','tasks.write')).toBeUndefined();
  expect(writes).toBe(1);
});
it('keeps schemas, door restrictions and asynchronous preparation for installed calls', async () => {
  const app=fixture(),module=app.operations.internal('changes'),may=vi.fn(()=>false),prepare=vi.fn(async()=>42);
  app.operations.register({name:'tasks.prepared',input:z.object({value:z.number()}),output:z.number(),may,prepare,run:(_ctx,_input,ready)=>ready});
  expect(module.call('tasks.prepared',{value:1})).toMatchObject({code:'unavailable'});
  expect(await module.callAsync('tasks.prepared',{value:'bad'})).toMatchObject({code:'invalid'});
  expect(await module.callAsync('tasks.prepared',{value:1})).toEqual({ok:true,value:42});
  expect(prepare).toHaveBeenCalledOnce();expect(may).not.toHaveBeenCalled();
  app.operations.register({name:'tasks.window',doors:['socket'],input:z.object({}),output:z.null(),may,run:()=>null});
  expect(module.call('tasks.window',{})).toMatchObject({code:'denied'});
});
it('retains prepared write admission, commit and replay without policy checks', async()=>{
 const app=fixture(),module=app.operations.internal('changes'),may=vi.fn(()=>false),admit=vi.fn(),prepare=vi.fn(async()=>42),run=vi.fn((_ctx,_input,ready)=>ready);
 app.operations.register({name:'tasks.preparedWrite',write:true,recheckPolicy:true,input:z.object({}),output:z.number(),may,admit,prepare,recover:()=>undefined,run});
 expect(await module.callAsync('tasks.preparedWrite',{},'write')).toEqual({ok:true,value:42});
 expect(await module.callAsync('tasks.preparedWrite',{},'write')).toEqual({ok:true,value:42});
 expect(may).not.toHaveBeenCalled();expect(admit).toHaveBeenCalledOnce();expect(prepare).toHaveBeenCalledOnce();expect(run).toHaveBeenCalledOnce();
});
it('revokes authority across an asynchronous wait', async()=>{
 const app=fixture(),module=app.operations.internal('changes');let release!:(n:number)=>void;
 const run=vi.fn(()=>42);
 app.operations.register({name:'tasks.wait',input:z.object({}),output:z.number(),may:()=>false,prepare:()=>new Promise<number>(resolve=>{release=resolve;}),run});
 const result=module.callAsync('tasks.wait',{});app.operations.close();release(42);
 expect(await result).toMatchObject({code:'denied'});expect(run).not.toHaveBeenCalled();
});

it('preserves windowOnly and requiresWindow independently of offered doors',async()=>{
 const app=fixture(),module=app.operations.internal('changes'),run=vi.fn(()=>null);
 app.operations.register({name:'tasks.windowOnly',windowOnly:true,input:z.object({}),output:z.null(),may:()=>false,run});
 app.operations.register({name:'tasks.requiresWindow',requiresWindow:()=>true,input:z.object({}),output:z.null(),may:()=>false,run});
 for(const name of ['tasks.windowOnly','tasks.requiresWindow']){
  expect(module.call(name,{})).toMatchObject({code:'denied'});
  expect(await module.callAsync(name,{})).toMatchObject({code:'denied'});
 }
 expect(run).not.toHaveBeenCalled();
});
