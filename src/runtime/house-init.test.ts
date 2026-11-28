/** The init a body's container starts it under (house-layout.ts, HOUSE_ENTRYPOINT), run for real: as PID 1 of
 * a fresh process namespace, which is what an engine gives a container, with a stand-in body under it. It
 * needs tini at its place and an `unshare` that may make a user and process namespace; where either is
 * missing the test says so and skips. No container engine is involved: what the engine adds (cgroups,
 * mounts, its own user namespace) is not tested here. */
import { spawn, spawnSync, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { accessSync, constants, readdirSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { HOUSE_ENTRYPOINT, HOUSE_INIT, HOUSE_NODE } from './house-layout.js';

const usable = (() => {
  if (process.platform !== 'linux') return false;
  try { accessSync(HOUSE_INIT, constants.X_OK); } catch { return false; }
  return spawnSync('unshare', ['-Urpf', '--mount-proc', 'true'], { stdio: 'ignore', timeout: 10_000 }).status === 0;
})();

/** The stand-in body: reads a line of its input, starts a long child in its own process group (as a
 * harness is), leaves an orphan behind, and reports what it sees. On SIGTERM it waits for its child to end
 * and says how it ended, then ends itself with 0: the signal must have reached the child without the
 * body passing it on. */
const body = `
const { spawn, execFileSync } = require('node:child_process'), fs = require('node:fs');
const say = line => process.stdout.write(line + '\\n');
const zombies = () => fs.readdirSync('/proc').filter(name => /^\\d+$/.test(name)).filter(pid => {
  try { const stat = fs.readFileSync('/proc/' + pid + '/stat', 'utf8'); return stat.slice(stat.lastIndexOf(')') + 2)[0] === 'Z'; } catch { return false; }
}).length;
let input = '';
process.stdin.on('data', chunk => {
  input += chunk; if (!input.includes('\\n')) return;
  process.stdin.pause();
  const child = spawn('sleep', ['300'], { stdio: 'ignore', detached: false });
  child.once('exit', (code, signal) => { say('child ' + signal); process.exit(0); });
  process.on('SIGTERM', () => say('body SIGTERM'));
  execFileSync('sh', ['-c', '(sleep 0.2 &) ; exit 0']);
  setTimeout(() => say('ready ' + JSON.stringify({ input: input.trim(), pid: process.pid, pid1: fs.readFileSync('/proc/1/cmdline', 'utf8').split('\\0').filter(Boolean),
    zombies: zombies(), group: process.pid === Number(fs.readFileSync('/proc/self/stat', 'utf8').split(') ')[1].split(' ')[2]) })), 1000);
});`;

/** Host pids of every descendant of one. */
function descendants(pid: number): number[] {
  const found: number[] = [];
  for (const task of (() => { try { return readdirSync(`/proc/${pid}/task`); } catch { return []; } })()) {
    let children: number[] = [];
    try { children = readFileSync(`/proc/${pid}/task/${task}/children`, 'utf8').trim().split(/\s+/).filter(Boolean).map(Number); } catch { /* ended */ }
    for (const child of children) found.push(child, ...descendants(child));
  }
  return found;
}
const running = (pid: number) => {
  try { const stat = readFileSync(`/proc/${pid}/stat`, 'utf8'); return stat.slice(stat.lastIndexOf(')') + 2)[0] !== 'Z'; } catch { return false; }
};

function house(): { process: ChildProcessWithoutNullStreams; lines: string[]; next: (prefix: string) => Promise<string>; ended: Promise<number | null> } {
  // HOUSE_ENTRYPOINT names the house's node; this machine's is whatever runs the test.
  const argv = [...HOUSE_ENTRYPOINT.slice(0, -1), process.execPath, '-e', body];
  expect(HOUSE_ENTRYPOINT.at(-1)).toBe(HOUSE_NODE);
  const started = spawn('unshare', ['-Urpf', '--mount-proc', ...argv], { stdio: 'pipe' });
  const lines: string[] = [], waiting: { prefix: string; resolve: (line: string) => void }[] = [];
  let text = '';
  started.stdout.on('data', chunk => {
    text += chunk; let cut;
    while ((cut = text.indexOf('\n')) >= 0) {
      const line = text.slice(0, cut); text = text.slice(cut + 1); lines.push(line);
      for (const [at, wait] of waiting.entries()) if (line.startsWith(wait.prefix)) { waiting.splice(at, 1); wait.resolve(line); break; }
    }
  });
  const ended = new Promise<number | null>(resolve => started.once('exit', code => resolve(code)));
  const next = (prefix: string) => {
    const seen = lines.find(line => line.startsWith(prefix));
    return seen ? Promise.resolve(seen) : new Promise<string>(resolve => waiting.push({ prefix, resolve }));
  };
  return { process: started, lines, next, ended };
}
/** tini's own pid on this machine: the one child of unshare. */
async function init(unshare: number): Promise<number> {
  for (let tries = 0; tries < 100; tries++) {
    const [pid] = descendants(unshare);
    if (pid !== undefined && readFileSync(`/proc/${pid}/cmdline`, 'utf8').startsWith(HOUSE_INIT)) return pid;
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  throw new Error('init not found');
}

describe.skipIf(!usable)('the house init, as PID 1 of its own process namespace', () => {
  it('is PID 1, passes input through, collects orphans, and passes SIGTERM to the body\'s whole process group', async () => {
    const run = house();
    run.process.stdin.write('the job\n');
    const ready = JSON.parse((await run.next('ready ')).slice('ready '.length));
    expect(ready.pid1).toEqual([HOUSE_INIT, '-g', '--', process.execPath, '-e', body]);
    // tini puts the body in a process group of its own, which its children share; the input reached it.
    expect(ready.group).toBe(true); expect(ready.input).toBe('the job');
    // The orphan the body left was adopted by PID 1 and collected: no zombie is left.
    expect(ready.zombies).toBe(0);
    process.kill(await init(run.process.pid!), 'SIGTERM');
    // The body was told, and so was its child, which the body never signalled. Then the body's exit is the init's.
    expect(await run.ended).toBe(0);
    expect(run.lines).toContain('body SIGTERM'); expect(run.lines).toContain('child SIGTERM');
  }, 20_000);
  it('ends everything in the namespace when the init is killed, as an engine removing the container does', async () => {
    const run = house();
    run.process.stdin.write('x\n');
    await run.next('ready ');
    const tini = await init(run.process.pid!), under = descendants(tini);
    expect(under.length).toBeGreaterThanOrEqual(2);
    process.kill(tini, 'SIGKILL');
    await run.ended;
    for (let tries = 0; tries < 50 && under.some(running); tries++) await new Promise(resolve => setTimeout(resolve, 50));
    expect(under.filter(running)).toEqual([]);
  }, 20_000);
});
