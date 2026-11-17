import { spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { workerLeft, type ProcessTable } from './worker-left.js';

const dirs: string[] = [], children: ChildProcess[] = [];
afterEach(() => {
  for (const child of children.splice(0)) try { process.kill(-child.pid!, 'SIGKILL'); } catch { /* already gone */ }
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});
const state = () => { const dir = mkdtempSync(join(tmpdir(), 'loom-left-test-')); dirs.push(dir); return dir; };
/** A body as the worker starts one: its own process group, its scratch directory named in its environment. */
function body(script: string, scratch: string) {
  const child = spawn('/bin/sh', ['-c', script], { detached: true, stdio: ['ignore', 'pipe', 'ignore'], env: { PATH: process.env.PATH ?? '/usr/bin:/bin', LOOM_BODY_SCRATCH: scratch } });
  children.push(child); return child;
}
const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };
/** A killed orphan is collected by whichever process adopted it; that takes a moment. */
async function dead(pid: number) { for (let n = 0; n < 100 && alive(pid); n++) await delay(50); return !alive(pid); }
const firstLine = async (child: ChildProcess) => String((await once(child.stdout!, 'data'))[0]).trim();

describe.skipIf(process.platform !== 'linux')('what a killed worker left, with real processes', () => {
  it('ends the recorded process group of a body, tidies it, and removes its scratch directory and record', async () => {
    const dir = state(), killed = workerLeft(dir), scratch = killed.scratch();
    writeFileSync(join(scratch, 'mcp_config.json'), 'a bearer a killed body could not remove');
    const child = body('sleep 300 & echo $!; wait', scratch), descendant = Number(await firstLine(child));
    killed.note(child.pid!, { job: 'job', harness: 'agy', account: 'account' }, scratch);
    // The worker is killed here: nothing is stopped and nothing is forgotten. The next one starts.
    const tidy = vi.fn((_left: unknown, at: string | undefined) => { expect(existsSync(join(at!, 'mcp_config.json'))).toBe(true); });
    const exited = once(child, 'exit');
    expect(await workerLeft(dir).reap(tidy)).toEqual({ ended: 1, unverified: 0 });
    expect((await exited)[1]).toBe('SIGKILL'); expect(await dead(descendant)).toBe(true);
    expect(tidy).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ job: 'job', harness: 'agy', account: 'account', pid: child.pid }), scratch);
    expect(readdirSync(dir)).toEqual(['worker']);
    expect(await workerLeft(dir).reap()).toEqual({ ended: 0, unverified: 0 });
  });
  it('finds a body\'s descendants by the scratch directory in their environment when the leader has gone', async () => {
    const dir = state(), killed = workerLeft(dir), scratch = killed.scratch();
    const child = body('sleep 300 & echo $!; exit 0', scratch), descendant = Number(await firstLine(child));
    killed.note(child.pid!, { job: 'job' }, scratch);
    await once(child, 'exit'); expect(alive(descendant)).toBe(true);
    expect(await workerLeft(dir).reap()).toEqual({ ended: 1, unverified: 0 });
    expect(await dead(descendant)).toBe(true); expect(readdirSync(dir)).toEqual(['worker']);
  });
  it('finds a body whose record was never written by its scratch directory alone', async () => {
    const dir = state(), scratch = workerLeft(dir).scratch();
    const child = body('exec sleep 300', scratch);
    await delay(100);
    const exited = once(child, 'exit');
    expect(await workerLeft(dir).reap()).toEqual({ ended: 1, unverified: 0 });
    expect((await exited)[1]).toBe('SIGKILL'); expect(readdirSync(dir)).toEqual(['worker']);
  });
  it('leaves alone a process that only holds a recorded pid, and a build record frees nothing but itself', async () => {
    const dir = state(), killed = workerLeft(dir);
    const stranger = body('exec sleep 300', '/nowhere'); await delay(100);
    // A record whose process has ended and whose pid the system has since given to someone else.
    killed.note(stranger.pid!, { job: 'job' });
    const [name] = readdirSync(dir).filter(file => file.startsWith('build-'));
    writeFileSync(join(dir, name), JSON.stringify({ pid: stranger.pid, born: 'another-boot:1', job: 'job' }));
    expect(await workerLeft(dir).reap()).toEqual({ ended: 0, unverified: 0 });
    expect(alive(stranger.pid!)).toBe(true); expect(readdirSync(dir)).toEqual(['worker']);
  });
  it('forgets a body that ended in good order, so nothing of it is left to find', async () => {
    const dir = state(), worker = workerLeft(dir), scratch = worker.scratch();
    const child = body('exit 0', scratch), forget = worker.note(child.pid!, { job: 'job' }, scratch);
    await once(child, 'exit'); rmSync(scratch, { recursive: true }); forget();
    expect(readdirSync(dir)).toEqual(['worker']);
    worker.close(); expect(readdirSync(dir)).toEqual([]);
  });
});

