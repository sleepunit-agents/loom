import { it, expect, vi } from 'vitest';
import { workerProgram } from './worker-program.js';
import { containerWorkerExecutor, UPKEEP_FAILED } from './worker-container.js';
import { defaultWorkerState } from './worker-left.js';
import { WORKER_STOP, WorkerStop } from './worker-stop.js';
import { RELAY_MS } from './account-signin-relay.js';
import { BODY_EXIT, LOOM_EXIT, WORKER_EXIT } from './job-exit.js';
const plan = { command: '/builder', args: [], cwd: '/work', env: { PATH: '/bin' } };
const config = { url: 'https://loom.example', box: 'b', tokenFile: '/token', build: plan, runners: { claude: plan } };
/** A worker with container bodies: it builds each house itself, so it has no build command and no runners. */
const houseConfig = { url: config.url, box: config.box, tokenFile: config.tokenFile };
function fixture() {
  const handlers = new Map<string, () => void>();
  return { handlers, args: ['/config'], read: vi.fn(async (path: string) => path === '/config' ? JSON.stringify(config) : ' private-token\n'),
    on: (name: string, stop: () => void) => { handlers.set(name, stop); },
    off: (name: string, stop: () => void) => { expect(handlers.get(name)).toBe(stop); handlers.delete(name); },
    error: vi.fn(), control: vi.fn().mockReturnValue({}), executor: vi.fn().mockReturnValue({}), run: vi.fn().mockResolvedValue(undefined) };
}
const state = defaultWorkerState('b');
it('loads validated config and token file then wires worker-only dependencies', async () => {
  const f = fixture();
  expect(await workerProgram(f)).toBe(0);
  expect(f.read.mock.calls.map(c => c[0])).toEqual(['/config', '/token']);
  expect(f.control).toHaveBeenCalledWith({ url: config.url, token: 'private-token', signal: expect.any(AbortSignal) });
  expect(f.executor).toHaveBeenCalledWith({ ...config, state });
  // One slot for a worker whose bodies are processes, unless it is told otherwise.
  expect(f.run).toHaveBeenCalledExactlyOnceWith({ box: 'b', control: {}, executor: {}, signal: expect.any(AbortSignal), turns: expect.objectContaining({ take: expect.any(Function) }) });
  expect(f.handlers.size).toBe(0);
});
it('ends what a killed worker left before it takes any work, and gives its state directory up when it stops', async () => {
  const f = fixture(), order: string[] = [];
  f.executor.mockImplementation(given => { order.push('executor ' + given.state); return { endLeft: vi.fn(async () => { order.push('endLeft'); return { unverified: 0 }; }), close: () => { order.push('close'); } }; });
  f.run.mockImplementation(async () => { order.push('run'); });
  f.read.mockImplementation(async path => path === '/config' ? JSON.stringify({ ...config, state: '/var/lib/loom-worker' }) : 'private-token');
  expect(await workerProgram(f)).toBe(0);
  expect(order).toEqual(['executor /var/lib/loom-worker', 'endLeft', 'run', 'close']);
  expect(f.error).not.toHaveBeenCalled();
});
it('keeps its state under the temporary directory, by user and machine, when the configuration names no place', () => {
  expect(state).toMatch(/loom-worker-\d+-[0-9a-f]{16}$/); expect(state).not.toBe(defaultWorkerState('c'));
});
it.each([
  ['another worker holds the state directory', 'held', 45, 'Worker stopped: another worker is running on the state directory\n'],
  ['the state directory is not private', 'state', 44, 'Worker stopped: the state directory is not a private directory of this user\n'],
  ['what was left cannot be ended', 'left', 46, 'Worker stopped: a process a previous worker left running could not be ended\n'],
] as const)('takes no work when %s, and says which', async (_why, stage, code, line) => {
  const f = fixture(), close = vi.fn();
  if (stage === 'left') f.executor.mockReturnValue({ close, endLeft: vi.fn(async () => { throw new WorkerStop('left'); }) });
  else f.executor.mockImplementation(() => { throw new WorkerStop(stage); });
  expect(await workerProgram(f)).toBe(code);
  expect(f.run).not.toHaveBeenCalled();
  expect(f.error).toHaveBeenCalledExactlyOnceWith(line);
  if (stage === 'left') expect(close).toHaveBeenCalledOnce();
});
it('gives every way it can stop its own line and its own exit code, none of them 0', () => {
  const codes = Object.values(WORKER_STOP).map(([code]) => code), lines = Object.values(WORKER_STOP).map(([, line]) => line);
  expect(new Set(codes).size).toBe(codes.length); expect(new Set(lines).size).toBe(lines.length);
  expect(codes).not.toContain(0);
  // Kept apart from the codes a job's row carries (job-exit.ts), except the shared "unexpected" 1.
  const jobCodes: number[] = [...Object.values(BODY_EXIT), ...Object.values(WORKER_EXIT), ...Object.values(LOOM_EXIT)];
  expect(codes.filter(code => code !== 1 && jobCodes.includes(code))).toEqual([]);
});
it('tells an unreadable configuration, an invalid one, an unreadable token file and wrong arguments apart from a failed slot', async () => {
  const stopped = async (change: (f: ReturnType<typeof fixture>) => void) => {
    const f = fixture(); change(f);
    const code = await workerProgram(f);
    expect(f.error).toHaveBeenCalledOnce(); expect(f.handlers.size).toBe(0);
    return [code, f.error.mock.calls[0][0]];
  };
  expect(await stopped(f => { f.args = []; })).toEqual([40, 'Worker stopped: expected the path of one configuration file\n']);
  expect(await stopped(f => { f.read.mockRejectedValue(new Error('private path')); })).toEqual([41, 'Worker stopped: the configuration file could not be read or is not valid\n']);
  expect(await stopped(f => { f.read.mockResolvedValue('{}'); })).toEqual([41, 'Worker stopped: the configuration file could not be read or is not valid\n']);
  expect(await stopped(f => { f.read.mockImplementation(async path => { if (path === '/config') return JSON.stringify(config); throw new Error('private-token'); }); }))
    .toEqual([42, 'Worker stopped: the token file could not be read\n']);
  // The token file is read by the rule every other client reads it by (cli/connection.ts): a file `loom mcp` would refuse stops the worker too.
  for (const bad of ['', ' \n', 'two words', 'a'.repeat(8193)]) expect(await stopped(f => { f.read.mockImplementation(async path => path === '/config' ? JSON.stringify(config) : bad); }))
    .toEqual([42, 'Worker stopped: the token file could not be read\n']);
  expect(await stopped(f => { f.control.mockImplementation(() => { throw new Error('private-token'); }); })).toEqual([43, 'Worker stopped: the worker could not be set up from its configuration\n']);
  expect(await stopped(f => { f.executor.mockImplementation(() => { throw new Error('private-token'); }); })).toEqual([43, 'Worker stopped: the worker could not be set up from its configuration\n']);
  expect(await stopped(f => { f.run.mockRejectedValue(new Error('private-brief')); })).toEqual([49, 'Worker stopped: a body it started could not be ended, so it takes no more work\n']);
});
it('says so when something left is still running that it could not show to be a previous worker\'s, and goes on', async () => {
  const f = fixture(); f.executor.mockReturnValue({ endLeft: vi.fn(async () => ({ unverified: 2 })) });
  expect(await workerProgram(f)).toBe(0);
  expect(f.error).toHaveBeenCalledExactlyOnceWith('Worker left 2 process group(s) running that it could not show to be a previous worker\'s\n');
  expect(f.run).toHaveBeenCalledOnce();
});
for (const name of ['SIGINT', 'SIGTERM']) it(`cancels worker on ${name} and removes signal handlers`, async () => {
  const f = fixture();
  f.run.mockImplementation(async (args) => {
    expect(args.signal.aborted).toBe(false);
    f.handlers.get(name)!();
    expect(args.signal.aborted).toBe(true);
  });
  expect(await workerProgram(f)).toBe(0);
  expect(f.handlers.size).toBe(0);
});
it('never prints private configuration or execution diagnostics', async () => {
  for (const stage of ['read', 'control', 'executor', 'run'] as const) {
    const f = fixture();
    f[stage].mockImplementation(() => { throw new Error('private-token private-brief'); });
    expect(await workerProgram(f)).toBeGreaterThan(0);
    expect(f.error).toHaveBeenCalledOnce();
    expect(Object.values(WORKER_STOP).map(([, line]) => `Worker stopped: ${line}\n`)).toContain(f.error.mock.calls[0][0]);
    expect(f.handlers.size).toBe(0);
  }
});
it('rejects malformed configuration before reading a token or launching', async () => {
  const f = fixture(); f.read.mockResolvedValue('{}');
  expect(await workerProgram(f)).toBe(WORKER_STOP.config[0]);
  expect(f.read).toHaveBeenCalledTimes(1);
  expect(f.control).not.toHaveBeenCalled(); expect(f.executor).not.toHaveBeenCalled(); expect(f.run).not.toHaveBeenCalled();
});

