import { readFile } from 'node:fs/promises';
import { expect, it, vi } from 'vitest';
import { workerProgram } from './runtime/worker-program.js';
vi.mock('node:fs/promises', () => ({ readFile: vi.fn().mockResolvedValue('local-config') }));
vi.mock('./runtime/worker-program.js', () => ({ workerProgram: vi.fn() }));
it('wires the actual worker executable arguments, configuration read and observation output', async () => {
  const argv = process.argv, exitCode = process.exitCode;
  const output = vi.spyOn(process.stdout, 'write').mockReturnValue(true);
  const diagnostics = vi.spyOn(process.stderr, 'write').mockReturnValue(true);
  const on = vi.spyOn(process, 'on').mockReturnValue(process);
  const off = vi.spyOn(process, 'off').mockReturnValue(process);
  vi.mocked(workerProgram).mockImplementation(async input => {
    expect(input.args).toEqual(['--account-usage', '/config']);
    expect(await input.read('/config')).toBe('local-config');
    expect(input.output).toBeTypeOf('function');
    input.output!('structured-observation\n'); input.error('generic-diagnostic\n');
    const stop = () => {}; input.on('SIGTERM', stop); input.off('SIGTERM', stop);
    expect(on).toHaveBeenCalledWith('SIGTERM', stop); expect(off).toHaveBeenCalledWith('SIGTERM', stop);
    return 17;
  });
  try {
    process.argv = ['node', 'loom-worker', '--account-usage', '/config'];
    await import('./worker.js');
    expect(workerProgram).toHaveBeenCalledOnce();
    expect(readFile).toHaveBeenCalledExactlyOnceWith('/config', 'utf8');
    expect(output).toHaveBeenCalledWith('structured-observation\n');
    expect(diagnostics).toHaveBeenCalledWith('generic-diagnostic\n');
    expect(process.exitCode).toBe(17);
  } finally {
    process.argv = argv; process.exitCode = exitCode;
    output.mockRestore(); diagnostics.mockRestore(); on.mockRestore(); off.mockRestore();
  }
});
