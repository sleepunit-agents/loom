import { afterEach, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { randomUUID } from 'node:crypto';
import { startLoom } from '../foundation.js';
import { fixture, fixtureSharing } from '../fixture.js';
import { FakeClock, type Viewer } from '../core/index.js';
import { installSecretValues } from '../pieces/secrets/values.js';
import { runSecretsClient } from './secrets-client.js';
import oracle from '../pieces/secrets/fixtures/command-oracle/legacy.json' with { type: 'json' };
const close: (() => Promise<void>)[] = [];
afterEach(async () => { vi.restoreAllMocks(); for (const fn of close.splice(0)) await fn(); });
async function setup(values = true) {
  const home = mkdtempSync(join(tmpdir(), 'secret-command-')); fixture(home);
  const clock = new FakeClock(Date.parse('2026-11-13T12:00:00Z'));
  const owner: Viewer = { kind: 'member', id: 'jonathan' };
  const holder = { names: () => [], set: vi.fn(), remove: vi.fn(), handTo() {}, rotate() {} };
  const app = await startLoom({ home, next: true, staging: true, clock, sharing: fixtureSharing, stdout() {},
    authenticate: request => {
      const token = request.headers.authorization;
      const viewer: Viewer | undefined = token === 'Bearer fixture-token' ? owner : token === 'Bearer restricted-token'
        ? { kind: 'member', id: 'pollock' } : token === 'Bearer agent-token' ? { kind: 'agent', id: 'art' } : undefined;
      return viewer ? { viewer, valid: () => true } : undefined;
    },
  });
  close.push(async () => { await app.close(); rmSync(home, { recursive: true, force: true }); });
  if (values) installSecretValues(app.db, app.operations, fixtureSharing, holder, Buffer.alloc(32, 5));
  const tokenFile = join(home, 'client.token'); writeFileSync(tokenFile, 'fixture-token');
  const run = async (argv: string[], options: { value?: string | Buffer; token?: string; request?: typeof fetch; tty?: boolean; env?: NodeJS.ProcessEnv } = {}) => {
    writeFileSync(tokenFile, options.token ?? 'fixture-token');
    let stdout = '', stderr = ''; const bodies: string[] = [];
    const code = await runSecretsClient(argv, {
      stdout: text => stdout += text, stderr: text => stderr += text, stdin: Readable.from(options.value === undefined ? [] : [options.value]), stdinIsTTY: options.tty ?? false,
      env: { LOOM_URL: app.url, LOOM_TOKEN_FILE: tokenFile, ...options.env },
    }, { request: async (url, init) => { bodies.push(String(init?.body)); return (options.request ?? fetch)(url, init); }, retry: async () => {} });
    return { code, stdout, stderr, bodies };
  };
  const call = (name: string, input: unknown) => app.operations.call('direct', owner, `secrets.${name}`, input, randomUUID());
  return { ...app, clock, holder, run, call };
}
it('keeps legacy sorted names, compact JSON, separate startup may output and exit codes over HTTP', async () => {
  const app = await setup();
  app.call('describe', { name: 'ZED', description: 'never output descriptions' });
  app.call('describe', { name: 'API', description: '' });
  expect(await app.run(['list'])).toMatchObject({ code: 0, stdout: 'API\nZED\n', stderr: '' });
  expect(await app.run(['list', '--json'])).toMatchObject({ code: 0, stdout: '["API","ZED"]\n', stderr: '' });
  expect(await app.run(['may', 'art', 'API'])).toMatchObject({ code: 1, stdout: "ask: API isn't given to art's houses at start: the owner allows it (loom secrets policy houses API art)\n", stderr: '' });
  expect(await app.run(['policy', 'houses', 'API', 'art'])).toMatchObject({ code: 0, stdout: '', stderr: "art's houses get API when they start\n" });
  expect(await app.run(['may', 'art', 'API', '--json'])).toMatchObject({ code: 0, stdout: '{"may":"allowed"}\n', stderr: '' });
  expect(await app.run(['policy', 'houses', 'API', 'art', '--off'])).toMatchObject({ code: 0, stdout: '', stderr: "art's houses no longer get API when they start\n" });
  app.call('policy', { default: 'auto', secrets: { API: { grant: 'never', houses: ['art'] } } });
  expect(await app.run(['may', 'art', 'API', '--json'])).toMatchObject({ code: 1, stdout: '{"may":"denied","why":"the policy never gives API out"}\n', stderr: '' });
  // Neither an Auto default nor a temporary grant becomes startup permission.
  expect(await app.run(['may', 'art', 'ZED'])).toMatchObject({ code: 1 });
});
it('matches captured outputs and exit codes from the frozen old executable on the same metadata fixture', async () => {
  const app = await setup();
  app.call('describe', { name: 'ZED', description: '' }); app.call('describe', { name: 'API', description: '' });
  const { v: _version, ...policy } = oracle.policy;
  expect(app.call('policy', policy)).toMatchObject({ ok: true });
  for (const expected of oracle.cases) {
    const { bodies: _requests, ...actual } = await app.run(expected.argv);
    const { argv: _argv, ...output } = expected;
    expect(actual).toEqual(output);
  }
});
it('reports pending, granted, expired, denied and revoked requests using the daemon clock', async () => {
  const app = await setup();
  const record = { id: 'q-01234567', agent: 'art', kind: 'secret', target: 'API', askedBy: { kind: 'agent', id: 'art' }, why: 'work', state: 'pending', createdAt: app.clock.now() };
  const save = (state: string) => app.db.prepare('INSERT OR REPLACE INTO secrets_requests VALUES (?,?)').run(record.id, JSON.stringify({ ...record, state }));
  save('pending'); expect(await app.run(['state', record.id])).toMatchObject({ code: 0, stdout: 'pending\n' });
  save('allowed'); app.db.prepare('INSERT INTO secrets_grants VALUES (?,?,?,?,?)').run('grant', 'art', 'secret', 'API', JSON.stringify({ requestId: record.id, expiresAt: app.clock.now() + 1000 }));
  expect(await app.run(['state', record.id])).toMatchObject({ code: 0, stdout: 'granted\n' });
  app.db.prepare('UPDATE secrets_grants SET record=? WHERE id=?').run(JSON.stringify({ requestId: record.id, expiresAt: app.clock.now() + 1000, movedTo: 'q-ffffffff' }), 'grant');
  expect(await app.run(['state', record.id])).toMatchObject({ code: 0, stdout: 'expired\n' });
  app.db.prepare('UPDATE secrets_grants SET record=? WHERE id=?').run(JSON.stringify({ requestId: 'q-ffffffff', expiresAt: app.clock.now() + 1000 }), 'grant');
  expect(await app.run(['state', record.id])).toMatchObject({ code: 0, stdout: 'expired\n' });
  app.db.prepare('UPDATE secrets_grants SET record=? WHERE id=?').run(JSON.stringify({ requestId: record.id, expiresAt: app.clock.now() + 1000 }), 'grant');
  await app.clock.advance(1000); expect(await app.run(['state', record.id])).toMatchObject({ code: 0, stdout: 'expired\n' });
  for (const state of ['denied', 'revoked', 'cancelled']) { save(state); expect(await app.run(['state', record.id])).toMatchObject({ code: 0, stdout: state + '\n' }); }
  expect(await app.run(['state', 'q-ffffffff'])).toMatchObject({ code: 3, stdout: '', stderr: 'loom secrets: there is no such request\n' });
});
it('accepts values only on bounded stdin and never stores or prints values or provider output', async () => {
  const app = await setup(); const sentinel = 'PRIVATE-value-sentinel-731';
  app.holder.set.mockReturnValue(sentinel);
  expect(await app.run(['add', 'API'], { value: sentinel + '\r\n' })).toMatchObject({ code: 0, stdout: '', stderr: 'stored API\n' });
  expect(app.holder.set.mock.calls[0][1]).toEqual(Buffer.alloc(Buffer.byteLength(sentinel)));
  expect(await app.run(['replace', 'API'], { value: 'next-value' })).toMatchObject({ code: 0, stdout: '', stderr: 'stored API\n' });
  expect(await app.run(['rm', 'API'])).toMatchObject({ code: 0, stdout: '', stderr: 'removed API\n' });
  const tables = app.db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as { name: string }[];
  expect(JSON.stringify(tables.map(table => app.db.prepare(`SELECT * FROM "${table.name}"`).all()))).not.toContain(sentinel);
  for (const value of ['', 'x'.repeat(65539), Buffer.from([0xff])]) expect(await app.run(['add', 'API'], { value })).toMatchObject({ code: 2, stdout: '', bodies: [] });
  expect(await app.run(['add', 'API'], { value: sentinel, tty: true })).toMatchObject({ code: 2, stdout: '', bodies: [] });
  expect(await app.run(['add', 'API', sentinel])).toMatchObject({ code: 2, stdout: '', bodies: [] });
  expect(await app.run(['add', 'API', '--force'], { value: sentinel })).toMatchObject({ code: 2, stdout: '', bodies: [] });
});
it('retries identical complete writes after dropped responses without repeating holder writes', async () => {
  const app = await setup(); let n = 0;
  const result = await app.run(['add', 'API'], { value: 'private-retry', request: async (url, init) => { const response = await fetch(url, init); if (++n === 1) throw Error('private upstream'); return response; } });
  expect(result.code).toBe(0); expect(result.bodies).toHaveLength(2); expect(result.bodies[0]).toBe(result.bodies[1]); expect(app.holder.set).toHaveBeenCalledTimes(1);
  expect(app.db.prepare("SELECT count(*) n FROM core_operations WHERE name='secrets.set'").get()).toEqual({ n: 1 });
  expect(await app.run(['list'], { request: async () => { throw Error('PRIVATE token and provider detail'); } })).toMatchObject({ code: 1, stdout: '', stderr: 'loom-secrets: loom daemon is unavailable\n' });
});
it('preserves a credential UTF-8 BOM and embedded newlines while trimming only the final newline', async () => {
  const app = await setup();
  app.holder.set.mockImplementation((_name, bytes) => { expect(bytes.toString('utf8')).toBe('\uFEFFfirst\nsecond'); });
  expect(await app.run(['add', 'API'], { value: '\uFEFFfirst\nsecond\n' })).toMatchObject({ code: 0, stdout: '', stderr: 'stored API\n' });
  expect(app.holder.set).toHaveBeenCalledOnce();
});
it('requires actual household-owner authentication and refuses unconfigured value operations', async () => {
  const app = await setup(false);
  for (const token of ['restricted-token', 'agent-token']) {
    for (const argv of [['list'], ['may', 'art', 'API'], ['state', 'q-01234567'], ['policy', 'houses', 'API', 'art']]) expect(await app.run(argv, { token })).toMatchObject({ code: 4, stdout: '' });
  }
  expect(await app.run(['add', 'API'], { value: 'secret' })).toMatchObject({ code: 3, stdout: '' });
  // Environment assertions never confer ownership or a house identity.
  expect(await app.run(['list'], { token: 'agent-token', env: { LOOM_PIECE_NAME: 'runtime', HOUSE_ID: 'h-1' } })).toMatchObject({ code: 4, stdout: '' });
});
it('rejects retired commands, malformed bindings, unsafe origins, redirects and hostile responses', async () => {
  const app = await setup();
  for (const argv of [['get', 'API', '--reveal'], ['issue', 'API'], ['bundle', 'export'], ['podman', 'API', 'x'], ['policy', 'houses-import'], ['list', '--json', '--json'], ['list', 'extra'], ['add', '../API']]) expect(await app.run(argv)).toMatchObject({ code: 2, stdout: '', bodies: [] });
  expect(await app.run(['list'], { env: { LOOM_URL: 'https://user:password@example.com' } })).toMatchObject({ code: 1, stdout: '', bodies: [] });
  expect(await app.run(['list'], { request: async (_url, init) => { expect(init?.redirect).toBe('error'); return new Response('{"ok":true,"value":{"stdout":"fixture-token","stderr":"","code":0}}'); } })).toMatchObject({ code: 1, stdout: '', stderr: 'loom-secrets: Invalid daemon response\n' });
  for (const field of ['stdout', 'stderr']) {
    const output = JSON.stringify({ ok: true, value: { stdout: '', stderr: '', code: 0, [field]: 'fixture-token' } }).replace('fixture-token', '\\u0066ixture-token');
    expect(await app.run(['list'], { request: async () => new Response(output) })).toMatchObject({ code: 1, stdout: '', stderr: 'loom-secrets: Invalid daemon response\n' });
  }
  expect(await app.run(['may', '123', 'API'])).toMatchObject({ code: 2, stdout: '' });
  expect(await app.run(['may', 'a'.repeat(41), 'API'])).toMatchObject({ code: 2, stdout: '' });
  expect(await app.run(['rm', 'API'], { request: async () => new Response('{"ok":true,"value":{"removed":true,"value":"PRIVATE"}}') })).toMatchObject({ code: 1, stdout: '', stderr: 'loom-secrets: Invalid daemon response\n' });
});
