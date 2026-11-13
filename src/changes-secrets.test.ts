import { afterEach, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startLoom } from './foundation.js';
import { fixture, fixtureSharing } from './fixture.js';
import { FakeClock, type Viewer } from './core/index.js';
import { installSecrets } from './pieces/secrets/index.js';
import { installSecretServices, secretUseRole } from './pieces/secrets/service.js';
import { githubSecrets } from './pieces/changes/secrets.js';
import { githubReader } from './pieces/changes/github.js';

const homes: string[] = [], closes: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of closes.splice(0)) await close();
  for (const home of homes.splice(0)) rmSync(home, {recursive: true, force: true});
});
async function setup() {
  const home = mkdtempSync(join(tmpdir(), 'changes-secret-')); homes.push(home); fixture(home);
  const config = {...fixtureSharing(), services: {changes: {types: ['change'], operations: []}}};
  const sharing = () => config, clock = new FakeClock();
  const app = await startLoom({home, next: true, staging: true, clock, sharing, install: a => {
    installSecrets(a.db, a.operations, a.live, sharing);
    installSecretServices(a.db, a.operations, sharing);
  }}); closes.push(app.close);
  let seq = 0;
  const call = (operation: string, input: unknown, viewer: Viewer = {kind: 'member', id: 'jonathan'}) =>
    app.operations.call('direct', viewer, `secrets.${operation}`, input, `changes-secret-${++seq}`);
  expect(call('describe', {name: 'github-acme', description: 'GitHub read'}).ok).toBe(true);
  const buffers: Uint8Array[] = [];
  const source = {read: vi.fn(async () => {const bytes = Buffer.from('FIXTURE-CREDENTIAL'); buffers.push(bytes); return bytes;})};
  const secrets = githubSecrets(secretUseRole(app.db, source, sharing, {kind: 'service', id: 'changes'}, () => clock.now(), app.live), {Acme: 'github-acme'});
  const request = vi.fn(async () => Response.json({data: {repository: {pullRequests: {nodes: [], pageInfo: {hasNextPage: false, endCursor: null}}}}})) as unknown as typeof fetch;
  return {app, call, clock, source, buffers, secrets, request, config};
}
it('reads GitHub through the real service grant and explicit value source, then refuses revocation', async () => {
  const {app, call, source, buffers, secrets, request} = await setup();
  const read = githubReader(secrets, request);
  await expect(read('github:acme/app', 0)).rejects.toThrow('GitHub read unavailable');
  expect(call('grant', {agent: 'changes', kind: 'secret', target: 'github-acme'}).ok).toBe(true);
  await expect(read('github:acme/app', 0)).rejects.toThrow('GitHub read unavailable');
  expect(source.read).not.toHaveBeenCalled(); expect(request).not.toHaveBeenCalled();
  expect(call('grantService', {service: 'changes', name: 'github-acme'}, {kind: 'service', id: 'changes'})).toMatchObject({ok: false, code: 'denied'});
  expect(call('grantService', {service: 'changes', name: 'github-acme'}).ok).toBe(true);
  await expect(read('github:acme/app', 0)).resolves.toEqual([]);
  expect(source.read).toHaveBeenCalledExactlyOnceWith('github-acme');
  expect(request).toHaveBeenCalledTimes(2);
  for (const [url, options] of vi.mocked(request).mock.calls) {
    expect(url).toBe('https://api.github.com/graphql');
    expect(options).toMatchObject({redirect: 'error', headers: {authorization: 'Bearer FIXTURE-CREDENTIAL'}});
  }
  expect(buffers[0].every(byte => byte === 0)).toBe(true);
  const rows = app.db.prepare('SELECT record FROM secrets_uses').all();
  expect(JSON.stringify(rows)).not.toContain('FIXTURE-CREDENTIAL');
  expect(call('revokeService', {service: 'changes', name: 'github-acme'}).ok).toBe(true);
  await expect(read('github:acme/app', 0)).rejects.toThrow('GitHub read unavailable');
  expect(source.read).toHaveBeenCalledTimes(1); expect(request).toHaveBeenCalledTimes(2);
});
it('requires an explicit owner mapping and snapshots validated bindings without fallback discovery', async () => {
  const use = {withValue: vi.fn(async <T>(_name: string, callback: (token: string) => Promise<T>) => callback('fixture'))};
  const bindings = {Acme: 'github-acme'}, secrets = githubSecrets(use, bindings);
  bindings.Acme = 'replacement';
  await expect(secrets.resolveGitHub('aCmE')).resolves.toBe('github-acme');
  for (const owner of ['other', '__proto__', 'constructor', '../acme']) await expect(secrets.resolveGitHub(owner)).rejects.toMatchObject({code: 'unavailable'});
  await expect(secrets.withValue('replacement', async () => true)).rejects.toMatchObject({code: 'denied'});
  expect(use.withValue).not.toHaveBeenCalled();
  for (const bad of [{Acme: '../token'}, {Acme: 'one', acme: 'two'}, {'bad/owner': 'one'}]) {
    expect(() => githubSecrets(use, bad)).toThrow('Invalid GitHub credential bindings');
  }
});
it.each(['revoke', 'expiry', 'uninstall', 'never'] as const)('holds the forge request if %s happens while acquiring the value', async action => {
  const {call, source, buffers, secrets, request, clock, config} = await setup();
  expect(call('grantService', {service: 'changes', name: 'github-acme', expiresAt: clock.now() + 1000}).ok).toBe(true);
  const acquire = source.read.getMockImplementation()!;
  source.read.mockImplementationOnce(async () => {
    const bytes = await acquire();
    if (action === 'revoke') expect(call('revokeService', {service: 'changes', name: 'github-acme'}).ok).toBe(true);
    if (action === 'expiry') clock.advance(1000);
    if (action === 'uninstall') delete (config.services as Record<string, unknown>).changes;
    if (action === 'never') expect(call('policy', {secrets: {'github-acme': {grant: 'never'}}}).ok).toBe(true);
    return bytes;
  });
  await expect(githubReader(secrets, request)('github:acme/app', 0)).rejects.toThrow('GitHub read unavailable');
  expect(request).not.toHaveBeenCalled(); expect(buffers[0].every(byte => byte === 0)).toBe(true);
});
it('hides holder errors and never contacts GitHub for an unmapped owner', async () => {
  const {call, source, secrets, request} = await setup();
  expect(call('grantService', {service: 'changes', name: 'github-acme'}).ok).toBe(true);
  await expect(githubReader(secrets, request)('github:other/app', 0)).rejects.toThrow('GitHub read unavailable');
  expect(source.read).not.toHaveBeenCalled();
  source.read.mockRejectedValueOnce(Error('FIXTURE-CREDENTIAL'));
  await expect(githubReader(secrets, request)('github:acme/app', 0)).rejects.toThrow('GitHub read unavailable');
  expect(request).not.toHaveBeenCalled();
});
