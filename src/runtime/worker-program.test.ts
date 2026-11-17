import { it, expect, vi } from 'vitest';
import { workerProgram } from './worker-program.js';
import { defaultWorkerState } from './worker-left.js';
import { WORKER_STOP, WorkerStop } from './worker-stop.js';
import { RELAY_MS } from './account-signin-relay.js';
import { BODY_EXIT, LOOM_EXIT, WORKER_EXIT } from './job-exit.js';
const plan = { command: '/builder', args: [], cwd: '/work', env: { PATH: '/bin' } };
const config = { url: 'https://loom.example', box: 'b', tokenFile: '/token', build: plan, runners: { claude: plan } };
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
  expect(f.run).toHaveBeenCalledWith({ box: 'b', control: {}, executor: {}, signal: expect.any(AbortSignal) });
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
  const selected = { ...config, container: { socket: '/configured/docker.sock', nestedSocket: '/configured/nested.sock', setupTimeoutMs: 200, cleanupTimeoutMs: 300 } };
  f.read.mockImplementation(async path => path === '/config' ? JSON.stringify(selected) : 'private-token');
  expect(await workerProgram({ ...f, containerExecutor })).toBe(0);
  expect(containerExecutor).toHaveBeenCalledExactlyOnceWith({ ...selected, state });
  expect(f.executor).not.toHaveBeenCalled();
  expect(f.run).toHaveBeenCalledWith(expect.objectContaining({ executor: { container: true } }));
});
for (const container of [{ socket: 'relative' }, { socket: '/docker.sock', privileged: true }, { socket: '/docker.sock', cleanupTimeoutMs: 0 }]) {
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
it('passes account bindings to container execution too', async () => {
  const f = fixture(), containerExecutor = vi.fn().mockReturnValue({}), configured = { ...config, container: { socket: '/fake/docker.sock' }, accountRunners: { subscription: { claude: plan } } };
  f.read.mockImplementation(async path => path === '/config' ? JSON.stringify(configured) : 'token');
  expect(await workerProgram({ ...f, containerExecutor })).toBe(0);
  expect(containerExecutor).toHaveBeenCalledExactlyOnceWith({ ...configured, state }); expect(f.executor).not.toHaveBeenCalled();
});

for (const patch of [{ cwd: 'relative' }, { env: { 'BAD-KEY': 'value' } }]) it('rejects invalid container runner plans before the token or builder', async () => {
  const f = fixture(); f.read.mockResolvedValue(JSON.stringify({ ...config, container: { socket: '/fake/docker.sock' }, accountRunners: { sub: { claude: { ...plan, ...patch } } } }));
  const containerExecutor = vi.fn(); expect(await workerProgram({ ...f, containerExecutor })).toBe(WORKER_STOP.config[0]);
  expect(f.read).toHaveBeenCalledExactlyOnceWith('/config'); expect(containerExecutor).not.toHaveBeenCalled(); expect(f.control).not.toHaveBeenCalled();
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
  const configured = { ...config, accountLogins: { subscription: { claude: { source: '/logins/subscription', target: '/home/agent/.claude' } } },
    container: { socket: '/fake/podman.sock', runtime: 'crun', mounts: [{ source: '/house/stamps', target: '/house/stamps', readOnly: false }, { source: '/house/mirror', target: '/mirror' }] } };
  f.read.mockImplementation(async path => path === '/config' ? JSON.stringify(configured) : 'private-token');
  expect(await workerProgram({ ...f, containerExecutor })).toBe(0);
  expect(containerExecutor).toHaveBeenCalledExactlyOnceWith({ ...configured, state }); expect(f.executor).not.toHaveBeenCalled();
});
for (const patch of [{ container: { socket: '/s', runtime: 'kata' } }, { container: { socket: '/s', runtime: '' } },
  { container: { socket: '/s', mounts: [{ source: '/a', target: '/b', readOnly: 'yes' }] } }, { container: { socket: '/s', mounts: [{ source: '/a', target: '/b', propagation: 'shared' }] } },
  { container: { socket: '/s', mounts: [{ source: '/a' }] } }, { container: { socket: '/s', mounts: { source: '/a', target: '/b' } } },
  { container: { socket: '/s' }, accountLogins: { a: { claude: { source: '/a', target: '/b', readOnly: true } } } },
  { container: { socket: '/s' }, accountLogins: { a: { claude: { source: '/a' } } } }, { container: { socket: '/s' }, accountLogins: { a: { source: '/a', target: '/b' } } },
  // Sign-in directories are mounts: a worker whose bodies are processes cannot give one to one job only.
  { accountLogins: { a: { claude: { source: '/a', target: '/b' } } } }, { accountLogins: {} }])
  it('rejects a runtime it does not know, a misshapen mount and sign-in directories without container bodies, before the token is read', async () => {
    const f = fixture(), containerExecutor = vi.fn();
    f.read.mockResolvedValue(JSON.stringify({ ...config, ...patch }));
    expect(await workerProgram({ ...f, containerExecutor })).toBe(WORKER_STOP.config[0]);
    expect(f.read).toHaveBeenCalledExactlyOnceWith('/config'); expect(containerExecutor).not.toHaveBeenCalled(); expect(f.executor).not.toHaveBeenCalled(); expect(f.run).not.toHaveBeenCalled();
  });
it('stops before any work is claimed when a mounted directory cannot be used, with its own line and code and no path in it', async () => {
  const line = 'Worker stopped: a path the configuration mounts into containers cannot be used: a source that is not an existing directory of this user, a nested socket that is not an existing socket, a source or target not written as a plain absolute path with no symbolic link in it, or two that overlap\n';
  const { mkdtempSync, mkdirSync, realpathSync, rmSync, symlinkSync } = await import('node:fs'), { tmpdir } = await import('node:os'), { join } = await import('node:path');
  const root = mkdtempSync(join(realpathSync(tmpdir()), 'loom-private-')), real = join(root, 'real'), other = join(root, 'other'), link = join(root, 'link');
  mkdirSync(real); mkdirSync(other); symlinkSync(real, link);
  try {
  // The real container executor, so the real checks: nothing here needs an engine, and the checks come
  // before the state directory is taken.
  for (const patch of [{ accountLogins: { subscription: { claude: { source: '/loom-test/private-missing-login', target: '/home/agent/.claude' } } } },
    { container: { socket: '/fake/docker.sock', mounts: [{ source: 'private-relative', target: '/house/x' }] } },
    { container: { socket: '/fake/docker.sock', mounts: [{ source: '/loom-test/private-missing-mount', target: '/var/run/docker.sock' }] } },
    // A symbolic link to a directory that is itself fine.
    { container: { socket: '/fake/docker.sock', mounts: [{ source: link, target: '/house/x' }] } },
    { accountLogins: { subscription: { claude: { source: link, target: '/home/agent/.claude' } } } },
    // Directories that exist and are fine, at places that collide: with each other, with a sign-in, with the socket.
    { container: { socket: '/fake/docker.sock', mounts: [{ source: real, target: '/house/x' }, { source: other, target: '/house/x/inner' }] } },
    { accountLogins: { subscription: { claude: { source: real, target: '/home/agent/.claude' } } }, container: { socket: '/fake/docker.sock', mounts: [{ source: other, target: '/home/agent/.claude' }] } },
    { container: { socket: '/fake/docker.sock', mounts: [{ source: real, target: '/var/run/docker.sock' }] } },
    // A nested socket that is a directory.
    { container: { socket: '/fake/docker.sock', nestedSocket: real } }]) {
    const f = fixture();
    f.read.mockImplementation(async path => path === '/config' ? JSON.stringify({ ...config, container: { socket: '/fake/docker.sock' }, ...patch }) : 'private-token');
    expect(await workerProgram(f)).toBe(52);
    expect(f.error).toHaveBeenCalledExactlyOnceWith(line);
    expect(f.run).not.toHaveBeenCalled(); expect(f.executor).not.toHaveBeenCalled(); expect(f.handlers.size).toBe(0);
  }
  } finally { rmSync(root, { recursive: true, force: true }); }
  expect(WORKER_STOP.mounts).toEqual([52, line.slice('Worker stopped: '.length, -1)]);
  expect(line).not.toMatch(/private|loom-test/);
});
