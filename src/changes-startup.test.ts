import { afterEach, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startLoom } from './foundation.js';
import { FakeClock } from './core/clock.js';
import { HouseholdDatabase } from './core/household/document.js';
import { SharingDatabase } from './core/household/sharing.js';
import { change } from './pieces/changes/fixture.js';
import { replaceChanges } from './pieces/changes/store.js';

const homes: string[] = [], closes: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of closes.splice(0).reverse()) await close();
  for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true });
});
const empty = () => Response.json({data: {repository: {pullRequests: {nodes: [], pageInfo: {hasNextPage: false, endCursor: null}}}}});
async function setup(staging = false, configured = true) {
  const home = mkdtempSync(join(tmpdir(), 'changes-startup-')); homes.push(home);
  const clock = new FakeClock(), buffers: Uint8Array[] = [];
  const source = {read: vi.fn(async () => { const bytes = Buffer.from('FIXTURE-STARTUP-TOKEN'); buffers.push(bytes); return bytes; })};
  const request = vi.fn(async () => empty()) as unknown as typeof fetch;
  const app = await startLoom({home, next: true, staging, clock,
    stdout: () => {},
    changes: configured ? {source, github: {acme: 'github-acme'}, request} : undefined,
    authenticate: () => ({viewer: {kind: 'member', id: 'jonathan'}, valid: () => true}),
  }); closes.push(app.close);
  app.db.transaction(() => {
    new HouseholdDatabase(app.db).replace(home, {v: 1, agents: ['art'], members: [{person: 'jonathan', role: 'owner', agents: '*'}]});
    new SharingDatabase(app.db, home).create({slug: 'pond', name: 'Pond', repositories: ['acme/app'], members: [], agents: ['art']});
    replaceChanges(app.db, [change()]);
  })();
  let serial = 0;
  const call = (operation: string, input: unknown = {}) => app.operations.call('direct', {kind: 'member', id: 'jonathan'}, operation, input, `startup-${++serial}`);
  const status = () => app.db.prepare("SELECT value FROM changes_meta WHERE key='sync-status'").get() as {value: string} | undefined;
  const refresh = async () => {
    const previous = status()?.value;
    // Make completion distinguishable without fixed sleeps or a real clock.
    clock.advance(1);
    const response = await fetch(`${app.url}/api/changes/refresh`, {method: 'POST', headers: {'content-type': 'application/json'}, body: JSON.stringify({input: {}, id: `http-${++serial}`})});
    expect(await response.json()).toMatchObject({ok: true});
    clock.advance(0);
    await vi.waitFor(() => expect(status()?.value).not.toBe(previous));
  };
  return {app, home, clock, source, buffers, request, call, status, refresh};
}
it('starts the next-root daemon and wakes it over HTTP using only current real service grants', async () => {
  const {app, clock, source, buffers, request, call, status, refresh} = await setup();
  expect(app.operations.has('changes.commit-sync')).toBe(true);
  expect(call('secrets.describe', {name: 'github-acme', description: 'GitHub read'})).toMatchObject({ok: true});
  expect(call('secrets.grant', {agent: 'changes', kind: 'secret', target: 'github-acme'})).toMatchObject({ok: true});
  clock.advance(1);
  await vi.waitFor(() => expect(status()).toBeDefined());
  expect(JSON.parse(status()!.value)).toMatchObject({error: true});
  expect(source.read).not.toHaveBeenCalled(); expect(request).not.toHaveBeenCalled();
  expect(call('secrets.grantService', {service: 'changes', name: 'github-acme'})).toMatchObject({ok: true});
  await refresh();
  expect(JSON.parse(status()!.value)).toMatchObject({error: false, held: false});
  expect(source.read).toHaveBeenCalledExactlyOnceWith('github-acme');
  expect(request).toHaveBeenCalledTimes(2);
  expect(buffers[0].every(byte => byte === 0)).toBe(true);
  expect(call('changes.list')).toMatchObject({ok: true, value: []});
  expect(call('secrets.revokeService', {service: 'changes', name: 'github-acme'})).toMatchObject({ok: true});
  await refresh();
  expect(JSON.parse(status()!.value)).toMatchObject({error: true});
  expect(source.read).toHaveBeenCalledTimes(1);
});
it('starts in staging but holds the value source and forge even with an owner service grant', async () => {
  const {app, call, clock, source, request, status, refresh} = await setup(true);
  expect(call('secrets.describe', {name: 'github-acme', description: ''}).ok).toBe(true);
  expect(call('secrets.grantService', {service: 'changes', name: 'github-acme'}).ok).toBe(true);
  clock.advance(1); await vi.waitFor(() => expect(status()).toBeDefined());
  await refresh();
  expect(JSON.parse(status()!.value)).toMatchObject({error: false, held: true});
  expect(source.read).not.toHaveBeenCalled(); expect(request).not.toHaveBeenCalled();
  expect(call('changes.list')).toMatchObject({ok: true, value: [{id: change().id}]});
  await app.close(); clock.advance(3600000);
  expect(source.read).not.toHaveBeenCalled();
});
it('runs without credential configuration, preserving the snapshot and recording only a generic read failure', async () => {
  const {clock, call, status, source, request} = await setup(false, false);
  clock.advance(1); await vi.waitFor(() => expect(status()).toBeDefined());
  expect(JSON.parse(status()!.value)).toMatchObject({error: true});
  expect(call('changes.list')).toMatchObject({ok: true, value: [{id: change().id, syncError: 'GitHub read unavailable'}]});
  expect(source.read).not.toHaveBeenCalled(); expect(request).not.toHaveBeenCalled();
});
it('rechecks revocation after source acquisition and erases its value without contacting GitHub', async () => {
  const {call, clock, source, request, status, buffers} = await setup();
  expect(call('secrets.describe', {name: 'github-acme', description: ''}).ok).toBe(true);
  expect(call('secrets.grantService', {service: 'changes', name: 'github-acme'}).ok).toBe(true);
  const read = source.read.getMockImplementation()!;
  source.read.mockImplementationOnce(async () => {
    const bytes = await read();
    expect(call('secrets.revokeService', {service: 'changes', name: 'github-acme'}).ok).toBe(true);
    return bytes;
  });
  clock.advance(1); await vi.waitFor(() => expect(status()).toBeDefined());
  expect(JSON.parse(status()!.value)).toMatchObject({error: true});
  expect(request).not.toHaveBeenCalled(); expect(buffers[0].every(byte => byte === 0)).toBe(true);
  expect(call('changes.list')).toMatchObject({ok: true, value: [{syncError: 'GitHub read unavailable'}]});
});
it('stops a source acquisition on foundation close before any forge request or late snapshot write', async () => {
  const {app, call, clock, source, request, buffers} = await setup();
  expect(call('secrets.describe', {name: 'github-acme', description: ''}).ok).toBe(true);
  expect(call('secrets.grantService', {service: 'changes', name: 'github-acme'}).ok).toBe(true);
  let release!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  const read = source.read.getMockImplementation()!;
  let acquired!: () => void;
  const finished = new Promise<void>(resolve => { acquired = resolve; });
  source.read.mockImplementationOnce(async () => { await held; const bytes = await read(); acquired(); return bytes; });
  clock.advance(1); await vi.waitFor(() => expect(source.read).toHaveBeenCalledOnce());
  await app.close(); release(); await finished;
  await vi.waitFor(() => expect(buffers[0].every(byte => byte === 0)).toBe(true));
  clock.advance(3600000);
  expect(request).not.toHaveBeenCalled(); expect(app.db.open).toBe(false);
});
it('rebuilds service registration after restart and keeps the durable due time and pending refresh', async () => {
  const {app, home, call, clock, source, request, status} = await setup();
  expect(call('secrets.describe', {name: 'github-acme', description: ''}).ok).toBe(true);
  expect(call('secrets.grantService', {service: 'changes', name: 'github-acme'}).ok).toBe(true);
  clock.advance(1); await vi.waitFor(() => expect(status()).toBeDefined());
  const due = app.db.prepare('SELECT due FROM changes_jobs').get();
  await app.close();
  const again = await startLoom({home, next: true, clock, stdout: () => {}, changes: {source, github: {acme: 'github-acme'}, request}});
  closes.push(again.close);
  expect(again.db.prepare('SELECT due FROM changes_jobs').get()).toEqual(due);
  clock.advance(1); expect(source.read).toHaveBeenCalledTimes(1);
  expect(again.operations.call('direct', {kind: 'member', id: 'jonathan'}, 'changes.refresh', {}, 'restart-refresh').ok).toBe(true);
  // Close before the scheduled wake: durable request must survive.
  await again.close();
  const third = await startLoom({home, next: true, clock, stdout: () => {}, changes: {source, github: {acme: 'github-acme'}, request}});
  closes.push(third.close);
  clock.advance(1);
  await vi.waitFor(() => expect(source.read).toHaveBeenCalledTimes(2));
  await vi.waitFor(() => expect(third.db.prepare('SELECT due FROM changes_jobs').get()).toEqual({due: clock.now() + 180000}));
  expect(request).toHaveBeenCalledTimes(4);
});
it('refuses malformed explicit bindings at startup and releases the home for a corrected restart', async () => {
  const home = mkdtempSync(join(tmpdir(), 'changes-bad-startup-')); homes.push(home);
  const clock = new FakeClock(), source = {read: vi.fn()}, request = vi.fn() as unknown as typeof fetch;
  await expect(startLoom({home, next: true, clock, stdout: () => {}, changes: {source, github: {acme: '../token'}, request}})).rejects.toThrow('Invalid GitHub credential bindings');
  const app = await startLoom({home, next: true, clock, stdout: () => {}, changes: {source, github: {}, request}});
  closes.push(app.close);
  expect(app.operations.has('changes.commit-sync')).toBe(true);
  expect(source.read).not.toHaveBeenCalled(); expect(request).not.toHaveBeenCalled();
  expect(app.db.prepare('SELECT * FROM secrets_grants').all()).toEqual([]);
  expect(app.db.prepare('SELECT * FROM secrets_names').all()).toEqual([]);
});
