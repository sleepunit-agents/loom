import { afterEach, expect, it, vi } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { startLoom } from '../foundation.js';
import { fixture, installFixture } from '../fixture.js';
import { FakeClock } from '../core/index.js';
import { PeopleStore } from '../backends/people.js';
import { HouseholdDatabase } from '../core/household/document.js';
import { householdCommands } from '../core/household/commands.js';
import { runHouseholdClient } from './household-client.js';
const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => { vi.useRealTimers(); vi.restoreAllMocks(); for (const close of cleanup.splice(0)) await close(); });
async function setup() {
  const home = mkdtempSync(join(tmpdir(), 'household-client-')); fixture(home);
  mkdirSync(join(home, 'commons'), { recursive: true });
  const people = new PeopleStore({ dbPath: join(home, 'commons', 'people.db') });
  people.write({ slug: 'guest', name: 'Guest' }); people.close();
  mkdirSync(join(home, 'agents', 'new-agent'), { recursive: true });
  writeFileSync(join(home, 'agents', 'new-agent', 'IDENTITY.md'), '# New agent\nPrepared context\n');
  const app = await startLoom({ home, next: true, clock: new FakeClock(), install: installFixture,
    authenticate: req => ({ viewer: req.headers.authorization === 'Bearer art-token' ? { kind: 'agent', id: 'art' } : { kind: 'member', id: req.headers.authorization === 'Bearer owner-token' ? 'jonathan' : 'pollock' }, valid: () => true }) });
  cleanup.push(async () => { await app.close(); rmSync(home, { recursive: true, force: true }); });
  const tokenFile = join(home, 'token'); writeFileSync(tokenFile, 'owner-token');
  const run = async (args: string[], request: typeof fetch = fetch, env = { LOOM_URL: app.url, LOOM_TOKEN_FILE: tokenFile }) => {
    let stdout = '', stderr = ''; const bodies: string[] = []; let elapsed = 0;
    const code = await runHouseholdClient(args, { stdout: s => stdout += s, stderr: s => stderr += s, stdin: Readable.from([]), stdinIsTTY: false, env }, {
      request: (url, init) => { bodies.push(String(init?.body)); return request(url, init); }, retry: async ms => { elapsed += ms; }, now: () => elapsed,
    });
    return { code, stdout, stderr, bodies };
  };
  return { app, home, tokenFile, run };
}
const inputs: Record<string, unknown> = {
  backup: {}, setBackup: { target: 'path:/mnt/backups', recipients: ['age1' + 'a'.repeat(40)], at: '03:17', tz: 'America/Chicago', keep: 7, required: ['tasks'] }, backupOff: {},
  profile: { agent: 'art' }, setProfile: { agent: 'art', text: 'Owner description.' }, requestProfile: { agent: 'art' }, describeSelf: { text: 'I help the household.' },
  bootstrapAgent: { agent: 'gabe', name: 'Gabe', purpose: 'Help with the garden.', voice: 'Warm and direct.', rules: 'Keep private things private.', ask: 'Before spending money.' },
  show: {}, setMember: { person: 'guest', agents: ['art'] }, removeMember: { person: 'guest' },
  addAgent: { agent: 'new-agent' }, setMemberProjects: { person: 'pollock', projects: ['other'] },
  setOwnedAgents: { person: 'pollock', agents: ['mark'] }, setAgentAccounts: { agent: 'art', accounts: { github: ['art-e-fish'] } },
  createProject: { slug: 'new-project', name: 'New project', members: [], agents: [], repositories: [] },
  setProjectMembers: { slug: 'new-project', members: ['pollock'] }, setProjectAgents: { slug: 'new-project', agents: ['art'] },
};
it('generates registry metadata/help and runs every household command through real HTTP', async () => {
  const { app, run, home, tokenFile } = await setup();
  const offered = app.operations.offered('http').filter(o => o.name.startsWith('household.') && o.cli);
  expect(offered.map(o => o.cli)).toEqual(householdCommands);
  const help = await run(['--help']); expect(help.code).toBe(0);
  for (const command of householdCommands) {
    expect(help.stdout).toContain(command.name);
    writeFileSync(tokenFile, command.name === 'describeSelf' ? 'art-token' : 'owner-token');
    const result = await run([command.name, JSON.stringify(inputs[command.name])]);
    expect(result).toMatchObject({ code: 0, stderr: '' });
    if (command.name === 'setBackup') expect(JSON.parse(result.stdout)).toMatchObject({ state: 'awaiting-runner', settings: inputs.setBackup, message: expect.stringContaining('no backup is scheduled') });
    if (command.name === 'backupOff') expect(JSON.parse(result.stdout)).toMatchObject({ state: 'off', settings: null });
    const operation = offered.find(o => o.name === `household.${command.name}`)!;
    expect(operation.output.safeParse(JSON.parse(result.stdout)).success).toBe(true);
    expect(JSON.parse(result.bodies[0]).input).toEqual(inputs[command.name]);
  }
  writeFileSync(tokenFile, 'owner-token');
  const document = new HouseholdDatabase(app.db).document()!;
  expect(document.agents).toContain('new-agent');
  expect(document.members).not.toEqual(expect.arrayContaining([expect.objectContaining({ person: 'guest' })]));
  // No client opens a local app store, even if the invoking home is contradictory.
  const result = await run(['addAgent', '{"agent":"art"}'], fetch, { LOOM_URL: app.url, LOOM_TOKEN_FILE: join(home, 'token'), LOOM_HOME: '/missing-client-home' } as NodeJS.ProcessEnv & { LOOM_URL: string; LOOM_TOKEN_FILE: string });
  expect(result).toMatchObject({ code: 0, stderr: '' });
});
it('leaves all validation and owner authorization in the daemon', async () => {
  const { app, run, tokenFile } = await setup();
  const before = new HouseholdDatabase(app.db).document();
  expect(await run(['setMember', '{"person":"guest","agents":["art"],"actor":"jonathan"}'])).toMatchObject({ code: 1, stdout: '' });
  writeFileSync(tokenFile, 'reader-token');
  for (const command of householdCommands) expect(await run([command.name, JSON.stringify(inputs[command.name])])).toMatchObject({ code: 1, stdout: '' });
  expect(new HouseholdDatabase(app.db).document()).toEqual(before);
});
it('retries a committed write with the same operation id after its response is lost', async () => {
  const { app, run } = await setup(); let calls = 0;
  const result = await run(['addAgent', '{"agent":"new-agent"}'], async (url, init) => {
    const response = await fetch(url, init);
    if (++calls === 1) { await response.body?.cancel(); throw Error('owner-token'); }
    return response;
  });
  expect(result).toMatchObject({ code: 0, stderr: '' }); expect(result.bodies).toHaveLength(2);
  expect(new Set(result.bodies).size).toBe(1);
  expect(app.db.prepare("SELECT count(*) AS n FROM core_operations WHERE name='household.addAgent'").get()).toEqual({ n: 1 });
});
it('refuses invalid usage before transport and preserves raw JSON for server validation', async () => {
  const { run } = await setup(); let calls = 0;
  const request: typeof fetch = async () => { calls++; throw Error('owner-token'); };
  for (const args of [['unknown'], ['addAgent'], ['addAgent', '[]'], ['addAgent', 'null'], ['addAgent', '{'], ['addAgent', '{}', 'extra']]) expect(await run(args, request)).toMatchObject({ code: 2, stdout: '' });
  expect(calls).toBe(0);
  const result = await run(['addAgent', '{"agent":1e400}']);
  expect(result).toMatchObject({ code: 1, stdout: '' }); expect(result.bodies[0]).toContain('1e400');
  expect(await run(['addAgent', '{}'], request)).toMatchObject({ code: 1, stdout: '', stderr: 'loom-household: loom daemon is unavailable\n' });
  expect(calls).toBe(8);
});
it('requires an explicit safe origin, refuses redirects and never echoes transport diagnostics', async () => {
  const { run, app, tokenFile } = await setup(); let calls = 0;
  const request: typeof fetch = async (_url, init) => { calls++; expect(init?.redirect).toBe('error'); return new Response(null, { status: 307 }); };
  for (const url of ['', 'ftp://example.com', 'https://user:pass@example.com', 'https://example.com/path', 'https://example.com/?query', 'https://example.com/#hash']) expect(await run(['addAgent', '{}'], request, { LOOM_URL: url, LOOM_TOKEN_FILE: tokenFile })).toMatchObject({ code: 1, stdout: '' });
  expect(calls).toBe(0);
  expect(await run(['addAgent', '{}'], request)).toMatchObject({ code: 1, stdout: '' }); expect(calls).toBe(1);
  for (const answer of [null, {}, { ok: false, message: 'owner-token' }, { ok: true }, { ok: true, value: { token: 'owner-token' } }]) {
    const result = await run(['addAgent', '{}'], async () => Response.json(answer)); expect(result).toMatchObject({ code: 1, stdout: '' }); expect(result.stderr).not.toContain('owner-token');
  }
  expect(await run(['addAgent', '{}'], request, { LOOM_URL: app.url, LOOM_TOKEN_FILE: '' })).toMatchObject({ code: 1, stdout: '' });
});