describe('what a killed worker left, by the rules', () => {
  const table = (over: Partial<ProcessTable> = {}): ProcessTable => ({ born: pid => pid === process.pid ? 'self' : undefined, groupAlive: () => false,
    killGroup: vi.fn(), holding: () => [], kill: vi.fn(), ...over });
  it('refuses a directory that is not this user\'s alone', () => {
    const dir = join(state(), 'shared'); mkdirSync(dir); chmodSync(dir, 0o755);
    expect(() => workerLeft(dir, { table: table() })).toThrow('private directory');
  });
  it('refuses a directory a live worker holds, and takes over from one that is gone or whose pid is another process now', () => {
    const dir = state();
    writeFileSync(join(dir, 'worker'), JSON.stringify({ pid: 4242, born: 'then' }));
    expect(() => workerLeft(dir, { table: table({ born: pid => pid === 4242 ? 'then' : 'self' }) })).toThrow('Another worker is running');
    workerLeft(dir, { table: table({ born: pid => pid === 4242 ? 'later' : 'self' }) }).close();
    writeFileSync(join(dir, 'worker'), JSON.stringify({ pid: 4242, born: 'then' }));
    workerLeft(dir, { table: table() }).close();
    expect(readdirSync(dir)).toEqual([]);
  });
  it('kills a group only while its leader is the recorded process, and counts a live group it cannot vouch for', async () => {
    const dir = state(), killGroup = vi.fn(); let groupAlive = true;
    const before = workerLeft(dir, { table: table({ born: pid => pid === 4242 ? 'then' : 'self' }) });
    before.note(4242, { job: 'job' });
    // Leader gone, group number still in use, nothing found by environment: not provably the recorded group.
    expect(await workerLeft(dir, { table: table({ groupAlive: () => true, killGroup }) }).reap()).toEqual({ ended: 0, unverified: 1 });
    expect(killGroup).not.toHaveBeenCalled();
    before.note(4242, { job: 'job' });
    const same = table({ born: pid => pid === 4242 ? 'then' : 'self', groupAlive: () => groupAlive, killGroup: vi.fn(() => { groupAlive = false; }) });
    expect(await workerLeft(dir, { table: same }).reap()).toEqual({ ended: 1, unverified: 0 });
    expect(same.killGroup).toHaveBeenCalledExactlyOnceWith(4242);
  });
  it('rejects, and keeps the record, when a recorded body will not die', async () => {
    const dir = state(), stubborn = table({ born: pid => pid === 4242 ? 'then' : 'self', groupAlive: () => true });
    workerLeft(dir, { table: stubborn }).note(4242, { job: 'job' });
    await expect(workerLeft(dir, { table: stubborn, waitMs: 100 }).reap()).rejects.toThrow('could not be ended');
    expect(readdirSync(dir).filter(name => name.startsWith('build-'))).toHaveLength(1);
  });
  it('ignores a record it cannot read rather than acting on it', async () => {
    const dir = state(), killGroup = vi.fn();
    writeFileSync(join(dir, 'build-broken.json'), '{"pid":1,"born":"then","job":"job"}');
    writeFileSync(join(dir, 'build-text.json'), 'not json');
    expect(await workerLeft(dir, { table: table({ born: () => 'then', killGroup }) }).reap()).toEqual({ ended: 0, unverified: 0 });
    expect(killGroup).not.toHaveBeenCalled(); expect(readdirSync(dir)).toEqual(['worker']);
  });
});
