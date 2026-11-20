import { afterEach, expect, it, vi } from 'vitest';
import { createHash, createHmac, randomBytes, randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startLoom } from '../../foundation.js';
import { fixtureSharing } from '../../fixture.js';
import { FakeClock, type Viewer } from '../../core/index.js';
import { installSecrets } from './index.js';
import { installSecretValues } from './values.js';
import type { KeyHolder } from './keyholder.js';

const homes: string[] = [], closes: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of closes.splice(0)) await close();
  for (const home of homes.splice(0)) rmSync(home, {recursive:true, force:true});
});
const owner: Viewer = {kind:'member', id:'jonathan'};
const home = () => { const path = mkdtempSync(join(tmpdir(), 'secret-retry-')); homes.push(path); return path; };
const holder = (): KeyHolder => ({names:()=>[], set:vi.fn(), remove:vi.fn(), handTo(){}, rotate(){}});
async function open(path: string, key: Uint8Array, source = holder()) {
  const app = await startLoom({home:path, clock:new FakeClock(), sharing:fixtureSharing, install:a=>{
    installSecrets(a.db, a.operations, a.live, fixtureSharing);
    installSecretValues(a.db, a.operations, fixtureSharing, source, key);
  }});
  closes.push(app.close); return app;
}
// Independent canonical encoding of this flat operation input, matching core's
// sorted-key contract without calling the implementation under test.
const canonical = (input: Record<string,string>) => JSON.stringify(Object.fromEntries(Object.entries(input).sort(([a],[b])=>a.localeCompare(b))));
const input = () => ({name:'api-key', value:'1234', mode:'add', writeId:randomUUID()});

it('persists independently calculated keyed fingerprints, not a guessable value hash or the key', async () => {
  const key = randomBytes(32), original = Buffer.from(key), source = holder();
  const app = await open(home(), key, source), data = input();
  key.fill(0); // Installation owns a snapshot, never the caller's buffer.
  const answer = app.operations.call('socket', owner, 'secrets.set', data, 'write');
  expect(answer).toEqual({ok:true, value:{saved:true}});
  const row = app.db.prepare('SELECT input_hash,result FROM core_operations WHERE id=?').get('write') as {input_hash:string; result:string};
  const body = canonical(data);
  expect(row.input_hash).toBe(createHmac('sha256', original).update('loom-secrets-operation-v1\0').update(body).digest('hex'));
  expect(row.input_hash).not.toBe(createHash('sha256').update(body).digest('hex'));
  expect(row.input_hash).not.toBe(createHmac('sha256', key).update('loom-secrets-operation-v1\0').update(body).digest('hex'));
  expect(row.result).toBe(JSON.stringify(answer));
  const tables = app.db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").all() as {name:string}[];
  const exported = JSON.stringify(tables.map(({name})=>app.db.prepare(`SELECT * FROM "${name}"`).all()));
  for (const representation of [original.toString('hex'),original.toString('base64'),JSON.stringify([...original])]) expect(exported).not.toContain(representation);
  expect(app.operations.call('socket', owner, 'secrets.set', {...data}, 'write')).toEqual(answer);
  expect(source.set).toHaveBeenCalledOnce();
  for (const change of [{value:'1235'}, {name:'other'}, {mode:'replace'}, {writeId:randomUUID()}]) {
    expect(app.operations.call('socket', owner, 'secrets.set', {...data,...change}, 'write')).toMatchObject({ok:false,code:'conflict'});
  }
  expect(source.set).toHaveBeenCalledOnce();
});

it('reuses retry receipts after restart with the same key and rejects a different key without calling the holder', async () => {
  const path = home(), key = randomBytes(32), data = input(), first = holder();
  const app = await open(path, key, first);
  const answer = app.operations.call('socket', owner, 'secrets.set', data, 'restart');
  expect(answer).toEqual({ok:true,value:{saved:true}});
  await app.close(); closes.pop();
  const second = holder(), restarted = await open(path, Buffer.from(key), second);
  expect(restarted.operations.call('socket', owner, 'secrets.set', data, 'restart')).toEqual(answer);
  expect(restarted.operations.call('socket', owner, 'secrets.set', {...data,value:'4321'}, 'restart')).toMatchObject({ok:false,code:'conflict'});
  expect(second.set).not.toHaveBeenCalled();
  await restarted.close(); closes.pop();
  const wrong = holder(), changed = await open(path, randomBytes(32), wrong);
  expect(changed.operations.call('socket', owner, 'secrets.set', data, 'restart')).toMatchObject({ok:false,code:'conflict'});
  expect(wrong.set).not.toHaveBeenCalled();
});

it('independent daemon keys produce different receipts for identical inputs', async () => {
  const data = input(), fingerprints: string[] = [];
  for (let n=0;n<2;n++) {
    const app = await open(home(), randomBytes(32));
    expect(app.operations.call('socket', owner, 'secrets.set', data, 'same')).toMatchObject({ok:true});
    fingerprints.push((app.db.prepare('SELECT input_hash FROM core_operations WHERE id=?').get('same') as {input_hash:string}).input_hash);
  }
  expect(fingerprints[0]).not.toBe(fingerprints[1]);
});

it('refuses missing or malformed keys before registering either value operation', async () => {
  const app = await startLoom({home:home(), clock:new FakeClock(), sharing:fixtureSharing}); closes.push(app.close);
  for (const key of [undefined, 'private', new Uint8Array(0), new Uint8Array(31), new Uint8Array(33)]) {
    // Deliberate untyped composition inputs exercise runtime admission, not TS.
    expect(()=>installSecretValues(app.db,app.operations,fixtureSharing,holder(),key as Uint8Array)).toThrow(/^Invalid secret retry key$/);
    expect(app.operations.has('secrets.set')).toBe(false);
    expect(app.operations.has('secrets.remove')).toBe(false);
  }
});

it('keys removal receipts and preserves exact retries and input conflicts', async () => {
  const key = randomBytes(32), source = holder(), app = await open(home(), key, source);
  expect(app.operations.call('socket', owner, 'secrets.set', input(), 'add')).toMatchObject({ok:true});
  const data = {name:'api-key',writeId:randomUUID()};
  const answer = app.operations.call('socket', owner, 'secrets.remove', data, 'remove');
  expect(answer).toEqual({ok:true,value:{removed:true}});
  const row = app.db.prepare('SELECT input_hash FROM core_operations WHERE id=?').get('remove') as {input_hash:string};
  expect(row.input_hash).toBe(createHmac('sha256',key).update('loom-secrets-operation-v1\0').update(canonical(data)).digest('hex'));
  expect(app.operations.call('socket', owner, 'secrets.remove', data, 'remove')).toEqual(answer);
  expect(app.operations.call('socket', owner, 'secrets.remove', {...data,name:'other'}, 'remove')).toMatchObject({ok:false,code:'conflict'});
  expect(source.remove).toHaveBeenCalledOnce();
});
