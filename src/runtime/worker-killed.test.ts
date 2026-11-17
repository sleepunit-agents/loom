/** A real body process that a signal ends, as the system's memory killer or an operator's kill would. */
import { expect, it } from 'vitest';
import { commandWorkerExecutor, type WorkerCommand } from './worker-process.js';
import { WORKER_EXIT, exitStage } from './job-exit.js';
import type { WorkerAssignment } from './worker.js';

const job: WorkerAssignment = { id: 'j', box: 'b', agent: 'art', conversation: 'c', model: 'custom-model', account: 'sub', harness: 'custom-runner', brief: '', house: { repository: 'repo', file: 'Containerfile', branch: 'main' } };
const node = (script: string): WorkerCommand => ({ command: process.execPath, args: ['-e', script], cwd: '/', env: {} });
const run = async (script: string) => {
  const executor = commandWorkerExecutor({ build: node(''), runners: { 'custom-runner': node(script) } });
  const body = executor.start(job, 'image', new AbortController().signal);
  try { await body.spawned; return await body.exited; } finally { await body.stop(); }
};

it('records a body a signal ended as killed, and not as the exit code 1 a body uses for its own failure', async () => {
  const killed = await run("process.kill(process.pid, 'SIGKILL'); setInterval(() => {}, 1000)");
  expect(killed).toMatchObject({ exitCode: WORKER_EXIT.killed, own: false });
  expect(exitStage(killed.exitCode)).toBe('body killed');
  // A body that ends by itself with 1 is still its own word.
  const failed = await run('process.exit(1)');
  expect(failed).toMatchObject({ exitCode: 1, own: true });
  expect(exitStage(failed.exitCode)).toBe('body input');
});