const account = { account: 'subscription', owner: 'member', provider: 'provider' };
function accountFixture(mode: string, config: unknown) {
  const f = fixture(); f.args = [mode, '/account-command']; f.read.mockResolvedValue(JSON.stringify(config));
  return { ...f, output: vi.fn(),
    usage: vi.fn().mockReturnValue(vi.fn().mockResolvedValue([])) };
}
it('runs the private quota reader with account identity and returns only structured observations', async () => {
  const f = accountFixture('--account-usage', { command: plan, account, timeoutMs: 123 });
  const windows = [{ name: 'week', usage: 0.5, readAt: '2026-11-14T20:00:00Z', resetsAt: '2026-11-15T20:00:00Z', durationMs: 7 * 86400_000 }];
  const read = vi.fn().mockResolvedValue(windows); f.usage.mockReturnValue(read);
  expect(await workerProgram(f)).toBe(0);
  expect(f.usage).toHaveBeenCalledExactlyOnceWith(plan, { signal: expect.any(AbortSignal), timeoutMs: 123 });
  expect(read).toHaveBeenCalledExactlyOnceWith(account);
  expect(f.output).toHaveBeenCalledExactlyOnceWith(JSON.stringify({ ...account, windows }) + '\n');
  expect(f.run).not.toHaveBeenCalled(); expect(f.control).not.toHaveBeenCalled(); expect(f.handlers.size).toBe(0);
});
for (const mode of ['--account-usage']) {
  it(`hides private failures from ${mode}`, async () => {
    const f = accountFixture(mode, { command: plan, account });
    f.usage.mockReturnValue(vi.fn().mockRejectedValue(new Error('private credential')));
    expect(await workerProgram(f)).toBe(50); expect(f.output).not.toHaveBeenCalled();
    expect(f.usage).toHaveBeenCalledOnce(); expect(f.usage.mock.results[0].value).toHaveBeenCalledOnce();
    expect(f.error).toHaveBeenCalledExactlyOnceWith('Worker stopped: the account command did not complete\n');
    expect(f.handlers.size).toBe(0);
  });
  it(`cancels ${mode} and refuses a late successful observation`, async () => {
    const f = accountFixture(mode, { command: plan, account });
    f.usage.mockImplementation((_plan, options) => async () => {
      f.handlers.get('SIGTERM')!(); expect(options.signal.aborted).toBe(true); return [];
    });
    expect(await workerProgram(f)).toBe(50); expect(f.output).not.toHaveBeenCalled();
    expect(f.handlers.size).toBe(0);
  });
  it(`rejects unrecognized config in ${mode} before any private command or token read`, async () => {
    const f = accountFixture(mode, { command: plan, account, tokenFile: '/private-token' });
    expect(await workerProgram(f)).toBe(WORKER_STOP.config[0]); expect(f.read).toHaveBeenCalledTimes(1);
    expect(f.usage).not.toHaveBeenCalled(); expect(f.output).not.toHaveBeenCalled();
  });
}

