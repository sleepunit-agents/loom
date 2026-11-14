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
