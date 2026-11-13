import { afterEach, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startLoom } from '../../foundation.js';
import { fixture, fixtureSharing } from '../../fixture.js';
import { FakeClock, type Viewer } from '../../core/index.js';
import { grantsRole, installSecrets } from './index.js';
import { installSecretValues } from './values.js';
import { installSecretServices, secretUseRole } from './service.js';
const homes: string[] = [], closes: (() => Promise<void>)[] = [];
afterEach(async () => { for (const close of closes.splice(0)) await close(); for (const h of homes.splice(0)) rmSync(h, {recursive:true, force:true}); vi.restoreAllMocks(); });
async function setup() {
  const home = mkdtempSync(join(tmpdir(), 'loom-secret-use-')); homes.push(home); fixture(home);
  const config = {...fixtureSharing(), services: {changes: {types: ['change'], operations: []}, discord: {types: [], operations: []}}};
  const sharing = () => config, clock = new FakeClock();
  const app = await startLoom({home, next:true, staging:true, clock, sharing, install: a => {
    installSecrets(a.db, a.operations, a.live, sharing);
    installSecretServices(a.db, a.operations, sharing);
    installSecretValues(a.db, a.operations, sharing, {names:()=>[], set(){}, remove(){}, rotate(){}, handTo(){}}, Buffer.alloc(32, 1));
  }}); closes.push(app.close);
  let seq=0;
  const call = (name: string, input: unknown, viewer: Viewer = {kind:'member', id:'jonathan'}, id=`use-${++seq}`) => app.operations.call('direct', viewer, `secrets.${name}`, input, id);
  expect(call('describe', {name:'github', description:'GitHub'}).ok).toBe(true);
  const buffers: Uint8Array[] = [];
  const source = {read: vi.fn(async () => {const b=Buffer.from('CREDENTIAL-SENTINEL'); buffers.push(b); return b;})};
  const role = (viewer: Viewer = {kind:'service', id:'changes'}) => secretUseRole(app.db, source, sharing, viewer, ()=>clock.now(), app.live);
  return {app, call, clock, source, role, config, buffers};
}
it('requires an owner service grant, distinguishes agent identity and rereads revoke, expiry and never', async () => {
  const {app, call, clock, source, role} = await setup();
  const use = vi.fn(async () => ({count: 2})), bound = role();
  await expect(bound.withValue('github', use)).rejects.toMatchObject({code:'denied'});
  expect(call('grant', {agent:'changes', kind:'secret', target:'github'}).ok).toBe(true);
  await expect(bound.withValue('github', use)).rejects.toMatchObject({code:'denied'});
  const grant = {service:'changes', name:'github', expiresAt:clock.now()+1000};
  for (const viewer of [{kind:'member',id:'pollock'}, {kind:'agent',id:'changes'}, {kind:'service',id:'changes'}, {kind:'runner',id:'one'}] as Viewer[]) {
    expect(call('grantService', grant, viewer)).toMatchObject({ok:false,code:'denied'});
    expect(call('revokeService', {service:'changes',name:'github'}, viewer)).toMatchObject({ok:false,code:'denied'});
  }
  expect(call('grantService', grant).ok).toBe(true);
  expect(call('revoke', {agent:'changes',kind:'secret',target:'github'}).ok).toBe(true);
  expect(grantsRole(app.db).mayUse('changes', {kind:'secret',target:'github'},clock.now())).toBe(false);
  for (const viewer of [{kind:'member',id:'jonathan'}, {kind:'agent',id:'changes'}, {kind:'service',id:'discord'}, {kind:'runner',id:'one'}] as Viewer[]) await expect(role(viewer).withValue('github',use)).rejects.toMatchObject({code:'denied'});
  expect(source.read).not.toHaveBeenCalled();
  clock.advance(999);
  await expect(bound.withValue('github',use)).resolves.toEqual({count:2});
  clock.advance(1);
  await expect(bound.withValue('github',use)).rejects.toMatchObject({code:'denied'});
  expect(call('grantService', {service:'changes',name:'github'}).ok).toBe(true);
  expect(call('policy', {secrets:{github:{grant:'never'}}}).ok).toBe(true);
  await expect(bound.withValue('github',use)).rejects.toMatchObject({code:'denied'});
  call('policy', {});
  expect(call('revokeService', {service:'changes',name:'github'}).ok).toBe(true);
  await expect(bound.withValue('github',use)).rejects.toMatchObject({code:'denied'});
  expect(use).toHaveBeenCalledTimes(1);
});
it('never stores or broadcasts value bytes or propagates holder/callback errors; erases the leased buffer', async () => {
  const {app, call, source, role, buffers} = await setup();
  call('grantService', {service:'changes',name:'github'});
  const changed = vi.spyOn(app.live,'changed');
  const logs = [vi.spyOn(console,'log'),vi.spyOn(console,'warn'),vi.spyOn(console,'error')];
  const before = app.db.prepare('SELECT * FROM core_operations').all();
  const result = await role().withValue('github', async token => {expect(token).toBe('CREDENTIAL-SENTINEL'); await Promise.resolve(); return {ok:true};});
  await expect(role().withValue('github', async token => {throw Error(token);})).rejects.toMatchObject({code:'unavailable', message:'Secret use failed'});
  source.read.mockRejectedValueOnce(Error('CREDENTIAL-SENTINEL'));
  await expect(role().withValue('github', async()=>true)).rejects.toMatchObject({message:'Secret use failed'});
  expect(buffers.every(b=>b.every(v=>v===0))).toBe(true);
  expect(changed.mock.calls.flatMap(c=>c[0]).every(c=>c.type==='secret.use')).toBe(true); expect(logs.every(s=>s.mock.calls.length===0)).toBe(true);
  expect(app.db.prepare('SELECT * FROM core_operations').all()).toEqual(before);
  const tables = app.db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as {name:string}[];
  const dump=tables.map(t=>app.db.prepare(`SELECT * FROM "${t.name.replaceAll('"','""')}"`).all());
  expect(JSON.stringify([result,dump,changed.mock.calls,...logs.map(s=>s.mock.calls)])).not.toContain('CREDENTIAL-SENTINEL');
});
it('rechecks access after holder transport waits and refuses malformed, missing or uninstalled names/services', async () => {
  const {call, source, role, buffers, config} = await setup();
  const use=vi.fn(async()=>true);
  for (const input of [{service:'absent',name:'github'},{service:'changes',name:'absent'},{service:'changes',name:'github',expiresAt:1}]) expect(call('grantService',input).ok).toBe(false);
  call('grantService',{service:'changes',name:'github'});
  for (const name of ['../github','', 'absent']) await expect(role().withValue(name,use)).rejects.toMatchObject({code:'denied'});
  expect(source.read).not.toHaveBeenCalled();
  const ordinaryRead=source.read.getMockImplementation()!;
  source.read.mockImplementationOnce(async()=>{const b=await ordinaryRead(); call('revokeService',{service:'changes',name:'github'}); return b;});
  await expect(role().withValue('github',use)).rejects.toMatchObject({message:'Secret use failed'});
  expect(buffers[0].every(v=>v===0)).toBe(true); expect(use).not.toHaveBeenCalled();
  call('grantService',{service:'changes',name:'github'});
  delete (config.services as Record<string,unknown>).changes;
  await expect(role().withValue('github',use)).rejects.toMatchObject({code:'denied'});
});

it.each(['registration', 'expiry', 'never', 'name'] as const)('rechecks %s after holder acquisition and erases bytes without invoking callback', async change => {
  const {app, call, clock, source, role, buffers, config} = await setup();
  expect(call('grantService',{service:'changes',name:'github',expiresAt:clock.now()+1000}).ok).toBe(true);
  const use=vi.fn(async()=>true), ordinaryRead=source.read.getMockImplementation()!;
  source.read.mockImplementationOnce(async()=>{
    const b=await ordinaryRead();
    if(change==='registration') delete (config.services as Record<string,unknown>).changes;
    if(change==='expiry') clock.advance(1000);
    if(change==='never') expect(call('policy',{secrets:{github:{grant:'never'}}}).ok).toBe(true);
    if(change==='name') app.db.prepare('DELETE FROM secrets_names WHERE id=?').run('github');
    return b;
  });
  await expect(role().withValue('github',use)).rejects.toMatchObject({code:'unavailable',message:'Secret use failed'});
  expect(source.read).toHaveBeenCalledTimes(1); expect(use).not.toHaveBeenCalled();
  expect(buffers).toHaveLength(1); expect(buffers[0].every(v=>v===0)).toBe(true);
});
