import { it, expect, vi } from 'vitest';
import { workerProgram } from './worker-program.js';
const plan = { command: '/builder', args: [], cwd: '/work', env: { PATH: '/bin' } };
const config = { url: 'https://loom.example', box: 'b', tokenFile: '/token', build: plan, runners: { claude: plan } };
function fixture() {
  const handlers = new Map<string, () => void>();
  return { handlers, args: ['/config'], read: vi.fn(async (path: string) => path === '/config' ? JSON.stringify(config) : ' private-token\n'),
    on: (name: string, stop: () => void) => { handlers.set(name, stop); },
    off: (name: string, stop: () => void) => { expect(handlers.get(name)).toBe(stop); handlers.delete(name); },
    error: vi.fn(), control: vi.fn().mockReturnValue({}), executor: vi.fn().mockReturnValue({}), run: vi.fn().mockResolvedValue(undefined) };
}
it('loads validated config and token file then wires worker-only dependencies', async () => {
  const f = fixture();
  expect(await workerProgram(f)).toBe(0);
  expect(f.read.mock.calls.map(c => c[0])).toEqual(['/config', '/token']);
  expect(f.control).toHaveBeenCalledWith({ url: config.url, token: 'private-token', signal: expect.any(AbortSignal) });
  expect(f.executor).toHaveBeenCalledWith(config);
  expect(f.run).toHaveBeenCalledWith({ box: 'b', control: {}, executor: {}, signal: expect.any(AbortSignal) });
  expect(f.handlers.size).toBe(0);
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
    expect(await workerProgram(f)).toBe(1);
    expect(f.error).toHaveBeenCalledExactlyOnceWith('Worker stopped: invalid configuration or unavailable execution\n');
    expect(f.handlers.size).toBe(0);
  }
});
it('rejects malformed configuration before reading a token or launching', async () => {
  const f = fixture(); f.read.mockResolvedValue('{}');
  expect(await workerProgram(f)).toBe(1);
  expect(f.read).toHaveBeenCalledTimes(1);
  expect(f.control).not.toHaveBeenCalled(); expect(f.executor).not.toHaveBeenCalled(); expect(f.run).not.toHaveBeenCalled();
});

const account = { account: 'subscription', owner: 'member', provider: 'provider' };
function accountFixture(mode: string, config: unknown) {
  const f = fixture(); f.args = [mode, '/account-command']; f.read.mockResolvedValue(JSON.stringify(config));
  return { ...f, output: vi.fn(), signIn: vi.fn().mockResolvedValue(undefined),
    usage: vi.fn().mockReturnValue(vi.fn().mockResolvedValue([])) };
}
it('runs a configured private sign-in on the worker and emits identity-only acknowledgement', async () => {
  const f = accountFixture('--account-signin', { command: plan, account, box: 'worker', timeoutMs: 123 });
  expect(await workerProgram(f)).toBe(0);
  expect(f.read).toHaveBeenCalledExactlyOnceWith('/account-command');
  expect(f.signIn).toHaveBeenCalledExactlyOnceWith(plan, { ...account, box: 'worker' }, { signal: expect.any(AbortSignal), timeoutMs: 123 });
  expect(f.output).toHaveBeenCalledExactlyOnceWith(JSON.stringify({ ...account, box: 'worker', signedIn: true }) + '\n');
  expect(f.run).not.toHaveBeenCalled(); expect(f.control).not.toHaveBeenCalled(); expect(f.handlers.size).toBe(0);
});
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
for (const mode of ['--account-signin', '--account-usage']) {
  it(`hides private failures from ${mode}`, async () => {
    const f = accountFixture(mode, { command: plan, account, ...(mode === '--account-signin' ? { box: 'b' } : {}) });
    f.signIn.mockRejectedValue(new Error('private credential'));
    f.usage.mockReturnValue(vi.fn().mockRejectedValue(new Error('private credential')));
    expect(await workerProgram(f)).toBe(1); expect(f.output).not.toHaveBeenCalled();
    if (mode === '--account-signin') expect(f.signIn).toHaveBeenCalledOnce();
    else { expect(f.usage).toHaveBeenCalledOnce(); expect(f.usage.mock.results[0].value).toHaveBeenCalledOnce(); }
    expect(f.error).toHaveBeenCalledExactlyOnceWith('Worker stopped: invalid configuration or unavailable execution\n');
    expect(f.handlers.size).toBe(0);
  });
  it(`cancels ${mode} and refuses a late successful observation`, async () => {
    const f = accountFixture(mode, { command: plan, account, ...(mode === '--account-signin' ? { box: 'b' } : {}) });
    f.signIn.mockImplementation(async (_plan, _identity, options) => {
      f.handlers.get('SIGTERM')!(); expect(options.signal.aborted).toBe(true);
    });
    f.usage.mockImplementation((_plan, options) => async () => {
      f.handlers.get('SIGTERM')!(); expect(options.signal.aborted).toBe(true); return [];
    });
    expect(await workerProgram(f)).toBe(1); expect(f.output).not.toHaveBeenCalled();
    expect(f.handlers.size).toBe(0);
  });
  it(`rejects unrecognized config in ${mode} before any private command or token read`, async () => {
    const f = accountFixture(mode, { command: plan, account, ...(mode === '--account-signin' ? { box: 'b' } : {}), tokenFile: '/private-token' });
    expect(await workerProgram(f)).toBe(1); expect(f.read).toHaveBeenCalledTimes(1);
    expect(f.signIn).not.toHaveBeenCalled(); expect(f.usage).not.toHaveBeenCalled(); expect(f.output).not.toHaveBeenCalled();
  });
}

