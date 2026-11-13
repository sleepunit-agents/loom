import { afterEach, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { format } from 'node:util';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { startLoom } from '../../foundation.js';
import { fixture, fixtureSharing } from '../../fixture.js';
import { FakeClock, type Viewer } from '../../core/index.js';
import { installSecrets } from './index.js';
import { handSecret, installSecretValues } from './values.js';
import type { KeyHolder } from './keyholder.js';
const owner: Viewer = {kind: 'member', id: 'jonathan'};
const sentinel = 'HOLDER-ACK-SECRET-SENTINEL';
const captured: string[] = [];
afterEach(() => {vi.restoreAllMocks(); captured.length = 0;});
const homes: string[] = [], closes: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of closes.splice(0)) await close();
  for (const home of homes.splice(0)) rmSync(home, {recursive: true, force: true});
});
async function setup() {
  for (const method of ['log', 'warn', 'error'] as const) vi.spyOn(console, method).mockImplementation((...args) => {captured.push(format(...args));});
  const home = mkdtempSync(join(tmpdir(), 'loom-holder-ack-')); homes.push(home); fixture(home);
  const holder: KeyHolder = {names: () => [], set() {}, remove() {}, handTo() {}, rotate() {}};
  const clock = new FakeClock();
  const app = await startLoom({home, next: true, staging: true, clock, sharing: fixtureSharing, install: a => {
    installSecrets(a.db, a.operations, a.live, fixtureSharing);
    installSecretValues(a.db, a.operations, fixtureSharing, holder);
  }}); closes.push(app.close);
  let sequence = 0;
  const call = (name: string, input: unknown, id = `ack-${++sequence}`) => app.operations.call('direct', owner, `secrets.${name}`, input, id);
  expect(call('describe', {name: 'api-key', description: 'Keep this description'}).ok).toBe(true);
  expect(call('grant', {agent: 'art', kind: 'secret', target: 'api-key'}).ok).toBe(true);
  const snapshot = () => (app.db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all() as {name: string}[])
    .map(({name}) => ({name, rows: app.db.prepare(`SELECT * FROM "${name}"`).all()}));
  return {app, holder, clock, call, snapshot};
}
const asynchronous = [
  ['resolved Promise', () => Promise.resolve(sentinel)],
  ['rejected Promise', () => Promise.reject(Error(sentinel))],
  ['native Promise with shadowed then', () => Object.defineProperty(Promise.reject(Error(sentinel)), 'then', {value: undefined})],
  ['async then method rejection', () => ({async then() {throw Error(sentinel);}})],
  ['thenable resolving to a rejected Promise', () => ({then(resolve: (v: unknown) => void) {resolve(Promise.reject(Error(sentinel)));}})],
  ['cyclic thenable output', () => {const value = {then(resolve: (v: unknown) => void) {resolve(value); return value;}}; return value;}],
  ['resolved thenable', () => ({then(resolve: (v: string) => void) {resolve(sentinel);}})],
  ['rejected thenable', () => ({then(_resolve: unknown, reject: (e: Error) => void) {reject(Error(sentinel));}})],
] as const;
it.each(asynchronous)('rejects %s for set/remove without metadata, receipts or Live; same operation can retry', async (_label, output) => {
  const {app, holder, call, snapshot} = await setup();
  const changed = vi.spyOn(app.live, 'changed');
  for (const method of ['set', 'remove'] as const) {
    const input = {name: 'api-key', writeId: randomUUID(), ...(method === 'set' ? {value: sentinel, mode: 'replace'} : {})};
    const before = snapshot();
    const attempted: unknown[][] = [];
    let acknowledge: () => unknown = output;
    // Plain adapter: Vitest spies inspect Promise.then before returning it.
    holder[method] = (...args: unknown[]) => {attempted.push(args); return acknowledge();};
    const id = `retry-${method}`;
    expect(call(method, input, id)).toEqual({ok: false, code: 'unavailable', message: `Key holder could not ${method === 'set' ? 'save' : 'remove'} the secret`});
    expect(attempted).toHaveLength(1);
    expect(snapshot()).toEqual(before); expect(changed).not.toHaveBeenCalled();
    if (method === 'set') expect(attempted[0][1]).toEqual(Buffer.alloc(Buffer.byteLength(sentinel)));
    acknowledge = () => sentinel;
    expect(call(method, input, id)).toEqual({ok: true, value: method === 'set' ? {saved: true} : {removed: true}});
    expect(attempted).toHaveLength(2);
    expect(changed).toHaveBeenCalledTimes(1);
    expect(JSON.stringify([snapshot(), changed.mock.calls])).not.toContain(sentinel);
    changed.mockClear();
  }
  // Flush Promise/thenable assimilation and rejection handlers before teardown.
  await Promise.resolve(); await Promise.resolve();
  expect(JSON.stringify(captured)).not.toContain(sentinel);
});
it.each(asynchronous)('does not count %s handoff as a released use; synchronous retry succeeds', async (_label, output) => {
  const {app, holder, clock, call, snapshot} = await setup();
  const changed = vi.spyOn(app.live, 'changed');
  let hands = 0, acknowledge: () => unknown = output;
  holder.handTo = () => {hands++; return acknowledge();};
  expect(handSecret(app.db, app.live, holder, 'art', 'api-key', 'runtime-sink', clock.now())).toBe(false);
  expect(hands).toBe(1);
  const failed = call('usage', {name: 'api-key'});
  expect(failed).toMatchObject({ok: true, value: {count: 0, lastUsedAt: null, events: [{state: 'failed', by: {kind: 'agent', id: 'art'}}]}});
  acknowledge = () => sentinel;
  expect(handSecret(app.db, app.live, holder, 'art', 'api-key', 'runtime-sink', clock.now())).toBe(true);
  expect(call('usage', {name: 'api-key'})).toMatchObject({ok: true, value: {count: 1, lastUsedAt: clock.now()}});
  expect(JSON.stringify([snapshot(), changed.mock.calls])).not.toContain(sentinel);
  await Promise.resolve(); await Promise.resolve();
  expect(JSON.stringify(captured)).not.toContain(sentinel);
});
it('redacts throwing then accessors and leaves no save receipt', async () => {
  const {app, holder, call, snapshot} = await setup();
  holder.set = () => ({get then() {throw Error(sentinel);}});
  const before = snapshot(), changed = vi.spyOn(app.live, 'changed');
  expect(call('set', {name: 'api-key', value: sentinel, mode: 'replace', writeId: randomUUID()})).toEqual({ok: false, code: 'unavailable', message: 'Key holder could not save the secret'});
  expect(snapshot()).toEqual(before); expect(changed).not.toHaveBeenCalled();
});