it('offers help with no environment, token file or available transport', async () => {
  for (const args of [[], ['--help'], ['-h']]) {
    let stdout = '';
    const mustNotCall = async () => { throw Error('offline help touched transport'); };
    expect(await runHouseholdClient(args, { stdout: s => stdout += s, stderr: () => {}, stdin: Readable.from([]), stdinIsTTY: false, env: {} }, { request: mustNotCall, retry: mustNotCall })).toBe(0);
    expect(stdout).toContain('usage: loom-household');
  }
});
it('survives a one-second restart and bounds immediate refusal retries to four seconds', async () => {
  const { app, tokenFile } = await setup(); let elapsed = 0; const attempts: number[] = [], bodies: string[] = [];
  let stdout = '', stderr = '';
  const io = { stdout: (s: string) => stdout += s, stderr: (s: string) => stderr += s, stdin: Readable.from([]), stdinIsTTY: false, env: { LOOM_URL: app.url, LOOM_TOKEN_FILE: tokenFile } };
  const runtime = { now: () => elapsed, retry: async (ms: number) => { elapsed += ms; }, request: (async (url, init) => {
    attempts.push(elapsed); bodies.push(String(init?.body));
    if (elapsed < 1000) throw Error('connection refused');
    return fetch(url, init);
  }) as typeof fetch };
  expect(await runHouseholdClient(['addAgent', '{"agent":"new-agent"}'], io, runtime)).toBe(0);
  expect(attempts).toEqual([0, 500, 1000]); expect(new Set(bodies).size).toBe(1); expect(stderr).toBe(''); expect(JSON.parse(stdout)).toContain('new-agent');
  for (const serverError of [false, true]) {
    elapsed = 0; attempts.length = 0; stdout = ''; stderr = '';
    runtime.request = async () => { attempts.push(elapsed); if (serverError) return new Response(null, { status: 503 }); throw Error('connection refused'); };
    expect(await runHouseholdClient(['addAgent', '{}'], io, runtime)).toBe(1);
    expect(elapsed).toBe(4000); expect(attempts).toEqual([0, 500, 1000, 1500, 2000, 2500, 3000, 3500]); expect(stdout).toBe('');
  }
});