it('passes a configured build deadline to the executor', async () => {
  const f = fixture();
  f.read.mockImplementation(async path => path === '/config' ? JSON.stringify({ ...config, buildTimeoutMs: 1_234 }) : 'private-token');
  expect(await workerProgram(f)).toBe(0);
  expect(f.executor).toHaveBeenCalledWith({ ...config, buildTimeoutMs: 1_234, state });
});
for (const buildTimeoutMs of [0, 1.5, 3_600_001]) it(`rejects invalid configured deadline ${buildTimeoutMs} before launching`, async () => {
  const f = fixture();
  f.read.mockResolvedValue(JSON.stringify({ ...config, buildTimeoutMs }));
  expect(await workerProgram(f)).toBe(WORKER_STOP.config[0]);
  expect(f.read).toHaveBeenCalledTimes(1);
  expect(f.executor).not.toHaveBeenCalled();
});


it('selects the actual container executor when configured, without invoking a host runner', async () => {
  const f = fixture(), containerExecutor = vi.fn().mockReturnValue({ container: true });
  const selected = { ...houseConfig, container: { socket: '/configured/docker.sock', nestedSocket: '/configured/nested.sock', setupTimeoutMs: 200, cleanupTimeoutMs: 300 } };
  f.read.mockImplementation(async path => path === '/config' ? JSON.stringify(selected) : 'private-token');
  expect(await workerProgram({ ...f, containerExecutor })).toBe(0);
  expect(containerExecutor).toHaveBeenCalledExactlyOnceWith({ ...selected, state }, { say: expect.any(Function) });
  expect(f.executor).not.toHaveBeenCalled();
  expect(f.run).toHaveBeenCalledWith(expect.objectContaining({ executor: { container: true } }));
});
for (const container of [{ socket: 7 }, { nestedSocket: '/docker.sock' }, { socket: '/docker.sock', privileged: true }, { socket: '/docker.sock', cleanupTimeoutMs: 0 }]) {
  it('rejects malformed container configuration before reading worker credentials', async () => {
    const f = fixture(), containerExecutor = vi.fn();
    f.read.mockResolvedValue(JSON.stringify({ ...config, container }));
    expect(await workerProgram({ ...f, containerExecutor })).toBe(WORKER_STOP.config[0]);
    expect(f.read).toHaveBeenCalledTimes(1); expect(containerExecutor).not.toHaveBeenCalled(); expect(f.run).not.toHaveBeenCalled();
  });
}

it('passes explicit account and harness runner bindings to the actual worker executor', async () => {
  const f = fixture(), configured = { ...config, accountRunners: { subscription: { claude: { ...plan, env: { PROFILE: '/worker/private/subscription' } } } } };
  f.read.mockImplementation(async path => path === '/config' ? JSON.stringify(configured) : 'token');
  expect(await workerProgram(f)).toBe(0); expect(f.executor).toHaveBeenCalledWith({ ...configured, state });
});

