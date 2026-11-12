/**
 * A background provider's lifetime lock belongs to this guardian, not its HTTP parent. After SIGKILL of that
 * parent the guardian still bounds and drains the provider before releasing the lock. Successors skip the
 * already admitted command while it finishes. Never unlink the database, even when it is unlocked.
 * Configuration (including stdin) arrives on stdin; argv contains only the lock path.
 */
import Database from 'better-sqlite3';
import { spawn } from 'node:child_process';

let input = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (s: string) => { input += s; });
process.stdin.on('end', () => {
  // An owner dying before sending configuration starts no provider.
  if (!input) return;
  const config = JSON.parse(input) as { path: string; args: string[]; stdin?: string; timeout: number };
  const db = new Database(process.argv[2], { timeout: 0 });
  try { db.exec('BEGIN EXCLUSIVE'); } catch { db.close(); process.exitCode = 75; return; }
  const child = spawn(config.path, config.args, { env: process.env, detached: true, stdio: [config.stdin === undefined ? 'ignore' : 'pipe', 'inherit', 'ignore'] });
  let done = false;
  const kill = () => { if (child.pid) { try { process.kill(-child.pid, 'SIGKILL'); } catch { /* exited */ } } };
  const timer = setTimeout(kill, config.timeout);
  const finish = (code: number) => {
    if (done) return;
    done = true; clearTimeout(timer); kill(); db.close(); process.exitCode = code;
  };
  child.on('error', () => finish(1));
  child.on('exit', code => finish(code ?? 1));
  if (child.stdin) { child.stdin.on('error', () => {}); child.stdin.end(config.stdin); }
});