it('cancels a stalled request at 1.5 seconds before retrying the same write', async () => {
  const { app, tokenFile } = await setup();
  vi.useFakeTimers(); vi.setSystemTime(0);
  const caps: number[] = [];
  vi.spyOn(AbortSignal, 'timeout').mockImplementation(ms => {
    caps.push(ms); const controller = new AbortController();
    setTimeout(() => controller.abort(Error('deadline')), ms); return controller.signal;
  });
  let started!: () => void;
  const firstRequest = new Promise<void>(resolve => { started = resolve; });
  let calls = 0; const bodies: string[] = []; let stdout = '';
  const result = runHouseholdClient(['addAgent', '{"agent":"new-agent"}'], {
    stdout: s => stdout += s, stderr: () => {}, stdin: Readable.from([]), stdinIsTTY: false,
    env: { LOOM_URL: app.url, LOOM_TOKEN_FILE: tokenFile },
  }, {
    now: () => Date.now(), retry: async ms => { await vi.advanceTimersByTimeAsync(ms); },
    request: (async (_url, init) => {
      bodies.push(String(init?.body));
      if (++calls > 1) return Response.json({ ok: true, value: ['new-agent'] });
      started();
      return new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(init.signal?.reason), { once: true });
      });
    }) as typeof fetch,
  });
  await firstRequest;
  expect(caps).toEqual([1500]);
  await vi.advanceTimersByTimeAsync(1499); expect(calls).toBe(1);
  await vi.advanceTimersByTimeAsync(1);
  expect(await result).toBe(0); expect(calls).toBe(2); expect(caps).toEqual([1500, 1500]);
  expect(new Set(bodies).size).toBe(1); expect(JSON.parse(stdout)).toEqual(['new-agent']);
});

it('shows only legacy summary fields from the daemon, without a write receipt', async () => {
  const { app, home, run } = await setup();
  const household = new HouseholdDatabase(app.db);
  expect(JSON.parse((await run(['show', '{}'])).stdout)).toEqual({ home, agents: ['art', 'mark', 'pond-bot'], default: 'art' });
  app.db.transaction(() => household.change(home, raw => { raw.default = 'mark'; raw.owner = 'legacy-owner'; raw.extra = { private: 'do not expose' }; }))();
  writeFileSync(join(home, 'household.json'), JSON.stringify({ v: 1, agents: ['wrong'], default: 'wrong', owner: 'wrong' }));
  const before = app.db.prepare('SELECT * FROM core_operations').all();
  const result = await run(['show', '{}']);
  expect(result).toMatchObject({ code: 0, stderr: '' });
  const h = household.household(home)!;
  expect(JSON.parse(result.stdout)).toEqual({ home, agents: h.agents, default: 'mark', owner: 'legacy-owner' });
  expect(JSON.parse(result.bodies[0])).toEqual({ input: {} });
  expect(app.db.prepare('SELECT * FROM core_operations').all()).toEqual(before);
  expect(await run(['show', '{"actor":"jonathan"}'])).toMatchObject({ code: 1, stdout: '' });
});