for (const accountRunners of [null, [], { sub: null }, { sub: [] }, { sub: { claude: null } },
  { '': { claude: plan } }, { sub: { '': plan } }, { sub: { claude: { ...plan, extra: 'wrong' } } },
  ...[{ command: '\0' }, { args: ['bad\0arg'] }, { cwd: '/bad\0dir' }, { env: { KEY: 'bad\0value' } }].map(patch => ({ sub: { claude: { ...plan, ...patch } } })),
]) it('rejects malformed nested account runners before token reads or execution', async () => {
  const f = fixture(); f.read.mockResolvedValue(JSON.stringify({ ...config, accountRunners }));
  expect(await workerProgram(f)).toBe(WORKER_STOP.config[0]); expect(f.read).toHaveBeenCalledExactlyOnceWith('/config');
  expect(f.executor).not.toHaveBeenCalled(); expect(f.run).not.toHaveBeenCalled(); expect(f.control).not.toHaveBeenCalled();
});
it.each([
  ['build', { build: plan }], ['runners', { runners: { claude: plan } }], ['runners', { runners: {} }], ['accountRunners', { accountRunners: { subscription: { claude: plan } } }],
  ['container.mounts', { container: { socket: '/fake/docker.sock', mounts: [{ source: '/house/stamps', target: 'house/stamps' }] } }], ['container.mounts', { container: { socket: '/fake/docker.sock', mounts: [] } }],
  ['build', config],
  // Where a sign-in appears in a house is no longer the machine's to say.
  ['accountLogins.subscription.claude.target', { accountLogins: { subscription: { claude: { source: '/logins/subscription', target: '/home/agent/.claude' } } } }],
  ['accountLogins."an account".codex.target', { accountLogins: { 'an account': { claude: { source: '/x' }, codex: { source: '/y', target: '/run/loom/login/codex' } } } }],
])('stops a worker with container bodies that still has %s, naming the key, before it reads its token', async (key, patch) => {
  const f = fixture(), containerExecutor = vi.fn();
  f.read.mockResolvedValue(JSON.stringify({ ...houseConfig, container: { socket: '/fake/docker.sock' }, ...patch }));
  expect(await workerProgram({ ...f, containerExecutor })).toBe(53);
  expect(f.error).toHaveBeenCalledExactlyOnceWith(`Worker stopped: ${WORKER_STOP.retired[1]} (${key})\n`);
  expect(WORKER_STOP.retired[1]).toBe('the configuration has a key that a worker with container bodies no longer takes: it builds each house itself from the agent\'s repository, mounts are listed by agent, and where a sign-in appears in a house is the same in every house');
  expect(f.read).toHaveBeenCalledExactlyOnceWith('/config'); expect(containerExecutor).not.toHaveBeenCalled(); expect(f.executor).not.toHaveBeenCalled(); expect(f.run).not.toHaveBeenCalled();
});
it('stops a worker with container bodies whose own directory cannot give a container the body program, with its own line and code', async () => {
  const f = fixture(), containerExecutor = vi.fn(() => { throw new WorkerStop('program'); });
  f.read.mockImplementation(async path => path === '/config' ? JSON.stringify({ ...houseConfig, container: { socket: '/fake/docker.sock' } }) : 'private-token');
  expect(await workerProgram({ ...f, containerExecutor })).toBe(55);
  expect(f.error).toHaveBeenCalledExactlyOnceWith('Worker stopped: the directory the worker is installed in cannot give containers the body program: dist/body.js or a package it depends on is not inside it (its packages must be in its own node_modules, as a global npm install puts them)\n');
  expect(f.run).not.toHaveBeenCalled();
});
it('stops a worker with container bodies whose install has no definition of the core house, with its own line and code', async () => {
  const f = fixture(), containerExecutor = vi.fn(() => { throw new WorkerStop('core'); });
  f.read.mockImplementation(async path => path === '/config' ? JSON.stringify({ ...houseConfig, container: { socket: '/fake/docker.sock' } }) : 'private-token');
  expect(await workerProgram({ ...f, containerExecutor })).toBe(56);
  expect(f.error).toHaveBeenCalledExactlyOnceWith('Worker stopped: the directory the worker is installed in has no definition of the core house (house/core/Housefile), which every house is built on\n');
  expect(f.run).not.toHaveBeenCalled();
});
it('stops a worker whose engine or sign-in directory another worker already uses, with its own line and code, the key and no path', async () => {
  const f = fixture(), endLeft = vi.fn(async () => { throw new WorkerStop('shared', 'accountLogins.subscription.claude.source'); });
  const containerExecutor = vi.fn(() => ({ endLeft, close: vi.fn() }));
  f.read.mockImplementation(async path => path === '/config' ? JSON.stringify({ ...houseConfig, container: { socket: '/fake/docker.sock' } }) : 'private-token');
  expect(await workerProgram({ ...f, containerExecutor: containerExecutor as never })).toBe(57);
  expect(f.error).toHaveBeenCalledExactlyOnceWith('Worker stopped: another worker on this machine already uses the engine or a sign-in directory this configuration names: one worker runs a machine\'s houses (accountLogins.subscription.claude.source)\n');
  expect(f.run).not.toHaveBeenCalled();
});
it('prints what its container executor has to say, in the executor\'s own fixed words', async () => {
  const f = fixture(); let say: ((line: string) => void) | undefined;
  const containerExecutor = vi.fn((_config: unknown, given?: { say?: (line: string) => void }) => { say = given?.say; return {}; });
  f.read.mockImplementation(async path => path === '/config' ? JSON.stringify({ ...houseConfig, slots: 1, container: { socket: '/fake/docker.sock' } }) : 'private-token');
  f.run.mockImplementation(async () => { say!(UPKEEP_FAILED); });
  expect(await workerProgram({ ...f, containerExecutor })).toBe(0);
  expect(f.error).toHaveBeenCalledExactlyOnceWith('Worker could not look at its house images: old ones stay until it can\n');
});
it('stops a worker with container bodies on a machine that has no git, with its own line and code', async () => {
  const f = fixture(), containerExecutor = vi.fn(() => { throw new WorkerStop('git'); });
  f.read.mockImplementation(async path => path === '/config' ? JSON.stringify({ ...houseConfig, container: { socket: '/fake/docker.sock' } }) : 'private-token');
  expect(await workerProgram({ ...f, containerExecutor })).toBe(54);
  expect(f.error).toHaveBeenCalledExactlyOnceWith('Worker stopped: git 2.32.0 or later, which fetches each house\'s repository, could not be run on this machine\n'); expect(f.run).not.toHaveBeenCalled();
});
for (const gone of ['build', 'runners'] as const) it(`still needs ${gone} for a worker whose bodies are processes`, async () => {
  const f = fixture(), { [gone]: _left, ...rest } = config;
  f.read.mockResolvedValue(JSON.stringify(rest));
  expect(await workerProgram(f)).toBe(WORKER_STOP.config[0]); expect(f.read).toHaveBeenCalledExactlyOnceWith('/config'); expect(f.executor).not.toHaveBeenCalled();
});

