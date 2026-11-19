import { readFile } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { expect, it, vi } from 'vitest';
import { workerProgram } from './runtime/worker-program.js';
import { endWorker } from './runtime/worker-exit.js';
import { WORKER_THREADS } from './runtime/machine-check.js';
vi.mock('node:fs/promises', () => ({ readFile: vi.fn().mockResolvedValue('local-config') }));
vi.mock('./runtime/worker-program.js', () => ({ workerProgram: vi.fn() }));
vi.mock('./runtime/worker-exit.js', () => ({ endWorker: vi.fn() }));
it('wires the actual worker executable arguments, configuration read and observation output', async () => {
  const argv = process.argv, exitCode = process.exitCode, threads = process.env.UV_THREADPOOL_SIZE;
  const output = vi.spyOn(process.stdout, 'write').mockReturnValue(true);
  const diagnostics = vi.spyOn(process.stderr, 'write').mockReturnValue(true);
  const on = vi.spyOn(process, 'on').mockReturnValue(process);
  const off = vi.spyOn(process, 'off').mockReturnValue(process);
  vi.mocked(workerProgram).mockImplementation(async input => {
    // The pool every file read and name lookup shares was sized before the program, or anything it imports, ran.
    expect(process.env.UV_THREADPOOL_SIZE).toBe(String(WORKER_THREADS));
    expect(input.args).toEqual(['--account-usage', '/config']);
    expect(await input.read('/config')).toBe('local-config');
    expect(input.output).toBeTypeOf('function');
    input.output!('structured-observation\n'); input.error('generic-diagnostic\n');
    const stop = () => {}; input.on('SIGTERM', stop); input.off('SIGTERM', stop);
    expect(on).toHaveBeenCalledWith('SIGTERM', stop); expect(off).toHaveBeenCalledWith('SIGTERM', stop);
    input.unanswered!(2);
    return 17;
  });
  try {
    delete process.env.UV_THREADPOOL_SIZE;
    process.argv = ['node', 'loom-worker', '--account-usage', '/config'];
    await import('./worker.js');
    expect(workerProgram).toHaveBeenCalledOnce();
    expect(readFile).toHaveBeenCalledExactlyOnceWith('/config', 'utf8');
    expect(output).toHaveBeenCalledWith('structured-observation\n');
    expect(diagnostics).toHaveBeenCalledWith('generic-diagnostic\n');
    // How the process ends is worker-exit.ts's, told the code and how many calls the reader said are out.
    expect(endWorker).toHaveBeenCalledExactlyOnceWith(17, 2);
  } finally {
    process.argv = argv; process.exitCode = exitCode;
    if (threads === undefined) delete process.env.UV_THREADPOOL_SIZE; else process.env.UV_THREADPOOL_SIZE = threads;
    output.mockRestore(); diagnostics.mockRestore(); on.mockRestore(); off.mockRestore();
  }
});
it('sizes the pool as the first thing the entry file does, before it loads anything, and leaves a size its starter chose', () => {
  const source = readFileSync(new URL('./worker.ts', import.meta.url), 'utf8');
  const statements = source.split('\n').filter(line => line.trim() && !/^\s*(\/\/|\/\*|\*|#!)/.test(line));
  expect(statements[0]).toBe(`process.env.UV_THREADPOOL_SIZE ??= '${WORKER_THREADS}';`);
  // No static import: those are loaded before any statement of the file runs.
  expect(source).not.toMatch(/^import /m);
  // The worker's process alone: nothing else in loom sets it, and the server never loads this file (architecture.contract.test.ts).
  const sets = (file: string) => readFileSync(new URL(file, import.meta.url), 'utf8').includes('UV_THREADPOOL_SIZE');
  expect(['./index.ts', './shared-root.ts', './shared-serve.ts', './runtime/worker-program.ts', './runtime/machine-check.ts'].filter(sets)).toEqual(['./runtime/machine-check.ts']);
});