it('passes a configured build deadline to the executor', async () => {
  const f = fixture();
  f.read.mockImplementation(async path => path === '/config' ? JSON.stringify({ ...config, buildTimeoutMs: 1_234 }) : 'private-token');
  expect(await workerProgram(f)).toBe(0);
  expect(f.executor).toHaveBeenCalledWith({ ...config, buildTimeoutMs: 1_234 });
});
for (const buildTimeoutMs of [0, 1.5, 3_600_001]) it(`rejects invalid configured deadline ${buildTimeoutMs} before launching`, async () => {
  const f = fixture();
  f.read.mockResolvedValue(JSON.stringify({ ...config, buildTimeoutMs }));
  expect(await workerProgram(f)).toBe(1);
  expect(f.read).toHaveBeenCalledTimes(1);
  expect(f.executor).not.toHaveBeenCalled();
});


it('selects the actual container executor when configured, without invoking a host runner', async () => {
  const f = fixture(), containerExecutor = vi.fn().mockReturnValue({ container: true });
  const selected = { ...config, container: { socket: '/configured/docker.sock', nestedSocket: '/configured/nested.sock', setupTimeoutMs: 200, cleanupTimeoutMs: 300 } };
  f.read.mockImplementation(async path => path === '/config' ? JSON.stringify(selected) : 'private-token');
  expect(await workerProgram({ ...f, containerExecutor })).toBe(0);
  expect(containerExecutor).toHaveBeenCalledExactlyOnceWith(selected);
  expect(f.executor).not.toHaveBeenCalled();
  expect(f.run).toHaveBeenCalledWith(expect.objectContaining({ executor: { container: true } }));
});
for (const container of [{ socket: 'relative' }, { socket: '/docker.sock', privileged: true }, { socket: '/docker.sock', cleanupTimeoutMs: 0 }]) {
  it('rejects malformed container configuration before reading worker credentials', async () => {
    const f = fixture(), containerExecutor = vi.fn();
    f.read.mockResolvedValue(JSON.stringify({ ...config, container }));
    expect(await workerProgram({ ...f, containerExecutor })).toBe(1);
    expect(f.read).toHaveBeenCalledTimes(1); expect(containerExecutor).not.toHaveBeenCalled(); expect(f.run).not.toHaveBeenCalled();
  });
}

it('passes explicit account and harness runner bindings to the actual worker executor', async () => {
  const f = fixture(), configured = { ...config, accountRunners: { subscription: { claude: { ...plan, env: { PROFILE: '/worker/private/subscription' } } } } };
  f.read.mockImplementation(async path => path === '/config' ? JSON.stringify(configured) : 'token');
  expect(await workerProgram(f)).toBe(0); expect(f.executor).toHaveBeenCalledWith(configured);
});