for (const facts of [[''], ['duplicate', 'duplicate'], ['bad\0fact'], ['bad\nline'], ['bad\rfact'], ['x'.repeat(257)], Array.from({ length: 129 }, (_, i) => 'fact'+i), null, 'gpu:5090']) it('rejects invalid configured machine facts before reading a token or executing', async () => {
  const f = fixture(); f.read.mockResolvedValue(JSON.stringify({ ...config, facts }));
  expect(await workerProgram(f)).toBe(WORKER_STOP.config[0]); expect(f.read).toHaveBeenCalledExactlyOnceWith('/config'); expect(f.control).not.toHaveBeenCalled(); expect(f.executor).not.toHaveBeenCalled(); expect(f.run).not.toHaveBeenCalled();
});

it('accepts explicit private bootstrap only in a configured runner, without putting it in argv or environment', async () => {
  const f = fixture(), selected = { ...config, runners: { claude: { ...plan, bodyBootstrap: true } } };
  f.read.mockImplementation(async path => path === '/config' ? JSON.stringify(selected) : 'machine-token'); expect(await workerProgram(f)).toBe(0); expect(f.executor).toHaveBeenCalledWith({ ...selected, state });
});
for (const bodyBootstrap of ['true', 1, null, {}]) it('refuses an invalid private runner bootstrap option before token reads', async () => {
  const f = fixture(); f.read.mockResolvedValue(JSON.stringify({ ...config, runners: { claude: { ...plan, bodyBootstrap } } }));
  expect(await workerProgram(f)).toBe(WORKER_STOP.config[0]); expect(f.read).toHaveBeenCalledExactlyOnceWith('/config'); expect(f.executor).not.toHaveBeenCalled();
});

it('accepts private bootstrap in exact account/harness bindings', async () => {
  const f = fixture(), selected = { ...config, accountRunners: { sub: { claude: { ...plan, bodyBootstrap: true } } } };
  f.read.mockImplementation(async path => path === '/config' ? JSON.stringify(selected) : 'machine-token'); expect(await workerProgram(f)).toBe(0); expect(f.executor).toHaveBeenCalledWith({ ...selected, state });
});
it('refuses a private bootstrap flag on a builder before reading its token', async () => {
  const f = fixture(); f.read.mockResolvedValue(JSON.stringify({ ...config, build: { ...plan, bodyBootstrap: true } }));
  expect(await workerProgram(f)).toBe(WORKER_STOP.config[0]); expect(f.read).toHaveBeenCalledExactlyOnceWith('/config'); expect(f.executor).not.toHaveBeenCalled();
});
for (const mode of ['--account-usage']) it(`refuses private bootstrap on the ${mode} command before private execution`, async () => {
  const f = accountFixture(mode, { command: { ...plan, bodyBootstrap: true }, account });
  expect(await workerProgram(f)).toBe(WORKER_STOP.config[0]); expect(f.usage).not.toHaveBeenCalled(); expect(f.read).toHaveBeenCalledOnce();
});

it('takes a sign-in deadline up to the relay\'s own and no longer', async () => {
  const signIn = (timeoutMs: number) => ({ ...config, accountSignIn: { programs: [{ provider: 'p', command: plan }], timeoutMs } });
  const f = fixture(); f.read.mockImplementation(async path => path === '/config' ? JSON.stringify(signIn(RELAY_MS)) : 'private-token');
  expect(await workerProgram({ ...f, signInRemote: () => ({ next: async () => undefined }) as never, pause: async () => { throw new Error('stop'); } })).toBe(0);
  const over = fixture(); over.read.mockImplementation(async path => path === '/config' ? JSON.stringify(signIn(RELAY_MS + 1)) : 'private-token');
  expect(await workerProgram(over)).toBe(WORKER_STOP.config[0]); expect(over.run).not.toHaveBeenCalled();
});

// Houses: the runtime's name, sign-in directories and fixed mounts (worker-mounts.ts holds the rules).
it('passes the engine runtime, the sign-in directories and the fixed mounts to container execution as they were written', async () => {
  const f = fixture(), containerExecutor = vi.fn().mockReturnValue({});
  const configured = { ...houseConfig, buildTimeoutMs: 2_400_000, accountLogins: { subscription: { claude: { source: '/logins/subscription' } } },
    container: { socket: '/fake/podman.sock', runtime: 'crun', mounts: { art: [{ source: '/house/stamps', target: 'house/stamps', readOnly: false }], mark: [{ source: '/house/mirror', target: 'mirror' }] } } };
  f.read.mockImplementation(async path => path === '/config' ? JSON.stringify(configured) : 'private-token');
  expect(await workerProgram({ ...f, containerExecutor })).toBe(0);
  expect(containerExecutor).toHaveBeenCalledExactlyOnceWith({ ...configured, state }, { say: expect.any(Function) }); expect(f.executor).not.toHaveBeenCalled();
});
for (const patch of [{ container: { socket: '/s', runtime: 'kata' } }, { container: { socket: '/s', runtime: '' } },
  { container: { socket: '/s', mounts: { art: [{ source: '/a', target: '/b', readOnly: 'yes' }] } } }, { container: { socket: '/s', mounts: { art: [{ source: '/a', target: '/b', propagation: 'shared' }] } } },
  { container: { socket: '/s', mounts: { art: [{ source: '/a' }] } } }, { container: { socket: '/s', mounts: { source: '/a', target: '/b' } } }, { container: { socket: '/s', mounts: { '': [] } } },
  { container: { socket: '/s', buildTimeoutMs: 1 } }, { container: { socket: '/s' }, buildTimeoutMs: 3_600_001 },
  { container: { socket: '/s' }, accountLogins: { a: { claude: { source: '/a', target: '/b', readOnly: true } } } },
  { container: { socket: '/s' }, accountLogins: { a: { claude: { target: '/b' } } } }, { container: { socket: '/s' }, accountLogins: { a: { source: '/a', target: '/b' } } },
  // Sign-in directories are mounts: a worker whose bodies are processes cannot give one to one job only.
  { accountLogins: { a: { claude: { source: '/a', target: '/b' } } } }, { accountLogins: {} }].entries())
  it(`rejects a runtime it does not know, a misshapen mount and sign-in directories without container bodies, before the token is read (${JSON.stringify(patch[1])})`, async () => {
    const f = fixture(), containerExecutor = vi.fn();
    f.read.mockResolvedValue(JSON.stringify({ ...('container' in patch[1] ? houseConfig : config), ...patch[1] }));
    expect(await workerProgram({ ...f, containerExecutor })).toBe(WORKER_STOP.config[0]);
    expect(f.read).toHaveBeenCalledExactlyOnceWith('/config'); expect(containerExecutor).not.toHaveBeenCalled(); expect(f.executor).not.toHaveBeenCalled(); expect(f.run).not.toHaveBeenCalled();
  });
