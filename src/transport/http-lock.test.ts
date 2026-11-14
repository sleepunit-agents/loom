import { expect, it } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createRequire } from 'node:module';
import { acquireHttpLock } from './http-lock.js';

it('rejects a second daemon and releases on close', () => {
  const home = mkdtempSync(join(tmpdir(), 'loom-http-lock-'));
  try {
    const release = acquireHttpLock(home);
    expect(() => acquireHttpLock(home)).toThrow(/already running/);
    release(); acquireHttpLock(home)();
  } finally { rmSync(home, { recursive: true, force: true }); }
});
it('recovers the same lock inode after process death', async () => {
  const home = mkdtempSync(join(tmpdir(), 'loom-http-crash-'));
  const require = createRequire(import.meta.url);
  const script = join(home, 'hold.cjs');
  // Keep the native connection reachable for the child's lifetime, even after GC.
  writeFileSync(script, `const D=require(${JSON.stringify(require.resolve('better-sqlite3'))});const db=new D(process.argv[2]);db.exec('BEGIN EXCLUSIVE');global.lockDatabase=db;setImmediate(()=>{global.gc();process.send('ready');});process.stdin.resume();`);
  const child = spawn(process.execPath, ['--expose-gc', script, join(home, 'http-daemon-lock.db')], { stdio: ['pipe', 'ignore', 'inherit', 'ipc'] });
  try {
    await once(child, 'message');
    expect(() => acquireHttpLock(home)).toThrow(/already running/);
    const exit = once(child, 'exit'); child.kill('SIGKILL'); await exit;
    acquireHttpLock(home)();
  } finally { child.kill('SIGKILL'); rmSync(home, { recursive: true, force: true }); }
});
