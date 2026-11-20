import { spawn } from 'node:child_process';
import { mkdtempSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, expect, it } from 'vitest';
import { holdAlone } from './worker-alone.js';
import { WORKER_STOP, WorkerStop, workerStopLine } from './worker-stop.js';

const root = mkdtempSync(join(realpathSync(tmpdir()), 'loom-alone-'));
afterAll(() => rmSync(root, { recursive: true, force: true }));
const stopped = (work: Promise<unknown>) => work.then(() => undefined, error => error as WorkerStop);
/** Another process that holds a path the way a worker does, says so, and then waits to be killed. */
async function otherWorker(path: string, abstract: boolean) {
  const program = `const net = require('node:net'), { createHash } = require('node:crypto'), os = require('node:os'), { join } = require('node:path');
    const name = 'loom-worker-' + createHash('sha256').update(${JSON.stringify(path)}).digest('hex').slice(0, 32);
    net.createServer().listen(${abstract} ? '\\0' + name : join(os.tmpdir(), name + '-' + os.userInfo().uid + '.sock'), () => process.stdout.write('held\\n'));`;
  const child = spawn(process.execPath, ['-e', program], { stdio: ['ignore', 'pipe', 'inherit'] });
  await new Promise<void>((resolve, reject) => { child.stdout.once('data', () => resolve()); child.once('exit', () => reject(new Error('the other worker did not start'))); });
  return { kill: () => new Promise<void>(resolve => { child.once('exit', () => resolve()); child.kill('SIGKILL'); }) };
}

it.each([['an abstract socket, as on Linux', true], ['a socket file, as elsewhere', false]] as const)('holds each path to one worker with %s: a second is stopped with the key, and gets it once the first lets go', async (_how, abstract) => {
  const socket = join(root, `engine-${abstract}.sock`), login = join(root, `login-${abstract}`);
  const first = [{ key: 'container.socket', path: socket }, { key: 'accountLogins.a.claude.source', path: login }];
  const release = await holdAlone(first, abstract);
  // The same engine under another configuration's key order, and the same sign-in directory with another engine.
  const sameEngine = await stopped(holdAlone([{ key: 'container.socket', path: socket }], abstract));
  expect(sameEngine).toBeInstanceOf(WorkerStop); expect([sameEngine!.stage, sameEngine!.key]).toEqual(['shared', 'container.socket']);
  const sameLogin = await stopped(holdAlone([{ key: 'container.socket', path: join(root, 'another-engine.sock') }, { key: 'accountLogins."their account".claude.source', path: login }], abstract));
  expect([sameLogin!.stage, sameLogin!.key]).toEqual(['shared', 'accountLogins."their account".claude.source']);
  // The one that was refused holds nothing: what it had taken before the collision is free again.
  const other = await holdAlone([{ key: 'container.socket', path: join(root, 'another-engine.sock') }], abstract); other();
  // The line names the key and never the path.
  expect(workerStopLine('shared', sameLogin!.key)).toBe(`Worker stopped: ${WORKER_STOP.shared[1]} (accountLogins."their account".claude.source)\n`);
  expect(WORKER_STOP.shared).toEqual([57, 'another worker on this machine already uses the engine or a sign-in directory this configuration names: one worker runs a machine\'s houses']);
  expect(workerStopLine('shared', sameLogin!.key)).not.toContain(root);
  // Let go, and the next worker has both. Letting go twice is nothing.
  release(); release();
  const next = await holdAlone(first, abstract); next();
  // One path under two keys of one configuration is held once and does not collide with itself.
  const twice = await holdAlone([{ key: 'a', path: socket }, { key: 'b', path: socket }], abstract); twice();
  // Nothing was written where the paths are: a sign-in directory is never touched.
  expect(readdirSync(root).filter(name => name.includes(String(abstract)))).toEqual([]);
});
it.each([['an abstract socket', true], ['a socket file', false]] as const)('is not blocked by a worker that died holding %s', async (_how, abstract) => {
  const path = join(root, `held-by-the-dead-${abstract}`), dead = await otherWorker(path, abstract);
  // While it lives, it holds.
  expect((await stopped(holdAlone([{ key: 'container.socket', path }], abstract)))!.stage).toBe('shared');
  // Killed outright, with no chance to let go: the system gives the name back, or the file it left answers nobody.
  await dead.kill();
  const release = await holdAlone([{ key: 'container.socket', path }], abstract);
  expect((await stopped(holdAlone([{ key: 'container.socket', path }], abstract)))!.stage).toBe('shared');
  release();
});
it('holds nothing when there is nothing to hold', async () => { (await holdAlone([]))(); writeFileSync(join(root, 'unused'), ''); });