it('stops before any work is claimed when a path given to containers or an engine socket cannot be used, with its own line and code and no path in it', async () => {
  expect(WORKER_STOP.mounts).toEqual([52, 'a path the configuration gives to containers, or an engine socket, cannot be used: a mounted directory that is not an existing directory of this user written as its real path, an engine socket that is not an existing socket, a source or a socket not written as a plain absolute path, a harness named under accountLogins in anything but lower-case letters, digits, - and _, a mount target that is not a plain path under the home of the house or that is or holds its repository, or a mounted directory that overlaps another, an engine socket, the state directory or the token file']);
  // The line, then the configuration key at fault in brackets: a key, never the path written under it.
  const line = (key: string) => `Worker stopped: ${WORKER_STOP.mounts[1]} (${key})\n`;
  const { mkdtempSync, mkdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } = await import('node:fs'), { tmpdir } = await import('node:os'), { join } = await import('node:path'), { createServer } = await import('node:http');
  const root = mkdtempSync(join(realpathSync(tmpdir()), 'loom-private-')), real = join(root, 'real'), other = join(root, 'other'), link = join(root, 'link');
  const engine = join(root, 'engine'), socket = join(engine, 'engine.sock'), workerState = join(root, 'state');
  mkdirSync(real); mkdirSync(other); mkdirSync(engine); symlinkSync(real, link);
  const program = join(root, 'install'); mkdirSync(join(program, 'dist'), { recursive: true }); mkdirSync(join(program, 'node_modules', 'zod'), { recursive: true });
  writeFileSync(join(program, 'dist', 'body.js'), ''); writeFileSync(join(program, 'package.json'), '{"dependencies":{"zod":"^4"}}');
  mkdirSync(join(program, 'house', 'core'), { recursive: true }); writeFileSync(join(program, 'house', 'core', 'Housefile'), 'FROM scratch\n');
  const run = join(root, 'run'); symlinkSync(engine, run);
  // An engine with nothing left on it: the worker that starts lists its containers and finds none.
  const server = createServer((_request, response) => { response.end('[]'); });
  await new Promise<void>(done => server.listen(socket, done));
  const login = (source: string) => ({ accountLogins: { subscription: { claude: { source } } } });
  const started = async (patch: { accountLogins?: unknown; container?: Record<string, unknown>; tokenFile?: string; state?: string }) => {
    const f = fixture();
    f.read.mockImplementation(async path => path === '/config' ? JSON.stringify({ ...houseConfig, state: workerState, ...patch, container: { socket, ...patch.container } }) : 'private-token');
    // The real container executor, so the real checks, which come before the state directory is taken. It
    // is told one thing only: a directory laid out as an install is, since a checkout's own may not be.
    return { code: await workerProgram({ ...f, containerExecutor: (given, with_) => containerWorkerExecutor(given, { ...with_, program }) }), f };
  };
  try {
    // The same configuration with nothing wrong in it starts, so each stop below is for the one thing changed.
    const fine = await started({ ...login(real), container: { nestedSocket: socket, mounts: { art: [{ source: other, target: 'house/x' }] } } });
    expect(fine.code).toBe(0); expect(fine.f.error).not.toHaveBeenCalled(); expect(fine.f.run).toHaveBeenCalledTimes(4);
    // So does one whose engine socket is named through a linked directory, as `/var/run/docker.sock` is on
    // most machines, with nothing else in it: a configuration from before any of these keys.
    for (const container of [{ socket: join(run, 'engine.sock') }, { socket: join(run, 'engine.sock'), nestedSocket: join(run, 'engine.sock'), mounts: { art: [{ source: other, target: 'house/x' }] } }]) {
      const linked = await started({ container });
      expect(linked.code).toBe(0); expect(linked.f.error).not.toHaveBeenCalled(); expect(linked.f.run).toHaveBeenCalledTimes(4);
    }
    const subscription = 'accountLogins.subscription.claude';
    for (const [what, key, patch] of [
      ['a sign-in directory that is missing', `${subscription}.source`, login('/loom-test/private-missing-login')],
      ['a relative mount source', 'container.mounts.art[0].source', { container: { mounts: { art: [{ source: 'private-relative', target: 'house/x' }] } } }],
      ['an absolute mount target', 'container.mounts.art[0].target', { container: { mounts: { art: [{ source: real, target: '/home/agent/house/x' }] } } }],
      ['a mount at the repository', 'container.mounts.art[0].target', { container: { mounts: { art: [{ source: real, target: 'repo' }] } } }],
      ['a mount that is a symbolic link to a directory that is itself fine', 'container.mounts.art[0].source', { container: { mounts: { art: [{ source: link, target: 'house/x' }] } } }],
      ['a sign-in directory that is a symbolic link', `${subscription}.source`, login(link)],
      ['two mounts at nested places', 'container.mounts.art[1].target', { container: { mounts: { art: [{ source: real, target: 'house/x' }, { source: other, target: 'house/x/inner' }] } } }],
      ['a mount at the nested socket\'s place', 'container.mounts.art[0].target', { container: { mounts: { art: [{ source: real, target: '/var/run/docker.sock' }] } } }],
      ['a mount at /run', 'container.mounts.art[0].target', { container: { mounts: { art: [{ source: real, target: '/run' }] } } }],
      ['one directory mounted twice', 'container.mounts.art[1].source', { container: { mounts: { art: [{ source: real, target: 'one' }, { source: real, target: 'two', readOnly: false }] } } }],
      ['a mount that is a sign-in directory', `${subscription}.source`, { ...login(real), container: { mounts: { art: [{ source: real, target: 'house/x' }] } } }],
      ['a nested socket that is a directory', 'container.nestedSocket', { container: { nestedSocket: real } }],
      ['a relative nested socket', 'container.nestedSocket', { container: { nestedSocket: 'engine/engine.sock' } }],
      ['a relative engine socket', 'container.socket', { container: { socket: 'engine/engine.sock' } }],
      ['an engine socket that is not there', 'container.socket', { container: { socket: join(engine, 'private-none.sock') } }],
      ['a mount of the directory that holds the engine socket', 'container.mounts.art[0].source', { container: { mounts: { art: [{ source: engine, target: 'house/run' }] } } }],
      ['a mount of the real directory of an engine socket named through a link', 'container.mounts.art[0].source', { container: { socket: join(run, 'engine.sock'), mounts: { art: [{ source: engine, target: 'house/run' }] } } }],
      ['a mount that will hold the state directory', 'container.mounts.art[0].source', { state: join(other, 'private-state'), container: { mounts: { art: [{ source: other, target: 'house/x' }] } } }],
      ['a mount that holds the token file', 'container.mounts.art[0].source', { tokenFile: join(real, 'private-token-file'), container: { mounts: { art: [{ source: real, target: 'house/x' }] } } }],
    ] as const) {
      const { code, f } = await started(patch);
      expect(code, what).toBe(52);
      expect(f.error, what).toHaveBeenCalledExactlyOnceWith(line(key));
      expect(f.error.mock.calls[0][0], what).not.toMatch(/private|loom-test|loom-private/);
      expect(f.run, what).not.toHaveBeenCalled(); expect(f.executor).not.toHaveBeenCalled(); expect(f.handlers.size).toBe(0);
    }
  } finally { await new Promise(done => server.close(done)); rmSync(root, { recursive: true, force: true }); }
});