for (const accountRunners of [null, [], { sub: null }, { sub: [] }, { sub: { claude: null } },
  { '': { claude: plan } }, { sub: { '': plan } }, { sub: { claude: { ...plan, extra: 'wrong' } } },
  ...[{ command: '\0' }, { args: ['bad\0arg'] }, { cwd: '/bad\0dir' }, { env: { KEY: 'bad\0value' } }].map(patch => ({ sub: { claude: { ...plan, ...patch } } })),
]) it('rejects malformed nested account runners before token reads or execution', async () => {
  const f = fixture(); f.read.mockResolvedValue(JSON.stringify({ ...config, accountRunners }));
  expect(await workerProgram(f)).toBe(1); expect(f.read).toHaveBeenCalledExactlyOnceWith('/config');
  expect(f.executor).not.toHaveBeenCalled(); expect(f.run).not.toHaveBeenCalled(); expect(f.control).not.toHaveBeenCalled();
});
it('passes account bindings to container execution too', async () => {
  const f = fixture(), containerExecutor = vi.fn().mockReturnValue({}), configured = { ...config, container: { socket: '/fake/docker.sock' }, accountRunners: { subscription: { claude: plan } } };
  f.read.mockImplementation(async path => path === '/config' ? JSON.stringify(configured) : 'token');
  expect(await workerProgram({ ...f, containerExecutor })).toBe(0);
  expect(containerExecutor).toHaveBeenCalledExactlyOnceWith(configured); expect(f.executor).not.toHaveBeenCalled();
});

for (const patch of [{ cwd: 'relative' }, { env: { 'BAD-KEY': 'value' } }]) it('rejects invalid container runner plans before the token or builder', async () => {
  const f = fixture(); f.read.mockResolvedValue(JSON.stringify({ ...config, container: { socket: '/fake/docker.sock' }, accountRunners: { sub: { claude: { ...plan, ...patch } } } }));
  const containerExecutor = vi.fn(); expect(await workerProgram({ ...f, containerExecutor })).toBe(1);
  expect(f.read).toHaveBeenCalledExactlyOnceWith('/config'); expect(containerExecutor).not.toHaveBeenCalled(); expect(f.control).not.toHaveBeenCalled();
});

for (const facts of [[''], ['duplicate', 'duplicate'], ['bad\0fact'], ['bad\nline'], ['bad\rfact'], ['x'.repeat(257)], Array.from({ length: 129 }, (_, i) => 'fact'+i), null, 'gpu:5090']) it('rejects invalid configured machine facts before reading a token or executing', async () => {
  const f = fixture(); f.read.mockResolvedValue(JSON.stringify({ ...config, facts }));
  expect(await workerProgram(f)).toBe(1); expect(f.read).toHaveBeenCalledExactlyOnceWith('/config'); expect(f.control).not.toHaveBeenCalled(); expect(f.executor).not.toHaveBeenCalled(); expect(f.run).not.toHaveBeenCalled();
});

it('accepts explicit private bootstrap only in a configured runner, without putting it in argv or environment', async () => {
  const f = fixture(), selected = { ...config, runners: { claude: { ...plan, bodyBootstrap: true } } };
  f.read.mockImplementation(async path => path === '/config' ? JSON.stringify(selected) : 'machine-token'); expect(await workerProgram(f)).toBe(0); expect(f.executor).toHaveBeenCalledWith(selected);
});
for (const bodyBootstrap of ['true', 1, null, {}]) it('refuses an invalid private runner bootstrap option before token reads', async () => {
  const f = fixture(); f.read.mockResolvedValue(JSON.stringify({ ...config, runners: { claude: { ...plan, bodyBootstrap } } }));
  expect(await workerProgram(f)).toBe(1); expect(f.read).toHaveBeenCalledExactlyOnceWith('/config'); expect(f.executor).not.toHaveBeenCalled();
});

it('accepts private bootstrap in exact account/harness bindings', async () => {
  const f = fixture(), selected = { ...config, accountRunners: { sub: { claude: { ...plan, bodyBootstrap: true } } } };
  f.read.mockImplementation(async path => path === '/config' ? JSON.stringify(selected) : 'machine-token'); expect(await workerProgram(f)).toBe(0); expect(f.executor).toHaveBeenCalledWith(selected);
});
it('refuses a private bootstrap flag on a builder before reading its token', async () => {
  const f = fixture(); f.read.mockResolvedValue(JSON.stringify({ ...config, build: { ...plan, bodyBootstrap: true } }));
  expect(await workerProgram(f)).toBe(1); expect(f.read).toHaveBeenCalledExactlyOnceWith('/config'); expect(f.executor).not.toHaveBeenCalled();
});
for (const mode of ['--account-signin', '--account-usage']) it(`refuses private bootstrap on the ${mode} command before private execution`, async () => {
  const f = accountFixture(mode, { command: { ...plan, bodyBootstrap: true }, account, ...(mode === '--account-signin' ? { box: 'box' } : {}) });
  expect(await workerProgram(f)).toBe(1); expect(f.signIn).not.toHaveBeenCalled(); expect(f.usage).not.toHaveBeenCalled(); expect(f.read).toHaveBeenCalledOnce();
});
