/** The program as it is installed, killed without a chance to tidy, and started again on the same home. */
import { expect, it } from 'vitest';
import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const dist = resolve(__dirname, '..', 'dist', 'index.js');
/** Starts `loom serve` and waits for the line it prints once it is listening, or for it to end. */
function start(home: string) {
  const child = spawn(process.execPath, [dist, 'serve', '--home', home, '--host', '127.0.0.1', '--port', '0'], { stdio: ['ignore', 'ignore', 'pipe'] });
  let stderr = '';
  const up = new Promise<string>((ok, no) => {
    child.stderr.on('data', chunk => { stderr += String(chunk); const url = /loom: shared app on (\S+)/.exec(stderr)?.[1]; if (url) ok(url); });
    child.once('exit', code => no(new Error(`loom serve ended with ${code}: ${stderr}`)));
  });
  return { child, up };
}
const ended = (child: ChildProcess) => new Promise<void>(done => { if (child.exitCode !== null || child.signalCode !== null) done(); else child.once('exit', () => done()); });
/** Every socket file under a directory: what a killed program cannot remove. */
function sockets(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true, recursive: true }).filter(entry => entry.isSocket()).map(entry => join(entry.parentPath, entry.name));
}

it.skipIf(!existsSync(dist))('starts again on the same home after being killed without cleanup', async () => {
  const parent = mkdtempSync(join(tmpdir(), 'loom-killed-')), home = join(parent, 'home');
  const running: ChildProcess[] = [];
  try {
    const first = start(home); running.push(first.child);
    await first.up;
    first.child.kill('SIGKILL'); await ended(first.child);
    // The operator's sign-in socket is the one file a kill leaves; the start below replaces it.
    expect(sockets(home)).toEqual([join(home, 'operator.sock')]);
    const second = start(home); running.push(second.child);
    const url = await second.up;
    expect(await (await fetch(url + '/auth/session')).json()).toEqual({ viewer: null });
    second.child.kill('SIGTERM'); await ended(second.child);
    expect(second.child.exitCode).toBe(0);
    expect(sockets(home)).toEqual([]);
  } finally {
    for (const child of running) { child.kill('SIGKILL'); await ended(child); }
    rmSync(parent, { recursive: true, force: true });
  }
});