// Several jobs side by side.
it('runs as many slots as the configuration says: four for container bodies and one for process bodies when it does not, all on one executor, one control and one set of turns', async () => {
  for (const [given, container, expected] of [[undefined, true, 4], [undefined, false, 1], [1, true, 1], [3, false, 3], [16, true, 16]] as const) {
    const f = fixture(), containerExecutor = vi.fn().mockReturnValue({ container: true });
    f.read.mockImplementation(async path => path === '/config' ? JSON.stringify({ ...(container ? { ...houseConfig, container: { socket: '/fake/docker.sock' } } : config), ...(given ? { slots: given } : {}) }) : 'private-token');
    expect(await workerProgram({ ...f, containerExecutor })).toBe(0);
    expect(f.run).toHaveBeenCalledTimes(expected);
    const calls = f.run.mock.calls.map(call => call[0]);
    expect(new Set(calls.map(call => call.turns)).size).toBe(1); expect(new Set(calls.map(call => call.executor)).size).toBe(1);
    expect(new Set(calls.map(call => call.control)).size).toBe(1); expect(new Set(calls.map(call => call.signal)).size).toBe(1);
    expect(container ? containerExecutor : f.executor).toHaveBeenCalledOnce();
  }
});
for (const slots of [0, 17, 1.5, -1, '4', null]) it(`refuses ${JSON.stringify(slots)} slots before it reads its token`, async () => {
  const f = fixture(); f.read.mockResolvedValue(JSON.stringify({ ...config, slots }));
  expect(await workerProgram(f)).toBe(WORKER_STOP.config[0]); expect(f.read).toHaveBeenCalledExactlyOnceWith('/config'); expect(f.run).not.toHaveBeenCalled();
});
it('stops every slot when one cannot end its body, waits for each to end its own, and only then gives its state up and says why', async () => {
  const f = fixture(), order: string[] = [], close = vi.fn(() => { order.push('close'); });
  f.executor.mockReturnValue({ close });
  f.read.mockImplementation(async path => path === '/config' ? JSON.stringify({ ...config, slots: 3 }) : 'private-token');
  let slot = 0;
  f.run.mockImplementation(async ({ signal }: { signal: AbortSignal }) => {
    const mine = ++slot;
    if (mine === 2) { await Promise.resolve(); order.push('slot 2 fails'); throw new Error('private: a body could not be ended'); }
    // The other slots hold bodies: they end them when the worker's stop reaches them, which takes a moment.
    await new Promise<void>(resolve => signal.addEventListener('abort', () => setTimeout(() => { order.push(`slot ${mine} ended its body`); resolve(); }, mine * 5), { once: true }));
  });
  expect(await workerProgram(f)).toBe(49);
  expect(order).toEqual(['slot 2 fails', 'slot 1 ended its body', 'slot 3 ended its body', 'close']);
  expect(f.error).toHaveBeenCalledExactlyOnceWith('Worker stopped: a body it started could not be ended, so it takes no more work\n');
});
it('ends every slot when the worker is asked to stop, and exits 0 once each has', async () => {
  const f = fixture(), ended: number[] = [];
  f.read.mockImplementation(async path => path === '/config' ? JSON.stringify({ ...config, slots: 4 }) : 'private-token');
  let slot = 0;
  f.run.mockImplementation(async ({ signal }: { signal: AbortSignal }) => { const mine = ++slot; await new Promise<void>(resolve => signal.addEventListener('abort', () => { ended.push(mine); resolve(); }, { once: true })); });
  const running = workerProgram(f); await vi.waitFor(() => expect(f.run).toHaveBeenCalledTimes(4));
  f.handlers.get('SIGTERM')!();
  expect(await running).toBe(0); expect(ended.sort()).toEqual([1, 2, 3, 4]); expect(f.error).not.toHaveBeenCalled();
});

it('lets as many bodies run on one account as accountSlots says: four when it does not (one for Codex), never more than the slots, one after the other at 1', async () => {
  const never = new AbortController().signal;
  /** How many jobs on one account the worker's turns let start together. */
  const together = async (patch: Record<string, unknown>, harness = 'claude') => {
    const f = fixture(), containerExecutor = vi.fn().mockReturnValue({});
    f.read.mockImplementation(async path => path === '/config' ? JSON.stringify({ ...houseConfig, container: { socket: '/fake/docker.sock' }, ...patch }) : 'private-token');
    expect(await workerProgram({ ...f, containerExecutor })).toBe(0);
    const turns = f.run.mock.calls[0][0].turns as { take(keys: string[], signal: AbortSignal): Promise<() => void> };
    let given = 0; for (let job = 0; job < 20; job++) void turns.take([`account:${harness}:one`], never).then(() => { given++; });
    for (let turn = 0; turn < 20; turn++) await Promise.resolve();
    return given;
  };
  expect(await together({})).toBe(4); expect(await together({ slots: 8 })).toBe(4); expect(await together({ slots: 2 })).toBe(2);
  expect(await together({ slots: 8, accountSlots: 6 })).toBe(6); expect(await together({ accountSlots: 1 })).toBe(1); expect(await together({ slots: 16, accountSlots: 16 })).toBe(16);
  // Codex's bodies run one at a time on an account unless the configuration says otherwise: what its program does when two renew at once is not established.
  expect(await together({}, 'codex')).toBe(1); expect(await together({ slots: 8 }, 'codex')).toBe(1); expect(await together({}, 'agy')).toBe(4);
  // One number is every harness's, Codex's too. A number for a harness is that harness's, and the others keep their defaults.
  expect(await together({ accountSlots: 3 }, 'codex')).toBe(3);
  expect(await together({ accountSlots: { codex: 2 } }, 'codex')).toBe(2); expect(await together({ accountSlots: { codex: 2 } })).toBe(4);
  expect(await together({ slots: 8, accountSlots: { claude: 6, codex: 1 } })).toBe(6); expect(await together({ slots: 8, accountSlots: { claude: 6 } }, 'codex')).toBe(1);
  expect(await together({ accountSlots: { claude: 1 } })).toBe(1); expect(await together({ slots: 2, accountSlots: {} })).toBe(2);
  // A harness's name that is also a name every object has is no entry.
  expect(await together({}, 'constructor')).toBe(4); expect(await together({ accountSlots: { codex: 2 } }, 'toString')).toBe(4);
});
for (const patch of [{ accountSlots: 5 }, { slots: 2, accountSlots: 3 }, { accountSlots: 0 }, { accountSlots: 17, slots: 16 }, { accountSlots: 1.5 }, { accountSlots: '2' },
  { accountSlots: { codex: 5 } }, { slots: 2, accountSlots: { claude: 2, codex: 3 } }, { accountSlots: { codex: 0 } }, { accountSlots: { codex: '1' } }, { accountSlots: { '': 1 } }, { accountSlots: [1] }])
  it(`refuses ${JSON.stringify(patch)}: more bodies on one account than the worker has slots, or no whole number of them`, async () => {
    const f = fixture(), containerExecutor = vi.fn();
    f.read.mockResolvedValue(JSON.stringify({ ...houseConfig, container: { socket: '/fake/docker.sock' }, ...patch }));
    expect(await workerProgram({ ...f, containerExecutor })).toBe(WORKER_STOP.config[0]); expect(containerExecutor).not.toHaveBeenCalled(); expect(f.run).not.toHaveBeenCalled();
  });
it('holds a process worker to its one slot for accounts too', async () => {
  const f = fixture(); f.read.mockResolvedValue(JSON.stringify({ ...config, accountSlots: 2 }));
  expect(await workerProgram(f)).toBe(WORKER_STOP.config[0]);
  const fine = fixture(); fine.read.mockImplementation(async path => path === '/config' ? JSON.stringify({ ...config, slots: 3, accountSlots: 2 }) : 'private-token');
  expect(await workerProgram(fine)).toBe(0); expect(fine.run).toHaveBeenCalledTimes(3);
});
